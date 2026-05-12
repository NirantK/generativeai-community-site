import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const pages = ['/', '/deephackdemos', '/demoday102023'];

for (const path of pages) {
  test(`axe: no critical/serious WCAG AA violations on ${path}`, async ({ page }) => {
    await page.goto(path, { waitUntil: 'networkidle' });
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    const blockers = results.violations.filter((v) =>
      ['critical', 'serious'].includes(v.impact ?? ''),
    );
    expect(blockers, JSON.stringify(blockers, null, 2)).toEqual([]);
  });
}
