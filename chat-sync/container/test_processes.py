import os,signal,sys,tempfile,time,unittest,subprocess
from unittest.mock import patch
from pathlib import Path
from processes import run_bounded

class ProcessTests(unittest.TestCase):
 def run_ready(self,command,ready,timeout):
  # Exercise the timeout only after the synthetic child's handler/descendant is
  # ready. Cold Python startup can exceed 200ms on the small cloud container.
  popen=subprocess.Popen
  def start(*args,**kwargs):
   process=popen(*args,**kwargs)
   deadline=time.monotonic()+10
   while not ready.exists():
    if process.poll() is not None or time.monotonic()>=deadline:
     try:os.killpg(process.pid,signal.SIGKILL)
     except ProcessLookupError:pass
     process.communicate()
     self.fail('synthetic subprocess did not become ready')
    time.sleep(.01)
   return process
  with patch('processes.subprocess.Popen',side_effect=start):
   return run_bounded(command,timeout)

 def test_success_preserves_result(self):
  result=run_bounded([sys.executable,'-c','print("ok")'],2)
  self.assertEqual(result.returncode,0)
  self.assertEqual(result.stdout,b'ok\n')
 def test_timeout_stops_descendants_before_they_write(self):
  with tempfile.TemporaryDirectory() as tmp:
   marker=str(Path(tmp)/'late-write');ready=Path(tmp)/'ready'
   child='import time,pathlib;pathlib.Path('+repr(str(ready))+').touch();time.sleep(1);pathlib.Path('+repr(marker)+').write_text("bad")'
   parent='import subprocess,sys,time;subprocess.Popen([sys.executable,"-c",'+repr(child)+']);time.sleep(20)'
   with self.assertRaises(subprocess.TimeoutExpired):self.run_ready([sys.executable,'-c',parent],ready,0.2)
   time.sleep(1.1)
   self.assertFalse(Path(marker).exists())
 def test_timeout_stops_children_that_ignore_termination_and_close_pipes(self):
  with tempfile.TemporaryDirectory() as tmp:
   marker=str(Path(tmp)/'late-write');ready=Path(tmp)/'ready'
   child='import signal,time,pathlib;signal.signal(signal.SIGTERM,signal.SIG_IGN);pathlib.Path('+repr(str(ready))+').touch();time.sleep(1);pathlib.Path('+repr(marker)+').write_text("bad")'
   parent='import subprocess,sys,time;subprocess.Popen([sys.executable,"-c",'+repr(child)+'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);time.sleep(20)'
   with self.assertRaises(subprocess.TimeoutExpired):self.run_ready([sys.executable,'-c',parent],ready,0.2)
   time.sleep(1.1)
   self.assertFalse(Path(marker).exists())
 def test_timeout_allows_graceful_shutdown(self):
  with tempfile.TemporaryDirectory() as tmp:
   marker=str(Path(tmp)/'closed');ready=Path(tmp)/'ready'
   command='import signal,time,pathlib,sys;signal.signal(signal.SIGTERM,lambda *args:(pathlib.Path('+repr(marker)+').write_text("closed"),sys.exit(0)));pathlib.Path('+repr(str(ready))+').touch();time.sleep(20)'
   with self.assertRaises(subprocess.TimeoutExpired):self.run_ready([sys.executable,'-c',command],ready,0.2)
   self.assertEqual(Path(marker).read_text(),'closed')
if __name__=='__main__':unittest.main()
