import json,threading,time,unittest,urllib.request,urllib.error
from jobs import Jobs,Busy,Conflict,SyncFailure
class JobTests(unittest.TestCase):
 def test_duplicate_start_and_private_status_during_running_work(self):
  lock=threading.Lock();jobs=Jobs(lock);ready=threading.Event();release=threading.Event();calls=[]
  def work():calls.append(1);ready.set();release.wait(2);return b'private original text'
  jobs.start('test-job-one',b'payload',work)
  self.assertTrue(ready.wait(1));jobs.start('test-job-one',b'payload',work)
  with self.assertRaises(Conflict):jobs.start('test-job-one',b'changed',work)
  with self.assertRaises(Busy):jobs.start('test-job-two',b'payload',work)
  self.assertEqual(jobs.status('test-job-one'),{'state':'running','error':None})
  self.assertFalse(lock.acquire(False));release.set()
  deadline=time.monotonic()+2
  while jobs.status('test-job-one')['state']=='running' and time.monotonic()<deadline:threading.Event().wait(.01)
  self.assertEqual(calls,[1]);self.assertEqual(jobs.result('test-job-one'),b'private original text')
  self.assertNotIn('private',json.dumps(jobs.status('test-job-one')))
  self.assertTrue(jobs.ack('test-job-one'));self.assertIsNone(jobs.result('test-job-one'))
  self.assertTrue(lock.acquire(timeout=1));lock.release()
 def test_failure_is_sanitized_and_releases_store(self):
  lock=threading.Lock();jobs=Jobs(lock);finished=threading.Event()
  def work():finished.set();raise RuntimeError('private phone or message')
  jobs.start('test-job-fail',b'payload',work);self.assertTrue(finished.wait(1))
  self.assertTrue(lock.acquire(timeout=1));lock.release()
  self.assertEqual(jobs.status('test-job-fail'),{'state':'failed','error':'source-failed'})
 def test_poll_failure_does_not_restart_job(self):
  lock=threading.Lock();jobs=Jobs(lock);done=threading.Event()
  jobs.start('test-job-poll',b'payload',lambda:(done.wait(1),b'ok')[1],True)
  self.assertEqual(jobs.status('test-job-poll'),{'retry':True})
  self.assertEqual(jobs.status('test-job-poll'),{'state':'running','error':None});done.set()
 def test_job_cannot_start_while_restore_or_checkpoint_holds_store(self):
  lock=threading.Lock();lock.acquire();jobs=Jobs(lock)
  try:
   with self.assertRaises(Busy):jobs.start('test-job-lock',b'payload',lambda:b'bad')
  finally:lock.release()
 def test_real_http_start_poll_terminal_failure_and_ack(self):
  # Importing the real server also checks its startup imports and syntax in the image.
  import server
  original=server.JOBS;server.JOBS=Jobs(threading.Lock())
  http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
  threading.Thread(target=http.serve_forever,daemon=True).start()
  base='http://127.0.0.1:'+str(http.server_port)
  def request(path,payload=None):
   req=urllib.request.Request(base+path,data=json.dumps(payload).encode() if payload is not None else None,headers={'Content-Type':'application/json'})
   try:
    with urllib.request.urlopen(req,timeout=2) as response:return response.status,json.load(response)
   except urllib.error.HTTPError as error:return error.code,json.load(error)
  try:
   self.assertEqual(request('/sync-job/start',{'id':'test-http-job','probe':True,'probeFailure':True,'transientPoll':True})[0],202)
   self.assertEqual(request('/sync-job/test-http-job')[0],503)
   deadline=time.monotonic()+2
   while time.monotonic()<deadline:
    status,body=request('/sync-job/test-http-job')
    if body.get('state')=='failed':break
    threading.Event().wait(.02)
   self.assertEqual(body,{'state':'failed','error':'controlled-source-failure'})
   self.assertEqual(request('/sync-job/test-http-job/ack',{})[1],{'acknowledged':True})
  finally:http.shutdown();http.server_close();server.JOBS=original
if __name__=='__main__':unittest.main()
