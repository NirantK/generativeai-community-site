import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('importer', ROOT / 'scripts/import-chat-archive.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


class ChatImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.source = Path(self.tmp.name) / 'messages.json'
        self.db = sqlite3.connect(':memory:')
        self.db.executescript((ROOT / 'admissions/migrations/0005_chat_archive.sql').read_text())
        self.manifest = {'groups': [{'sourceRef': 'test-room', 'title': 'Test group', 'file': str(self.source), 'coverageNote': 'Synthetic fixture only'}]}

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def run_import(self, messages):
        self.source.write_text(json.dumps(messages))
        sql, totals = importer.build(self.manifest)
        self.db.executescript(sql)
        return sql, totals

    def message(self, **kwargs):
        return {'id': 'one', 'type': 'TEXT', 'timestamp': '2026-09-15T00:00:00Z', 'sender_name': 'Test Author', 'text': 'Original body', **kwargs}

    def test_html_and_metadata_are_removed_and_names_pseudonymized(self):
        sql, _ = self.run_import([self.message(sender_name='+91 12345 67890', senderID='sensitive-bridge', text='<mx-reply>Private quoted identity</mx-reply><p>It\'s useful<br>code &lt;b&gt;</p><script>bad()</script>', attachments=[{'secret':'private'}])])
        author, body = self.db.execute('SELECT author,body FROM chat_messages').fetchone()
        self.assertTrue(author.startswith('Member '))
        self.assertEqual(body, "It's useful\ncode <b>")
        for private in ('sensitive-bridge', '12345', 'Private quoted', 'bad()', 'attachments'):
            self.assertNotIn(private, sql)

    def test_idempotency_edits_fts_and_moderation_survive_reimport(self):
        self.run_import([self.message()])
        self.run_import([self.message(), self.message(text="Edited '); DROP TABLE chat_groups; --")])
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM chat_messages').fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM chat_search WHERE chat_search MATCH 'Original'").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM chat_search WHERE chat_search MATCH 'Edited'").fetchone()[0], 1)
        self.db.execute('UPDATE chat_messages SET hidden=1')
        self.db.execute('UPDATE chat_groups SET published=1')
        self.run_import([self.message()])
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM chat_search').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT published FROM chat_groups').fetchone()[0], 1)

    def test_deleted_messages_tombstone_and_nontext_is_skipped(self):
        self.run_import([self.message(isDeleted=True), self.message(id='notice', type='NOTICE'), self.message(id='file', type='FILE')])
        self.run_import([self.message()])
        self.assertEqual(self.db.execute('SELECT hidden,body FROM chat_messages').fetchall(), [(1, '')])
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM chat_search').fetchone()[0], 0)

    def test_moderator_history_is_excluded(self):
        self.manifest['groups'][0]['title'] = 'Moderators & Advisors'
        with self.assertRaises(ValueError):
            self.run_import([])


if __name__ == '__main__':
    unittest.main()
