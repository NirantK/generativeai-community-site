#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["beeper-desktop-api==5.0.0"]
# ///
"""Export only the explicitly selected community room; never publish or print content."""
import argparse,json,os,subprocess,sys,tempfile
from pathlib import Path
from datetime import datetime,timezone
from beeper_desktop_api import BeeperDesktop
ROOM='!ahQ2N95zrRGpWPQ0Vznh:beeper.local'
TITLE='The GenerativeAI Group'
SOURCE='120363049558306142@g.us'
FIELDS=('id','timestamp','sender_name','sender_id','text','type','is_deleted','is_hidden','edited_timestamp')
def write(path,value):
 fd,tmp=tempfile.mkstemp(prefix='.export-',dir=path.parent)
 try:
  os.fchmod(fd,0o600)
  with os.fdopen(fd,'w') as out: json.dump(value,out,ensure_ascii=False)
  os.replace(tmp,path)
 finally:
  if os.path.exists(tmp): os.unlink(tmp)
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--output-dir',type=Path,required=True);a=ap.parse_args()
 if a.output_dir.resolve().is_relative_to(Path(__file__).resolve().parents[1]): raise ValueError('Keep exports outside the repository')
 a.output_dir.mkdir(mode=0o700,parents=True,exist_ok=True);os.chmod(a.output_dir,0o700)
 key=subprocess.run(['security','find-generic-password','-s','beeper-mcp-token','-w'],capture_output=True,text=True,check=True).stdout.strip()
 client=BeeperDesktop(access_token=key);chat=client.chats.retrieve(chat_id=ROOM)
 if chat.id!=ROOM or chat.title!=TITLE or chat.network!='WhatsApp' or chat.type!='group': raise ValueError('Source identity mismatch')
 items={};pages=0;cursors=set();page=client.messages.list(chat_id=ROOM)
 while True:
  pages+=1
  for message in page.items:
   raw=message.model_dump(mode='json')
   if raw.get('chat_id')!=ROOM: raise ValueError('Cross-room message')
   items[raw['id']]={k:raw.get(k) for k in FIELDS}
  if pages%25==0: print(json.dumps({'pages':pages,'messages':len(items),'complete':False}),flush=True)
  if not page.has_next_page(): break
  cursor=page.oldest_cursor
  if not cursor or cursor in cursors: raise ValueError('Pagination did not advance')
  cursors.add(cursor);page=page.get_next_page()
 dates=sorted(str(m['timestamp']) for m in items.values() if m.get('timestamp'))
 coverage={'title':TITLE,'sourceRef':SOURCE,'room':ROOM,'exportedAt':datetime.now(timezone.utc).isoformat(),'messages':len(items),'pages':pages,'paginationComplete':True,'oldest':dates[0] if dates else None,'newest':dates[-1] if dates else None,'limitation':'All history available through this Beeper installation; not proof of complete WhatsApp history.'}
 data=a.output_dir/'messages.json';write(data,list(items.values()));write(a.output_dir/'coverage.json',coverage)
 note=f"Available Beeper history: {coverage['oldest']} to {coverage['newest']}; {len(items)} source records. Local pagination exhausted; older WhatsApp history may be unavailable."
 write(a.output_dir/'manifest.json',{'groups':[{'sourceRef':SOURCE,'title':TITLE,'file':str(data.resolve()),'coverageNote':note}]})
 print(json.dumps(coverage),flush=True)
if __name__=='__main__':
 try: main()
 except Exception as error:
  print('Export failed: '+type(error).__name__,file=sys.stderr);sys.exit(1)
