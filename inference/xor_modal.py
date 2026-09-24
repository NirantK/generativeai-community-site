"""Pinned Xor SGLang service. Hydrate the verified model volume before deployment."""

import hashlib
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import urlopen

import modal

APP_NAME = "genaicommunity-xor"
REVISION = "679decd4c669e5c37f4ac29dbd9957997424c876"
SGLANG_IMAGE = "lmsysorg/sglang@sha256:6bcaa47db52f78ce0d67863b8b2431221b79bc23204a80cad757fa819d00e921"
MODEL_DIR = Path("/models/xor")
GPU = os.environ.get("XOR_GPU", "A100-80GB")
GPU_COUNT = int(GPU.rsplit(":", 1)[1]) if ":" in GPU else 1
MAX_PREFILL = "250000" if GPU_COUNT == 2 else "16384"
MEM_FRACTION = "0.85"
CHECKSUMS = {
    "model-00001-of-00002.safetensors": "7b67cdcf3fbe1a6311638e3dc8b28fdf7fde16f72a3d58b41bf40871c301f149",
    "model-00002-of-00002.safetensors": "5c90ac336cd66b9e36ddde347ca2b67523fe7b787693a194ffad05b4bbec3af8",
    "model.safetensors.index.json": "a4247f5d5f3f409c5ebf75164d84513db1a4ea49f876d1d2a841aa6300e4cedd",
    "config.json": "85eeca65b582011bb78e97bdbef4eee4127df73c96eed698dadac34c1ebbb7b0",
    "generation_config.json": "a4cef85934ea1fdcb207944dbc6eee70dbbf16806874428556ae33023336c0a4",
    "tokenizer.json": "06b9509352d2af50381ab2247e083b80d32d5c0aba91c272ca9ff729b6a0e523",
    "tokenizer_config.json": "9cf04fffe3d8c3b85e439fb35c7acad0761ab51c422a8c4256d9f887c3a0be7d",
    "chat_template.jinja": "e84f32a23fdda27689f868aa4a1a5621f41133e51a48d7f3efcbea2839574259",
    "preprocessor_config.json": "27225450ac9c6529872ee1924fcb0962ff5634834f817040f444118116f4e516",
    "video_preprocessor_config.json": "7768af27c1fafa9cc9011c1dc20067e03f8915e03b63504550e11d5066986d13",
}

app = modal.App(APP_NAME)
volume = modal.Volume.from_name("genaicommunity-xor-weights", create_if_missing=True)
download_image = modal.Image.debian_slim(python_version="3.11").pip_install("huggingface_hub==0.35.3")
runtime_image = (
    modal.Image.from_registry(SGLANG_IMAGE)
    .env({"XOR_GPU": GPU})
    .add_local_file("inference/xor_upstream/server.py", "/opt/xor/server.py")
    .add_local_file("inference/xor_metered_proxy.py", "/opt/xor/metered_proxy.py")
)


def verify_weights() -> None:
    for filename, expected in CHECKSUMS.items():
        digest = hashlib.sha256()
        with (MODEL_DIR / filename).open("rb") as stream:
            for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
                digest.update(block)
        if digest.hexdigest() != expected:
            raise RuntimeError(f"Xor checksum mismatch: {filename}")


@app.function(image=download_image, volumes={"/models": volume}, cpu=2, memory=4096, timeout=3600)
def hydrate() -> None:
    """Download once into a persistent volume and verify every released artifact."""
    from huggingface_hub import snapshot_download

    snapshot_download(
        "juspay/xor", revision=REVISION, local_dir=str(MODEL_DIR),
        allow_patterns=list(CHECKSUMS), max_workers=4,
    )
    verify_weights()
    volume.commit()
    print("Pinned Xor weights verified in persistent volume")


@app.server(
    image=runtime_image,
    gpu=GPU,
    cpu=4,
    memory=16384,
    target_concurrency=1,
    port=8000,
    name="xor",
    min_containers=0,
    max_containers=1,
    # Cold initialization takes several minutes. Keep the ready container long
    # enough for clients honoring Retry-After to reach it after startup.
    scaledown_window=120,
    startup_timeout=1800,
    volumes={"/models": volume},
)
class XorServer:
    @modal.enter()
    def start(self):
        if not (MODEL_DIR / "model-00001-of-00002.safetensors").exists():
            raise RuntimeError("Xor weights are missing; run hydrate first")
        env = {**os.environ, "HF_HUB_OFFLINE": "1", "OPENJEV_SGLANG_URL": "http://127.0.0.1:30000",
               "OPENJEV_MODEL_ID": "xor", "OPENJEV_BACKEND": "Qwen/Qwen3.6-35B-A3B",
               "OPENJEV_CACHE": "0", "OPENJEV_IMAGES": "1", "OPENJEV_REQSIG": ""}
        command = [
            sys.executable, "-m", "sglang.launch_server", "--model-path", str(MODEL_DIR),
            "--trust-remote-code", "--tp-size", str(GPU_COUNT), "--port", "30000", "--host", "127.0.0.1",
            "--max-prefill-tokens", MAX_PREFILL, "--mem-fraction-static", MEM_FRACTION,
        ]
        if GPU_COUNT == 1:
            command.extend(["--context-length", "16384"])
        if GPU == "A100-80GB":
            # Hybrid attention needs its full cache. Skip CUDA graph buffers to
            # retain measured VRAM headroom on the 80 GiB card.
            command.append("--disable-cuda-graph")
        self.engine = subprocess.Popen(command, env=env)
        for _ in range(720):
            if self.engine.poll() is not None:
                raise RuntimeError("Xor SGLang engine exited during startup")
            try:
                with urlopen("http://127.0.0.1:30000/health", timeout=2):
                    break
            except Exception:
                time.sleep(2)
        else:
            raise RuntimeError("Xor SGLang engine did not become healthy")
        self.wrapper = subprocess.Popen([sys.executable, "/opt/xor/server.py", "30002"], env=env)
        self.proxy = subprocess.Popen([sys.executable, "/opt/xor/metered_proxy.py"], env=env)

    @modal.exit()
    def stop(self):
        for name in ("proxy", "wrapper", "engine"):
            process = getattr(self, name, None)
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
