/** What a *successful* dispatch's event stream actually looks like.
 *
 *  Validation is the only door into COMPLETE, so a test fixture standing in for
 *  a successful run has to carry the evidence a successful run produces: an
 *  edit that happened, a verifying command that went green, and the tool
 *  results that say both worked. A stream with a bare `result` event describes
 *  a run that reported success and produced nothing — which is a real and
 *  important case, and `reportedSuccessWithNoEvidence` below is it, kept
 *  separate rather than used by accident.
 *
 *  Lives beside the lifecycle rather than in one test file because four of them
 *  need the same shape, and four hand-rolled approximations of a runtime
 *  envelope drift apart. */
import type { StructuredEvent } from '../adapters/adapter.js';

interface SuccessfulRunInput {
  /** The file the run changed. */
  editedPath: string;
  /** The verifying command it ran, if any. Omit for a run that changed
   *  something and checked nothing. */
  verifyCommand?: string;
  /** What the run said when it finished. */
  result?: string;
  costUsd?: number;
}

/** An assistant turn plus the tool results that say how it went.
 *
 *  Both halves matter: `observationsFromEvents` pairs a `tool_use` with its
 *  `tool_result` by id, and a call with no result is recorded as having
 *  *failed* — so a fixture that omits them describes a run whose every action
 *  went wrong. */
export function successfulRunEvents(input: SuccessfulRunInput): StructuredEvent[] {
  const calls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [
    { id: 'call-edit', name: 'Edit', input: { file_path: input.editedPath } },
  ];
  if (input.verifyCommand) {
    calls.push({ id: 'call-verify', name: 'Bash', input: { command: input.verifyCommand } });
  }

  return [
    {
      type: 'assistant',
      payload: { message: { content: calls.map((call) => ({ type: 'tool_use', ...call })) } },
    },
    {
      type: 'user',
      payload: {
        message: {
          content: calls.map((call) => ({
            type: 'tool_result', tool_use_id: call.id, is_error: false, content: 'ok',
          })),
        },
      },
    },
    {
      type: 'result',
      payload: {
        is_error: false,
        result: input.result ?? 'done',
        total_cost_usd: input.costUsd ?? 0,
      },
    },
  ] as StructuredEvent[];
}

/** Reported success, produced nothing. The claim with nothing behind it, and
 *  the case the validation ladder exists to refuse. */
export function reportedSuccessWithNoEvidence(result = 'done'): StructuredEvent[] {
  return [{ type: 'result', payload: { is_error: false, result } }] as StructuredEvent[];
}

/** Replays a fixture's events through the dispatch's own event callback.
 *
 *  `executeStep` streams events as they arrive and the manager derives
 *  artifacts, tool observations and cost from that stream — so a stub that only
 *  *returns* events describes a run the runtime never saw do anything. Which
 *  used not to matter, because nothing downstream read the stream to decide
 *  whether the task succeeded, and now does. */
export function replayInto<T extends { events: StructuredEvent[] }>(
  input: { onEvent?: (event: StructuredEvent) => void },
  result: T,
): T {
  for (const event of result.events) input.onEvent?.(event);
  return result;
}
