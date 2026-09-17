import importlib.util,json,os,sqlite3,subprocess,tempfile,threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from checkpoint import checkpoint,restore
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
    tests=subprocess.run(['python3','-m','unittest','discover','-s','/app/scripts/tests'],capture_output=True,timeout=60)
    binary=subprocess.run(['/usr/local/bin/wacli','--help'],capture_output=True,timeout=10)
    if tests.returncode or binary.returncode:raise RuntimeError('selftest failed')
    return self.reply(200,{'passed':True,'tests':9,'wacli':True})
   if self.path=='/restore':
    size=int(self.headers.get('Content-Length','0'))
    if size<=0 or size>30_000_000:raise ValueError('checkpoint size')
    restore(self.rfile.read(size),STORE);return self.reply(200,{'ok':True})
   if self.path=='/checkpoint':return self.reply(200,checkpoint(STORE),'application/octet-stream')
   if self.path!='/sync':return self.reply(404,{})
   with tempfile.TemporaryDirectory(dir='/data') as tmp:
    run=subprocess.run(['python3','/app/scripts/export-community-chat.py','--sync','--output-dir',tmp],capture_output=True,timeout=940)
    if run.returncode:raise RuntimeError('sync failed')
    p=Path(tmp);sql,_=importer().build(json.loads((p/'manifest.json').read_text()))
    db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row;db.executescript(Path('/app/admissions/migrations/0005_chat_archive.sql').read_text());db.executescript(sql)
    rows=[dict(r) for r in db.execute('SELECT id,group_id,source_id,posted_at,author,body,hidden FROM chat_messages ORDER BY id')]
    result={'rows':rows,'coverage':json.loads((p/'coverage.json').read_text())}
    body=json.dumps(result).encode()
    if len(body)>20_000_000:raise ValueError('export too large')
    self.reply(200,body)
  except Exception:self.reply(503,{'error':'could-not-sync'})
  finally:LOCK.release()
ThreadingHTTPServer(('0.0.0.0',8080),Handler).serve_forever()
