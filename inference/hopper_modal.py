"""Protected, scale-to-zero Hopper A10 service using the verified fast-kernel runtime."""

import socket
import subprocess
import sys
import time

import modal

APP_NAME = "genaicommunity-hopper"
ADAPTER_REVISION = "281d393f65ecfaf25c729a60b8f7fff61b49f9b4"
app = modal.App(APP_NAME)
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
    )
    .env({"HF_HOME": "/cache/huggingface", "PYTHONUNBUFFERED": "1"})
    .add_local_file("inference/hopper_metered_proxy.py", "/opt/hopper_metered_proxy.py")
)


@app.server(
    image=image,
    gpu="A10",
    cpu=4,
    memory=32768,
    volumes={"/cache": cache},
    target_concurrency=1,
    port=8000,
    name="hopper",
    min_containers=0,
    max_containers=1,
    scaledown_window=30,
    startup_timeout=300,
)
class HopperServer:
    @modal.enter()
    def start(self):
        from huggingface_hub import snapshot_download

        adapter = snapshot_download("HopitAI/hopper", revision=ADAPTER_REVISION)
        cache.commit()
        self.process = subprocess.Popen(
            [sys.executable, "-m", "hopper_decisions.server", "--adapter", adapter,
             "--host", "127.0.0.1", "--port", "8001"]
        )
        # Upstream binds only after model load and fast-kernel validation. A slow
        # fallback or crashed child must never become a healthy public endpoint.
        deadline = time.monotonic() + 270
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError("Pinned Hopper runtime exited before becoming ready")
            try:
                with socket.create_connection(("127.0.0.1", 8001), timeout=1):
                    break
            except OSError:
                time.sleep(1)
        else:
            raise TimeoutError("Pinned Hopper runtime did not become ready")
        self.proxy = subprocess.Popen([sys.executable, "/opt/hopper_metered_proxy.py"])

    @modal.exit()
    def stop(self):
        self.proxy.terminate()
        self.proxy.wait(timeout=10)
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
