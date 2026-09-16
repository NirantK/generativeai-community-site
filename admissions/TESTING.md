# LinkedIn test policy

## Repeatable automated coverage

Run `npm run check:admissions && npm run test:admissions`.

The authentication integration test uses the actual gateway, D1 state records,
RS256 signature verification, issuer and audience checks, Agent identity, and session
creation. Only the LinkedIn token/JWKS/userinfo network responses are intercepted.
It generates its own signing keys and synthetic applicant; it does not reuse a
personal LinkedIn account, OAuth token, cookie, email address, or real invitation.

Covered authentication cases: valid login, callback replay, wrong audience, wrong
issuer, legacy-request nonce mismatch, expired ID token, forged signature, mismatched userinfo subject,
cancelled consent, and callback/cookie state mismatch. Application tests separately
exercise consent, verified email, token scopes, idempotency, review, and delivery.

No production login bypass, configurable fake issuer, or publicly accessible account
reset route is introduced. A fresh local Workers test runtime gives each suite clean
storage, so the one-application rule does not prevent repeated regression runs.

## Personal-account smoke test: once by default

Perform one live LinkedIn OIDC test with Nirant's already-authorized personal account
only after staging frontend, service binding, client secret, and exact callback URL
are configured. Confirm the callback creates the expected profile/session, then sign
out. Do not submit an application, send email, join WhatsApp, or reset a real application
merely to exercise login. Those actions need their own explicit test scope.

Record date, environment, build commit, and pass/fail here without tokens, authorization
codes, cookies, email addresses, or LinkedIn subject identifiers. Do not mark this test
passed based on a community-page link opening or a mocked callback.

Current live OIDC status: **sign-in passed; sign-out verification pending**.
Verified on staging on 16 September 2026, build `61cee8b`: LinkedIn consent returned
successfully, a session was created, and the correct owner's profile and verified
email appeared. No application or invitation was submitted. The first attempt
failed because the transferred client secret was incorrect; it was replaced, and
issuer verification was aligned with live provider discovery.

Repeat the live test only when explicitly requested or after a material provider,
client credential, callback-domain, or authentication integration change; explain why
it is needed. Routine commits use the synthetic tests above.

The community footer link was separately tested once in Nirant's signed-in browser on
16 September 2026 and reached organization 146602087. Website CI tests this navigation
with a synthetic LinkedIn destination; that is not evidence of OIDC login success.


## Provider compatibility

Use the live discovery issuer `https://www.linkedin.com/oauth`, not the older
issuer in LinkedIn's documentation example. Match LinkedIn's confidential
server-side authorization-code flow: one-use state bound to an HttpOnly secure
cookie, client-secret token exchange, signed ID token, exact issuer/audience,
required expiry/issued-at/subject, and matching userinfo subject. The current
provider does not advertise nonce/PKCE support; no unsupported nonce is sent.
Old in-flight requests that did send a nonce still require a matching claim.

References checked 16 September 2026:
- https://www.linkedin.com/oauth/.well-known/openid-configuration
- https://github.com/nextauthjs/next-auth/blob/main/packages/core/src/providers/linkedin.ts

All subsequent live smoke tests use `https://staging.genaicommunity.ai`; production
checks use `https://genaicommunity.ai`. The staging callback-domain change requires
one new live login because the previous host-only session cannot transfer safely.

## Official-domain smoke test — 16 September 2026

On deployed build `1b666fb`, sign-in on `staging.genaicommunity.ai` returned the
expected owner's profile with verified email. Email-allowlisted administrator
access loaded successfully and showed no submitted applications.

The owner authorized one verification email. The native Cloudflare binding
accepted the send; inbox receipt and code verification remain pending. During
reverification, token issuance was denied by the server as required. The stale
verified-email label and enabled controls observed in this test were corrected,
with a regression check passing on all five browser/device profiles.

No application or invitation has been submitted in this smoke test yet.

## LinkedIn-only email and agent-first update

Build `0cb78a7` deployed successfully to the official staging domain. The separate
email-code and email-edit endpoints/forms were removed at the owner's request.
Draft contact details now refresh only from a validated LinkedIn callback. The
agent option is expanded before the alternative form.

The earlier Cloudflare test email was located in the correct connected personal
Gmail account through Composio. Gmail Authentication-Results confirm SPF, DKIM
for genaicommunity.ai, and DMARC all pass. No verification code was used after the
owner removed the code step.

Local validation: 27 backend tests and 45 application-page browser checks passed.
CI also passed the full browser suite and deployed the additive bug-report schema.
Submission receipts have an independent durable delivery ledger; automated tests
cover one send under concurrency, escaping, and uncertain outcomes without blind
resends. Agent bug reports cover plain-text input, 200-word/8,000-byte limits,
idempotent retries/conflicts, and revoked tokens.

Live application submission, receipt delivery, and bug reporting remain pending
one provider sign-in to clear the draft's old email-code test state.

## September 16 authenticated staging checks

On `staging.genaicommunity.ai`: LinkedIn session, shortened agent submission, identical retries, conflicting submissions, forbidden bearer operations, plain-text bug report creation/retry/word limit, and token revocation were checked. The test application remains in manual review. Exactly one submitted-copy email was observed in the applicant's personal Gmail inbox, with SPF, DKIM, and DMARC passing. No approval invitation was sent.

New administrator invitation tests cover authorization, CSRF, duplicate-send prevention, matching-email acceptance, expiry, bearer exclusion, and revocation of access through an existing session. Page-gate tests verify unauthorized users never receive the dashboard. Policy tests cover all seven named companies, exact role evidence, uncertainty, invalid/future dates, and the one-year boundary. These invitation email tests mock the provider; no new administrator was actually invited.
