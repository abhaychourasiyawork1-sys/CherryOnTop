import { describe, it, expect } from 'vitest';
import { mergeEvents, type OrgEvent } from './eventLog.js';

const event = (id: number): OrgEvent => ({ id, nodeId: 'n1', type: 'state.transition', createdAt: 't' });

describe('mergeEvents', () => {
  it('drops an event already replayed from history', () => {
    const history = [event(1), event(2)];
    expect(mergeEvents(history, [event(2), event(3)]).map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it('returns the same reference when nothing is new', () => {
    const history = [event(1)];
    expect(mergeEvents(history, [event(1)])).toBe(history);
  });

  it('orders by row id, not arrival — history can arrive after live events', () => {
    expect(mergeEvents([event(5)], [event(2)]).map((e) => e.id)).toEqual([2, 5]);
  });

  it('keeps events that carry no id rather than silently dropping them', () => {
    const anonymous = { nodeId: 'n1', type: 'x', createdAt: 't' };
    expect(mergeEvents([], [anonymous, anonymous])).toHaveLength(2);
  });

  it('caps retained history', () => {
    const many = Array.from({ length: 4200 }, (_, i) => event(i));
    const merged = mergeEvents([], many);
    expect(merged).toHaveLength(4000);
    expect(merged.at(-1)!.id).toBe(4199);
  });
});
