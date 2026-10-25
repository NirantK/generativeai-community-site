# Community chat archive operations

The active sync runs entirely in Cloudflare every 30 minutes. Read [the cloud runbook](../chat-sync/README.md) before acting. Do not run local wacli sync or the former local importer procedure. Code changes deploy through GitHub and automatic Cloudflare deployment.

Authorized groups:

- The GenerativeAI Group: `120363049558306142@g.us`
- Job Posts & Talent: `120363323644237261@g.us`
- Project Demos & Events: `120363297860953641@g.us` (verify exact live identity before publication).

Inspect Workflow instances, recovery markers and per-group R2 last-success checkpoints first. An empty cache, export cap or source failure retains existing published history and does not advance that group’s checkpoint. Healthy groups can continue. Missing cache messages never imply deletion. Preserve administrator hiding/publication decisions.

The GenerativeAI source cutover remains **2026-09-17T00:01:16Z**. Retain legacy history and import only later namespaced wacli records. Other groups retain their own documented coverage. Backfill is best-effort and never proves full history.

All stored and published chat text is phone-redacted using consistent color-animal-time pseudonyms. Original live text may be sent transiently to Clef for classification; never store it in exports, Workflow results or logs. Admin review uses sanitized text. Model failure must not stop a valid archive import.

Verify D1 counts, indexed search integrity and date coverage after every import. Advance non-content last-success only after verified success. Do not change memberships or send the old one-time announcement again. Automatic routing replies remain paused until the reviewed trial and controlled quoted-reply test pass.
