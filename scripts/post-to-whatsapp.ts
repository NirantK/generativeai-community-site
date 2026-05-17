#!/usr/bin/env -S node --experimental-strip-types
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SITE = process.env.SITE_URL ?? 'https://genaicommunity.ai';
const KEY = process.env.OUTBOX_API_KEY;
const CHAT = process.env.WA_CHAT ?? 'GenAI Jobs';
const BEEPER = process.env.BEEPER_CLI ?? `${process.env.HOME}/.claude/skills/beeper/beeper.py`;
const STATE_FILE = process.env.OUTBOX_STATE ?? join(tmpdir(), 'genai-outbox.state.json');

if (!KEY) {
  console.error('OUTBOX_API_KEY missing');
  process.exit(1);
}

const headers = { 'x-outbox-key': KEY, 'content-type': 'application/json' };

const res = await fetch(`${SITE}/api/jobs/pending-wa`, { headers });
if (!res.ok) {
  console.error(`pending-wa returned ${res.status}`);
  process.exit(1);
}
const pending = (await res.json()) as Array<{ id: string; message: string }>;

for (const item of pending) {
  const r = spawnSync('uv', ['run', BEEPER, 'post', '--chat', CHAT, '--text', item.message], {
    stdio: 'inherit',
  });
  const ok = r.status === 0;
  await fetch(`${SITE}/api/jobs/mark-posted`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: item.id, status: ok ? 'posted' : 'failed' }),
  });
  console.log(`${item.id}: ${ok ? 'posted' : 'failed'}`);
}

const state = existsSync(STATE_FILE)
  ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { lastCleanup?: number })
  : {};
if (!state.lastCleanup || Date.now() - state.lastCleanup > 3_600_000) {
  const c = await fetch(`${SITE}/api/cron/cleanup`, { headers });
  console.log(`cleanup: ${c.status}`);
  writeFileSync(STATE_FILE, JSON.stringify({ ...state, lastCleanup: Date.now() }));
}
