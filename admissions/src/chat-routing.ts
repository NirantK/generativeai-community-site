import { z } from 'zod';
import { ApiError, body, digest, json } from './security';
import { choices, moveReply, routingGroups, type RoutingChoice } from './chat-routing-policy';
export type ReviewRow={id:string;message_id:string;group_id:string;choice:RoutingChoice;probabilities:string;confidence:number;proposal:number;status:string;historical:number;model:string;prompt_version:string;created_at:number;text:string;author:string;postedAt:number};
export type RoutingSettings={trial_started_at:number;replies_enabled:number;enabled_at:number|null;test_verified:number;version:number;test_source_group:string|null;test_destination:RoutingChoice|null;test_requested_by:string|null;test_requested_at:number|null;active_policy:string;policy_requested_at:number|null};
const DAY=86400000;
export async function routingSettings(db:D1Database){
 const settings=await db.prepare('SELECT * FROM chat_routing_settings WHERE id=1').first<RoutingSettings>();
 if(!settings)throw new ApiError(503,'routing_unavailable','Chat routing is being deployed.');
 return settings;
}
export async function routingMetrics(db:D1Database,settings:RoutingSettings,now=Date.now()){
 const rows=await db.prepare(`SELECT d.group_id,d.choice,d.proposal,l.label,COUNT(*) n FROM chat_routing_decisions d JOIN chat_routing_labels l ON l.decision_id=d.id GROUP BY d.group_id,d.choice,d.proposal,l.label`).all<{group_id:string;choice:string;proposal:number;label:string;n:number}>();
 let reviewedProposals=0,correctProposals=0,total=0;
 const matrix:Record<string,Record<string,number>>={};
 for(const r of rows.results){
  total+=r.n;matrix[r.label]??={};matrix[r.label][r.choice]=(matrix[r.label][r.choice]??0)+r.n;
  if(r.proposal){reviewedProposals+=r.n;if(r.choice===r.label)correctProposals+=r.n;}
 }
 const precision=reviewedProposals?correctProposals/reviewedProposals:0;
 const trialDays=Math.max(0,(now-settings.trial_started_at)/DAY);
 return {total,reviewedProposals,correctProposals,precision,trialDays,matrix,trialPassed:trialDays>=7&&reviewedProposals>=30&&precision>=0.95};
}
function entropy(probabilities:string){
 try{return Object.values(JSON.parse(probabilities) as Record<string,number>).reduce((n,p)=>n-(p>0?p*Math.log(p):0),0);}catch{return 0;}
}
function fingerprint(text:string){return text.toLowerCase().replace(/https?:\/\/\S+/g,'URL').replace(/\d+/g,'N').replace(/[^\p{L}\p{N}]+/gu,' ').trim();}
export function selectReview(rows:ReviewRow[],limit=20){
 const selected:{row:ReviewRow;reason:string}[]=[],ids=new Set<string>(),texts:string[]=[];
 const add=(row:ReviewRow,reason:string)=>{
  const text=fingerprint(row.text),tokens=new Set(text.split(' ').filter(w=>w.length>2));
  if(ids.has(row.message_id)||text.length<15||texts.some(old=>{
   if(old===text)return true;
   const other=new Set(old.split(' ').filter(w=>w.length>2));
   const intersection=[...tokens].filter(t=>other.has(t)).length;
   return intersection/Math.max(1,tokens.size+other.size-intersection)>0.85;
  }))return false;
  selected.push({row,reason});ids.add(row.message_id);texts.push(text);return true;
 };
 const uncertain=rows.filter(r=>r.status==='assessed').sort((a,b)=>entropy(b.probabilities)-entropy(a.probabilities));
 const disagreement=rows.filter(r=>r.status==='assessed'&&r.choice!=='unclear'&&routingGroups.find(g=>g.id===r.group_id)?.key!==r.choice).sort((a,b)=>b.confidence-a.confidence);
 function pick(candidates:ReviewRow[],quota:number,reason:string){
  let count=0;
  // Round-robin source groups, so the largest archive cannot dominate a batch.
  const buckets=routingGroups.map(g=>candidates.filter(r=>r.group_id===g.id));
  while(count<quota&&buckets.some(b=>b.length))for(const b of buckets){const row=b.shift();if(row&&count<quota&&add(row,reason))count++;}
 }
 pick(uncertain,8,'Near tie');pick(disagreement,6,'Group disagreement');
 pick([...rows].sort((a,b)=>a.postedAt-b.postedAt),4,'Diverse example');
 // Stable hash-like order changes as new rows arrive without trusting source labels.
 pick([...rows].sort((a,b)=>a.id.slice(-16).localeCompare(b.id.slice(-16))),2,'Audit sample');
 pick(rows,Math.max(0,limit-selected.length),'Additional example');
 return selected.slice(0,limit);
}
const labelSchema=z.object({decisionId:z.string().regex(/^[a-f0-9]{64}:[a-f0-9]{64}$/),label:z.enum(choices as [RoutingChoice,...RoutingChoice[]]),explanation:z.string().trim().max(1500).default('')}).strict();
export async function routingAdmin(req:Request,env:Env,suffix:string,actor:string){
 const settings=await routingSettings(env.INDEX);
 if(suffix==='/queue'&&req.method==='GET'){
  const rows=await env.INDEX.prepare(`SELECT d.*,COALESCE(NULLIF(d.review_text,''),m.body) text,m.author,m.posted_at postedAt FROM chat_routing_decisions d JOIN chat_messages m ON m.id=d.message_id LEFT JOIN chat_routing_labels l ON l.decision_id=d.id WHERE l.decision_id IS NULL AND m.hidden=0 AND d.status='assessed' AND NOT EXISTS(SELECT 1 FROM chat_routing_decisions newer WHERE newer.message_id=d.message_id AND newer.created_at>d.created_at) ORDER BY d.created_at DESC LIMIT 4000`).all<ReviewRow>();
  const cards=selectReview(rows.results).map(({row,reason})=>({decisionId:row.id,messageId:row.message_id,groupId:row.group_id,text:row.text,author:row.author,postedAt:row.postedAt,historical:!!row.historical,reason}));
  return json({cards,groups:routingGroups.map(({key,id,title})=>({key,id,title})),available:rows.results.length});
 }
 if(suffix==='/labels'&&req.method==='POST'){
  const input=labelSchema.parse(await body(req));
  const decision=await env.INDEX.prepare('SELECT * FROM chat_routing_decisions WHERE id=?').bind(input.decisionId).first();
  if(!decision)throw new ApiError(404,'not_found','Review example not found.');
  const holdout=parseInt((await digest(input.decisionId)).slice(0,2),16)%5===0?1:0;
  const inserted=await env.INDEX.prepare('INSERT INTO chat_routing_labels(decision_id,label,explanation,actor,holdout,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(decision_id) DO NOTHING RETURNING decision_id').bind(input.decisionId,input.label,input.explanation,actor,holdout,Date.now()).first();
  if(!inserted){const prior=await env.INDEX.prepare('SELECT label,explanation FROM chat_routing_labels WHERE decision_id=?').bind(input.decisionId).first<{label:string;explanation:string}>();if(prior?.label!==input.label||prior?.explanation!==input.explanation)throw new ApiError(409,'already_labeled','Another administrator labeled this example. Refresh the queue.');}
  return json({label:input.label,modelChoice:decision.choice,probabilities:JSON.parse(String(decision.probabilities)),model:decision.model,promptVersion:decision.prompt_version,holdout:!!holdout});
 }
 if(suffix==='/metrics'&&req.method==='GET'){
  const recent=await env.INDEX.prepare('SELECT message_id,destination,status,test,whatsapp_message_id,updated_at FROM chat_routing_sends ORDER BY updated_at DESC LIMIT 30').all();
  const counts=await env.INDEX.prepare('SELECT status,COUNT(*) total FROM chat_routing_decisions GROUP BY status').all();
  const policies=await env.INDEX.prepare('SELECT version,status,evaluation,created_at,activated_at FROM chat_routing_policies ORDER BY created_at DESC LIMIT 5').all();
  return json({settings,policies:policies.results.map(p=>({...p,evaluation:JSON.parse(String(p.evaluation))})),metrics:await routingMetrics(env.INDEX,settings),counts:counts.results,sends:recent.results,replyTemplates:routingGroups.map(g=>({choice:g.key,text:moveReply(g.key)}))});
 }
 if(suffix==='/policy/evaluate'&&req.method==='POST'){
  await env.INDEX.prepare('UPDATE chat_routing_settings SET policy_requested_at=? WHERE id=1').bind(Date.now()).run();
  return json({queued:true});
 }
 if(suffix==='/policy/activate'&&req.method==='POST'){
  const input=z.object({version:z.string().max(100)}).strict().parse(await body(req));
  const policy=await env.INDEX.prepare("SELECT version FROM chat_routing_policies WHERE version=? AND status='ready'").bind(input.version).first();
  if(!policy)throw new ApiError(409,'evaluation_required','This policy has not passed the held-out evaluation.');
  await env.INDEX.batch([
   env.INDEX.prepare('UPDATE chat_routing_settings SET active_policy=?,replies_enabled=0,enabled_at=NULL,test_verified=0,version=version+1 WHERE id=1').bind(input.version),
   env.INDEX.prepare('UPDATE chat_routing_policies SET activated_at=? WHERE version=?').bind(Date.now(),input.version),
   env.INDEX.prepare('INSERT INTO chat_archive_actions(id,actor,action,target,at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),actor,'activate_routing_policy',input.version,Date.now())
  ]);
  return json({activePolicy:input.version,repliesPaused:true});
 }
 if(suffix==='/settings'&&req.method==='POST'){
  const input=z.object({enabled:z.boolean(),version:z.number().int()}).strict().parse(await body(req));
  if(input.enabled){const metrics=await routingMetrics(env.INDEX,settings);if(!metrics.trialPassed||!settings.test_verified)throw new ApiError(409,'trial_required','Complete the reviewed seven-day trial and one confirmed quoted-reply test before enabling replies.');}
  const row=await env.INDEX.prepare('UPDATE chat_routing_settings SET replies_enabled=?,enabled_at=?,version=version+1 WHERE id=1 AND version=? RETURNING version').bind(input.enabled?1:0,input.enabled?Date.now():null,input.version).first();
  if(!row)throw new ApiError(409,'settings_changed','Settings changed. Refresh before trying again.');
  await env.INDEX.prepare('INSERT INTO chat_archive_actions(id,actor,action,target,at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),actor,input.enabled?'enable_routing_replies':'pause_routing_replies','routing',Date.now()).run();
  return json({enabled:input.enabled,...row});
 }
 if(suffix==='/test'&&req.method==='POST'){
  const input=z.object({sourceGroup:z.string(),destination:z.enum(['general','jobs','demos_events']),cancel:z.boolean().default(false)}).strict().parse(await body(req));
  const source=routingGroups.find(g=>g.id===input.sourceGroup);
  if(!source||(!input.cancel&&source.key===input.destination))throw new ApiError(422,'destination','Select two different groups.');
  if(!input.cancel&&!(await routingMetrics(env.INDEX,settings)).trialPassed)throw new ApiError(409,'trial_required','Complete the reviewed trial before requesting a controlled test.');
  if(settings.test_requested_at&&!input.cancel)throw new ApiError(409,'test_pending','A controlled test is already waiting.');
  await env.INDEX.prepare('UPDATE chat_routing_settings SET test_source_group=?,test_destination=?,test_requested_by=?,test_requested_at=?,version=version+1 WHERE id=1').bind(input.cancel?null:source.id,input.cancel?null:input.destination,input.cancel?null:actor,input.cancel?null:Date.now()).run();
  return json({pending:!input.cancel,recipient:source.title,text:moveReply(input.destination)});
 }
 const reconcile=suffix.match(/^\/sends\/([a-f0-9]{64})\/reconcile$/);
 if(reconcile&&req.method==='POST'){
  const input=z.object({outcome:z.enum(['accepted','not_sent']),reason:z.string().trim().min(10).max(1500)}).strict().parse(await body(req));
  const changed=await env.INDEX.prepare("UPDATE chat_routing_sends SET status=?,updated_at=? WHERE message_id=? AND status IN ('sending','uncertain') RETURNING test").bind(input.outcome,Date.now(),reconcile[1]).first<{test:number}>();
  if(!changed)throw new ApiError(409,'not_uncertain','This send does not need reconciliation.');
  if(changed.test&&input.outcome==='accepted')await env.INDEX.prepare('UPDATE chat_routing_settings SET test_verified=1,version=version+1 WHERE id=1').run();
  await env.INDEX.prepare('INSERT INTO chat_archive_actions(id,actor,action,target,at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),actor,'reconcile_routing:'+input.outcome+':'+input.reason,reconcile[1],Date.now()).run();
  return json({status:input.outcome});
 }
 throw new ApiError(405,'method','Unsupported chat-routing operation.');
}
