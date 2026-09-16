import { WorkerEntrypoint } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { createRemoteJWKSet, jwtVerify, errors } from "jose";
import { z } from "zod";
import {
  ApiError,
  body,
  cookie,
  csrf,
  digest,
  json,
  randomToken,
  sessionCookie,
} from "./security";
export { AdmissionAgent, AdmissionWorkflow } from "./agent";
const jwks = createRemoteJWKSet(
  new URL("https://www.linkedin.com/oauth/openid/jwks"),
);
const sessionName = "__Host-ga-session",
  oauthName = "__Host-ga-oauth";
const actor = (env: Env, id: string) => getAgentByName(env.ADMISSION, id);
async function limit(env: Env, key: string, max: number) {
  const bucket = Math.floor(Date.now() / 60000);
  const row = await env.INDEX.prepare(
    "INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
  )
    .bind(`${key}:${bucket}`, (bucket + 2) * 60000)
    .first<{ count: number }>();
  if (row && row.count > max)
    throw new ApiError(
      429,
      "rate_limited",
      "Too many requests. Try again in a minute.",
    );
}
async function authenticated(req: Request, env: Env, browserOnly = false) {
  const authorization = req.headers.get("authorization");
  if (authorization && browserOnly)
    throw new ApiError(
      403,
      "browser_required",
      "This action requires a browser session.",
    );
  const raw = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : cookie(req, sessionName);
  if (!raw || raw.length !== 64)
    throw new ApiError(
      401,
      "unauthorized",
      "Sign in with LinkedIn or supply a valid application token.",
    );
  const hash = await digest(raw),
    bearer = !!authorization;
  const row = await env.INDEX.prepare(
    `SELECT account_id,expires_at FROM ${bearer ? "tokens" : "sessions"} WHERE hash=?`,
  )
    .bind(hash)
    .first<{ account_id: string; expires_at: number }>();
  if (!row || row.expires_at <= Date.now())
    throw new ApiError(
      401,
      "expired_credentials",
      "Session or application token expired.",
    );
  const agent = await actor(env, row.account_id);
  if (bearer && !(await agent.authorizeToken(hash)))
    throw new ApiError(
      401,
      "invalid_token",
      "Application token expired or revoked.",
    );
  await limit(env, row.account_id, bearer ? 30 : 60);
  return { agent, id: row.account_id, hash, bearer };
}
async function admin(req: Request, env: Env) {
  const auth = await authenticated(req, env, true);
  const state = await auth.agent.publicState();
  if (
    !state.profile ||
    !(env.ADMIN_SUBJECTS ?? "").split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(state.profile.sub)
  )
    throw new ApiError(403, "forbidden", "Administrator access required.");
  return { ...auth, sub: state.profile.sub };
}
function redirect(url: string, cookies: string[] = []) {
  const headers = new Headers({
    Location: url,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url),
    path = url.pathname;
  if (path === "/auth/linkedin" && req.method === "GET") {
    if (!env.LINKEDIN_CLIENT_ID || !env.LINKEDIN_CLIENT_SECRET)
      throw new ApiError(
        503,
        "login_unconfigured",
        "LinkedIn sign-in is not configured yet.",
      );
    await limit(
      env,
      `login:${await digest(req.headers.get("cf-connecting-ip") ?? "unknown")}`,
      20,
    );
    // LinkedIn's confidential authorization-code flow uses one-use state.
    // Its discovery metadata/Auth.js provider do not advertise nonce checks.
    const state = randomToken();
    await env.INDEX.prepare(
      "INSERT INTO oauth_states(hash,nonce,verifier,expires_at) VALUES(?,?,?,?)",
    )
      .bind(await digest(state), "", "", Date.now() + 600000)
      .run();
    const authorize = new URL(
      "https://www.linkedin.com/oauth/v2/authorization",
    );
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: env.LINKEDIN_CLIENT_ID,
      redirect_uri: `${env.SITE_URL}/auth/linkedin/callback`,
      scope: "openid profile email",
      state,
    }).toString();
    return redirect(authorize.toString(), [
      sessionCookie(oauthName, state, 600),
    ]);
  }
  if (path === "/auth/linkedin/callback" && req.method === "GET") {
    const state = url.searchParams.get("state");
    if (!state || state !== cookie(req, oauthName))
      throw new ApiError(400, "oauth_state", "Sign-in expired. Start again.");
    const saved = await env.INDEX.prepare(
      "DELETE FROM oauth_states WHERE hash=? AND expires_at>? RETURNING nonce",
    )
      .bind(await digest(state), Date.now())
      .first<{ nonce: string }>();
    if (!saved)
      throw new ApiError(
        400,
        "oauth_replay",
        "Sign-in expired or already used.",
      );
    if (url.searchParams.has("error"))
      return redirect(`${env.SITE_URL}/apply?signin=cancelled`, [
        sessionCookie(oauthName, "", 0),
      ]);
    const code = url.searchParams.get("code");
    if (!code)
      throw new ApiError(400, "oauth_code", "Missing authorization code.");
    const tokenResponse = await fetch(
      "https://www.linkedin.com/oauth/v2/accessToken",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: `${env.SITE_URL}/auth/linkedin/callback`,
          client_id: env.LINKEDIN_CLIENT_ID,
          client_secret: env.LINKEDIN_CLIENT_SECRET,
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!tokenResponse.ok)
      throw new ApiError(
        502,
        "linkedin_unavailable",
        "LinkedIn sign-in failed. Please try again.",
      );
    const tokens = z
      .object({ id_token: z.string(), access_token: z.string() })
      .parse(await tokenResponse.json());
    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer: "https://www.linkedin.com/oauth",
      audience: env.LINKEDIN_CLIENT_ID,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub"],
      maxTokenAge: "10m",
    });
    // Preserve validation for any in-flight requests created by the old flow.
    if ((saved.nonce && payload.nonce !== saved.nonce) || !payload.sub)
      throw new ApiError(400, "oidc_nonce", "Invalid sign-in response.");
    const infoResponse = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!infoResponse.ok)
      throw new ApiError(
        502,
        "linkedin_profile",
        "Could not retrieve your LinkedIn profile. Try again.",
      );
    const info = z
      .object({
        sub: z.string(),
        name: z.string().optional(),
        email: z.string().email().optional(),
        email_verified: z.boolean().optional(),
        picture: z.string().url().optional(),
      })
      .parse(await infoResponse.json());
    if (info.sub !== payload.sub)
      throw new ApiError(
        400,
        "oidc_subject",
        "LinkedIn profile does not match this sign-in.",
      );
    const id = await digest(`linkedin:${payload.sub}`);
    const agent = await actor(env, id);
    await agent.identify({
      id,
      sub: payload.sub,
      name: info.name ?? "Community applicant",
      email: info.email ?? "",
      emailVerified: !!info.email && info.email_verified === true,
      picture: info.picture,
    });
    const session = randomToken();
    await env.INDEX.batch([
      env.INDEX.prepare("DELETE FROM sessions WHERE hash=?").bind(
        await digest(cookie(req, sessionName)),
      ),
      env.INDEX.prepare(
        "INSERT INTO sessions(hash,account_id,expires_at) VALUES(?,?,?)",
      ).bind(await digest(session), id, Date.now() + 7 * 86400000),
    ]);
    return redirect(`${env.SITE_URL}/apply`, [
      sessionCookie(sessionName, session, 7 * 86400),
      sessionCookie(oauthName, "", 0),
    ]);
  }
  if (req.method !== "GET") {
    const apiBearer =
      path === "/api/v1/application" && req.headers.has("authorization");
    if (!apiBearer) csrf(req, env.SITE_URL);
  }
  if (path === "/auth/logout" && req.method === "POST") {
    await env.INDEX.prepare("DELETE FROM sessions WHERE hash=?")
      .bind(await digest(cookie(req, sessionName)))
      .run();
    return json({ signedOut: true }, 200, {
      "Set-Cookie": sessionCookie(sessionName, "", 0),
    });
  }
  if (path.startsWith("/api/admin/")) {
    const auth = await admin(req, env);
    if (path === "/api/admin/applications" && req.method === "GET") {
      const rows = await env.INDEX.prepare(
        "SELECT * FROM applications WHERE status<>? ORDER BY updated_at DESC LIMIT 100",
      )
        .bind("draft")
        .all();
      return json({ applications: rows.results });
    }
    const match = path.match(
      /^\/api\/admin\/applications\/([a-f0-9]{64})(?:\/(decision|retry|reconcile))?$/,
    );
    if (!match) throw new ApiError(404, "not_found", "Endpoint not found.");
    const target = await actor(env, match[1]);
    if (req.method === "GET" && !match[2]) {
      const {
        profile,
        application,
        status,
        assessment,
        policy,
        model,
        decision,
        delivery,
        history,
      } = await target.inspect();
      return json({
        profile,
        application,
        status,
        assessment,
        policy,
        model,
        decision,
        delivery,
        history,
      });
    }
    if (req.method === "POST" && match[2] === "decision") {
      const data = z
        .object({
          action: z.enum(["approve", "decline"]),
          reason: z.string().trim().min(5).max(1500),
        })
        .strict()
        .parse(await body(req));
      return json(await target.decide(data.action, data.reason, auth.sub));
    }
    if (req.method === "POST" && match[2] === "reconcile") {
      const data = z
        .object({
          outcome: z.enum(["accepted", "not_sent"]),
          reason: z.string().trim().min(10).max(1500),
        })
        .strict()
        .parse(await body(req));
      return json(
        await target.reconcileDelivery(data.outcome, data.reason, auth.sub),
      );
    }
    if (req.method === "POST" && match[2] === "retry")
      return json(await target.retryDelivery(auth.sub));
    throw new ApiError(405, "method", "Method not allowed.");
  }
  const browserOnly = path !== "/api/v1/application";
  const auth = await authenticated(req, env, browserOnly);
  if (path === "/api/v1/application") {
    if (req.method === "GET") return json(await auth.agent.publicState());
    if (req.method === "POST") {
      const key = req.headers.get("Idempotency-Key");
      if (!key || !/^[\w-]{8,128}$/.test(key))
        throw new ApiError(
          400,
          "idempotency_key",
          "Supply an Idempotency-Key of 8–128 letters, digits, underscores or hyphens.",
        );
      return json(
        await auth.agent.submit(
          await body(req),
          key,
          auth.bearer ? auth.hash : undefined,
        ),
        202,
      );
    }
  }
  if (path === "/api/application-token") {
    if (req.method === "POST") return json(await auth.agent.token(), 201);
    if (req.method === "DELETE") return json(await auth.agent.revoke());
  }
  if (path === "/api/application-consent" && req.method === "POST") {
    z.object({ consent: z.literal(true) })
      .strict()
      .parse(await body(req));
    return json(await auth.agent.consent());
  }
  if (path === "/api/application-email" && req.method === "POST") {
    await limit(env, `email:${auth.id}`, 2);
    const data = z
      .object({ email: z.string().trim().email().max(254) })
      .strict()
      .parse(await body(req));
    return json(await auth.agent.changeEmail(data.email));
  }
  if (path === "/api/application-email/verify" && req.method === "POST") {
    const data = z
      .object({ code: z.string().regex(/^\d{8}$/) })
      .strict()
      .parse(await body(req));
    return json(await auth.agent.verify(data.code));
  }
  throw new ApiError(404, "not_found", "Endpoint not found.");
}

// No public ingress to privileged handlers. Astro binds to this named entrypoint.
export class AdmissionsGateway extends WorkerEntrypoint<Env> {
  async fetch(req: Request): Promise<Response> {
    try {
      return await handle(req, this.env);
    } catch (error) {
      if (
        new URL(req.url).pathname === "/auth/linkedin/callback" &&
        req.headers.get("accept")?.includes("text/html")
      ) {
        return redirect(`${this.env.SITE_URL}/apply?signin=failed`, [
          sessionCookie(oauthName, "", 0),
        ]);
      }
      if (error instanceof ApiError)
        return json(
          {
            error: {
              code: error.code,
              message: JSON.parse(error.message.slice(10)).message,
              details: error.details,
            },
          },
          error.status,
          error.status === 429 ? { "Retry-After": "60" } : {},
        );
      if (error instanceof errors.JOSEError)
        return json(
          {
            error: {
              code: "invalid_signin",
              message:
                "Invalid or expired LinkedIn sign-in. Please start again.",
            },
          },
          400,
        );
      if (error instanceof z.ZodError)
        return json(
          {
            error: {
              code: "validation",
              message: "Check the supplied fields.",
              details: error.flatten(),
            },
          },
          422,
        );
      // RPC preserves Error.message, but not custom error properties.
      if (error instanceof Error && error.message.startsWith("API_ERROR:")) {
        const parsed = JSON.parse(error.message.slice(10));
        return json(
          {
            error: {
              code: parsed.code,
              message: parsed.message,
              details: parsed.details,
            },
          },
          parsed.status,
        );
      }
      return json(
        {
          error: {
            code: "temporarily_unavailable",
            message:
              "Please try again shortly. Your saved application is safe.",
          },
        },
        503,
      );
    }
  }
}
export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  },
  async scheduled(_event: ScheduledController, env: Env) {
    await env.INDEX.batch(
      ["sessions", "tokens", "oauth_states", "rate_limits"].map((table) =>
        env.INDEX.prepare(`DELETE FROM ${table} WHERE expires_at<?`).bind(
          Date.now(),
        ),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
