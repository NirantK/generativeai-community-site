import { z } from "zod";
export const POLICY = "practitioners-v1";
export const CONSENT = "admissions-v1";
export const TOKEN_TTL = 24 * 60 * 60 * 1000;
export const applicationSchema = z
  .object({
    linkedinUrl: z
      .string()
      .trim()
      .url()
      .max(300)
      .refine((v) => {
        const u = new URL(v);
        return (
          u.protocol === "https:" &&
          ["linkedin.com", "www.linkedin.com"].includes(u.hostname) &&
          /^\/in\/[^/]+\/?$/.test(u.pathname) &&
          !u.search &&
          !u.hash
        );
      }, "Use an https://www.linkedin.com/in/ profile URL"),
    role: z.string().trim().min(2).max(300),
    organization: z.string().trim().min(2).max(300),
    education: z.string().trim().min(2).max(600),
    project: z.string().trim().min(40).max(4000),
    contribution: z.string().trim().min(20).max(2000),
    outcome: z.string().trim().min(10).max(2000),
    motivation: z.string().trim().min(20).max(2000),
  })
  .strict();
export type Application = z.infer<typeof applicationSchema>;
export const assessmentSchema = z
  .object({
    relevant: z.boolean(),
    concrete: z.boolean(),
    contribution: z.boolean(),
    uncertain: z.boolean(),
    reasons: z.string().min(1).max(1500),
    evidence: z.array(z.string().min(10).max(1000)).min(1).max(5),
  })
  .strict();
export type Assessment = z.infer<typeof assessmentSchema>;
export type Profile = {
  id: string;
  sub: string;
  name: string;
  email: string;
  emailVerified: boolean;
  picture?: string;
};
export type Delivery = {
  status:
    "pending" | "paused" | "sending" | "accepted" | "failed" | "uncertain";
  attempts: number;
  messageId?: string;
  error?: string;
  updatedAt?: number;
};
export type RecordState = {
  profile: Profile | null;
  consent: string | null;
  tokenHash: string | null;
  tokenExpires: number;
  verification: {
    hash: string;
    email: string;
    expires: number;
    attempts: number;
  } | null;
  application: Application | null;
  payloadHash: string | null;
  idempotencyKey: string | null;
  status: "draft" | "submitted" | "review" | "approved" | "declined";
  assessment: Assessment | null;
  policy: string;
  model: string | null;
  decision: { actor: string; reason: string; at: number } | null;
  delivery: Delivery;
  history: { event: string; actor: string; at: number }[];
};
export function initialRecord(): RecordState {
  return {
    profile: null,
    consent: null,
    tokenHash: null,
    tokenExpires: 0,
    verification: null,
    application: null,
    payloadHash: null,
    idempotencyKey: null,
    status: "draft",
    assessment: null,
    policy: POLICY,
    model: null,
    decision: null,
    delivery: { status: "pending", attempts: 0 },
    history: [],
  };
}
export function qualifies(a: Assessment, application: Application): boolean {
  const text = [
    application.project,
    application.contribution,
    application.outcome,
  ].join("\n");
  return (
    a.relevant &&
    a.concrete &&
    a.contribution &&
    !a.uncertain &&
    a.evidence.every((e) => text.includes(e))
  );
}
export function submissionResult(
  state: RecordState,
  hash: string,
  key: string,
): "new" | "replay" | "conflict" {
  if (!state.application) return "new";
  return state.payloadHash === hash ? "replay" : "conflict";
}
export function emailFailure(code: string): "failed" | "uncertain" {
  return [
    "E_VALIDATION_ERROR",
    "E_FIELD_MISSING",
    "E_SENDER_NOT_VERIFIED",
    "E_RECIPIENT_NOT_ALLOWED",
    "E_RECIPIENT_SUPPRESSED",
    "E_SENDER_DOMAIN_NOT_AVAILABLE",
    "E_RATE_LIMIT_EXCEEDED",
    "E_DAILY_LIMIT_EXCEEDED",
  ].includes(code)
    ? "failed"
    : "uncertain";
}
