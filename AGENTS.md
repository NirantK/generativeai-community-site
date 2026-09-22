# GenerativeAI Community repository

## Modal CLI

The Modal CLI is pinned in `pyproject.toml` and `uv.lock`. Run `uv sync --frozen` after cloning, then use `uv run modal <command>` from the repository root. Check the installed CLI with `uv run modal --help`.

Authenticate this computer through Modal's browser flow with `uv run modal setup`. Verify the active workspace with `uv run modal token info`. Modal stores CLI credentials in the local user configuration; keep them out of the repository, logs, and command arguments.

Modal API tokens use `ak-` / `as-` prefixes and authorize CLI workspace operations. Proxy tokens use `wk-` / `ws-` prefixes and authenticate requests to protected Modal endpoints; they cannot authenticate the CLI. Never put either kind of token in source control or `AGENTS.md`.

## Deployment

The site and admissions services deploy through `.github/workflows/ci.yml` after checks pass. Follow `docs/deployment.md`; do not deploy the site or its Cloudflare services directly from a workstation. Installing or authenticating the Modal CLI does not deploy a model or change the live site.
