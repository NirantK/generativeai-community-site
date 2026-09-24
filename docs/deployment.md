# Website publishing

Source repository: `NirantK/generativeai-community-site`.
Production: https://genaicommunity.ai
Cloudflare account: Scaled Focus (`076c525b59739562570401e48fc0651c`).
Existing Pages project: `generativeai-community-site`.

## GitHub-driven deployment

Every pull request builds the website and runs accessibility, mobile layout,
font and navigation checks. Merging to `main` repeats those checks and publishes
the exact tested artifact to the existing Cloudflare Pages project automatically.
Same-repository pull requests also deploy isolated staging at
`https://staging.genaicommunity.ai` after checks pass.
The preview service binding points to the staging admission Worker and database.

There are no workstation uploads or dashboard drag-and-drop deployments.
A failed build or test prevents the deploy job. Production deployments are serialized.
The existing domain and Pages project stay in place.

Cloudflare classifies the existing project as Direct Upload; it cannot be converted
to native Git integration. GitHub Actions is its supported automatic CI/CD integration.
The workflow is `.github/workflows/ci.yml`.

## One-time credential setup

Set `CLOUDFLARE_API_TOKEN` as a GitHub repository secret or in the `production`
environment. It needs Pages Write, Workers Scripts Write, D1 Write, and zone Workers Routes Edit for the
Scaled Focus account. The latter permissions deploy the private admissions Worker
and apply its migrations. Store `LINKEDIN_CLIENT_SECRET` as a repository secret
for both environments. Store `MODAL_PROXY_TOKEN` as a repository secret for both
environments; it contains the protected Modal endpoint proxy token. The Worker
receives it through `wrangler secret bulk`. Never expose that token in Pages,
client code, logs, or committed files.
Do not put the token in source, logs, issues, or command arguments. From an authenticated
terminal, `gh secret set CLOUDFLARE_API_TOKEN --repo NirantK/generativeai-community-site`
prompts for the value securely. The account ID is public configuration.

The Pages token was stored by the owner on 16 September 2026. Check the GitHub run
and live URLs before marking a deployment complete.

The September 2026 People page updates were reconciled with the published HTML before
being committed so a source build preserves the existing content.

## Checks

`npm ci && npm run build && npm run test:e2e`

Normal CI uses its local build only. Explicit public-site smoke tests can be run with
`RUN_LIVE_SITE_TESTS=1 npx playwright test tests/live-domain.spec.ts --project=desktop`.
These do not authenticate with LinkedIn. Personal-account sign-in tests must be run
manually and recorded once; repeat authentication regression tests use signed synthetic
OIDC responses in the separate admissions implementation, never personal cookies or tokens.

## LinkedIn link verification

On 16 September 2026, the footer link was followed from the built Terms page in
Nirant Kasliwal's existing signed-in browser session. LinkedIn opened the GenerativeAI
Community admin page for organization `146602087`, confirming the public vanity URL
`https://www.linkedin.com/company/genaicommunity/` resolves to the correct Page.
This was a link-navigation smoke test, not an OIDC sign-in test.

`tests/footer.spec.ts` repeats the actual footer navigation using an intercepted
LinkedIn destination. CI never calls LinkedIn or stores personal-account cookies.
The real signed-in check is test-once by default; repeat it only after the target
Page/URL changes or when explicitly requested.

## Verified rollout status — 16 September 2026

- GitHub Actions run `35092606550` passed all checks and deployed staging from commit `214a232`.
- Staging frontend: https://staging.genaicommunity.ai
- Staging Pages Functions successfully reach the private admission Worker; the application page shows the signed-out LinkedIn entry flow.
- LinkedIn and WhatsApp secrets are stored in GitHub and were deployed to the staging Worker.
- Replacement deployment token `genaicommunity-github-deploy-v2` authenticated successfully. The original token was removed from Cloudflare after confirmation.
- The initial failed OAuth exchange was fixed by correcting the client secret and provider issuer. Real staging login passed on build `61cee8b`. The official staging hostname now needs its own callback smoke test.
- Production publishing, app privacy-policy registration, administrator configuration, and controlled email delivery remain pending.

## Application API edge checks

Agents use the browser for LinkedIn sign-in, consent, and token issuance, then use
`/api/v1/application` with their bearer token. Browser Integrity Check can reject
non-browser clients before the application validates a token (Cloudflare Error 1010).
The 22 September incident was confirmed in Cloudflare traffic logs as a BIC block.

Keep any BIC exception restricted to HTTPS, the exact production hostname,
`/api/v1/*`, and an `Authorization: Bearer` header. Token validation, managed WAF,
and rate limits must remain active. A saved rule is not proof that the API works.

Run `python3 scripts/check-application-api.py` and enter an existing application
token at the hidden prompt. The script performs only GET, uses Python urllib's
default user agent, and prints status, ray ID, and the result without token or
applicant data. Only an authenticated HTTP 200 is green. `--invalid-token` provides
an edge-only probe: a 401 shows token rejection, never authenticated success.

Record the original failing timestamp/ray and the post-change check. Do not
re-enable a broken setting to manufacture a baseline. After an owner-confirmed
fix, inspect application status before retrying any POST with its original
idempotency key and unchanged body.

## Direct application API ingress

`api-gateway/wrangler.jsonc` routes only HTTPS `/api/v1/*` on the exact production
hostname to `genaicommunity-api`. It forwards the original request through the
existing private `ADMISSIONS` service binding. Authentication, browser CSRF checks,
rate limits, idempotency, and application state stay in `AdmissionsGateway`.
Sign-in, token issuance, administrator endpoints, and static pages remain on Pages.
The staging gateway has its own hostname route and staging service binding.
Both gateways disable workers.dev and preview URLs.

CI deploys the admissions service before its gateway. To roll back only ingress,
remove the gateway route in Cloudflare; the existing Pages API function remains
available. Do not disable zone-wide security or change applicant credentials.

Incident evidence (22 September 2026, UTC):
- 05:33:12: original applicant request blocked by zone Browser Integrity Check.
- Approved BIC exception scope: exact host, HTTPS, `/api/v1/*`, bearer header.
- Configuration rule: `6df44885dea446628028b1b7fbdff823`.
- BIC-only WAF skip: `962fafac4709411aa399c1ad57f86dac`; all other skip options off.
- 05:59:54: ray `a3ef16146e4ea92b-MAA` logged the skip but still returned 1010.
- 06:11:29: authorized applicant token GET also returned 403/1010, ray
  `a3ef270d8f2e7f7a-MAA`; token was never logged or stored in the repository.
- 06:13:35: failing probe ray `a3ef2a222a2d58e7-MAA` did not reach Pages Functions.
  A browser GET immediately afterward appeared in the connected live log, confirming
  the stream worked. This locates the residual block before Pages execution; the
  exact Cloudflare internal cause is not yet established.

The direct route removes the Pages ingress hop. Verify the original urllib client
with an existing valid token after rollout; a deployment or Trace simulation alone
is not a successful end-to-end test.
