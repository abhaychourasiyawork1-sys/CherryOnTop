import { describe, it, expect } from 'vitest';
import { groupAttention, attentionCount, scopeAttention, type AttentionItem } from './attention.js';

const item = (partial: Partial<AttentionItem>): AttentionItem => ({
  kind: 'interrupted', nodeId: 'n', caseId: 'c', caseGoal: 'goal', nodeGoal: 'goal',
  detail: 'Stopped when the daemon did.', at: '2026-09-01T00:00:00Z', ...partial,
});

describe('intelligent attention', () => {
  it('an out-of-mandate approval interrupts; a refused tool only informs', () => {
    const groups = groupAttention([
      item({ kind: 'denied', nodeId: 'a', detail: 'Reached for Skill' }),
      item({ kind: 'approval', nodeId: 'b', approvalId: 'ap1', detail: 'Needs $20 more than its mandate allows' }),
    ]);
    expect(groups[0]).toMatchObject({ kind: 'approval', level: 'attention', type: 'approval' });
    expect(groups[1]).toMatchObject({ kind: 'denied', level: 'inform' });
  });

  it('one daemon restart that stopped four runs is one group', () => {
    const groups = groupAttention(['1', '2', '3', '4'].map((id) => item({ nodeId: id, caseId: `case-${id}` })));
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe('4 runs stopped when the daemon did');
    expect(groups[0].caseIds).toHaveLength(4);
  });

  it('keeps every approval its own decision', () => {
    const groups = groupAttention([
      item({ kind: 'approval', approvalId: 'a1', nodeId: 'x' }),
      item({ kind: 'approval', approvalId: 'a2', nodeId: 'y' }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['approval:a1', 'approval:a2']);
  });

  it('deduplicates the same fact reported twice', () => {
    const groups = groupAttention([item({}), item({})]);
    expect(groups[0].items).toHaveLength(1);
  });

  it('counts only what needs a person, by case', () => {
    const groups = groupAttention([
      item({ nodeId: 'a', caseId: 'c1' }),
      item({ nodeId: 'b', caseId: 'c1' }),
      item({ kind: 'over_budget', caseId: 'c2' }),
    ]);
    expect(attentionCount(groups)).toBe(1);
  });

  it('scopes to one workspace', () => {
    const scoped = scopeAttention([item({ caseId: 'mine' }), item({ caseId: 'theirs' })], new Set(['mine']));
    expect(scoped.map((i) => i.caseId)).toEqual(['mine']);
  });
});
