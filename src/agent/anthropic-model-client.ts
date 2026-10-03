/** `ModelClient` over the Anthropic Messages API.
 *
 *  The key is read by the SDK from the daemon's own `ANTHROPIC_API_KEY`. It is
 *  never put in a request the sandbox can see: the loop runs here, and only
 *  tool commands cross into the sandbox.
 *
 *  Cache layout: tools, then the frozen system prompt (breakpoint), then the
 *  append-only history with the request-level breakpoint that rides its last
 *  block. Each turn therefore re-reads everything before it from cache and
 *  writes only what it added.
 *
 *  Streamed underneath (a long turn would otherwise risk the HTTP timeout) and
 *  read back whole with `finalMessage()`. The SDK retries 408/409/429/5xx and
 *  connection errors itself; what still fails is mapped onto `ModelFailureKind`
 *  by the SDK's typed errors, never by message text. */
import Anthropic from '@anthropic-ai/sdk';
import { ModelError, resolveModelId, type Message, type ModelClient, type ModelTurnInput } from './model-client.js';

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Haiku 4.5 rejects `output_config.effort`; every newer model takes it. */
export function acceptsEffort(modelId: string): boolean {
  return !modelId.includes('haiku');
}

/** The request body for one turn, exactly as sent. Exported so the wiring can
 *  be checked (and token-counted for free) without making a paid call. */
export function buildRequest(input: ModelTurnInput): Anthropic.MessageCreateParamsNonStreaming {
  const model = resolveModelId(input.model);
  const effort = input.effort && EFFORTS.has(input.effort) && acceptsEffort(model)
    ? { output_config: { effort: input.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } }
    : {};
  return {
    model,
    max_tokens: input.maxTokens,
    // The stable prefix (tools + system) is identical across every dispatch of
    // a harness version: held for an hour so later sessions read it from cache
    // too (both ToFu and the Harness Effect pin it). The growing history rides
    // the request-level 5-minute breakpoint. Longer TTLs must come first.
    system: [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    tools: input.tools,
    messages: input.messages,
    cache_control: { type: 'ephemeral' },
    ...effort,
  };
}

export function classifyError(err: unknown): ModelError {
  if (err instanceof ModelError) return err;
  if (err instanceof Anthropic.RateLimitError) return new ModelError('rate_limit', err.message, 429);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return new ModelError('auth', err.message, err.status);
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError || err instanceof Anthropic.UnprocessableEntityError) {
    return new ModelError('bad_request', err.message, err.status);
  }
  if (err instanceof Anthropic.InternalServerError) return new ModelError('overloaded', err.message, err.status);
  if (err instanceof Anthropic.APIConnectionError) return new ModelError('network', err.message);
  if (err instanceof Anthropic.APIError) return new ModelError('other', err.message, err.status);
  return new ModelError('other', err instanceof Error ? err.message : String(err));
}

export interface AnthropicClientLike {
  messages: { stream(body: Anthropic.MessageStreamParams, options?: { signal?: AbortSignal }): { finalMessage(): Promise<Message> } };
}

export class AnthropicModelClient implements ModelClient {
  private readonly client: AnthropicClientLike;

  /** `client` is for tests; production builds one from the environment. */
  constructor(client?: AnthropicClientLike) {
    this.client = client ?? new Anthropic();
  }

  async createTurn(input: ModelTurnInput, signal?: AbortSignal): Promise<Message> {
    try {
      return await this.client.messages.stream(buildRequest(input), signal ? { signal } : undefined).finalMessage();
    } catch (err) {
      throw classifyError(err);
    }
  }
}

/** Whether the owned runtime can reach a model at all from this process. */
export function anthropicConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim());
}
