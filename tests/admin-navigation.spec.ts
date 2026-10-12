import { test, expect } from '@playwright/test';

test('left workspace navigation separates application, routing and role views', async ({ page }) => {
  await page.route('**/api/admin/**', route => route.fulfill({ json: { applications: [], invitations: [], reports: [], groups: [], cards: [], available: 0 } }));
  await page.route('**/api/app/access', r=>r.fulfill({json:{administrator:true,status:'approved'}}));
  await page.goto('/app/applications');
  await expect(page.getByRole('heading', { name: 'Application review', exact: true })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
  await nav.getByRole('link', { name: 'Applications', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/applications\/?$/);
  await expect(page.locator('#applications')).toHaveCount(1);
  await expect(page.locator('#routing-cards')).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Applications', exact: true })).toHaveAttribute('aria-current', 'page');
  await nav.getByRole('link', { name: 'Message Review', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/message-review\/?$/);
  await expect(page.locator('#routing-cards')).toHaveCount(1);
  await expect(page.locator('#applications')).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Message Review', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.route('**/api/admin/members*', r=>r.fulfill({json:{members:[{id:'member',name:'Current builder',email:'builder@example.com',role:'Member',linkedinUrl:'https://www.linkedin.com/in/builder/'}],administrators:['owner@example.com'],nextCursor:null}}));
  await nav.getByRole('link', {name:'Roles',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Current builder'})).toBeVisible();
  await expect(page.getByRole('link',{name:'LinkedIn profile'})).toHaveAttribute('href','https://www.linkedin.com/in/builder/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
