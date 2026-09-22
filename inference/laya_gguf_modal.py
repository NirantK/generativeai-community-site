"""Serve the typed-decisions GGUF with ggmlc on Modal's lowest-cost GPU."""

import subprocess
import sys

import modal

APP_NAME = "genaicommunity-laya-typed-decisions-gguf"
MODEL_REVISION = "1e9e8ba1f5271316601e0fefd940786660bd6964"
MODEL_FILE = "laya_typed_decisions_f16.gguf"
MODEL_SHA256 = "71bf44211496be01cb8057b5ce906aaba62cd0192115c3abb5b42b2f0147ee2c"
MODEL_PATH = f"/models/{MODEL_FILE}"
LAYA_BINARY = "/opt/ggmlc/build/examples/laya/laya"

app = modal.App(APP_NAME)

# ggmlc only publishes Linux CUDA binaries for sm80 and newer. The T4 is sm75,
# so compile the pinned runtime for that architecture instead of using llama.cpp.
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
        f"'https://huggingface.co/mys/laya-typed-decisions-GGUF/resolve/{MODEL_REVISION}/{MODEL_FILE}' "
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
    scaledown_window=2,
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
