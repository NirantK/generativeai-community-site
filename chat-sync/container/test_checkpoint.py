import io,sqlite3,tarfile,tempfile,unittest
from pathlib import Path
from checkpoint import checkpoint,restore,SOURCE
class CheckpointTests(unittest.TestCase):
 def test_only_group_and_redacted_text_survive(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);store=root/'source';store.mkdir()
   with sqlite3.connect(store/'session.db') as c:c.execute('CREATE TABLE auth (value TEXT)');c.execute("INSERT INTO auth VALUES ('synthetic credential')")
   with sqlite3.connect(store/'wacli.db') as c:
    c.executescript('''CREATE TABLE chats(jid TEXT PRIMARY KEY);CREATE TABLE contacts(jid TEXT);CREATE TABLE messages(rowid INTEGER PRIMARY KEY,chat_jid TEXT,text TEXT,display_text TEXT,sender_name TEXT,media_caption TEXT,sender_jid TEXT,quoted_sender_jid TEXT,media_key BLOB,file_sha256 BLOB,file_enc_sha256 BLOB,direct_path TEXT,local_path TEXT,filename TEXT,buttons TEXT);CREATE VIRTUAL TABLE messages_fts USING fts5(text,content='messages',content_rowid='rowid');''')
    c.executemany('INSERT INTO chats VALUES (?)',[(SOURCE,),('private-other',)])
    c.execute("INSERT INTO contacts VALUES ('private-contact')")
    c.execute('INSERT INTO messages(rowid,chat_jid,text,sender_name,sender_jid) VALUES(1,?,?,?,?)',(SOURCE,'Call +91 12345 67890','+91 12345 67890','+911234567890'))
    c.execute("INSERT INTO messages(rowid,chat_jid,text) VALUES(2,'private-other','DO NOT UPLOAD')")
   restore(checkpoint(store),root/'restored')
   with sqlite3.connect(root/'restored'/'wacli.db') as c:
    self.assertEqual(c.execute('SELECT count(*) FROM contacts').fetchone()[0],0)
    self.assertEqual(c.execute('SELECT text,sender_name,sender_jid FROM messages').fetchall(),[('Call amber bear noon','amber bear noon','')])
    self.assertEqual(c.execute('SELECT count(*) FROM messages_fts WHERE messages_fts MATCH ?',('amber',)).fetchone()[0],1)
   self.assertNotIn(b'DO NOT UPLOAD',(root/'restored'/'wacli.db').read_bytes())
   self.assertNotIn(b'12345',(root/'restored'/'wacli.db').read_bytes())
 def test_restore_rejects_unexpected_members(self):
  b=io.BytesIO()
  with tarfile.open(fileobj=b,mode='w:gz') as t:t.addfile(tarfile.TarInfo('../unexpected'))
  with tempfile.TemporaryDirectory() as tmp,self.assertRaises(ValueError):restore(b.getvalue(),Path(tmp))
