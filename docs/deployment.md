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
`https://staging.generativeai-community-site.pages.dev` after checks pass.
The preview service binding points to the staging admission Worker and database.

There are no workstation uploads or dashboard drag-and-drop deployments.
A failed build or test prevents the deploy job. Production deployments are serialized.
The existing domain and Pages project stay in place.

Cloudflare classifies the existing project as Direct Upload; it cannot be converted
to native Git integration. GitHub Actions is its supported automatic CI/CD integration.
The workflow is `.github/workflows/ci.yml`.

## One-time credential setup

Set `CLOUDFLARE_API_TOKEN` as a GitHub repository secret or in the `production`
environment. It needs Pages Write, Workers Scripts Write, and D1 Write for the
Scaled Focus account. The latter permissions deploy the private admissions Worker
and apply its migrations. Store `LINKEDIN_CLIENT_SECRET` as a repository secret
for both environments.
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
- Staging frontend: https://staging.generativeai-community-site.pages.dev
- Staging Pages Functions successfully reach the private admission Worker; the application page shows the signed-out LinkedIn entry flow.
- LinkedIn and WhatsApp secrets are stored in GitHub and were deployed to the staging Worker.
- Replacement deployment token `genaicommunity-github-deploy-v2` authenticated successfully. The original token was removed from Cloudflare after confirmation.
- The first real OAuth callback failed at token exchange. The incorrect transferred secret was corrected; issuer/provider-flow corrections are covered by regression tests and await live verification.
- Production publishing, app privacy-policy registration, administrator configuration, and controlled email delivery remain pending.
