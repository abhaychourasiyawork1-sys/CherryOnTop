import { z } from 'zod';

export const StructuredEventSchema = z.object({
  type: z.string(),
  payload: z.unknown(),
});
export type StructuredEvent = z.infer<typeof StructuredEventSchema>;

/** What a node is permitted to reach for, in the shape an adapter needs to tell
 *  its runtime. `allowedTools: null` means unrestricted — see enforce-tools.ts
 *  for why an empty grant is the sentinel for "no restriction". */
export interface ToolGrant {
  allowedTools: string[] | null;
  readOnly: boolean;
}

/** Optional per-dispatch controls. All absent = today's behaviour exactly. */
export interface BuildCommandOptions {
  /** Passed verbatim to the runtime's model flag. A short alias ("haiku",
   *  "sonnet") or a full pinned id both work. */
  model?: string;
  /** Hard cap on agent turns for this dispatch. */
  maxTurns?: number;
  /** Appended to the runtime's built-in system prompt (Task 12). */
  systemPrompt?: string;
}

export interface RuntimeAdapter {
  name: string;
  /** `grant` is optional so a caller that has no contract in hand (a plan or
   *  synthesis pass on the parent's own authority) still builds a command. When
   *  it is supplied the adapter must express it in the runtime's own permission
   *  flags, so a forbidden call is refused before it happens rather than
   *  reported after. */
  buildCommand(goal: string, grant?: ToolGrant, opts?: BuildCommandOptions): string[];
  /** Whether this runtime can actually serve a model *name*. Optional: absent
   *  means "any name the caller passes". It exists because the flag surviving
   *  into argv is not the same question as the runtime accepting the value —
   *  see codex.ts, which takes `--model` and then rejects a Claude alias. */
  servesModel?(model: string): boolean;
  /** Wraps one raw output line as a StructuredEvent, or null if it is not a
   *  recognizable event (blank, malformed JSON, or missing a `type` field). */
  parseLine(line: string): StructuredEvent | null;
  parseEventStream(stream: NodeJS.ReadableStream): Promise<StructuredEvent[]>;
}
