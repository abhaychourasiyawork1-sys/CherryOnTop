import { z } from 'zod';

export const StructuredEventSchema = z.object({
  type: z.string(),
  payload: z.unknown(),
});
export type StructuredEvent = z.infer<typeof StructuredEventSchema>;

export interface RuntimeAdapter {
  name: string;
  buildCommand(goal: string): string[];
  /** Wraps one raw output line as a StructuredEvent, or null if it is not a
   *  recognizable event (blank, malformed JSON, or missing a `type` field). */
  parseLine(line: string): StructuredEvent | null;
  parseEventStream(stream: NodeJS.ReadableStream): Promise<StructuredEvent[]>;
}
