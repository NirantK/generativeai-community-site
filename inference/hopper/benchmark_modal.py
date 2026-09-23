"""Reproducible Hopper reference and GGUF benchmarks on Modal.

Run: uv run modal run inference/hopper/benchmark_modal.py --variant reference
     uv run modal run inference/hopper/benchmark_modal.py --variant bf16
"""

from __future__ import annotations

import json
import hashlib
import gc
import math
import os
import statistics
import time
from pathlib import Path

import modal

BASE_REVISION = "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a"
ADAPTER_REVISION = "281d393f65ecfaf25c729a60b8f7fff61b49f9b4"
HOPPER_COMMIT = "c0ee1c92f1b12012bcc56ee13d6cc179ba1f97c9"
JEVBENCH_COMMIT = "75e6224ed8103bbc3485ca74820a2eaf7ce8abe0"
LLAMA_COMMIT = "b29c606e28a01b1bc8c1351026a0fa6e616bf6c4"

app = modal.App("hopper-optimization")
cache = modal.Volume.from_name("hopper-optimization-cache", create_if_missing=True)
artifacts = modal.Volume.from_name("hopper-optimization-artifacts", create_if_missing=True)

reference_image = (
    modal.Image.from_registry("nvidia/cuda:12.8.1-devel-ubuntu24.04", add_python="3.12")
    .apt_install("ca-certificates", "cmake", "g++", "git", "ninja-build")
    .run_commands(
        "pip install torch==2.8.0 transformers==5.17.0 peft==0.21.0 "
        "accelerate==1.15.0 flash-linear-attention==0.5.2 "
        "'sentencepiece>=0.1.98,<0.3' 'protobuf>=4.21,<5'",
        "pip install --no-deps "
        "'https://github.com/Dao-AILab/causal-conv1d/releases/download/v1.7.0/"
        "causal_conv1d-1.7.0%2Bcu12torch2.8cxx11abiTRUE-cp312-cp312-linux_x86_64.whl'",
        f"git clone https://github.com/hopit-ai/hopper.git /opt/hopper && "
        f"cd /opt/hopper && git checkout {HOPPER_COMMIT} && pip install --no-deps -e .",
        f"git clone https://github.com/fstandhartinger/jevbench.git /opt/jevbench && "
        f"cd /opt/jevbench && git checkout {JEVBENCH_COMMIT}",
    )
    .env({"HF_HOME": "/cache/huggingface", "PYTHONUNBUFFERED": "1", "PYTHONPATH": "/opt"})
)

def make_native_image(cuda_arch: str):
    return reference_image.run_commands(
        f"git clone https://github.com/ggml-org/llama.cpp.git /opt/llama.cpp && "
        f"cd /opt/llama.cpp && git checkout {LLAMA_COMMIT}",
        "cmake -S /opt/llama.cpp -B /opt/llama.cpp/build -G Ninja "
        "-DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON -DLLAMA_BUILD_TESTS=OFF "
        "-DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=OFF "
        f"-DCMAKE_CUDA_ARCHITECTURES={cuda_arch}",
        "cmake --build /opt/llama.cpp/build --target llama --parallel 4",
    ).add_local_file(
        "inference/hopper/native_score.cpp", "/opt/native_score.cpp", copy=True,
    ).add_local_file(
        "inference/hopper/native_score.py", "/opt/native_score.py", copy=True,
    ).run_commands(
        "g++ -O3 -std=c++17 -I/opt/llama.cpp/include -I/opt/llama.cpp/ggml/include "
        "/opt/native_score.cpp -L/opt/llama.cpp/build/bin -Wl,-rpath,/opt/llama.cpp/build/bin "
        "-L/usr/local/cuda/lib64/stubs -Wl,-rpath-link,/usr/local/cuda/lib64/stubs "
        "-lllama -lggml -lcuda -o /opt/hopper-native-score"
    )


native_image = make_native_image("86")
native_t4_image = make_native_image("75")


def tasks():
    for name in ("easy", "hard", "original"):
        with open(f"/opt/jevbench/datasets/public/{name}.jsonl") as source:
            for line in source:
                record = json.loads(line)
                yield record["id"], {
                    "state": record["state"], "question": record["question"],
                    "labels": record.get("labels"),
                }


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, math.ceil(fraction * len(ordered)) - 1)]


def summary(rows, startup_seconds, memory_gb, gpu):
    elapsed = [sum(row["seconds"]) for row in rows]
    forward = [row["forward_seconds"] for row in rows]
    return {
        "gpu": gpu, "count": len(rows), "startup_seconds": startup_seconds,
        "gpu_memory_gb": memory_gb,
        "p50_ms": statistics.median(elapsed) * 1000,
        "p95_ms": percentile(elapsed, 0.95) * 1000,
        "forward_p50_ms": statistics.median(forward) * 1000,
        "forward_p95_ms": percentile(forward, 0.95) * 1000,
        "mean_gpu_seconds_per_decision": statistics.mean(elapsed),
        "mean_tokens": statistics.mean(row["tokens"] for row in rows),
    }


def adapter_path():
    from huggingface_hub import snapshot_download

    return snapshot_download("HopitAI/hopper", revision=ADAPTER_REVISION)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@app.function(image=reference_image, gpu="A10", cpu=4, memory=32768,
              volumes={"/cache": cache}, timeout=3600)
def reference_benchmark():
    import torch
    from hopper_decisions.model import Decider

    started = time.perf_counter()
    decider = Decider(adapter=adapter_path())
    startup = time.perf_counter() - started
    rows = []
    for item_id, payload in tasks():
        result = decider.score(payload)
        rows.append({
            "id": item_id, "response": result["response"], "raw": result["raw"],
            "tokens": result["tokens"], "seconds": result["seconds"],
            "forward_seconds": result["seconds"][1],
        })
    cache.commit()
    return {"variant": "reference", "summary": summary(
        rows, startup, torch.cuda.max_memory_allocated() / 1e9, "A10"), "rows": rows}


@app.function(image=reference_image, gpu="A10", cpu=4, memory=32768,
              volumes={"/cache": cache}, timeout=3600)
def cold_reference():
    from hopper_decisions.model import Decider

    started = time.perf_counter()
    decider = Decider(adapter=adapter_path())
    model_initialization_seconds = time.perf_counter() - started
    del decider
    return {"variant": "reference", "gpu": "A10",
            "model_initialization_seconds": model_initialization_seconds}


def run_native_benchmark(variant: str, gpu: str):
    import subprocess
    from native_score import NativeDecider

    if variant not in ("bf16", "q8_0"):
        raise ValueError("variant must be bf16 or q8_0")
    model_path = f"/artifacts/hopper-{variant}-no-mtp.gguf"
    if not Path(model_path).is_file():
        raise FileNotFoundError(model_path)
    started = time.perf_counter()
    decider = NativeDecider(model_path, "/opt/hopper-native-score", "/opt/hopper/hopper_decisions/maps/hopper.json")
    # First real task pays any runtime graph initialization before timed items.
    first = next(tasks())[1]
    decider.score(first)
    startup = time.perf_counter() - started
    memory_mb = int(subprocess.check_output([
        "nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits",
    ], text=True).strip().splitlines()[0])
    rows = []
    try:
        for item_id, payload in tasks():
            result = decider.score(payload)
            rows.append({"id": item_id, "response": result["response"],
                         "raw": result["raw"], "tokens": result["tokens"],
                         "seconds": result["seconds"],
                         "forward_seconds": result["forward_seconds"]})
    finally:
        decider.close()
    result = {"variant": variant, "summary": summary(
        rows, startup, memory_mb / 1024, gpu), "rows": rows}
    remote_result = Path(f"/artifacts/benchmarks/{variant}-{gpu.lower()}.json")
    remote_result.parent.mkdir(parents=True, exist_ok=True)
    remote_result.write_text(json.dumps(result, indent=2) + "\n")
    artifacts.commit()
    return result


@app.function(image=native_image, gpu="A10", cpu=4, memory=32768,
              volumes={"/cache": cache, "/artifacts": artifacts}, timeout=3600)
def native_benchmark_a10(variant: str):
    return run_native_benchmark(variant, "A10")


@app.function(image=native_image, gpu="A10", cpu=4, memory=32768,
              volumes={"/cache": cache, "/artifacts": artifacts}, timeout=3600)
def cold_native_a10(variant: str):
    from native_score import NativeDecider

    started = time.perf_counter()
    decider = NativeDecider(f"/artifacts/hopper-{variant}-no-mtp.gguf",
                            "/opt/hopper-native-score", "/opt/hopper/hopper_decisions/maps/hopper.json")
    decider.score(next(tasks())[1])
    model_initialization_seconds = time.perf_counter() - started
    decider.close()
    return {"variant": variant, "gpu": "A10",
            "model_initialization_seconds": model_initialization_seconds}


@app.function(image=native_t4_image, gpu="T4", cpu=4, memory=32768,
              volumes={"/cache": cache, "/artifacts": artifacts}, timeout=3600)
def native_benchmark_t4(variant: str):
    return run_native_benchmark(variant, "T4")


@app.function(image=native_image, gpu="L4", cpu=4, memory=32768,
              volumes={"/cache": cache, "/artifacts": artifacts}, timeout=3600)
def native_benchmark_l4(variant: str):
    return run_native_benchmark(variant, "L4")


@app.function(image=native_image, gpu="A10", cpu=4, memory=32768,
              volumes={"/cache": cache, "/artifacts": artifacts}, timeout=7200)
def convert_weights():
    import subprocess
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    merged_dir = Path("/artifacts/merged")
    bf16 = Path("/artifacts/hopper-bf16-no-mtp.gguf")
    q8 = Path("/artifacts/hopper-q8_0-no-mtp.gguf")
    if not bf16.exists():
        model = AutoModelForCausalLM.from_pretrained(
            "Qwen/Qwen3.5-4B", revision=BASE_REVISION,
            dtype=torch.bfloat16, device_map="cuda", attn_implementation="sdpa")
        model = PeftModel.from_pretrained(model, adapter_path()).merge_and_unload()
        merged_dir.mkdir(parents=True, exist_ok=True)
        model.save_pretrained(merged_dir, safe_serialization=True, max_shard_size="4GB")
        AutoTokenizer.from_pretrained("Qwen/Qwen3.5-4B", revision=BASE_REVISION).save_pretrained(merged_dir)
        del model
        torch.cuda.empty_cache()
        subprocess.run([
            "python", "/opt/llama.cpp/convert_hf_to_gguf.py", str(merged_dir),
            "--no-mtp", "--outtype", "bf16", "--outfile", str(bf16),
        ], check=True)
    if not q8.exists():
        subprocess.run([
            "/opt/llama.cpp/build/bin/llama-quantize", str(bf16), str(q8), "Q8_0",
        ], check=True)
    cache.commit()
    artifacts.commit()
    return {"base_revision": BASE_REVISION, "adapter_revision": ADAPTER_REVISION,
            "llama_commit": LLAMA_COMMIT, "files": {
                path.name: {"bytes": path.stat().st_size, "sha256": sha256(path)}
                for path in (bf16, q8)}}


@app.function(image=native_image, gpu="A10", cpu=4, memory=32768,
              volumes={"/cache": cache, "/artifacts": artifacts}, timeout=7200)
def paired_benchmark(variant: str):
    """Run reference and GGUF sequentially on one A10 host."""
    import torch
    from hopper_decisions.model import Decider
    from native_score import NativeDecider

    if variant not in ("bf16", "q8_0"):
        raise ValueError(variant)
    started = time.perf_counter()
    decider = Decider(adapter=adapter_path())
    ref_startup = time.perf_counter() - started
    ref_rows = []
    for item_id, payload in tasks():
        result = decider.score(payload)
        ref_rows.append({"id": item_id, "response": result["response"], "raw": result["raw"],
                         "tokens": result["tokens"], "seconds": result["seconds"],
                         "forward_seconds": result["seconds"][1]})
    ref_memory = torch.cuda.max_memory_allocated() / 1e9
    del decider
    gc.collect()
    torch.cuda.empty_cache()
    started = time.perf_counter()
    native = NativeDecider(f"/artifacts/hopper-{variant}-no-mtp.gguf", "/opt/hopper-native-score",
                           "/opt/hopper/hopper_decisions/maps/hopper.json")
    native.score(next(tasks())[1])
    native_startup = time.perf_counter() - started
    candidate_rows = []
    try:
        for item_id, payload in tasks():
            result = native.score(payload)
            candidate_rows.append({"id": item_id, "response": result["response"],
                                   "raw": result["raw"], "tokens": result["tokens"],
                                   "seconds": result["seconds"],
                                   "forward_seconds": result["forward_seconds"]})
    finally:
        native.close()
    cache.commit()
    return {
        "reference": {"variant": "reference", "summary": summary(ref_rows, ref_startup, ref_memory, "A10"),
                      "rows": ref_rows},
        "candidate": {"variant": variant, "summary": summary(candidate_rows, native_startup, 0, "A10"),
                      "rows": candidate_rows},
    }


@app.local_entrypoint()
def main(variant: str = "reference", gpu: str = "A10"):
    if variant in ("cold-reference", "cold-q8_0"):
        if gpu != "A10":
            raise ValueError("cold-start comparison is A10-only")
        started = time.perf_counter()
        result = (cold_reference.remote() if variant == "cold-reference"
                  else cold_native_a10.remote("q8_0"))
        result["first_invocation_wall_seconds"] = time.perf_counter() - started
    elif variant == "reference":
        if gpu != "A10":
            raise ValueError("reference benchmark is pinned to A10")
        result = reference_benchmark.remote()
    elif variant in ("bf16", "q8_0"):
        candidates = {"A10": native_benchmark_a10, "T4": native_benchmark_t4,
                      "L4": native_benchmark_l4}
        result = candidates[gpu].remote(variant)
    elif variant in ("paired-bf16", "paired-q8_0"):
        if gpu != "A10":
            raise ValueError("paired benchmark is A10-only")
        result = paired_benchmark.remote(variant.removeprefix("paired-"))
    elif variant == "convert":
        result = convert_weights.remote()
    else:
        raise ValueError("variant must be reference, convert, bf16, q8_0, or paired-*")
    output = Path("inference/hopper/results")
    output.mkdir(parents=True, exist_ok=True)
    if variant.startswith("paired-"):
        for key in ("reference", "candidate"):
            target = output / f"{variant}-{key}-a10.json"
            target.write_text(json.dumps(result[key], indent=2) + "\n")
        print(json.dumps({key: result[key]["summary"] for key in ("reference", "candidate")}, indent=2))
        return
    target = output / ("conversion.json" if variant == "convert" else f"{variant}-{gpu.lower()}.json")
    target.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"file": str(target), **(result.get("summary") or result)}, indent=2))
