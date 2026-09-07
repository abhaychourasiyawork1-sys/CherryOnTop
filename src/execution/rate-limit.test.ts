import { describe, it, expect } from 'vitest';
import { rateLimitFromEvents, describeRateLimit } from './rate-limit.js';

const rejected = (over: Record<string, unknown> = {}) => ({
  type: 'rate_limit_event',
  payload: { rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1788697200, ...over } },
});

const NOW = new Date(1788697200_000 - 45 * 60_000); // 45 minutes before reset

describe('rateLimitFromEvents', () => {
  it('finds a refused request and the window that ran out', () => {
    expect(rateLimitFromEvents([rejected()])).toEqual({ window: 'five_hour', resetsAtSeconds: 1788697200 });
  });

  it('ignores the informational events that report a window merely filling up', () => {
    // Every run emits these; treating one as a failure would fail every run.
    expect(rateLimitFromEvents([{ type: 'rate_limit_event', payload: { rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } } }]))
      .toBeNull();
  });

  it('returns nothing for a run that was never rate limited', () => {
    expect(rateLimitFromEvents([{ type: 'result', payload: { is_error: false } }])).toBeNull();
    expect(rateLimitFromEvents([])).toBeNull();
  });

  it('survives a malformed event rather than throwing mid-failure', () => {
    expect(rateLimitFromEvents([{ type: 'rate_limit_event', payload: null }])).toBeNull();
    expect(rateLimitFromEvents([rejected({ resetsAt: 'soon' })])).toEqual({ window: 'five_hour', resetsAtSeconds: undefined });
  });
});

describe('describeRateLimit', () => {
  it('says what ran out, when it returns, and what to do', () => {
    const message = describeRateLimit(rateLimitFromEvents([rejected()])!, NOW);
    expect(message).toContain('five-hour usage limit is used up');
    expect(message).toContain('45 minutes');
    expect(message).toContain('ANTHROPIC_API_KEY');
  });

  it('formats a long wait in hours', () => {
    const early = new Date(1788697200_000 - 130 * 60_000);
    expect(describeRateLimit({ window: 'five_hour', resetsAtSeconds: 1788697200 }, early)).toContain('2h 10m');
  });

  it('still explains itself when no reset time was given', () => {
    const message = describeRateLimit({ window: 'seven_day' }, NOW);
    expect(message).toContain('seven-day');
    expect(message).not.toContain('resets at');
  });
});
