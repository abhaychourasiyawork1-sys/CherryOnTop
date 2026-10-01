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
  it('asks System-1 about every goal: no word list decides what a goal means', async () => {
    for (const goal of ['Rename the variable', 'Review the auth module. Do not modify anything.', 'Investigate why login fails and fix it']) {
      const { provider, s1 } = laya(0.5);
      await assessChangeRequest('n', goal, s1);
      expect(provider.asked, goal).toHaveLength(1);
      expect(provider.asked[0].surface).toBe('execution.change_requested');
    }
  });

  it('follows System-1, not the wording: a "do not modify" goal Laya reads as a change stays writable', async () => {
    const v = await assessChangeRequest('n', 'Review the auth module. Do not modify anything.', laya(0.99).s1);
    expect(v).toMatchObject({ readOnly: false, decidedBy: 'system1' });
  });

  it('keeps edit tools for the xarray bug report when Laya reads it as a change', async () => {
    expect((await assessChangeRequest('n', XARRAY, laya(0.99).s1)).readOnly).toBe(false);
  });

  it('keeps tools on an ambiguous goal read as a change', async () => {
    const v = await assessChangeRequest('n', AMBIGUOUS, laya(0.8).s1);
    expect(v).toMatchObject({ readOnly: false, decidedBy: 'system1' });
  });

  it('narrows only on a confident "explain"', async () => {
    expect((await assessChangeRequest('n', 'Explain why the cache misses', laya(1 - EXPLAIN_THRESHOLD - 0.05).s1)).readOnly).toBe(true);
    expect((await assessChangeRequest('n', 'Explain why the cache misses', laya(0.4).s1)).readOnly).toBe(false);
  });

  it('stays writable when System-1 cannot answer, whatever the goal says', async () => {
    const down = createSystem1(null, { maxCallsPerScope: 10, timeoutMs: 1_000 });
    expect(await assessChangeRequest('n', AMBIGUOUS, down)).toMatchObject({ readOnly: false, decidedBy: 'fallback' });
    // No keyword rule stands in for the judgment: "explain" wording alone narrows nothing.
    expect(await assessChangeRequest('n', 'Explain how the iterator works', down)).toMatchObject({ readOnly: false, decidedBy: 'fallback' });
  });
});
