import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup,snapshot,settled} from './market-browser-helpers.ts';
import {financialSnapshot,marketSnapshot} from './market-helpers.ts';

for(const width of [1440,390])test(`simple market ${width}: three tabs, category filtering, keyboard selection, detail action and no browsing mutations`,{timeout:60000},async t=>{
  const f=await setup(t),{page}=await f.page('buyer',{width,height:1000},width===390),financial=await financialSnapshot(f),before=await marketSnapshot(f);
  const nav=page.getByRole('navigation',{name:'Market workspace'});assert.deepEqual(await nav.getByRole('link').allTextContents(),['Buy','Work Orders','My Orders']);
  await page.getByRole('heading',{name:'Buy',exact:true}).waitFor();assert.equal(await page.locator('.market-stats').count(),0);
  await snapshot(page,`simple-buy-${width}.png`);
  if(width===390)await page.getByRole('button',{name:'Categories & filters'}).click();
  const categories=page.getByRole('complementary',{name:'Categories'});await categories.getByRole('button').nth(1).click();
  if(width===390)await page.getByRole('button',{name:'Categories & filters'}).click();
  assert.equal(await categories.getByRole('button',{pressed:true}).count(),1);
  if(width===390)await page.getByRole('button',{name:'Categories & filters'}).click();
  const row=page.locator('.auction-results').getByRole('button',{name:/^Select /}).first();await row.focus();await page.keyboard.press('Space');
  const detail=page.getByRole('region',{name:'Selected listing'});await detail.getByRole('link',{name:'Review supply →'}).waitFor();
  assert.equal(await detail.getByText('More details',{exact:true}).count(),1);assert.equal(await detail.getByText(/Record /).isVisible(),false);
  if(width===390){assert.equal(await page.locator('.auction-results').isVisible(),false);assert.equal(await detail.getByRole('heading').evaluate(el=>el===document.activeElement),true);}
  await snapshot(page,`simple-buy-detail-${width}.png`);
  await detail.getByRole('link',{name:'Review supply →'}).click();await settled(page);await page.getByRole('heading',{name:'Propose an input purchase',exact:true}).waitFor();await page.reload();await settled(page);
  await nav.getByRole('link',{name:'Work Orders',exact:true}).click();await settled(page);await page.getByRole('heading',{name:'Work orders',exact:true}).waitFor();
  await snapshot(page,`simple-work-orders-${width}.png`);await page.locator('.auction-results').getByRole('button',{name:/^Select /}).first().click();
  await page.getByRole('link',{name:'Review need →'}).waitFor();await snapshot(page,`simple-work-detail-${width}.png`);
  if(width===390){await page.getByRole('button',{name:'← Back to listings',exact:true}).click();await page.waitForFunction(()=>Boolean(document.activeElement?.closest('.auction-results')));assert.equal(await page.locator('.auction-results').getByRole('button',{name:/^Select /}).first().evaluate(el=>el===document.activeElement),true);}
  await nav.getByRole('link',{name:'My Orders',exact:true}).click();await settled(page);await page.getByRole('heading',{name:'My orders',exact:true}).waitFor();await snapshot(page,`simple-my-orders-${width}.png`);
  assert.deepEqual(await financialSnapshot(f),financial);assert.deepEqual(await marketSnapshot(f),before);
});
