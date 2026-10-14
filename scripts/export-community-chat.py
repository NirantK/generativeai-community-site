#!/usr/bin/env python3
"""Export the authorized WhatsApp group using wacli only; never print content."""
import argparse
import html
import json
import os
import subprocess
import sqlite3
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from chat_privacy import redact_text

CLI = os.environ.get('WACLI_BIN', '/opt/homebrew/bin/wacli')
STORE = os.environ.get('WACLI_STORE', '/Users/nirantk/.wacli-codex')
SOURCE = '120363049558306142@g.us'
TITLE = 'The GenerativeAI Group'
JOBS_SOURCE = '120363323644237261@g.us'
JOBS_TITLE = 'Job Posts & Talent'
DEMOS_SOURCE = '120363297860953641@g.us'
DEMOS_TITLE = 'Project Demos & Events'
# The published legacy archive ends here. Its IDs differ from WhatsApp IDs.
# Preserve it; never guess cross-source matches or re-import overlapping history.
CUTOVER = datetime.fromisoformat('2026-09-17T00:01:16+00:00')
JOBS_CUTOVER = datetime.fromtimestamp(0, timezone.utc)
GROUPS = ((SOURCE, TITLE, CUTOVER), (JOBS_SOURCE, JOBS_TITLE, JOBS_CUTOVER), (DEMOS_SOURCE, DEMOS_TITLE, JOBS_CUTOVER))
LIMIT = 1000000


def write(path, value):
    fd, tmp = tempfile.mkstemp(prefix='.export-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out, ensure_ascii=False)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def call(*args, timeout=90):
    result = subprocess.run([CLI, '--store', STORE, *args], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('wacli failed')
    return result.stdout


def normalize(messages, source=SOURCE, cutover=CUTOVER):
    selected = {}
    overlap = 0
    for raw in messages:
        # wacli's cached ChatName can be stale or even a participant name.
        # The explicit WhatsApp JID is the source identity; the title is display metadata.
        if raw.get('ChatJID') != source:
            raise ValueError('Source identity mismatch')
        at = datetime.fromisoformat(raw['Timestamp'].replace('Z', '+00:00'))
        if at.tzinfo is None:
            raise ValueError('Missing timestamp timezone')
        if at <= cutover:
            overlap += 1
            continue
        if not raw.get('MsgID'):
            raise ValueError('Missing WhatsApp message ID')
        mid = 'wacli:' + raw['MsgID']
        deleted = bool(raw.get('Revoked') or raw.get('DeletedForMe'))
        media = bool(raw.get('MediaType') or raw.get('ReactionToID'))
        selected[mid] = {
            'id': mid, 'timestamp': at.isoformat(),
            'sender_name': html.escape(redact_text(raw.get('SenderName') or '')),
            # The shared importer expects HTML; wacli text is plain text.
            'text': html.escape(redact_text(raw.get('Text') or '')),
            'type': 'OTHER' if media else 'TEXT',
            'is_deleted': deleted, 'is_hidden': False,
        }
    return list(selected.values()), overlap


def publication_counts(messages):
    """Report why cached records are not eligible for the text-only archive."""
    counts = {'textCandidates': 0, 'mediaOrReactions': 0, 'emptyText': 0, 'deleted': 0}
    for message in messages:
        if message['is_deleted']:
            counts['deleted'] += 1
        elif message['type'] != 'TEXT':
            counts['mediaOrReactions'] += 1
        elif not message['text'].strip():
            counts['emptyText'] += 1
        else:
            counts['textCandidates'] += 1
    return counts


def backfill_jobs():
    # This is the sole permitted on-demand backfill target. Never fan out to other chats.
    return call('history', 'backfill', '--chat', JOBS_SOURCE, '--count', '500',
                '--requests', '1', '--wait', '90s', timeout=240)


def verify_demos():
    payload = json.loads(call('groups', 'info', '--jid', DEMOS_SOURCE, '--json'))
    data = payload.get('data') or {}
    if not payload.get('success') or data.get('JID') != DEMOS_SOURCE or data.get('Name') != DEMOS_TITLE:
        raise ValueError('Live group identity mismatch')
    return {'sourceRef': DEMOS_SOURCE, 'title': DEMOS_TITLE}

def seed_demos_anchor(value):
    # Operator supplies authentic metadata from an existing cache, never text/sender/session keys.
    anchor = json.loads(value)
    if set(anchor) != {'messageId', 'timestamp', 'fromMe'} or not isinstance(anchor['messageId'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,200}', anchor['messageId']) or type(anchor['timestamp']) is not int or not 1420070400 <= anchor['timestamp'] < int(datetime.now(timezone.utc).timestamp()) or type(anchor['fromMe']) is not bool:
        raise ValueError('Invalid history anchor')
    with sqlite3.connect(Path(STORE) / 'wacli.db') as db:
        if db.execute('SELECT 1 FROM messages WHERE chat_jid=? LIMIT 1', (DEMOS_SOURCE,)).fetchone():
            return
        db.execute("INSERT INTO chats(jid,kind,name) VALUES(?,'group',?) ON CONFLICT(jid) DO NOTHING", (DEMOS_SOURCE, DEMOS_TITLE))
        db.execute('INSERT INTO messages(chat_jid,chat_name,msg_id,ts,from_me) VALUES(?,?,?,?,?)', (DEMOS_SOURCE, DEMOS_TITLE, anchor['messageId'], anchor['timestamp'], int(anchor['fromMe'])))

def bootstrap_demos(path):
    payload = json.loads(Path(path).read_text())
    if set(payload) != {'sourceRef','messages','anchorMessageId'} or payload['sourceRef'] != DEMOS_SOURCE or not isinstance(payload['messages'],list) or not 1 <= len(payload['messages']) <= 5000:
        raise ValueError('Invalid demos cache')
    with sqlite3.connect(Path(STORE) / 'wacli.db') as db:
        db.execute("INSERT INTO chats(jid,kind,name) VALUES(?,'group',?) ON CONFLICT(jid) DO NOTHING", (DEMOS_SOURCE,DEMOS_TITLE))
        for row in payload['messages']:
            if set(row) != {'messageId','timestamp','fromMe','author','text'} or not isinstance(row['messageId'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,200}',row['messageId']) or type(row['timestamp']) is not int or not 1420070400 <= row['timestamp'] < int(datetime.now(timezone.utc).timestamp()) or type(row['fromMe']) is not bool or not isinstance(row['author'],str) or len(row['author'])>200 or not isinstance(row['text'],str) or not 1 <= len(row['text']) <= 30000:
                raise ValueError('Invalid demos cache row')
            text,author=redact_text(row['text']),redact_text(row['author'])
            db.execute("INSERT INTO messages(chat_jid,chat_name,msg_id,ts,from_me,sender_jid,sender_name,text,display_text) VALUES(?,?,?,?,?,'',?,?,?) ON CONFLICT(chat_jid,msg_id) DO NOTHING",(DEMOS_SOURCE,DEMOS_TITLE,row['messageId'],row['timestamp'],int(row['fromMe']),author,text,text))
            # Fill the authentic empty metadata anchor only; never override cloud edits/deletions.
            if row['messageId'] == payload['anchorMessageId']:
                db.execute("UPDATE messages SET text=?,display_text=?,sender_name=? WHERE chat_jid=? AND msg_id=? AND ts=? AND from_me=? AND COALESCE(text,'')='' AND COALESCE(sender_jid,'')='' AND edited=0 AND revoked=0 AND deleted_for_me=0",(text,text,author,DEMOS_SOURCE,row['messageId'],row['timestamp'],int(row['fromMe'])))

def backfill_demos():
    return call('history', 'backfill', '--chat', DEMOS_SOURCE, '--count', '500',
                '--requests', '1', '--wait', '90s', timeout=240)

def main():
    global PHASE
    PHASE = 'arguments'
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--sync', action='store_true', help='Receive current WhatsApp messages before exporting')
    parser.add_argument('--backfill-jobs', action='store_true', help='Request one bounded older-history batch for Job Posts & Talent')
    parser.add_argument('--backfill-demos', action='store_true', help='Request one bounded older-history batch for Project Demos & Events')
    parser.add_argument('--bootstrap-demos-file',type=Path,help='Operator-only sanitized authentic pre-cloud demos cache')
    parser.add_argument('--demos-anchor', help='Operator-only authentic metadata anchor for an empty demos cache')
    args = parser.parse_args()
    if args.demos_anchor and not args.backfill_demos:
        raise ValueError('Anchor requires demos backfill')
    if args.backfill_jobs and args.backfill_demos:
        raise ValueError('Select one backfill group')
    if args.output_dir.resolve().is_relative_to(Path(__file__).resolve().parents[1]):
        raise ValueError('Keep exports outside the repository')
    args.output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    args.output_dir.chmod(0o700)
    PHASE = 'authentication'
    auth = json.loads(call('auth', 'status', '--json'))
    if not auth.get('success') or not auth.get('data', {}).get('authenticated'):
        raise RuntimeError('wacli is not authenticated')
    verified = None
    if args.sync or args.backfill_demos or args.bootstrap_demos_file:
        PHASE = 'verify-demos'
        verified = verify_demos()
    if args.bootstrap_demos_file:
        PHASE = 'bootstrap-demos'
        bootstrap_demos(args.bootstrap_demos_file)
    if args.backfill_demos:
        PHASE = 'backfill-demos'
        if args.demos_anchor:
            seed_demos_anchor(args.demos_anchor)
        backfill_demos()
    if args.backfill_jobs:
        PHASE = 'backfill'
        backfill_jobs()
    if args.sync:
        PHASE = 'live-sync'
        call('sync', '--once', '--idle-exit', '15s', '--max-reconnect', '45s',
             '--presence-mode', 'quiet', timeout=300)
    coverages, manifest = [], []
    for index, (source, title, cutover) in enumerate(GROUPS):
        PHASE = 'export-primary' if source == SOURCE else 'export-jobs' if source == JOBS_SOURCE else 'export-demos'
        payload = json.loads(call('messages', 'export', '--chat', source, '--limit', str(LIMIT), '--json'))
        if not payload.get('success'):
            raise RuntimeError('Export failed')
        raw = payload['data']['messages']
        if not raw or len(raw) >= LIMIT:
            coverages.append({'title':title,'sourceRef':source,'provider':'wacli','status':'could-not-sync','reason':'empty-cache' if not raw else 'export-cap','cachedRecords':len(raw),'messages':0,'cutover':cutover.isoformat(),'oldest':None,'newest':None,'verifiedIdentity':verified if source==DEMOS_SOURCE else None})
            continue
        PHASE = 'normalize-primary' if source == SOURCE else 'normalize-jobs' if source == JOBS_SOURCE else 'normalize-demos'
        messages, overlap = normalize(raw, source, cutover)
        dates = sorted(m['timestamp'] for m in messages)
        coverage = {
            'title': title, 'sourceRef': source, 'provider': 'wacli',
            'verifiedIdentity': verified if source == DEMOS_SOURCE else None,
            'exportedAt': datetime.now(timezone.utc).isoformat(),
            'cachedRecords': len(raw), 'messages': len(messages), 'overlapSkipped': overlap,
            'publicationCounts': publication_counts(messages),
            'cutover': cutover.isoformat(), 'oldest': dates[0] if dates else None,
            'newest': dates[-1] if dates else None,
            'limitation': 'Available wacli cache only; not proof of complete WhatsApp history.',
        }
        data = args.output_dir / f'messages-{index}.json'
        write(data, messages)
        note = f'Available wacli text after {cutover.isoformat()} may be incomplete.'
        if source == SOURCE:
            note = 'Historical archive begins 2024-11-17. ' + note
        manifest.append({'sourceRef': source, 'title': title, 'file': str(data.resolve()), 'coverageNote': note})
        coverages.append(coverage)
    write(args.output_dir / 'coverage.json', coverages)
    write(args.output_dir / 'manifest.json', {'groups': manifest})
    PHASE = 'complete'
    print(json.dumps(coverages))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Only a fixed phase and exception class leave the container; never print CLI output.
        print('Export failed: ' + globals().get('PHASE', 'unknown') + ':' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
