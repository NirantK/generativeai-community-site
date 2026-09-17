# Cloudflare-hosted WhatsApp archive sync

Deployment is **not a completed cutover** until the live preflight and authenticated sync pass. `SYNC_ENABLED=false` is intentional during setup.

## Architecture

- A Worker cron checks daily at 09:00 IST. A successful checkpoint makes the workflow skip until three full days have elapsed; failures retry on the next daily check.
- One leased Durable Object owns the WhatsApp session and starts a native Linux `wacli` 0.18.2 container. No public Worker route, workers.dev URL, or HTTP administrative endpoint is enabled.
- Private R2 bucket `genaicommunity-chat-sync-private` stores the session credential, sanitized single-group cache, pending sanitized export, and non-content sync results. Never enable public access. Treat the session snapshot as a credential.
- The container uses the existing exporter/importer and source cutover. Only `120363049558306142@g.us` can be published. It retains namespaced IDs and applies explicit deletions; absence never deletes history.
- The Worker writes through the D1 binding. Scheduled runs do not use Wrangler OAuth, a Mac, or an account API token. GitHub needs a deployment token only at deployment time.
- Each per-message database batch updates its search entry atomically. Administrator hiding and group publication state survive. Last-success advances only after search-index verification. Pending exports survive import failure.
- The container checkpoint drops unrelated cached chats, contacts, locations, and media, and redacts phone-shaped text before R2 upload. `session.db` is a private authentication credential, not published chat data.

## Cutover checklist

1. Ensure the GitHub deployment token supports Workers/Containers image deployment and R2 bucket access, in addition to existing D1 access. Create the private R2 bucket once. Keep runtime credentials out of the image, logs, and repository.
2. Deploy this branch via GitHub after review. Run `genaicommunity-chat-sync` with `{"preflight":true}` through the authenticated Cloudflare Workflow API. This runs archive privacy and source-isolation checks inside the deployed container; it uses no WhatsApp credentials or production writes.
3. Stop local wacli sync processes. Create a private checkpoint using `chat-sync/container/checkpoint.py:checkpoint(Path('/Users/nirantk/.wacli-codex'))`; upload the result to `session/latest.tar.gz` in the private bucket. Do not run the same session concurrently on the Mac and Cloudflare.
4. Set `SYNC_ENABLED=true` through a GitHub configuration change. Trigger the workflow with `{"force":true}`. Verify it reports success, D1 index integrity, preserved legacy counts/publication status, and accurate coverage. Trigger again to confirm idempotency, then confirm restoration after container stop.
5. Only after success, remove the local archive refresh from the Codex automation. Preserve its separately authorized one-time September 18 announcement until it has been sent.
6. Delete temporary local checkpoints. Retain non-content audit results. Never claim full WhatsApp history: coverage is limited to available synced text.

A failed/empty/capped source export causes `could-not-sync` and no import. Checkpoint restoration failure requires operator action. If WhatsApp revokes the session, it still requires pairing again; hosting does not remove WhatsApp authentication requirements.
