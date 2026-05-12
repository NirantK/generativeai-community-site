/**
 * One-off suite to verify the live custom domain.
 * Uses Chromium with --host-resolver-rules to bypass any local DNS quirks
 * (e.g., Tailscale MagicDNS intercept) and prove the production site renders
 * correctly across mobile + desktop viewports.
 */
import { test, expect, chromium, devices } from '@playwright/test';

const DOMAIN = 'genaicommunity.ai';
const CDN_IPS = ['104.21.94.116', '172.67.223.65'];
const launchOpts = {
  args: [`--host-resolver-rules=MAP ${DOMAIN} ${CDN_IPS[0]},MAP www.${DOMAIN} ${CDN_IPS[0]}`],
};

const viewports = [
  { name: 'iphone-se',  d: devices['iPhone SE'] },
  { name: 'iphone-14',  d: devices['iPhone 14'] },
  { name: 'pixel-7',    d: devices['Pixel 7'] },
  { name: 'iphone-11pm', d: { viewport: { width: 414, height: 896 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
  { name: 'desktop',    d: { viewport: { width: 1440, height: 900 } } },
];

const pages = ['/', '/deephackdemos/', '/demoday102023/'];

for (const v of viewports) {
  for (const p of pages) {
    test(`${v.name} :: ${p} :: live domain renders`, async () => {
      const browser = await chromium.launch(launchOpts);
      const context = await browser.newContext({ ...v.d });
      const page = await context.newPage();
      await page.goto(`https://${DOMAIN}${p}`, { waitUntil: 'networkidle' });

      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth - doc.clientWidth;
      });
      expect(overflow, `${overflow}px overflow on ${v.name}${p}`).toBeLessThanOrEqual(0);

      const small = await page.$$eval(
        'header a, header button, nav a, nav button, main > section a',
        (els) =>
          els
            .map((el) => {
              const r = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
              return { tag: el.tagName, text: (el.textContent ?? '').trim().slice(0, 30), h: Math.round(r.height), w: Math.round(r.width), visible };
            })
            .filter((x) => x.visible && (x.h < 48 || x.w < 24)),
      );
      expect(small, JSON.stringify(small)).toEqual([]);

      const fontFamily = await page.evaluate(() => {
        const h1 = document.querySelector('h1') as HTMLElement | null;
        const mono = document.querySelector('header a') as HTMLElement | null;
        return {
          h1: h1 ? getComputedStyle(h1).fontFamily : '',
          mono: mono ? getComputedStyle(mono).fontFamily : '',
        };
      });
      expect(fontFamily.h1.toLowerCase()).toMatch(/geist/);
      expect(fontFamily.mono.toLowerCase()).toMatch(/jetbrains/);

      await browser.close();
    });
  }
}
