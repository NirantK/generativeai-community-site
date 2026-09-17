#!/usr/bin/env python3
"""Export the authorized WhatsApp group using wacli only; never print content."""
import argparse
import html
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

CLI = '/opt/homebrew/bin/wacli'
STORE = '/Users/nirantk/.wacli-codex'
SOURCE = '120363049558306142@g.us'
TITLE = 'The GenerativeAI Group'
# The published legacy archive ends here. Its IDs differ from WhatsApp IDs.
# Preserve it; never guess cross-source matches or re-import overlapping history.
CUTOVER = datetime.fromisoformat('2026-09-17T00:01:16+00:00')
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


def normalize(messages):
    selected = {}
    overlap = 0
    for raw in messages:
        if raw.get('ChatJID') != SOURCE or raw.get('ChatName') != TITLE:
            raise ValueError('Source identity mismatch')
        at = datetime.fromisoformat(raw['Timestamp'].replace('Z', '+00:00'))
        if at.tzinfo is None:
            raise ValueError('Missing timestamp timezone')
        if at <= CUTOVER:
            overlap += 1
            continue
        if not raw.get('MsgID'):
            raise ValueError('Missing WhatsApp message ID')
        mid = 'wacli:' + raw['MsgID']
        deleted = bool(raw.get('Revoked') or raw.get('DeletedForMe'))
        media = bool(raw.get('MediaType') or raw.get('ReactionToID'))
        selected[mid] = {
            'id': mid, 'timestamp': at.isoformat(),
            'sender_name': html.escape(raw.get('SenderName') or ''),
            'sender_id': raw.get('SenderJID') or '',
            # The shared importer expects HTML; wacli text is plain text.
            'text': html.escape(raw.get('Text') or ''),
            'type': 'OTHER' if media else 'TEXT',
            'is_deleted': deleted, 'is_hidden': False,
        }
    return list(selected.values()), overlap


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--sync', action='store_true', help='Receive current WhatsApp messages before exporting')
    args = parser.parse_args()
    if args.output_dir.resolve().is_relative_to(Path(__file__).resolve().parents[1]):
        raise ValueError('Keep exports outside the repository')
    args.output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    args.output_dir.chmod(0o700)
    auth = json.loads(call('auth', 'status', '--json'))
    if not auth.get('success') or not auth.get('data', {}).get('authenticated'):
        raise RuntimeError('wacli is not authenticated')
    if args.sync:
        call('sync', '--once', '--idle-exit', '15s', '--max-reconnect', '45s', '--presence-mode', 'quiet', timeout=900)
    payload = json.loads(call('messages', 'export', '--chat', SOURCE, '--limit', str(LIMIT), '--json'))
    if not payload.get('success'):
        raise RuntimeError('Export failed')
    raw = payload['data']['messages']
    if not raw or len(raw) >= LIMIT:
        raise ValueError('Empty or potentially capped export; investigate before importing')
    messages, overlap = normalize(raw)
    dates = sorted(m['timestamp'] for m in messages)
    coverage = {
        'title': TITLE, 'sourceRef': SOURCE, 'provider': 'wacli',
        'exportedAt': datetime.now(timezone.utc).isoformat(),
        'cachedRecords': len(raw), 'messages': len(messages), 'overlapSkipped': overlap,
        'cutover': CUTOVER.isoformat(), 'oldest': dates[0] if dates else None,
        'newest': dates[-1] if dates else None,
        'limitation': 'Available wacli cache only; not proof of complete WhatsApp history. Legacy archive is preserved.',
    }
    data = args.output_dir / 'messages.json'
    write(data, messages)
    write(args.output_dir / 'coverage.json', coverage)
    note = 'Historical archive begins 2024-11-17. Updates use wacli after 2026-09-17T00:01:16Z. Available synced text may be incomplete.'
    write(args.output_dir / 'manifest.json', {'groups': [{'sourceRef': SOURCE, 'title': TITLE, 'file': str(data.resolve()), 'coverageNote': note}]})
    print(json.dumps(coverage))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Export failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
