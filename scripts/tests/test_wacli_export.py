import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('exporter',Path(__file__).resolve().parents[1]/'export-community-chat.py')
exporter=importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)

class ExportTests(unittest.TestCase):
    def row(self,**extra):
        return {'ChatJID':exporter.SOURCE,'ChatName':exporter.TITLE,'MsgID':'test-id','Timestamp':'2026-09-17T00:02:00Z','Text':'x < y & z','SenderName':'Test',**extra}
    def test_cutover_avoids_legacy_duplicates(self):
        messages,overlap=exporter.normalize([self.row(Timestamp='2026-09-17T00:01:16Z'),self.row()])
        self.assertEqual(overlap,1)
        self.assertEqual(len(messages),1)
        self.assertEqual(messages[0]['id'],'wacli:test-id')
        self.assertEqual(messages[0]['text'],'x &lt; y &amp; z')
    def test_deletions_and_media(self):
        messages,_=exporter.normalize([self.row(Revoked=True,MediaType='image')])
        self.assertTrue(messages[0]['is_deleted'])
        self.assertEqual(messages[0]['type'],'OTHER')
    def test_other_group_fails_closed(self):
        with self.assertRaises(ValueError): exporter.normalize([self.row(ChatJID='other@g.us')])
