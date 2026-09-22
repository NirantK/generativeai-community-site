# GenerativeAI Community repository

## Modal CLI

The Modal CLI is pinned in `pyproject.toml` and `uv.lock`. Run `uv sync --frozen` after cloning, then use `uv run modal <command>` from the repository root. Check the installed CLI with `uv run modal --help`.

Authenticate this computer through Modal's browser flow with `uv run modal setup`. Verify the active workspace with `uv run modal token info`. Modal stores CLI credentials in the local user configuration; keep them out of the repository, logs, and command arguments.

Modal API tokens use `ak-` / `as-` prefixes and authorize CLI workspace operations. Proxy tokens use `wk-` / `ws-` prefixes and authenticate requests to protected Modal endpoints; they cannot authenticate the CLI. Never put either kind of token in source control or `AGENTS.md`.

## Deployment

The site and admissions services deploy through `.github/workflows/ci.yml` after checks pass. Follow `docs/deployment.md`; do not deploy the site or its Cloudflare services directly from a workstation. Installing or authenticating the Modal CLI does not deploy a model or change the live site.

## Member model API

The `laya-typed-decisions` model is deployed in the `scaledfocus` Modal workspace. `inference/laya_gguf_modal.py` builds the pinned runtime and weights on a T4. `inference/metered_proxy.py` serializes inference and reports elapsed GPU-container seconds in `X-GPU-Seconds`. Model additions belong in the registry in `admissions/src/models.ts` and the public OpenAPI specification; callers always name the model.

The private admissions Worker owns member authentication, the model gateway, and the D1 `model_usage` ledger. Only approved members with a current bearer token can call it. Keep the Modal proxy credential in the `MODAL_PROXY_TOKEN` GitHub Actions secret and the deployed Worker secret, never in the repository or frontend. The CI workflow applies D1 migrations before deploying the Worker. The public route and usage docs are at `/models`.
