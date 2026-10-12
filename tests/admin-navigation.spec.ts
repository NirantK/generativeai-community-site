import { test, expect } from '@playwright/test';

test('admin overview links to separate application and message review workspaces', async ({ page }) => {
  await page.route('**/api/admin/**', route => route.fulfill({ json: { applications: [], invitations: [], reports: [], groups: [], cards: [], available: 0 } }));
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Administration', exact: true })).toBeVisible();
  await expect(page.locator('#applications, #routing-cards')).toHaveCount(0);
  const nav = page.getByRole('navigation', { name: 'Administration', exact: true });
  await nav.getByRole('link', { name: 'Applications', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/applications\/?$/);
  await expect(page.locator('#applications')).toHaveCount(1);
  await expect(page.locator('#routing-cards')).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Applications', exact: true })).toHaveAttribute('aria-current', 'page');
  await nav.getByRole('link', { name: 'Message reviews', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/message-reviews\/?$/);
  await expect(page.locator('#routing-cards')).toHaveCount(1);
  await expect(page.locator('#applications')).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Message reviews', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
