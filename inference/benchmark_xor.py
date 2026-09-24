"""Run frozen public JEVBench cases against a protected Modal Xor endpoint.

The CLI credential stays in Modal's local config. This script writes only labels,
probabilities, timing and aggregate metrics; it does not write case text.
"""

import argparse
import json
import math
import statistics
import subprocess
import time
from urllib.request import urlopen

REVISION = "fd51755eb0c0b546ca206d764faf3302feca913e"
BASE = f"https://raw.githubusercontent.com/fstandhartinger/jevbench/{REVISION}/datasets/public"
TIERS = ("easy", "original", "hard")


def cases():
    for tier in TIERS:
        with urlopen(f"{BASE}/{tier}.jsonl", timeout=30) as response:
            for line in response:
                case = json.loads(line)
                yield tier, case


def probabilities(answer, kind, labels):
    if answer.get("type") != kind:
        raise ValueError("Answer type mismatch")
    if kind == "noul":
        p = answer["noul"]
        return {"no": 1 - p, "yes": p}
    raw = answer["probabilities"]
    if not isinstance(raw, dict):
        raise ValueError("Missing probabilities")
    return {str(label): float(raw[str(label)]) for label in labels}


def invoke(endpoint, case):
    request = json.dumps({"state": case["state"], "model": "xor", "questions": {"decision": case["question"]}})
    cmd = ["uv", "run", "modal", "curl", "-sS", "-i", "--max-time", "120", "-X", "POST",
           endpoint.rstrip("/") + "/v1/systemone", "-H", "Content-Type: application/json", "--data-binary", "@-"]
    start = time.perf_counter()
    result = subprocess.run(cmd, input=request, text=True, capture_output=True, timeout=140)
    elapsed = time.perf_counter() - start
    if result.returncode:
        raise RuntimeError(f"Authenticated endpoint failed with exit code {result.returncode}")
    head, sep, payload = result.stdout.replace("\r\n", "\n").rpartition("\n\n")
    if not sep or " 200 " not in head.splitlines()[0]:
        raise RuntimeError("Endpoint did not return HTTP 200")
    headers = dict(line.split(":", 1) for line in head.splitlines()[1:] if ":" in line)
    measured = float(headers.get("X-GPU-Seconds", headers.get("x-gpu-seconds", "nan")))
    if not math.isfinite(measured):
        raise RuntimeError("Missing inference meter")
    return json.loads(payload), elapsed, measured


def summarize(rows):
    valid = [r for r in rows if r["ok"]]
    latencies = sorted(r["inferenceSeconds"] for r in valid)
    return {
        "attempted": len(rows), "valid": len(valid),
        "accuracy": sum(r["correct"] for r in valid) / len(valid) if valid else None,
        "brierMean": statistics.mean(r["brier"] for r in valid) if valid else None,
        "p95InferenceSeconds": latencies[math.ceil(.95 * len(latencies)) - 1] if latencies else None,
        "meanInferenceSeconds": statistics.mean(latencies) if latencies else None,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--limit", type=int, default=231)
    args = parser.parse_args()
    rows = []
    for tier, case in cases():
        if len(rows) >= args.limit:
            break
        try:
            response, elapsed, measured = invoke(args.endpoint, case)
            answer = response["answers"]["decision"]
            kind = case["question"]["type"]
            probs = probabilities(answer, kind, case["labels"])
            if any(not 0 <= p <= 1 for p in probs.values()) or abs(sum(probs.values()) - 1) > .01:
                raise ValueError("Invalid probability distribution")
            expected = str(case["expected"])
            prediction = max(probs, key=probs.get)
            rows.append({"id": case["id"], "tier": tier, "ok": True,
                         "correct": prediction == expected,
                         "brier": sum((p - (1 if label == expected else 0)) ** 2 for label, p in probs.items()),
                         "probabilities": probs, "inferenceSeconds": measured, "roundTripSeconds": elapsed})
        except (KeyError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
            rows.append({"id": case["id"], "tier": tier, "ok": False, "error": type(exc).__name__})
        if len(rows) % 20 == 0:
            print(f"{len(rows)} cases completed", flush=True)
    report = {"harnessRevision": REVISION, "summary": summarize(rows),
              "tiers": {tier: summarize([r for r in rows if r["tier"] == tier]) for tier in TIERS},
              "results": rows}
    with open(args.output, "w") as stream:
        json.dump(report, stream, indent=2)
    print(json.dumps({"summary": report["summary"], "tiers": report["tiers"]}, indent=2))


if __name__ == "__main__":
    main()
