import { test, expect } from '@playwright/test';

test('footer legal links navigate and the LinkedIn link targets the verified community page', async ({ page }) => {
  await page.goto('/');
  const footer = page.getByRole('contentinfo');
  await footer.getByRole('link', { name: 'PRIVACY', exact: true }).click();
  await expect(page).toHaveURL(/\/privacy-policy$/);
  await expect(page.getByRole('heading', { name: 'Privacy Policy', exact: true })).toBeVisible();
  await footer.getByRole('link', { name: 'TERMS', exact: true }).click();
  await expect(page).toHaveURL(/\/terms-and-conditions$/);
  await expect(page.getByRole('heading', { name: 'Terms & Conditions', exact: true })).toBeVisible();

  // The personal-account smoke test is one-time. CI never contacts LinkedIn,
  // stores its cookies, or requires an account; it tests the actual link navigation.
  const communityUrl = 'https://www.linkedin.com/company/genaicommunity/';
  await page.route('https://www.linkedin.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<h1>LinkedIn destination fixture</h1>',
  }));
  await footer.getByRole('link', { name: 'GenerativeAI Community on LinkedIn', exact: true }).click();
  await expect(page).toHaveURL(communityUrl);
  await expect(page.getByRole('heading', { name: 'LinkedIn destination fixture' })).toBeVisible();
});
