"""Private checkpoint: session credential plus only the authorized, redacted cache."""
import io,sqlite3,tarfile,tempfile,os,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
sys.path.insert(0,'/app/scripts')
from chat_privacy import redact_text
SOURCE='120363049558306142@g.us'

def checkpoint(store):
 with tempfile.TemporaryDirectory() as tmp:
  root=Path(tmp)
  # SQLite backup also captures a consistent WAL snapshot; never copy a live db file.
  with sqlite3.connect(f'file:{store}/session.db?mode=ro',uri=True) as src,sqlite3.connect(root/'session.db') as dst:src.backup(dst)
  with sqlite3.connect(f'file:{store}/wacli.db?mode=ro',uri=True) as src,sqlite3.connect(root/'wacli.db') as dst:
   src.backup(dst)
   dst.execute('PRAGMA secure_delete=ON')
   names=[r[0] for r in dst.execute("SELECT name FROM sqlite_master WHERE type='table'")]
   for name in names:
    if name in ('schema_migrations','sqlite_sequence','messages','chats') or 'fts' in name or 'search' in name:continue
    if not name.replace('_','').isalnum():raise ValueError('Unexpected schema')
    dst.execute(f'DELETE FROM "{name}"')
   dst.execute('DELETE FROM messages WHERE chat_jid != ?', (SOURCE,))
   dst.execute('DELETE FROM chats WHERE jid != ?', (SOURCE,))
   for rowid,text,display,name,caption in dst.execute('SELECT rowid,text,display_text,sender_name,media_caption FROM messages').fetchall():
    dst.execute('UPDATE messages SET text=?,display_text=?,sender_name=?,media_caption=? WHERE rowid=?',tuple(redact_text(x or '') for x in (text,display,name,caption))+(rowid,))
   dst.execute("UPDATE messages SET sender_jid='',quoted_sender_jid='',media_key=NULL,file_sha256=NULL,file_enc_sha256=NULL,direct_path=NULL,local_path=NULL,filename=NULL,buttons=NULL")
   # Rebuild external-content FTS tables from the now-redacted source.
   for name,sql in dst.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'").fetchall():
    if 'fts5' not in sql.lower():raise ValueError('Unexpected virtual table')
    dst.execute(f"INSERT INTO \"{name}\"(\"{name}\") VALUES('rebuild')")
   dst.commit();dst.execute('VACUUM')
  out=io.BytesIO()
  with tarfile.open(fileobj=out,mode='w:gz') as tar:
   for name in ('session.db','wacli.db'):tar.add(root/name,arcname=name)
  return out.getvalue()

def restore(blob,store):
 store.mkdir(mode=0o700,parents=True,exist_ok=True)
 with tarfile.open(fileobj=io.BytesIO(blob),mode='r:gz') as tar:
  members=tar.getmembers()
  if {m.name for m in members}!={'session.db','wacli.db'} or len(members)!=2:raise ValueError('Invalid checkpoint')
  for member in members:
   if not member.isfile() or member.size>100_000_000:raise ValueError('Invalid checkpoint member')
   with tar.extractfile(member) as src,open(store/member.name,'wb') as dst:dst.write(src.read())
   os.chmod(store/member.name,0o600)
