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

    def test_phone_numbers_are_replaced_before_export(self):
        messages,_=exporter.normalize([self.row(Text='Call +91 12345 67890', SenderName='+91 12345 67890')])
        self.assertEqual(messages[0]['text'], 'Call amber bear noon')
        self.assertEqual(messages[0]['sender_name'], 'amber bear noon')
    def test_other_group_fails_closed(self):
        with self.assertRaises(ValueError): exporter.normalize([self.row(ChatJID='other@g.us')])
    def test_stale_cached_chat_name_does_not_change_group_identity(self):
        messages, overlap = exporter.normalize([self.row(ChatName='Stale participant name')])
        self.assertEqual((len(messages), overlap), (1, 0))
    def test_job_group_keeps_history_before_primary_cutover(self):
        row=self.row(ChatJID=exporter.JOBS_SOURCE,ChatName='Stale participant name',Timestamp='2025-01-01T00:00:00Z')
        messages, overlap=exporter.normalize([row],exporter.JOBS_SOURCE,exporter.JOBS_CUTOVER)
        self.assertEqual((len(messages), overlap), (1, 0))
        with self.assertRaises(ValueError):
            exporter.normalize([row],exporter.SOURCE,exporter.CUTOVER)
