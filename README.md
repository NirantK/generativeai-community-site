# GenAI Community

Static portal for the Generative AI Community (2,000+ members across Bangalore and San Francisco). Rules, demos, events.

Source content migrated from `nirantk.com/community/*`.

## Stack

- **Astro 6** (`output: 'static'`) — server-rendered at build time, zero client JS.
- **Tailwind v4** with the Technical Precision design system (`src/styles/global.css`).
- **Self-hosted Geist + JetBrains Mono** variable fonts.
- **Cloudflare Pages** for hosting.

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

## License

Apache 2.0. See [`LICENSE`](./LICENSE).
