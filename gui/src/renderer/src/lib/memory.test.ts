import { describe, it, expect } from 'vitest';
import { workspaceMemory, gist, type CaseRecord } from './memory.js';

const record = (partial: Partial<CaseRecord> & { id: string; state?: string }): CaseRecord => ({
  node: { id: partial.id, goal: `Goal ${partial.id}.`, state: partial.state ?? 'COMPLETE', updatedAt: '2026-09-01T00:00:00Z' },
  mandate: null,
  dod: { items: [], progress: { met: 0, unmet: 0, total: 0 } },
  approvals: [],
  answer: null,
  ...partial,
});

describe('workspace memory', () => {
  it('turns a completed run’s answer into understanding, with provenance', () => {
    const items = workspaceMemory([record({
      id: 'c1', answer: '## Findings\n\nThe auth flow already validates tokens.\n\n| a | b |',
      dod: { items: [], progress: { met: 2, unmet: 0, total: 2 } },
    })]);
    expect(items).toEqual([expect.objectContaining({
      type: 'fact', section: 'understanding', text: 'The auth flow already validates tokens.',
      caseId: 'c1', caseTitle: 'Goal c1', confidence: 'confirmed',
    })]);
  });

  it('records a person’s rulings as decisions', () => {
    const items = workspaceMemory([record({
      id: 'c', approvals: [{ id: 'a', status: 'approved', reason: 'Spend $10 more' }, { id: 'b', status: 'pending', reason: 'x' }],
      dod: { items: [{ id: 'd', text: 'Tests pass', state: 'met', checkedAt: '2026-09-02T00:00:00Z' }], progress: { met: 1, unmet: 0, total: 1 } },
    })]);
    expect(items.filter((i) => i.type === 'decision').map((i) => i.text).sort()).toEqual(['Accepted as done: Tests pass', 'Approved: Spend $10 more']);
  });

  it('deduplicates constraints across runs', () => {
    const items = workspaceMemory([
      record({ id: 'a', mandate: { name: 'm', constraints: ['No network access'] } }),
      record({ id: 'b', mandate: { name: 'm', constraints: ['no network access '] } }),
    ]);
    expect(items.filter((i) => i.type === 'constraint')).toHaveLength(1);
  });

  it('keeps unfinished work as open threads, but not superseded runs', () => {
    const items = workspaceMemory([
      record({ id: 'f', state: 'FAILED' }),
      record({ id: 'g', state: 'FAILED', node: { id: 'g', goal: 'g', state: 'FAILED', updatedAt: '', supersededBy: 'h' } }),
    ]);
    expect(items.map((i) => i.id)).toEqual(['open:f']);
  });

  it('does not treat a run without an answer as knowledge', () => {
    expect(workspaceMemory([record({ id: 'x' })])).toEqual([]);
    expect(gist('# Title')).toBe('Title');
  });
});
