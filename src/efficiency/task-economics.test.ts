import { describe, it, expect } from 'vitest';
import { deriveTaskEconomicsSignals, extractAnchors, taskEconomicsFor } from './task-economics.js';

const derive = (goal: string, over: Partial<Parameters<typeof deriveTaskEconomicsSignals>[0]> = {}) =>
  deriveTaskEconomicsSignals({ anchors: extractAnchors(goal), readOnly: false, ...over });

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
  it('trusts a goal that names where it works, and narrows what it reaches across', () => {
    const named = derive('Fix the typo in README.md');
    const unnamed = derive('Fix the typo');
    expect(named.hasExplicitAnchors).toBe(true);
    expect(named.confidence).toBeGreaterThan(unnamed.confidence);
    expect(named.breadth).toBeLessThan(unnamed.breadth);
    expect(named.expectedModificationScope).toBeLessThan(unnamed.expectedModificationScope);
  });

  it('does not read the wording: two goals naming the same things derive the same signals', () => {
    expect(derive('Review the whole codebase across every module in src/a.ts'))
      .toEqual(derive('Rename one helper in src/a.ts'));
  });

  it('marks a read-only task as modifying nothing and as investigation', () => {
    const s = derive('Investigate the slow path', { readOnly: true });
    expect(s.readOnly).toBe(true);
    expect(s.expectedModificationScope).toBe(0);
    expect(s.investigationLikelihood).toBe(1);
  });

  it('wants less proving for an answer than for a change', () => {
    expect(derive('x', { readOnly: true }).verificationNeed).toBeLessThan(derive('x').verificationNeed);
  });

  it('gives a change touching several named files a wider modification scope than one touching a single file', () => {
    const wide = derive('fix src/a.ts and src/b.ts and src/c.ts');
    const narrow = derive('fix src/a.ts');
    expect(wide.expectedModificationScope).toBeGreaterThan(narrow.expectedModificationScope);
  });

  it('never claims to know how big the work is: the band stays unknown', () => {
    expect(derive('Fix the typo in README.md').complexityBand).toBe('unknown');
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

  it('is deterministic — the same input derives the same signals', () => {
    expect(derive('Fix the off-by-one in src/context/delta.ts')).toEqual(derive('Fix the off-by-one in src/context/delta.ts'));
  });

  it('names no file of its own: the signals never mention a path', () => {
    const s = JSON.stringify(taskEconomicsFor('Add a unit test for src/engines/economics.ts'));
    expect(s).not.toContain('src/');
    expect(s).not.toContain('.ts');
  });
});

describe('taskEconomicsFor', () => {
  it('assumes a task writes until something says it does not', () => {
    const s = taskEconomicsFor('Review the codebase and find bugs. Do not modify anything.');
    expect(s.readOnly).toBe(false);
  });

  it('reads read-only from the understanding it is given, not from the goal', () => {
    const s = taskEconomicsFor('Fix the typo in README.md', { readOnly: true, anchors: ['README.md'] });
    expect(s.readOnly).toBe(true);
    expect(s.hasExplicitAnchors).toBe(true);
  });
});
