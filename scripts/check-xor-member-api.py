#!/usr/bin/env python3
"""Check live Xor text, image, and per-model usage with an existing member token.

The token is read from a hidden prompt and is never logged or stored. This makes
two billable calls. A call is retried only on an explicit model_starting response.
"""

import base64
import getpass
import json
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib

BASE = "https://genaicommunity.ai"
MODEL = "juspay/xor"
OTHERS = ("mys/laya-typed-decisions-GGUF", "mys/laya-multilingual-GGUF", "HopitAI/hopper")


def call(path, token, payload=None):
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if payload is not None:
        headers.update({"Origin": BASE, "Content-Type": "application/json"})
    request = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers=headers,
        method="POST" if payload is not None else "GET",
    )
    try:
        response = urllib.request.urlopen(request, timeout=240)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        try:
            result = json.loads(response.read(1_000_000))
        except (ValueError, UnicodeDecodeError):
            result = {}
        return response.status, result, response.headers


def usage(token, model):
    status, result, _ = call("/v1/models/usage?model=" + urllib.parse.quote(model, safe=""), token)
    if status != 200 or result.get("model") != model:
        raise RuntimeError(f"Usage check for {model} returned HTTP {status}")
    return result["usage"]


def infer(token, payload):
    for attempt in range(9):
        status, result, headers = call("/v1/systemone", token, payload)
        if status == 503 and result.get("error", {}).get("code") == "model_starting":
            if attempt == 8:
                break
            time.sleep(min(30, max(1, int(headers.get("Retry-After", "30")))))
            continue
        if status != 200 or result.get("model") != MODEL:
            raise RuntimeError(f"Xor inference returned HTTP {status}")
        return result
    raise RuntimeError("Xor did not become ready after explicit model_starting responses")


def red_png():
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    raw = b"\x00\xff\x00\x00"
    image = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">2I5B", 1, 1, 8, 2, 0, 0, 0))
    image += chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    return "data:image/png;base64," + base64.b64encode(image).decode("ascii")


def check_answer(result, name, kind):
    answer = result.get("answers", {}).get(name, {})
    meter = result.get("usage", {})
    if answer.get("type") != kind or meter.get("gpu") != "A100 80GB" or meter.get("gpuCount") != 1:
        raise RuntimeError(f"Xor {kind} response schema or hardware meter is invalid")
    if not isinstance(meter.get("gpuSeconds"), (int, float)) or meter["gpuSeconds"] <= 0:
        raise RuntimeError("Xor GPU-seconds meter is missing")
    return meter["gpuSeconds"]


def main():
    token = getpass.getpass("Existing approved-member API token (hidden): ").strip()
    if not token:
        raise RuntimeError("No token entered")
    status, catalog, _ = call("/v1/models", token)
    if status != 200 or MODEL not in {item.get("name") for item in catalog.get("models", [])}:
        raise RuntimeError(f"Approved-member Xor catalog failed: HTTP {status}")
    before = {model: usage(token, model) for model in (MODEL, *OTHERS)}
    text = infer(token, {
        "model": MODEL,
        "state": "The customer was charged twice for one invoice.",
        "questions": {"billing": {"type": "noul", "instructions": "Is this a billing issue?"}},
    })
    text_seconds = check_answer(text, "billing", "noul")
    if not 0 <= text["answers"]["billing"].get("noul", -1) <= 1:
        raise RuntimeError("Xor binary probability is invalid")
    visual = infer(token, {
        "model": MODEL,
        "state": "Inspect the attached image.",
        "images": [red_png()],
        "questions": {"color": {"type": "choice", "instructions": "What color is the image?",
                                 "criteria": {"red": "red", "blue": "blue"}}},
    })
    image_seconds = check_answer(visual, "color", "choice")
    if set(visual["answers"]["color"].get("probabilities", {})) != {"red", "blue"}:
        raise RuntimeError("Xor image probabilities are invalid")
    after = {model: usage(token, model) for model in (MODEL, *OTHERS)}
    if after[MODEL]["requestCount"] != before[MODEL]["requestCount"] + 2:
        raise RuntimeError("Xor request count did not increase by two")
    if abs(after[MODEL]["gpuSeconds"] - before[MODEL]["gpuSeconds"] - text_seconds - image_seconds) > 0.00001:
        raise RuntimeError("Xor GPU usage total does not match response meters")
    if any(after[model] != before[model] for model in OTHERS):
        raise RuntimeError("Another model's usage changed during the Xor probe")
    print(json.dumps({"result": "verified", "model": MODEL, "calls": ["text", "image"],
                      "gpu": "A100 80GB", "requestCount": after[MODEL]["requestCount"],
                      "otherModelTotalsUnchanged": True}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, KeyError, TypeError, ValueError, urllib.error.URLError) as error:
        print(json.dumps({"result": "not_verified", "reason": str(error)}), file=sys.stderr)
        raise SystemExit(1)
