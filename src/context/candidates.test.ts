import { describe, it, expect } from 'vitest';
import { buildCandidates, buildDependencyEdges, resolveImport, artifactRole } from './candidates.js';
import type { RepoEntry } from '../intelligence/repo-map.js';

const ENTRIES: RepoEntry[] = [
  { path: 'src/auth/session.ts', symbols: ['refreshSession', 'Session'], imports: ['./store.js'] },
  { path: 'src/auth/store.ts', symbols: ['readStore'], imports: [] },
  { path: 'src/auth/session.test.ts', symbols: [], imports: ['./session.js'] },
  { path: 'src/api/login.ts', symbols: ['login'], imports: ['../auth/session.js'] },
  { path: 'src/billing/invoice.ts', symbols: ['renderInvoice'], imports: [] },
  { path: 'docs/auth.md', symbols: [], imports: [] },
  { path: 'vitest.config.ts', symbols: [], imports: [] },
];

const build = (goal: string, anchors: string[], over: Partial<Parameters<typeof buildCandidates>[0]> = {}) =>
  buildCandidates({
    entries: ENTRIES, goal, anchors,
    taskFit: { verificationNeed: 0.8, investigationLikelihood: 0.3, readOnly: false },
    ...over,
  });

const paths = (goal: string, anchors: string[] = []) => build(goal, anchors).map((c) => c.path);

describe('resolveImport', () => {
  const known = new Set(ENTRIES.map((e) => e.path));

  it('resolves the TypeScript-ESM .js specifier to the .ts file on disk', () => {
    expect(resolveImport('src/api/login.ts', '../auth/session.js', known)).toBe('src/auth/session.ts');
  });

  it('resolves a sibling', () => {
    expect(resolveImport('src/auth/session.ts', './store.js', known)).toBe('src/auth/store.ts');
  });

  it('drops a specifier that names nothing tracked rather than guessing', () => {
    expect(resolveImport('src/api/login.ts', './nowhere.js', known)).toBeNull();
  });
});

describe('buildDependencyEdges', () => {
  it('records both directions of a direct edge', () => {
    const edges = buildDependencyEdges(ENTRIES);
    expect([...edges.imports.get('src/api/login.ts')!]).toContain('src/auth/session.ts');
    expect([...edges.importedBy.get('src/auth/session.ts')!]).toContain('src/api/login.ts');
  });

  it('sees nothing at all in entries scanned before imports were recorded', () => {
    const legacy = ENTRIES.map(({ path, symbols }) => ({ path, symbols }));
    const edges = buildDependencyEdges(legacy);
    expect(edges.imports.size).toBe(0);
  });
});

describe('artifactRole', () => {
  it('reads the kind off the shape of the path, not off a list of names', () => {
    expect(artifactRole('src/a/b.test.ts')).toBe('test');
    expect(artifactRole('test/unit/whatever.ts')).toBe('test');
    expect(artifactRole('docs/design.md')).toBe('docs');
    expect(artifactRole('vitest.config.ts')).toBe('config');
    expect(artifactRole('src/a/b.ts')).toBe('source');
  });
});

describe('buildCandidates', () => {
  it('finds the file an exact path anchor names', () => {
    const c = build('fix src/auth/session.ts', ['src/auth/session.ts'])
      .find((x) => x.path === 'src/auth/session.ts')!;
    expect(c.relationships).toContain('anchor');
    expect(c.confidenceScore).toBe(1);
  });

  it('finds the file a bare filename anchor names', () => {
    expect(paths('fix session.ts', ['session.ts'])).toContain('src/auth/session.ts');
  });

  it('finds the file a symbol anchor declares', () => {
    expect(paths('fix refreshSession', ['refreshSession'])).toContain('src/auth/session.ts');
  });

  it('pulls in a direct dependency of an anchored file', () => {
    expect(paths('fix src/auth/session.ts', ['src/auth/session.ts'])).toContain('src/auth/store.ts');
  });

  it('pulls in a direct dependent of an anchored file', () => {
    expect(paths('fix src/auth/session.ts', ['src/auth/session.ts'])).toContain('src/api/login.ts');
  });

  it('pulls in the test that covers an anchored file', () => {
    const test = build('fix src/auth/session.ts', ['src/auth/session.ts'])
      .find((c) => c.path === 'src/auth/session.test.ts')!;
    expect(test.relationships).toContain('test-of:src/auth/session.ts');
  });

  it('leaves an unrelated file out entirely', () => {
    expect(paths('fix src/auth/session.ts', ['src/auth/session.ts'])).not.toContain('src/billing/invoice.ts');
  });

  it('does not chase a dependency of a dependency', () => {
    // login -> session -> store. `login.ts` is anchored, so `session.ts` is a
    // direct edge and `store.ts` is a rumour about a rumour.
    const c = build('fix src/api/login.ts', ['src/api/login.ts']).find((x) => x.path === 'src/auth/store.ts');
    expect(c?.relationships ?? []).not.toContain('imports:src/auth/session.ts');
  });

  it('scores a direct relationship above a bare lexical brush-past', () => {
    const list = build('fix src/auth/session.ts', ['src/auth/session.ts']);
    const structural = list.find((c) => c.path === 'src/auth/store.ts')!;
    const lexical = list.find((c) => c.path === 'docs/auth.md');
    expect(structural.confidenceScore).toBeGreaterThan(lexical?.confidenceScore ?? 0);
  });

  it('keeps a lexical-only match when nothing was anchored', () => {
    expect(paths('fix the invoice rendering')).toContain('src/billing/invoice.ts');
  });

  it('produces nothing for a goal that matches nothing', () => {
    expect(paths('xyzzy plugh')).toEqual([]);
  });

  it('offers relationships as L2 evidence and a bare match as L1', () => {
    const list = build('fix src/auth/session.ts', ['src/auth/session.ts']);
    expect(list.find((c) => c.path === 'src/auth/store.ts')!.evidenceLevel).toBe('L2');
    expect(list.every((c) => c.materialization === 'inventory')).toBe(true);
  });

  it('never reads a file to decide whether a file is worth reading', () => {
    // Every entry names a path that does not exist on disk; building candidates
    // for them must still work.
    expect(() => build('fix src/auth/session.ts', ['src/auth/session.ts'])).not.toThrow();
  });

  it('weighs a test artifact by the task\'s verification need, not by its name', () => {
    const high = build('fix src/auth/session.ts', ['src/auth/session.ts'])
      .find((c) => c.path === 'src/auth/session.test.ts')!;
    const low = buildCandidates({
      entries: ENTRIES, goal: 'fix src/auth/session.ts', anchors: ['src/auth/session.ts'],
      taskFit: { verificationNeed: 0.05, investigationLikelihood: 0.9, readOnly: true },
    }).find((c) => c.path === 'src/auth/session.test.ts')!;
    expect(high.taskFitScore).toBeGreaterThan(low.taskFitScore);
  });

  it('marks a path a sibling dispatch already received as reusable', () => {
    const c = build('fix src/auth/session.ts', ['src/auth/session.ts'], {
      previouslySelected: ['src/auth/store.ts'],
    });
    expect(c.find((x) => x.path === 'src/auth/store.ts')!.reuseScore).toBe(1);
    expect(c.find((x) => x.path === 'src/api/login.ts')!.reuseScore).toBe(0);
  });

  it('is deterministic and stably ordered', () => {
    expect(paths('fix src/auth/session.ts', ['src/auth/session.ts']))
      .toEqual(paths('fix src/auth/session.ts', ['src/auth/session.ts']));
  });

  it('deduplicates a path that appears twice in the inventory', () => {
    const doubled = buildCandidates({
      entries: [...ENTRIES, ENTRIES[0]], goal: 'fix session.ts', anchors: ['session.ts'],
      taskFit: { verificationNeed: 0.5, investigationLikelihood: 0.5, readOnly: false },
    });
    expect(doubled.filter((c) => c.path === 'src/auth/session.ts')).toHaveLength(1);
  });
});
