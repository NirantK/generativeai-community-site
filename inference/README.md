# Laya models on Modal

`laya_gguf_modal.py` serves Typed Decisions and `laya_multilingual_gguf_modal.py` serves the full Multilingual checkpoint as separate protected Modal apps. Each uses a pinned F16 GGUF and pinned `ggmlc` runtime on at most one NVIDIA T4. The F16 checkpoints preserve the published weights; quantization would not reduce the GPU's hourly rate. The runtime is built for the T4's sm75 architecture because the upstream release does not publish an sm75 binary. Each model file is verified against its Hugging Face SHA-256 during the image build.

Deploy from the repository root after authenticating the Modal CLI:

```sh
uv sync --frozen
uv run modal deploy inference/laya_gguf_modal.py
uv run modal deploy inference/laya_multilingual_gguf_modal.py
```

The deployed endpoints in the `scaledfocus` workspace are
`https://scaledfocus--genaicommunity-laya-typed-decisions-gguf-laya.us-east.modal.direct` and
`https://scaledfocus--genaicommunity-laya-multilingual-gguf-laya.us-east.modal.direct`.
Use `uv run modal curl <endpoint>/health` for an authenticated operator check;
API clients use a Modal proxy token. A successful health response reports
`device: cuda:0` and the corresponding `family` (`typed-decisions` or `multilingual`).

Modal's server proxy requires a workspace proxy token. Do not put that token in this repository or expose the Modal URL as an unauthenticated backend. The service provides `GET /health` and `POST /v1/decide` with a request body containing `state` and typed `questions`. See the [ggmlc Laya API](https://github.com/monatis/ggmlc/tree/v0.9.2/examples/laya) for the underlying question schema. `metered_proxy.py` forwards calls to ggmlc on loopback and adds `X-GPU-Seconds` to completed inference responses.

Both deployments keep zero warm containers and permit at most one T4 container each to control spend. Calls are serialized within each app so their measured durations do not overlap. Multilingual keeps a 30-second idle window so a cold-starting container remains available to the gateway's retries. A request after scale-to-zero can receive a 503 while the container starts; the site gateway retries those responses.

The public member route is `POST /api/v1/models/infer` on `genaicommunity.ai`. The site Worker authenticates approved members, selects the model from a server-side registry, invokes its protected endpoint, saves measured microseconds in D1, and returns per-call and cumulative usage. `GET /api/v1/models/usage?model=mys%2Flaya-multilingual-GGUF` reads the multilingual member total separately from `mys/laya-typed-decisions-GGUF`. The Modal proxy token is a Cloudflare Worker secret supplied through the `MODAL_PROXY_TOKEN` GitHub Actions secret; it never belongs in client code.

Hopper is a separate protected A10 Modal app in `inference/hopper_modal.py`. It uses the pinned upstream v1.1.0 BF16 fast-kernel scorer and calibration map; the experimental GGUF candidates failed the fidelity and p95 gates in `inference/hopper/PERFORMANCE.md` and were not published. The Hopper proxy accepts one typed question at `/v1/decide`, forwards it to the upstream one-pass `/v1/systemone` route, and adds `X-GPU-Seconds`. It exposes `/health` only after the model and fast kernels pass startup validation. `HopitAI/hopper` has a separate D1 usage total measured in A10 seconds. A cold scale-to-zero activation can take over a minute and is not included in the inference-seconds meter; the member gateway retries only unmetered startup 503s.

The meter measures elapsed inference time in the GPU container. It excludes cold start, upstream queueing, and idle time. It is an API usage measure rather than the exact Modal invoice total.

The multilingual checkpoint's own model card says its probabilities are uncalibrated and its zero-shot typed-decisions performance is weak. Validate and calibrate on the target language and workflow before treating confidence as a decision threshold.

## Separate billed-usage report

Run `uv run python inference/billed_usage.py --start 2026-09-22` to read the authoritative hourly billing report for this deployed app. It uses the locally configured workspace credential. Keep its output private to operators; member endpoints expose only their own inference usage.

The report preserves exact decimal costs for T4, CPU, and memory separately, together with the interval and retrieval timestamp. T4 seconds are a current-rate equivalent derived from the reported GPU cost, not a raw duration supplied by the billing API. The current partial hour is excluded, source reporting can be delayed, and repeated queries can include revisions. Credits and reservations affect the final invoice separately. Startup, idle time and direct operator calls remain app overhead; they are not allocated to member requests.

Validate the report conversion with `python3 -m unittest discover -s inference -p 'test_*.py'`.
