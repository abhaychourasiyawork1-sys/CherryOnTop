import { z } from 'zod';

export const AuthoritySchema = z.object({
  tools: z.array(z.string()),
  spawn_children: z.boolean(),
  max_child_count: z.number().int().nonnegative(),
  budget_usd: z.number().nonnegative(),
});

export const DeadlineSchema = z.object({
  expected_at: z.string().datetime().optional(),
  hard_at: z.string().datetime().optional(),
});

export const NodeContractSchema = z.object({
  goal: z.string().min(1),
  definition_of_done: z.array(z.string()).min(1),
  authority: AuthoritySchema,
  constraints: z.array(z.string()).default([]),
  deadline: DeadlineSchema.optional(),
});

export type Authority = z.infer<typeof AuthoritySchema>;
export type Deadline = z.infer<typeof DeadlineSchema>;
export type NodeContract = z.infer<typeof NodeContractSchema>;
