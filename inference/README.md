# Laya Typed-Decisions on Modal

`laya_gguf_modal.py` serves the pinned F16 GGUF using the pinned `ggmlc` runtime on one NVIDIA T4. The F16 checkpoint preserves the published weights; quantization would not reduce the GPU's hourly rate. The runtime is built for the T4's sm75 architecture because the upstream release does not publish an sm75 binary. The model file is verified against its Hugging Face SHA-256 during the image build.

Deploy from the repository root after authenticating the Modal CLI:

```sh
uv sync --frozen
uv run modal deploy inference/laya_gguf_modal.py
```

The deployed endpoint in the `scaledfocus` workspace is
`https://scaledfocus--genaicommunity-laya-typed-decisions-gguf-laya.us-east.modal.direct`.
Use `uv run modal curl <endpoint>/health` for an authenticated operator check;
API clients use a Modal proxy token. A successful health response reports
`device: cuda:0` and `family: typed-decisions`.

Modal's server proxy requires a workspace proxy token. Do not put that token in this repository or expose the Modal URL as an unauthenticated backend. The service provides `GET /health`, `POST /v1/systemone`, and `POST /v1/decide` with a request body containing `state` and typed `questions`. See the [ggmlc Laya API](https://github.com/monatis/ggmlc/tree/v0.9.2/examples/laya) for the full schema.

The deployment keeps zero warm containers and permits at most one T4 container to control spend. A request after scale-to-zero can receive a 503 while the container starts; clients should retry it. No site route, member authentication, or usage meter is added here.
