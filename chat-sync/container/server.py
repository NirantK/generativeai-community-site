import importlib.util,json,os,re,sqlite3,subprocess,tempfile,threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from checkpoint import checkpoint,restore
from routing import candidates,send_reply
from processes import run_bounded
from jobs import Jobs,Busy,Conflict,SyncFailure
import time
os.umask(0o077)
STORE=Path('/data/store');LOCK=threading.Lock();JOBS=Jobs(LOCK)
def importer():
 spec=importlib.util.spec_from_file_location('importer','/app/scripts/import-chat-archive.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def sync_payload(path,headers,request_body):
 try:
  stage='export'
  with tempfile.TemporaryDirectory(dir='/data') as tmp:
   command=['python3','/app/scripts/export-community-chat.py','--output-dir',tmp]
   if path=='/sync/bootstrap-demos':
    size=int(headers.get('Content-Length','0'))
    if size<=0 or size>2_000_000:raise ValueError('bootstrap size')
    seed=Path(tmp)/'bootstrap.json';seed.write_bytes(request_body[:size])
    command.extend(['--bootstrap-demos-file',str(seed)])
   if path=='/sync':command.append('--sync')
   if path=='/sync/backfill-jobs':command.append('--backfill-jobs')
   if path=='/sync/backfill-demos':
    command.append('--backfill-demos')
    anchor=headers.get('X-Demos-Anchor')
    if anchor:
     if len(anchor)>1000:raise ValueError('anchor size')
     command.extend(['--demos-anchor',anchor])
   run=run_bounded(command,940)
   if run.returncode:
    marker=run.stderr.decode('utf-8','replace')
    match=re.search(r'Export failed: (arguments|authentication|verify-demos|backfill|backfill-demos|bootstrap-demos|live-sync|export-primary|export-jobs|export-demos|normalize-primary|normalize-jobs|normalize-demos|complete):([A-Za-z]+)',marker)
    if match:stage=match.group(1)+'-'+match.group(2).lower()
    raise RuntimeError('sync failed')
   stage='import'
   p=Path(tmp);sql,_=importer().build(json.loads((p/'manifest.json').read_text()))
   db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row;db.executescript(Path('/app/admissions/migrations/0005_chat_archive.sql').read_text());db.executescript(sql)
   stage='serialize'
   rows=[dict(r) for r in db.execute('SELECT id,group_id,source_id,posted_at,author,body,hidden FROM chat_messages ORDER BY id')]
   result={'rows':rows,'coverage':json.loads((p/'coverage.json').read_text())}
   if path in ('/sync','/sync/backfill-jobs','/sync/backfill-demos'):
    since=int(headers.get('X-Routing-Since','0'))
    if since>0:
     result['routingCandidates'],result['routingOmitted']=candidates(STORE,rows,0 if path!='/sync' else since)
   body=json.dumps(result).encode()
   if len(body)>30_000_000:raise ValueError('export too large')
   return body
 except subprocess.TimeoutExpired:raise SyncFailure('source-timeout') from None
 except Exception:raise SyncFailure(stage+'-failed') from None
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def reply(self,status,data,kind='application/json'):
  body=data if isinstance(data,bytes) else json.dumps(data).encode();self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def do_GET(self):
  if self.path=='/health':return self.reply(200,{'ok':True})
  match=re.fullmatch('/sync-job/([a-zA-Z0-9-]{8,100})(/result)?',self.path)
  if match:
   if match[2]:
    result=JOBS.result(match[1])
    return self.reply(200,result) if result is not None else self.reply(409,{'error':'result-not-ready'})
   status=JOBS.status(match[1])
   return self.reply(503 if status and status.get('retry') else 200,status) if status else self.reply(404,{'error':'job-not-found'})
  self.reply(404,{})
 def do_POST(self):
  if self.path=='/sync-job/start':
   try:
    size=int(self.headers.get('Content-Length','0'))
    if size<=0 or size>2_100_000:raise ValueError('job size')
    raw=self.rfile.read(size);payload=json.loads(raw);job_id=payload['id']
    if payload.get('probe'):
     def work():
      time.sleep(0.1 if payload.get('probeFailure') else 330)
      if payload.get('probeFailure'):raise SyncFailure('controlled-source-failure')
      return json.dumps({'passed':True,'waitedSeconds':330}).encode()
    else:
     path=payload['path']
     if path not in ('/sync','/sync/backfill-jobs','/sync/backfill-demos','/sync/cached-only','/sync/bootstrap-demos'):raise ValueError('job path')
     def work():return sync_payload(path,payload.get('headers',{}),payload.get('body','').encode())
    JOBS.start(job_id,raw,work,bool(payload.get('transientPoll')))
    return self.reply(202,{'id':job_id})
   except Busy:return self.reply(409,{'error':'busy'})
   except Conflict:return self.reply(409,{'error':'job-conflict'})
   except Exception:return self.reply(400,{'error':'invalid-job'})
  match=re.fullmatch('/sync-job/([a-zA-Z0-9-]{8,100})/ack',self.path)
  if match:
   try:return self.reply(200,{'acknowledged':JOBS.ack(match[1])})
   except Busy:return self.reply(409,{'error':'busy'})
  if not LOCK.acquire(timeout=45 if self.path=='/checkpoint' else 0):return self.reply(409,{'error':'busy'})
  try:
   if self.path=='/selftest':
    import_test=subprocess.run(['python3','-m','unittest','discover','-s','/app/scripts/tests','-p','test_chat_import.py'],capture_output=True,timeout=60)
    export_test=subprocess.run(['python3','-m','unittest','discover','-s','/app/scripts/tests','-p','test_wacli_export.py'],capture_output=True,timeout=60)
    job_test=subprocess.run(['python3','-m','unittest','discover','-s','/app','-p','test_jobs.py'],capture_output=True,timeout=60)
    process_test=subprocess.run(['python3','-m','unittest','discover','-s','/app','-p','test_processes.py'],capture_output=True,timeout=60)
    privacy=subprocess.run(['python3','-m','unittest','discover','-s','/app','-p','test_checkpoint.py'],capture_output=True,timeout=60)
    routing_test=subprocess.run(['python3','-m','unittest','discover','-s','/app','-p','test_routing.py'],capture_output=True,timeout=60)
    binary=subprocess.run(['/usr/local/bin/wacli','--help'],capture_output=True,timeout=10)
    # Only suite codes and test identifiers leave the synthetic test runner.
    # Never return stderr, assertion text, tracebacks or runtime/session data.
    suites=[('import',import_test),('export',export_test),('jobs',job_test),('process',process_test),('checkpoint',privacy),('routing',routing_test)]
    failed=[(name,result) for name,result in suites if result.returncode]
    if failed:
     name,result=failed[0]
     tests=re.findall(r'^(?:FAIL|ERROR): (test_[a-z0-9_]+) ',result.stderr.decode('utf-8','replace'),re.MULTILINE)
     return self.reply(503,{'error':name+'-selftest-failed','failedTests':tests[:10]})
    if binary.returncode:return self.reply(503,{'error':'wacli-binary-failed'})
    count=sum(int(n) for result in (import_test,export_test,privacy,routing_test,process_test,job_test) for n in re.findall(r'Ran (\d+) tests?',result.stderr.decode('utf-8','replace')))
    return self.reply(200,{'passed':True,'tests':count,'wacli':True})
   if self.path=='/restore':
    size=int(self.headers.get('Content-Length','0'))
    if size<=0 or size>30_000_000:raise ValueError('checkpoint size')
    restore(self.rfile.read(size),STORE);return self.reply(200,{'ok':True})
   if self.path=='/send-reply':
    size=int(self.headers.get('Content-Length','0'))
    if size<=0 or size>2000:raise ValueError('reply size')
    return self.reply(200,send_reply(STORE,json.loads(self.rfile.read(size))))
   if self.path=='/validate-session':
    result=run_bounded(['/usr/local/bin/wacli','--store',str(STORE),'groups','refresh','--json'],90)
    if result.returncode:return self.reply(503,{'error':'live-authentication-failed'})
    return self.reply(200,{'authenticated':True})
   if self.path=='/checkpoint':
    try:return self.reply(200,checkpoint(STORE),'application/octet-stream')
    except sqlite3.Error as error:
     name=getattr(error,'sqlite_errorname','SQLITE_UNKNOWN').lower().replace('_','-')
     if not re.fullmatch('[a-z-]+',name):name='sqlite-unknown'
     return self.reply(503,{'error':'checkpoint-'+name})
    except Exception as error:
     name=type(error).__name__.lower()
     return self.reply(503,{'error':'checkpoint-'+name if re.fullmatch('[a-z]+',name) else 'checkpoint-unknown'})
   if self.path not in ('/sync','/sync/backfill-jobs','/sync/backfill-demos','/sync/cached-only','/sync/bootstrap-demos'):return self.reply(404,{})
   size=int(self.headers.get('Content-Length','0'))
   if size>2_000_000:raise ValueError('request size')
   return self.reply(200,sync_payload(self.path,self.headers,self.rfile.read(size) if size else b''))
  except SyncFailure as error:self.reply(503,{'error':error.code})
  except subprocess.TimeoutExpired:self.reply(503,{'error':'source-timeout'})
  except Exception:self.reply(503,{'error':stage+'-failed' if 'stage' in locals() else 'request-failed'})
  finally:LOCK.release()
if __name__=='__main__':
 ThreadingHTTPServer(('0.0.0.0',8080),Handler).serve_forever()
