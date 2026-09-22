import { assessmentRequest, parseAssessment } from "./assessment";
import { z } from "zod";
import { Agent } from "agents";
import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import {
  applicationSchema,
  linkedinProfileSchema,
  CONSENT,
  POLICY,
  TOKEN_TTL,
  initialRecord,
  qualifies,
  rejectStudent,
  appealSchema,
  whatsappInvite,
  submissionResult,
  emailFailure,
  initialEnrichment,
} from "./domain";
import type { RecordState, Profile, Assessment, Delivery, Enrichment } from "./domain";
import { ApiError, digest, randomToken, escapeHtml } from "./security";
import { verifyMainTrackPaper } from "./publication";
import { enrichPerson } from "./crustdata";

export class AdmissionAgent extends Agent<Env, RecordState> {
  initialState = initialRecord();
  // All mutations run through this queue, including across external awaits.
  private pending: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.pending.then(fn, fn);
    this.pending = result.catch(() => {});
    return result;
  }
  private write(next: Partial<RecordState>, event?: string, actor = "system") {
    this.setState({
      ...this.state,
      ...next,
      history: event
        ? [...this.state.history, { event, actor, at: Date.now() }].slice(-100)
        : this.state.history,
    });
  }
  async index() {
    const p = this.state.profile;
    if (!p) return;
    const link = linkedinProfileSchema.safeParse(this.state.application?.linkedinUrl);
    const submittedAt = this.state.submittedAt ?? this.state.history.find(event => event.event === "submitted")?.at ?? null;
    await this.env.INDEX.prepare(
      "INSERT INTO applications(id,name,status,delivery,updated_at,appeal_status,approved_at,submitted_at,linkedin_url,details_version) VALUES(?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,delivery=excluded.delivery,updated_at=excluded.updated_at,appeal_status=excluded.appeal_status,approved_at=excluded.approved_at,submitted_at=excluded.submitted_at,linkedin_url=excluded.linkedin_url,details_version=1",
    )
      .bind(
        p.id,
        p.name,
        this.state.status,
        this.state.delivery.status,
        Date.now(),
        this.state.appeals?.some(a => !a.resolution) ? "pending" : this.state.appeals?.length ? "resolved" : "none",
        this.state.status === "approved" ? this.state.decision?.at ?? null : null,
        submittedAt,
        link.success ? link.data : null,
      )
      .run();
  }
  async identify(profile: Profile) {
    return this.serial(async () => {
      if (this.state.profile && this.state.profile.sub !== profile.sub)
        throw new ApiError(403, "identity", "Account mismatch.");
      // Only a validated LinkedIn callback can refresh identity or email.
      const changed =
        this.state.profile &&
        !this.state.application &&
        (this.state.profile.email !== profile.email ||
          this.state.profile.emailVerified !== profile.emailVerified);
      this.write({
        profile: this.state.application
          ? { ...this.state.profile!, name: profile.name }
          : profile,
        verification: null,
        ...(changed ? { tokenHash: null, tokenExpires: 0 } : {}),
      });
      await this.index();
      if (this.state.consent === CONSENT && this.state.profile?.emailVerified)
        await this.queueEnrichment("email", this.state.profile.email);
      return this.publicState();
    });
  }
  async publicState() {
    const { profile, application, status, consent, delivery } = this.state;
    const enrichment = this.state.enrichment ?? initialEnrichment();
    return {
      profile,
      application,
      enrichment: { status: enrichment.status, source: enrichment.source, data: enrichment.data, updatedAt: enrichment.updatedAt },
      status,
      consent: consent === CONSENT || application ? consent : null,
      delivery: { status: delivery.status },
      receipt: { status: this.state.receipt?.status ?? "pending" },
      submissionChannel: this.state.submissionChannel ?? "unknown",
      decisionReason: this.state.decision?.reason ?? null,
      appeal: {
        eligible: status === "declined" && this.state.submissionChannel === "agent",
        status: this.state.appeals?.at(-1)?.resolution ? "resolved" : this.state.appeals?.length ? "pending" : "none",
        requirements: "Provide an HTTPS link to your work, a detailed project explanation, or the name and context of a community member who can vouch for your work. References require administrator verification.",
        history: (this.state.appeals ?? []).map(({key,hash,...appeal}) => ({...appeal, previousDecision: {...appeal.previousDecision, actor: appeal.previousDecision.actor === "agent" ? "agent" : "administrator"}, resolution: appeal.resolution ? {...appeal.resolution, actor: "administrator"} : null})),
      },
      missingRequirements: [
        ...(!profile?.emailVerified ? ["verifiedEmail"] : []),
        ...(!application && consent !== CONSENT ? ["consent"] : []),
        ...(!application ? Object.keys(applicationSchema.shape) : []),
      ],
      tokenActive:
        !!this.state.tokenHash && this.state.tokenExpires > Date.now(),
    };
  }
  async inspect() {
    return this.state;
  }
  async authorizeToken(hash: string) {
    return (
      !!this.state.tokenHash &&
      this.state.tokenHash === hash &&
      this.state.tokenExpires > Date.now()
    );
  }
  async consent() {
    return this.serial(async () => {
      this.write({ consent: CONSENT }, "consent", "applicant");
      if (this.state.profile?.emailVerified)
        await this.queueEnrichment("email", this.state.profile.email);
      return this.publicState();
    });
  }
  async token() {
    return this.serial(async () => {
      if (this.state.consent !== CONSENT)
        throw new ApiError(
          403,
          "consent",
          "Accept the application terms in your browser first.",
        );
      if (!this.state.profile?.emailVerified)
        throw new ApiError(
          409,
          "email_unverified",
          "LinkedIn must confirm your email. Refresh your LinkedIn sign-in.",
        );
      const token = randomToken(),
        hash = await digest(token),
        expires = Date.now() + TOKEN_TTL;
      await this.env.INDEX.prepare(
        "INSERT INTO tokens(hash,account_id,expires_at) VALUES(?,?,?)",
      )
        .bind(hash, this.state.profile.id, expires)
        .run();
      this.write(
        { tokenHash: hash, tokenExpires: expires },
        "token_issued",
        "applicant",
      );
      return { token, expiresAt: expires };
    });
  }
  async revoke() {
    return this.serial(async () => {
      this.write(
        { tokenHash: null, tokenExpires: 0 },
        "token_revoked",
        "applicant",
      );
      return { revoked: true };
    });
  }
  private async queueEnrichment(source: "email" | "linkedin", lookupValue: string) {
    if (this.state.consent !== CONSENT || !lookupValue) return;
    const previous = this.state.enrichment ?? initialEnrichment();
    if (source === "email" && previous.source === "linkedin") return;
    if (previous.source === source && previous.lookupValue === lookupValue &&
        !["idle", "unavailable"].includes(previous.status)) return;
    const next: Enrichment = {
      status: "pending", source, lookupValue, data: null, updatedAt: null,
    };
    this.write({ enrichment: next }, "enrichment_queued");
    await this.schedule(1, "enrich");
  }
  async setEnrichmentUrl(input: unknown) {
    return this.serial(async () => {
      const url = applicationSchema.shape.linkedinUrl.parse(input);
      if (this.state.application) throw new ApiError(409, "submitted", "Application already submitted.");
      if (this.state.consent !== CONSENT) throw new ApiError(403, "consent", "Save consent first.");
      await this.queueEnrichment("linkedin", url);
      return this.publicState();
    });
  }
  private async refreshEnrichment() {
    const snapshot = this.state.enrichment ?? initialEnrichment();
    if (snapshot.status !== "pending" || !snapshot.source || !snapshot.lookupValue) return;
    let data: Enrichment["data"] = null;
    let status: Enrichment["status"] = "unavailable";
    try {
      if (this.env.CRUSTDATA_API_KEY) {
        data = await enrichPerson(this.env.CRUSTDATA_API_KEY, snapshot.source,
          snapshot.lookupValue, this.state.profile!.name);
        status = data ? "matched" : "no_match";
      }
    } catch { /* Enrichment failures must not block submission or assessment. */ }
    const current = this.state.enrichment;
    if (current?.source === snapshot.source && current.lookupValue === snapshot.lookupValue) {
      this.write({ enrichment: { ...current, status, data, updatedAt: Date.now() } },
        "enrichment_checked");
    }
  }
  async enrich() {
    return this.serial(() => this.refreshEnrichment());
  }
  async submit(input: unknown, key: string, tokenHash?: string) {
    return this.serial(async () => {
      if (tokenHash && !(await this.authorizeToken(tokenHash)))
        throw new ApiError(
          401,
          "invalid_token",
          "Application token expired or revoked.",
        );
      if (this.state.consent !== CONSENT || !this.state.profile?.emailVerified)
        throw new ApiError(
          409,
          "incomplete_account",
          "Consent and a verified email are required.",
        );
      // Preserve exact accepted retries from before contact fields were required.
      if (this.state.application && (!this.state.application.whatsapp || !this.state.application.linkedinUrl)) {
        const legacy = applicationSchema.omit({ ...(!this.state.application.whatsapp ? { whatsapp: true as const } : {}), ...(!this.state.application.linkedinUrl ? { linkedinUrl: true as const } : {}) }).safeParse(input);
        if (legacy.success) {
          if (await digest(JSON.stringify(legacy.data)) !== this.state.payloadHash)
            throw new ApiError(409, "application_conflict", "An application has already been submitted with different content.");
          await this.index();
          return this.publicState();
        }
      }
      const parsed = applicationSchema.safeParse(input);
      if (!parsed.success)
        throw new ApiError(
          422,
          "validation",
          "Check the application fields.",
          parsed.error.flatten(),
        );
      const hash = await digest(JSON.stringify(parsed.data));
      const result = submissionResult(this.state, hash, key);
      if (result === "conflict")
        throw new ApiError(
          409,
          "application_conflict",
          "An application has already been submitted with different content.",
        );
      if (result === "new") {
        this.write(
          {
            application: parsed.data,
            submittedAt: Date.now(),
            payloadHash: hash,
            idempotencyKey: key,
            status: "submitted",
            submissionChannel: tokenHash ? "agent" : "form",
          },
          "submitted",
          "applicant",
        );
        await this.schedule(1, "deliverReceipt");
        await this.queueEnrichment("linkedin", parsed.data.linkedinUrl);
        await this.schedule(30, "ensureWorkflow");
      }
      await this.index();
      // A deterministic workflow ID recovers a crash between saving and dispatching.
      await this.ensureWorkflow();
      return this.publicState();
    });
  }
  async ensureWorkflow() {
    if (!this.state.application) return;
    const id = `review-${this.state.profile!.id}`;
    try {
      await this.runWorkflow(
        "REVIEW",
        { accountId: this.state.profile!.id },
        { id, agentBinding: "ADMISSION" },
      );
    } catch {
      try {
        const existing = await this.env.REVIEW.get(id);
        const status = await existing.status();
        if (status.status === "errored") await existing.restart();
      } catch {
        await this.schedule(60, "ensureWorkflow");
        throw new ApiError(
          503,
          "assessment_queued",
          "Application saved. Assessment will retry shortly.",
        );
      }
    }
  }
  async assess() {
    return this.serial(async () => {
      if (this.state.status !== "submitted") return;
      const application = this.state.application!;
      await this.refreshEnrichment();
      let assessment: Assessment | null = null;
      let failure: "model_unavailable" | "invalid_model_output" | null =
        "model_unavailable";
      try {
        const output = await this.env.AI.run(
          this.env.AI_MODEL as Parameters<Ai["run"]>[0],
          assessmentRequest(application, new Date().toISOString().slice(0, 10), this.state.enrichment?.data ?? null),
        );
        failure = "invalid_model_output";
        assessment = parseAssessment(output);
        failure = null;
      } catch {
        /* Fail closed to human review; never reject on infrastructure failure. */
      }
      const ordinaryApproval = !!assessment && !assessment.paper && qualifies(assessment, application);
      let verifiedPaperUrl: string | null = null;
      if (assessment?.paper && !ordinaryApproval && this.env.AUTO_APPROVALS_ENABLED === "true") {
        try {
          verifiedPaperUrl = await verifyMainTrackPaper(
            assessment.paper,
            this.state.profile!.name,
            application,
          );
        } catch {
          // Search outages or unclear evidence require human review.
        }
      }
      const approved =
        this.env.AUTO_APPROVALS_ENABLED === "true" &&
        (ordinaryApproval || !!verifiedPaperUrl);
      const declined = !!assessment && !verifiedPaperUrl && rejectStudent(assessment, application) && this.env.AUTO_APPROVALS_ENABLED === "true";
      this.write(
        {
          assessment,
          assessmentFailure: failure,
          policy: POLICY,
          model: this.env.AI_MODEL,
          status: approved ? "approved" : declined ? "declined" : "review",
          decision: approved || declined
            ? { actor: "agent", reason: verifiedPaperUrl ? `Verified main-track paper: ${verifiedPaperUrl}` : assessment!.reasons, at: Date.now() }
            : null,
        },
        approved ? "auto_approved" : declined ? "auto_declined_student" : "review_required",
      );
      await this.index();
      if (approved) await this.schedule(1, "deliver");
    });
  }
  async appeal(input: unknown, key: string, tokenHash?: string) {
    return this.serial(async () => {
      if (tokenHash && !(await this.authorizeToken(tokenHash))) throw new ApiError(401, "invalid_token", "Application token expired or revoked.");
      if (this.state.submissionChannel !== "agent") throw new ApiError(403, "appeal_ineligible", "Appeals are available only for applications originally submitted using an agent token.");
      const parsed = appealSchema.safeParse(input);
      if (!parsed.success) throw new ApiError(422, "validation", "Provide work evidence, a project explanation, or a community reference.", parsed.error.flatten());
      const evidence = parsed.data;
      const hash = await digest(JSON.stringify(evidence));
      const appeals = this.state.appeals ?? [];
      const previous = appeals.find(a => a.key === key);
      if (previous) {
        if (previous.hash !== hash) throw new ApiError(409, "idempotency_conflict", "This appeal key was already used with different evidence.");
        await this.index();
        return this.publicState();
      }
      if (this.state.status !== "declined" || !this.state.decision || appeals.some(a => !a.resolution)) throw new ApiError(409, "appeal_conflict", "An appeal requires a rejected application with no pending appeal.");
      const last = appeals.at(-1);
      if (last?.hash === hash) throw new ApiError(409, "new_evidence_required", "Provide new evidence when appealing another rejection.");
      this.write({
        status: "review", decision: null,
        appeals: [...appeals, {id: crypto.randomUUID(),key,hash,evidence,submittedAt:Date.now(),previousDecision:this.state.decision,resolution:null}],
      }, "appeal_submitted", "applicant");
      await this.schedule(1, "index");
      await this.index();
      return this.publicState();
    });
  }
  async reassess(actor: string) {
    await this.serial(async () => {
      if (this.state.status !== "review" || this.state.decision || this.state.appeals?.some(a => !a.resolution))
        throw new ApiError(
          409,
          "assessment_conflict",
          "Only undecided applications awaiting review can be reassessed.",
        );
      this.write({ status: "submitted" }, "reassessment_requested", actor);
      await this.schedule(1, "assess");
      await this.index();
    });
    await this.assess();
    return this.publicState();
  }
  async decide(action: "approve" | "decline", reason: string, actor: string) {
    return this.serial(async () => {
      if (this.state.status !== "review")
        throw new ApiError(
          409,
          "decision_conflict",
          "This application is no longer awaiting review.",
        );
      this.write(
        {
          status: action === "approve" ? "approved" : "declined",
          decision: { actor, reason, at: Date.now() },
          appeals: (this.state.appeals ?? []).map(a => a.resolution ? a : { ...a, resolution: { actor, reason, at: Date.now(), action } }),
        },
        action,
        actor,
      );
      await this.index();
      if (action === "approve") await this.schedule(1, "deliver");
      try {
        const workflow = await this.env.REVIEW.get(
          `review-${this.state.profile!.id}`,
        );
        await workflow.sendEvent({ type: "decision", payload: { action } });
      } catch {
        /* Durable polling also observes the stored decision. */
      }
      return this.publicState();
    });
  }
  async deliver() {
    return this.dispatchEmail("invite");
  }
  async deliverReceipt() {
    return this.dispatchEmail("receipt");
  }
  private async dispatchEmail(kind: "invite" | "receipt") {
    return this.serial(async () => {
      if (
        kind === "invite"
          ? this.state.status !== "approved"
          : !this.state.application
      )
        return;
      const field = kind === "receipt" ? "receipt" : "delivery";
      const previous: Delivery = this.state[field] ?? {
        status: "pending",
        attempts: 0,
      };
      if (["accepted", "uncertain"].includes(previous.status)) return;
      if (previous.status === "sending") {
        this.write(
          { [field]: { ...previous, status: "uncertain" } },
          `${kind}_email_uncertain`,
        );
        await this.index();
        return;
      }
      if (this.env.EMAIL_ENABLED !== "true") {
        this.write({ [field]: { ...previous, status: "paused" } });
        await this.index();
        return;
      }
      const url = whatsappInvite(this.env.WHATSAPP_INVITE_URL);
      if (
        kind === "invite" &&
        !url
      ) {
        this.write({
          [field]: {
            ...previous,
            status: "failed",
            error: "invite_not_configured",
          },
        });
        await this.index();
        return;
      }
      this.write(
        {
          [field]: {
            status: "sending",
            attempts: previous.attempts + 1,
            updatedAt: Date.now(),
          },
        },
        `${kind}_email_started`,
      );
      try {
        const application = this.state.application;
        const labels: [string, string][] = application
          ? [
              ["WhatsApp phone number", application.whatsapp ?? "Not provided"],
              ["LinkedIn profile (applicant supplied)", application.linkedinUrl ?? "Not provided"],
              ["Current or most recent role", application.role],
              ["AI project or use case", application.project],
              ["Your contribution", application.contribution],
              ["Reason for joining", application.motivation],
            ]
          : [];
        const receiptText =
          "We received your GenerativeAI Community application. Here is your submitted copy. This is not an approval or invitation.\n\n" +
          labels.map(([label, value]) => `${label}\n${value}`).join("\n\n") +
          `\n\nCheck your status: ${this.env.SITE_URL}/apply`;
        const receiptHtml =
          "<p>We received your GenerativeAI Community application. Here is your submitted copy. This is not an approval or invitation.</p>" +
          labels
            .map(
              ([label, value]) =>
                `<h2>${label}</h2><p>${escapeHtml(value).replaceAll("\n", "<br>")}</p>`,
            )
            .join("") +
          `<p><a href="${escapeHtml(this.env.SITE_URL)}/apply">Check your application status</a></p>`;
        const response = await this.env.EMAIL.send({
          from: {
            email: "noreply@genaicommunity.ai",
            name: "GenerativeAI Community",
          },
          to: this.state.profile!.email,
          subject:
            kind === "receipt"
              ? "Your GenerativeAI Community application — submitted copy"
              : "You’re approved — join the GenerativeAI Community",
          text:
            kind === "receipt"
              ? receiptText
              : `Your application is approved. Join our WhatsApp community: ${url}\n\nExplore the member-only Past Chats archive: ${this.env.SITE_URL}/past-chats\n\nTo let your AI agent search Past Chats, sign in and generate a token here: ${this.env.SITE_URL}/apply#agent-token\nAgent instructions: ${this.env.SITE_URL}/api-instructions\n\nPlease read our community rules: ${this.env.SITE_URL}/#whatsapp-community-rules`,
          html:
            kind === "receipt"
              ? receiptHtml
              : `<p>Your application is approved.</p><p><a href="${escapeHtml(url!)}">Join our WhatsApp community</a></p><p>Now that you’re a member, explore <a href="${escapeHtml(this.env.SITE_URL)}/past-chats">Past Chats</a> to search conversations that shaped the community.</p><p>To let your AI agent search Past Chats, <a href="${escapeHtml(this.env.SITE_URL)}/apply#agent-token">generate a member API token</a> after signing in. You can then give the token && the <a href="${escapeHtml(this.env.SITE_URL)}/api-instructions">agent instructions</a> to your agent.</p><p>Please read our <a href="${escapeHtml(this.env.SITE_URL)}/#whatsapp-community-rules">community rules</a>.</p>`,
        });
        this.write(
          {
            [field]: {
              ...this.state[field]!,
              status: "accepted",
              messageId: response.messageId,
            },
          },
          `${kind}_email_accepted`,
        );
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : "unknown";
        this.write(
          {
            [field]: {
              ...this.state[field]!,
              status: emailFailure(code),
              error: code,
            },
          },
          `${kind}_email_failed`,
        );
        if (code === "E_RATE_LIMIT_EXCEEDED" && this.state[field]!.attempts < 3)
          await this.schedule(
            60 * this.state[field]!.attempts,
            kind === "receipt" ? "deliverReceipt" : "deliver",
          );
      }
      await this.index();
    });
  }
  async reconcileDelivery(
    outcome: "accepted" | "not_sent",
    reason: string,
    actor: string,
    kind: "invite" | "receipt" = "invite",
  ) {
    return this.serial(async () => {
      const field = kind === "receipt" ? "receipt" : "delivery";
      const ledger = this.state[field] ?? { status: "pending", attempts: 0 };
      if (!["uncertain", "sending"].includes(ledger.status))
        throw new ApiError(
          409,
          "delivery_conflict",
          "Only uncertain delivery can be reconciled.",
        );
      this.write(
        {
          [field]: {
            ...ledger,
            status: outcome === "accepted" ? "accepted" : "failed",
            error: outcome === "not_sent" ? "confirmed_not_sent" : undefined,
          },
        },
        `${kind}_delivery_reconciled: ${reason}`,
        actor,
      );
      await this.index();
      return this.publicState();
    });
  }
  async retryDelivery(actor: string, kind: "invite" | "receipt" = "invite") {
    const ledger = this.state[kind === "receipt" ? "receipt" : "delivery"] ?? {
      status: "pending",
      attempts: 0,
    };
    if (ledger.status === "uncertain" || ledger.status === "sending")
      throw new ApiError(
        409,
        "delivery_uncertain",
        "Check Cloudflare email logs before resolving this delivery.",
      );
    if (kind === "receipt") await this.deliverReceipt();
    else await this.deliver();
    return this.publicState();
  }
}

export class AdmissionWorkflow extends AgentWorkflow<
  AdmissionAgent,
  { accountId: string }
> {
  async run(
    event: AgentWorkflowEvent<{ accountId: string }>,
    step: AgentWorkflowStep,
  ) {
    await step.do("receipt", () => this.agent.deliverReceipt());
    await step.do("assess", () => this.agent.assess());
    // Persisted decisions are the source of truth; events accelerate the wait.
    for (let i = 0; i < 90; i++) {
      const state = await step.do(`status-${i}`, () =>
        this.agent.publicState(),
      );
      if (state.status !== "review") break;
      try {
        await step.waitForEvent(`decision-${i}`, {
          type: "decision",
          timeout: "1 day",
        });
      } catch {
        /* Check persisted state after timeout. */
      }
    }
    await step.do("deliver", () => this.agent.deliver());
    await step.do("index", () => this.agent.index());
  }
}
