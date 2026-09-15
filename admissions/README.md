# Community admissions

LinkedIn-only sign-in, browser and agent applications, Cloudflare Agents SDK review,
and Cloudflare Email Service invitations from `noreply@genaicommunity.ai`.

## Deployment status (2026-09-15)

- Cloudflare account: Scaled Focus (`076c525b59739562570401e48fc0651c`).
- Email Sending enabled for `genaicommunity.ai`. Authoritative DNS verified bounce MX,
  SPF, DKIM and DMARC (`p=reject`); existing root mail records were not replaced.
- Staging database `genai_admissions_staging` created and migration applied.
- Private staging Worker `genaicommunity-admissions-staging` and review Workflow deployed.
- Email dispatch and automatic approvals remain paused in staging.
- Production website has **not** been replaced. Current credentials cannot inspect
  Pages hosting; the repository's `genaicommunity-site` Worker does not exist remotely.
- No real LinkedIn login, inbox delivery, or WhatsApp membership test has been performed.

## Finish setup

1. In the LinkedIn developer portal create/select the community application and request
   the **Sign In with LinkedIn using OpenID Connect** product. Approve its association
   with your LinkedIn Page if the portal requests it.
2. Register exact callback URLs:
   - Production: `https://genaicommunity.ai/auth/linkedin/callback`
   - Staging: `https://staging.genaicommunity.ai/auth/linkedin/callback`
   Staging frontend/DNS is not yet deployed; change the staging SITE_URL and callback
   together if using a different preview host. Use HTTPS for secure session cookies.
3. Supply secrets with interactive Wrangler prompts (never commit values):
   ```sh
   npx wrangler secret put LINKEDIN_CLIENT_ID --config admissions/wrangler.jsonc --env staging
   npx wrangler secret put LINKEDIN_CLIENT_SECRET --config admissions/wrangler.jsonc --env staging
   npx wrangler secret put WHATSAPP_INVITE_URL --config admissions/wrangler.jsonc --env staging
   ```
4. Sign in as the administrator. Read your own `profile.sub` through the authenticated
   `GET /api/v1/application`; set `ADMIN_SUBJECTS` to that identifier. Never authorize
   administrators by display name or an applicant-supplied email. Multiple subjects
   are comma-separated.
5. Confirm the active hosting project and existing production bindings before any
   frontend deployment. Current OAuth credentials lack Pages inspection permission.
   Preserve the job board's actual D1/Stripe setup; the local job database ID remains
   a placeholder and must not be used to replace production configuration.
6. For production, create a separate `genai_admissions` D1 database, replace only the
   top-level admissions database ID, apply the migration, set production secrets,
   and deploy the admissions Worker before deploying the frontend service binding.
   ```sh
   npx wrangler d1 create genai_admissions
   npx wrangler d1 migrations apply genai_admissions --config admissions/wrangler.jsonc --env "" --remote
   npx wrangler deploy --config admissions/wrangler.jsonc --env ""
   ```
7. Configure the frontend `ADMISSIONS` service binding to `genaicommunity-admissions`
   with entrypoint `AdmissionsGateway` (already in wrangler.toml). A staging frontend
   must bind to `genaicommunity-admissions-staging`; do not cross-bind databases/accounts.
8. Enable `EMAIL_ENABLED` in staging and verify a real inbox you control. Confirm
   Authentication-Results shows SPF/DKIM/DMARC pass. Test LinkedIn cancellation,
   missing email, email verification, browser and token submission, review, and the
   approved WhatsApp invitation. Test provider acceptance does not prove inbox placement.
9. Enable `AUTO_APPROVALS_ENABLED` only after checking representative application
   assessments. Deploy the verified frontend, then enable production email/approvals.

## Architecture and state

The Astro routes proxy HTTP requests through a named, private Worker entrypoint.
The default admissions Worker returns 404 and has no public route. Authentication,
CSRF and administrator checks occur in that private gateway, not in the browser.

One `AdmissionAgent` owns each LinkedIn account/application. The Agent record is
canonical for profile, consent, token hash, application, assessment, decision and
email ledger. D1 stores hashed sessions, token lookups, one-use OAuth state, rate
counters and an administrator listing projection. Decisions always read Agent state.
Do not use the projection as authorization or approval truth.

A serialized mutation queue protects concurrent token issuance, submission, decisions
and email attempts. A deterministic workflow ID plus scheduled redispatch recovers
submission/dispatch failures. `AgentWorkflow` assesses the application, waits for a
human decision when necessary, and delivers an invitation. Scheduled delivery also
handles a decision made after the workflow's review wait has ended.

Application states: `draft → submitted → review/approved → declined/approved`.
Decline is administrator-only. Email states are separate: `pending`, `paused`,
`sending`, `accepted`, `failed`, `uncertain`. There is no invented `joined` state.

## Agent API

See `public/openapi.json` and `/api-instructions`. Token generation requires browser
LinkedIn sign-in, current consent, and verified email. Tokens contain 256 random bits,
expire in 24 hours, are shown once and stored only as SHA-256 hashes. Replacement,
revocation and email changes invalidate old tokens. Contact changes are locked after
submission. A token is scoped to one account, one submission, and status reads.

Submission requires JSON and an `Idempotency-Key` (8–128 word/hyphen characters).
Both browser and bearer paths call the same Agent method. Identical normalized
payload retries return the original application; any different post-submission
payload returns 409, including reuse of the original key. Unknown fields such as
email, identity or consent are rejected. Applicants authorize agent access in the
browser; an agent cannot grant consent.

## Operations

- Pause automatic approvals: set `AUTO_APPROVALS_ENABLED=false` and redeploy.
  New assessments go to review. Existing approvals are not retroactively revoked.
- Pause outbound email: set `EMAIL_ENABLED=false` and redeploy. This also pauses
  verification messages. Approved applications stay approved.
- After resuming, use the admin Retry button on paused/confirmed-failed invitations.
- Inspect uncertain delivery in Cloudflare Email Service logs. Record `accepted`
  or `not_sent` plus supporting evidence in the admin reconciliation form. Only
  confirmed non-sends can then be retried. Never manually retry an ambiguous send.
- `accepted` means the provider accepted the message, not inbox delivery or joining.
- Rate-limit rejections are retried at most twice by Agent scheduling. Unknown/internal
  email failures are conservative `uncertain` outcomes, not blindly retried.
- The admin list displays the 100 most recently updated applications. Inspect an older
  known application through its authenticated admin endpoint if needed.
- Daily cron deletes expired sessions, tokens, OAuth state and rate counters.
- Logs do not include credentials or application bodies. Keep worker invocation logging
  disabled, so callback URLs containing authorization codes do not enter request logs.
- For a deletion request, remove that account's Agent record and associated D1 rows using
  an authenticated operator process; do not remove only the administrator projection.

## Local verification

```sh
npm ci
cp admissions/.dev.vars.example admissions/.dev.vars
npm run types:admissions
npm run check:admissions
npm run test:admissions
npm run build:admissions
npm run build
npx astro check
npx wrangler d1 migrations apply genai_jobboard --local
npx playwright test tests/admissions.spec.ts tests/jobs.spec.ts tests/axe.spec.ts --project=desktop --project=iphone-se
```

The Workers integration tests mock AI and email; they do not send real email or call a
live model. Browser application tests mock the authenticated API and cover UI behavior;
real credential/inbox tests are explicit launch gates. Compatibility date 2026-08-22
matches the latest runtime supported by the installed Workers Vitest pool.

Astro and its Cloudflare adapter were upgraded to patched current versions for this
authentication surface. `compressHTML: true` preserves the previous whitespace behavior;
existing Stripe wire API remains pinned. Remaining npm advisories are evaluated separately
for development tooling rather than weakening the application tests or using forced
major downgrades.

## Verified checks for this implementation

- 22 Workers integration/policy/security tests passed, including signed OIDC login, replay protection, and real AgentWorkflow dispatch with mocked AI.
- 38 desktop/iPhone SE browser tests passed, including admissions, admin review, accessibility, fonts, job board, overflow, and touch targets.
- Astro and admissions TypeScript checks and production builds passed.
- Production dependency audit reports zero known vulnerabilities. Development-only toolchain advisories remain (no forced major downgrades applied).
- Screenshots reviewed for the sign-in and completed form at mobile/desktop sizes.
