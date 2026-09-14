import { describe, it, expect } from 'vitest';
import {
  propagateFailure, detectEvidenceConflicts, resolveByPrecedence, type EvidenceClaim,
} from './conflicts.js';
import { dependentsOf, type WorkstreamNode } from './workstreams.js';

const node = (id: string, over: Partial<WorkstreamNode> = {}): WorkstreamNode => ({
  id,
  inputDependencies: [], informationDependencies: [],
  outputDependencies: [], validationDependencies: [], writePaths: [],
  ...over,
});

describe('an unrelated failure must not cancel healthy work', () => {
  it('leaves branches that share nothing with the failed one running', () => {
    const result = propagateFailure([node('a'), node('b'), node('c')], 'a');
    expect(result.cancelled).toEqual([]);
    expect(result.unaffected).toEqual(['b', 'c']);
  });

  it('leaves a branch that merely needed the same knowledge running', () => {
    // On a shared-context goal this is most of the fan-out. Cancelling it would
    // bin work that was going fine because something else died.
    const nodes = [
      node('a', { informationDependencies: ['src/auth/session.ts'] }),
      node('b', { informationDependencies: ['src/auth/session.ts'] }),
    ];
    expect(propagateFailure(nodes, 'a').unaffected).toEqual(['b']);
  });

  it('leaves a branch that writes a different file running', () => {
    const nodes = [node('a', { writePaths: ['src/a.ts'] }), node('b', { writePaths: ['src/b.ts'] })];
    expect(propagateFailure(nodes, 'a').cancelled).toEqual([]);
  });

  it('cancels nothing for a failure in a branch this plan does not contain', () => {
    // A stale id from a retried plan must not be able to take down a healthy run.
    const result = propagateFailure([node('a'), node('b')], 'from-an-older-plan');
    expect(result.cancelled).toEqual([]);
    expect(result.unaffected).toEqual(['a', 'b']);
    expect(result.reasons).toContain('unknown_workstream');
  });
});

describe('a dependency-linked failure must propagate', () => {
  it('cancels a branch that needed the failed branch’s output', () => {
    const nodes = [node('producer'), node('consumer', { inputDependencies: ['producer'] })];
    const result = propagateFailure(nodes, 'producer');
    expect(result.cancelled).toEqual(['consumer']);
    expect(result.reasons).toContain('cancelled:consumer:depends_on:producer');
  });

  it('cancels a dependent of a dependent', () => {
    const nodes = [
      node('a'),
      node('b', { inputDependencies: ['a'] }),
      node('c', { inputDependencies: ['b'] }),
      node('unrelated'),
    ];
    const result = propagateFailure(nodes, 'a');
    expect(result.cancelled).toEqual(['b', 'c']);
    expect(result.unaffected).toEqual(['unrelated']);
  });

  it('cancels a branch that had to be validated against the failed one', () => {
    const nodes = [node('impl'), node('check', { validationDependencies: ['impl'] })];
    expect(propagateFailure(nodes, 'impl').cancelled).toEqual(['check']);
  });

  it('respects a dependency stated from the producing side', () => {
    const nodes = [node('producer', { outputDependencies: ['consumer'] }), node('consumer')];
    expect(propagateFailure(nodes, 'producer').cancelled).toEqual(['consumer']);
  });

  it('does not cancel upstream — the producer already did its work', () => {
    const nodes = [node('producer'), node('consumer', { inputDependencies: ['producer'] })];
    expect(propagateFailure(nodes, 'consumer').cancelled).toEqual([]);
  });

  it('terminates on a dependency cycle rather than looping', () => {
    const nodes = [node('a', { inputDependencies: ['b'] }), node('b', { inputDependencies: ['a'] })];
    expect(dependentsOf(nodes, 'a')).toEqual(['b']);
  });
});

describe('contradictory evidence from parallel workstreams', () => {
  const claim = (over: Partial<EvidenceClaim> = {}): EvidenceClaim => ({
    id: 'c1', subject: 'src/auth/session.ts', content: 'reads the store first',
    revision: 'rev-1', validated: false, workstreamId: 'a', createdAt: '2026-09-14T00:00:00.000Z',
    ...over,
  });

  it('reports two branches that disagree about one subject', () => {
    const conflicts = detectEvidenceConflicts([
      claim({ id: 'c1', workstreamId: 'a', content: 'reads the store first' }),
      claim({ id: 'c2', workstreamId: 'b', content: 'reads the cookie first' }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].evidenceIds).toEqual(['c1', 'c2']);
    expect(conflicts[0].resolved).toBe(false);
  });

  it('does not report two branches that agree — that is the most useful signal there is', () => {
    const conflicts = detectEvidenceConflicts([
      claim({ id: 'c1', workstreamId: 'a' }),
      claim({ id: 'c2', workstreamId: 'b' }),
    ]);
    expect(conflicts).toEqual([]);
  });

  it('does not report one branch revising its own view', () => {
    const conflicts = detectEvidenceConflicts([
      claim({ id: 'c1', workstreamId: 'a', content: 'first guess' }),
      claim({ id: 'c2', workstreamId: 'a', content: 'better answer' }),
    ]);
    expect(conflicts).toEqual([]);
  });

  it('does not report branches describing different subjects', () => {
    const conflicts = detectEvidenceConflicts([
      claim({ id: 'c1', workstreamId: 'a', subject: 'src/a.ts', content: 'x' }),
      claim({ id: 'c2', workstreamId: 'b', subject: 'src/b.ts', content: 'y' }),
    ]);
    expect(conflicts).toEqual([]);
  });

  it('calls two checked claims disagreeing the worst case', () => {
    // Something checked both and they still disagree: either a check is wrong
    // or the tree moved underneath. Two guesses disagreeing is ordinary.
    const checked = detectEvidenceConflicts([
      claim({ id: 'c1', workstreamId: 'a', content: 'x', validated: true }),
      claim({ id: 'c2', workstreamId: 'b', content: 'y', validated: true }),
    ]);
    const guesses = detectEvidenceConflicts([
      claim({ id: 'c1', workstreamId: 'a', content: 'x' }),
      claim({ id: 'c2', workstreamId: 'b', content: 'y' }),
    ]);
    expect(checked[0].severity).toBe('high');
    expect(guesses[0].severity).toBe('low');
  });

  it('gives one disagreement one id, however often it is observed', () => {
    const claims = [
      claim({ id: 'c1', workstreamId: 'a', content: 'x' }),
      claim({ id: 'c2', workstreamId: 'b', content: 'y' }),
    ];
    expect(detectEvidenceConflicts(claims)[0].id)
      .toBe(detectEvidenceConflicts([...claims].reverse())[0].id);
  });

  it('is deterministic across several subjects', () => {
    const claims = [
      claim({ id: 'z1', subject: 'z.ts', workstreamId: 'a', content: '1' }),
      claim({ id: 'z2', subject: 'z.ts', workstreamId: 'b', content: '2' }),
      claim({ id: 'a1', subject: 'a.ts', workstreamId: 'a', content: '1' }),
      claim({ id: 'a2', subject: 'a.ts', workstreamId: 'b', content: '2' }),
    ];
    expect(detectEvidenceConflicts(claims).map((c) => c.id))
      .toEqual(detectEvidenceConflicts([...claims].reverse()).map((c) => c.id));
  });
});

describe('precedence is stated, and it does not resolve anything', () => {
  const claim = (over: Partial<EvidenceClaim> = {}): EvidenceClaim => ({
    id: 'c1', subject: 's', content: 'x', revision: 'rev-0', validated: false,
    workstreamId: 'a', createdAt: '2026-09-14T00:00:00.000Z', ...over,
  });

  it('puts evidence about the tree as it stands above evidence about the tree as it was', () => {
    const { preferred, reasonCodes } = resolveByPrecedence([
      claim({ id: 'old', revision: 'rev-0', validated: true }),
      claim({ id: 'current', revision: 'rev-1', validated: false }),
    ], 'rev-1');
    // The architectural invariant, and it outranks even being checked.
    expect(preferred!.id).toBe('current');
    expect(reasonCodes).toContain('current_revision');
  });

  it('puts checked above asserted at the same revision', () => {
    const { preferred } = resolveByPrecedence([
      claim({ id: 'asserted', revision: 'rev-1' }),
      claim({ id: 'checked', revision: 'rev-1', validated: true }),
    ], 'rev-1');
    expect(preferred!.id).toBe('checked');
  });

  it('puts newer above older when nothing else separates them', () => {
    const { preferred } = resolveByPrecedence([
      claim({ id: 'old', createdAt: '2026-09-14T00:00:00.000Z' }),
      claim({ id: 'new', createdAt: '2026-09-15T00:00:00.000Z' }),
    ]);
    expect(preferred!.id).toBe('new');
  });

  it('gives the same answer twice', () => {
    const claims = [claim({ id: 'b' }), claim({ id: 'a' })];
    expect(resolveByPrecedence(claims).preferred!.id)
      .toBe(resolveByPrecedence([...claims].reverse()).preferred!.id);
  });

  it('keeps the loser rather than discarding it', () => {
    const { superseded } = resolveByPrecedence([
      claim({ id: 'winner', revision: 'rev-1' }),
      claim({ id: 'loser', revision: 'rev-0' }),
    ], 'rev-1');
    expect(superseded.map((c) => c.id)).toEqual(['loser']);
  });

  it('says out loud that nothing here established which claim is true', () => {
    const { reasonCodes } = resolveByPrecedence([
      claim({ id: 'a', content: 'x' }), claim({ id: 'b', content: 'y' }),
    ]);
    expect(reasonCodes).toContain('unresolved_disagreement');
  });

  it('handles an empty set without inventing a winner', () => {
    expect(resolveByPrecedence([])).toEqual({ preferred: null, superseded: [], reasonCodes: ['no_claims'] });
  });
});
