import { describe, it, expect } from 'vitest';
import { assessChangeRequest, EXPLAIN_THRESHOLD } from './change-request.js';
import { fakeLaya } from './fake-provider.js';
import { createSystem1 } from './guard.js';

// The SWE-bench report that lost its edit tools to the word "why".
const XARRAY = '"center" kwarg ignored when manually iterating over DataArrayRolling. I am confused why the following two code chunks do not produce the same sequence of values. This returns the following values, as expected. Is this an issue with the window iterator?';
const AMBIGUOUS = 'Why does the CSV export drop the last row?';
// The fake puts its probability on the first option, `change`.
const laya = (pChange: number) => {
  const provider = fakeLaya(pChange);
  return { provider, s1: createSystem1(provider, { maxCallsPerScope: 10, timeoutMs: 1_000 }) };
};

describe('assessChangeRequest', () => {
  it('never asks about a goal with no investigative wording', async () => {
    const { provider, s1 } = laya(0.5);
    expect(await assessChangeRequest('n', 'Rename the variable', s1)).toEqual({ readOnly: false, decidedBy: 'rule' });
    expect(provider.asked).toHaveLength(0);
  });

  it('honours an explicit "do not modify" without asking', async () => {
    const { provider, s1 } = laya(0.99);
    const v = await assessChangeRequest('n', 'Review the auth module. Do not modify anything.', s1);
    expect(v).toMatchObject({ readOnly: true, decidedBy: 'rule' });
    expect(provider.asked).toHaveLength(0);
  });

  it('keeps edit tools when the goal names a change, without asking', async () => {
    const { provider, s1 } = laya(0.01);
    expect(await assessChangeRequest('n', 'Investigate why login fails and fix it', s1)).toMatchObject({ readOnly: false, decidedBy: 'rule' });
    expect(provider.asked).toHaveLength(0);
  });

  it('reads "without changing X" as a constraint on a fix, not as "change nothing"', async () => {
    const v = await assessChangeRequest('n', 'Investigate the parser crash and fix it without changing the public API', laya(0.01).s1);
    expect(v.readOnly).toBe(false);
    expect((await assessChangeRequest('n', 'Review the auth module without modifying anything', laya(0.99).s1)).readOnly).toBe(true);
  });

  it('keeps edit tools for the xarray bug report', async () => {
    expect((await assessChangeRequest('n', XARRAY, laya(0.01).s1)).readOnly).toBe(false);
  });

  it('asks System-1 when the words leave it open, and keeps tools on a change reading', async () => {
    const { provider, s1 } = laya(0.8);
    const v = await assessChangeRequest('n', AMBIGUOUS, s1);
    expect(v).toMatchObject({ readOnly: false, decidedBy: 'system1' });
    expect(provider.asked[0].surface).toBe('execution.change_requested');
  });

  it('narrows only on a confident "explain"', async () => {
    expect((await assessChangeRequest('n', 'Explain why the cache misses', laya(1 - EXPLAIN_THRESHOLD - 0.05).s1)).readOnly).toBe(true);
    expect((await assessChangeRequest('n', 'Explain why the cache misses', laya(0.4).s1)).readOnly).toBe(false);
  });

  it('falls back to the rule when System-1 cannot answer', async () => {
    const down = createSystem1(null, { maxCallsPerScope: 10, timeoutMs: 1_000 });
    expect(await assessChangeRequest('n', AMBIGUOUS, down)).toMatchObject({ readOnly: false, decidedBy: 'fallback' });
    expect(await assessChangeRequest('n', 'Explain how the iterator works', down)).toMatchObject({ readOnly: true, decidedBy: 'fallback' });
  });
});
