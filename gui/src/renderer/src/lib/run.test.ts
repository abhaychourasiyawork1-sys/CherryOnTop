import { describe, it, expect } from 'vitest';
import { phaseOf, resultOf, failureOf, revertGoal, titleOf, filesChanged } from './run.js';
import { node } from './fixtures.js';

describe('run phase', () => {
  it('shows several agents as one organization in one phase', () => {
    const root = node({ id: 'r', state: 'DELEGATE', childCount: 2 });
    const kids = [
      node({ id: 'a', parentId: 'r', state: 'SELF_EXECUTE' }),
      node({ id: 'b', parentId: 'r', state: 'PLAN' }),
    ];
    expect(phaseOf(root, [root, ...kids])).toBe('working');
  });

  it('moves through investigating → working → verifying', () => {
    expect(phaseOf(node({ id: 'r', state: 'PLAN' }), [node({ id: 'r', state: 'PLAN' })])).toBe('investigating');
    expect(phaseOf(node({ id: 'r', state: 'SELF_EXECUTE' }), [node({ id: 'r', state: 'SELF_EXECUTE' })])).toBe('working');
    expect(phaseOf(node({ id: 'r', state: 'VERIFY' }), [node({ id: 'r', state: 'VERIFY' })])).toBe('verifying');
  });

  it('waiting on a person beats everything live', () => {
    const root = node({ id: 'r', state: 'DELEGATE', childCount: 2 });
    expect(phaseOf(root, [root, node({ id: 'a', state: 'SELF_EXECUTE' }), node({ id: 'b', state: 'WAIT_APPROVAL' })])).toBe('waiting');
  });

  it('settles with the root', () => {
    expect(phaseOf(node({ id: 'r', state: 'COMPLETE' }), [])).toBe('done');
    expect(phaseOf(node({ id: 'r', state: 'INTERRUPTED' }), [])).toBe('paused');
  });
});

describe('result', () => {
  const artifacts = [
    { id: '1', nodeId: 'r', kind: 'file_edit', path: 'src/a.ts', summary: '' },
    { id: '2', nodeId: 'r', kind: 'file_edit', path: 'src/a.ts', summary: '' },
    { id: '3', nodeId: 'r', kind: 'file_write', path: 'src/b.ts', summary: '' },
    { id: '4', nodeId: 'r', kind: 'command', path: null, summary: 'npm test' },
  ];

  it('turns a completed run into a compact result', () => {
    const result = resultOf(node({ id: 'r', goal: 'Refactor the auth flow. Keep the API.' }), artifacts, { met: 3, unmet: 0, unverified: 0, total: 3 });
    expect(result).toMatchObject({ title: 'Refactor the auth flow', status: 'complete', filesChanged: ['src/a.ts', 'src/b.ts'] });
  });

  it('never calls a run with unmet checks complete', () => {
    expect(resultOf(node({ id: 'r' }), [], { met: 1, unmet: 1, unverified: 0, total: 2 }).status).toBe('incomplete');
  });

  it('titles long goals by their first sentence', () => {
    expect(titleOf('Fix the typo in greet.js. Then run tests.')).toBe('Fix the typo in greet.js');
    expect(titleOf('\n\nhello')).toBe('hello');
    expect(titleOf('<!-- canary GUID 26b5 -->\nBuild the React frontend.')).toBe('Build the React frontend');
    expect(filesChanged(artifacts)).toHaveLength(2);
  });
});

describe('failure and revert', () => {
  it('says what happened, what changed, and what is next', () => {
    const failure = failureOf(
      node({ id: 'r', state: 'FAILED' }),
      [{ id: 1, nodeId: 'r', type: 'step.outcome', payload: { succeeded: false, message: 'Request timed out' }, createdAt: '' }],
      [],
    );
    expect(failure).toEqual({ whatHappened: 'Request timed out', whatIDid: 'No files were changed.', next: 'retry' });
  });

  it('offers resume for interrupted work and admits changed files', () => {
    const failure = failureOf(node({ id: 'r', state: 'INTERRUPTED' }), [],
      [{ id: '1', nodeId: 'r', kind: 'file_edit', path: 'a.ts', summary: '' }]);
    expect(failure.next).toBe('resume');
    expect(failure.whatIDid).toMatch(/1 file was changed/);
  });

  it('a revert is a new, traceable instruction that names the original run', () => {
    const goal = revertGoal(node({ id: 'run-42', goal: 'Add caching.' }), ['src/cache.ts']);
    expect(goal).toContain('run-42');
    expect(goal).toContain('- src/cache.ts');
    expect(goal).toMatch(/stop and report the conflict/);
  });
});
