"""Serve the full multilingual Laya F16 GGUF with ggmlc on a protected T4."""

import subprocess
import sys

import modal

APP_NAME = "genaicommunity-laya-multilingual-gguf"
MODEL_REVISION = "3b645ae5428115fa5fd1c453070d22c3ce4b987d"
MODEL_FILE = "laya_multilingual_f16.gguf"
MODEL_SHA256 = "5fdabb71480e6469e986d71d15dabe1dc7160fcdf4bc6e10bd3acc4f51ff4f71"
MODEL_PATH = f"/models/{MODEL_FILE}"
LAYA_BINARY = "/opt/ggmlc/build/examples/laya/laya"

app = modal.App(APP_NAME)

# ggmlc's published CUDA binaries target sm80+, while the T4 is sm75.
image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-devel-ubuntu22.04", add_python="3.11")
    .apt_install("ca-certificates", "cmake", "curl", "g++", "git", "ninja-build")
    .run_commands(
        "git clone --recursive --depth 1 --branch v0.9.2 https://github.com/monatis/ggmlc.git /opt/ggmlc",
        "cmake -S /opt/ggmlc -B /opt/ggmlc/build -G Ninja "
        "-DCMAKE_BUILD_TYPE=Release -DGGMLC_ENABLE_CUDA=ON "
        "-DGGMLC_BUILD_EXAMPLES=ON -DCMAKE_CUDA_ARCHITECTURES=75 "
        "-DCMAKE_CUDA_RUNTIME_LIBRARY=Static -DGGML_NATIVE=OFF",
        "cmake --build /opt/ggmlc/build --target laya --parallel 4",
        "mkdir -p /models",
        "curl --fail --location --retry 3 "
        f"'https://huggingface.co/mys/laya-multilingual-GGUF/resolve/{MODEL_REVISION}/{MODEL_FILE}' "
        f"--output {MODEL_PATH}",
        f"echo '{MODEL_SHA256}  {MODEL_PATH}' | sha256sum --check --status",
    )
    .add_local_file("inference/metered_proxy.py", "/opt/metered_proxy.py")
)


@app.server(
    image=image,
    gpu="T4",
    cpu=1,
    memory=4096,
    target_concurrency=1,
    port=8000,
    name="laya",
    min_containers=0,
    max_containers=1,
    scaledown_window=30,
    startup_timeout=300,
)
class LayaServer:
    @modal.enter()
    def start(self):
        self.process = subprocess.Popen(
            [
                LAYA_BINARY,
                "serve",
                MODEL_PATH,
                "--port",
                "8001",
                "--device",
                "cuda",
                "--cuda-graph",
            ]
        )
        self.proxy = subprocess.Popen([sys.executable, "/opt/metered_proxy.py"])

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
