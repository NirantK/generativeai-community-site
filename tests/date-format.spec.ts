import { test, expect } from '@playwright/test';
import { formatDate, formatDateTime, parseDateInput } from '../src/lib/dates';
test.use({ locale: 'en-US', timezoneId: 'America/Los_Angeles' });
test('IST display crosses UTC midnight and year boundaries with fixed Sep notation', () => {
  expect(formatDateTime('2026-09-14T20:00:00Z')).toBe('15 Sep 2026, 01:30 IST');
  expect(formatDate('2026-12-31T20:00:00Z')).toBe('1 Jan 2027');
  expect(formatDateTime('invalid')).toBe('Date unavailable');
  expect(parseDateInput('15 Sep 2026')).toBe('2026-09-15');
  expect(parseDateInput('31 Sep 2026')).toBeNull();
  expect(parseDateInput('29 Feb 2026')).toBeNull();
});
test('archive timestamp uses IST despite a US browser locale and timezone', async ({ page }) => {
  await page.route('**/api/v1/chats/**', route => route.fulfill({json:route.request().url().endsWith('/groups') ? {groups:[{id:'a'.repeat(64),title:'Example',messageCount:1}]} : {messages:[{id:'b'.repeat(64),author:'Example',postedAt:Date.parse('2026-09-14T20:00:00Z'),text:'Example'}],nextCursor:null}}));
  await page.goto('/past-chats');
  await expect(page.locator('.chat-meta')).toHaveText('Example · 15 Sep 2026, 01:30 IST');
});
