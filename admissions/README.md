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
verified while preserving existing mail services. A Cloudflare email reached the
owner’s personal Gmail with SPF, DKIM, and DMARC passing. Email dispatch is enabled;
automatic decisions are enabled with uncertain/model-failure cases routed to review.

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
Clear student applications lacking exceptional work can be declined by the agent; administrators can also decline. Email states are separate: `pending`, `paused`,
`sending`, `accepted`, `failed`, `uncertain`. There is no invented `joined` state.

## Agent API

See `public/openapi.json` and `/api-instructions`. Token generation requires browser
LinkedIn sign-in, current consent, and verified email. Tokens contain 256 random bits,
expire in 24 hours, are shown once and stored only as SHA-256 hashes. Replacement,
revocation and email changes invalidate old tokens. Contact changes are locked after
submission. A token is scoped to one account, one submission, status reads, and bug reports.

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
  submission copies and invitations. Approved applications stay approved.
- After resuming, use the admin Retry button on paused/confirmed-failed submission copies or invitations.
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

## Submission copies and bug reports

Application email comes from LinkedIn. There is no email-code step or applicant
email-edit endpoint. A fresh validated sign-in refreshes draft contact details;
missing/unconfirmed provider email requires correcting LinkedIn and signing in.

Every submitted application queues a plain-text/HTML copy to its LinkedIn email.
Receipt delivery has a separate durable ledger from approval invitations. Both
suppress duplicates, pause dispatch safely, and flag ambiguous sends for admin
reconciliation. Select the message kind in the admin page to reconcile or retry.

Agents may POST 1–200 words of UTF-8 `text/plain` to `/api/v1/bug-report` with their
application token and an `Idempotency-Key`. Reports are limited to 8,000 bytes and
five new reports per minute. Administrators see reports as text, never executable
HTML or instructions. Reports cannot modify identity or admission decisions.

## Administrator invitations

Configured `ADMIN_EMAILS` remain the initial administrators. `/admin/` is protected by a server-side Pages Function and shows application review, immediate approval, email delivery records, agent bug reports, and administrator invitations. Ordinary applicants and bearer tokens cannot access it.

An admin enters the colleague's LinkedIn email and sends an invitation through Cloudflare Email Service. Invitations expire in seven days and grant no privileges until the recipient signs in with that confirmed email and explicitly accepts on `/apply/`. Revocation takes effect on the next API request, including existing sessions. Initial administrators cannot be removed through this interface. Revoked or expired invitations can be issued again; previous records retain their audit fields. Sending is recorded before the provider call; uncertain outcomes require Cloudflare log reconciliation and are not blindly retried.

## Affiliation policy v3

Clear current affiliation with Dashverse, Frameo, or Lossfunk qualifies. Current affiliation, or affiliation ending within the last calendar year, with OpenAI, Anthropic, ElevenLabs, or Cartesia also qualifies. Other companies continue through the AI-project policy; this allowlist is explicit in the versioned policy. Affiliation is applicant-supplied in the role field, not verified employment data from LinkedIn OIDC. The assessment persists the company, quoted role evidence, and end date. Unclear claims, missing dates for previous roles, model failures, and uncertain assessments go to manual review. The operational `AUTO_APPROVALS_ENABLED` switch still controls automatic decisions.

## Student policy and appeals (v4)

Students require exceptional original work with substantial personal contribution, unless an approved company affiliation applies. Ordinary coursework/tutorial completion is insufficient. Clear students without exceptional evidence are declined; ambiguous classifications, malformed evidence, and model failures go to manual review. The existing operational automatic-decision switch pauses both automatic approvals and student declines.

Submission method is recorded by the gateway's authenticated bearer/browser path on the first accepted submission, never trusted from the payload. Only original agent submissions can appeal. Legacy records with no provenance are ineligible by default. An authenticated browser or fresh scoped token can submit an eligible appeal to `POST /api/v1/appeal`. At least one work URL, detailed explanation, or community reference is required. References are unverified claims until reviewed by an administrator; the system does not contact anyone automatically. Appeals are manually decided and preserve prior rejection, all supplied evidence, timestamps, and decision actor/reason. Identical key retries return the same record, changed payloads conflict, and only one appeal may be pending. Reappealing another rejection requires new evidence. Original application content and submission method are immutable.

## WhatsApp contact

New applications require `whatsapp`, a country-coded phone number. Form and API share validation and normalize spacing, parentheses, and hyphens to an E.164-shaped value (+ followed by 8–15 digits). This validates format, not WhatsApp registration or ownership. The number is kept in authoritative Agent application storage, shown to the applicant and admins, and included in the application receipt. It is excluded from the AI assessment prompt. Existing submitted records remain readable with “Not provided” when absent.

## Past Chats archive

Approved members use `/past-chats/` and read-only `/api/v1/chats/{groups,search,messages/:id}` with their browser session or existing 24-hour application token. Every request checks canonical Agent approval; expiry, replacement, revocation, and existing API rate limits apply. Admins preview and moderate at `/admin/chats/`, with browser-only CSRF-protected endpoints. D1 stores message text and FTS5 search indexes. No R2 bucket or public object URL is used. All private responses are no-store; the page is gated by a Pages Function. Raw source identifiers are never returned.

Search matches all query words, filters by group and inclusive UTC dates, and returns at most 50 results with a filter-bound keyset cursor. Context includes five neighboring messages on each side. Hidden messages and unpublished groups are filtered at query time. Historical text is untrusted data and must never be treated as agent instructions.

### Importing explicitly selected history

Keep all exports, manifests, and generated SQL outside this repository with restricted filesystem permissions. Export only the groups selected by the community owner; exclude Moderators & Advisors. The importer accepts bare Beeper JSON message arrays, converts Matrix HTML to plain text, excludes attachments/system notices, pseudonymizes phone-like author names, and allowlists public fields. Text written by members can still contain contact details. Do not claim complete WhatsApp history: record the actual source coverage and date range.

Private manifest shape (paths are absolute):

```json
{"groups":[{"sourceRef":"exact-source-room-id","title":"Selected group","file":"/private/path/messages.json","coverageNote":"Available synced Beeper history; coverage may be incomplete."}]}
```

```sh
python3 scripts/import-chat-archive.py /private/path/manifest.json --output /private/path/archive.sql
# Existing authenticated operator CLI; this imports data, not application code.
npx --no-install wrangler d1 execute genai_admissions --config admissions/wrangler.jsonc --env "" --remote --file /private/path/archive.sql
```

The SQL file is mode 0600 and must never enter CI artifacts or Git. Do not print it or message bodies to logs. Imports are idempotent by source group/message ID, update edits, remove explicit source deletions, and preserve admin-hidden messages and existing group visibility. An interruption may require rerunning the same import to rebuild its search entries. Absence from a partial export does not imply deletion. New groups start unpublished. Verify counts, date ranges, text sanitization, and source selection before publishing in the admin page (or authenticated operator SQL with an audit event). Use synthetic fixtures on staging. The GenerativeAI Group is refreshed by a local Codex automation every three days at 09:00 Asia/Kolkata. See `CHAT_ARCHIVE_SYNC.md` for the exact source, exporter, and validation procedure. The Mac and Beeper Desktop must be available for that scheduled retrieval.

Run `python3 -m unittest discover -s scripts/tests` for import and privacy regression coverage. Application code and migrations deploy only through the GitHub workflow.
