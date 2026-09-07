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

export interface RuntimeAdapter {
  name: string;
  /** `grant` is optional so a caller that has no contract in hand (a plan or
   *  synthesis pass on the parent's own authority) still builds a command. When
   *  it is supplied the adapter must express it in the runtime's own permission
   *  flags, so a forbidden call is refused before it happens rather than
   *  reported after. */
  buildCommand(goal: string, grant?: ToolGrant): string[];
  /** Wraps one raw output line as a StructuredEvent, or null if it is not a
   *  recognizable event (blank, malformed JSON, or missing a `type` field). */
  parseLine(line: string): StructuredEvent | null;
  parseEventStream(stream: NodeJS.ReadableStream): Promise<StructuredEvent[]>;
}
