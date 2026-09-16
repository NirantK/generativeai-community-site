import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const group={id:'a'.repeat(64),title:'Test community',published:1,messageCount:2,firstMessageAt:1,lastMessageAt:2,importedAt:3,coverageNote:'Synthetic history'};
const message={id:'b'.repeat(64),groupTitle:group.title,author:'Test Member',postedAt:1789430400000,text:'Retrieval project <img src=x onerror=alert(1)>'};
test('members search, filter, paginate and read plain-text context',async({page})=>{
 let searched=false;
 await page.route('**/api/v1/chats/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname.endsWith('/groups'))return route.fulfill({json:{groups:[group]}});
  if(url.pathname.includes('/messages/'))return route.fulfill({json:{message,before:[],after:[]}});
  if(url.searchParams.get('q')){expect(url.searchParams.get('q')).toBe('retrieval');expect(url.searchParams.get('group')).toBe(group.id);expect(url.searchParams.get('from')).toBe('2026-09-01');searched=true;}
  return route.fulfill({json:{messages:[message],nextCursor:url.searchParams.has('cursor')?null:'next-page'}});
 });
 await page.goto('/past-chats');
 await expect(page.getByText(message.text,{exact:true})).toBeVisible();
 expect(await page.locator('#chat-results img').count()).toBe(0);
 await page.getByLabel('Search messages').fill('retrieval');
 await page.getByLabel('Group',{exact:true}).selectOption(group.id);
 await page.getByLabel('From',{exact:true}).fill('2026-09-01');
 await page.getByRole('button',{name:'Search chats'}).click();
 await expect.poll(()=>searched).toBe(true);
 await page.getByRole('button',{name:'Load more messages'}).click();
 await expect(page.locator('#chat-results article')).toHaveCount(2);
 await page.getByRole('button',{name:'Read in context'}).first().click();
 await expect(page.getByRole('heading',{name:'Conversation context'})).toBeVisible();
 const violations=(await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa']).analyze()).violations;
 expect(violations.filter(v=>['serious','critical'].includes(v.impact??''))).toEqual([]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
test('membership denial exposes no results',async({page})=>{
 await page.route('**/api/v1/chats/**',route=>route.fulfill({status:403,json:{error:{message:'Approved membership is required.'}}}));
 await page.goto('/past-chats');
 await expect(page.getByRole('status')).toHaveText('Approved membership is required.');
 await expect(page.locator('#chat-results article')).toHaveCount(0);
});
test('admin can unpublish a group and hide a message',async({page})=>{
 let unpublished=false,hidden=false;
 await page.route('**/api/admin/chats/**',async route=>{
  if(route.request().method()==='POST'){expect(route.request().postDataJSON()).toEqual({published:false});unpublished=true;return route.fulfill({json:{published:false}});}
  if(route.request().method()==='DELETE'){hidden=true;return route.fulfill({json:{hidden:true}});}
  return route.fulfill({json:route.request().url().endsWith('/groups')?{groups:[group]}:{messages:[message],nextCursor:null}});
 });
 await page.goto('/admin/chats');
 await page.getByRole('button',{name:'Unpublish group'}).click();
 await expect(page.getByRole('button',{name:'Publish group',exact:true})).toBeVisible();
 expect(unpublished).toBe(true);
 await page.getByRole('button',{name:'Hide message'}).click();
 await expect(page.locator('#chat-results article')).toHaveCount(0);
 expect(hidden).toBe(true);
});
