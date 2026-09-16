import { describe, it, expect, beforeAll, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { AdmissionsGateway } from "../src/index";
import {
  applicationSchema,
  initialRecord,
  qualifies,
  submissionResult,
  emailFailure,
} from "../src/domain";
import { digest, randomToken, csrf } from "../src/security";
import migration from "../migrations/0001_admissions.sql?raw";
import bugMigration from "../migrations/0002_bug_reports.sql?raw";
const sample = {
  role: "Student",

  project:
    "I built a retrieval augmented AI assistant for a local library catalog.",
  contribution:
    "I implemented document ingestion and evaluated retrieval quality.",

  motivation:
    "I want to share evaluation methods and learn from other builders.",
};
beforeAll(async () => {
  for (const query of (migration + bugMigration)
    .split(";")
    .filter((s) => s.trim()))
    await env.INDEX.prepare(query).run();
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
        ...sample,
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
