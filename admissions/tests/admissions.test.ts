import { describe, it, expect, beforeAll, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { AdmissionsGateway } from "../src/index";
import {
  applicationSchema,
  initialRecord,
  qualifies,
  rejectStudent,
  assessmentSchema,
  whatsappInvite,
  submissionResult,
  emailFailure,
} from "../src/domain";
import { digest, randomToken, csrf } from "../src/security";
import listingMigration from "../migrations/0006_admin_listing.sql?raw";
import archiveMigration from "../migrations/0005_chat_archive.sql?raw";
import migration from "../migrations/0001_admissions.sql?raw";
import appealMigration from "../migrations/0004_appeal_index.sql?raw";
import adminMigration from "../migrations/0003_administrators.sql?raw";
import bugMigration from "../migrations/0002_bug_reports.sql?raw";
import modelMigration from "../migrations/0007_model_usage.sql?raw";
const sample = {
  linkedinUrl: "https://www.linkedin.com/in/test-builder/",
  whatsapp: "+14155552671",
  role: "AI engineer",

  project:
    "I built a retrieval augmented AI assistant for a local library catalog.",
  contribution:
    "I implemented document ingestion and evaluated retrieval quality.",

  motivation:
    "I want to share evaluation methods and learn from other builders.",
};
beforeAll(async () => {
  for (const query of (migration + bugMigration + adminMigration + appealMigration + archiveMigration + listingMigration + modelMigration)
    .split(";")
    .filter((s) => s.trim()))
    await env.INDEX.prepare(query).run();
});

describe("member model API", () => {
  it("requires an approved member and records measured GPU seconds under the account", async () => {
    const owner = await account();
    await owner.agent.consent();
    const { token } = await owner.agent.token();
    const headers = { Authorization: `Bearer ${token}` };
    expect((await gateway("/api/v1/models", "GET", headers)).status).toBe(403);
    await runInDurableObject(owner.agent, async instance => {
      instance.setState({ ...instance.state, status: "approved" });
    });
    const previous = env.MODAL_PROXY_TOKEN;
    env.MODAL_PROXY_TOKEN = "test-proxy-token";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({answers:{billing:{noul:true}}}), {
      status: 200, headers: {"X-GPU-Seconds":"0.125432", "Content-Type":"application/json"},
    }));
    try {
      const modelList = await (await gateway("/api/v1/models", "GET", headers)).json() as any;
      expect(modelList.models.map((model:any) => model.name)).toContain("laya-typed-decisions");
      const request = {
        model: "laya-typed-decisions",
        state: {message:"Charged twice"},
        questions: {billing:{type:"noul",instructions:"Is this about billing?"}},
      };
      const response = await gateway("/api/v1/models/infer", "POST", headers, request);
      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.model).toBe(request.model);
      expect(data.result.answers.billing.noul).toBe(true);
      expect(data.usage).toEqual({gpuSeconds:0.125432,totalGpuSeconds:0.125432,requestCount:1});
      expect(fetchMock).toHaveBeenCalledOnce();
      expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({Authorization:"Bearer test-proxy-token"});
      const usage = await (await gateway("/api/v1/models/usage?model=laya-typed-decisions", "GET", headers)).json() as any;
      expect(usage.usage).toEqual({requestCount:1,gpuSeconds:0.125432});
      expect((await gateway("/api/v1/models/usage?model=unknown", "GET", headers)).status).toBe(404);
    } finally {
      fetchMock.mockRestore();
      env.MODAL_PROXY_TOKEN = previous;
    }
  });
});
async function account(
  verified = true,
  sub = crypto.randomUUID(),
  email = "applicant@example.com",
) {
  const id = await digest(sub),
    agent = await getAgentByName(env.ADMISSION, id);
  await agent.identify({
    id,
    sub,
    name: "Test applicant",
    email,
    emailVerified: verified,
  });
  return { id, agent };
}
async function browser(id: string) {
  const token = randomToken();
  await env.INDEX.prepare(
    "INSERT INTO sessions(hash,account_id,expires_at) VALUES(?,?,?)",
  )
    .bind(await digest(token), id, Date.now() + 3600000)
    .run();
  return `__Host-ga-session=${token}`;
}
function gateway(
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
  data?: unknown,
) {
  return new AdmissionsGateway(createExecutionContext(), env).fetch(
    new Request(`https://genaicommunity.ai${path}`, {
      method,
      headers: {
        ...headers,
        ...(data ? { "Content-Type": "application/json" } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    }),
  );
}

describe("administrator identity", () => {
  it("permits only the configured browser account and fails closed", async () => {
    const owner = await account();
    const other = await account(true, crypto.randomUUID(), "other@example.com");
    const unverified = await account(false);
    const previous = env.ADMIN_EMAILS;
    try {
      env.ADMIN_EMAILS = "  APPLICANT@example.com  ";
      expect(
        (
          await gateway("/api/admin/applications", "GET", {
            Cookie: await browser(owner.id),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await gateway("/api/admin/applications", "GET", {
            Cookie: await browser(other.id),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await gateway("/api/admin/applications", "GET", {
            Cookie: await browser(unverified.id),
          })
        ).status,
      ).toBe(403);
      await owner.agent.consent();
      const { token } = await owner.agent.token();
      expect(
        (
          await gateway("/api/admin/applications", "GET", {
            Authorization: `Bearer ${token}`,
          })
        ).status,
      ).toBe(403);
      env.ADMIN_EMAILS = "";
      expect(
        (
          await gateway("/api/admin/applications", "GET", {
            Cookie: await browser(owner.id),
          })
        ).status,
      ).toBe(403);
    } finally {
      env.ADMIN_EMAILS = previous;
    }
  });
});

describe("policy and validation", () => {
  it("accepts students without collecting education or organization", () =>
    expect(
      applicationSchema.safeParse({
        ...sample, role: "Student",
      }).success,
    ).toBe(true));
  it("rejects identity injection and removed application fields", () => {
    expect(
      applicationSchema.safeParse({ ...sample, email: "other@example.com" })
        .success,
    ).toBe(false);
    expect(
      applicationSchema.safeParse({
        ...sample,
        education: "No formal education",
      }).success,
    ).toBe(false);
  });
  it("requires exact supporting evidence and sends uncertain assessments to review", () => {
    const assessment = {
      student: {status:"not_student" as const,roleEvidence:sample.role,exceptional:false,exceptionalEvidence:[]},
      relevant: true,
      concrete: true,
      contribution: true,
      uncertain: false,
      reasons: "Concrete project",
      evidence: [sample.project],
    };
    expect(qualifies(assessment, sample)).toBe(true);
    expect(
      qualifies(
        { ...assessment, evidence: ["invented professional experience"] },
        sample,
      ),
    ).toBe(false);
    expect(qualifies({ ...assessment, uncertain: true }, sample)).toBe(false);
  });
  it("never treats an unknown email outcome as safely retryable", () => {
    expect(emailFailure("E_RATE_LIMIT_EXCEEDED")).toBe("failed");
    expect(emailFailure("E_INTERNAL_SERVER_ERROR")).toBe("uncertain");
    expect(emailFailure("unknown")).toBe("uncertain");
  });
});

describe("real Worker and Durable Object security", () => {
  it("requires browser origin for consent and token issuance", async () => {
    const { id } = await account();
    const cookie = await browser(id);
    const r = await gateway(
      "/api/application-consent",
      "POST",
      { cookie },
      { consent: true },
    );
    expect(r.status).toBe(403);
  });
  it("requires consent and verified email before token issuance", async () => {
    const { agent } = await account(false);
    await expect((async () => await agent.token())()).rejects.toThrow(
      "consent",
    );
    await agent.consent();
    await expect((async () => await agent.token())()).rejects.toThrow(
      "email_unverified",
    );
  });
  it("replaces and revokes token hashes without storing the raw token", async () => {
    const { agent } = await account();
    await agent.consent();
    const first = await agent.token();
    const second = await agent.token();
    expect(await agent.authorizeToken(await digest(first.token))).toBe(false);
    expect(await agent.authorizeToken(await digest(second.token))).toBe(true);
    expect(JSON.stringify(await agent.inspect())).not.toContain(second.token);
    await agent.revoke();
    expect(await agent.authorizeToken(await digest(second.token))).toBe(false);
  });
  it("expires tokens and refuses them on browser/admin endpoints", async () => {
    const { agent } = await account();
    await agent.consent();
    const { token } = await agent.token();
    const headers = {
      Authorization: `Bearer ${token}`,
      Origin: "https://genaicommunity.ai",
    };
    expect((await gateway("/api/v1/application", "GET", headers)).status).toBe(
      200,
    );
    expect(
      (
        await gateway("/api/application-consent", "POST", headers, {
          consent: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (await gateway("/api/admin/applications", "GET", headers)).status,
    ).toBe(403);
    await runInDurableObject(agent, async (instance) => {
      instance.setState({ ...instance.state, tokenExpires: Date.now() - 1 });
    });
    expect((await gateway("/api/v1/application", "GET", headers)).status).toBe(
      401,
    );
  });
  it("restricts status to the token owner", async () => {
    const a = await account(),
      b = await account();
    await a.agent.consent();
    const { token } = await a.agent.token();
    const response = await gateway(
      `/api/v1/application?account=${b.id}`,
      "GET",
      { Authorization: `Bearer ${token}` },
    );
    const data = await response.json();
    expect(data.profile.id).toBe(a.id);
  });
  it("blocks submission contact edits and malformed idempotency keys", async () => {
    const { agent } = await account();
    await agent.consent();
    const { token } = await agent.token();
    const headers = { Authorization: `Bearer ${token}` };
    expect(
      (await gateway("/api/v1/application", "POST", headers, sample)).status,
    ).toBe(400);
    const r = await gateway(
      "/api/v1/application",
      "POST",
      { ...headers, "Idempotency-Key": "valid-key" },
      { ...sample, email: "attacker@example.com" },
    );
    expect(r.status).toBe(422);
  });
  it("serializes simultaneous decisions and never sends for pending applicants", async () => {
    const { agent } = await account();
    await runInDurableObject(agent, async (instance) => {
      instance.setState({
        ...instance.state,
        application: sample,
        status: "review",
      });
    });
    await agent.deliver();
    expect((await agent.inspect()).delivery.status).toBe("pending");
    const results = await Promise.allSettled([
      agent.decide("approve", "Concrete AI project", "admin"),
      agent.decide("decline", "Different review result", "admin"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (await agent.inspect()).history.filter(
        (h) => h.event === "approve" || h.event === "decline",
      ),
    ).toHaveLength(1);
  });
  it("does not resend after a crash leaves an email in flight", async () => {
    const { agent } = await account();
    await runInDurableObject(agent, async (instance) => {
      instance.setState({
        ...instance.state,
        status: "approved",
        delivery: { status: "sending", attempts: 1 },
      });
    });
    await agent.deliver();
    expect((await agent.inspect()).delivery.status).toBe("uncertain");
    await expect(
      (async () => await agent.retryDelivery("admin"))(),
    ).rejects.toThrow("delivery_uncertain");
  });
  it("returns structured errors from DO validation through RPC", async () => {
    const { id } = await account(false);
    const response = await gateway("/api/application-token", "POST", {
      cookie: await browser(id),
      Origin: "https://genaicommunity.ai",
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("consent");
  });
  it("denies unconfigured OAuth and replayed callbacks", async () => {
    expect((await gateway("/auth/linkedin")).status).toBe(503);
    expect(
      (await gateway("/auth/linkedin/callback?state=fake&code=fake")).status,
    ).toBe(400);
  });
});

describe("submission recovery and approval decisions", () => {
  it("website and bearer submissions save identical data and reject conflicting retries", async () => {
    const a = await account(),
      b = await account();
    await a.agent.consent();
    await b.agent.consent();
    for (const current of [a, b])
      await runInDurableObject(current.agent, async (instance) => {
        vi.spyOn(instance, "ensureWorkflow").mockResolvedValue(undefined);
      });
    const { token } = await b.agent.token();
    const cookie = await browser(a.id);
    const browserHeaders = {
      cookie,
      Origin: "https://genaicommunity.ai",
      "Idempotency-Key": "browser-key",
    };
    const tokenHeaders = {
      Authorization: `Bearer ${token}`,
      "Idempotency-Key": "agent-key",
    };
    expect(
      (await gateway("/api/v1/application", "POST", browserHeaders, sample))
        .status,
    ).toBe(202);
    expect(
      (await gateway("/api/v1/application", "POST", tokenHeaders, sample))
        .status,
    ).toBe(202);
    expect((await a.agent.inspect()).application).toEqual(
      (await b.agent.inspect()).application,
    );
    expect(
      (await gateway("/api/v1/application", "POST", tokenHeaders, sample))
        .status,
    ).toBe(202);
    expect(
      (
        await gateway("/api/v1/application", "POST", tokenHeaders, {
          ...sample,
          role: "Different role",
        })
      ).status,
    ).toBe(409);
    expect(
      (await b.agent.inspect()).history.filter((h) => h.event === "submitted"),
    ).toHaveLength(1);
  });
  it("rejects a token revoked between authentication and submission", async () => {
    const { agent } = await account();
    await agent.consent();
    const { token } = await agent.token();
    await agent.revoke();
    await expect(
      (async () =>
        await agent.submit(sample, "revoked-key", await digest(token)))(),
    ).rejects.toThrow("invalid_token");
  });
  it("a completed submission is recoverable after dispatch failure", async () => {
    const { agent } = await account();
    await agent.consent();
    await runInDurableObject(agent, async (instance) => {
      vi.spyOn(instance, "ensureWorkflow")
        .mockRejectedValueOnce(new Error("Dispatch interrupted"))
        .mockResolvedValue(undefined);
    });
    await expect(
      (async () => await agent.submit(sample, "recovery-key"))(),
    ).rejects.toThrow("Dispatch interrupted");
    expect((await agent.inspect()).application).toEqual(sample);
    await agent.submit(sample, "recovery-key");
    expect(
      (await agent.inspect()).history.filter((h) => h.event === "submitted"),
    ).toHaveLength(1);
  });
  it("agent auto-approves concrete work and fails closed on model outages", async () => {
    const { agent } = await account();
    await runInDurableObject(agent, async (instance) => {
      instance.setState({
        ...instance.state,
        application: sample,
        status: "submitted",
      });
      const bindings = instance["env"];
      bindings.AUTO_APPROVALS_ENABLED = "true";
      vi.spyOn(bindings.AI, "run").mockResolvedValue({
        response: JSON.stringify({
          student: {status:"not_student" as const,roleEvidence:sample.role,exceptional:false,exceptionalEvidence:[]},
      relevant: true,
          concrete: true,
          contribution: true,
          uncertain: false,
          reasons: "Concrete personal AI contribution",
          evidence: [sample.project],
        }),
      });
      await instance.assess();
    });
    expect((await agent.inspect()).status).toBe("approved");
    const other = await account();
    await runInDurableObject(other.agent, async (instance) => {
      instance.setState({
        ...instance.state,
        application: sample,
        status: "submitted",
      });
      vi.spyOn(instance["env"].AI, "run").mockRejectedValue(
        new Error("Model unavailable"),
      );
      await instance.assess();
    });
    expect((await other.agent.inspect()).status).toBe("review");
  });
  it("shows enrichment state to the applicant without exposing lookup internals", async () => {
    const { agent } = await account();
    await agent.consent();
    const state = await agent.setEnrichmentUrl("https://www.linkedin.com/in/builder");
    expect(state.enrichment).toMatchObject({ status: "pending", source: "linkedin" });
    expect(state.enrichment).not.toHaveProperty("lookupValue");
    await agent.enrich();
    expect((await agent.publicState()).enrichment.status).toBe("unavailable");
  });
  it("passes completed enrichment to the application review model", async () => {
    const { agent } = await account();
    await runInDurableObject(agent, async (instance) => {
      instance.setState({ ...instance.state, application: sample, status: "submitted",
        enrichment: { status: "matched", source: "linkedin", lookupValue: sample.linkedinUrl,
          data: { name: "Test applicant", title: "Researcher", location: null,
            company: "Example AI", school: null, degree: null }, updatedAt: Date.now() } });
      const run = vi.spyOn(instance["env"].AI, "run").mockResolvedValue({
        response: JSON.stringify({ relevant: false, concrete: false, contribution: false,
          uncertain: true, reasons: "Needs review", evidence: [sample.project], paper: null }),
      });
      await instance.assess();
      const request = run.mock.calls.at(-1)![1] as { messages: Array<{ role: string; content: string }> };
      const supplied = JSON.parse(request.messages.find((message) => message.role === "user")!.content);
      expect(supplied.externalEnrichment).toMatchObject({ name: "Test applicant", company: "Example AI" });
      expect(supplied.application).toMatchObject({ role: sample.role, project: sample.project, contribution: sample.contribution, motivation: sample.motivation });
    });
  });
  it("accepts structured JSON model output and only reassesses undecided review cases", async () => {
    const { agent } = await account();
    await runInDurableObject(agent, async (instance) => {
      instance.setState({
        ...instance.state,
        application: sample,
        status: "review",
      });
      instance["env"].AUTO_APPROVALS_ENABLED = "true";
      const assessment = {
        student: {status:"not_student" as const,roleEvidence:sample.role,exceptional:false,exceptionalEvidence:[]},
      relevant: true,
        concrete: true,
        contribution: true,
        uncertain: false,
        reasons: "Concrete work",
        evidence: [sample.project],
      };
      const run = vi
        .spyOn(instance["env"].AI, "run")
        .mockResolvedValue({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(assessment) } }] } as never)
        .mockClear();
      await instance.reassess("admin");
      expect(instance.state.status).toBe("approved");
      expect(instance.state.assessment).toEqual(assessment);
      expect(JSON.stringify(run.mock.calls[0][1])).not.toContain(sample.whatsapp);
      expect(run.mock.calls[0][1]).toHaveProperty(
        "response_format.type",
        "json_schema",
      );
      await expect(instance.reassess("admin")).rejects.toThrow(
        "assessment_conflict",
      );
    });
  });
  it("refreshes draft email only from a validated provider identity and revokes old tokens", async () => {
    const { id, agent } = await account();
    await agent.consent();
    const { token } = await agent.token();
    const original = (await agent.inspect()).profile!;
    await agent.identify({
      ...original,
      email: "updated@example.com",
      emailVerified: true,
    });
    expect((await agent.inspect()).profile?.email).toBe("updated@example.com");
    expect(await agent.authorizeToken(await digest(token))).toBe(false);
    expect(
      (
        await gateway(
          "/api/application-email",
          "POST",
          { Cookie: await browser(id), Origin: env.SITE_URL },
          { email: "attacker@example.com" },
        )
      ).status,
    ).toBe(404);
  });
  it("sends one escaped submitted copy to the LinkedIn email without an invitation", async () => {
    const { agent } = await account();
    await runInDurableObject(agent, async (instance) => {
      instance.setState({
        ...instance.state,
        application: {
          ...sample,
          project: sample.project + " <script>alert(1)</script>",
        },
        status: "submitted",
      });
      instance["env"].EMAIL_ENABLED = "true";
      const send = vi
        .spyOn(instance["env"].EMAIL, "send")
        .mockResolvedValue({ messageId: "receipt-test" });
      await Promise.all([instance.deliverReceipt(), instance.deliverReceipt()]);
      expect(send).toHaveBeenCalledTimes(1);
      const email = send.mock.calls[0][0] as {
        to: string;
        text: string;
        html: string;
      };
      expect(email.to).toBe("applicant@example.com");
      expect(email.text).toContain(sample.project);
      expect(email.text).toContain(sample.contribution);
      expect(email.text).toContain(sample.whatsapp);
      expect(email.html).toContain(sample.whatsapp);
      expect(email.html).toContain("&lt;script&gt;");
      expect(email.html).not.toContain("<script>");
      expect(email.text).not.toContain("chat.whatsapp.com");
      expect(instance.state.receipt?.status).toBe("accepted");
      expect(instance.state.delivery.status).toBe("pending");
    });
  });
  it("does not blindly resend a receipt after an ambiguous send or recovered in-flight send", async () => {
    const { agent } = await account();
    await runInDurableObject(agent, async (instance) => {
      instance.setState({
        ...instance.state,
        application: sample,
        status: "review",
      });
      instance["env"].EMAIL_ENABLED = "true";
      const send = vi
        .spyOn(instance["env"].EMAIL, "send")
        .mockRejectedValue(new Error("connection lost"))
        .mockClear();
      await instance.deliverReceipt();
      await instance.deliverReceipt();
      expect(send).toHaveBeenCalledTimes(1);
      expect(instance.state.receipt?.status).toBe("uncertain");
      instance.setState({
        ...instance.state,
        receipt: { status: "sending", attempts: 1 },
      });
      await instance.deliverReceipt();
      expect(send).toHaveBeenCalledTimes(1);
      expect(instance.state.receipt?.status).toBe("uncertain");
    });
  });
  it("accepted email is sent once and a manual reconciliation can unblock a known non-send", async () => {
    const { agent } = await account();
    let sends = 0;
    await runInDurableObject(agent, async (instance) => {
      instance.setState({ ...instance.state, status: "approved" });
      instance["env"].EMAIL_ENABLED = "true";
      instance["env"].WHATSAPP_INVITE_URL =
        "https://chat.whatsapp.com/TestInvite";
      vi.spyOn(instance["env"].EMAIL, "send").mockImplementation(async () => {
        sends++;
        return { messageId: "test-message" };
      });
      await instance.deliver();
      await instance.deliver();
      expect(sends).toBe(1);
    });
    expect((await agent.inspect()).delivery.status).toBe("accepted");
  });
});

it("dispatches a real AgentWorkflow and persists its assessment", async () => {
  const { agent } = await account();
  await agent.consent();
  await runInDurableObject(agent, async (instance) => {
    instance["env"].AUTO_APPROVALS_ENABLED = "false";
    instance["env"].EMAIL_ENABLED = "false";
    vi.spyOn(instance["env"].AI, "run").mockResolvedValue({
      response: JSON.stringify({
        student: {status:"not_student" as const,roleEvidence:sample.role,exceptional:false,exceptionalEvidence:[]},
      relevant: true,
        concrete: true,
        contribution: true,
        uncertain: false,
        reasons: "Concrete AI project",
        evidence: [sample.project],
      }),
    });
  });
  await agent.submit(sample, "workflow-dispatch");
  await vi.waitFor(
    async () => expect((await agent.inspect()).status).toBe("review"),
    { timeout: 10000, interval: 100 },
  );
  expect((await agent.inspect()).assessment?.relevant).toBe(true);
});

it("validates signed LinkedIn callbacks and repeats failure cases without a personal account", async () => {
  const { generateKeyPair, exportJWK, SignJWT } = await import("jose");
  const keys = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "oidc-test",
    alg: "RS256",
    use: "sig",
  };
  env.LINKEDIN_CLIENT_ID = "test-client";
  env.LINKEDIN_CLIENT_SECRET = "test-client-secret";
  let signed = "";
  const mock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/jwks"))
        return new Response(JSON.stringify({ keys: [jwk] }), {
          headers: { "content-type": "application/json" },
        });
      if (url.endsWith("/accessToken"))
        return new Response(
          JSON.stringify({
            id_token: signed,
            access_token: "test-oauth-token",
          }),
          { headers: { "content-type": "application/json" } },
        );
      if (url.endsWith("/userinfo"))
        return new Response(
          JSON.stringify({
            sub: "oidc-applicant",
            name: "OIDC Applicant",
            email: "oidc@example.com",
            email_verified: true,
          }),
          { headers: { "content-type": "application/json" } },
        );
      throw new Error("Unexpected external request in OAuth test");
    });
  try {
    const begin = await gateway("/auth/linkedin");
    expect(begin.status).toBe(302);
    const location = new URL(begin.headers.get("Location")!);
    const state = location.searchParams.get("state")!;
    expect(location.searchParams.has("nonce")).toBe(false);
    signed = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "oidc-test" })
      .setSubject("oidc-applicant")
      .setIssuer("https://www.linkedin.com/oauth")
      .setAudience("test-client")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);
    const headers = { cookie: `__Host-ga-oauth=${state}` };
    const callback = await gateway(
      `/auth/linkedin/callback?state=${state}&code=test-code`,
      "GET",
      headers,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("set-cookie")).toContain("__Host-ga-session=");
    const session = callback.headers
      .get("set-cookie")!
      .match(/__Host-ga-session=([a-f0-9]+)/)![1];
    const accountResponse = await gateway("/api/v1/application", "GET", {
      cookie: `__Host-ga-session=${session}`,
    });
    expect((await accountResponse.json()).profile.emailVerified).toBe(true);
    expect(
      (
        await gateway(
          `/auth/linkedin/callback?state=${state}&code=test-code`,
          "GET",
          headers,
        )
      ).status,
    ).toBe(400);
    // Exercise the real JWT/state/session implementation. Only provider network
    // responses are synthetic; no production test-login endpoint is introduced.
    const forgedKeys = await generateKeyPair("RS256");
    const invalidCases = [
      { name: "wrong audience", audience: "wrong-client" },
      { name: "wrong issuer", issuer: "https://example.com" },
      { name: "legacy request nonce mismatch", nonce: "wrong-nonce" },
      { name: "obsolete issuer", issuer: "https://www.linkedin.com" },
      { name: "expired token", expiry: "-1m" },
      { name: "mismatched profile", subject: "another-account" },
      { name: "forged signature", key: forgedKeys.privateKey },
    ];
    for (const scenario of invalidCases) {
      const next = await gateway("/auth/linkedin");
      const nextLocation = new URL(next.headers.get("Location")!);
      const nextState = nextLocation.searchParams.get("state")!;
      if (scenario.nonce) {
        await env.INDEX.prepare("UPDATE oauth_states SET nonce=? WHERE hash=?")
          .bind("legacy-request-nonce", await digest(nextState))
          .run();
      }
      signed = await new SignJWT(
        scenario.nonce ? { nonce: scenario.nonce } : {},
      )
        .setProtectedHeader({ alg: "RS256", kid: "oidc-test" })
        .setSubject(scenario.subject ?? "oidc-applicant")
        .setIssuer(scenario.issuer ?? "https://www.linkedin.com/oauth")
        .setAudience(scenario.audience ?? "test-client")
        .setIssuedAt()
        .setExpirationTime(scenario.expiry ?? "5m")
        .sign(scenario.key ?? keys.privateKey);
      const failed = await gateway(
        `/auth/linkedin/callback?state=${nextState}&code=test-code`,
        "GET",
        { cookie: `__Host-ga-oauth=${nextState}` },
      );
      expect(failed.status, scenario.name).toBe(400);
      expect(
        failed.headers.get("set-cookie") ?? "",
        scenario.name,
      ).not.toContain("__Host-ga-session=");
    }
    const cancelled = await gateway("/auth/linkedin");
    const cancelledState = new URL(
      cancelled.headers.get("Location")!,
    ).searchParams.get("state")!;
    const cancelledResponse = await gateway(
      `/auth/linkedin/callback?state=${cancelledState}&error=access_denied`,
      "GET",
      { cookie: `__Host-ga-oauth=${cancelledState}` },
    );
    expect(cancelledResponse.status).toBe(302);
    expect(cancelledResponse.headers.get("Location")).toBe(
      "https://genaicommunity.ai/apply?signin=cancelled",
    );
    expect(cancelledResponse.headers.get("set-cookie")).not.toContain(
      "__Host-ga-session=",
    );
    expect(
      (
        await gateway(
          "/auth/linkedin/callback?state=invalid&code=test-code",
          "GET",
          {
            cookie: "__Host-ga-oauth=another-state",
          },
        )
      ).status,
    ).toBe(400);
  } finally {
    mock.mockRestore();
    env.LINKEDIN_CLIENT_ID = "";
    env.LINKEDIN_CLIENT_SECRET = "";
  }
});

it("returns failed browser callbacks to a safe retry page without exposing codes", async () => {
  const response = await gateway(
    "/auth/linkedin/callback?state=invalid&code=must-not-be-reflected",
    "GET",
    { accept: "text/html", cookie: "__Host-ga-oauth=different" },
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(
    "https://genaicommunity.ai/apply?signin=failed",
  );
  expect(response.headers.get("set-cookie")).toContain("__Host-ga-oauth=; ");
  expect(response.headers.get("set-cookie")).not.toContain(
    "__Host-ga-session=",
  );
  expect(await response.text()).not.toContain("must-not-be-reflected");
});

describe("agent bug reports", () => {
  it("stores scoped plain text, deduplicates retries, rejects changed keys and oversized reports", async () => {
    const { agent } = await account();
    await agent.consent();
    const { token } = await agent.token();
    const send = (text: string, key = "bug-smoke-123", type = "text/plain") =>
      new AdmissionsGateway(createExecutionContext(), env).fetch(
        new Request("https://genaicommunity.ai/api/v1/bug-report", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": type,
            "Idempotency-Key": key,
          },
          body: text,
        }),
      );
    const content =
      "The token copy button did not provide feedback. Expected a confirmation message after copying.";
    const first = await send(content);
    expect(first.status).toBe(201);
    const saved = await first.json();
    const retry = await send(content);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(saved);
    expect((await send("Different report")).status).toBe(409);
    expect((await send("word ".repeat(201), "too-many-words")).status).toBe(
      422,
    );
    expect((await send("x".repeat(8001), "too-many-bytes")).status).toBe(413);
    expect(
      (await send("{}", "wrong-content-type", "application/json")).status,
    ).toBe(415);
    expect((await send("word ".repeat(200), "allowed-word-count")).status).toBe(
      201,
    );
    expect((await agent.inspect()).application).toBeNull();
    await agent.revoke();
    expect(
      (await send("Revoked token report", "revoked-token-report")).status,
    ).toBe(401);
  });
});

describe("administrator invitations", () => {
  it("restricts creation, requires matching email acceptance, and revokes existing sessions", async () => {
    const owner = await account(true, crypto.randomUUID(), "owner@example.com");
    const recipient = await account(true, crypto.randomUUID(), "invited@example.com");
    const stranger = await account();
    const previous = env.ADMIN_EMAILS, emailEnabled = env.EMAIL_ENABLED;
    env.ADMIN_EMAILS = "owner@example.com"; env.EMAIL_ENABLED = "true";
    const send = vi.spyOn(env.EMAIL, "send").mockResolvedValue({messageId:"test-admin-invite"} as never).mockClear();
    const headers = {Cookie: await browser(owner.id), Origin:"https://genaicommunity.ai"};
    const recipientHeaders = {Cookie:await browser(recipient.id), Origin:headers.Origin};
    try {
      expect((await gateway("/api/admin/invitations", "POST", {Cookie: await browser(stranger.id), Origin:headers.Origin}, {email:"invited@example.com"})).status).toBe(403);
      expect((await gateway("/api/admin/invitations", "POST", {Cookie:headers.Cookie}, {email:"invited@example.com"})).status).toBe(403);
      const created = await gateway("/api/admin/invitations", "POST", headers, {email:"INVITED@example.com"});
      expect(created.status).toBe(201);
      const invite = await created.json() as {id:string;delivery:string};
      expect(invite.delivery).toBe("accepted");
      expect(send.mock.calls.filter(([message]) => message.to === "invited@example.com" && message.subject === "Invitation to administer GenerativeAI Community")).toHaveLength(1);
      expect((await gateway("/api/admin/invitations", "POST", headers, {email:"invited@example.com"})).status).toBe(409);
      expect(send.mock.calls.filter(([message]) => message.to === "invited@example.com" && message.subject === "Invitation to administer GenerativeAI Community")).toHaveLength(1);
      expect((await gateway("/api/admin/access", "GET", recipientHeaders)).status).toBe(403);
      expect((await gateway("/api/admin-invitation", "POST", {Cookie: await browser(stranger.id), Origin:headers.Origin})).status).toBe(409);
      expect((await gateway("/api/admin-invitation", "POST", recipientHeaders)).status).toBe(200);
      expect((await gateway("/api/admin/access", "GET", recipientHeaders)).status).toBe(200);
      expect((await gateway(`/api/admin/invitations/${invite.id}`, "DELETE", headers)).status).toBe(200);
      expect((await gateway("/api/admin/access", "GET", recipientHeaders)).status).toBe(403);
    } finally { env.ADMIN_EMAILS=previous; env.EMAIL_ENABLED=emailEnabled; send.mockRestore(); }
  });
  it("refuses expired invitations and bearer acceptance", async () => {
    const recipient = await account(true, crypto.randomUUID(), "expired@example.com");
    await env.INDEX.prepare("INSERT INTO administrator_invites(id,email,invited_by,created_at,expires_at) VALUES(?,?,?,?,?)").bind(crypto.randomUUID(), "expired@example.com", "test", 1, 2).run();
    expect((await gateway("/api/admin-invitation", "POST", {Cookie:await browser(recipient.id), Origin:"https://genaicommunity.ai"})).status).toBe(409);
    await recipient.agent.consent(); const {token}=await recipient.agent.token();
    expect((await gateway("/api/admin-invitation", "POST", {Authorization:`Bearer ${token}`, Origin:"https://genaicommunity.ai"})).status).toBe(403);
  });
  it("approves immediately with an audit reason but requires a decline reason", async () => {
    const owner=await account(); const previous=env.ADMIN_EMAILS; env.ADMIN_EMAILS="applicant@example.com";
    const headers={Cookie:await browser(owner.id), Origin:"https://genaicommunity.ai"};
    await runInDurableObject(owner.agent, async instance => { instance.setState({...instance.state, application:sample, status:"review"}); });
    try {
      expect((await gateway(`/api/admin/applications/${owner.id}/decision`, "POST", headers, {action:"decline"})).status).toBe(422);
      expect((await gateway(`/api/admin/applications/${owner.id}/decision`, "POST", headers, {action:"approve"})).status).toBe(200);
      expect((await owner.agent.inspect()).decision?.reason).toBe("Approved by administrator.");
      expect((await gateway(`/api/admin/applications/${owner.id}/decision`, "POST", headers, {action:"approve"})).status).toBe(409);
    } finally {env.ADMIN_EMAILS=previous;}
  });
});

it("qualifies explicit company affiliations with conservative one-year dates", () => {
  const now=Date.parse("2026-09-16T12:00:00Z");
  for (const company of ["Dashverse","Frameo","Lossfunk","OpenAI","Anthropic","ElevenLabs","Cartesia"] as const) {
    const role=`Engineer at ${company}`;
    const a={student:{status:"not_student" as const,roleEvidence:role,exceptional:false,exceptionalEvidence:[]},relevant:false,concrete:false,contribution:false,uncertain:false,reasons:"Affiliation",evidence:[sample.project],affiliation:{company,current:true,endedOn:null,evidence:role}};
    expect(qualifies(a,{...sample,role},now)).toBe(true);
    expect(qualifies({...a,uncertain:true},{...sample,role},now)).toBe(false);
    expect(qualifies(a,sample,now)).toBe(false);
    const globalCompany=["OpenAI","Anthropic","ElevenLabs","Cartesia"].includes(company);
    expect(qualifies({...a,affiliation:{...a.affiliation,current:false,endedOn:"2025-09-16"}},{...sample,role},now)).toBe(globalCompany);
    for (const endedOn of ["2025-09-15","2027-01-01","2026-02-30",null]) expect(qualifies({...a,affiliation:{...a.affiliation,current:false,endedOn}},{...sample,role},now)).toBe(false);
  }
});

it("normalizes WhatsApp tracking parameters but rejects unrelated invite hosts", () => {
  expect(whatsappInvite("https://chat.whatsapp.com/Example123?s=cl&p=i")).toBe("https://chat.whatsapp.com/Example123");
  expect(whatsappInvite("https://chat.whatsapp.com.evil.example/Example123")).toBeNull();
  expect(whatsappInvite("https://user@chat.whatsapp.com/Example123")).toBeNull();
});

describe("student policy", () => {
  const application={...sample,role:"University student"};
  const assessment={student:{status:"student" as const,roleEvidence:"University student",exceptional:false,exceptionalEvidence:[] as string[]}, relevant:true,concrete:true,contribution:true,uncertain:false,reasons:"Coursework does not demonstrate exceptional original work",evidence:[sample.project]};
  it("declines ordinary students but permits exceptional work and approved affiliations", () => {
    expect(rejectStudent(assessment,application)).toBe(true);
    expect(qualifies(assessment,application)).toBe(false);
    const exceptional={...assessment,student:{...assessment.student,exceptional:true,exceptionalEvidence:[sample.contribution]}};
    expect(qualifies(exceptional,application)).toBe(true);
    expect(rejectStudent(exceptional,application)).toBe(false);
    expect(qualifies({...exceptional,student:{...exceptional.student,exceptionalEvidence:["invented exceptional achievement"]}},application)).toBe(false);
    expect(rejectStudent({...assessment,uncertain:true},application)).toBe(false);
    expect(rejectStudent({...assessment,student:{...assessment.student,roleEvidence:"Invented student classification"}},application)).toBe(false);
    const role="University student and engineer at Dashverse";
    const affiliated={...assessment,student:{...assessment.student,roleEvidence:role},affiliation:{company:"Dashverse" as const,current:true,endedOn:null,evidence:role}};
    expect(qualifies(affiliated,{...application,role})).toBe(true);
    expect(rejectStudent(affiliated,{...application,role})).toBe(false);
    expect(assessmentSchema.safeParse({...assessment,student:undefined}).success).toBe(false);
  });
  it("records automatic student rejection without dispatching an approval invitation", async () => {
    const {agent}=await account();
    await runInDurableObject(agent,async instance=>{
      instance.setState({...instance.state,application,status:"submitted",submissionChannel:"agent"});
      instance["env"].AUTO_APPROVALS_ENABLED="true";
      const run=vi.spyOn(instance["env"].AI,"run").mockResolvedValue({response:assessment} as never);
      try {
        await instance.assess();
        expect(instance.state.status).toBe("declined");
        expect(instance.state.decision?.actor).toBe("agent");
        expect(instance.state.delivery.attempts).toBe(0);
        expect((await instance.publicState()).appeal.eligible).toBe(true);
      } finally {run.mockRestore();}
    });
  });
});

describe("appeals", () => {
  const evidence={explanation:"I built and deployed an original tool, and can explain its architecture, evaluation methods, and the code I personally contributed."};
  async function rejected(channel?: "agent" | "form") {
    const owner=await account();
    await owner.agent.consent();
    const {token}=await owner.agent.token();
    await runInDurableObject(owner.agent,async instance=>{instance.setState({...instance.state,application:sample,submissionChannel:channel,status:"declined",decision:{actor:"agent",reason:"Insufficient work evidence",at:Date.now()}});});
    return {...owner,token};
  }
  it("rejects form and legacy appeals even after a token is issued",async()=>{
    for(const channel of ["form",undefined] as const){
      const {token}=await rejected(channel);
      expect((await gateway("/api/v1/appeal","POST",{Authorization:`Bearer ${token}`,"Idempotency-Key":"appeal-ineligible"},evidence)).status).toBe(403);
    }
  });
  it("validates evidence, enforces scope/idempotency, and retains the entire resolution",async()=>{
    const {agent,token,id}=await rejected("agent");
    const headers={Authorization:`Bearer ${token}`,"Idempotency-Key":"appeal-evidence-1"};
    expect((await gateway("/api/v1/appeal","POST",headers,{})).status).toBe(422);
    expect((await gateway("/api/v1/appeal","POST",headers,{proofUrl:"javascript:alert(1)"})).status).toBe(422);
    expect((await gateway("/api/v1/appeal","POST",headers,{proofUrl:"not-a-url"})).status).toBe(422);
    expect((await gateway("/api/v1/appeal","POST",headers,{...evidence,accountId:"another-account"})).status).toBe(422);
    expect((await gateway("/api/v1/appeal","POST",headers,evidence)).status).toBe(202);
    expect((await gateway("/api/v1/appeal","POST",headers,evidence)).status).toBe(202);
    expect((await gateway("/api/v1/appeal","POST",headers,{voucher:"A known member can vouch for this project."})).status).toBe(409);
    expect((await gateway("/api/v1/appeal","POST",{...headers,"Idempotency-Key":"appeal-evidence-2"},evidence)).status).toBe(409);
    let state=await agent.inspect();
    expect(state.status).toBe("review");
    expect(state.appeals).toHaveLength(1);
    expect(state.appeals?.[0].previousDecision.reason).toBe("Insufficient work evidence");
    expect(state.appeals?.[0].evidence).toEqual(evidence);
    expect((await env.INDEX.prepare("SELECT appeal_status FROM applications WHERE id=?").bind(id).first())?.appeal_status).toBe("pending");
    const previousAdmins=env.ADMIN_EMAILS; env.ADMIN_EMAILS="applicant@example.com";
    try { expect((await gateway(`/api/admin/applications/${id}/reassess`,"POST",{Cookie:await browser(id),Origin:"https://genaicommunity.ai"},{})).status).toBe(409); }
    finally { env.ADMIN_EMAILS=previousAdmins; }
    await agent.decide("approve","Reviewed work and confirmed personal contribution","admin");
    state=await agent.inspect();
    expect(state.appeals?.[0].resolution?.action).toBe("approve");
    expect(state.appeals?.[0].resolution?.actor).toBe("admin");
    expect((await agent.publicState()).appeal.eligible).toBe(false);
    expect(state.application).toEqual(sample);
    await agent.revoke();
    expect((await gateway("/api/v1/appeal","POST",headers,evidence)).status).toBe(401);
  });
  it("permits browser appeals only for agent-origin applications and requires CSRF",async()=>{
    const {agent,id}=await rejected("agent");
    const headers={Cookie:await browser(id),"Idempotency-Key":"browser-appeal-1"};
    expect((await gateway("/api/v1/appeal","POST",headers,evidence)).status).toBe(403);
    expect((await gateway("/api/v1/appeal","POST",{...headers,Origin:"https://genaicommunity.ai"},evidence)).status).toBe(202);
    await agent.decide("decline","Evidence remains insufficient after manual review","admin");
    expect((await gateway("/api/v1/appeal","POST",{...headers,Origin:"https://genaicommunity.ai","Idempotency-Key":"browser-appeal-2"},evidence)).status).toBe(409);
  });
  it("records first submission provenance and does not change it on a bearer replay",async()=>{
    const {agent}=await account();await agent.consent();
    await agent.submit(sample,"original-browser-application");
    const {token}=await agent.token();
    await agent.submit(sample,"replayed-via-agent",await digest(token));
    expect((await agent.inspect()).submissionChannel).toBe("form");
    const other=await account();await other.agent.consent();const access=await other.agent.token();
    await other.agent.submit(sample,"original-agent-application",await digest(access.token));
    expect((await other.agent.inspect()).submissionChannel).toBe("agent");
  });
});

it("requires a country-coded WhatsApp number and normalizes formatting", () => {
  expect(applicationSchema.parse({...sample,whatsapp:"+1 (415) 555-2671"}).whatsapp).toBe("+14155552671");
  for(const whatsapp of [undefined,"", "4155552671", "+0123456789", "+123", "+1234567890123456", "+1415abc2671"]) expect(applicationSchema.safeParse({...sample,whatsapp}).success).toBe(false);
});

it("preserves identical legacy retries without allowing a new application to omit WhatsApp", async () => {
  const {agent}=await account(); await agent.consent();
  const {whatsapp, ...legacy}=sample;
  await runInDurableObject(agent, async instance => {
    instance.setState({...instance.state,application:legacy as typeof sample,payloadHash:await digest(JSON.stringify(legacy)),status:"review"});
    const result=await instance.submit(legacy,"legacy-retry-1");
    expect(result.application).toEqual(legacy);
    expect(instance.state.application?.whatsapp).toBeUndefined();
  });
});

describe("member chat archive",()=>{
  async function member(status:"approved"|"review"|"declined"|"draft"="approved") {
    const owner=await account();await owner.agent.consent();const {token}=await owner.agent.token();
    await runInDurableObject(owner.agent,async instance=>{instance.setState({...instance.state,status});});
    return {...owner,headers:{Authorization:`Bearer ${token}`}};
  }
  async function group(published=true) {
    const id=await digest(crypto.randomUUID());
    await env.INDEX.prepare("INSERT INTO chat_groups(id,title,source_ref,published,imported_at,coverage_note) VALUES(?,?,?,?,?,?)").bind(id,"Example community group","private-source-"+id,published?1:0,Date.now(),"Available synced history").run();
    return id;
  }
  async function message(groupId:string,text:string,at=Date.parse("2026-01-01")) {
    const id=await digest(crypto.randomUUID());
    await env.INDEX.prepare("INSERT INTO chat_messages(id,group_id,source_id,posted_at,author,body) VALUES(?,?,?,?,?,?)").bind(id,groupId,"source-"+id,at,"Example member",text).run();
    await env.INDEX.prepare("INSERT INTO chat_search(rowid,body,author) SELECT rowid,body,author FROM chat_messages WHERE id=?").bind(id).run();
    return id;
  }
  it("allows approved browser/token reads and denies other states and revoked tokens",async()=>{
    expect((await gateway("/api/v1/chats/groups")).status).toBe(401);
    for(const status of ["draft","review","declined"] as const) {
      const owner=await member(status);
      expect((await gateway("/api/v1/chats/groups","GET",owner.headers)).status).toBe(403);
    }
    const owner=await member();
    expect((await gateway("/api/v1/chats/groups","GET",owner.headers)).status).toBe(200);
    expect((await gateway("/api/v1/chats/groups","GET",{Cookie:await browser(owner.id)})).status).toBe(200);
    expect((await gateway("/api/admin/chats/groups","GET",owner.headers)).status).toBe(403);
    await runInDurableObject(owner.agent,async instance=>{instance.setState({...instance.state,status:"declined"});});
    expect((await gateway("/api/v1/chats/groups","GET",owner.headers)).status).toBe(403);
    await owner.agent.revoke();
    expect((await gateway("/api/v1/chats/groups","GET",owner.headers)).status).toBe(401);
  });
  it("searches full text with group/date filters and stable pagination",async()=>{
    const owner=await member(), id=await group();
    const first=await message(id,"Retrieval evaluation uses a measured baseline.",Date.parse("2026-01-01"));
    const second=await message(id,"Retrieval evaluation needs realistic questions.",Date.parse("2026-01-02"));
    await message(id,"Voice agents use streaming audio.",Date.parse("2026-01-03"));
    const path=`/api/v1/chats/search?q=retrieval%20evaluation&group=${id}&limit=1`;
    const result=await (await gateway(path,"GET",owner.headers)).json() as any;
    expect(result.messages.map((m:any)=>m.id)).toEqual([second]);
    expect(result.nextCursor).toBeTruthy();
    const next=await (await gateway(path+"&cursor="+encodeURIComponent(result.nextCursor),"GET",owner.headers)).json() as any;
    expect(next.messages.map((m:any)=>m.id)).toEqual([first]);
    expect(next.nextCursor).toBeNull();
    const dated=await (await gateway(`/api/v1/chats/search?group=${id}&from=2026-01-02&to=2026-01-02`,"GET",owner.headers)).json() as any;
    expect(dated.messages.map((m:any)=>m.id)).toEqual([second]);
    expect((await gateway(path+"&from=2026-01-02&cursor="+encodeURIComponent(result.nextCursor),"GET",owner.headers)).status).toBe(400);
    expect((await gateway("/api/v1/chats/search?cursor=broken","GET",owner.headers)).status).toBe(400);
    expect((await gateway("/api/v1/chats/search?q=%22%27","GET",owner.headers)).status).toBe(422);
    expect((await gateway("/api/v1/chats/search?from=2026-02-30","GET",owner.headers)).status).toBe(422);
  });
  it("never exposes unpublished groups and keeps context inside the selected group",async()=>{
    const owner=await member(), visible=await group(), privateGroup=await group(false);
    const first=await message(visible,"Visible earlier context",1000);
    const selected=await message(visible,"Visible selected message",2000);
    const hidden=await message(privateGroup,"Private moderator message",1500);
    const context=await (await gateway(`/api/v1/chats/messages/${selected}`,"GET",owner.headers)).json() as any;
    expect(context.before.map((m:any)=>m.id)).toEqual([first]);
    expect(JSON.stringify(context)).not.toContain(hidden);
    expect((await gateway(`/api/v1/chats/messages/${hidden}`,"GET",owner.headers)).status).toBe(404);
    const groups=await (await gateway("/api/v1/chats/groups","GET",owner.headers)).json() as any;
    expect(groups.groups.some((g:any)=>g.id===privateGroup)).toBe(false);
    expect(JSON.stringify(groups)).not.toContain("private-source-");
  });
  it("unpublishes groups and hides messages through browser-only, CSRF-protected admin actions",async()=>{
    const owner=await member(), id=await group(), msg=await message(id,"Redactable archive text");
    const prior=env.ADMIN_EMAILS;env.ADMIN_EMAILS="applicant@example.com";
    const browserHeaders={Cookie:await browser(owner.id),Origin:"https://genaicommunity.ai"};
    try {
      expect((await gateway(`/api/admin/chats/messages/${msg}`,"DELETE",owner.headers)).status).toBe(403);
      expect((await gateway(`/api/admin/chats/messages/${msg}`,"DELETE",{Cookie:browserHeaders.Cookie})).status).toBe(403);
      expect((await gateway(`/api/admin/chats/messages/${msg}`,"DELETE",browserHeaders)).status).toBe(200);
      expect((await gateway(`/api/v1/chats/messages/${msg}`,"GET",owner.headers)).status).toBe(404);
      const found=await (await gateway(`/api/v1/chats/search?group=${id}&q=redactable`,"GET",owner.headers)).json() as any;
      expect(found.messages).toHaveLength(0);
      const other=await message(id,"Another visible message");
      expect((await gateway(`/api/admin/chats/groups/${id}`,"POST",browserHeaders,{published:false})).status).toBe(200);
      expect((await gateway(`/api/v1/chats/messages/${other}`,"GET",owner.headers)).status).toBe(404);
      expect((await gateway(`/api/admin/chats/messages/${other}`,"GET",browserHeaders)).status).toBe(200);
      const audit=await env.INDEX.prepare("SELECT action FROM chat_archive_actions WHERE target IN (?,?)").bind(msg,id).all();
      expect(audit.results).toHaveLength(2);
    } finally {env.ADMIN_EMAILS=prior;}
  });
});

describe("LinkedIn links and administrator grid metadata",()=>{
  it("requires a real LinkedIn profile URL and normalizes tracking parameters",()=>{
    expect(applicationSchema.parse({...sample,linkedinUrl:"https://in.linkedin.com/in/test-builder?trk=profile"}).linkedinUrl).toBe("https://www.linkedin.com/in/test-builder/");
    for(const linkedinUrl of [undefined,"javascript:alert(1)","https://linkedin.com.evil.test/in/name/","https://www.linkedin.com/company/example/","https://user@www.linkedin.com/in/name/","https://www.linkedin.com/in/a%2Fb/"]) {
      expect(applicationSchema.safeParse({...sample,linkedinUrl}).success).toBe(false);
    }
  });
  it("preserves accepted application retries that predate profile-link collection",async()=>{
    const owner=await account();await owner.agent.consent();
    const {linkedinUrl,...legacy}=sample;const hash=await digest(JSON.stringify(legacy));
    await runInDurableObject(owner.agent,async instance=>{instance.setState({...instance.state,application:legacy as any,payloadHash:hash,idempotencyKey:"legacy-link-test",status:"review"});});
    expect((await owner.agent.submit(legacy,"legacy-link-test")).status).toBe("review");
    expect((await gateway("/api/v1/application","POST",{Cookie:await browser(owner.id),Origin:"https://genaicommunity.ai","Idempotency-Key":"legacy-link-test"},sample)).status).toBe(409);
  });
  it("sorts approvals by decision date, restores old metadata, and filters other states",async()=>{
    const older=await account(),newer=await account(),pending=await account();
    for(const [owner,at,status] of [[older,1000,"approved"],[newer,2000,"approved"],[pending,3000,"review"]] as const) {
      await runInDurableObject(owner.agent,async instance=>{instance.setState({...instance.state,application:sample,status,submittedAt:500,decision:status==="approved"?{actor:"admin",reason:"Approved",at}:null});});
      await owner.agent.index();
    }
    await env.INDEX.prepare("UPDATE applications SET approved_at=NULL,linkedin_url=NULL,details_version=0,updated_at=999999 WHERE id=?").bind(older.id).run();
    const previous=env.ADMIN_EMAILS;env.ADMIN_EMAILS="applicant@example.com";
    try {
      const headers={Cookie:await browser(older.id)};
      const result=await (await gateway("/api/admin/applications?status=approved","GET",headers)).json() as any;
      expect(result.applications.filter((row:any)=>[newer.id,older.id].includes(row.id)).map((row:any)=>row.id)).toEqual([newer.id,older.id]);
      expect(result.applications.every((row:any)=>row.status==="approved")).toBe(true);
      expect(result.applications.find((row:any)=>row.id===older.id).approved_at).toBe(1000);
      expect(result.applications.find((row:any)=>row.id===older.id).linkedin_url).toBe(sample.linkedinUrl);

      const review=await (await gateway("/api/admin/applications?status=review","GET",headers)).json() as any;
      expect(review.applications.map((row:any)=>row.id)).toContain(pending.id);
      expect(review.applications.every((row:any)=>row.status==="review")).toBe(true);
      expect((await gateway("/api/admin/applications?status=invalid","GET",headers)).status).toBe(422);
    } finally {env.ADMIN_EMAILS=previous;}
  });
});
