# Cloudflare-hosted WhatsApp archive sync

The live preflight and authenticated two-group sync passed on 2026-09-24. Scheduling is enabled. The archive is limited to available synced text; it is not a complete copy of WhatsApp history.

## Architecture

- A Worker cron checks daily at 09:00 IST. A successful checkpoint makes the workflow skip until the third subsequent calendar day in Asia/Kolkata; failures retry on the next daily check.
- One leased Durable Object owns the WhatsApp session and starts a native Linux `wacli` 0.18.2 container. No public Worker route, workers.dev URL, or HTTP administrative endpoint is enabled.
- Private R2 bucket `genaicommunity-chat-sync-private` stores the session credential, sanitized two-group cache, pending sanitized export, and non-content sync results. Never enable public access. Treat the session snapshot as a credential.
- Cloudflare R2 lifecycle rule `chat-sync-checkpoints-30-days` expires immutable exports under `session/checkpoints/` after 30 days. Cloudflare processes expirations automatically, typically within 24 hours of expiry. The active `session/latest.tar.gz` is outside this prefix and must remain available for session restore. The default multipart-abort rule remains enabled.
- The container syncs only `120363049558306142@g.us` (The GenerativeAI Group) and `120363323644237261@g.us` (Job Posts & Talent). The first group's legacy cutover is preserved; the second group uses available wacli history. It retains namespaced IDs and applies explicit deletions; absence never deletes history.
- The Worker writes through the D1 binding. Scheduled runs do not use Wrangler OAuth, a Mac, or an account API token. GitHub needs a deployment token only at deployment time.
- Each per-message database batch updates its search entry atomically. Administrator hiding and group publication state survive. Last-success advances only after search-index verification. Pending exports survive import failure.
- The container checkpoint drops unrelated cached chats, contacts, locations, and media, and redacts phone-shaped text before R2 upload. `session.db` is a private authentication credential, not published chat data. Job Posts & Talent was published after its cloud import and search-index verification on 2026-09-24.

## Operations

1. Inspect `genaicommunity-chat-sync` Workflow instances and the private R2 `last-success.json` after a run. The two published group rows in D1 must have visible messages and a consistent `chat_search` index.
2. After a container image deployment, run authenticated preflight with `{"preflight":true}` before a controlled `{"force":true}` sync. Preflight stops the reserved container so the next run uses the updated image.
3. If the cloud session needs replacement, stop local wacli sync processes, create a private checkpoint with `chat-sync/container/checkpoint.py:checkpoint(Path('/Users/nirantk/.wacli-codex'))`, and upload it to `session/latest.tar.gz`. Never run the same session on the Mac and Cloudflare concurrently.
4. Keep runtime credentials out of the image, logs, and repository. Delete temporary local checkpoints after verification.
5. Verify retention with `CLOUDFLARE_ACCOUNT_ID=076c525b59739562570401e48fc0651c npx wrangler r2 bucket lifecycle list genaicommunity-chat-sync-private --config chat-sync/wrangler.jsonc`. The `chat-sync-checkpoints-30-days` rule must be enabled with prefix `session/checkpoints/` and expiry of 30 days. Do not apply a bucket-wide expiry: it would remove the active session and sync state.

On 2026-09-24, five checkpoint copies were found to contain unrelated cached chat rows and deleted after explicit owner approval. Five audited copies containing only the two intended groups were kept, along with `session/latest.tar.gz`. The retention rule expires immutable copies after 30 days. New checkpoints close SQLite before archiving and pass a WAL-mode privacy test.

A failed/empty/capped source export causes `could-not-sync` and no import. Checkpoint restoration failure requires operator action. If WhatsApp revokes the session, it still requires pairing again; hosting does not remove WhatsApp authentication requirements.
