/** Drives one stream-json Claude session through the `<cto_decide>` protocol.
 *
 *  The turn protocol, verified against the real CLI:
 *
 *   1. The goal goes in as the first stream-json user message.
 *   2. A turn that ends with frames is answered: the gateway judges them and
 *      the answer goes back in as the next user message. The model continues
 *      in the same process and the same session.
 *   3. A turn that ends without a frame is the last one: stdin is closed, the
 *      CLI exits, and the Job completes.
 *
 *  Two facts about multi-turn sessions that the rest of the runtime does not
 *  know, and must not have to learn, are absorbed here:
 *
 *   - Every turn emits its own `result`. Only the last one is the answer, so
 *     the earlier ones are re-typed `session.turn_result`. Otherwise the
 *     decision turn's text would be published as the node's answer.
 *   - Each `result.usage` covers only its own turn, while `total_cost_usd` is a
 *     running total (Claude Code docs, streaming input mode). The final
 *     `result` is rewritten to carry summed usage and turns, and keeps the last
 *     cost. Every downstream reader of "the last result" then gets the whole
 *     session, counted once.
 *
 *  Transport-agnostic: `send`/`end` are a Kubernetes attach in production and
 *  a function call in tests. */
import type { StructuredEvent } from '../adapters/adapter.js';
import { extractFrames } from './model-protocol.js';
import type { GatewayReply, ModelGateway } from './model-gateway.js';

export interface SessionTransport {
  send(line: string): void;
  end(): void;
}

export interface SessionControllerOptions {
  gateway: ModelGateway;
  transport: SessionTransport;
  /** Decision round trips allowed before the session is closed at the next
   *  turn boundary whatever the model asks. Each round trip is a model turn
   *  somebody pays for, so this cap exists apart from the decision budget. */
  maxDecisionTurns: number;
  /** A compact, provider-free note for the transcript, and the full reply for
   *  receipts. */
  onDecision?: (reply: GatewayReply, turn: number) => void;
}

export interface SessionSummary {
  decisionTurns: number;
  /** Frames the model emitted that were never answered: not at the end of a
   *  turn, past the round-trip cap, or arriving after the session had ended. */
  unanswered: number;
  ended: boolean;
}

export function userMessage(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}

type Usage = Record<string, number>;
const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;

export interface SessionController {
  start(goal: string): void;
  /** Rewrites one event (scrubs frames, re-types turn results). Synchronous so
   *  the caller's event order is untouched; answering runs in the background
   *  and is awaited through `settled`. */
  process(event: StructuredEvent): StructuredEvent;
  settled(): Promise<void>;
  /** Closes stdin now: the runtime finishes its current turn and exits.
   *  Idempotent. Anything asked after this is recorded as unanswered. */
  closeInput(): void;
  /** Called once the runtime has finished. Returns a synthetic final `result`
   *  when the session died between turns, so its spend is not lost. */
  finish(): { summary: SessionSummary; synthetic?: StructuredEvent };
}

export function createSessionController(options: SessionControllerOptions): SessionController {
  let pending: string[] = [];
  let decisionTurns = 0;
  let unanswered = 0;
  let ended = false;
  let finalSeen = false;
  let lastCost: number | undefined;
  const usage: Usage = Object.fromEntries(USAGE_KEYS.map((k) => [k, 0]));
  let turns = 0;
  let work: Promise<void> = Promise.resolve();

  const end = () => {
    if (ended) return;
    ended = true;
    options.transport.end();
  };

  const absorbUsage = (payload: Record<string, unknown>) => {
    const u = (payload.usage ?? {}) as Record<string, unknown>;
    for (const k of USAGE_KEYS) usage[k] += typeof u[k] === 'number' ? (u[k] as number) : 0;
    turns += typeof payload.num_turns === 'number' ? payload.num_turns : 0;
    if (typeof payload.total_cost_usd === 'number') lastCost = payload.total_cost_usd;
  };

  const scrubText = (text: string): { text: string; bodies: string[] } => {
    const { visible, bodies } = extractFrames(text);
    return { text: visible, bodies };
  };

  return {
    start(goal) {
      options.transport.send(userMessage(goal));
    },

    process(event) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;

      if (event.type === 'assistant') {
        const message = (payload.message ?? {}) as { content?: unknown };
        if (!Array.isArray(message.content)) return event;
        // Anything the model says after a frame means the frame did not end
        // its turn, so it is not a request.
        if (pending.length > 0) { unanswered += pending.length; pending = []; }
        let found: string[] = [];
        const content = message.content.flatMap((block: { type?: string; text?: unknown }) => {
          if (block?.type !== 'text' || typeof block.text !== 'string') {
            if (found.length > 0) { unanswered += found.length; found = []; }
            return [block];
          }
          const { text, bodies } = scrubText(block.text);
          if (found.length > 0) { unanswered += found.length; found = []; }
          found = bodies;
          return text.trim() ? [{ ...block, text }] : [];
        });
        pending = found;
        if (found.length === 0 && content.length === message.content.length) return event;
        return { ...event, payload: { ...payload, message: { ...message, content } } };
      }

      if (event.type !== 'result') return event;
      absorbUsage(payload);
      const text = typeof payload.result === 'string' ? extractFrames(payload.result).visible : payload.result;

      if (ended) {
        // The runtime is already closing. Anything it asks now cannot be
        // answered.
        unanswered += pending.length;
        pending = [];
      }

      if (pending.length > 0 && decisionTurns < options.maxDecisionTurns) {
        const bodies = pending;
        pending = [];
        const turn = ++decisionTurns;
        work = work.then(async () => {
          let reply: GatewayReply;
          try {
            reply = await options.gateway.handle(bodies);
          } catch {
            reply = { records: [], message: '<cto_decision>\nunavailable: decide with your own judgment\n</cto_decision>\nContinue the task.' };
          }
          options.onDecision?.(reply, turn);
          if (!ended) options.transport.send(userMessage(reply.message));
        });
        return { type: 'session.turn_result', payload: { ...payload, result: text } };
      }

      unanswered += pending.length;
      pending = [];
      finalSeen = true;
      end();
      return {
        type: 'result',
        payload: {
          ...payload,
          result: text,
          usage: { ...(payload.usage as object | undefined ?? {}), ...usage },
          num_turns: turns,
          ...(lastCost === undefined ? {} : { total_cost_usd: lastCost }),
        },
      };
    },

    settled: () => work,
    closeInput: end,

    finish() {
      unanswered += pending.length;
      pending = [];
      end();
      const summary = { decisionTurns, unanswered, ended };
      if (finalSeen || decisionTurns === 0) return { summary };
      return {
        summary,
        synthetic: {
          type: 'result',
          payload: {
            type: 'result', subtype: 'error_during_execution', is_error: true,
            result: 'the session ended before its final turn',
            usage: { ...usage }, num_turns: turns,
            ...(lastCost === undefined ? {} : { total_cost_usd: lastCost }),
          },
        },
      };
    },
  };
}
