import { describe, it, expect, vi } from 'vitest';
import { publish, subscribeAll, subscribeToNode, subscribeToPrefix } from './bus.js';

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

describe('subscribeToPrefix', () => {
  it('delivers a family of events without the subscriber filtering for itself', () => {
    const seen: string[] = [];
    const stop = subscribeToPrefix('economic.', (event) => seen.push(event.type));
    publish({ nodeId: 'n', type: 'economic.EVIDENCE_ACQUIRED', payload: {}, createdAt: 't' });
    publish({ nodeId: 'n', type: 'economic.TASK_COMPLETED', payload: {}, createdAt: 't' });
    publish({ nodeId: 'n', type: 'exec.assistant', payload: {}, createdAt: 't' });
    stop();
    expect(seen).toEqual(['economic.EVIDENCE_ACQUIRED', 'economic.TASK_COMPLETED']);
  });

  it('matches a prefix rather than a substring', () => {
    const seen: string[] = [];
    const stop = subscribeToPrefix('exec.', (event) => seen.push(event.type));
    publish({ nodeId: 'n', type: 'not.exec.assistant', payload: {}, createdAt: 't' });
    stop();
    expect(seen).toEqual([]);
  });

  it('stops delivering once unsubscribed', () => {
    const seen: string[] = [];
    subscribeToPrefix('economic.', (event) => seen.push(event.type))();
    publish({ nodeId: 'n', type: 'economic.TASK_STARTED', payload: {}, createdAt: 't' });
    expect(seen).toEqual([]);
  });
});
