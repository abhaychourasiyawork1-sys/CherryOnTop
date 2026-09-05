import { describe, it, expect } from 'vitest';
import { createTranscript } from './transcript.js';
import type { BusEvent } from '../events/bus.js';

const NODE_META = {
  a: { goal: 'add the auth guard', parentId: null },
  b: { goal: 'write the tests', parentId: 'a' },
};

function exec(nodeId: string, raw: object, id: number): BusEvent {
  return { id, nodeId, type: `exec.${(raw as { type: string }).type}`, payload: raw, createdAt: 't0' };
}

const textEvent = (nodeId: string, text: string, id: number) =>
  exec(nodeId, { type: 'assistant', message: { content: [{ type: 'text', text }] } }, id);

const toolUse = (nodeId: string, id: string, name: string, input: object, eventId: number) =>
  exec(nodeId, { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }, eventId);

const toolResult = (nodeId: string, toolUseId: string, eventId: number) =>
  exec(nodeId, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'x' }] } }, eventId);

const transition = (nodeId: string, state: string, id: number): BusEvent =>
  ({ id, nodeId, type: 'state.transition', payload: { state }, createdAt: 't0' });

describe('transcript reducer — attribution', () => {
  it('emits a header the first time a node speaks, and not again while it keeps speaking', () => {
    const t = createTranscript(() => NODE_META);
    const first = t.feed(textEvent('a', 'one', 1));
    expect(first[0]).toMatchObject({ kind: 'header', nodeId: 'a', goal: 'add the auth guard' });
    expect(first[1]).toMatchObject({ kind: 'line', nodeId: 'a' });

    const second = t.feed(textEvent('a', 'two', 2));
    expect(second.map((b) => b.kind)).toEqual(['line']);
  });

  it('emits a new header when the speaking node changes, and again when it changes back', () => {
    const t = createTranscript(() => NODE_META);
    t.feed(textEvent('a', 'one', 1));
    expect(t.feed(textEvent('b', 'two', 2))[0]).toMatchObject({ kind: 'header', nodeId: 'b' });
    expect(t.feed(textEvent('a', 'three', 3))[0]).toMatchObject({ kind: 'header', nodeId: 'a' });
  });

  it('indents a child under its parent', () => {
    const t = createTranscript(() => NODE_META);
    expect(t.feed(textEvent('b', 'child speaking', 1))[0]).toMatchObject({ kind: 'header', nodeId: 'b', depth: 1 });
    expect(t.feed(textEvent('a', 'parent speaking', 2))[0]).toMatchObject({ kind: 'header', nodeId: 'a', depth: 0 });
  });

  it('keeps a separate stream renderer per node, so interleaved tool calls still resolve correctly', () => {
    // The whole point of the redesign: two nodes working at once must not have
    // one node's tool_result close the other node's pending tool_use.
    const t = createTranscript(() => NODE_META);
    t.feed(toolUse('a', 'tu_a', 'Read', { file_path: '/a' }, 1));
    t.feed(toolUse('b', 'tu_b', 'Bash', { command: 'ls' }, 2));

    const resolvedA = t.feed(toolResult('a', 'tu_a', 3));
    expect(resolvedA.find((b) => b.kind === 'line')).toMatchObject({
      kind: 'line', nodeId: 'a', action: 'update', line: { key: 'tu_a' },
    });

    const resolvedB = t.feed(toolResult('b', 'tu_b', 4));
    expect(resolvedB.find((b) => b.kind === 'line')).toMatchObject({
      kind: 'line', nodeId: 'b', action: 'update', line: { key: 'tu_b' },
    });
  });

  it("ignores a node's tool_result against another node's pending call", () => {
    const t = createTranscript(() => NODE_META);
    t.feed(toolUse('a', 'tu_a', 'Read', { file_path: '/a' }, 1));
    expect(t.feed(toolResult('b', 'tu_a', 2)).filter((blk) => blk.kind === 'line')).toEqual([]);
  });

  it('emits a header carrying the new state when a node changes lifecycle state', () => {
    const t = createTranscript(() => NODE_META);
    t.feed(textEvent('a', 'one', 1));
    expect(t.feed(transition('a', 'VERIFY', 2)).some((b) => b.kind === 'header' && b.state === 'VERIFY')).toBe(true);
  });

  it('ignores a repeated transition to the state a node is already in', () => {
    const t = createTranscript(() => NODE_META);
    t.feed(transition('a', 'VERIFY', 1));
    expect(t.feed(transition('a', 'VERIFY', 2))).toEqual([]);
  });

  it('drops events for other nodes while focus is set, and restores when it is cleared', () => {
    const t = createTranscript(() => NODE_META);
    t.setFocus('a');
    expect(t.feed(textEvent('b', 'ignored', 1))).toEqual([]);
    expect(t.feed(textEvent('a', 'kept', 2))).not.toEqual([]);

    t.setFocus(null);
    expect(t.feed(textEvent('b', 'now visible', 3))).not.toEqual([]);
  });

  it('withholds suppressed noise by default and surfaces it under verbose', () => {
    const t = createTranscript(() => NODE_META);
    const hookEvent = exec('a', { type: 'system', subtype: 'hook_started' }, 1);
    expect(t.feed(hookEvent)).toEqual([]);

    t.setVerbose(true);
    const surfaced = t.feed(exec('a', { type: 'system', subtype: 'hook_started' }, 2));
    expect(surfaced.some((b) => b.kind === 'system' && b.text.includes('exec.system'))).toBe(true);
  });
});

describe('transcript reducer — narration', () => {
  it('narrates lifecycle milestones instead of printing bare state names', () => {
    const t = createTranscript(() => NODE_META);
    expect(t.feed(transition('a', 'CREATED', 1)).some((b) => b.kind === 'system' && /created/i.test(b.text))).toBe(true);
    expect(t.feed(transition('a', 'COMPLETE', 2)).some((b) => b.kind === 'system' && b.tone === 'good')).toBe(true);
    expect(t.feed(transition('b', 'CANCELLED', 3)).some((b) => b.kind === 'system' && /cancelled/i.test(b.text))).toBe(true);
    expect(t.feed(transition('b', 'FAILED', 4)).some((b) => b.kind === 'system' && b.tone === 'bad')).toBe(true);
  });

  it('narrates an escalation with the actual budget shortfall, not just the outcome', () => {
    const t = createTranscript(() => NODE_META);
    const blocks = t.feed({
      id: 1, nodeId: 'a', type: 'decision.made', createdAt: 't0',
      payload: { outcome: 'ESCALATE', breakdown: { score: 0.6, threshold: 0.3, requiredBudget: 1, availableBudget: 0.1 } },
    });
    const system = blocks.find((b) => b.kind === 'system');
    expect(system?.kind === 'system' && system.text).toContain('ESCALATE');
    expect(system?.kind === 'system' && system.text).toContain('$1.00');
    expect(system?.kind === 'system' && system.text).toContain('$0.10');
  });

  it('explains a SELF_EXECUTE that happened only because the node cannot delegate', () => {
    const t = createTranscript(() => NODE_META);
    const blocks = t.feed({
      id: 1, nodeId: 'a', type: 'decision.made', createdAt: 't0',
      payload: { outcome: 'SELF_EXECUTE', breakdown: { score: 0, reason_no_spawn_authority: 1 } },
    });
    const system = blocks.find((b) => b.kind === 'system');
    expect(system?.kind === 'system' && system.text).toMatch(/no authority to spawn/i);
  });

  it('rounds decision scores rather than leaking float noise into the transcript', () => {
    const t = createTranscript(() => NODE_META);
    const blocks = t.feed({
      id: 1, nodeId: 'a', type: 'decision.made', createdAt: 't0',
      payload: { outcome: 'DELEGATE', breakdown: { score: 0.5999999999999999, threshold: 0.3 } },
    });
    const system = blocks.find((b) => b.kind === 'system');
    expect(system?.kind === 'system' && system.text).toContain('0.60');
    expect(system?.kind === 'system' && system.text).not.toContain('0.5999999999999999');
  });
});
