import { describe, it, expect } from 'vitest';
import {
  buildCandidates, buildDependencyEdges, resolveImport, artifactRole,
  renderAt, tokensAt, offersFullArtifact, materializationFor, EVIDENCE_LADDER,
} from './candidates.js';
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

  it('falls back to what the repository depends on when the goal points at nothing', () => {
    // The defect this replaces: a goal naming no file and matching no word
    // produced an empty candidate set, and the selector's "uncertainty widens"
    // rule then relaxed a test over nothing. Widening has to happen at
    // *generation*, or it does not happen at all.
    const found = paths('xyzzy plugh');
    expect(found.length).toBeGreaterThan(0);
    expect(found).toContain('src/auth/store.ts');
  });

  it('marks such a candidate as weak evidence, so the floor fires and the selector widens', () => {
    const central = build('xyzzy plugh', []).find((c) => c.path === 'src/auth/store.ts')!;
    // "Everything imports this" is a fact about the repository, not about the
    // goal. It earns a place in the set and almost no confidence.
    expect(central.confidenceScore).toBeLessThan(0.3);
    expect(central.relationships.some((r) => r.startsWith('depended-on-by:'))).toBe(true);
  });

  it('still produces nothing when the repository has no dependencies either', () => {
    const isolated = [
      { path: 'a.ts', symbols: [], imports: [] },
      { path: 'b.ts', symbols: [], imports: [] },
    ];
    expect(buildCandidates({
      entries: isolated, goal: 'xyzzy plugh', anchors: [],
      taskFit: { verificationNeed: 0.5, investigationLikelihood: 0.5, readOnly: false },
    })).toEqual([]);
  });

  it('does not mix centrality in once something is anchored', () => {
    // With an anchor in hand, adjacency to it is far better evidence, and
    // diluting it with "much of the repo depends on this" would rank a popular
    // unrelated module beside the file the goal named.
    const anchored = build('fix src/auth/session.ts', ['src/auth/session.ts']);
    expect(anchored.every((c) => !c.relationships.some((r) => r.startsWith('depended-on-by:')))).toBe(true);
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

describe('evidence levels L0 to L3', () => {
  const shape = {
    path: 'src/auth/session.ts',
    symbols: ['refreshSession', 'expireSession'],
    relationships: ['imports:src/auth/store.ts', 'tested-by:src/auth/session.test.ts'],
    fullArtifactTokens: 900,
  };

  it('names four levels, cheapest first', () => {
    expect(EVIDENCE_LADDER).toEqual(['L0', 'L1', 'L2', 'L3']);
  });

  it('prices each level above the one below it', () => {
    const prices = EVIDENCE_LADDER.map((level) => tokensAt(shape, level));
    for (let i = 1; i < prices.length; i++) expect(prices[i]).toBeGreaterThan(prices[i - 1]);
  });

  it('renders metadata, structural and focused evidence distinctly', () => {
    expect(renderAt(shape, 'L0')).toBe('  src/auth/session.ts');
    expect(renderAt(shape, 'L1')).toContain('refreshSession');
    expect(renderAt(shape, 'L1')).not.toContain('imports:');
    expect(renderAt(shape, 'L2')).toContain('imports:src/auth/store.ts');
  });

  it('prices the full artifact from the size the inventory already knew', () => {
    expect(tokensAt(shape, 'L3')).toBe(900);
  });

  it('never renders a full artifact — this module does not read files', () => {
    expect(renderAt(shape, 'L3')).toBe(renderAt(shape, 'L2'));
  });

  it('does not offer a level it cannot price', () => {
    const unsized = { ...shape, fullArtifactTokens: undefined };
    expect(offersFullArtifact(unsized)).toBe(false);
    expect(offersFullArtifact(shape)).toBe(true);
    // And asking anyway gets the honest L2 price, never an invented file size.
    expect(tokensAt(unsized, 'L3')).toBe(tokensAt(unsized, 'L2'));
  });

  it('never prices a full artifact below its own description', () => {
    expect(tokensAt({ ...shape, fullArtifactTokens: 1 }, 'L3')).toBeGreaterThanOrEqual(tokensAt(shape, 'L2'));
  });

  it('says that materializing L3 is a file read whatever the candidate claims', () => {
    expect(materializationFor({ materialization: 'inventory' }, 'L2')).toBe('inventory');
    expect(materializationFor({ materialization: 'inventory' }, 'L3')).toBe('read-file');
  });
});

describe('buildCandidates and evidence levels', () => {
  const entries = [
    { path: 'src/auth/session.ts', symbols: ['refreshSession'], imports: [], bytes: 4000 },
    { path: 'src/auth/store.ts', symbols: ['readStore'], imports: [] },
  ];

  it('offers the full-artifact level exactly when the scan recorded a size', () => {
    const built = buildCandidates({
      entries, goal: 'fix refreshSession in src/auth/session.ts', anchors: ['session.ts'],
      taskFit: { verificationNeed: 0.5, investigationLikelihood: 0.3, readOnly: false },
    });
    const sized = built.find((c) => c.path === 'src/auth/session.ts')!;
    expect(sized.evidenceLevel).toBe('L3');
    expect(sized.fullArtifactTokens).toBe(1000);
  });

  it('keeps estimatedTokens at the cheap inventory price, never the file price', () => {
    const built = buildCandidates({
      entries, goal: 'fix refreshSession in src/auth/session.ts', anchors: ['session.ts'],
      taskFit: { verificationNeed: 0.5, investigationLikelihood: 0.3, readOnly: false },
    });
    const sized = built.find((c) => c.path === 'src/auth/session.ts')!;
    // Including a candidate must never accidentally price in a file read nobody
    // asked for.
    expect(sized.estimatedTokens).toBeLessThan(100);
  });
});
