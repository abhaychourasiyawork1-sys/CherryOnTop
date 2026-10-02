/** Offline replay: a recorded dispatch, re-run through the controller, re-priced.
 *
 *  The token side is exact. An observation shaped from `n` to `m` tokens after
 *  turn k enters turn k+1 as `n − m` fewer cache-write tokens and every later
 *  turn as `n − m` fewer cache-read tokens. Nothing else in the recorded run
 *  has to be assumed for that.
 *
 *  Whether the agent would have come back for what was elided cannot be
 *  observed offline, so it is reported three ways:
 *
 *   - `noRefetch` / `allRefetch`: the bounds;
 *   - `proxyRefetch`: an information-use estimate from the recorded future. An
 *     elision counts as needed when the agent later *said* (in its text or tool
 *     inputs) an identifier that appeared only in the elided part: not in what
 *     was kept, not in the goal, not in anything it had seen before. That is the
 *     agent demonstrably using information only that region held. It misses uses
 *     that leave no lexical trace (under-counts) and credits coincidental
 *     mentions (over-counts); it is a proxy, and is labelled as one.
 *
 *  Each refetch is priced the way the controller prices it: one turn re-reading
 *  the whole context, plus carrying the slice from then on.
 *
 *  Input is the runtime's own event stream (`exec.assistant` / `exec.user`
 *  rows), so this works on any state.db the runtime has written. */
import { estimateTokens } from '../context/candidates.js';
import { perTokenRates } from '../execution/pricing.js';
import { carryingUsd, refetchMean, type RefetchBelief } from './economics.js';
import { InfoSession, type Component, type HookPayload } from './controller.js';
import { codeIdentifiers, shapeCandidates, termsOf } from './shape.js';
import type { RefetchFeatures, RefetchModel } from './refetch-model.js';
export type { RefetchFeatures } from './refetch-model.js';
import { SPILL_DIR } from './controller.js';

export type TrajectoryStep =
  | { kind: 'turn'; id: string; usage: Record<string, number>; text: string; said: string }
  | { kind: 'tool'; toolUseId: string; name: string; input: Record<string, unknown>; output: string; isError: boolean }
  /** The runtime's final account. Per-message output counts in the stream are
   *  placeholders; this one is the real total. */
  | { kind: 'result'; usage: Record<string, number> };

interface Block { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean; text?: string }

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : (c as { text?: string }).text ?? '')).join('\n');
  return '';
}

/** Rebuilds a dispatch's turns and tool calls from its `exec.*` events, in order.
 *  A message streams as several events; its usage is the largest value each
 *  field reached (the first copy's output count is a placeholder). */
export function trajectoryFromEvents(rows: ReadonlyArray<{ type: string; payload: unknown }>): TrajectoryStep[] {
  const steps: TrajectoryStep[] = [];
  const turns = new Map<string, Extract<TrajectoryStep, { kind: 'turn' }>>();
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const row of rows) {
    const message = (row.payload as { message?: { id?: string; content?: Block[]; usage?: Record<string, number> } } | null)?.message;
    if (row.type === 'exec.assistant' && message) {
      const id = message.id ?? `turn-${steps.length}`;
      let turn = turns.get(id);
      if (!turn) {
        turn = { kind: 'turn', id, usage: {}, text: '', said: '' };
        turns.set(id, turn);
        steps.push(turn);
      }
      for (const [k, v] of Object.entries(message.usage ?? {})) {
        if (typeof v === 'number') turn.usage[k] = Math.max(turn.usage[k] ?? 0, v);
      }
      for (const block of message.content ?? []) {
        if (block.type === 'tool_use' && block.id && !calls.has(block.id)) {
          calls.set(block.id, { name: block.name ?? '', input: block.input ?? {} });
          turn.said += `\n${JSON.stringify(block.input ?? {})}`;
        }
        if (block.type === 'text' && block.text && block.text !== turn.text) {
          turn.text = block.text;
          turn.said += `\n${block.text}`;
        }
      }
    } else if (row.type === 'exec.result') {
      const usage = (row.payload as { usage?: Record<string, number> } | null)?.usage;
      if (usage) steps.push({ kind: 'result', usage });
    } else if (row.type === 'exec.user' && Array.isArray(message?.content)) {
      for (const block of message!.content!) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue;
        const call = calls.get(block.tool_use_id);
        if (!call) continue;
        steps.push({ kind: 'tool', toolUseId: block.tool_use_id, name: call.name, input: call.input, output: contentText(block.content), isError: block.is_error === true });
      }
    }
  }
  return steps;
}

export interface ReplayOptions {
  goal: string;
  model: string;
  disabled?: Component[];
  beliefs?: Map<string, RefetchBelief>;
  refetchModel?: RefetchModel | null;
  pastTurns?: number[];
  confidence?: number;
  taskValueUsd?: number;
  finish?: { failed: number; finished: number };
}

export interface ElisionLabel {
  cell: string;
  tokens: number;
  /** The information-use proxy: the agent later used something only the elided part held. */
  used: boolean;
  /** The identifiers that made it count as used (at most five), for auditing the proxy. */
  matched?: string[];
  /** Exact carrying saved, and the price of one refetch, for this elision. */
  savedUsd?: number;
  refetchUsd?: number;
  /** Which observation it came from, so alternatives can be compared per observation. */
  observation?: string;
  /** What the runtime could know when deciding (see refetch-model.ts). */
  features?: RefetchFeatures;
}



export interface ReplayReport {
  turns: number;
  toolCalls: number;
  baselineUsd: number;
  /** By cache class, recorded. */
  baseline: { readUsd: number; writeUsd: number; outputUsd: number; inputUsd: number };
  elidedTokens: number;
  /** Exact saving if nothing elided were ever refetched. */
  savedUsd: number;
  policyUsd: { noRefetch: number; meanRefetch: number; proxyRefetch: number; allRefetch: number };
  decisions: Record<string, number>;
  elisions: ElisionLabel[];
  /** Every candidate representation of every observation that reached the
   *  shaping stage, labelled by the information-use proxy whether or not the
   *  policy chose it: the calibration set for refetch beliefs. */
  candidateLabels: ElisionLabel[];
  /** The run ended with edits after its last executed command. */
  unverifiedFinish: boolean;
  /** Calls the controller would have refused before they ran. Offline the
   *  recorded call still happened, so these are counted, not re-priced. */
  refusals: Array<{ action: string; tokens: number; context: number }>;
  /** Repeat-gate labels the recorded future yields (see SessionResult.repeats). */
  repeats: Array<{ differed: boolean; again: boolean }>;
}

const specificTerms = codeIdentifiers;

export async function replay(steps: readonly TrajectoryStep[], options: ReplayOptions): Promise<ReplayReport> {
  const prices = perTokenRates(options.model);
  const decisions: Record<string, number> = {};
  const elisions: Array<{ afterTurn: number; stepIndex: number; tokens: number; cell: string; context: number; onlyElided: Set<string> }> = [];
  const candidates: Array<{ stepIndex: number; afterTurn: number; context: number; cell: string; tokens: number; onlyElided: Set<string>; features: RefetchFeatures }> = [];
  let lastDecision: Record<string, unknown> | null = null;
  const session = new InfoSession({
    nodeId: 'replay', taskRootId: 'replay', role: 'execute', goal: options.goal, mode: 'active',
    disabled: new Set(options.disabled ?? []), prices, confidence: options.confidence ?? 0.9,
    taskValueUsd: options.taskValueUsd ?? 5, beliefs: options.beliefs ?? new Map(), refetchModel: options.refetchModel ?? null, pastTurns: options.pastTurns ?? [],
    finish: options.finish ?? { failed: 0, finished: 0 }, negatives: [], revision: null,
  }, {
    emit: (type, payload) => {
      if (type !== 'ic.decision') return;
      const key = `${String(payload.action)}${payload.applied ? '' : ':not-applied'}`;
      decisions[key] = (decisions[key] ?? 0) + 1;
      lastDecision = payload;
    },
  });

  const baseline = { readUsd: 0, writeUsd: 0, outputUsd: 0, inputUsd: 0 };
  const turnContext: number[] = [];
  let turnIndex = -1;
  let toolCalls = 0;
  let lastText = '';
  let outputTotal = 0;
  const seenBefore = specificTerms(options.goal);
  // What the controller itself can have seen: the goal, tool inputs and tool
  // outputs (hooks never see the agent's prose). Features use this, so a model
  // trained here is trained on what the runtime will actually know.
  const runtimeSeen = specificTerms(options.goal);
  let reportedOutput: number | null = null;
  const refusals: ReplayReport['refusals'] = [];
  for (const [stepIndex, step] of steps.entries()) {
    if (step.kind === 'result') {
      reportedOutput = (reportedOutput ?? 0) + (step.usage.output_tokens ?? 0);
      continue;
    }
    if (step.kind === 'turn') {
      turnIndex++;
      const u = step.usage;
      baseline.readUsd += (u.cache_read_input_tokens ?? 0) * prices.read;
      baseline.writeUsd += (u.cache_creation_input_tokens ?? 0) * prices.write;
      baseline.outputUsd += (u.output_tokens ?? 0) * prices.output;
      baseline.inputUsd += (u.input_tokens ?? 0) * prices.input;
      outputTotal += u.output_tokens ?? 0;
      turnContext.push((u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
      if (step.text) lastText = step.text;
      session.observeEvent({ type: 'assistant', payload: { message: { id: step.id, usage: u } } });
      for (const t of specificTerms(step.said)) seenBefore.add(t);
      continue;
    }
    toolCalls++;
    for (const t of specificTerms(JSON.stringify(step.input))) runtimeSeen.add(t);
    const base = { tool_name: step.name, tool_input: step.input, tool_use_id: step.toolUseId };
    const pre = await session.handle({ hook_event_name: 'PreToolUse', ...base });
    if ((pre.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision === 'deny') {
      refusals.push({ action: String((lastDecision as Record<string, unknown> | null)?.action ?? 'deny'), tokens: estimateTokens(step.output), context: turnContext.at(-1) ?? 0 });
    }
    lastDecision = null;
    // As the live runtime reports it: a failed call on its own event.
    const post: HookPayload = step.isError
      ? { hook_event_name: 'PostToolUseFailure', ...base, error: step.output }
      : { hook_event_name: 'PostToolUse', ...base, tool_response: { type: 'text', text: step.output } };
    const response = await session.handle(post);
    const shaped = (response.hookSpecificOutput as { updatedToolOutput?: string } | undefined)?.updatedToolOutput;
    const outputTerms = specificTerms(step.output);
    const reached = lastDecision as Record<string, unknown> | null;
    if (reached && (reached.action === 'keep' || String(reached.action).startsWith('shape:'))) {
      const kind = step.name === 'Bash' ? 'bash' : step.name.toLowerCase();
      const locator = step.name === 'Read' ? String(step.input.file_path ?? '') : `${SPILL_DIR}/${step.toolUseId}.out`;
      const query = new Set([...termsOf(options.goal), ...termsOf(JSON.stringify(step.input))]);
      for (const c of shapeCandidates({ text: step.output, query, locator, source: step.name === 'Read' })) {
        const kept = specificTerms(c.text);
        const onlyElided = new Set([...outputTerms].filter((t) => !kept.has(t) && !seenBefore.has(t)));
        const original = estimateTokens(step.output);
        candidates.push({
          stepIndex, afterTurn: turnIndex, context: turnContext.at(-1) ?? 0, cell: `${kind}:${c.representation}`, tokens: original - c.tokens, onlyElided,
          features: {
            tool: kind, representation: c.representation, originalTokens: original, keptFraction: c.tokens / Math.max(1, original),
            novelIdentifiers: [...outputTerms].filter((t) => !kept.has(t) && !runtimeSeen.has(t)).length, progress: Number(reached.step) / Math.max(1e-9, Number(reached.step) + Number(reached.remainingTurns)),
          },
        });
      }
    }
    if (shaped !== undefined) {
      const kept = specificTerms(shaped);
      const d = lastDecision as Record<string, unknown> | null;
      const isDedup = d?.action === 'dedup' || d?.action === 'subsume';
      elisions.push({
        afterTurn: turnIndex, stepIndex, tokens: Math.max(0, estimateTokens(step.output) - estimateTokens(shaped)),
        cell: isDedup ? String(d?.action) : String(d?.cell ?? 'unknown'), context: turnContext.at(-1) ?? 0,
        // A duplicate's content is still in context, so nothing only it held exists.
        onlyElided: isDedup ? new Set() : new Set([...outputTerms].filter((t) => !kept.has(t) && !seenBefore.has(t))),
      });
    }
    for (const t of outputTerms) { seenBefore.add(t); runtimeSeen.add(t); }
  }
  await session.handle({ hook_event_name: 'Stop', last_assistant_message: lastText });

  // Information-use labels from the recorded future.
  const laterSaid = (from: number) => {
    const out = new Set<string>();
    for (const s of steps.slice(from + 1)) if (s.kind === 'turn') for (const t of specificTerms(s.said)) out.add(t);
    return out;
  };
  if (reportedOutput !== null && reportedOutput > outputTotal) {
    baseline.outputUsd = reportedOutput * prices.output;
    outputTotal = reportedOutput;
  }
  const turns = turnIndex + 1;
  const outputPerTurn = turns > 0 ? outputTotal / turns : 0;
  let savedUsd = 0;
  let refetchAll = 0;
  let refetchMeanUsd = 0;
  let refetchProxy = 0;
  const labels: ElisionLabel[] = [];
  for (const e of elisions) {
    const after = Math.max(0, turns - (e.afterTurn + 1));
    const future = laterSaid(e.stepIndex);
    const matched = [...e.onlyElided].filter((t) => future.has(t));
    const used = matched.length > 0;
    labels.push({ cell: e.cell, tokens: e.tokens, used, ...(used ? { matched: matched.slice(0, 5) } : {}) });
    if (after === 0) continue; // the run ended before the shaped text was ever sent
    savedUsd += carryingUsd(e.tokens, after - 1, prices);
    const refetch = e.context * prices.read + outputPerTurn * prices.output + carryingUsd(e.tokens, Math.max(0, after - 2), prices);
    refetchAll += refetch;
    refetchMeanUsd += refetchMean(options.beliefs?.get(e.cell) ?? { refetched: 0, elided: 0 }) * refetch;
    if (used) refetchProxy += refetch;
  }
  const turnsTotal = turnIndex + 1;
  const perTurnOut = turnsTotal > 0 ? (reportedOutput ?? outputTotal) / turnsTotal : 0;
  const candidateLabels: ElisionLabel[] = candidates.map((c) => {
    const future = laterSaid(c.stepIndex);
    const after = Math.max(0, turnsTotal - (c.afterTurn + 1));
    return {
      cell: c.cell, tokens: c.tokens, used: [...c.onlyElided].some((t) => future.has(t)),
      savedUsd: after > 0 ? carryingUsd(c.tokens, after - 1, prices) : 0,
      refetchUsd: after > 0 ? c.context * prices.read + perTurnOut * prices.output + carryingUsd(c.tokens, Math.max(0, after - 2), prices) : 0,
      observation: String(c.stepIndex), features: c.features,
    };
  });
  const baselineUsd = baseline.readUsd + baseline.writeUsd + baseline.outputUsd + baseline.inputUsd;
  const result = session.close();
  return {
    turns, toolCalls, baselineUsd, baseline,
    elidedTokens: elisions.reduce((s, e) => s + e.tokens, 0),
    savedUsd,
    policyUsd: {
      noRefetch: baselineUsd - savedUsd,
      meanRefetch: baselineUsd - savedUsd + refetchMeanUsd,
      proxyRefetch: baselineUsd - savedUsd + refetchProxy,
      allRefetch: baselineUsd - savedUsd + refetchAll,
    },
    decisions,
    elisions: labels,
    candidateLabels,
    unverifiedFinish: result.unverifiedFinish || decisions['block-finish'] !== undefined,
    refusals,
    repeats: result.repeats,
  };
}
