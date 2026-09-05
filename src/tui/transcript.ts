import { createStreamRenderer, type RenderedLine, type StreamRenderer } from './stream-renderer.js';
import type { BusEvent } from '../events/bus.js';

export interface NodeMeta {
  goal: string;
  parentId: string | null;
}

/** Read fresh on every event rather than captured once: delegation creates nodes
 *  while the transcript is already running, and a child whose parent arrived
 *  after the reducer was built must still indent correctly. */
export type NodeMetaLookup = () => Record<string, NodeMeta>;

export type Block =
  | { kind: 'header'; key: string; nodeId: string; goal: string; state: string; depth: number }
  | { kind: 'line'; key: string; nodeId: string; depth: number; action: 'append' | 'update'; line: RenderedLine }
  | { kind: 'system'; key: string; nodeId: string | null; depth: number; text: string; tone: Tone }
  | { kind: 'command'; key: string; input: string; output: string[] };

export type Tone = 'info' | 'warn' | 'good' | 'bad';

export interface Transcript {
  /** Zero or more blocks for one event. Zero means nothing to show — a filtered
   *  node, suppressed noise, or a transition that changed nothing. */
  feed(event: BusEvent): Block[];
  setFocus(nodeId: string | null): void;
  focus(): string | null;
  setVerbose(on: boolean): void;
  verbose(): boolean;
}

// What each lifecycle state actually means, in the terms someone watching cares
// about. The old TUI printed the state name itself and left the reader to know
// the machine; a node passes through four of these in under a second.
const NARRATION: Record<string, { text: string; tone: Tone }> = {
  CREATED: { text: 'node created', tone: 'info' },
  ORIENT: { text: 'orienting', tone: 'info' },
  PLAN: { text: 'planning', tone: 'info' },
  INTELLIGENCE_GATE: { text: 'assessing uncertainty', tone: 'info' },
  EXECUTION_DECISION: { text: 'deciding how to execute', tone: 'info' },
  SELF_EXECUTE: { text: 'executing in the sandbox', tone: 'info' },
  DELEGATE: { text: 'delegating to a child node', tone: 'info' },
  ESCALATE: { text: 'escalating — this is outside its authority', tone: 'warn' },
  WAIT_APPROVAL: { text: 'waiting for your approval', tone: 'warn' },
  VERIFY: { text: 'verifying the result', tone: 'info' },
  COMPLETE: { text: 'complete', tone: 'good' },
  FAILED: { text: 'failed', tone: 'bad' },
  CANCELLED: { text: 'cancelled by you', tone: 'warn' },
};

/** Two decimal places, no float noise: the economics formula produces values
 *  like 0.5999999999999999 and nobody reading a decision needs 16 digits. */
function num(value: number | undefined): string {
  return value === undefined ? '?' : value.toFixed(2);
}

function narrateDecision(payload: unknown): string {
  const { outcome, breakdown } = (payload ?? {}) as { outcome?: string; breakdown?: Record<string, number> };
  const b = breakdown ?? {};
  if (outcome === 'ESCALATE') {
    return `decided ESCALATE — delegating scored ${num(b.score)} against a threshold of ${num(b.threshold)}, `
      + `but a child costs $${num(b.requiredBudget)} and this node has $${num(b.availableBudget)}`;
  }
  if (outcome === 'SELF_EXECUTE' && b.reason_no_spawn_authority) {
    return 'decided SELF_EXECUTE — it has no authority to spawn children';
  }
  return `decided ${outcome ?? 'unknown'} — scored ${num(b.score)} against a threshold of ${num(b.threshold)}`;
}

export function createTranscript(lookupMeta: NodeMetaLookup): Transcript {
  // One renderer per node. A shared one would correlate node A's tool_result
  // against node B's pending tool_use — the exact failure that makes two nodes
  // working at once unreadable, and the reason this is tested rather than eyeballed.
  const renderers = new Map<string, StreamRenderer>();
  const lastState = new Map<string, string>();
  let lastSpeaker: string | null = null;
  let focused: string | null = null;
  let isVerbose = false;
  let seq = 0;
  const nextKey = () => `b${seq++}`;

  function depthOf(nodeId: string, meta: Record<string, NodeMeta>): number {
    let depth = 0;
    let cursor = meta[nodeId]?.parentId ?? null;
    // Bounded: a corrupt parent chain must not hang the render loop.
    while (cursor && meta[cursor] && depth < 16) {
      depth++;
      cursor = meta[cursor].parentId;
    }
    return depth;
  }

  function headerFor(nodeId: string, meta: Record<string, NodeMeta>, depth: number): Block {
    return {
      kind: 'header',
      key: nextKey(),
      nodeId,
      goal: meta[nodeId]?.goal ?? '(unknown goal)',
      state: lastState.get(nodeId) ?? '',
      depth,
    };
  }

  return {
    focus: () => focused,
    verbose: () => isVerbose,
    setFocus(nodeId) {
      focused = nodeId;
      // Force a header on the next event: after a focus change the reader has
      // lost track of who was speaking.
      lastSpeaker = null;
    },
    setVerbose(on) { isVerbose = on; },

    feed(event: BusEvent): Block[] {
      if (focused && event.nodeId !== focused) return [];

      const meta = lookupMeta();
      const depth = depthOf(event.nodeId, meta);
      const blocks: Block[] = [];

      if (event.type === 'state.transition') {
        const state = (event.payload as { state?: string })?.state;
        if (!state || lastState.get(event.nodeId) === state) return [];
        lastState.set(event.nodeId, state);
        blocks.push(headerFor(event.nodeId, meta, depth));
        const narration = NARRATION[state];
        if (narration) {
          blocks.push({ kind: 'system', key: nextKey(), nodeId: event.nodeId, depth, ...narration });
        }
        lastSpeaker = event.nodeId;
        return blocks;
      }

      if (event.type === 'decision.made') {
        if (lastSpeaker !== event.nodeId) {
          blocks.push(headerFor(event.nodeId, meta, depth));
          lastSpeaker = event.nodeId;
        }
        blocks.push({
          kind: 'system', key: nextKey(), nodeId: event.nodeId, depth,
          text: narrateDecision(event.payload), tone: 'info',
        });
        return blocks;
      }

      if (!event.type.startsWith('exec.')) return [];

      let renderer = renderers.get(event.nodeId);
      if (!renderer) {
        renderer = createStreamRenderer();
        renderers.set(event.nodeId, renderer);
      }

      const results = renderer.feed({ type: event.type.slice('exec.'.length), payload: event.payload });
      if (results.length === 0) {
        // Suppressed noise: hook chatter, rate-limit pings, an empty thinking
        // block, a tool_result with no matching call. /verbose surfaces it
        // rather than losing it — nothing is discarded, only withheld.
        if (!isVerbose) return [];
        return [{
          kind: 'system', key: nextKey(), nodeId: event.nodeId, depth,
          text: `${event.type} ${JSON.stringify(event.payload).slice(0, 160)}`, tone: 'info',
        }];
      }

      if (lastSpeaker !== event.nodeId) {
        blocks.push(headerFor(event.nodeId, meta, depth));
        lastSpeaker = event.nodeId;
      }
      for (const result of results) {
        blocks.push({
          kind: 'line', key: result.line.key, nodeId: event.nodeId,
          depth, action: result.action, line: result.line,
        });
      }
      return blocks;
    },
  };
}
