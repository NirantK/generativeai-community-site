import { z } from "zod";
export const POLICY = "students-exceptional-v5";
export const CONSENT = "admissions-v1";
export const TOKEN_TTL = 24 * 60 * 60 * 1000;
export const linkedinProfileSchema = z.string().trim().max(500).url().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      /^(www\.|[a-z]{2}\.)?linkedin\.com$/.test(url.hostname) &&
      /^\/in\/[\p{L}\p{N}._-]+\/?$/u.test(decodeURIComponent(url.pathname));
  } catch { return false; }
}, "Use your HTTPS LinkedIn profile link, such as https://www.linkedin.com/in/your-name/.").transform(value => {
  const url = new URL(value);
  return `https://www.linkedin.com${url.pathname.replace(/\/$/, "")}/`;
});
export const applicationSchema = z
  .object({
    whatsapp: z.string().trim().max(32).transform(value => value.replace(/[\s()-]/g, "")).pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, "Enter your WhatsApp number with country code, for example +14155552671.")),
    linkedinUrl: linkedinProfileSchema,
    role: z.string().trim().min(2).max(300),
    project: z.string().trim().min(40).max(4000),
    contribution: z.string().trim().min(20).max(2000),
    motivation: z.string().trim().min(20).max(2000),
  })
  .strict();
export type Application = z.infer<typeof applicationSchema>;
export const assessmentSchema = z
  .object({
    student: z.object({
      status: z.enum(["student", "not_student", "unclear"]),
      roleEvidence: z.string().min(2).max(300),
      exceptional: z.boolean(),
      exceptionalEvidence: z.array(z.string().min(10).max(1000)).max(5),
    }).strict(),
    affiliation: z.object({
      company: z.enum(["Dashverse", "Frameo", "Lossfunk", "OpenAI", "Anthropic", "ElevenLabs", "Cartesia"]),
      current: z.boolean(),
      endedOn: z.string().nullable(),
      evidence: z.string().min(2).max(300),
    }).strict().nullable().optional(),
    relevant: z.boolean(),
    concrete: z.boolean(),
    contribution: z.boolean(),
    uncertain: z.boolean(),
    reasons: z.string().min(1).max(1500),
    evidence: z.array(z.string().min(10).max(1000)).min(1).max(5),
  })
  .strict();
export type Assessment = z.infer<typeof assessmentSchema>;
export const appealSchema = z.object({
  proofUrl: z.string().url().max(2000).refine(url => /^https:\/\//i.test(url), "Use an HTTPS work link.").optional(),
  explanation: z.string().trim().min(80).max(4000).optional(),
  voucher: z.string().trim().min(20).max(1000).optional(),
}).strict().refine(value => !!(value.proofUrl || value.explanation || value.voucher), "Provide work evidence, a project explanation, or a community member who can vouch for you.");
export type Decision = { actor: string; reason: string; at: number };
export type Appeal = { id: string; key: string; hash: string; evidence: z.infer<typeof appealSchema>; submittedAt: number; previousDecision: Decision; resolution: (Decision & { action: "approve" | "decline" }) | null };
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
  submittedAt?: number;
  submissionChannel?: "agent" | "form";
  appeals?: Appeal[];
  assessment: Assessment | null;
  assessmentFailure?: "model_unavailable" | "invalid_model_output" | null;
  policy: string;
  model: string | null;
  decision: Decision | null;
  delivery: Delivery;
  receipt?: Delivery;
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
    receipt: { status: "pending", attempts: 0 },
    history: [],
  };
}
export function qualifies(a: Assessment, application: Application, now = Date.now()): boolean {
  if (affiliationQualifies(a, application, now)) return true;
  if (!a.student || a.student.status === "unclear" || !application.role.includes(a.student.roleEvidence)) return false;
  if (a.student.status === "student" && !exceptionalStudent(a, application)) return false;
  const text = [application.project, application.contribution].join("\n");
  return (
    a.evidence.length > 0 &&
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

export function whatsappInvite(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    if (url.protocol !== "https:" || url.host !== "chat.whatsapp.com" || url.username || url.password || !/^\/[A-Za-z0-9]+$/.test(url.pathname)) return null;
    return `${url.origin}${url.pathname}`;
  } catch { return null; }
}

export function exceptionalStudent(a: Assessment, application: Application): boolean {
  const text = `${application.project}\n${application.contribution}`;
  return !!a.student?.exceptional && a.student.exceptionalEvidence.length > 0 && a.student.exceptionalEvidence.every(quote => text.includes(quote));
}
export function rejectStudent(a: Assessment, application: Application): boolean {
  return !affiliationQualifies(a, application) && !a.uncertain && a.student?.status === "student" && application.role.includes(a.student.roleEvidence) && !a.student.exceptional;
}

export function affiliationQualifies(a: Assessment, application: Application, now = Date.now()): boolean {
  const affiliation = a.affiliation;
  if (affiliation && !a.uncertain && application.role.includes(affiliation.evidence)) {
    const named = new RegExp(`\\b${affiliation.company}\\b`, "i").test(affiliation.evidence);
    const globalCompany = ["OpenAI", "Anthropic", "ElevenLabs", "Cartesia"].includes(affiliation.company);
    const cutoff = new Date(now); cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1); cutoff.setUTCHours(0, 0, 0, 0);
    const ended = affiliation.endedOn && /^\d{4}-\d{2}-\d{2}$/.test(affiliation.endedOn) ? Date.parse(affiliation.endedOn + "T00:00:00Z") : NaN;
    const validDate = Number.isFinite(ended) && new Date(ended).toISOString().slice(0,10) === affiliation.endedOn;
    if (named && (affiliation.current || (globalCompany && validDate && ended >= cutoff.getTime() && ended <= now))) return true;
  }
  return false;
}
