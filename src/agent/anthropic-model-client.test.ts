import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicModelClient, buildRequest, classifyError, acceptsEffort, type AnthropicClientLike } from './anthropic-model-client.js';
import { fakeMessage, resolveModelId, scriptedModelClient, ModelError, type ModelTurnInput } from './model-client.js';

const turn: ModelTurnInput = { model: 'haiku', maxTokens: 1000, system: 'sys', tools: [], messages: [{ role: 'user', content: 'hi' }] };

describe('model ids', () => {
  it('maps CLI aliases to API ids and passes full ids through', () => {
    expect(resolveModelId('haiku')).toBe('claude-haiku-4-5');
    expect(resolveModelId('Sonnet')).toBe('claude-sonnet-5-5');
    expect(resolveModelId('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(resolveModelId(undefined)).toBe('claude-sonnet-5-5');
  });
});

describe('buildRequest', () => {
  it('caches the frozen system prompt and rides a breakpoint on the history', () => {
    const body = buildRequest(turn);
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('sends effort only to models that accept it, and never a thinking config', () => {
    expect(buildRequest({ ...turn, effort: 'high' }).output_config).toBeUndefined();
    expect(buildRequest({ ...turn, model: 'sonnet', effort: 'high' }).output_config).toEqual({ effort: 'high' });
    expect(buildRequest({ ...turn, model: 'sonnet', effort: 'bogus' }).output_config).toBeUndefined();
    expect(buildRequest({ ...turn, model: 'opus', effort: 'low' })).not.toHaveProperty('thinking');
    expect(acceptsEffort('claude-haiku-4-5')).toBe(false);
  });

  it('is byte-identical for identical input (cache prefix stability)', () => {
    expect(JSON.stringify(buildRequest(turn))).toBe(JSON.stringify(buildRequest(structuredClone(turn))));
  });
});

describe('AnthropicModelClient', () => {
  it('returns the streamed final message', async () => {
    const message = fakeMessage('done');
    let sent: unknown;
    const fake: AnthropicClientLike = { messages: { stream: (body) => { sent = body; return { finalMessage: async () => message }; } } };
    expect(await new AnthropicModelClient(fake).createTurn(turn)).toBe(message);
    expect((sent as { model: string }).model).toBe('claude-haiku-4-5');
  });

  it('maps SDK errors to failure kinds by type, not by message text', async () => {
    const headers = new Headers();
    const cases: Array<[unknown, string]> = [
      [new Anthropic.RateLimitError(429, {}, 'slow down', headers), 'rate_limit'],
      [new Anthropic.AuthenticationError(401, {}, 'bad key', headers), 'auth'],
      [new Anthropic.BadRequestError(400, {}, 'prompt is too long', headers), 'bad_request'],
      [new Anthropic.InternalServerError(529, {}, 'overloaded', headers), 'overloaded'],
      [new Anthropic.APIConnectionError({ message: 'reset' }), 'network'],
      [new Error('boom'), 'other'],
    ];
    for (const [err, kind] of cases) expect(classifyError(err).kind).toBe(kind);
    const failing: AnthropicClientLike = { messages: { stream: () => ({ finalMessage: async () => { throw new Anthropic.RateLimitError(429, {}, 'x', headers); } }) } };
    await expect(new AnthropicModelClient(failing).createTurn(turn)).rejects.toMatchObject({ kind: 'rate_limit' });
  });
});

describe('scriptedModelClient', () => {
  it('records requests and replays turns, errors included', async () => {
    const client = scriptedModelClient([fakeMessage('a'), new ModelError('overloaded', 'busy')]);
    expect((await client.createTurn(turn)).content[0]).toMatchObject({ text: 'a' });
    await expect(client.createTurn(turn)).rejects.toMatchObject({ kind: 'overloaded' });
    await expect(client.createTurn(turn)).rejects.toBeInstanceOf(ModelError);
    expect(client.requests).toHaveLength(3);
  });
});
