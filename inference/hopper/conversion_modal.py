"""Merge Hopper and export BF16 + Q8_0 GGUF without compiling CUDA llama.cpp."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import modal

app = modal.App("hopper-gguf-conversion")
cache = modal.Volume.from_name("hopper-optimization-cache", create_if_missing=True)
artifacts = modal.Volume.from_name("hopper-optimization-artifacts", create_if_missing=True)
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
        "git clone https://github.com/ggml-org/llama.cpp.git /opt/llama.cpp && "
        "cd /opt/llama.cpp && git checkout b29c606e28a01b1bc8c1351026a0fa6e616bf6c4",
        "pip install 'sentencepiece>=0.1.98,<0.3' 'protobuf>=4.21,<5'",
        "cmake -S /opt/llama.cpp -B /opt/llama.cpp/build -G Ninja "
        "-DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=OFF -DLLAMA_BUILD_TESTS=OFF "
        "-DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=OFF",
        "cmake --build /opt/llama.cpp/build --target llama-quantize --parallel 4",
    )
    .env({"HF_HOME": "/cache/huggingface", "PYTHONUNBUFFERED": "1"})
)


def checksum(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@app.function(image=image, gpu="A10", cpu=4, memory=32768,
              volumes={"/cache": cache, "/artifacts": artifacts}, timeout=7200)
def convert():
    import subprocess
    import torch
    from huggingface_hub import snapshot_download
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    base_revision = "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a"
    adapter_revision = "281d393f65ecfaf25c729a60b8f7fff61b49f9b4"
    bf16 = Path("/artifacts/hopper-bf16-no-mtp.gguf")
    q8 = Path("/artifacts/hopper-q8_0-no-mtp.gguf")
    merged_dir = Path("/artifacts/merged")
    if not bf16.exists():
        adapter = snapshot_download("HopitAI/hopper", revision=adapter_revision)
        model = AutoModelForCausalLM.from_pretrained(
            "Qwen/Qwen3.5-4B", revision=base_revision,
            dtype=torch.bfloat16, device_map="cuda", attn_implementation="sdpa")
        model = PeftModel.from_pretrained(model, adapter).merge_and_unload()
        merged_dir.mkdir(parents=True, exist_ok=True)
        model.save_pretrained(merged_dir, safe_serialization=True, max_shard_size="4GB")
        AutoTokenizer.from_pretrained("Qwen/Qwen3.5-4B", revision=base_revision).save_pretrained(merged_dir)
        del model
        torch.cuda.empty_cache()
        subprocess.run(["python", "/opt/llama.cpp/convert_hf_to_gguf.py", str(merged_dir),
                        "--no-mtp", "--outtype", "bf16", "--outfile", str(bf16)], check=True)
    if not q8.exists():
        subprocess.run(["/opt/llama.cpp/build/bin/llama-quantize",
                        str(bf16), str(q8), "Q8_0"], check=True)
    artifacts.commit()
    cache.commit()
    return {"base_revision": base_revision, "adapter_revision": adapter_revision,
            "llama_commit": "b29c606e28a01b1bc8c1351026a0fa6e616bf6c4",
            "files": {path.name: {"bytes": path.stat().st_size, "sha256": checksum(path)}
                      for path in (bf16, q8)}}


@app.function(image=image, cpu=4, memory=32768,
              volumes={"/cache": cache, "/artifacts": artifacts}, timeout=7200)
def reconvert_without_mtp():
    """The merged LM has no MTP tensors; exclude the config's unused MTP layer."""
    import subprocess

    merged_dir = Path("/artifacts/merged")
    config_path = merged_dir / "config.json"
    index_path = merged_dir / "model.safetensors.index.json"
    config = json.loads(config_path.read_text())
    weights = json.loads(index_path.read_text())["weight_map"]
    if any("mtp" in name.lower() or "layers.32." in name for name in weights):
        raise ValueError("merged weights contain MTP tensors; refusing to omit them")
    if config["num_hidden_layers"] != 32 or config["mtp_num_hidden_layers"] != 1:
        raise ValueError("unexpected source configuration")

    bf16 = Path("/artifacts/hopper-bf16-no-mtp.gguf")
    q8 = Path("/artifacts/hopper-q8_0-no-mtp.gguf")
    if not bf16.exists():
        subprocess.run(["python", "/opt/llama.cpp/convert_hf_to_gguf.py", str(merged_dir),
                        "--no-mtp", "--outtype", "bf16", "--outfile", str(bf16)], check=True)
    if not q8.exists():
        subprocess.run(["/opt/llama.cpp/build/bin/llama-quantize",
                        str(bf16), str(q8), "Q8_0"], check=True)
    artifacts.commit()
    return {"reason": "no MTP tensors in merged safetensors index; used --no-mtp",
            "source_config": {"num_hidden_layers": 32, "mtp_num_hidden_layers": 1},
            "files": {path.name: {"bytes": path.stat().st_size, "sha256": checksum(path)}
                      for path in (bf16, q8)}}


@app.local_entrypoint()
def main(mode: str = "merge"):
    result = reconvert_without_mtp.remote() if mode == "repair" else convert.remote()
    target = Path("inference/hopper/results/" + ("conversion-no-mtp.json" if mode == "repair" else "conversion.json"))
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"file": str(target), **result}, indent=2))
