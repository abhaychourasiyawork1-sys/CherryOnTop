import { z } from 'zod';

export const StructuredEventSchema = z.object({
  type: z.string(),
  payload: z.unknown(),
});
export type StructuredEvent = z.infer<typeof StructuredEventSchema>;

export interface RuntimeAdapter {
  name: string;
  buildCommand(goal: string): string[];
  parseEventStream(stream: NodeJS.ReadableStream): Promise<StructuredEvent[]>;
}
