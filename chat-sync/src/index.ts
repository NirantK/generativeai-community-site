import { routingGroups } from '../../admissions/src/chat-routing-policy';
import { classifyLive, evaluateReviewedPolicy, modelEvaluation, seedRouting, type LiveCandidate } from './routing';
import { Container } from '@cloudflare/containers';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
const GROUP=routingGroups[0].id;
const SOURCE=routingGroups[0].source;
const GROUPS=routingGroups;
const DAY=86400000;
// Retain the original preflight instance identity: Containers reserves this slot even after stop.
type Row={id:string;group_id:string;source_id:string;posted_at:number;author:string;body:string;hidden:number};
type Coverage={status?:string;reason?:string;sourceRef:string;provider:string;cachedRecords:number;messages:number;cutover:string;oldest:string|null;newest:string|null;publicationCounts?:{textCandidates:number;mediaOrReactions:number;emptyText:number;deleted:number};verifiedIdentity?:{sourceRef:string;title:string}|null};
type Export={rows:Row[];coverage:Coverage[];routingCandidates?:LiveCandidate[];routingOmitted?:number};
async function digest(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');}

async function checkpointBytes(response:Response){
 if(!response.ok){
  const detail=await response.json<{error?:string}>().catch(()=>({error:'unknown'}));
  const code=typeof detail.error==='string' && /^[a-z-]+$/.test(detail.error)?detail.error:'unknown';
  throw new Error(`checkpoint-response-failed:${response.status}:${code}`);
 }
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
 async tryAcquire(owner:string){
  return this.ctx.storage.transaction(async tx=>{
   const lease=await tx.get<{owner:string;expires:number}>('lease');
   if(lease && lease.owner!==owner && lease.expires>Date.now())return false;
   await tx.put('lease',{owner,expires:Date.now()+60*60_000});
   return true;
  });
 }
 async acquire(owner:string){if(!await this.tryAcquire(owner))throw new Error('sync-already-running');}
 async release(owner:string){
  await this.ctx.storage.transaction(async tx=>{if((await tx.get<{owner:string}>('lease'))?.owner===owner)await tx.delete('lease');});
 }
 // Operator-only recovery for a Workflow verified terminated in Cloudflare.
 async releaseTerminatedLease(owner:string){
  if(!/^[a-zA-Z0-9_-]{8,120}$/.test(owner))throw new Error('invalid-lease-owner');
  if(await this.env.STATE.head('session/recovery-required'))throw new Error('session-recovery-required');
  if(this.ctx.container?.running)throw new Error('container-still-running');
  return this.ctx.storage.transaction(async tx=>{
   const lease=await tx.get<{owner:string;expires:number}>('lease');
   if(!lease||lease.owner!==owner||lease.expires>Date.now()+50*60_000)throw new Error('lease-not-eligible');
   await tx.delete('lease');
   return {released:true};
  });
 }
 async preflight(){
  if(await this.env.STATE.head('session/recovery-required'))throw new Error('recover-session-before-preflight');
  try {
  await this.startAndWaitForPorts();
  const r=await this.containerFetch('http://container/selftest',{method:'POST'});
   if(!r.ok){
    const detail=await r.json<{error?:string}>().catch(()=>({error:'unknown'}));
    const code=typeof detail.error==='string' && /^(exporter-selftest-failed|privacy-selftest-failed|wacli-binary-failed)$/.test(detail.error)?detail.error:'unknown';
    throw new Error(`container-selftest-failed:${code}`);
   }
   return await r.json<{passed:boolean;tests:number;wacli:boolean}>();
  }finally{try{await this.destroy();}catch{/* Preserve the startup failure when no container exists. */}}
 }
 async saveCheckpoint(){
  if(!this.ctx.container?.running)throw new Error('current-container-session-unavailable');
  // Checkpoint the running instance directly. The SDK proxy may try to restart
  // it when its cached health state lags a long request or deployment.
  const bytes=await checkpointBytes(await this.ctx.container.getTcpPort(8080).fetch('http://container/checkpoint',{method:'POST'}));
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
  if(!await this.env.STATE.head('session/recovery-required'))return {saved:false,bytes:0};
  // Do not start or restore: only the existing container can hold the latest session.
  return this.saveCheckpoint();
 }
 async restoreSavedSession(owner:string,marker:number,restartFailedContainer=false):Promise<{saved:boolean;bytes:number;recoveredCurrent?:boolean;liveAuthenticated?:boolean}>{
  if((await this.ctx.storage.get<{owner:string}>('lease'))?.owner!==owner)throw new Error('lease-required');
  const required=await this.env.STATE.get('session/recovery-required');
  if(!required || !Number.isSafeInteger(marker) || Number(await required.text())!==marker)throw new Error('recovery-marker-mismatch');
  if(this.ctx.container?.running){
   if(!restartFailedContainer)throw new Error('recover-current-session-first');
   try{return {...await this.saveCheckpoint(),recoveredCurrent:true};}
   catch{
    // Explicit operator restart only after checkpoint failure, with marker and lease verified.
    // Preserve the R2 snapshot and recovery marker until live validation succeeds.
    await this.destroy();
   }
  }
  const snapshot=await this.env.STATE.get('session/latest.tar.gz');
  if(!snapshot || snapshot.size>30_000_000)throw new Error('session-checkpoint-required');
  try{
   await this.startAndWaitForPorts();
   const restored=await this.containerFetch('http://container/restore',{method:'POST',headers:{'Content-Length':String(snapshot.size)},body:await snapshot.arrayBuffer()});
   if(!restored.ok)throw new Error('session-restore-failed');
   const verified=await this.containerFetch('http://container/validate-session',{method:'POST'});
   if(!verified.ok || !(await verified.json<{authenticated?:boolean}>()).authenticated)throw new Error('saved-session-live-authentication-failed');
   // The marker is cleared only by a verified checkpoint of the live-validated session.
   return {...await this.saveCheckpoint(),liveAuthenticated:true};
  }finally{await this.destroy();}
 }
 private async runJob(payload:Record<string,unknown>):Promise<Response>{
  const id=crypto.randomUUID();
  const body=JSON.stringify({...payload,id});
  const call=async(path:string,init?:RequestInit)=>{
   for(let attempt=0;attempt<3;attempt++){
    try{
     const response=await this.containerFetch(`http://container${path}`,{...init,signal:AbortSignal.timeout(20_000)});
     if(response.status!==429&&response.status<500)return response;
     await response.body?.cancel();
    }catch{ /* Retry only idempotent job creation/status/result, never WhatsApp sends. */ }
    if(attempt<2)await new Promise(resolve=>setTimeout(resolve,2000));
   }
   throw new Error('sync-job-transport-failed');
  };
  const started=await call('/sync-job/start',{method:'POST',headers:{'Content-Type':'application/json'},body});
  if(!started.ok)throw new Error('sync-job-start-failed');
  await started.body?.cancel();
  try{
   for(let poll=0;poll<110;poll++){
    const response=await call(`/sync-job/${id}`);
    if(!response.ok)throw new Error('sync-job-lost');
    const status=await response.json<{state:string;error?:string}>();
    if(status.state==='failed'){
     const code=typeof status.error==='string'&&/^[a-z-]+$/.test(status.error)?status.error:'unknown';
     throw new Error(`wacli-sync-failed:${code}`);
    }
    if(status.state==='complete'){
     const result=await call(`/sync-job/${id}/result`);
     if(!result.ok)throw new Error('sync-job-result-failed');
     const headers=new Headers(result.headers);headers.set('X-Sync-Job',id);
     return new Response(result.body,{headers});
    }
    if(status.state!=='running')throw new Error('sync-job-invalid-state');
    await new Promise(resolve=>setTimeout(resolve,10_000));
   }
   throw new Error('sync-job-deadline');
  }catch(error){
   // Ack only terminal failures; a running job must keep its store lock.
   try{await call(`/sync-job/${id}/ack`,{method:'POST'});}catch{}
   throw error;
  }
 }
 private async ackJob(response:Response){
  const id=response.headers.get('X-Sync-Job');
  if(!id||!/^[a-zA-Z0-9-]{8,100}$/.test(id))return;
  try{const ack=await this.containerFetch(`http://container/sync-job/${id}/ack`,{method:'POST',signal:AbortSignal.timeout(20_000)});await ack.body?.cancel();}catch{}
 }
 async transportPreflight(owner:string){
  if((await this.ctx.storage.get<{owner:string}>('lease'))?.owner!==owner)throw new Error('lease-required');
  if(await this.env.STATE.head('session/recovery-required'))throw new Error('session-recovery-required');
  try{
   await this.startAndWaitForPorts();
   const response=await this.runJob({probe:true,transientPoll:true});
   const result=await response.json<{passed:boolean;waitedSeconds:number}>();
   await this.ackJob(response);
   if(!result.passed||result.waitedSeconds!==330)throw new Error('transport-probe-failed');
   let failedSafely=false;
   try{await this.runJob({probe:true,probeFailure:true});}
   catch(error){failedSafely=error instanceof Error&&error.message==='wacli-sync-failed:controlled-source-failure';}
   if(!failedSafely)throw new Error('transport-failure-probe-failed');
   return {passed:true,waitedSeconds:330,transientPollRecovered:true,sourceFailurePreserved:true};
  }finally{await this.destroy();}
 }
 async run(owner:string,backfillJobs=false,cachedOnly=false,backfillDemos=false,demosAnchor?:{messageId:string;timestamp:number;fromMe:boolean},bootstrapDemos=false) {
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
   const bootstrap=bootstrapDemos?await this.env.STATE.get('bootstrap/demos-cache.json'):null;
   if(bootstrapDemos&&(!bootstrap||bootstrap.size>2_000_000))throw new Error('sanitized-demos-bootstrap-required');
   const endpoint=bootstrapDemos?'http://container/sync/bootstrap-demos':backfillJobs?'http://container/sync/backfill-jobs':backfillDemos?'http://container/sync/backfill-demos':cachedOnly?'http://container/sync/cached-only':'http://container/sync';
   const settings=await this.env.DB.prepare('SELECT trial_started_at FROM chat_routing_settings WHERE id=1').first<{trial_started_at:number}>().catch(()=>null);
   const response=await this.runJob({path:new URL(endpoint).pathname,headers:{'X-Routing-Since':String(settings?.trial_started_at??0),...(demosAnchor?{'X-Demos-Anchor':JSON.stringify(demosAnchor)}:{}),...(bootstrap?{'Content-Length':String(bootstrap.size)}:{})},...(bootstrap?{body:await bootstrap.text()}: {})});
   if(!response.ok){
    const detail=await response.json<{error?:string}>().catch(()=>({error:'unknown'}));
    const code=typeof detail.error==='string' && /^[a-z-]+$/.test(detail.error)?detail.error:'unknown';
    throw new Error(`wacli-sync-failed:${code}`);
   }
   const size=Number(response.headers.get('Content-Length'));
   if(!size || size>30_000_000)throw new Error('invalid-export-size');
   const data=await response.json<Export>();
   await this.ackJob(response);
   if(!Array.isArray(data.coverage)||data.coverage.length!==GROUPS.length||!Array.isArray(data.rows))throw new Error('invalid-export');
   for(const group of GROUPS){
    const coverage=data.coverage.find(c=>c.sourceRef===group.source);
    if(!coverage||coverage.provider!=='wacli'||(coverage.status!=='could-not-sync'&&(coverage.cachedRecords<=0||coverage.cachedRecords>=1_000_000))||data.coverage.filter(c=>c.sourceRef===group.source).length!==1)throw new Error('invalid-export-coverage');
   }
   for(const r of data.rows){
    const group=GROUPS.find(g=>g.id===r.group_id);
    if(!group || data.coverage.find(c=>c.sourceRef===group.source)?.status==='could-not-sync' || !r.source_id.startsWith('wacli:') || r.id!==await digest(group.source+'\0'+r.source_id) || ![0,1].includes(r.hidden) || typeof r.body!=='string' || typeof r.author!=='string' || r.body.length>30000 || r.author.length>200 || (!r.hidden && (!Number.isSafeInteger(r.posted_at)||r.posted_at<=group.cutover||r.posted_at>Date.now()+DAY)))throw new Error('invalid-export-row');
   }
   // Original text and sender exist only in this method; never return them from a Workflow step.
   const candidates=data.routingCandidates??[];
   delete data.routingCandidates;
   if(candidates.length>200)throw new Error('routing-candidate-limit');
   // Save only sanitized archive data. AI failure cannot lose an otherwise valid archive update.
   await this.env.STATE.put('pending/export.json',JSON.stringify(data));
   if(settings && !cachedOnly && !bootstrapDemos){
    try{await classifyLive(this.env,(backfillJobs||backfillDemos)?candidates.slice(0,30):candidates,async(c,destination)=>{
     const reply=await this.containerFetch('http://container/send-reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:c.source,messageId:c.messageId,sender:c.sender,destination})});
     if(!reply.ok)throw new Error('reply-outcome-uncertain');
     return reply.json<{accepted:boolean;id?:string|null;uncertain?:boolean}>();
    },backfillJobs||backfillDemos);}catch{await this.env.STATE.put('routing/last-attempt.json',JSON.stringify({status:'could-not-classify',at:Date.now()}));}
   }
   return {records:data.rows.length};
  } finally {
   try {
    if(restored){
     await this.saveCheckpoint();
    }
   } finally {if(!await this.env.STATE.head('session/recovery-required'))await this.destroy();}
  }
 }
}
async function metrics(db:D1Database){
 const result:Record<string,{total:number;visible:number;oldest:number|null;newest:number|null}|null>={};
 for(const group of GROUPS){
  const counts=await db.prepare('SELECT count(*) total,sum(hidden=0) visible,min(CASE WHEN hidden=0 THEN posted_at END) oldest,max(CASE WHEN hidden=0 THEN posted_at END) newest FROM chat_messages WHERE group_id=?').bind(group.id).first<{total:number;visible:number;oldest:number|null;newest:number|null}>();
  const integrity=await db.prepare('SELECT count(*) missing FROM chat_messages m LEFT JOIN chat_search s ON s.rowid=m.rowid WHERE m.group_id=? AND m.hidden=0 AND (s.rowid IS NULL OR s.body != m.body OR s.author != m.author)').bind(group.id).first<{missing:number}>();
  const hidden=await db.prepare('SELECT count(*) exposed FROM chat_search s JOIN chat_messages m ON m.rowid=s.rowid WHERE m.group_id=? AND m.hidden=1').bind(group.id).first<{exposed:number}>();
  if(integrity?.missing!==0||hidden?.exposed!==0)throw new Error('search-index-verification-failed');
  result[group.id]=counts;
 }
 return result;
}
type SyncParams={transportTest?:boolean;restartFailedContainer?:boolean;restoreCheckpoint?:number;bootstrapDemos?:boolean;demosAnchor?:{messageId:string;timestamp:number;fromMe:boolean};force?:boolean;preflight?:boolean;recover?:boolean;storageTest?:boolean;backfillJobs?:boolean;cachedOnly?:boolean;terminatedLeaseOwner?:string;backfillDemos?:boolean;seedRouting?:number;seedProposals?:number;modelEvaluation?:boolean;evaluatePolicy?:boolean};
export class ChatSyncWorkflow extends WorkflowEntrypoint<Env,SyncParams> {
 async run(event:WorkflowEvent<SyncParams>,step:WorkflowStep){
  const params=event.payload ?? {};
  if(params.demosAnchor&&(!params.force||!params.backfillDemos))throw new Error('anchor-requires-forced-demos-backfill');
  if(params.evaluatePolicy)return step.do('evaluate-reviewed-policy',{retries:{limit:0,delay:'1 second'},timeout:'20 minutes'},()=>evaluateReviewedPolicy(this.env));
  if(params.modelEvaluation)return step.do('cloud-clef-evaluation',{retries:{limit:0,delay:'1 second'},timeout:'10 minutes'},()=>modelEvaluation(this.env));
  if(params.seedProposals)return step.do('seed-trial-proposals',{retries:{limit:0,delay:'1 second'},timeout:'20 minutes'},()=>seedRouting(this.env,params.seedProposals,true));
  if(params.seedRouting)return step.do('seed-historical-review',{retries:{limit:0,delay:'1 second'},timeout:'20 minutes'},()=>seedRouting(this.env,params.seedRouting));
  if(params.storageTest)return step.do('cloud-r2-checkpoint-test',()=>storagePreflight(this.env.STATE));
  if(params.terminatedLeaseOwner)return step.do('release-verified-terminated-lease',()=>this.env.WACLI.getByName('preflight').releaseTerminatedLease(params.terminatedLeaseOwner!));
  if(params.restartFailedContainer&&!params.restoreCheckpoint)throw new Error('restart-requires-exact-recovery-marker');
  if(params.restoreCheckpoint){
   const instance=this.env.WACLI.getByName('preflight');
   await instance.acquire(event.instanceId);
   try{return await step.do('restore-and-validate-saved-session',{retries:{limit:0,delay:'1 second'},timeout:'5 minutes'},()=>instance.restoreSavedSession(event.instanceId,params.restoreCheckpoint!,!!params.restartFailedContainer));}
   finally{await instance.release(event.instanceId);}
  }
  if(params.recover){
   const instance=this.env.WACLI.getByName('preflight');
   await instance.acquire(event.instanceId);
   try{return await step.do('recover-current-session',{retries:{limit:0,delay:'1 second'},timeout:'2 minutes'},()=>instance.recover(event.instanceId));}
   finally{await instance.release(event.instanceId);}
  }

  if(params.transportTest){
   const instance=this.env.WACLI.getByName('preflight');
   await instance.acquire(event.instanceId);
   try{return await step.do('cloud-long-job-transport',{retries:{limit:0,delay:'1 second'},timeout:'10 minutes'},()=>instance.transportPreflight(event.instanceId));}
   finally{await instance.release(event.instanceId);}
  }
  if(params.preflight){
   const instance=this.env.WACLI.getByName('preflight');
   await instance.acquire(event.instanceId);
   try{return await step.do('cloud-container-preflight',()=>instance.preflight());}
   finally{await instance.release(event.instanceId);}
  }
  if(this.env.SYNC_ENABLED!=='true' && !params.force)return {status:'paused'};
  if((params.backfillJobs||params.backfillDemos||params.cachedOnly||params.bootstrapDemos) && !params.force)throw new Error('manual-sync-requires-explicit-force');
  if([params.backfillJobs,params.backfillDemos,params.cachedOnly,params.bootstrapDemos].filter(Boolean).length>1)throw new Error('incompatible-sync-modes');
  const last=await this.env.STATE.get('last-success.json');
  const previous=last?await last.json<{at:number;digest:string}>():null;
  const owner=event.instanceId;
  const acquired=await step.do('acquire-single-session',()=>this.env.WACLI.getByName('preflight').tryAcquire(owner));
  if(!acquired){
   if(params.force)throw new Error('sync-already-running');
   return {status:'already-running'};
  }
  try {
   // Retry the verified current-session checkpoint on the next slot, before idle shutdown.
   // No automatic stale-snapshot restoration or marker deletion is permitted here.
   if(await this.env.STATE.head('session/recovery-required'))await step.do('recover-interrupted-session',{retries:{limit:0,delay:'1 second'},timeout:'2 minutes'},()=>this.env.WACLI.getByName('preflight').recover(owner));
   // Never overwrite an export awaiting import after a partial failure.
   const pending=await this.env.STATE.head('pending/export.json');
   if(pending && (params.backfillJobs||params.backfillDemos||params.bootstrapDemos))throw new Error('pending-export-must-be-imported-first');
   if(!pending)await step.do('sync-wacli',{retries:{limit:0,delay:'1 second'},timeout:'20 minutes'},()=>this.env.WACLI.getByName('preflight').run(owner,!!params.backfillJobs,!!params.cachedOnly,!!params.backfillDemos,params.demosAnchor,!!params.bootstrapDemos));
   const result=await step.do('import-and-verify',{retries:{limit:2,delay:'30 seconds'},timeout:'10 minutes'},async()=>{
    if(await this.env.STATE.head('session/recovery-required'))throw new Error('session-recovery-required');
    const object=await this.env.STATE.get('pending/export.json');
    if(!object || object.size>20_000_000)throw new Error('missing-export');
    const data=await object.json<Export>();
    const hash=await digest(JSON.stringify(data.rows));
    const before=await metrics(this.env.DB);
    const primary=await this.env.DB.prepare('SELECT published FROM chat_groups WHERE id=? AND source_ref=?').bind(GROUP,SOURCE).first();
    if(!primary)throw new Error('archive-group-missing');
    for(const added of GROUPS.slice(1)){
    await this.env.DB.prepare('INSERT INTO chat_groups(id,title,source_ref,imported_at,coverage_note) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(added.id,added.title,added.source,Date.now(),'Available wacli text may be incomplete.').run();
    if(!await this.env.DB.prepare('SELECT id FROM chat_groups WHERE id=? AND source_ref=?').bind(added.id,added.source).first())throw new Error('group-identity-mismatch');
    }
    if(hash!==previous?.digest){
     for(let offset=0;offset<data.rows.length;offset+=20){
      const statements:D1PreparedStatement[]=[];
      for(const r of data.rows.slice(offset,offset+20)){
       statements.push(this.env.DB.prepare('DELETE FROM chat_search WHERE rowid=(SELECT rowid FROM chat_messages WHERE id=?)').bind(r.id));
       statements.push(this.env.DB.prepare(`INSERT INTO chat_messages(id,group_id,source_id,posted_at,author,body,hidden) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET posted_at=CASE WHEN excluded.hidden=1 THEN chat_messages.posted_at ELSE excluded.posted_at END,author=CASE WHEN excluded.hidden=1 THEN '' WHEN chat_messages.hidden=0 THEN excluded.author ELSE chat_messages.author END,body=CASE WHEN excluded.hidden=1 THEN '' WHEN chat_messages.hidden=0 THEN excluded.body ELSE chat_messages.body END,hidden=MAX(chat_messages.hidden,excluded.hidden)`).bind(r.id,r.group_id,r.source_id,r.posted_at,r.author,r.body,r.hidden));
       statements.push(this.env.DB.prepare('INSERT INTO chat_search(rowid,body,author) SELECT rowid,body,author FROM chat_messages WHERE id=? AND hidden=0').bind(r.id));
      }
      await this.env.DB.batch(statements);
     }
    }
    const after=await metrics(this.env.DB);
    for(const added of GROUPS.slice(1)){
     const coverage=data.coverage.find(c=>c.sourceRef===added.source);
     if(!coverage)throw new Error('archive-group-coverage-missing');
     // A metadata-only history anchor is not published history. Do not block healthy groups.
     if((after[added.id]?.visible??0)<1){coverage.status='could-not-sync';coverage.reason='no-publishable-text';}
    }
    for(const group of GROUPS)if(data.coverage.find(c=>c.sourceRef===group.source)?.status!=='could-not-sync')await this.env.DB.prepare('UPDATE chat_groups SET imported_at=? WHERE id=?').bind(Date.now(),group.id).run();
    const failedGroups=data.coverage.filter(c=>c.status==='could-not-sync').map(c=>({sourceRef:c.sourceRef,reason:c.reason}));
    const result={status:failedGroups.length?'partial':hash===previous?.digest?'unchanged':'synced',failedGroups,at:Date.now(),digest:hash,records:data.rows.length,routingOmitted:data.routingOmitted??0,before,after,coverage:data.coverage};
    for(const group of GROUPS){
     const coverage=data.coverage.find(c=>c.sourceRef===group.source);
     if(coverage?.status==='could-not-sync'){await this.env.STATE.put(`groups/${group.key}/last-attempt.json`,JSON.stringify({status:'could-not-sync',at:result.at,reason:coverage.reason}));continue;}
     const rows=data.rows.filter(r=>r.group_id===group.id);
     await this.env.STATE.put(`groups/${group.key}/last-success.json`,JSON.stringify({at:result.at,digest:await digest(JSON.stringify(rows)),counts:after[group.id],coverage:data.coverage.find(c=>c.sourceRef===group.source)}));
    }
    if(!failedGroups.length)await this.env.STATE.put('last-success.json',JSON.stringify(result));
    else await this.env.STATE.put('last-attempt.json',JSON.stringify({status:'could-not-sync',at:result.at,failedGroups}));
    await this.env.STATE.delete('pending/export.json');
    if(params.bootstrapDemos&&!failedGroups.some(g=>g.sourceRef===GROUPS[2].source))await this.env.STATE.delete('bootstrap/demos-cache.json');
    return result;
   });
   // Historical sampling is independent of the archive's verified success checkpoint.
   try{await step.do('replenish-review',{retries:{limit:0,delay:'1 second'},timeout:'5 minutes'},()=>seedRouting(this.env,18));}catch{await this.env.STATE.put('routing/last-attempt.json',JSON.stringify({status:'could-not-seed',at:Date.now()}));}
   try{await step.do('evaluate-reviewed-policy',{retries:{limit:0,delay:'1 second'},timeout:'20 minutes'},()=>evaluateReviewedPolicy(this.env));}catch{await this.env.STATE.put('routing/last-attempt.json',JSON.stringify({status:'could-not-evaluate',at:Date.now()}));}
   return result;
  }catch{
   await this.env.STATE.put('last-attempt.json',JSON.stringify({status:'could-not-sync',at:Date.now()}));
   throw new Error('could-not-sync: inspect authenticated workflow steps; archive checkpoint not advanced');
  } finally {await this.env.WACLI.getByName('preflight').release(owner);}
 }
}
export default {
 async fetch(){return new Response('Not found',{status:404});},
} satisfies ExportedHandler<Env>;
