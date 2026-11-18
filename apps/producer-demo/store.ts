import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {closeSync,existsSync,lstatSync,openSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
import {exchangeSchema,viewSchema,ProducerError} from './protocol.ts';
import type {Exchange,ExchangeView} from './protocol.ts';

const applicationId=0x56565052; // VVPR: never initialize an unrelated database.
const ownerSchema=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,99}$/);
const simulationSchema=z.strictObject({commandId:z.uuid(),delays:z.tuple([z.number().int().positive().max(60000),z.number().int().positive().max(60000)])});
export type ProducerRecord={owner:string;exchange:Exchange;simulation:z.infer<typeof simulationSchema>|null};
type Row=Record<string,unknown>;

/** Producer-owned state only. No marketplace connection, credentials or migration. */
export class ProducerStore{
  #db:DatabaseSync;
  #healthy=true;
  readonly runId:string;
  constructor(stateFile?:string){
    let fresh=stateFile===undefined;
    if(stateFile!==undefined){
      if(!isAbsolute(stateFile))throw new Error('Producer state file must be absolute');
      if(existsSync(stateFile)){
        const stat=lstatSync(stateFile);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Invalid producer state file');
      }else{closeSync(openSync(stateFile,'wx',0o600));fresh=true;}
    }
    this.#db=new DatabaseSync(stateFile??':memory:',{timeout:1000});
    try{
      this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF');
      this.#db.exec('BEGIN IMMEDIATE');
      const id=this.#db.prepare('PRAGMA application_id').get()!.application_id;
      const tables=this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
      if(fresh&&id===0&&tables.length===0){
        this.#db.exec(`
          CREATE TABLE producer_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),run_id TEXT NOT NULL);
          CREATE TABLE producer_exchanges(request_id TEXT PRIMARY KEY,owner TEXT NOT NULL,exchange_json TEXT NOT NULL,simulation_json TEXT,UNIQUE(owner,request_id));
          CREATE TABLE producer_replays(owner TEXT NOT NULL,command_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,receipt_json TEXT NOT NULL,
            PRIMARY KEY(owner,command_id),FOREIGN KEY(owner,request_id) REFERENCES producer_exchanges(owner,request_id));
          PRAGMA application_id=${applicationId}; PRAGMA user_version=1;
        `);
        this.#db.prepare('INSERT INTO producer_meta VALUES(1,?)').run(randomUUID());
      }else if(id!==applicationId||JSON.stringify(tables)!==JSON.stringify(['producer_exchanges','producer_meta','producer_replays'])
        ||this.#db.prepare('PRAGMA user_version').get()!.user_version!==1)throw new Error('Unrecognized producer state');
      this.runId=z.uuid().parse(this.#db.prepare('SELECT run_id FROM producer_meta WHERE singleton=1').get()?.run_id);
      this.#validate();
      this.#db.exec('COMMIT');
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      if(this.#db.prepare('PRAGMA quick_check').get()!.quick_check!=='ok')throw new Error('Producer integrity check failed');
    }catch{
      if(this.#db.isTransaction)this.#db.exec('ROLLBACK');this.#db.close();throw new Error('Producer state unavailable or invalid; no reset performed');
    }
  }
  #record(row:Row):ProducerRecord{
    const owner=ownerSchema.parse(row.owner),exchange=exchangeSchema.parse(JSON.parse(String(row.exchange_json)));
    const simulation=row.simulation_json===null?null:simulationSchema.parse(JSON.parse(String(row.simulation_json)));
    if(row.request_id!==exchange.requestId||exchange.runId!==this.runId||Boolean(exchange.job)!==Boolean(simulation))throw new Error('Invalid producer record');
    if(exchange.job){
      const sequence=exchange.job.state==='queued'?1:exchange.job.state==='printing'?2:3;
      if(exchange.job.sequence!==sequence||exchange.messages.length!==4+sequence||exchange.job.quoteId!==exchange.quote.quoteId
        ||exchange.messages[2]?.correlationId!==simulation!.commandId)throw new Error('Invalid producer checkpoint');
    }else if(exchange.messages.length!==2)throw new Error('Invalid quote checkpoint');
    return{owner,exchange,simulation};
  }
  #validate(){
    if(this.recordCount()>100||this.replayCount()>300)throw new Error('Producer bounds exceeded');
    for(const row of this.#db.prepare('SELECT * FROM producer_exchanges').iterate())this.#record(row);
    for(const row of this.#db.prepare('SELECT * FROM producer_replays').iterate()){
      const owner=ownerSchema.parse(row.owner);z.uuid().parse(row.command_id);z.string().regex(/^[a-f0-9]{64}$/).parse(row.fingerprint);
      const receipt=viewSchema.parse(JSON.parse(String(row.receipt_json))),record=this.get(owner,String(row.request_id));
      if(!record||!receipt.exchange||receipt.runId!==this.runId||receipt.exchange.runId!==this.runId
        ||receipt.exchange.requestId!==record.exchange.requestId||receipt.exchange.quote.termsDigest!==record.exchange.quote.termsDigest)throw new Error('Invalid replay checkpoint');
    }
    if(this.#db.prepare('PRAGMA foreign_key_check').get())throw new Error('Invalid producer references');
  }
  get healthy(){return this.#healthy;}
  /** Every command/transition and its receipt commit together before any reply. */
  transaction<T>(action:()=>T,write=true):T{
    if(!this.#healthy)throw new ProducerError('UNAVAILABLE');
    try{this.#db.exec(write?'BEGIN IMMEDIATE':'BEGIN');const result=action();this.#db.exec('COMMIT');return result;}
    catch(error){
      try{if(this.#db.isTransaction)this.#db.exec('ROLLBACK');}catch{this.#healthy=false;}
      if(error instanceof ProducerError)throw error;
      this.#healthy=false;throw new ProducerError('UNAVAILABLE');
    }
  }
  recordCount(){return Number(this.#db.prepare('SELECT count(*) AS n FROM producer_exchanges').get()!.n);}
  replayCount(){return Number(this.#db.prepare('SELECT count(*) AS n FROM producer_replays').get()!.n);}
  get(owner:string,id:string){const row=this.#db.prepare('SELECT * FROM producer_exchanges WHERE owner=? AND request_id=?').get(owner,id);return row?this.#record(row):undefined;}
  recent(owner:string){return this.#db.prepare('SELECT * FROM producer_exchanges WHERE owner=? ORDER BY rowid DESC LIMIT 10').all(owner).map(row=>{const {exchange:e}=this.#record(row);return{requestId:e.requestId,need:e.brief.need,state:e.job?.state??'quoted'};});}
  active(){return this.#db.prepare('SELECT * FROM producer_exchanges WHERE simulation_json IS NOT NULL').all().map(row=>this.#record(row)).filter(r=>r.exchange.job?.state==='queued'||r.exchange.job?.state==='printing');}
  insert(record:ProducerRecord){this.#db.prepare('INSERT INTO producer_exchanges VALUES(?,?,?,?)').run(record.exchange.requestId,record.owner,JSON.stringify(record.exchange),record.simulation?JSON.stringify(record.simulation):null);}
  save(record:ProducerRecord){this.#db.prepare('UPDATE producer_exchanges SET exchange_json=?,simulation_json=? WHERE owner=? AND request_id=?').run(JSON.stringify(record.exchange),record.simulation?JSON.stringify(record.simulation):null,record.owner,record.exchange.requestId);}
  replay(owner:string,command:string){const row=this.#db.prepare('SELECT fingerprint,receipt_json FROM producer_replays WHERE owner=? AND command_id=?').get(owner,command);return row?{fingerprint:String(row.fingerprint),receipt:viewSchema.parse(JSON.parse(String(row.receipt_json)))}:undefined;}
  remember(owner:string,command:string,fingerprint:string,receipt:ExchangeView){this.#db.prepare('INSERT INTO producer_replays VALUES(?,?,?,?,?)').run(owner,command,receipt.exchange!.requestId,fingerprint,JSON.stringify(receipt));}
  close(){this.#healthy=false;this.#db.close();}
}
