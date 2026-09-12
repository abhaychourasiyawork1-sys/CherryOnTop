import { describe, it, expect } from 'vitest';
import { projectObservation, projectionFor, PROJECTIONS } from './registry.js';
import type { Observation } from '../observation.js';

const observation = (over: Partial<Observation> = {}): Observation => ({
  observationId: 'o1',
  tool: { name: 'Bash', operation: undefined },
  invocation: { callId: 't1', input: {} },
  execution: { nodeId: 'n1', sequence: 0, succeeded: true },
  raw: '',
  semanticId: 'observation:Bash:abc',
  ...over,
});

const bash = (command: string, raw: string, operation?: string) => observation({
  tool: { name: 'Bash', operation: operation ?? command.split(/\s+/).slice(0, 2).join('/') },
  invocation: { callId: 't1', input: { command } },
  raw,
});

describe('the registry', () => {
  it('is ordered narrowest first, so a broad projection cannot claim output a real reducer understands', () => {
    // `runtime-log` matches npm/docker/kubectl broadly. `pnpm test` is a test
    // run, and must reach the test projection.
    expect(PROJECTIONS.at(-1)!.name).toBe('runtime-log');
    expect(projectionFor(bash('pnpm test', 'x'))!.name).toBe('test');
    expect(projectionFor(bash('npm install', 'x'))!.name).toBe('runtime-log');
  });

  it('falls back explicitly rather than silently', () => {
    const unknown = bash('some-bespoke-tool --run', Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'));
    expect(projectionFor(unknown)).toBeUndefined();
    const projected = projectObservation(unknown);
    expect(projected.projection).toBe('generic');
    expect(projected.text).toMatch(/lines omitted/);
  });

  it('always keeps a ref to the full output, whatever the mode', () => {
    // Reduction is a view. A view that cannot be un-taken is data loss wearing
    // an efficiency badge.
    const o = bash('git status', ' M src/a.ts');
    for (const mode of ['reference', 'reduced', 'full'] as const) {
      expect(projectObservation(o, mode).fullRef).toBe(o.semanticId);
    }
  });

  it('reference mode costs almost nothing and names the tool', () => {
    const o = bash('git diff', 'x'.repeat(100_000));
    const projected = projectObservation(o, 'reference');
    expect(projected.text.length).toBeLessThan(100);
    expect(projected.text).toContain('git/diff');
  });

  it('full mode is verbatim', () => {
    const o = bash('git diff', 'exactly this');
    expect(projectObservation(o, 'full').text).toBe('exactly this');
  });
});

describe('git', () => {
  it('keeps the shape of a diff and drops its body', () => {
    const diff = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      'index abc..def 100644',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -1,5 +1,7 @@',
      ' const unchanged = 1;',
      '-const removed = 2;',
      '+const added = 3;',
    ].join('\n');
    const text = projectObservation(bash('git diff', diff)).text;
    expect(text).toContain('diff --git a/src/auth.ts');
    expect(text).toContain('@@ -1,5 +1,7 @@');
    // The body is what an expansion is for.
    expect(text).not.toContain('const unchanged');
  });

  it('keeps a status readable', () => {
    const status = ['On branch main', ' M src/a.ts', '?? src/b.ts'].join('\n');
    const text = projectObservation(bash('git status', status)).text;
    expect(text).toContain('src/a.ts');
    expect(text).toContain('src/b.ts');
  });

  it('leaves an empty result alone', () => {
    expect(projectObservation(bash('git status', '')).reduction.reduced).toBe(false);
  });
});

describe('search', () => {
  it('keeps hits and drops the context lines around them', () => {
    const output = [
      'src/auth.ts:12:export function login() {',
      'src/auth.ts-13-  return 1;',
      'src/cart.ts:40:function login2() {}',
      '2 matches',
    ].join('\n');
    const text = projectObservation(bash('rg login', output)).text;
    expect(text).toContain('src/auth.ts:12');
    expect(text).toContain('2 matches');
    expect(text).not.toContain('return 1;');
  });

  it('claims the Grep tool as well as the shell command', () => {
    const grep = observation({ tool: { name: 'Grep' }, raw: 'src/a.ts:1:hit' });
    expect(projectionFor(grep)!.name).toBe('search');
  });
});

describe('test and build', () => {
  it('keeps the three lines that matter out of a thousand that do not', () => {
    // The case the whole registry exists for. Truncating at the top keeps the
    // passes; this keeps the answer.
    const log = [
      ...Array.from({ length: 500 }, (_, i) => `✓ src/x${i}.test.ts > passes`),
      'FAIL  src/auth.test.ts > refuses an expired token',
      'AssertionError: expected true to be false',
      ' ❯ src/auth.test.ts:42:19',
      ...Array.from({ length: 500 }, (_, i) => `✓ src/y${i}.test.ts > passes`),
      ' Tests  1 failed | 1000 passed (1001)',
    ].join('\n');

    const projected = projectObservation(bash('pnpm test', log));
    expect(projected.projection).toBe('test');
    expect(projected.text).toContain('refuses an expired token');
    expect(projected.text).toContain('expected true to be false');
    expect(projected.text).toContain('1 failed | 1000 passed');
    expect(projected.text).not.toContain('x250');
    expect(projected.reduction.keptLines).toBeLessThan(10);
    expect(projected.reduction.strategy).toBe('semantic');
  });

  it('keeps compiler diagnostics with their locations', () => {
    const log = [
      'src/a.ts(12,5): error TS2741: Property x is missing',
      'src/b.ts(1,1): error TS2307: Cannot find module',
      'Found 2 errors.',
    ].join('\n');
    const projected = projectObservation(bash('tsc --noEmit', log));
    expect(projected.projection).toBe('build');
    expect(projected.text).toContain('TS2741');
    expect(projected.text).toContain('src/b.ts');
  });

  it('still says something useful about a run where everything passed', () => {
    const projected = projectObservation(bash('pnpm test', '✓ a\n✓ b\n Tests  2 passed (2)'));
    expect(projected.text).toContain('2 passed');
  });
});

describe('filesystem', () => {
  it('does not second-guess a file the agent chose to read', () => {
    // The one decision we have no better information about than the agent did.
    const content = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    const projected = projectObservation(observation({ tool: { name: 'Read' }, raw: content }));
    expect(projected.projection).toBe('filesystem');
    expect(projected.text).toBe(content);
    expect(projected.reduction.reduced).toBe(false);
  });

  it('collapses the repetition a build-output listing produces', () => {
    const listing = Array.from({ length: 200 }, () => 'chunk.js').join('\n');
    expect(projectObservation(observation({ tool: { name: 'LS' }, raw: listing })).text).toContain('[× 200]');
  });
});

describe('runtime logs', () => {
  it('keeps the verdict lines out of a container log', () => {
    const log = [
      ...Array.from({ length: 100 }, () => 'progress...'),
      'npm ERR! code ELIFECYCLE',
      'added 402 packages in 9s',
    ].join('\n');
    const projected = projectObservation(bash('npm install', log));
    expect(projected.projection).toBe('runtime-log');
    expect(projected.text).toContain('ELIFECYCLE');
    expect(projected.text).toContain('added 402 packages');
    expect(projected.text).not.toContain('progress...\nprogress...');
  });

  it('keeps a kubectl table readable', () => {
    const log = ['NAME  READY  STATUS', 'org-job-1  0/1  CrashLoopBackOff'].join('\n');
    const text = projectObservation(bash('kubectl get pods', log)).text;
    expect(text).toContain('CrashLoopBackOff');
  });
});

describe('token-estimate regressions on representative long output', () => {
  const ratio = (raw: string, command: string) => {
    const projected = projectObservation(bash(command, raw));
    return projected.text.length / raw.length;
  };

  it('cuts a long test log by more than an order of magnitude', () => {
    const log = [
      ...Array.from({ length: 2000 }, (_, i) => `✓ src/x${i}.test.ts > a reasonably long test name here`),
      'FAIL src/a.test.ts > one failure',
      ' Tests  1 failed | 2000 passed',
    ].join('\n');
    expect(ratio(log, 'pnpm test')).toBeLessThan(0.02);
  });

  it('cuts a long diff by more than half', () => {
    // A realistic hunk: a header and a marker, then a body of ten lines. The
    // body is what an expansion is for, and what this drops.
    const diff = Array.from({ length: 200 }, (_, i) => [
      `diff --git a/f${i}.ts b/f${i}.ts`,
      '@@ -1,10 +1,10 @@',
      ...Array.from({ length: 10 }, (_, j) => ` const untouched${j} = ${i};`),
    ].join('\n')).join('\n');
    expect(ratio(diff, 'git diff')).toBeLessThan(0.25);
  });

  it('never grows the output it was given', () => {
    for (const [command, raw] of [
      ['git status', ' M a.ts'],
      ['pnpm test', '✓ ok'],
      ['rg x', 'a.ts:1:x'],
      ['npm install', 'added 1 package'],
      ['npm install', 'nothing a reducer recognises at all'],
      ['unknown-tool', 'short'],
    ] as const) {
      // A reducer may add a short marker saying what it did; it must never add
      // more than that.
      expect(projectObservation(bash(command, raw)).text.length).toBeLessThanOrEqual(raw.length + 40);
    }
  });
});
