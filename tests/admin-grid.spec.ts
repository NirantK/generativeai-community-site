import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('approved grid defaults to newest approvals and exposes supplied LinkedIn links',async({page},info)=>{
 await page.route('**/api/admin/bug-reports',r=>r.fulfill({json:{reports:[]}}));
 await page.route('**/api/admin/invitations',r=>r.fulfill({json:{invitations:[]}}));
 await page.route('**/api/admin/applications*',r=>{
  const approved=new URL(r.request().url()).searchParams.get('status')==='approved';
  return r.fulfill({json:{applications:approved?[
   {id:'a'.repeat(64),name:'Recent Member',status:'approved',delivery:'accepted',approved_at:1789603200000,linkedin_url:'https://www.linkedin.com/in/recent-member/'},
   {id:'b'.repeat(64),name:'Earlier Member With A Long Name',status:'approved',delivery:'accepted',approved_at:1789516800000,linkedin_url:null},
   {id:'c'.repeat(64),name:'Another Member',status:'approved',delivery:'paused',approved_at:1789430400000,linkedin_url:'javascript:alert(1)'}
  ]:[]}});
 });
 await page.goto('/admin');
 await expect(page.getByLabel('Show applications')).toHaveValue('approved');
 await expect(page.locator('.application-card')).toHaveCount(3);
 await expect(page.locator('.application-card').first()).toContainText('Recent Member');
 await expect(page.getByRole('link',{name:'View LinkedIn profile'})).toHaveAttribute('href','https://www.linkedin.com/in/recent-member/');
 await expect(page.getByText('LinkedIn profile: Not provided')).toHaveCount(2);
 const columns=await page.locator('#applications').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length);
 expect(columns).toBe(info.project.name==='desktop'?3:1);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa']).analyze();expect(axe.violations.filter(v=>['serious','critical'].includes(v.impact??''))).toEqual([]);
 if(['desktop','iphone-se'].includes(info.project.name))await page.screenshot({path:`.shots/admin-grid-${info.project.name}.png`,fullPage:true});
 await page.getByLabel('Show applications').selectOption('review');
 await expect(page.getByText('No applications in this view.').first()).toBeVisible();
 await expect(page.locator('.application-card')).toHaveCount(0);
});
