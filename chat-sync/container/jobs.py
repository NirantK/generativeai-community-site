"""One private in-memory job; status responses never contain message text."""
import hashlib,re,threading,time
class SyncFailure(Exception):
 def __init__(self,code):self.code=code if re.fullmatch('[a-z-]+',code) else 'source-failed'
class Busy(Exception):pass
class Conflict(Exception):pass
class Jobs:
 def __init__(self,store_lock):self.lock=threading.Lock();self.store_lock=store_lock;self.job=None
 def start(self,job_id,payload,work,transient_poll=False):
  if not re.fullmatch('[a-zA-Z0-9-]{8,100}',job_id):raise ValueError('invalid job id')
  fingerprint=hashlib.sha256(payload).hexdigest()
  with self.lock:
   if self.job and self.job['id']==job_id:
    if self.job['fingerprint']!=fingerprint:raise Conflict()
    return
   if self.job and self.job['state']=='running':raise Busy()
   if not self.store_lock.acquire(False):raise Busy()
   job={'id':job_id,'fingerprint':fingerprint,'state':'running','result':None,'error':None,'transient_poll':transient_poll}
   self.job=job
  def execute():
   result=None;failure=None
   try:
    result=work()
    if not isinstance(result,bytes) or len(result)>30_000_000:raise SyncFailure('invalid-export-size')
   except Exception as error:
    failure=error.code if isinstance(error,SyncFailure) else 'source-failed'
   finally:
    self.store_lock.release()
    with self.lock:job.update(state='failed' if failure else 'complete',result=None if failure else result,error=failure)
  threading.Thread(target=execute,daemon=True).start()
 def status(self,job_id):
  with self.lock:
   if not self.job or self.job['id']!=job_id:return None
   if self.job['transient_poll']:
    self.job['transient_poll']=False
    return {'retry':True}
   return {'state':self.job['state'],'error':self.job['error']}
 def result(self,job_id):
  with self.lock:
   if not self.job or self.job['id']!=job_id:return None
   return self.job['result']
 def ack(self,job_id):
  with self.lock:
   if not self.job or self.job['id']!=job_id:return False
   if self.job['state']=='running':raise Busy()
   self.job.update(result=None,state='acknowledged');return True
