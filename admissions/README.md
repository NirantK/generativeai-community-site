# Community admissions

LinkedIn-only sign-in, browser and agent applications, Cloudflare Agents SDK review,
and Cloudflare Email Service invitations from `noreply@genaicommunity.ai`.

## Deployment setup (2026-09-16)

The existing Cloudflare Pages project is `generativeai-community-site` in Scaled
Focus (`076c525b59739562570401e48fc0651c`). Astro builds a static frontend. Pages
Functions forward `/auth/*` and `/api/*` through a private named service binding.
The unfinished job-board branch is not part of this deployment.

Production and staging have separate D1 databases and AdmissionAgent namespaces.
GitHub Actions deploys the backend, applies additive migrations, then publishes the
tested Pages artifact. See `docs/deployment.md`. Do not deploy from a workstation.

The LinkedIn app is `266495208`; its OIDC product is enabled. Configure these exact
callbacks in the developer portal:

- `https://genaicommunity.ai/auth/linkedin/callback`
- `https://staging.genaicommunity.ai/auth/linkedin/callback`

Store `LINKEDIN_CLIENT_SECRET` in GitHub Actions secrets. The client ID is public
configuration. Never commit secrets, include them in CLI arguments, or print them.

Email Sending is enabled for `genaicommunity.ai`. DNS authentication records were
verified while preserving existing mail services. Inbox Authentication-Results and
real invitation delivery still require a controlled test. Both email dispatch and
automatic approvals remain paused until those launch checks complete.

Remaining launch inputs and checks:

1. Configure `WHATSAPP_INVITE_URL` securely for each admissions Worker.
2. Configure `ADMIN_EMAILS` as a comma-separated email allowlist in deployment
   secrets. Administrator requests require an authenticated browser session and a
   verified matching email. Unverified addresses and application tokens cannot
   access administration. Comparison is case-insensitive with whitespace trimmed.
3. Verify staging login, browser/API submissions, review, and controlled email
   delivery. Record the real LinkedIn test in `TESTING.md`; repeatable tests use
   signed synthetic OIDC tokens and no personal credentials.
4. Enable email and automatic approvals only after validating their launch gates.

## Architecture and state

The Pages Functions proxy HTTP requests through a named, private Worker entrypoint.
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
npm run check:admissions
npm run test:admissions
npm run build:admissions
npm run build
npx wrangler pages functions build functions --outdir=/tmp/community-functions
npm run test:e2e
```

The Workers tests mock AI and email. Browser application tests mock authenticated
API responses. They do not send real email, call a live model, or use personal
LinkedIn credentials. Compatibility date 2026-08-22 matches the installed Workers
test runtime. See `TESTING.md` for signed OIDC coverage and the one-time live check.
