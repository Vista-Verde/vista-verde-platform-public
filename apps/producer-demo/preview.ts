import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {ProducerClient} from './requester.ts';
import {ProducerError} from './protocol.ts';
import type {ProducerAction} from './protocol.ts';
import {readProducerJson,sendProducerError} from './server.ts';

/** Disposable independent UI/requester. No market database or grants; loopback only. */
export async function startProducerPreview(client:ProducerClient,port=0){
  const csrf=randomBytes(24).toString('hex');let authority='';
  const root=new URL(import.meta.url.endsWith('.ts')?'../../dist/apps/web/':'../../web/',import.meta.url);
  const policy="default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";
  const assets=new Map([['/',['text/html; charset=utf-8',Buffer.from('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Independent synthetic producer exchange</title><link rel="stylesheet" href="/style.css"></head><body><main id="root"></main><script type="module" src="/producer-exchange.js"></script></body></html>')]],
    ['/producer-exchange.js',['text/javascript; charset=utf-8',readFileSync(new URL('producer-exchange.js',root))]],['/style.css',['text/css; charset=utf-8',readFileSync(new URL('style.css',root))]]] as const);
  const server=createServer(async(req,res)=>{try{
    if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==authority||req.headers.origin&&req.headers.origin!==`http://${authority}`)throw new ProducerError('FORBIDDEN');
    res.setHeader('cache-control','no-store');res.setHeader('content-security-policy',policy);res.setHeader('x-content-type-options','nosniff');
    const asset=assets.get(req.url as '/');if(asset&&req.method==='GET'){res.writeHead(200,{'content-type':asset[0]});res.end(asset[1]);return;}
    if(req.method==='GET'&&req.url==='/preview-context'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({csrf}));return;}
    const action=req.url?.match(/^\/producer-demo\/(read|submit|accept)$/)?.[1] as ProducerAction|undefined;
    if(req.method!=='POST'||!action||req.headers.origin!==`http://${authority}`||req.headers['x-csrf-token']!==csrf)throw new ProducerError('FORBIDDEN');
    const output=await client.call('independent-preview',action,await readProducerJson(req));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(output));
  }catch(error){sendProducerError(res,error);}});
  server.requestTimeout=3000;server.headersTimeout=3000;server.listen(port,'127.0.0.1');await once(server,'listening');
  const address=server.address();if(!address||typeof address==='string')throw new Error('Preview unavailable');authority=`127.0.0.1:${address.port}`;
  return{url:`http://${authority}`,async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const preview=await startProducerPreview(new ProducerClient('http://127.0.0.1:4320'),4321);
  console.log(`Independent synthetic requester/UI ready at ${preview.url}; producer must run separately on loopback:4320.`);
  process.once('SIGINT',()=>{void preview.close();});process.once('SIGTERM',()=>{void preview.close();});
}
