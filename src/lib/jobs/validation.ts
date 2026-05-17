import { z } from 'zod';

export const jobDraftSchema = z.object({
  role: z.string().min(2).max(100),
  company: z.string().min(2).max(100),
  location: z.string().min(2).max(80),
  comp: z.string().max(80).optional().nullable(),
  applyWeb: z.string().url(),
  applyApi: z.string().url().optional().nullable(),
  contactEmail: z.string().email(),
  blurb: z.string().min(20).max(280),
});

export type JobDraft = z.infer<typeof jobDraftSchema>;
