# LinkedIn test policy

## Repeatable automated coverage

Run `npm run check:admissions && npm run test:admissions`.

The authentication integration test uses the actual gateway, D1 state records,
RS256 signature verification, nonce and audience checks, Agent identity, and session
creation. Only the LinkedIn token/JWKS/userinfo network responses are intercepted.
It generates its own signing keys and synthetic applicant; it does not reuse a
personal LinkedIn account, OAuth token, cookie, email address, or real invitation.

Covered authentication cases: valid login, callback replay, wrong audience, wrong
issuer, wrong nonce, expired ID token, forged signature, mismatched userinfo subject,
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

Current live OIDC status: **not run**. The LinkedIn app/product and callback registrations
exist, and the client secret is stored in GitHub. The staging deployment must pass
before the one-time real account test.

Repeat the live test only when explicitly requested or after a material provider,
client credential, callback-domain, or authentication integration change; explain why
it is needed. Routine commits use the synthetic tests above.

The community footer link was separately tested once in Nirant's signed-in browser on
16 September 2026 and reached organization 146602087. Website CI tests this navigation
with a synthetic LinkedIn destination; that is not evidence of OIDC login success.
