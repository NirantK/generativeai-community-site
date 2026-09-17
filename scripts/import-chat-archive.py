#!/usr/bin/env python3
"""Prepare a private, idempotent D1 import from explicitly selected Beeper exports.

Does not fetch, publish, or deploy anything. See admissions/README.md.
"""
import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from chat_privacy import redact_text


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skipped = []

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'mx-reply'):
            self.skipped.append(tag)
        if not self.skipped and tag in ('br', 'p', 'div', 'li', 'pre'):
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if self.skipped:
            if tag == self.skipped[-1]:
                self.skipped.pop()
        elif tag in ('p', 'div', 'li', 'pre'):
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.skipped:
            self.parts.append(data)


def plain(value):
    parser = PlainText()
    parser.feed(str(value or ''))
    return ''.join(parser.parts).replace('\x00', '').strip()


def hashed(value):
    return hashlib.sha256(value.encode()).hexdigest()


def literal(value):
    return "'" + str(value).replace('\x00', '').replace("'", "''") + "'"


def timestamp(value):
    parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Message timestamps must include a timezone')
    return int(parsed.timestamp() * 1000)


def build(manifest):
    statements = []
    totals = {'groups': 0, 'messages': 0, 'tombstones': 0, 'skipped': 0}
    now = int(datetime.now(timezone.utc).timestamp() * 1000)
    seen_groups = set()
    for group in manifest['groups']:
        ref, title = group['sourceRef'], plain(group['title'])
        if not ref or not title or ref in seen_groups:
            raise ValueError('Groups require unique sourceRef and nonempty title')
        seen_groups.add(ref)
        # Moderator history requires a separate explicit implementation decision.
        if 'moderator' in title.lower() or ref in ('120363159390549956@g.us',):
            raise ValueError('Moderator groups are excluded from this importer')
        gid = hashed(ref)
        coverage = str(group['coverageNote']).strip()
        if not coverage:
            raise ValueError('Describe available source coverage; do not assume complete history')
        messages = json.loads(Path(group['file']).read_text())
        if not isinstance(messages, list):
            raise ValueError('Expected a Beeper JSON message array')
        statements.append(f'INSERT INTO chat_groups(id,title,source_ref,imported_at,coverage_note) VALUES({literal(gid)},{literal(title)},{literal(ref)},{now},{literal(coverage)}) ON CONFLICT(id) DO UPDATE SET title=excluded.title,imported_at=excluded.imported_at,coverage_note=excluded.coverage_note;')
        # Source exports may repeat IDs. Use the last version, retaining hidden tombstones.
        unique = {}
        for message in messages:
            source_id = str(message.get('id') or '')
            if not source_id:
                totals['skipped'] += 1
                continue
            previous = unique.get(source_id, {})
            if not any(previous.get(k) for k in ('is_deleted', 'isDeleted', 'is_hidden', 'isHidden')):
                unique[source_id] = message
        for source_id, message in unique.items():
            mid = hashed(ref + '\0' + source_id)
            hidden = any(message.get(k) for k in ('is_deleted', 'isDeleted', 'is_hidden', 'isHidden'))
            statements.append(f'DELETE FROM chat_search WHERE rowid=(SELECT rowid FROM chat_messages WHERE id={literal(mid)});') if hidden else None
            if hidden:
                # Store a tombstone even when the source body is already gone.
                statements.append(f"INSERT INTO chat_messages(id,group_id,source_id,posted_at,author,body,hidden) VALUES({literal(mid)},{literal(gid)},{literal(source_id)},0,'','',1) ON CONFLICT(id) DO UPDATE SET body='',author='',hidden=1;")
                totals['tombstones'] += 1
                continue
            if str(message.get('type', 'TEXT')).upper() != 'TEXT':
                totals['skipped'] += 1
                continue
            text = redact_text(plain(message.get('text')))
            if not text:
                totals['skipped'] += 1
                continue
            if len(text) > 30000 or len(text.encode('utf-8')) > 60000:
                raise ValueError('Message exceeds the import size limit; review instead of silently truncating')
            posted = timestamp(message.get('timestamp'))
            if posted < 0 or posted > now + 86400000:
                raise ValueError('Unexpected message timestamp')
            author = redact_text(plain(message.get('sender_name') or message.get('senderName')))
            sender = str(message.get('sender_id') or message.get('senderID') or source_id)
            # Display names sometimes contain raw phone/bridge identities. Never expose those.
            if not author or '@' in author:
                author = 'Member ' + hashed(ref + '\0' + sender)[:10]
            statements.append(f'DELETE FROM chat_search WHERE rowid=(SELECT rowid FROM chat_messages WHERE id={literal(mid)});')
            statements.append(f'INSERT INTO chat_messages(id,group_id,source_id,posted_at,author,body) VALUES({literal(mid)},{literal(gid)},{literal(source_id)},{posted},{literal(author[:200])},{literal(text)}) ON CONFLICT(id) DO UPDATE SET posted_at=excluded.posted_at,author=CASE WHEN chat_messages.hidden=0 THEN excluded.author ELSE chat_messages.author END,body=CASE WHEN chat_messages.hidden=0 THEN excluded.body ELSE chat_messages.body END;')
            statements.append(f'INSERT INTO chat_search(rowid,body,author) SELECT rowid,body,author FROM chat_messages WHERE id={literal(mid)} AND hidden=0;')
            totals['messages'] += 1
        action_id = hashed(ref + '\0' + str(now))
        statements.append(f"INSERT OR IGNORE INTO chat_archive_actions(id,actor,action,target,at) VALUES({literal(action_id)},'operator-import','import',{literal(gid)},{now});")
        totals['groups'] += 1
    return '\n'.join(statements) + '\n', totals


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[1]
    for path in (args.manifest, args.output):
        if path.resolve().is_relative_to(repository):
            parser.error('Keep source manifests and generated SQL outside the repository')
    manifest = json.loads(args.manifest.read_text())
    for group in manifest['groups']:
        if Path(group['file']).resolve().is_relative_to(repository):
            parser.error('Keep raw exports outside the repository')
    sql, totals = build(manifest)
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(sql)
    print(json.dumps(totals))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError) as error:
        # Never print source message content on failure.
        print('Import preparation failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
