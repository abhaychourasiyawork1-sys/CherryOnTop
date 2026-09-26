import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAnalyticsEventName, sanitizeMetadata } from '../src/analytics/events';
import { configureTracker, flush, getQueuedEvents, resetTracker, track } from '../src/analytics/tracker';

describe('analytics events', () => {
  it('accepts only approved event names', () => {
    expect(isAnalyticsEventName('hero_cta_clicked')).toBe(true);
    expect(isAnalyticsEventName('launch_form_submitted')).toBe(true);
    expect(isAnalyticsEventName('page_scrolled')).toBe(false);
    expect(isAnalyticsEventName('anything the visitor typed')).toBe(false);
    expect(isAnalyticsEventName(42)).toBe(false);
  });

  it('drops PII-like fields and values', () => {
    expect(
      sanitizeMetadata({
        email: 'a@example.com',
        repository: 'acme/app',
        model: 'x',
        provider: 'y',
        note: 'someone@example.com',
        repoPath: '/home/user/project',
        layer: 'runtime',
      }),
    ).toEqual({ layer: 'runtime' });
  });

  it('bounds metadata size', () => {
    const big: Record<string, string> = {};
    for (let index = 0; index < 20; index += 1) big[`k${index}`] = 'v';
    big.long = 'x'.repeat(500);
    const result = sanitizeMetadata(big) ?? {};
    expect(Object.keys(result).length).toBeLessThanOrEqual(8);
    expect(result.long).toBeUndefined();
  });
});

describe('analytics tracker', () => {
  const send = vi.fn<(body: string, onHide: boolean) => Promise<void>>();

  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue(undefined);
    resetTracker();
    configureTracker({ send, batchSize: 3 });
  });

  afterEach(() => resetTracker());

  it('ignores unknown event names at runtime', () => {
    track('free form text' as never);
    expect(getQueuedEvents()).toHaveLength(0);
  });

  it('batches events and sends when the batch size is reached', async () => {
    track('hero_cta_clicked');
    track('video_started');
    expect(send).not.toHaveBeenCalled();
    track('benchmark_viewed');
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(send.mock.calls[0][0]) as { sessionId: string; events: unknown[] };
    expect(payload.events).toHaveLength(3);
    expect(payload.sessionId).toMatch(/^[a-z0-9-]{8,64}$/i);
    expect(getQueuedEvents()).toHaveLength(0);
  });

  it('flush sends pending events once and reuses the session id', async () => {
    track('receipt_opened', { expanded: true });
    await flush();
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    track('mandate_explored');
    await flush();
    const first = JSON.parse(send.mock.calls[0][0]) as { sessionId: string; events: Array<{ event: string; metadata?: unknown }> };
    const second = JSON.parse(send.mock.calls[1][0]) as { sessionId: string };
    expect(first.events[0]).toMatchObject({ event: 'receipt_opened', metadata: { expanded: true } });
    expect(first.sessionId).toBe(second.sessionId);
  });

  it('never throws when the transport fails', async () => {
    send.mockRejectedValue(new Error('offline'));
    track('hero_cta_clicked');
    await expect(flush()).resolves.toBeUndefined();
  });
});
