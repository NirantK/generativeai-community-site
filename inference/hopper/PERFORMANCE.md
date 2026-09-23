# Hopper inference optimization, 2026-09-23

## Decision

Keep Hopper's pinned upstream BF16 fast-kernel runtime on an A10 for this phase. Neither llama.cpp GGUF candidate meets the release gates: both exceed the `1e-3` probability tolerance and both worsen paired A10 p95 latency and warm cost. No GGUF was published to Hugging Face or promoted to a member API. The optional MTP layer in the source config has no corresponding weights; valid conversion requires llama.cpp's `--no-mtp` option. The initial exports made without it cannot load and are retained only in the private Modal artifact volume.

## Reproduction

- Upstream Hopper `v1.1.0` at `c0ee1c92f1b12012bcc56ee13d6cc179ba1f97c9`, Qwen/Qwen3.5-4B at `851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a`, HopitAI/hopper adapter at `281d393f65ecfaf25c729a60b8f7fff61b49f9b4`, and the adapter's `hopper.json` calibration map.
- JevBench `v1.3.0` at `75e6224ed8103bbc3485ca74820a2eaf7ce8abe0`: all 231 public items, including nine prompts of at least 3,000 tokens and near-tie decisions. Maximum prompt length: 4,055 tokens.
- llama.cpp `v0.4.1` at `b29c606e28a01b1bc8c1351026a0fa6e616bf6c4`. LoRA merged once into BF16 weights; converter invoked with `--no-mtp`; Q8_0 quantized from the corrected BF16 GGUF. The scorer uses one `llama_decode` pass and reads final-position logits for Hopper's answer-letter token IDs. It does not generate text. Hopper's own tokenizer, request parsing, and calibration code are reused.
- Modal benchmark functions request one GPU, four CPU cores, and 32 GiB memory. Prompts run serially at concurrency one. The paired A10 tests run upstream and candidate sequentially on the same host to reduce host variance. HTTP overhead is not included.

## Measurements

Component profile of the upstream A10 scorer, warm p50: tokenization **0.851 ms**, model forward **61.473 ms**, restricted output-head logits/readout **0.157 ms**, calibration/response **0.037 ms**. The upstream reference's peak PyTorch GPU allocation was **9.24 GB**. These components were separately synchronized and measured over all 231 items.

| Runtime | GPU | Warm p50 / p95 | Mean s/decision | GPU memory | Model init + warm-up |
| --- | --- | ---: | ---: | ---: | ---: |
| Upstream fast kernels | A10 | 62.5 / 471 ms | 0.137 | 9.24 GB allocated | 80.1 s |
| Upstream fast kernels | L4 | 89.6 / 608 ms | 0.182 | 9.24 GB allocated | 109.3 s |
| Upstream fast kernels | T4 | 1,068 / 13,309 ms | 3.438 | 14.49 GB allocated | 344.2 s |
| GGUF BF16 | L4 | 92.5 / 939 ms | 0.259 | 8.45 GiB device used | 22.3 s |
| GGUF Q8_0 | L4 | 78.6 / 779 ms | 0.213 | 4.76 GiB device used | 13.0 s |
| GGUF BF16 | T4 | 609 / 6,590 ms | 1.788 | 8.42 GiB device used | 14.8 s |
| GGUF Q8_0 | T4 | 181 / 2,128 ms | 0.538 | 4.66 GiB device used | 41.8 s |

The A10 rows below are *paired*, so comparisons are within each host rather than against the separate baseline above. Peak allocated memory and device-used memory are different metrics and must not be interpreted as identical.

| A10 pair | Reference p50 / p95 | GGUF p50 / p95 | Reference / GGUF mean s | Max probability error | Top-answer flips |
| --- | ---: | ---: | ---: | ---: | ---: |
| BF16 | 65.2 / 517 ms | 63.9 / 673 ms | 0.155 / 0.184 | 0.0394 | 0 |
| Q8_0 | 55.1 / 468 ms | 68.9 / 732 ms | 0.136 / 0.196 | 0.0714 | 0 |

The BF16 long-prompt subset's worst probability error was 0.0275; its near-tie subset's was 0.0325. Q8_0's were 0.0250 and 0.0409. All exceed `1e-3`, despite no observed top-answer flips. L4 candidate fidelity also failed: worst errors 0.0335 (BF16) and 0.0775 (Q8_0); T4 errors were 0.0303 (BF16) and 0.0718 (Q8_0). The difference is larger than numerical noise acceptable to the benchmark and needs investigation before any GGUF could be served.

## Cost and scale-to-zero

At [Modal's listed resource rates](https://modal.com/pricing), with the requested four cores and 32 GiB, estimated warm cost per 1,000 decisions is **$0.059 upstream A10**, **$0.063 upstream L4**, **$0.988 upstream T4**, **$0.089 BF16 L4**, **$0.073 Q8_0 L4**, **$0.514 BF16 T4**, and **$0.155 Q8_0 T4**. In the paired A10 runs, BF16 increased warm cost from **$0.066 to $0.079** per 1,000 decisions and Q8_0 from **$0.058 to $0.084**. These are resource-rate estimates, not invoiced totals. They omit image pull, scheduling, network, and HTTP overhead and may understate billed memory/CPU usage.

The GGUF model-load-and-first-score times were much shorter than upstream's warm-up on already-running containers (paired A10: 13.9 s BF16 and 7.6 s Q8_0, versus 98.5 s and 73.0 s for their references). With a 30-second idle allowance and ten decisions per activation, the resulting **proxy** cost per completed decision is $0.00558 reference versus $0.00196 BF16, and $0.00448 reference versus $0.00170 Q8_0. This *suggests* a scale-to-zero advantage at sparse traffic, but it is not a full end-to-end cold-start measurement; container provisioning, image pull, and volume mount were outside the timer. With failed fidelity and p95 gates, this possible advantage cannot justify promotion.

## Artifacts and limits

The corrected private Volume artifacts are `hopper-bf16-no-mtp.gguf` (8,424,393,056 bytes, SHA-256 `87fd10ecc6d31c87b7ea24db9c2b5befb35bda5bde7e8cb89feafbb0d98661d9`) and `hopper-q8_0-no-mtp.gguf` (4,482,402,656 bytes, SHA-256 `4101b11af977f577b2b361efb716e6bee85d6cfd64fbbe1514d983f406fc390a`). Full per-item JSON is stored locally under ignored `results/`; scripts and comparison tests are tracked. The user authorized the `nirantk` Hugging Face namespace, but the validated-export condition was not met, so nothing was uploaded.

No member-API registration or site rollout was part of this optimization phase.
