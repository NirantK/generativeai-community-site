import hashlib,json,sqlite3,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from routing import candidates,send_reply,GROUPS
class RoutingTests(unittest.TestCase):
 def fixture(self,path):
  source=next(iter(GROUPS));group=hashlib.sha256(source.encode()).hexdigest()
  c=sqlite3.connect(path/'wacli.db')
  c.executescript('CREATE TABLE messages(msg_id TEXT,chat_jid TEXT,text TEXT,sender_jid TEXT,ts INTEGER,edited_ts INTEGER,from_me INTEGER,quoted_msg_id TEXT,reaction_to_id TEXT,media_type TEXT,revoked INTEGER,deleted_for_me INTEGER)')
  for mid,own,quote,media,sender in [('fresh',0,'','','123456789@s.whatsapp.net'),('self',1,'','','123@s.whatsapp.net'),('reply',0,'quoted','','123@s.whatsapp.net'),('media',0,'','image','123@s.whatsapp.net'),('restored',0,'','','')]:
   c.execute('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(mid,source,'Call +91 12345 67890',sender,2000,0,own,quote,'',media,0,0))
  c.commit();c.close()
  rows=[{'id':hashlib.sha256((source+'\0wacli:'+mid).encode()).hexdigest(),'group_id':group,'source_id':'wacli:'+mid,'body':'Call amber bear noon','posted_at':2000000,'hidden':0} for mid in ['fresh','self','reply','media','restored']]
  return source,rows
 def test_only_new_incoming_top_level_text_has_transient_original(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp);source,rows=self.fixture(p);items,omitted=candidates(p,rows,1000000)
   self.assertEqual([i['messageId'] for i in items],['fresh']);self.assertEqual(omitted,0)
   self.assertIn('+91 12345 67890',items[0]['text']);self.assertEqual(items[0]['contentHash'],hashlib.sha256(rows[0]['body'].encode()).hexdigest())
 def test_send_checks_source_and_uses_signed_quoted_reply(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp);source,rows=self.fixture(p)
   with patch('routing.subprocess.run') as run:
    run.return_value.stdout=json.dumps({'success':True,'data':{'sent':True,'id':'confirmed'}});run.return_value.returncode=1
    result=send_reply(p,{'source':source,'destination':'jobs','messageId':'fresh','sender':'123456789@s.whatsapp.net'})
    self.assertTrue(result['accepted']);self.assertEqual(result['id'],'confirmed')
    args=run.call_args.args[0];self.assertIn('--reply-to-sender',args);self.assertIn("I'd love it if you could move this message to Job Posts & Talent.\n\n- Sent by my agent",args)
   for mid,sender in [('self','123@s.whatsapp.net'),('fresh','wrong@s.whatsapp.net'),('reply','123@s.whatsapp.net')]:
    with self.assertRaises(ValueError):send_reply(p,{'source':source,'destination':'jobs','messageId':mid,'sender':sender})
 def test_ambiguous_send_never_claims_acceptance(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp);source,rows=self.fixture(p)
   with patch('routing.subprocess.run') as run:
    run.return_value.stdout='not json';result=send_reply(p,{'source':source,'destination':'jobs','messageId':'fresh','sender':'123456789@s.whatsapp.net'})
    self.assertEqual(result,{'accepted':False,'uncertain':True});self.assertEqual(run.call_count,1)
