import { describe, it, expect } from 'vitest';
import { toLedgerEntries, matchesLens, approvalTitle } from './ledger.js';

const base = {
  nodeIds: ['root', 'kid'],
  events: [
    { id: 1, nodeId: 'kid', type: 'authority.denied', payload: { tool: 'Bash' }, createdAt: 't5' },
    { id: 2, nodeId: 'elsewhere', type: 'authority.denied', payload: { tool: 'Write' }, createdAt: 't6' },
    { id: 3, nodeId: 'kid', type: 'exec.assistant', payload: {}, createdAt: 't7' },
  ],
  decisions: [
    { id: 'd1', nodeId: 'root', type: 'execution_decision', outcome: 'DELEGATE', breakdown: {}, createdAt: 't1' },
    { id: 'd2', nodeId: 'elsewhere', type: 'execution_decision', outcome: 'DELEGATE', breakdown: {}, createdAt: 't2' },
  ],
  artifacts: [
    { id: 'a1', nodeId: 'kid', kind: 'file_write', path: 'src/x.ts', summary: 'Write', createdAt: 't3' },
    { id: 'a2', nodeId: 'elsewhere', kind: 'file_write', path: 'src/y.ts', summary: 'Write', createdAt: 't4' },
  ],
  approvals: [
    { id: 'p1', nodeId: 'root', reason: 'more budget', status: 'approved', createdAt: 't0', resolvedAt: 't8' },
    { id: 'p2', nodeId: 'elsewhere', reason: 'other', status: 'approved', createdAt: 't0' },
  ],
};

describe('the proof ledger', () => {
  it('never lets another case`s record into this one', () => {
    const entries = toLedgerEntries(base);
    expect(entries.every((entry) => entry.nodeId !== 'elsewhere')).toBe(true);
    expect(entries).toHaveLength(4);
  });

  it('ignores the exec firehose — a ledger is not a log', () => {
    expect(toLedgerEntries(base).some((entry) => entry.title.includes('assistant'))).toBe(false);
  });

  it('is newest first, and dates an approval by when it was answered', () => {
    const entries = toLedgerEntries(base);
    expect(entries.map((entry) => entry.at)).toEqual(['t8', 't5', 't3', 't1']);
  });

  it('describes a human decision from the person`s side', () => {
    expect(approvalTitle('approved')).toBe('You allowed it');
    expect(approvalTitle('rejected')).toBe('You refused it');
    // Cancelled is not something anyone chose; saying "you" there would be a lie.
    expect(approvalTitle('cancelled')).toContain('the run stopped first');
  });

  it('filters by the question being asked', () => {
    const entries = toLedgerEntries(base);
    const of = (lens: Parameters<typeof matchesLens>[1]) =>
      entries.filter((entry) => matchesLens(entry, lens)).map((entry) => entry.kind);
    expect(of('all')).toHaveLength(4);
    expect(of('decisions')).toEqual(['decision']);
    expect(of('produced')).toEqual(['artifact']);
    expect(of('authority').sort()).toEqual(['approval', 'denial']);
    expect(of('people')).toEqual(['approval']);
  });
});
