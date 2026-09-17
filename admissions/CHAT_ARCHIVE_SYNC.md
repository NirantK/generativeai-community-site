# The GenerativeAI Group archive refresh

## Authorized scope and schedule

The community owner authorized publication of **The GenerativeAI Group** and a refresh every three days on 17 September 2026. The active local Codex automation is `sync-generativeai-group-archive`, attached to the community website task, at 09:00 Asia/Kolkata every three days.

- Beeper room: `!ahQ2N95zrRGpWPQ0Vznh:beeper.local`
- WhatsApp group: `120363049558306142@g.us`
- Import `sourceRef`: `120363049558306142@g.us`; do not change it between runs.
- D1 group ID: `80a506e83ca3ccc963bfbbc5493b124e85e5a87d7e074835728a1d78a9b38fca`
- Production database: `genai_admissions`, configured in `admissions/wrangler.jsonc`, root environment (`--env ''`).

No other group is authorized by this schedule. In particular, exclude Moderators & Advisors, announcement groups, direct messages, and linked subgroups. Verify the exact source room's title and WhatsApp identity before retrieval; do not substitute a fuzzy match.

## Refresh procedure

Use the Beeper skill through a delegated agent, as required by the workspace instructions. Beeper Desktop and its local API must be running on this Mac. Retrieve credentials through the existing keychain integration without printing them. Existing Wrangler authentication provides D1 access. A failed or unauthenticated fetch is not evidence that the archive is empty.

1. Create a new private run directory outside the repository (0700 directory, 0600 files). Run `uv run scripts/export-community-chat.py --output-dir PRIVATE_RUN_DIRECTORY` through the delegated Beeper agent to export all available messages from the selected room with pagination. Save a bare JSON array plus metadata describing page count, message count, timestamps, and whether the local API reported the end of pagination. Never claim full WhatsApp history: this is available synced Beeper history.
2. Build a private manifest with the exact `sourceRef` above, title `The GenerativeAI Group`, export file path, and truthful `coverageNote`. If pagination fails or hits a cap, report it; do not overwrite the last successful state with an empty/partial failure. No automatic deletion based on absence from an export.
3. Run `python3 scripts/import-chat-archive.py PRIVATE_MANIFEST --output PRIVATE_SQL`. The importer allows only text, removes HTML/quoted identity metadata, pseudonymizes phone-like author names, and excludes attachments/system notices. Explicit deleted/hidden source records become tombstones. It preserves admin-hidden messages and current group publication on re-import.
4. Validate the generated SQL against a temporary SQLite database with `admissions/migrations/0005_chat_archive.sql`, checking message/FTS counts and timestamp range. Do not print bodies, credentials, or raw SQL. Review unexpected count drops or oversized-message failures before touching production.
5. Import data with `npx --no-install wrangler d1 execute genai_admissions --config admissions/wrangler.jsonc --env '' --remote --file PRIVATE_SQL --yes`. Save logs privately; inspect success and bounded error summaries. This is a data refresh, not a Worker/Pages code deployment. Code changes continue through GitHub.
6. Verify production counts, timestamp range, FTS row coverage, and the selected group's visibility. Record metrics and a digest of normalized message ID, timestamp, author, body, and hidden state in the private run state; compare this digest to distinguish content changes from a routine refresh. Leave all other groups unchanged. Future syncs **must not republish** a group that an administrator has unpublished; ordinary import preserves visibility. The first publication was explicitly authorized by the owner and is a separate audited action.
7. Remove transient raw exports/generated SQL once a successful import is verified; retain only non-content metrics needed to compare the next run. Keep the previously published database intact if fetching, parsing, or importing fails. A retry of the same import is idempotent and restores FTS entries if an interrupted import left partial progress.

There is no need to sign into LinkedIn or send a message/email for a scheduled refresh. Do not invent a member account or weaken access checks to test it. Approved members and their valid application tokens read the archive through the already-deployed website/API. Check unauthenticated access on `https://genaicommunity.ai`; never use a `pages.dev` domain.

## Reporting

Notify for added/updated/deleted history, failures, or required input. Report counts and available date coverage, not message contents. Stay quiet when nothing meaningful changed. Be explicit if the local computer/Beeper/authentication was unavailable; do not claim that a scheduled sync succeeded just because the schedule exists.
