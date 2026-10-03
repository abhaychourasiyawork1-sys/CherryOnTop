/** Offline replay of a recorded Claude Code dispatch through the owned loop.
 *
 *  The recorded model's actions are replayed verbatim (a scripted client
 *  returns each recorded turn's text and tool calls) and every tool returns its
 *  recorded output, so the only thing that differs between arms is what
 *  CherryOnTop puts in front of the model: the real `runAgentSession`, the
 *  real broker, the real information controller and compaction run. No model,
 *  no sandbox, no network.
 *
 *  Tokens. A request's size is counted with the runtime's own estimator and
 *  calibrated per session against the recorded run: the recorded context grew
 *  by G real tokens over a history the estimator sizes at g, so estimates are
 *  scaled by G/g. Cache traffic follows the owned layout: tools and system are
 *  their own cached block; history is append-only, so each request reads the
 *  previous request from cache and writes what was added; after a compaction
 *  only the fixed block is read. Output tokens are the recorded ones.
 *
 *  What it cannot know: whether the model would have acted differently on a
 *  smaller context. Projections are reported as the no-refetch bound; the
 *  refetch-risk side is the information-control replay's job (bench/infocontrol). */
import { estimateTokens } from '../context/candidates.js';
import { estimateCostUsd, perTokenRates } from '../execution/pricing.js';
import { InfoSession, type Component } from '../infocontrol/controller.js';
import { ownedPrices, runAgentSession } from './loop.js';
import { fakeMessage, resolveModelId, type ContentBlock, type Message, type MessageParam, type ModelTurnInput } from './model-client.js';
import type { Sandbox } from './sandbox.js';
import { ToolBroker } from './tools.js';

export interface RecordedTurn {
  content: ContentBlock[];
  /** Tokens this turn's request carried in the recorded run (input + cache). */
  contextTokens: number;
  outputTokens: number;
}

export interface RecordedSession {
  goal: string;
  model: string;
  turns: RecordedTurn[];
  results: Map<string, { text: string; isError: boolean }>;
  /** The recorded run's cost at Claude Code's rates (1-hour cache writes). */
  recordedUsd: number;
}

interface Block { type?: string; id?: string; name?: string; input?: unknown; text?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : (c as { text?: string }).text ?? '')).join('\n');
  return '';
}

/** One recorded CLI session (from its `init` to its `result`) as replayable turns.
 *  A message streams as several events sharing an id; its blocks are merged
 *  and its usage is each field's largest value. Subagent messages are skipped. */
export function sessionFromEvents(rows: ReadonlyArray<{ type: string; payload: unknown }>, goal: string): RecordedSession {
  const turns = new Map<string, { blocks: ContentBlock[]; seen: Set<string>; usage: Record<string, number> }>();
  const results = new Map<string, { text: string; isError: boolean }>();
  let model = '';
  let resultOutput: number | null = null;
  for (const row of rows) {
    const type = row.type.replace(/^exec\./, '');
    const p = row.payload as { parent_tool_use_id?: unknown; message?: { id?: string; model?: string; content?: Block[]; usage?: Record<string, number> }; usage?: Record<string, number> } | null;
    if (p?.parent_tool_use_id) continue;
    if (type === 'assistant' && p?.message) {
      const id = p.message.id ?? `turn-${turns.size}`;
      const turn = turns.get(id) ?? { blocks: [], seen: new Set<string>(), usage: {} };
      turns.set(id, turn);
      if (p.message.model) model = p.message.model;
      for (const [k, v] of Object.entries(p.message.usage ?? {})) if (typeof v === 'number') turn.usage[k] = Math.max(turn.usage[k] ?? 0, v);
      for (const b of p.message.content ?? []) {
        const key = b.type === 'tool_use' ? `u:${b.id}` : b.type === 'text' ? `t:${b.text}` : null;
        if (!key || turn.seen.has(key) || (b.type === 'text' && !b.text)) continue;
        turn.seen.add(key);
        turn.blocks.push(b.type === 'tool_use'
          ? { type: 'tool_use', id: b.id!, name: b.name ?? '', input: b.input ?? {} } as ContentBlock
          : { type: 'text', text: b.text!, citations: null } as ContentBlock);
      }
    } else if (type === 'user' && Array.isArray(p?.message?.content)) {
      for (const b of p!.message!.content!) if (b.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, { text: contentText(b.content), isError: b.is_error === true });
    } else if (type === 'result' && p?.usage && typeof p.usage.output_tokens === 'number') {
      resultOutput = p.usage.output_tokens;
    }
  }
  const list = [...turns.values()].filter((t) => t.blocks.length > 0);
  // Per-message output counts in the stream are placeholders; the result's total is real.
  const perTurnOutput = resultOutput !== null && list.length > 0 ? resultOutput / list.length : null;
  const n = (v: number | undefined) => v ?? 0;
  const recorded = list.reduce((s, t) => ({
    inputTokens: s.inputTokens + n(t.usage.input_tokens), cacheReadTokens: s.cacheReadTokens + n(t.usage.cache_read_input_tokens),
    cacheCreationTokens: s.cacheCreationTokens + n(t.usage.cache_creation_input_tokens), outputTokens: s.outputTokens + (perTurnOutput ?? n(t.usage.output_tokens)),
  }), { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 });
  const r = perTokenRates(model);
  return {
    goal, model, results,
    turns: list.map((t) => ({
      content: t.blocks,
      contextTokens: n(t.usage.input_tokens) + n(t.usage.cache_read_input_tokens) + n(t.usage.cache_creation_input_tokens),
      outputTokens: perTurnOutput ?? n(t.usage.output_tokens),
    })),
    recordedUsd: recorded.inputTokens * r.input + recorded.cacheReadTokens * r.read + recorded.cacheCreationTokens * r.write + recorded.outputTokens * r.output,
  };
}

export interface ArmReport {
  arm: string;
  turnsReplayed: number;
  toolCalls: number;
  compactions: number;
  projected: number;
  /** Characters the model was not shown that the sandbox produced. */
  elidedChars: number;
  /** Projected or cut outputs with no way back (no spill file, not a file Read). Must be 0. */
  unrecoverable: number;
  contextTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  peakContext: number;
  costUsd: number;
  /** The same tokens at Claude Code's cache-write price (1-hour TTL, 2x):
   *  separates what fewer tokens saved from what the cheaper TTL saved. */
  costAt1hWritesUsd: number;
}

export interface Arm {
  name: string;
  infoControl: 'off' | 'active';
  pricedCompaction: boolean;
}

export const ARMS: Arm[] = [
  { name: 'owned', infoControl: 'off', pricedCompaction: false },
  { name: 'owned+ic', infoControl: 'active', pricedCompaction: false },
  { name: 'owned+ic+compaction', infoControl: 'active', pricedCompaction: true },
];

/** Replay can only re-price what reaches the model; components that refuse a
 *  call or add a turn would change the recorded actions themselves. */
const REPLAY_DISABLED: Component[] = ['finish', 'repeat', 'memory', 'system1'];

const nullSandbox: Sandbox = { workdir: '/app', exec: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }), close: async () => {} };

const sizeOf = (m: MessageParam) => estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));

/** Real tokens per estimated token in this session, from the recorded run. */
export function calibration(rec: RecordedSession): number {
  if (rec.turns.length < 2) return 1;
  let estimated = 0;
  for (let i = 0; i < rec.turns.length - 1; i++) {
    estimated += estimateTokens(JSON.stringify(rec.turns[i].content));
    for (const b of rec.turns[i].content) if (b.type === 'tool_use') estimated += estimateTokens(rec.results.get(b.id)?.text ?? '');
  }
  const grew = rec.turns.at(-1)!.contextTokens - rec.turns[0].contextTokens;
  return estimated > 0 && grew > 0 ? grew / estimated : 1;
}

export async function replayOwned(rec: RecordedSession, arm: Arm): Promise<ArmReport> {
  const model = resolveModelId(rec.model || 'sonnet');
  const scale = calibration(rec);
  const turns = [...rec.turns];
  let prev: { tokens: number; head: string } | null = null;
  const totals = { context: 0, read: 0, write: 0, output: 0, peak: 0 };

  const respond = (input: ModelTurnInput): Message => {
    const recorded = turns.shift()!;
    const fixed = Math.round((estimateTokens(input.system) + estimateTokens(JSON.stringify(input.tools))) * scale);
    const tokens = fixed + Math.round(input.messages.reduce((s, m) => s + sizeOf(m), 0) * scale);
    const head = JSON.stringify(input.messages[0]);
    const read = prev === null ? 0 : prev.head === head ? Math.min(prev.tokens, tokens) : fixed;
    prev = { tokens, head };
    totals.context += tokens; totals.read += read; totals.write += tokens - read; totals.output += recorded.outputTokens;
    totals.peak = Math.max(totals.peak, tokens);
    return fakeMessage(recorded.content, {
      model, stopReason: recorded.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      usage: { input_tokens: 0, cache_read_input_tokens: read, cache_creation_input_tokens: tokens - read, output_tokens: Math.round(recorded.outputTokens) },
    });
  };

  const session = new InfoSession({
    nodeId: 'replay', taskRootId: 'replay', role: 'execute', goal: rec.goal, mode: arm.infoControl, disabled: new Set(REPLAY_DISABLED),
    prices: ownedPrices(model), confidence: 0.9, taskValueUsd: 0, beliefs: new Map(), pastTurns: [], finish: { failed: 0, finished: 0 }, negatives: [], revision: null,
  }, { emit: () => {} });
  const state = { handle: (p: Record<string, unknown>) => session.handle(p), activeState: () => session.activeState(), observeEvent: (e: { type: string; payload: unknown }) => session.observeEvent(e) };
  const broker = new ToolBroker({
    sandbox: nullSandbox, infoControl: state,
    runTool: async (call) => {
      const r = rec.results.get(call.id);
      return r ? { text: r.text, failed: r.isError } : { text: '(no recorded output)', failed: true };
    },
  });
  const result = await runAgentSession({
    sessionId: 'replay', goal: rec.goal, workdir: '/app', model, client: { createTurn: async (input) => respond(input) },
    broker, state, maxTurns: rec.turns.length, pricedCompaction: arm.pricedCompaction,
    // Recorded actions only: no turn or tool the recorded run did not have.
    confirmFinish: false, webSearch: false, recite: false,
  });

  let toolCalls = 0; let projected = 0; let elidedChars = 0; let unrecoverable = 0;
  for (const e of result.events) {
    if (e.type !== 'user') continue;
    const p = e.payload as { message: { content: Array<{ tool_use_id: string; content: string }> }; tool_use_result: Array<{ tool_use_id: string; tool: string | null; raw: string; projected: boolean; spilledTo: string | null }> };
    for (const r of p.tool_use_result) {
      toolCalls++;
      const shown = p.message.content.find((b) => b.tool_use_id === r.tool_use_id)?.content ?? '';
      if (r.projected) projected++;
      const cut = Math.max(0, r.raw.length - shown.length);
      elidedChars += cut;
      // A Read is its file; a duplicate pointer says to re-run the call.
      const isRead = r.tool === 'Read';
      const rerun = /Run (the|this) same (call|Read) again/.test(shown);
      if (cut > 0 && !r.spilledTo && !isRead && !rerun) unrecoverable++;
    }
  }
  return {
    arm: arm.name, turnsReplayed: result.usage.numTurns, toolCalls, compactions: result.compactions, projected, elidedChars, unrecoverable,
    contextTokens: totals.context, cacheReadTokens: totals.read, cacheWriteTokens: totals.write, outputTokens: Math.round(totals.output), peakContext: totals.peak,
    costUsd: estimateCostUsd({ inputTokens: 0, outputTokens: totals.output, cacheReadTokens: totals.read, cacheCreationTokens: totals.write }, model),
    costAt1hWritesUsd: (() => { const r = perTokenRates(model); return totals.output * r.output + totals.read * r.read + totals.write * r.write; })(),
  };
}
