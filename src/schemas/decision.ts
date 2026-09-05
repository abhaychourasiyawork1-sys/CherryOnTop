import { z } from 'zod';

export const DecisionOutcomeSchema = z.enum(['SELF_EXECUTE', 'DELEGATE', 'ESCALATE']);

export const DecisionSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  type: z.literal('execution_decision'),
  outcome: DecisionOutcomeSchema,
  breakdown: z.record(z.string(), z.number()),
  createdAt: z.string().datetime(),
});

export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
