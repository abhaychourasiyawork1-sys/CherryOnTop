import { describe, it, expect } from 'vitest';
import { encodeSnapshot, decodeSnapshot } from './sync.js';
import { mergeEvents } from './eventLog.js';
import { node } from './fixtures.js';

describe('cached state', () => {
  it('round-trips a snapshot', () => {
    const raw = encodeSnapshot([node({ id: 'a' })], [], new Date('2026-09-01T00:00:00Z'));
    const snapshot = decodeSnapshot(raw)!;
    expect(snapshot.nodes.map((n) => n.id)).toEqual(['a']);
    expect(snapshot.savedAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('treats a corrupt or foreign cache as no cache', () => {
    expect(decodeSnapshot('{')).toBeNull();
    expect(decodeSnapshot(JSON.stringify({ version: 9, nodes: [], approvals: [] }))).toBeNull();
    const partial = decodeSnapshot(JSON.stringify({ version: 1, nodes: [{ id: 'x' }, node({ id: 'ok' })], approvals: [] }));
    expect(partial!.nodes.map((n) => n.id)).toEqual(['ok']);
  });

  it('keeps the newest nodes when trimming', () => {
    const many = Array.from({ length: 900 }, (_, i) =>
      node({ id: String(i), updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }));
    const snapshot = decodeSnapshot(encodeSnapshot(many, []))!;
    expect(snapshot.nodes).toHaveLength(800);
    expect(snapshot.nodes[0].id).toBe('899');
  });
});

describe('reconnect', () => {
  it('replaying history after a reconnect duplicates nothing', () => {
    const live = [{ id: 1, nodeId: 'a', type: 'x', createdAt: '' }, { id: 2, nodeId: 'a', type: 'y', createdAt: '' }];
    const replayed = [...live, { id: 3, nodeId: 'a', type: 'z', createdAt: '' }];
    const merged = mergeEvents(live, replayed);
    expect(merged.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(mergeEvents(merged, replayed)).toBe(merged);
  });
});
