import { z } from 'zod';

export const CommitmentStatusSchema = z.enum(['pending', 'active', 'blocked', 'at_risk', 'completed', 'failed']);

export const CommitmentSchema = z.object({
  id: z.string(),
  owner: z.string(),
  parent_commitment: z.string().optional(),
  goal: z.string().min(1),
  definition_of_done: z.array(z.string()).min(1),
  status: CommitmentStatusSchema,
  created_at: z.string().datetime(),
  started_at: z.string().datetime().optional(),
  expected_at: z.string().datetime().optional(),
  due_at: z.string().datetime().optional(),
  last_progress_at: z.string().datetime().optional(),
  next_check_at: z.string().datetime().optional(),
  completed_at: z.string().datetime().optional(),
  dependencies: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  current_confidence: z.number().min(0).max(1).optional(),
  current_progress: z.number().min(0).max(1).optional(),
});

export type CommitmentStatus = z.infer<typeof CommitmentStatusSchema>;
export type Commitment = z.infer<typeof CommitmentSchema>;
