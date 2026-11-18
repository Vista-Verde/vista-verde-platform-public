import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import type { AxeResults } from 'axe-core';
import type { Envelope,Operation } from '../../packages/contracts/src/index.ts';
import { envelope } from '../../packages/contracts/src/index.ts';
import { fixture,ok } from './helpers.ts';
import { web } from './web-helpers.ts';

const axeSource=readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'),'utf8');
const artifacts=resolve(process.env.VV_WEB_ARTIFACTS ?? 'web-artifacts');mkdirSync(artifacts,{recursive:true});
export async function settled(page:Page){await page.locator('#market-app[aria-busy="false"]').waitFor();}
export async function setup(t:Parameters<typeof fixture>[0]){
  const f=await fixture(t),api=await web(f),browser=await chromium.launch();f.cleanupWith(()=>browser.close());const errors:string[]=[];
  async function page(persona:string,viewport={width:1440,height:1080},mobile=false){
    const context=await browser.newContext({viewport,...(mobile?{isMobile:true,hasTouch:true}:{})}),page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(api.url);
    const labels:Record<string,string>={'buyer-agent':'Buyer agent · draft demand','buyer':'Buyer human · review & publish','producer-a':'Producer A · reviewed fixture','producer-b':'Producer B · reviewed fixture'};
    await page.getByRole('button',{name:labels[persona]!,exact:false}).click();await page.getByRole('navigation',{name:'Market workspace'}).waitFor();await settled(page);return{page,context};
  }
  t.after(()=>assert.deepEqual(errors,[],'The real market browser has no runtime errors'));return{...f,api,browser,page};
}
export async function switchTo(page:Page,persona:string){
  await page.getByLabel('Demo participant',{exact:true}).selectOption(persona);
  await page.waitForFunction(value=>document.querySelector('#market-app')?.getAttribute('data-persona')===value&&document.querySelector('#market-app')?.getAttribute('aria-busy')==='false',persona);
}
export async function route(page:Page,url:string,hash:string){await page.goto(`${url}/#${hash}`);await settled(page);}
export async function submitted(page:Page,operation:Operation,action:()=>Promise<unknown>):Promise<Envelope>{
  const response=page.waitForResponse(reply=>reply.url().endsWith(`/commands/${operation}`)&&reply.request().method()==='POST');await action();const receipt=envelope.parse(await(await response).json());await settled(page);return receipt;
}
export async function confirm(page:Page){
  await page.getByLabel('I approve these frozen terms for my business.',{exact:true}).check();return ok(await submitted(page,'confirmMarketProposal',()=>page.getByRole('button',{name:'Confirm frozen terms',exact:true}).click()));
}
export async function report(page:Page,value:number){
  await page.getByLabel('Report quantity (each)',{exact:true}).fill(String(value));await page.getByLabel('Report note',{exact:true}).fill(`Synthetic browser report of ${value} each.`);
  return ok(await submitted(page,'reportMarketFulfillment',()=>page.getByRole('button',{name:'Report fulfillment',exact:true}).click()));
}
export async function acknowledge(page:Page,value:number){return ok(await submitted(page,'acknowledgeMarketFulfillment',()=>page.getByRole('button',{name:`Acknowledge ${value} each`,exact:true}).click()));}
export async function snapshot(page:Page,name:string){
  await page.evaluate(axeSource);const results=await page.evaluate(async()=>{
    const checker=(window as unknown as{axe:{run:(root:Document,options:unknown)=>Promise<AxeResults>}}).axe;
    return await checker.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}});
  });
  assert.deepEqual(results.violations.map(v=>({id:v.id,nodes:v.nodes.map(node=>node.target)})),[],`Automated accessibility in ${name}`);
  const width=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));assert.ok(width.scroll<=width.client,`No horizontal overflow in ${name}: ${JSON.stringify(await page.evaluate(()=>Array.from(document.querySelectorAll('main *')).filter(el=>el.getBoundingClientRect().right>document.documentElement.clientWidth+1).slice(0,12).map(el=>({tag:el.tagName,class:el.className,width:Math.round(el.getBoundingClientRect().width)}))))}`);
  assert.match(await page.getByRole('banner').innerText(),/Vista Verde/);
  // Audit the visible notification too, then dismiss it so the exported proof
  // leaves budgets and conservation text readable beneath the transient toast.
  const dismiss=page.getByRole('button',{name:'Dismiss notification',exact:true});if(await dismiss.count())await dismiss.click();
  await page.screenshot({path:resolve(artifacts,name),fullPage:true});
}
