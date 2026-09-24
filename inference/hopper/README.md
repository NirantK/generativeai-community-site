# Hopper inference optimization

This is an isolated benchmark/port of [HopitAI/hopper](https://github.com/hopit-ai/hopper), not a deployed member model. It uses Hopper v1.1.0, its pinned Qwen3.5-4B base, adapter revision, calibration map, and JevBench v1.3.0 public tasks. Exact revisions and measured results are in [PERFORMANCE.md](PERFORMANCE.md).

The native scorer calls `llama_decode` across the prompt and reads final-position logits for the allowed answer-letter token IDs. It does **not** generate a token. `native_score.py` uses Hopper's own request parser, chat template, tokenizer, and calibration code. The model is merged once before conversion to BF16 GGUF; Q8_0 is quantized from that BF16 file. The merged model has no MTP tensors despite an optional MTP layer in its config, so the working export requires `--no-mtp`.

```sh
.venv/bin/modal run inference/hopper/reference_modal.py
.venv/bin/modal run inference/hopper/reference_modal.py --profile
.venv/bin/modal run inference/hopper/conversion_modal.py
.venv/bin/modal run inference/hopper/conversion_modal.py --mode repair
.venv/bin/modal run inference/hopper/benchmark_modal.py --variant paired-bf16
.venv/bin/modal run inference/hopper/benchmark_modal.py --variant paired-q8_0
.venv/bin/modal run inference/hopper/benchmark_modal.py --variant cold-reference
.venv/bin/modal run inference/hopper/benchmark_modal.py --variant cold-q8_0
python3 inference/hopper/compare.py inference/hopper/results/paired-bf16-reference-a10.json inference/hopper/results/paired-bf16-candidate-a10.json
```

The persistent Modal volumes `hopper-optimization-cache` and `hopper-optimization-artifacts` hold downloaded weights and derived GGUFs; no weights or credentials belong in Git. The benchmark writes local JSON results under `results/`. The paired A10 benchmark controls for host-to-host variation. Do not promote or publish a GGUF unless every public JevBench item is within `1e-3` probability error and all non-tie top answers agree. If neither candidate improves measured cost per decision by at least 15% without increasing p95 latency, use Hopper's upstream fast-kernel runtime instead. **Both tested GGUFs failed these gates; neither has been published.**
