import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { envelope,marketOrderSchema,marketCommitmentSchema } from '../../packages/contracts/src/index.ts';
import type { Operation } from '../../packages/contracts/src/index.ts';
import { ok } from './helpers.ts';

// Run only with a page whose owner sign-in is already established by the caller.
// The journey never reads, prints, copies or stores Access assertions/cookies.
export async function ownerWorkJourney(page:Page,options:{origin:string;need:string;appPath?:'/'|'/app'}){
  const base=new URL(options.appPath??'/app',options.origin).toString();
  const labels:Record<string,string>={'buyer-agent':'Buyer agent · draft demand','buyer':'Buyer human · review & publish','producer-a':'Producer A · reviewed fixture'};
  const busy=()=>page.locator('#market-app[aria-busy="false"]').waitFor();
  const navigate=async(hash:string)=>{await page.goto(`${base}#${hash}`);await busy();};
  const persona=async(actor:string)=>{
    const selector=page.getByLabel('Demo participant',{exact:true});
    await selector.or(page.getByRole('button',{name:labels[actor]!,exact:false})).first().waitFor();
    if(await selector.count())await selector.selectOption(actor);
    else await page.getByRole('button',{name:labels[actor]!,exact:false}).click();
    await page.waitForFunction(value=>document.querySelector('#market-app')?.getAttribute('data-persona')===value&&document.querySelector('#market-app')?.getAttribute('aria-busy')==='false',actor);
  };
  const command=async(operation:Operation,click:()=>Promise<unknown>)=>{
    const pending=page.waitForResponse(response=>response.url().endsWith(`/commands/${operation}`)&&response.request().method()==='POST');
    await click();const response=await pending;assert.equal(response.status(),200);const receipt=ok(envelope.parse(await response.json()));await busy();return receipt;
  };
  const consent=async()=>{
    await page.getByLabel('I approve these frozen terms for my business.',{exact:true}).check();
    return command('confirmMarketProposal',()=>page.getByRole('button',{name:'Confirm frozen terms',exact:true}).click());
  };
  await page.goto(base);await persona('buyer-agent');await navigate('post-work/PANEL-DEMO');
  await page.getByLabel('Concrete need',{exact:true}).fill(options.need);await page.getByLabel('Quantity (each)',{exact:true}).fill('12');
  await page.getByLabel('Total budget (USD)',{exact:true}).fill('1200.00');await page.getByLabel('Delivery location',{exact:true}).fill('Synthetic owner demo receiving site');
  await page.getByLabel('Work order terms',{exact:true}).fill('Synthetic owner demonstration only; counted fulfillment and explicit receiver acknowledgement.');
  const posted=await command('postWorkOrder',()=>page.getByRole('button',{name:'Post work order',exact:true}).click()),workOrderId=posted.recordIds.workOrderId!;
  assert.ok(workOrderId);assert.equal(marketOrderSchema.parse(posted.data.order).budgetCommitted?.minorUnits,0);
  await persona('producer-a');await navigate(`work/${workOrderId}`);
  await page.getByLabel('Response quantity (each)',{exact:true}).fill('8');await page.getByLabel('Response unit price (USD)',{exact:true}).fill('90.00');
  await page.getByLabel('Response origin',{exact:true}).fill('Synthetic owner demo workshop');
  await page.getByLabel('Response terms',{exact:true}).fill('Synthetic private production response; all-in output price, separate receiver acknowledgement.');
  const proposed=await command('respondToWorkOrder',()=>page.getByRole('button',{name:'Propose producer response',exact:true}).click()),proposalId=proposed.recordIds.proposalId!;
  assert.ok(proposalId);assert.equal((proposed.data.proposal as {buyerApproved:boolean}).buyerApproved,false);assert.equal((proposed.data.proposal as {sellerApproved:boolean}).sellerApproved,false);
  await persona('buyer');await navigate(`proposal/${proposalId}`);const approved=await consent();assert.equal(approved.state,'partially_approved');assert.equal(approved.recordIds.commitmentId,undefined);
  await persona('producer-a');await navigate(`proposal/${proposalId}`);const agreed=await consent(),commitmentId=agreed.recordIds.commitmentId!;assert.ok(commitmentId);
  await navigate(`commitment/${commitmentId}`);await page.getByLabel('Report quantity (each)',{exact:true}).fill('5');
  await page.getByLabel('Report note',{exact:true}).fill('Synthetic partial fulfillment of five counted demo panels.');
  const reported=await command('reportMarketFulfillment',()=>page.getByRole('button',{name:'Report fulfillment',exact:true}).click());
  assert.equal(marketCommitmentSchema.parse(reported.data.commitment).acknowledgedQuantity.value,0);
  await persona('buyer');await navigate(`commitment/${commitmentId}`);
  const acknowledged=await command('acknowledgeMarketFulfillment',()=>page.getByRole('button',{name:'Acknowledge 5 each',exact:true}).click());
  const current=marketCommitmentSchema.parse(acknowledged.data.commitment);assert.equal(current.acknowledgedQuantity.value,5);assert.equal(current.reportedQuantity.value,5);assert.equal(current.remainingQuantity.value,3);assert.equal(current.state,'in_progress');
  await page.reload();await busy();assert.match(await page.locator('main').innerText(),/5.*8|5 each/);
  await navigate(`work/${workOrderId}`);assert.match(await page.locator('main').innerText(),/4 each/);assert.match(await page.locator('main').innerText(),/\$480\.00/);
  return {url:page.url(),workOrderId,proposalId,capacityOfferId:proposed.recordIds.sellOrderId!,commitmentId,
    fulfillmentId:reported.recordIds.fulfillmentId!,quantity:8,reported:5,acknowledged:5,remainingFulfillment:3,remainingWork:4,
    committedBudgetMinorUnits:72000,remainingBudgetMinorUnits:48000,synthetic:true as const};
}
