import os,sys,tempfile,time,unittest,subprocess
from pathlib import Path
from processes import run_bounded

class ProcessTests(unittest.TestCase):
 def test_success_preserves_result(self):
  result=run_bounded([sys.executable,'-c','print("ok")'],2)
  self.assertEqual(result.returncode,0)
  self.assertEqual(result.stdout,b'ok\n')
 def test_timeout_stops_descendants_before_they_write(self):
  with tempfile.TemporaryDirectory() as tmp:
   marker=str(Path(tmp)/'late-write')
   child='import time,pathlib;time.sleep(1);pathlib.Path('+repr(marker)+').write_text("bad")'
   parent='import subprocess,sys,time;subprocess.Popen([sys.executable,"-c",'+repr(child)+']);time.sleep(20)'
   with self.assertRaises(subprocess.TimeoutExpired):run_bounded([sys.executable,'-c',parent],0.2)
   time.sleep(1.1)
   self.assertFalse(Path(marker).exists())
 def test_timeout_stops_children_that_ignore_termination_and_close_pipes(self):
  with tempfile.TemporaryDirectory() as tmp:
   marker=str(Path(tmp)/'late-write')
   child='import signal,time,pathlib;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(1);pathlib.Path('+repr(marker)+').write_text("bad")'
   parent='import subprocess,sys,time;subprocess.Popen([sys.executable,"-c",'+repr(child)+'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);time.sleep(20)'
   with self.assertRaises(subprocess.TimeoutExpired):run_bounded([sys.executable,'-c',parent],0.2)
   time.sleep(1.1)
   self.assertFalse(Path(marker).exists())
 def test_timeout_allows_graceful_shutdown(self):
  with tempfile.TemporaryDirectory() as tmp:
   marker=str(Path(tmp)/'closed')
   command='import signal,time,pathlib,sys;signal.signal(signal.SIGTERM,lambda *args:(pathlib.Path('+repr(marker)+').write_text("closed"),sys.exit(0)));time.sleep(20)'
   with self.assertRaises(subprocess.TimeoutExpired):run_bounded([sys.executable,'-c',command],0.2)
   self.assertEqual(Path(marker).read_text(),'closed')
if __name__=='__main__':unittest.main()
