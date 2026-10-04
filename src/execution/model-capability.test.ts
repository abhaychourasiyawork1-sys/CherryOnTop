import { describe, it, expect } from 'vitest';
import {
  createCapabilityRegistry, classifyRuntimeFailure, accountKeyFor, COOLDOWN_MS, ALL_MODELS, type CapabilityKey,
} from './model-capability.js';
import type { StructuredEvent } from '../adapters/adapter.js';

const key = (over: Partial<CapabilityKey> = {}): CapabilityKey => ({ provider: 'claude-code', model: 'opus', account: 'subscription', ...over });

function registry() {
  let now = 1_000_000;
  const r = createCapabilityRegistry(() => now);
  return { r, advance: (ms: number) => { now += ms; }, at: () => now };
}

const failure = (text: string): StructuredEvent[] => [
  { type: 'result', payload: { type: 'result', is_error: true, result: text } },
];

describe('what is known about a model on an account', () => {
  it('knows nothing until something is observed, and unknown means available', () => {
    const { r } = registry();
    expect(r.state(key())).toBeUndefined();
    expect(r.isAvailable(key())).toBe(true);
  });

  it('blocks a model the plan does not include, for a cooldown rather than for ever', () => {
    const { r, advance } = registry();
    const state = r.observeFailure(key(), 'model_unavailable');
    expect(state.available).toBe(false);
    expect(state.failureClass).toBe('model_unavailable');
    expect(r.isAvailable(key())).toBe(false);
    advance(COOLDOWN_MS.model_unavailable - 1);
    expect(r.isAvailable(key())).toBe(false);
    advance(2);
    expect(r.isAvailable(key())).toBe(true);
  });

  it('lets the cooldown expire out of the registry, so an old failure leaves no trace', () => {
    const { r, advance } = registry();
    r.observeFailure(key(), 'transient');
    advance(COOLDOWN_MS.transient + 1);
    expect(r.state(key())).toBeUndefined();
  });

  it('clears a block the moment the model works', () => {
    const { r } = registry();
    r.observeFailure(key(), 'model_unavailable');
    r.observeSuccess(key());
    expect(r.isAvailable(key())).toBe(true);
    expect(r.state(key())).toBeUndefined();
  });

  it('backs off a repeatedly failing transient error, up to a ceiling', () => {
    const { r, advance } = registry();
    const first = r.observeFailure(key(), 'transient');
    advance(COOLDOWN_MS.transient + 1);
    const second = r.observeFailure(key(), 'transient');
    const span = (s: typeof first) => Date.parse(s.cooldownUntil!) - Date.parse(s.checkedAt);
    expect(span(second)).toBeGreaterThan(span(first));
    for (let i = 0; i < 12; i++) { advance(COOLDOWN_MS.transientMax + 1); r.observeFailure(key(), 'transient'); }
    const last = r.state(key())!;
    expect(span(last)).toBeLessThanOrEqual(COOLDOWN_MS.transientMax);
  });

  it('keeps accounts, providers and models apart', () => {
    const { r } = registry();
    r.observeFailure(key(), 'model_unavailable');
    expect(r.isAvailable(key({ model: 'sonnet' }))).toBe(true);
    expect(r.isAvailable(key({ account: 'api-key' }))).toBe(true);
    expect(r.isAvailable(key({ provider: 'codex' }))).toBe(true);
  });

  it('applies an authentication failure to every model on that provider and account', () => {
    const { r } = registry();
    r.observeFailure(key({ model: ALL_MODELS }), 'auth');
    expect(r.isAvailable(key({ model: 'opus' }))).toBe(false);
    expect(r.isAvailable(key({ model: 'haiku' }))).toBe(false);
    expect(r.isAvailable(key({ provider: 'codex', model: 'gpt' }))).toBe(true);
  });

  it('honours the time a rate limit says it lifts, when it says one', () => {
    const { r, at } = registry();
    r.observeFailure(key(), 'rate_limited', at() + 90 * 60_000);
    expect(Date.parse(r.state(key())!.cooldownUntil!)).toBe(at() + 90 * 60_000);
  });
});

describe('reading the runtime’s own account of a failure', () => {
  it.each([
    ['model "x" is not available on your plan', 'model_unavailable'],
    ['You do not have access to this model', 'model_unavailable'],
    ['Invalid API key · Please run /login', 'auth'],
    ['authentication_error: OAuth token has expired', 'auth'],
    ['Request timed out', null],
    ['max turns exceeded', null],
  ])('%s → %s', (text, expected) => {
    expect(classifyRuntimeFailure(failure(text))).toBe(expected);
  });

  it('says nothing about a failure that happened after the agent had started working', () => {
    // A task about a missing model or a 401 will say so in its own error text.
    const afterWork: StructuredEvent[] = [
      { type: 'assistant', payload: { message: { id: 'm1', usage: {} } } },
      ...failure('model "orders" is not found — the migration is wrong (HTTP 401 from the fixture)'),
    ];
    expect(classifyRuntimeFailure(afterWork)).toBeNull();
  });

  it('says nothing about a run that did not fail', () => {
    expect(classifyRuntimeFailure([{ type: 'result', payload: { is_error: false, result: 'done' } }])).toBeNull();
    expect(classifyRuntimeFailure([])).toBeNull();
  });
});

describe('the account a run is billed to', () => {
  it('names the kind of credential, never the credential', () => {
    expect(accountKeyFor({ CLAUDE_CREDENTIALS_JSON: '{"secret":1}' })).toBe('subscription');
    expect(accountKeyFor({ ANTHROPIC_API_KEY: 'sk-ant-secret' })).toBe('api-key');
    expect(accountKeyFor({})).toBe('none');
    expect(accountKeyFor({ CLAUDE_CREDENTIALS_JSON: 'x' })).not.toContain('secret');
  });
});
