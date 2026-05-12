import { test, expect } from '@playwright/test';

test('Geist + JetBrains Mono load and apply', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(() => (document as any).fonts.ready);
  const h1Family = await page.evaluate(
    () => getComputedStyle(document.querySelector('h1') as HTMLElement).fontFamily,
  );
  const monoFamily = await page.evaluate(() => {
    const el = document.querySelector('header a') as HTMLElement | null;
    return el ? getComputedStyle(el).fontFamily : '';
  });
  expect(h1Family.toLowerCase()).toMatch(/geist/);
  expect(monoFamily.toLowerCase()).toMatch(/jetbrains/);
});
