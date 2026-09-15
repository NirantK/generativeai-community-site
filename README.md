# GenerativeAI Community

Static portal for the Generative AI Community (2,000+ members across Bangalore and San Francisco). Rules, demos, events.

Source content migrated from `nirantk.com/community/*`.

## Stack

- **Astro 7** with `@astrojs/cloudflare` adapter — static by default, SSR only where needed (`/jobs`, `/jobs/[id]`, `/me`, `/api/*`).
- **Tailwind v4** with the Technical Precision design system (`src/styles/global.css`).
- **Self-hosted Geist + JetBrains Mono** variable fonts.
- **Cloudflare Workers + D1** — D1 (`genai_jobboard`) backs the paid job board; secrets via `wrangler secret put`.
- **Stripe Checkout** for paid posts; **Drizzle ORM** for D1.

## Develop

```bash
npm install
npm run dev               # http://localhost:4321
```

## Build

```bash
npm run build             # → dist/
npm run preview           # serve dist/
```

## QA

Mobile viewport gate across iPhone SE / 14 / 11 Pro Max / Pixel 7 / desktop:

```bash
npm run test:e2e
```

Checks: no horizontal scroll, header/nav tap targets ≥ 48px, Geist + JetBrains Mono apply, zero critical/serious WCAG AA violations (axe-core).

Against a deployed URL:

```bash
PLAYWRIGHT_BASE_URL=https://<preview>.pages.dev npm run test:e2e
```

## Content

Markdown lives under `src/content/community/`. Add a page by adding `<slug>.md` plus `src/pages/<slug>.astro`.

## Design tokens

Dark "Technical Precision" palette, type scale, spacing, 48px tap-target sizing — all encoded in `src/styles/global.css` via Tailwind v4 `@theme`. Utility classes (`bg-surface-container`, `text-on-surface-variant`, `font-mono`, `text-label-caps`, `min-h-tap`, …) derive from the tokens.

## Job board (paid)

Live routes: `/jobs`, `/jobs/post`, `/jobs/[id]`, `/jobs/success`.
Outbox: `/api/jobs/pending-wa` (GET) + `/api/jobs/mark-posted` (POST), gated by `OUTBOX_API_KEY` header.

### One-time setup

1. Create the D1 database and paste the ID into `wrangler.toml`:
   ```bash
   npx wrangler d1 create genai_jobboard
   ```
2. Apply migrations (local + remote):
   ```bash
   npx wrangler d1 migrations apply genai_jobboard --local
   npx wrangler d1 migrations apply genai_jobboard --remote
   ```
3. Set secrets (after deploying once so the Worker exists):
   ```bash
   echo "$STRIPE_SECRET"          | npx wrangler secret put STRIPE_SECRET
   echo "$STRIPE_WEBHOOK_SECRET"  | npx wrangler secret put STRIPE_WEBHOOK_SECRET
   echo "$STRIPE_PRICE_ID"        | npx wrangler secret put STRIPE_PRICE_ID
   echo "$OUTBOX_API_KEY"         | npx wrangler secret put OUTBOX_API_KEY
   echo "https://genaicommunity.ai" | npx wrangler secret put SITE_URL
   ```
4. In Stripe Dashboard, create a one-time product, capture the `price_id`, and add a webhook for `checkout.session.completed` pointing to `https://genaicommunity.ai/api/stripe/webhook`. Capture the signing secret.

### Local dev with .dev.vars

Copy `.dev.vars.example` to `.dev.vars` and fill values. `wrangler` reads it automatically.

### WhatsApp outbox (local launchd job)

`scripts/post-to-whatsapp.ts` polls `/api/jobs/pending-wa` and shells out to the Beeper skill to post each new job into the `GenAI Jobs` chat, then marks each result via `/api/jobs/mark-posted`. Includes hourly `/api/cron/cleanup` to GC stale `pending_payment` drafts.

Install as a launchd agent (edit `OUTBOX_API_KEY` first):

```bash
cp scripts/com.genaicommunity.outbox.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.genaicommunity.outbox.plist
tail -f /tmp/genai-outbox.log
```

## License

Apache 2.0. See [`LICENSE`](./LICENSE).

## Membership applications

LinkedIn sign-in, browser and agent applications, automated/human review, and Cloudflare email invitations. See [admissions setup and operations](admissions/README.md) for deployment status and required launch inputs.
