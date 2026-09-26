import { z } from 'zod';

export const INTENT_VALUES = [
  'Software development',
  'Research',
  'Automation',
  'Operations',
  'Other',
] as const;

export type IntentValue = (typeof INTENT_VALUES)[number];

export const waitlistRequestSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.string().min(3).max(254).email()),
  intent: z.enum(INTENT_VALUES).optional(),
  honeypot: z.string().max(200).optional(),
  consentVersion: z.string().max(50).nullable().optional(),
});

export type WaitlistRequest = z.infer<typeof waitlistRequestSchema>;
