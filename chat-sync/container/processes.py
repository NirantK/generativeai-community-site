"""Bounded subprocesses: terminate descendants before releasing the store lock."""
import os,signal,subprocess

def run_bounded(command,timeout):
    process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    try:
        stdout,stderr=process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:os.killpg(process.pid,signal.SIGTERM)
        except ProcessLookupError:pass
        try:process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            try:os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            process.communicate()
        raise subprocess.TimeoutExpired(command,timeout) from None
    return subprocess.CompletedProcess(command,process.returncode,stdout,stderr)
