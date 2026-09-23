"""Hopper's exact request, prompt and calibration around a native llama.cpp forward.

The C++ process stays resident so model load is never included in a warm decision.
It returns selected final-position logits; Python never asks llama.cpp to generate.
"""

from __future__ import annotations

import json
import math
import subprocess
import time
from pathlib import Path

from hopper_decisions import calibration, request
from hopper_decisions.model import BASE, REVISION
from hopper_decisions.prompt import chat_ids, letter_token_ids, messages, option_lines


def probabilities(logits: list[float], labels: list[str]) -> dict[str, float]:
    if len(logits) != len(labels) or not logits or not all(math.isfinite(v) for v in logits):
        raise ValueError("invalid native logits")
    peak = max(logits)
    values = [math.exp(value - peak) for value in logits]
    total = sum(values)
    return dict(zip(labels, (value / total for value in values)))


class NativeDecider:
    def __init__(self, model_path: str, binary: str, calibration_path: str, name: str = "hopper"):
        from transformers import AutoTokenizer

        self.tokenizer = AutoTokenizer.from_pretrained(BASE, revision=REVISION)
        self.letters = letter_token_ids(self.tokenizer)
        self.mapping = calibration.read(calibration_path)
        self.name = name
        self.process = subprocess.Popen(
            [binary, model_path], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            text=True, bufsize=1,
        )
        if self.process.stdin is None or self.process.stdout is None:
            raise RuntimeError("native scorer pipes unavailable")

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.stdin.close()
            self.process.wait(timeout=10)

    def score(self, payload: dict) -> dict:
        t0 = time.perf_counter()
        example, key = request.parse(payload)
        labels = request.names(example)
        ids = chat_ids(self.tokenizer, messages(example, example["question"], option_lines(example)))
        t1 = time.perf_counter()
        line = " ".join(map(str, [len(ids), *ids, len(labels), *self.letters[:len(labels)]]))
        self.process.stdin.write(line + "\n")
        self.process.stdin.flush()
        native_line = self.process.stdout.readline().strip()
        if not native_line or native_line.startswith("ERR "):
            raise RuntimeError(f"native scorer failed: {native_line or self.process.poll()}")
        native = json.loads(native_line)
        t2 = time.perf_counter()
        raw = probabilities(native["logits"], labels)
        calibrated = calibration.apply(self.mapping, example, raw)
        reply = request.response(key, example["kind"], calibrated, self.name, len(ids))
        t3 = time.perf_counter()
        return {
            "response": reply,
            "raw": raw,
            "tokens": len(ids),
            "seconds": (t1 - t0, t2 - t1, t3 - t2),
            "forward_seconds": native["forward_seconds"],
        }


def serve_lines(model_path: str, binary: str, calibration_path: str) -> None:
    """Local JSON-lines driver, useful for parity checks without an HTTP server."""
    import sys

    decider = NativeDecider(model_path, binary, calibration_path)
    try:
        for line in sys.stdin:
            try:
                print(json.dumps(decider.score(json.loads(line))["response"]), flush=True)
            except (ValueError, RuntimeError) as error:
                print(json.dumps({"error": str(error)}), flush=True)
    finally:
        decider.close()


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 4:
        raise SystemExit("usage: python -m inference.hopper.native_score MODEL.gguf BINARY hopper.json")
    serve_lines(*sys.argv[1:])
