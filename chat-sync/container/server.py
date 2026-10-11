import importlib.util,json,os,re,sqlite3,subprocess,tempfile,threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from checkpoint import checkpoint,restore
from routing import candidates,send_reply
os.umask(0o077)
STORE=Path('/data/store');LOCK=threading.Lock()
def importer():
 spec=importlib.util.spec_from_file_location('importer','/app/scripts/import-chat-archive.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def reply(self,status,data,kind='application/json'):
  body=data if isinstance(data,bytes) else json.dumps(data).encode();self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def do_GET(self):
  if self.path=='/health':return self.reply(200,{'ok':True})
  self.reply(404,{})
 def do_POST(self):
  if not LOCK.acquire(False):return self.reply(409,{'error':'busy'})
  try:
   if self.path=='/selftest':
    import_test=subprocess.run(['python3','-m','unittest','discover','-s','/app/scripts/tests','-p','test_chat_import.py'],capture_output=True,timeout=60)
    export_test=subprocess.run(['python3','-m','unittest','discover','-s','/app/scripts/tests','-p','test_wacli_export.py'],capture_output=True,timeout=60)
    privacy=subprocess.run(['python3','-m','unittest','discover','-s','/app','-p','test_checkpoint.py'],capture_output=True,timeout=60)
    routing_test=subprocess.run(['python3','-m','unittest','discover','-s','/app','-p','test_routing.py'],capture_output=True,timeout=60)
    binary=subprocess.run(['/usr/local/bin/wacli','--help'],capture_output=True,timeout=10)
    if import_test.returncode or export_test.returncode:return self.reply(503,{'error':'exporter-selftest-failed'})
    if privacy.returncode or routing_test.returncode:return self.reply(503,{'error':'privacy-selftest-failed'})
    if binary.returncode:return self.reply(503,{'error':'wacli-binary-failed'})
    count=sum(int(n) for result in (import_test,export_test,privacy,routing_test) for n in re.findall(r'Ran (\d+) tests?',result.stderr.decode('utf-8','replace')))
    return self.reply(200,{'passed':True,'tests':count,'wacli':True})
   if self.path=='/restore':
    size=int(self.headers.get('Content-Length','0'))
    if size<=0 or size>30_000_000:raise ValueError('checkpoint size')
    restore(self.rfile.read(size),STORE);return self.reply(200,{'ok':True})
   if self.path=='/send-reply':
    size=int(self.headers.get('Content-Length','0'))
    if size<=0 or size>2000:raise ValueError('reply size')
    return self.reply(200,send_reply(STORE,json.loads(self.rfile.read(size))))
   if self.path=='/checkpoint':return self.reply(200,checkpoint(STORE),'application/octet-stream')
   if self.path not in ('/sync','/sync/backfill-jobs','/sync/backfill-demos','/sync/cached-only'):return self.reply(404,{})
   stage='export'
   with tempfile.TemporaryDirectory(dir='/data') as tmp:
    command=['python3','/app/scripts/export-community-chat.py','--output-dir',tmp]
    if self.path=='/sync':command.append('--sync')
    if self.path=='/sync/backfill-jobs':command.append('--backfill-jobs')
    if self.path=='/sync/backfill-demos':
     command.append('--backfill-demos')
     anchor=self.headers.get('X-Demos-Anchor')
     if anchor:
      if len(anchor)>1000:raise ValueError('anchor size')
      command.extend(['--demos-anchor',anchor])
    run=subprocess.run(command,capture_output=True,timeout=940)
    if run.returncode:
     marker=run.stderr.decode('utf-8','replace')
     match=re.search(r'Export failed: (arguments|authentication|verify-demos|backfill|backfill-demos|live-sync|export-primary|export-jobs|export-demos|normalize-primary|normalize-jobs|normalize-demos|complete):([A-Za-z]+)',marker)
     if match:stage=match.group(1)+'-'+match.group(2).lower()
     raise RuntimeError('sync failed')
    stage='import'
    p=Path(tmp);sql,_=importer().build(json.loads((p/'manifest.json').read_text()))
    db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row;db.executescript(Path('/app/admissions/migrations/0005_chat_archive.sql').read_text());db.executescript(sql)
    stage='serialize'
    rows=[dict(r) for r in db.execute('SELECT id,group_id,source_id,posted_at,author,body,hidden FROM chat_messages ORDER BY id')]
    result={'rows':rows,'coverage':json.loads((p/'coverage.json').read_text())}
    if self.path=='/sync':
     since=int(self.headers.get('X-Routing-Since','0'))
     if since>0:result['routingCandidates'],result['routingOmitted']=candidates(STORE,rows,since)
    body=json.dumps(result).encode()
    if len(body)>30_000_000:raise ValueError('export too large')
    self.reply(200,body)
  except subprocess.TimeoutExpired:self.reply(503,{'error':'source-timeout'})
  except Exception:self.reply(503,{'error':stage+'-failed' if 'stage' in locals() else 'request-failed'})
  finally:LOCK.release()
ThreadingHTTPServer(('0.0.0.0',8080),Handler).serve_forever()
