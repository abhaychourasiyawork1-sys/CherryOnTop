/** The one seam between CherryOnTop's agent loop and a model provider.
 *
 *  Messages, tools and responses use the Messages API shapes (the SDK's own
 *  types): Claude Code's stream already speaks them, so every reader of a
 *  dispatch's events reads an owned run unchanged, and a second provider would
 *  translate at its own client rather than at every reader. The loop never
 *  imports a provider SDK; it holds a `ModelClient`.
 *
 *  A turn returns the finished message. Deltas are not surfaced: nothing in
 *  the runtime renders partial tokens (the TUI renders whole events), and a
 *  client may still stream underneath to keep long turns off HTTP timeouts. */
import type Anthropic from '@anthropic-ai/sdk';

export type Message = Anthropic.Message;
export type MessageParam = Anthropic.MessageParam;
export type Tool = Anthropic.ToolUnion;
export type ContentBlock = Anthropic.ContentBlock;

export interface ModelTurnInput {
  model: string;
  maxTokens: number;
  /** Frozen for a session: any byte change here invalidates the prompt cache
   *  and, on models with preserved thinking, every earlier thinking block. */
  system: string;
  tools: Tool[];
  messages: MessageParam[];
  /** Reasoning effort, sent only to a model that accepts it. */
  effort?: string;
  /** Thinking tokens per turn on a model that takes a budget (Haiku 4.5).
   *  Adaptive models decide for themselves. 0 turns thinking off where allowed. */
  thinkingBudget?: number;
}

/** Why a turn could not be had, in the terms the loop recovers by. */
export type ModelFailureKind = 'rate_limit' | 'overloaded' | 'auth' | 'bad_request' | 'network' | 'other';

export class ModelError extends Error {
  constructor(readonly kind: ModelFailureKind, message: string, readonly status?: number) {
    super(message);
    this.name = 'ModelError';
  }
}

export interface ModelClient {
  createTurn(input: ModelTurnInput, signal?: AbortSignal): Promise<Message>;
}

/** CLI aliases (what the Action Market proposes for a Claude harness) to the
 *  API ids they name today. A full id passes through unchanged. */
const ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
};

/** What a model can do that the request has to say differently per model.
 *  Facts from the API's own model table, not tuning: Haiku 4.5 thinks only with
 *  an explicit token budget (and needs the interleaved-thinking beta to think
 *  between tool calls, as Claude Code runs it); every newer model thinks
 *  adaptively, interleaved by default. The dynamic-filtering web search exists
 *  only on the newer models. */
export interface ModelProfile {
  thinking: 'budget' | 'adaptive';
  webSearchType: 'web_search_20250305' | 'web_search_20260209';
}

export function modelProfile(modelId: string): ModelProfile {
  const legacy = /haiku|-4-5\b|sonnet-4-5|opus-4-5|opus-4-1/.test(modelId);
  return legacy
    ? { thinking: 'budget', webSearchType: 'web_search_20250305' }
    : { thinking: 'adaptive', webSearchType: 'web_search_20260209' };
}

export function resolveModelId(model: string | undefined): string {
  const name = (model ?? '').trim().toLowerCase();
  return ALIASES[name] ?? (name || ALIASES.sonnet);
}

/** A client that answers from a script, for tests and offline replay. Each
 *  entry is the next turn's message, or a function of the request (so a test
 *  can assert on what the loop sent), or an error to throw. */
export type ScriptedTurn = Message | Error | ((input: ModelTurnInput) => Message | Error);

export function scriptedModelClient(turns: ScriptedTurn[]): ModelClient & { requests: ModelTurnInput[] } {
  const requests: ModelTurnInput[] = [];
  return {
    requests,
    async createTurn(input) {
      requests.push(structuredClone(input));
      const next = turns.shift();
      if (next === undefined) throw new ModelError('other', 'scripted client ran out of turns');
      const turn = typeof next === 'function' ? next(input) : next;
      if (turn instanceof Error) throw turn;
      return turn;
    },
  };
}

let fakeId = 0;

/** A finished assistant message, for scripts. */
export function fakeMessage(
  content: ContentBlock[] | string,
  opts: { stopReason?: Message['stop_reason']; usage?: Partial<Message['usage']>; model?: string } = {},
): Message {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content, citations: null } as ContentBlock] : content;
  return {
    id: `msg_fake_${++fakeId}`,
    type: 'message',
    role: 'assistant',
    model: opts.model ?? 'claude-haiku-4-5',
    content: blocks,
    stop_reason: opts.stopReason ?? (blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...opts.usage } as Message['usage'],
  } as Message;
}

export function toolUse(id: string, name: string, input: Record<string, unknown>): ContentBlock {
  return { type: 'tool_use', id, name, input } as ContentBlock;
}
