import { describe, it, expect } from 'vitest';
import { deriveTaskEconomicsSignals, extractAnchors, taskEconomicsFor } from './task-economics.js';

const derive = (goal: string, over: Partial<Parameters<typeof deriveTaskEconomicsSignals>[0]> = {}) =>
  deriveTaskEconomicsSignals({
    goal, taskClass: 'implementation', namedAnchors: extractAnchors(goal), readOnly: false, ...over,
  });

describe('extractAnchors', () => {
  it('finds a path, a dotted filename and a backticked symbol', () => {
    expect(extractAnchors('fix `refreshSession` in src/auth/session.ts and update README.md'))
      .toEqual(expect.arrayContaining(['src/auth/session.ts', 'README.md', 'refreshSession']));
  });

  it('finds nothing in a goal that names nothing', () => {
    expect(extractAnchors('review the codebase and find bugs')).toEqual([]);
  });

  it('does not treat an ordinary English sentence ending as a filename', () => {
    expect(extractAnchors('make it faster. then tell me why.')).toEqual([]);
  });
});

describe('deriveTaskEconomicsSignals', () => {
  it('gives a typo fix on a named file high confidence and a tiny scope', () => {
    const s = derive('Fix the typo in README.md', { taskClass: 'trivial_edit' });
    expect(s.hasExplicitAnchors).toBe(true);
    expect(s.confidence).toBeGreaterThan(0.7);
    expect(s.expectedModificationScope).toBeLessThan(0.3);
    expect(s.complexityBand).toBe('tiny');
  });

  it('gives a broad unanchored review low confidence and high breadth', () => {
    const s = derive('Review the whole codebase across every module and find bugs', { taskClass: 'investigation', readOnly: true });
    expect(s.hasExplicitAnchors).toBe(false);
    expect(s.breadth).toBeGreaterThan(0.4);
    expect(s.confidence).toBeLessThan(0.5);
    expect(s.investigationLikelihood).toBeGreaterThan(0.6);
  });

  it('marks a read-only task as modifying nothing', () => {
    const s = derive('Investigate the root cause of the slow path', { taskClass: 'investigation', readOnly: true });
    expect(s.readOnly).toBe(true);
    expect(s.expectedModificationScope).toBe(0);
  });

  it('wants verification for implementation and test authoring, less for documentation', () => {
    const impl = derive('Add a --since flag to org tokens', { taskClass: 'implementation' });
    const tests = derive('Add a unit test for src/engines/economics.ts', { taskClass: 'test_authoring' });
    const docs = derive('Document the lifecycle states in docs/lifecycle.md', { taskClass: 'documentation' });
    expect(impl.verificationNeed).toBeGreaterThan(0.5);
    expect(tests.verificationNeed).toBeGreaterThan(0.5);
    expect(docs.verificationNeed).toBeLessThan(impl.verificationNeed);
  });

  it('treats debugging as investigation-heavy but still writing', () => {
    const s = derive('Debug the crash in the dispatch loop and fix it', { taskClass: 'debugging' });
    expect(s.investigationLikelihood).toBeGreaterThan(0.5);
    expect(s.expectedModificationScope).toBeGreaterThan(0);
  });

  it('gives a refactor across several files a wider modification scope than a one-file edit', () => {
    const wide = derive('Refactor every query module in src/db/queries to share one error helper');
    const narrow = derive('Rename the helper in src/db/queries/tokens.ts', { taskClass: 'trivial_edit' });
    expect(wide.expectedModificationScope).toBeGreaterThan(narrow.expectedModificationScope);
  });

  it('produces only normalized, finite signals for any goal', () => {
    for (const goal of ['', 'x', '???', 'a'.repeat(5000), 'fix src/a.ts and src/b.ts and src/c.ts']) {
      const s = derive(goal);
      for (const value of [s.confidence, s.breadth, s.expectedModificationScope, s.investigationLikelihood, s.verificationNeed]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is deterministic — the same goal derives the same signals', () => {
    expect(derive('Fix the off-by-one in src/context/delta.ts')).toEqual(derive('Fix the off-by-one in src/context/delta.ts'));
  });

  it('names no file of its own: the signals never mention a path', () => {
    const s = JSON.stringify(taskEconomicsFor('Add a unit test for src/engines/economics.ts'));
    expect(s).not.toContain('src/');
    expect(s).not.toContain('.ts');
  });
});

describe('taskEconomicsFor', () => {
  it('classifies and derives in one call, off the goal alone', () => {
    const s = taskEconomicsFor('Fix the typo in README.md');
    expect(s.complexityBand).toBe('tiny');
    expect(s.hasExplicitAnchors).toBe(true);
  });

  it('reads an investigative goal as read-only without being told', () => {
    expect(taskEconomicsFor('Review the codebase and find bugs. Do not modify anything.').readOnly).toBe(true);
  });
});
