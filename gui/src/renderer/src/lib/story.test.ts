import { describe, it, expect } from 'vitest';
import { toStory } from './story.js';
import { node } from './fixtures.js';
import type { OrgEvent } from './eventLog.js';

let seq = 0;
const ev = (nodeId: string, type: string, payload: unknown = {}): OrgEvent =>
  ({ id: ++seq, nodeId, type, payload, createdAt: `2026-09-01T00:00:${String(seq).padStart(2, '0')}Z` });

describe('story', () => {
  const nodes = [
    node({ id: 'r', goal: 'Refactor auth. Keep API.' }),
    node({ id: 'a', parentId: 'r', goal: 'Read callers' }),
    node({ id: 'b', parentId: 'r', goal: 'Change middleware' }),
  ];

  it('turns meaningful state changes into readable entries and folds the noise', () => {
    seq = 0;
    const story = toStory([
      ev('r', 'state.transition', { state: 'CREATED' }),
      ev('r', 'exec.assistant'),
      ev('r', 'exec.assistant'),
      ev('r', 'decision.made', { outcome: 'DELEGATE' }),
      ev('r', 'state.transition', { state: 'COMPLETE' }),
    ], nodes);
    expect(story.map((e) => [e.title, e.detail])).toEqual([
      ['You asked', 'Refactor auth'],
      ['A decision was made', 'Split the work across agents'],
      ['Work completed', 'Refactor auth'],
    ]);
    expect(story[1].folded).toBe(2);
  });

  it('keeps links to every source record', () => {
    seq = 0;
    const events = [ev('r', 'exec.user'), ev('r', 'state.transition', { state: 'CREATED' }), ev('r', 'context.receipt')];
    const story = toStory(events, nodes);
    expect(story[0].sourceIds.sort()).toEqual([1, 2, 3]);
  });

  it('collapses repetitive entries deterministically', () => {
    seq = 0;
    const events = [
      ev('a', 'state.transition', { state: 'CREATED' }),
      ev('b', 'state.transition', { state: 'CREATED' }),
      ev('a', 'state.transition', { state: 'COMPLETE' }),
    ];
    const first = toStory(events, nodes);
    expect(first.map((e) => e.title)).toEqual(['An agent took on a piece', 'A piece was finished']);
    expect(first[0].detail).toBe('2 pieces · latest: Change middleware');
    expect(first[0].sourceIds).toEqual([1, 2]);
    expect(toStory(events, nodes)).toEqual(first);
  });

  it('stays fast on a very long history', () => {
    seq = 0;
    const events = Array.from({ length: 50_000 }, (_, i) => ev('r', i % 500 === 0 ? 'validation.result' : 'exec.assistant', { passed: true }));
    const started = performance.now();
    const story = toStory(events, nodes);
    expect(performance.now() - started).toBeLessThan(500);
    expect(story).toHaveLength(1);
    expect(story[0].folded).toBe(50_000 - 100);
  });
});

describe('story counts', () => {
  it('keeps counting past two', () => {
    seq = 0;
    const kids = ['a', 'b', 'c'].map((id) => node({ id, parentId: 'r', goal: id }));
    const story = toStory(kids.map((k) => ev(k.id, 'state.transition', { state: 'CREATED' })), [node({ id: 'r' }), ...kids]);
    expect(story[0].detail).toBe('3 pieces · latest: c');
  });
});
