import { Container } from '@cloudflare/containers';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
const GROUP='80a506e83ca3ccc963bfbbc5493b124e85e5a87d7e074835728a1d78a9b38fca';
const SOURCE='120363049558306142@g.us';
const DAY=86400000;
// Retain the original preflight instance identity: Containers reserves this slot even after stop.
type Row={id:string;group_id:string;source_id:string;posted_at:number;author:string;body:string;hidden:number};
type Export={rows:Row[];coverage:{sourceRef:string;provider:string;cachedRecords:number;messages:number;cutover:string;oldest:string|null;newest:string|null}};
async function digest(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');}

async function checkpointBytes(response:Response){
 if(!response.ok)throw new Error('checkpoint-response-failed');
 const size=Number(response.headers.get('Content-Length'));
 if(!Number.isSafeInteger(size)||size<=0||size>30_000_000)throw new Error('checkpoint-size-invalid');
 const bytes=await response.arrayBuffer();
 if(bytes.byteLength!==size)throw new Error('checkpoint-length-mismatch');
 return bytes;
}
async function storagePreflight(bucket:R2Bucket){
 const key=`tests/checkpoint-${crypto.randomUUID()}`;
 const bytes=new Uint8Array([1,7,19,31]);
 const response=new Response(new ReadableStream({start(c){c.enqueue(bytes);c.close();}}),{headers:{'Content-Length':'4'}});
 try{
  const body=await checkpointBytes(response);
  await bucket.put(key,body);
  const stored=await bucket.get(key);
  if(!stored || Array.from(new Uint8Array(await stored.arrayBuffer())).join()!==bytes.join())throw new Error('checkpoint-roundtrip-failed');
  return {passed:true,streamToR2Roundtrip:true};
 }finally{await bucket.delete(key);}
}

export class WhatsAppContainer extends Container<Env> {
 defaultPort=8080;
 sleepAfter='20m';
 async acquire(owner:string){
  return this.ctx.storage.transaction(async tx=>{
   const lease=await tx.get<{owner:string;expires:number}>('lease');
   if(lease && lease.owner!==owner && lease.expires>Date.now())throw new Error('sync-already-running');
   await tx.put('lease',{owner,expires:Date.now()+60*60_000});
  });
 }
 async release(owner:string){
  await this.ctx.storage.transaction(async tx=>{if((await tx.get<{owner:string}>('lease'))?.owner===owner)await tx.delete('lease');});
 }
 async preflight(){
  if(await this.env.STATE.head('session/recovery-required'))throw new Error('recover-session-before-preflight');
  try {
   await this.startAndWaitForPorts();
   const r=await this.containerFetch('http://container/selftest',{method:'POST'});
   if(!r.ok)throw new Error('container-selftest-failed');
   return await r.json<{passed:boolean;tests:number;wacli:boolean}>();
  }finally{try{await this.stop();}catch{/* Preserve the startup failure when no container exists. */}}
 }
 async saveCheckpoint(){
  if(!this.ctx.container?.running)throw new Error('current-container-session-unavailable');
  const bytes=await checkpointBytes(await this.containerFetch('http://container/checkpoint',{method:'POST'}));
  // Verify an immutable recovery copy before replacing the active checkpoint.
  const key=`session/checkpoints/${crypto.randomUUID()}.tar.gz`;
  await this.env.STATE.put(key,bytes);
  if((await this.env.STATE.head(key))?.size!==bytes.byteLength)throw new Error('checkpoint-verification-failed');
  await this.env.STATE.put('session/latest.tar.gz',bytes);
  if((await this.env.STATE.head('session/latest.tar.gz'))?.size!==bytes.byteLength)throw new Error('active-checkpoint-verification-failed');
  await this.env.STATE.delete('session/recovery-required');
  return {saved:true,bytes:bytes.byteLength};
 }
 async recover(owner:string){
  if((await this.ctx.storage.get<{owner:string}>('lease'))?.owner!==owner)throw new Error('lease-required');
  if(!await this.env.STATE.head('session/recovery-required'))return {saved:false,reason:'recovery-not-required'};
  // Do not start or restore: only the existing container can hold the latest session.
  return this.saveCheckpoint();
 }
 async run(owner:string) {
  if((await this.ctx.storage.get<{owner:string}>('lease'))?.owner!==owner)throw new Error('lease-required');
  let restored=false;
  try {
   if(await this.env.STATE.head('session/recovery-required'))throw new Error('session-recovery-required');
   const snapshot=await this.env.STATE.get('session/latest.tar.gz');
   if(!snapshot || snapshot.size>30_000_000)throw new Error('session-checkpoint-required');
   await this.startAndWaitForPorts();
   const restore=await this.containerFetch('http://container/restore',{method:'POST',headers:{'Content-Length':String(snapshot.size)},body:await snapshot.arrayBuffer()});
   if(!restore.ok)throw new Error('session-restore-failed');
   restored=true;
   await this.env.STATE.put('session/recovery-required',String(Date.now()));
   const response=await this.containerFetch('http://container/sync',{method:'POST'});
   if(!response.ok)throw new Error('wacli-sync-failed');
   const size=Number(response.headers.get('Content-Length'));
   if(!size || size>20_000_000)throw new Error('invalid-export-size');
   const data=await response.json<Export>();
   if(data.coverage.sourceRef!==SOURCE || data.coverage.provider!=='wacli' || data.coverage.cachedRecords<=0 || data.coverage.cachedRecords>=1_000_000 || !Array.isArray(data.rows))throw new Error('invalid-export');
   for(const r of data.rows){
    if(r.group_id!==GROUP || !r.source_id.startsWith('wacli:') || r.id!==await digest(SOURCE+'\0'+r.source_id) || ![0,1].includes(r.hidden) || typeof r.body!=='string' || typeof r.author!=='string' || r.body.length>30000 || r.author.length>200 || (!r.hidden && (!Number.isSafeInteger(r.posted_at)||r.posted_at<=Date.parse('2026-09-17T00:01:16Z')||r.posted_at>Date.now()+DAY)))throw new Error('invalid-export-row');
   }
   // Persist sanitized export before session advancement, so a later D1 failure is recoverable.
   await this.env.STATE.put('pending/export.json',JSON.stringify(data));
   return {records:data.rows.length};
  } finally {
   try {
    if(restored){
     await this.saveCheckpoint();
    }
   } finally {if(!await this.env.STATE.head('session/recovery-required'))await this.stop();}
  }
 }
}
async function metrics(db:D1Database){
 const counts=await db.prepare('SELECT count(*) total,sum(hidden=0) visible,min(CASE WHEN hidden=0 THEN posted_at END) oldest,max(CASE WHEN hidden=0 THEN posted_at END) newest FROM chat_messages WHERE group_id=?').bind(GROUP).first<{total:number;visible:number;oldest:number|null;newest:number|null}>();
 const integrity=await db.prepare('SELECT count(*) missing FROM chat_messages m LEFT JOIN chat_search s ON s.rowid=m.rowid WHERE m.group_id=? AND m.hidden=0 AND (s.rowid IS NULL OR s.body != m.body OR s.author != m.author)').bind(GROUP).first<{missing:number}>();
 const hidden=await db.prepare('SELECT count(*) exposed FROM chat_search s JOIN chat_messages m ON m.rowid=s.rowid WHERE m.group_id=? AND m.hidden=1').bind(GROUP).first<{exposed:number}>();
 if(integrity?.missing!==0||hidden?.exposed!==0)throw new Error('search-index-verification-failed');
 return counts;
}
export class ChatSyncWorkflow extends WorkflowEntrypoint<Env,{force?:boolean;preflight?:boolean;recover?:boolean;storageTest?:boolean}> {
 async run(event:WorkflowEvent<{force?:boolean;preflight?:boolean;recover?:boolean;storageTest?:boolean}>,step:WorkflowStep){
  if(event.payload.storageTest)return step.do('cloud-r2-checkpoint-test',()=>storagePreflight(this.env.STATE));
  if(event.payload.recover){
   const instance=this.env.WACLI.getByName('preflight');
   await instance.acquire(event.instanceId);
   try{return await step.do('recover-current-session',{retries:{limit:0,delay:'1 second'},timeout:'2 minutes'},()=>instance.recover(event.instanceId));}
   finally{await instance.release(event.instanceId);}
  }

  if(event.payload.preflight){
   const instance=this.env.WACLI.getByName('preflight');
   await instance.acquire(event.instanceId);
   try{return await step.do('cloud-container-preflight',()=>instance.preflight());}
   finally{await instance.release(event.instanceId);}
  }
  if(this.env.SYNC_ENABLED!=='true' && !event.payload.force)return {status:'paused'};
  const last=await this.env.STATE.get('last-success.json');
  const previous=last?await last.json<{at:number;digest:string}>():null;
  if(!event.payload.force && previous && Math.floor((Date.now()+19_800_000)/DAY)-Math.floor((previous.at+19_800_000)/DAY)<3)return {status:'not-due'};
  const owner=event.instanceId;
  await step.do('acquire-single-session',()=>this.env.WACLI.getByName('preflight').acquire(owner));
  try {
   // Never overwrite an export awaiting import after a partial failure.
   const pending=await this.env.STATE.head('pending/export.json');
   if(!pending)await step.do('sync-wacli',{retries:{limit:0,delay:'1 second'},timeout:'20 minutes'},()=>this.env.WACLI.getByName('preflight').run(owner));
   return await step.do('import-and-verify',{retries:{limit:2,delay:'30 seconds'},timeout:'10 minutes'},async()=>{
    if(await this.env.STATE.head('session/recovery-required'))throw new Error('session-recovery-required');
    const object=await this.env.STATE.get('pending/export.json');
    if(!object || object.size>20_000_000)throw new Error('missing-export');
    const data=await object.json<Export>();
    const hash=await digest(JSON.stringify(data.rows));
    const before=await metrics(this.env.DB);
    const group=await this.env.DB.prepare('SELECT published FROM chat_groups WHERE id=? AND source_ref=?').bind(GROUP,SOURCE).first();
    if(!group)throw new Error('archive-group-missing');
    if(hash!==previous?.digest){
     for(let offset=0;offset<data.rows.length;offset+=20){
      const statements:D1PreparedStatement[]=[];
      for(const r of data.rows.slice(offset,offset+20)){
       statements.push(this.env.DB.prepare('DELETE FROM chat_search WHERE rowid=(SELECT rowid FROM chat_messages WHERE id=?)').bind(r.id));
       statements.push(this.env.DB.prepare(`INSERT INTO chat_messages(id,group_id,source_id,posted_at,author,body,hidden) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET posted_at=CASE WHEN excluded.hidden=1 THEN chat_messages.posted_at ELSE excluded.posted_at END,author=CASE WHEN excluded.hidden=1 THEN '' WHEN chat_messages.hidden=0 THEN excluded.author ELSE chat_messages.author END,body=CASE WHEN excluded.hidden=1 THEN '' WHEN chat_messages.hidden=0 THEN excluded.body ELSE chat_messages.body END,hidden=MAX(chat_messages.hidden,excluded.hidden)`).bind(r.id,GROUP,r.source_id,r.posted_at,r.author,r.body,r.hidden));
       statements.push(this.env.DB.prepare('INSERT INTO chat_search(rowid,body,author) SELECT rowid,body,author FROM chat_messages WHERE id=? AND hidden=0').bind(r.id));
      }
      await this.env.DB.batch(statements);
     }
    }
    const after=await metrics(this.env.DB);
    await this.env.DB.prepare('UPDATE chat_groups SET imported_at=? WHERE id=?').bind(Date.now(),GROUP).run();
    const result={status:hash===previous?.digest?'unchanged':'synced',at:Date.now(),digest:hash,records:data.rows.length,before,after,coverage:data.coverage};
    await this.env.STATE.put('last-success.json',JSON.stringify(result));
    await this.env.STATE.delete('pending/export.json');
    return result;
   });
  }catch{
   await this.env.STATE.put('last-attempt.json',JSON.stringify({status:'could-not-sync',at:Date.now()}));
   throw new Error('could-not-sync: inspect authenticated workflow steps; archive checkpoint not advanced');
  } finally {await this.env.WACLI.getByName('preflight').release(owner);}
 }
}
export default {
 async fetch(){return new Response('Not found',{status:404});},
 async scheduled(event:ScheduledController,env:Env){
  if(env.SYNC_ENABLED==='true')await env.SYNC.create({id:`scheduled-${Math.floor(event.scheduledTime/DAY)}`,params:{}});
 }
} satisfies ExportedHandler<Env>;
