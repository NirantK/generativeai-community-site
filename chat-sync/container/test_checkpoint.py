import io,sqlite3,tarfile,tempfile,unittest
from pathlib import Path
from checkpoint import checkpoint,restore,SOURCE,JOBS_SOURCE,DEMOS_SOURCE
class CheckpointTests(unittest.TestCase):
 def test_only_group_and_redacted_text_survive(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);store=root/'source';store.mkdir()
   with sqlite3.connect(store/'session.db') as c:c.execute('CREATE TABLE auth (value TEXT)');c.execute("INSERT INTO auth VALUES ('synthetic credential')")
   with sqlite3.connect(store/'wacli.db') as c:
    c.execute('PRAGMA journal_mode=WAL')
    c.executescript('''CREATE TABLE chats(jid TEXT PRIMARY KEY);CREATE TABLE contacts(jid TEXT);CREATE TABLE messages(rowid INTEGER PRIMARY KEY,chat_jid TEXT,text TEXT,display_text TEXT,sender_name TEXT,media_caption TEXT,sender_jid TEXT,quoted_sender_jid TEXT,media_key BLOB,file_sha256 BLOB,file_enc_sha256 BLOB,direct_path TEXT,local_path TEXT,filename TEXT,buttons TEXT);CREATE VIRTUAL TABLE messages_fts USING fts5(text,content='messages',content_rowid='rowid');''')
    c.executemany('INSERT INTO chats VALUES (?)',[(SOURCE,),(JOBS_SOURCE,),(DEMOS_SOURCE,),('private-other',)])
    c.execute("INSERT INTO contacts VALUES ('private-contact')")
    c.execute('INSERT INTO messages(rowid,chat_jid,text,sender_name,sender_jid) VALUES(1,?,?,?,?)',(SOURCE,'Call +91 12345 67890','+91 12345 67890','+911234567890'))
    c.execute("INSERT INTO messages(rowid,chat_jid,text) VALUES(2,'private-other','DO NOT UPLOAD')")
    c.execute('INSERT INTO messages(rowid,chat_jid,text) VALUES(3,?,?)',(JOBS_SOURCE,'Talent opportunity'))
    c.execute('INSERT INTO messages(rowid,chat_jid,text) VALUES(4,?,?)',(DEMOS_SOURCE,'Demo call +91 12345 67890'))
   restore(checkpoint(store),root/'restored')
   with sqlite3.connect(root/'restored'/'wacli.db') as c:
    self.assertEqual(c.execute('SELECT count(*) FROM contacts').fetchone()[0],0)
    self.assertEqual(c.execute('SELECT text,sender_name,sender_jid FROM messages ORDER BY rowid').fetchall(),[('Call amber bear noon','amber bear noon',''),('Talent opportunity','',''),('Demo call amber bear noon','','')])
    self.assertEqual(c.execute('SELECT jid FROM chats ORDER BY jid').fetchall(),sorted([(SOURCE,),(JOBS_SOURCE,),(DEMOS_SOURCE,)]))
    self.assertEqual(c.execute('SELECT count(*) FROM messages_fts WHERE messages_fts MATCH ?',('amber',)).fetchone()[0],2)
   self.assertNotIn(b'DO NOT UPLOAD',(root/'restored'/'wacli.db').read_bytes())
   self.assertNotIn(b'12345',(root/'restored'/'wacli.db').read_bytes())
 def test_restore_removes_old_sqlite_sidecars(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);source=root/'source';source.mkdir();target=root/'target';target.mkdir()
   for name in ('session.db','wacli.db'):
    with sqlite3.connect(source/name) as db:db.execute('CREATE TABLE test(value TEXT)');db.execute("INSERT INTO test VALUES('saved')")
   blob=io.BytesIO()
   with tarfile.open(fileobj=blob,mode='w:gz') as tar:
    for name in ('session.db','wacli.db'):tar.add(source/name,arcname=name)
   for name in ('session.db','wacli.db'):
    for suffix in ('-wal','-shm','-journal'):(target/(name+suffix)).write_bytes(b'stale')
   restore(blob.getvalue(),target)
   for name in ('session.db','wacli.db'):
    for suffix in ('-wal','-shm','-journal'):self.assertFalse((target/(name+suffix)).exists())
    with sqlite3.connect(target/name) as db:self.assertEqual(db.execute('SELECT value FROM test').fetchone(),('saved',))
 def test_invalid_restore_keeps_existing_databases(self):
  with tempfile.TemporaryDirectory() as tmp:
   target=Path(tmp)
   for name in ('session.db','wacli.db'):(target/name).write_bytes(b'keep')
   blob=io.BytesIO()
   with tarfile.open(fileobj=blob,mode='w:gz') as tar:
    for name in ('session.db','wacli.db'):
     member=tarfile.TarInfo(name);member.size=3;tar.addfile(member,io.BytesIO(b'bad'))
   with self.assertRaises(sqlite3.Error):restore(blob.getvalue(),target)
   self.assertEqual((target/'session.db').read_bytes(),b'keep')
   self.assertEqual((target/'wacli.db').read_bytes(),b'keep')
 def test_restore_rejects_unexpected_members(self):
  b=io.BytesIO()
  with tarfile.open(fileobj=b,mode='w:gz') as t:t.addfile(tarfile.TarInfo('../unexpected'))
  with tempfile.TemporaryDirectory() as tmp,self.assertRaises(ValueError):restore(b.getvalue(),Path(tmp))
