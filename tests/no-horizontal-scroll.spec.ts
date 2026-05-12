import { test, expect } from '@playwright/test';

const pages = ['/', '/deephackdemos', '/demoday102023'];

for (const path of pages) {
  test(`no horizontal scroll on ${path}`, async ({ page }) => {
    await page.goto(path, { waitUntil: 'networkidle' });
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth - doc.clientWidth;
    });
    expect(overflow, `${overflow}px horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
  });
}
