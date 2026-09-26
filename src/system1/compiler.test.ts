import { describe, it, expect } from 'vitest';
import { compileRequest, compileHarnessRequest, stateFacts, STATE_CHAR_BUDGET } from './compiler.js';
import { initialEconomicState, normalizeEconomicState } from '../decision/state.js';
import { LIMITS } from './types.js';

const base = () => initialEconomicState({ goal: 'review the parser', totalTokenBudget: 10_000 });

describe('Decision Compiler', () => {
  it('produces the same digest for the same inputs', () => {
    const a = compileHarnessRequest({ surface: 'execution.decomposable', goal: 'g', facts: stateFacts(base()), stateVersion: 2 });
    const b = compileHarnessRequest({ surface: 'execution.decomposable', goal: 'g', facts: stateFacts(base()), stateVersion: 2 });
    expect(a.inputDigest).toBe(b.inputDigest);
    expect(a.id).toBe(b.id);
  });

  it('canonicalizes choice option order but keeps score levels in rubric order', () => {
    const opts = [{ id: 'b', action: '', description: 'two' }, { id: 'a', action: '', description: 'one' }];
    const common = { source: 'model' as const, surface: 'model.request' as const, question: 'q', questionVersion: 'v', goal: 'g', stateVersion: 0 };
    const c1 = compileRequest({ ...common, primitive: 'choice', candidates: opts });
    const c2 = compileRequest({ ...common, primitive: 'choice', candidates: [...opts].reverse() });
    expect(c1.inputDigest).toBe(c2.inputDigest);
    expect(c1.candidates.map((c) => c.id)).toEqual(['a', 'b']);
    const s = compileRequest({ ...common, primitive: 'score', candidates: opts });
    expect(s.candidates.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('preserves the state and question versions', () => {
    const r = compileHarnessRequest({ surface: 'action.helpful', goal: 'g', stateVersion: 7, subject: 'validate' });
    expect(r.stateVersion).toBe(7);
    expect(r.questionVersion).toBe('action.helpful@1');
  });

  it('does not change when unrelated state changes', () => {
    const s1 = base();
    const s2 = normalizeEconomicState({
      ...s1, availableCapabilities: ['x', 'y'],
      resources: { ...s1.resources, optimizationTokens: 999 },
    });
    const a = compileHarnessRequest({ surface: 'execution.decomposable', goal: 'g', facts: stateFacts(s1), stateVersion: 1 });
    const b = compileHarnessRequest({ surface: 'execution.decomposable', goal: 'g', facts: stateFacts(s2), stateVersion: 1 });
    expect(a.inputDigest).toBe(b.inputDigest);
  });

  it('rejects an oversized model request before any provider is involved', () => {
    expect(() => compileRequest({
      source: 'model', surface: 'model.request', primitive: 'noul', question: 'x'.repeat(LIMITS.questionChars + 1),
      questionVersion: 'v', goal: 'g', stateVersion: 0,
    })).toThrow(/exceeds/);
  });

  it('never carries an old heuristic verdict as an answer', () => {
    const r = compileHarnessRequest({ surface: 'execution.decomposable', goal: 'Review the codebase and check for bugs, no edits', facts: stateFacts(base()), stateVersion: 0 });
    const text = JSON.stringify(r);
    for (const verdict of ['worthSplitting', 'split_score', 'decomposition_score', 'coherent_single_task']) {
      expect(text).not.toContain(verdict);
    }
  });

  it('fits the checkpoint context by dropping low-priority facts, and says so', () => {
    const facts: [string, string][] = Array.from({ length: 30 }, (_, i) => [`fact${i}`, 'x'.repeat(300)]);
    const r = compileHarnessRequest({ surface: 'execution.decomposable', goal: 'g', facts, stateVersion: 0 });
    expect(JSON.stringify(r.state).length).toBeLessThanOrEqual(STATE_CHAR_BUDGET);
    expect(r.truncated).toBe(true);
    expect(r.state.fact0).toBeDefined();
  });
});
