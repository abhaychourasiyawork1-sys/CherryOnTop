import { z } from 'zod';

export const DecisionOutcomeSchema = z.enum(['SELF_EXECUTE', 'DELEGATE', 'ESCALATE']);
export const DecisionTypeSchema = z.enum(['execution_decision', 'runtime_selection']);

const BASE = {
  id: z.string(),
  nodeId: z.string(),
  breakdown: z.record(z.string(), z.number()),
  createdAt: z.string().datetime(),
};

// Runtime choice is a scored decision with a numeric breakdown, exactly like
// delegation — so it is recorded the same way, and the same "why" view explains
// both rather than a parallel record growing for the same idea. A union rather
// than a widened `outcome`: the two kinds have genuinely different outcomes, and
// collapsing them to `string` would stop 'MAYBE' being rejected.
export const DecisionSchema = z.discriminatedUnion('type', [
  z.object({
    ...BASE,
    type: z.literal('execution_decision'),
    outcome: DecisionOutcomeSchema,
  }),
  z.object({
    ...BASE,
    type: z.literal('runtime_selection'),
    /** The chosen adapter's name. Not an enum: adapters are registered at
     *  runtime, and a decision recorded before an adapter was removed must
     *  still parse. */
    outcome: z.string().min(1),
  }),
]);

export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;
export type DecisionType = z.infer<typeof DecisionTypeSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
