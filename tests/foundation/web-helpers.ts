import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BASELINE,envelope,commandNames } from '../../packages/contracts/src/index.ts';
import type { Operation } from '../../packages/contracts/src/index.ts';
import { startHttp } from '../../apps/api/src/http.ts';
import type { WebOptions } from '../../apps/api/src/http.ts';
import type { fixture } from './helpers.ts';
export async function web(f: Awaited<ReturnType<typeof fixture>>,options:Pick<WebOptions,'legacy'|'producer'>={}) {
  const personas=Object.fromEntries([['buyer-agent','Buyer agent · draft demand'],['buyer','Buyer human · review & publish'],['producer-a','Producer A · reviewed fixture'],['producer-b','Producer B · reviewed fixture']].map(([id,label]) => [id!,{ label:label!,token:f.token(id!) }]));
  const api=await startHttp(f.connectionString,'local_test',{ personas,...options }); f.cleanupWith(() => api.close()); return api;
}
export async function browserSession(url: string,persona: string) {
  const boot=await fetch(`${url}/session`); const anonymous=await boot.json(); const cookie=boot.headers.get('set-cookie')!.split(';')[0]!;
  const response=await fetch(`${url}/session`,{ method:'POST',headers:{ cookie,origin:url,'content-type':'application/json','x-csrf-token':anonymous.csrf },body:JSON.stringify({ persona }) });
  const value=await response.json(); if (!response.ok) throw new Error('Fixture session exchange failed.');
  const signedCookie=response.headers.get('set-cookie')!.split(';')[0]!;
  const headers={ cookie:signedCookie,origin:url,'content-type':'application/json','x-csrf-token':value.csrf };
  const call=async (operation: Operation,input: unknown,overrides: Record<string,string>={},splitAfter?: number) => {
    const command=(commandNames as readonly string[]).includes(operation);
    const body=Buffer.from(JSON.stringify(input));
    return await new Promise<{ status:number; receipt:ReturnType<typeof envelope.parse> }>((resolve,reject) => {
      const req=request(`${url}/${command ? 'commands' : 'queries'}/${operation}`,{ method:'POST',headers:{ ...headers,'content-length':Buffer.byteLength(body),...overrides } },response => {
        const chunks: Buffer[]=[]; response.on('data',bytes => { chunks.push(bytes); }); response.on('error',reject);
        response.on('end',() => { try { resolve({ status:response.statusCode!,receipt:envelope.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }); } catch (e) { reject(e); } });
      }); req.on('error',reject);
      if (splitAfter === undefined) req.end(body);
      else { req.write(body.subarray(0,splitAfter)); setTimeout(() => req.end(body.subarray(splitAfter)),10); }
    });
  };
  return { cookie:signedCookie,headers,call };
}
export async function mcp(f: Awaited<ReturnType<typeof fixture>>,actor: string) {
  const client=new Client({ name:'web-parity-client',version:BASELINE },{ versionNegotiation:{ mode:{ pin:'2026-07-28' } } });
  const transport=new StdioClientTransport({ command:process.execPath,args:['dist/apps/api/src/stdio.js'],env:{ VV_DATABASE_URL:f.connectionString,VV_FIXTURE_MODE:'local_test',VV_FIXTURE_CREDENTIAL:f.token(actor) },stderr:'pipe' });
  f.cleanupWith(() => client.close()); await client.connect(transport,{ timeout:5000 });
  return { call:async (operation: Operation,input: unknown) => envelope.parse((await client.callTool({ name:operation,arguments:input as Record<string,unknown> })).structuredContent) };
}
