import { describe, it, expect, vi } from 'vitest';
import { publish, subscribeAll, subscribeToNode } from './bus.js';

describe('event bus', () => {
  it('delivers a published event to a global subscriber', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeAll(handler);
    publish({ nodeId: 'n1', type: 'test', payload: {}, createdAt: 't0' });
    expect(handler).toHaveBeenCalledWith({ nodeId: 'n1', type: 'test', payload: {}, createdAt: 't0' });
    unsubscribe();
  });

  it('delivers only matching-node events to a per-node subscriber', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToNode('n1', handler);
    publish({ nodeId: 'n1', type: 'a', payload: {}, createdAt: 't0' });
    publish({ nodeId: 'n2', type: 'b', payload: {}, createdAt: 't0' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].nodeId).toBe('n1');
    unsubscribe();
  });

  it('stops delivering after unsubscribe', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeAll(handler);
    unsubscribe();
    publish({ nodeId: 'n1', type: 'test', payload: {}, createdAt: 't0' });
    expect(handler).not.toHaveBeenCalled();
  });
});
