"""Run only the pinned upstream Hopper benchmark; no GGUF image is built."""

from __future__ import annotations

import json
import math
import statistics
import time
from pathlib import Path

import modal

app = modal.App("hopper-reference-benchmark")
cache = modal.Volume.from_name("hopper-optimization-cache", create_if_missing=True)
image = (
    modal.Image.from_registry("nvidia/cuda:12.8.1-devel-ubuntu24.04", add_python="3.12")
    .apt_install("ca-certificates", "cmake", "g++", "git", "ninja-build")
    .run_commands(
        "pip install torch==2.8.0 transformers==5.17.0 peft==0.21.0 "
        "accelerate==1.15.0 flash-linear-attention==0.5.2",
        "pip install --no-deps "
        "'https://github.com/Dao-AILab/causal-conv1d/releases/download/v1.7.0/"
        "causal_conv1d-1.7.0%2Bcu12torch2.8cxx11abiTRUE-cp312-cp312-linux_x86_64.whl'",
        "git clone https://github.com/hopit-ai/hopper.git /opt/hopper && "
        "cd /opt/hopper && git checkout c0ee1c92f1b12012bcc56ee13d6cc179ba1f97c9 "
        "&& pip install --no-deps -e .",
        "git clone https://github.com/fstandhartinger/jevbench.git /opt/jevbench && "
        "cd /opt/jevbench && git checkout 75e6224ed8103bbc3485ca74820a2eaf7ce8abe0",
    )
    .env({"HF_HOME": "/cache/huggingface", "PYTHONUNBUFFERED": "1"})
)


def run_reference(gpu: str):
    import torch
    from huggingface_hub import snapshot_download
    from hopper_decisions.model import Decider

    adapter = snapshot_download("HopitAI/hopper", revision="281d393f65ecfaf25c729a60b8f7fff61b49f9b4")
    started = time.perf_counter()
    decider = Decider(adapter=adapter)
    startup = time.perf_counter() - started
    rows = []
    for name in ("easy", "hard", "original"):
        with open(f"/opt/jevbench/datasets/public/{name}.jsonl") as source:
            for line in source:
                record = json.loads(line)
                payload = {"state": record["state"], "question": record["question"],
                           "labels": record.get("labels")}
                result = decider.score(payload)
                rows.append({"id": record["id"], "response": result["response"],
                             "raw": result["raw"], "tokens": result["tokens"],
                             "seconds": result["seconds"],
                             "forward_seconds": result["seconds"][1]})
    times = sorted(sum(row["seconds"]) for row in rows)
    forward = sorted(row["forward_seconds"] for row in rows)
    cache.commit()
    return {"variant": "reference", "rows": rows, "summary": {
        "gpu": gpu, "count": len(rows), "startup_seconds": startup,
        "gpu_memory_gb": torch.cuda.max_memory_allocated() / 1e9,
        "p50_ms": statistics.median(times) * 1000,
        "p95_ms": times[math.ceil(0.95 * len(times)) - 1] * 1000,
        "forward_p50_ms": statistics.median(forward) * 1000,
        "forward_p95_ms": forward[math.ceil(0.95 * len(forward)) - 1] * 1000,
        "mean_gpu_seconds_per_decision": statistics.mean(times),
        "mean_tokens": statistics.mean(row["tokens"] for row in rows),
    }}


@app.function(image=image, gpu="A10", cpu=4, memory=32768,
              volumes={"/cache": cache}, timeout=3600)
def benchmark_a10():
    return run_reference("A10")


@app.function(image=image, gpu="L4", cpu=4, memory=32768,
              volumes={"/cache": cache}, timeout=3600)
def benchmark_l4():
    return run_reference("L4")


@app.function(image=image, gpu="T4", cpu=4, memory=32768,
              volumes={"/cache": cache}, timeout=3600)
def benchmark_t4():
    return run_reference("T4")


@app.function(image=image, gpu="A10", cpu=4, memory=32768,
              volumes={"/cache": cache}, timeout=3600)
def profile_components():
    """Split the reference forward from its restricted output-head readout."""
    import torch
    from huggingface_hub import snapshot_download
    from hopper_decisions import calibration, request
    from hopper_decisions.model import Decider

    adapter = snapshot_download("HopitAI/hopper", revision="281d393f65ecfaf25c729a60b8f7fff61b49f9b4")
    decider = Decider(adapter=adapter)
    rows = []
    with torch.inference_mode():
        for name in ("easy", "hard", "original"):
            with open(f"/opt/jevbench/datasets/public/{name}.jsonl") as source:
                for line in source:
                    record = json.loads(line)
                    payload = {"state": record["state"], "question": record["question"],
                               "labels": record.get("labels")}
                    t0 = time.perf_counter()
                    example, key = request.parse(payload)
                    ids = decider.encode(example)
                    labels = request.names(example)
                    t1 = time.perf_counter()
                    hidden = decider.body(input_ids=torch.tensor([ids], device="cuda"),
                                          use_cache=False).last_hidden_state
                    torch.cuda.synchronize()
                    t2 = time.perf_counter()
                    logits = (decider.head[:len(labels)] @ hidden[0, -1]).float()
                    probabilities = torch.log_softmax(logits, -1).exp().tolist()
                    t3 = time.perf_counter()
                    raw = dict(zip(labels, probabilities))
                    request.response(key, example["kind"],
                                     calibration.apply(decider.map, example, raw),
                                     decider.name, len(ids))
                    t4 = time.perf_counter()
                    rows.append({"id": record["id"], "tokens": len(ids),
                                 "tokenization_seconds": t1 - t0,
                                 "model_forward_seconds": t2 - t1,
                                 "logits_readout_seconds": t3 - t2,
                                 "postprocessing_seconds": t4 - t3})
    cache.commit()
    return {"rows": rows, "summary": {key + "_p50_ms": statistics.median(
        row[key + "_seconds"] for row in rows) * 1000 for key in
        ("tokenization", "model_forward", "logits_readout", "postprocessing")}}


@app.local_entrypoint()
def main(gpu: str = "A10", profile: bool = False):
    if profile:
        result = profile_components.remote()
        target = Path("inference/hopper/results/reference-a10-components.json")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps({"file": str(target), **result["summary"]}, indent=2))
        return
    functions = {"A10": benchmark_a10, "L4": benchmark_l4, "T4": benchmark_t4}
    result = functions[gpu].remote()
    target = Path(f"inference/hopper/results/reference-{gpu.lower()}.json")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"file": str(target), **result["summary"]}, indent=2))
