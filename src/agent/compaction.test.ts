import { describe, it, expect } from 'vitest';
import { compact, canCompact, priceCompaction, type CallRecord } from './compaction.js';
import { ownedPrices } from './loop.js';
import type { MessageParam } from './model-client.js';

const exchange = (id: string, out: string): MessageParam[] => [
  { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id, name: 'Read', input: { file_path: `${id}.py` } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out }] },
];

describe('compact', () => {
  const messages: MessageParam[] = [{ role: 'user', content: 'goal' }, ...exchange('a', 'x'.repeat(4000)), ...exchange('b', 'y'.repeat(4000)), ...exchange('c', 'tail')];
  const calls = new Map<string, CallRecord>([
    ['a', { id: 'a', name: 'Read', target: 'a.py', isError: false }],
    ['b', { id: 'b', name: 'Bash', target: 'make', isError: true, spilledTo: '/tmp/cto-ic/b.out' }],
  ]);

  it('keeps goal + state + index + last exchange, and accounts for what it dropped', () => {
    const r = compact({ goal: 'goal', messages, activeState: 'Goal: goal\nFiles you have edited (1): a.py', calls })!;
    expect(r.messages).toHaveLength(3);
    expect(r.messages[0].content).toContain('Files you have edited (1): a.py');
    expect(r.messages[0].content).toContain('2. Bash make — failed — full output in /tmp/cto-ic/b.out');
    expect(r.droppedCallIds).toEqual(['a', 'b']);
    expect(r.retainedCallIds).toEqual(['c']);
    expect(r.droppedTokens).toBeGreaterThan(r.keptTokens);
    expect(JSON.stringify(r.messages)).not.toContain('thinking');
    // A tool_use is never separated from its result.
    expect(r.messages[1].role).toBe('assistant');
    expect(r.messages[2]).toEqual(messages.at(-1));
  });

  it('refuses when there is nothing before the last exchange to drop', () => {
    const short: MessageParam[] = [{ role: 'user', content: 'goal' }, ...exchange('a', 'x')];
    expect(canCompact(short)).toBe(false);
    expect(compact({ goal: 'goal', messages: short, activeState: '', calls })).toBeNull();
  });
});

describe('priceCompaction', () => {
  const prices = ownedPrices('haiku');
  const base = { keptTokens: 2_000, stateTokens: 300, contextTokens: 80_000, outputPerTurn: 300, refetchProbability: 0.5 };

  it('pays when a large stale history would be carried for many more turns', () => {
    expect(priceCompaction({ ...base, droppedTokens: 70_000, droppedCalls: 10, remainingTurns: 30 }, prices).worth).toBe(true);
  });

  it('does not pay early, near the end, or when the history is mostly what is kept', () => {
    expect(priceCompaction({ ...base, droppedTokens: 70_000, droppedCalls: 10, remainingTurns: 1 }, prices).worth).toBe(false);
    expect(priceCompaction({ ...base, droppedTokens: 1_500, droppedCalls: 2, remainingTurns: 30 }, prices).worth).toBe(false);
  });

  it('gets more reluctant as the refetch risk grows', () => {
    const a = priceCompaction({ ...base, droppedTokens: 40_000, droppedCalls: 20, remainingTurns: 10 }, prices);
    const b = priceCompaction({ ...base, droppedTokens: 40_000, droppedCalls: 20, remainingTurns: 10, refetchProbability: 0.9 }, prices);
    expect(b.costUsd).toBeGreaterThan(a.costUsd);
    expect(b.savedUsd).toBe(a.savedUsd);
  });
});
