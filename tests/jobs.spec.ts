import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('Jobs', () => {
  test('list page renders and passes a11y', async ({ page }) => {
    await page.goto('/jobs');
    await expect(page.getByRole('heading', { name: /open roles/i })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    const blockers = results.violations.filter((v) =>
      ['critical', 'serious'].includes(v.impact ?? ''),
    );
    expect(blockers, JSON.stringify(blockers, null, 2)).toEqual([]);
  });

  test('post page renders form and passes a11y', async ({ page }) => {
    await page.goto('/jobs/post');
    await expect(page.getByRole('button', { name: /post_job/i })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    const blockers = results.violations.filter((v) =>
      ['critical', 'serious'].includes(v.impact ?? ''),
    );
    expect(blockers, JSON.stringify(blockers, null, 2)).toEqual([]);
  });

  test('header links to /jobs', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'JOBS' }).first().click();
    await expect(page).toHaveURL(/\/jobs$/);
  });
});
