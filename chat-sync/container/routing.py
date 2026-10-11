"""Original text/quote sender are transient. Never include these in checkpoints or logs."""
import hashlib,json,sqlite3,subprocess
from pathlib import Path
GROUPS={'120363049558306142@g.us':'The GenerativeAI Group','120363323644237261@g.us':'Job Posts & Talent','120363297860953641@g.us':'Project Demos & Events'}
DESTINATIONS={'general':'The GenerativeAI Group','jobs':'Job Posts & Talent','demos_events':'Project Demos & Events'}
def candidates(store,rows,since):
 by_source={(r['group_id'],r['source_id'][6:]):r for r in rows if not r['hidden']}
 out=[]
 with sqlite3.connect(f'file:{store}/wacli.db?mode=ro',uri=True) as db:
  db.row_factory=sqlite3.Row
  for source in GROUPS:
   result=db.execute("SELECT msg_id,text,sender_jid,ts FROM messages WHERE chat_jid=? AND from_me=0 AND COALESCE(quoted_msg_id,'')='' AND COALESCE(reaction_to_id,'')='' AND COALESCE(media_type,'')='' AND revoked=0 AND deleted_for_me=0 AND sender_jid!='' AND (ts>? OR edited_ts>?) ORDER BY ts DESC LIMIT 201",(source,since//1000,since//1000)).fetchall()
   for raw in result:
    row=by_source.get((hashlib.sha256(source.encode()).hexdigest(),raw['msg_id']))
    if not row or not raw['text'] or len(raw['text'])>30000:continue
    out.append({'id':row['id'],'groupId':row['group_id'],'source':source,'messageId':raw['msg_id'],'sender':raw['sender_jid'],'text':raw['text'],'contentHash':hashlib.sha256(raw['text'].encode()).hexdigest(),'postedAt':row['posted_at']})
 out.sort(key=lambda r:r['postedAt'],reverse=True)
 return out[:200],max(0,len(out)-200)
def send_reply(store,data):
 source=data.get('source');destination=data.get('destination');mid=data.get('messageId');sender=data.get('sender')
 if source not in GROUPS or destination not in DESTINATIONS or GROUPS[source]==DESTINATIONS[destination] or not isinstance(mid,str) or len(mid)>200 or not isinstance(sender,str) or len(sender)>150:raise ValueError('invalid reply')
 with sqlite3.connect(f'file:{store}/wacli.db?mode=ro',uri=True) as db:
  row=db.execute('SELECT sender_jid,from_me,quoted_msg_id,revoked,deleted_for_me FROM messages WHERE chat_jid=? AND msg_id=?',(source,mid)).fetchone()
 if not row or row[0]!=sender or row[1] or row[2] or row[3] or row[4]:raise ValueError('source reply unavailable')
 message=f"I'd love it if you could move this message to {DESTINATIONS[destination]}.\n\n- Sent by my agent"
 r=subprocess.run(['/usr/local/bin/wacli','--store',str(store),'send','text','--to',source,'--message',message,'--reply-to',mid,'--reply-to-sender',sender,'--no-preview','--json'],capture_output=True,timeout=90)
 try:payload=json.loads(r.stdout);sent=payload.get('data') or {}
 except Exception:return {'accepted':False,'uncertain':True}
 # sent:true is authoritative even when the command reports a local-store warning.
 if payload.get('success') and sent.get('sent') is True:
  mid=sent.get('id');return {'accepted':True,'id':mid if isinstance(mid,str) and len(mid)<200 else None}
 return {'accepted':False,'uncertain':True}
