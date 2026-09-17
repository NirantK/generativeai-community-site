# The GenerativeAI Group archive refresh

## Authorized source and schedule

Use **wacli exclusively**. The owner selected The GenerativeAI Group and a refresh every three days. The active local Codex automation `sync-generativeai-group-archive` runs at 09:00 Asia/Kolkata every three days in the community website task.

- CLI: `/opt/homebrew/bin/wacli`
- Session store: `/Users/nirantk/.wacli-codex` (always pass explicitly)
- Group and importer `sourceRef`: `120363049558306142@g.us`
- Expected name: `The GenerativeAI Group`
- D1 group ID: `80a506e83ca3ccc963bfbbc5493b124e85e5a87d7e074835728a1d78a9b38fca`
- Production database: `genai_admissions`, config `admissions/wrangler.jsonc`, root environment `--env ''`.
- Last-success metrics: `/Users/nirantk/Library/Application Support/GenAICommunity/archive-sync/last-success.json`.

Only this group is authorized for publication. Exclude other groups and direct messages. Never send a message, change membership, or use Beeper as a fallback. The Mac, WhatsApp session, and network must be available; Beeper Desktop is not required.

## Source transition

The existing 29,851-message archive was imported before this source change. Its identifiers differ from native WhatsApp IDs. Preserve that history. The exporter has an immutable cutover at **2026-09-17T00:01:16Z**, the last archived source message. It skips earlier/equal records and prefixes new source IDs with `wacli:`. This avoids duplicating overlapping cached history without guessing matches.

Edits/deletions for post-cutover wacli records retain stable IDs and use the existing importer. Corrections to older legacy records need administrator handling because their WhatsApp IDs are not mapped. A short wacli cache never authorizes deleting old archive rows. Do not reset the cutover to the newest sync timestamp: re-reading post-cutover messages is needed to catch edits/deletions.

## Refresh procedure

1. Create a fresh private run directory outside Git (0700). Run `python3 scripts/export-community-chat.py --sync --output-dir PRIVATE_RUN_DIRECTORY`. This checks authentication, receives messages with a bounded wacli sync, exports only the exact group, verifies identity, and writes normalized messages/coverage/manifest files as 0600. The underlying sync receives WhatsApp account events locally; only the authorized group's text is exported for publication. Do not enable media downloads.
2. Treat sync errors, zero source records, or a capped export as failures. Preserve the previous archive and report the problem. Zero **post-cutover** messages can be a valid no-change result when old cached records were successfully read. Available local cache is not proof of complete WhatsApp history. Optional targeted `wacli history backfill --chat 120363049558306142@g.us` may request history, but overlapping legacy records remain excluded from import.
3. For new-source records, run `python3 scripts/import-chat-archive.py PRIVATE_MANIFEST --output PRIVATE_SQL`. The exporter escapes wacli's plain text for the shared HTML-normalizing importer. Media/reactions are excluded, phone-like author names are pseudonymized, explicit deletions become tombstones, and administrator hiding/publication choices are preserved.
4. Validate SQL in temporary SQLite using `admissions/migrations/0005_chat_archive.sql`; compare counts, timestamps, FTS rows, and a normalized digest. Keep bodies/credentials/raw SQL out of logs. Do not use a local fresh database's count as the expected total production count: legacy history remains in production.
5. Import with `npx --no-install wrangler d1 execute genai_admissions --config admissions/wrangler.jsonc --env '' --remote --file PRIVATE_SQL --yes`. Save logs privately. This updates data; application code deploys only through GitHub.
6. Verify production group counts, full-text index coverage, and current publication state. Never republish a group an administrator has unpublished. Update last-success metrics only after verified success; distinguish the new-source digest from the old full-archive baseline. The first wacli run initializes its own provider digest.
7. Remove temporary raw exports/SQL after verification. Retain only non-content metrics for subsequent comparisons. No deletion based on absence from an export. Retrying an import is idempotent and preserves hidden records.

No LinkedIn login, invented test member, or email is needed. Verify public access remains blocked on `https://genaicommunity.ai`; do not test on `pages.dev`.

## Reporting

Notify for meaningful additions/edits/deletions, failures, or required input. Report counts/date coverage, never message bodies. Stay quiet on unchanged successful runs. Do not claim success when wacli authentication, sync, or database verification failed.
