import { z } from 'zod';

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export const ApprovalSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  reason: z.string(),
  status: ApprovalStatusSchema,
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;
