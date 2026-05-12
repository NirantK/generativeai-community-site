import { test, expect } from '@playwright/test';

const pages = ['/', '/deephackdemos', '/demoday102023'];

for (const path of pages) {
  test(`header + nav tap targets ≥ 48px on ${path}`, async ({ page }) => {
    await page.goto(path, { waitUntil: 'networkidle' });
    const small = await page.$$eval(
      'header a, header button, nav a, nav button, main > section a',
      (els) =>
        els
          .map((el) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
            return {
              tag: el.tagName,
              text: (el.textContent ?? '').trim().slice(0, 40),
              h: Math.round(r.height),
              w: Math.round(r.width),
              visible,
            };
          })
          .filter((x) => x.visible && (x.h < 48 || x.w < 24)),
    );
    expect(small, JSON.stringify(small, null, 2)).toEqual([]);
  });
}
