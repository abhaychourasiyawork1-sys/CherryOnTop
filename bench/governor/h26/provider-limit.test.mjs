// Provider-limit invalidation: every known refusal signature, and ordinary
// agent failures that must NOT be mistaken for one. Payloads are the real
// shapes from the 2026-10-02 validation runs.
import { describe, expect, it } from 'vitest';
import { providerLimit } from './provider-limit.mjs';

const rle = (status, extra = {}) => ({ type: 'exec.rate_limit_event', payload: { type: 'rate_limit_event', rate_limit_info: { status, rateLimitType: 'five_hour', resetsAt: 1790956800, ...extra } } });

describe('provider limits are detected', () => {
  it('a rejected rate_limit_event (exec or plan)', () => {
    expect(providerLimit([rle('rejected', { overageStatus: 'rejected' })])).toEqual({ reason: 'rate_limit_event:rejected:five_hour', eventType: 'exec.rate_limit_event' });
    expect(providerLimit([{ ...rle('rejected'), type: 'plan.rate_limit_event' }]).reason).toBe('rate_limit_event:rejected:five_hour');
  });
  it('the runtime\'s usage-limit message on the step outcome', () => {
    expect(providerLimit([{ type: 'step.outcome', payload: { succeeded: false, message: 'Your Claude five-hour usage limit is used up, so the request was refused. It resets at 09:30 pm, in about 3h 8m.' } }]).reason).toBe('usage_limit_message');
  });
  it('the market refusing harnesses as harness_rate_limited', () => {
    expect(providerLimit([{ type: 'step.outcome', payload: { succeeded: false, message: 'No execution candidate is feasible — exec:claude-code:haiku:low: unavailable:harness_rate_limited, insufficient_budget, quality_floor.' } }]).reason).toBe('harness_rate_limited');
    expect(providerLimit([{ type: 'market.decision', payload: { reasonCodes: ['rejected:exec:claude-code:haiku:high:unavailable:harness_rate_limited'] } }]).reason).toBe('harness_rate_limited');
  });
  it('an unrecovered API rate-limit or overload error as the final result', () => {
    expect(providerLimit([{ type: 'exec.result', payload: { type: 'result', is_error: true, result: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}' } }]).reason).toBe('api_error:rate_limit_error');
    expect(providerLimit([{ type: 'exec.result', payload: { type: 'result', is_error: true, result: 'API Error: 529 overloaded_error' } }]).reason).toBe('api_error:overloaded_error');
  });
});

describe('ordinary failures are not provider limits', () => {
  it('informational rate-limit events', () => {
    expect(providerLimit([rle('allowed'), rle('allowed_warning', { utilization: 0.97, surpassedThreshold: 0.9 })])).toBeNull();
  });
  it('running out of turns, failed validation, a budget refusal, a crashed agent', () => {
    expect(providerLimit([
      { type: 'exec.result', payload: { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 61 } },
      { type: 'step.outcome', payload: { succeeded: false, message: 'error_max_turns' } },
      { type: 'validation.result', payload: { passed: false, level: 'V2' } },
      { type: 'step.outcome', payload: { succeeded: false, message: 'No execution candidate is feasible — exec:codex:haiku:default: unavailable:harness_cannot_serve_model, insufficient_budget, quality_floor.' } },
      { type: 'step.outcome', payload: { succeeded: false, message: 'Job failed: exit code 1' } },
    ])).toBeNull();
  });
  it('an API error the CLI recovered from (not the final result)', () => {
    expect(providerLimit([{ type: 'exec.system', payload: { subtype: 'api_retry', error: 'overloaded_error' } }])).toBeNull();
  });
  it('the agent reading code or logs that mention these strings', () => {
    expect(providerLimit([
      { type: 'exec.user', payload: { message: { content: [{ type: 'tool_result', content: 'if status == "harness_rate_limited": raise; # usage limit is used up' }] } } },
      { type: 'exec.assistant', payload: { message: { content: [{ type: 'text', text: 'grep found rate_limit_error and usage limit is used up' }] } } },
    ])).toBeNull();
  });
});
