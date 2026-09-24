#!/usr/bin/env python3
"""One synthetic production Hopper decision with an existing approved-member token.

Prompts for the token without echoing it. Never prints the token or member data.
This probe makes one billable model call and checks the per-model usage ledger.
"""

import getpass
import json
import sys
import urllib.error
import urllib.request

BASE = "https://genaicommunity.ai/api/v1/models"
HOPPER = "HopitAI/hopper"
OTHER = ("mys/laya-typed-decisions-GGUF", "mys/laya-multilingual-GGUF")


def call(path, token, payload=None, timeout=30):
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if payload is not None:
        headers.update({"Origin": "https://genaicommunity.ai", "Content-Type": "application/json"})
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers=headers,
        method="POST" if payload is not None else "GET",
    )
    try:
        response = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        try:
            result = json.loads(response.read(1_000_000))
        except (ValueError, UnicodeDecodeError):
            result = {}
        return response.status, result


def usage(token, model):
    from urllib.parse import quote

    status, result = call("/usage?model=" + quote(model, safe=""), token)
    if status != 200 or result.get("model") != model:
        raise RuntimeError(f"Usage check for {model} returned HTTP {status}")
    return result["usage"]


def main():
    token = getpass.getpass("Existing approved-member API token (hidden): ").strip()
    if not token:
        raise RuntimeError("No token entered")
    status, catalog = call("", token)
    if status != 200 or HOPPER not in {item.get("name") for item in catalog.get("models", [])}:
        raise RuntimeError(f"Approved-member model catalog failed: HTTP {status}")
    before = {model: usage(token, model) for model in (HOPPER, *OTHER)}
    payload = {
        "model": HOPPER,
        "state": "The customer was charged twice for the same invoice.",
        "questions": {"billing": {
            "type": "choice",
            "instructions": "What issue does this describe?",
            "criteria": {"billing": "Duplicate billing charge", "other": "Unrelated issue"},
        }},
    }
    status, result = call("/infer", token, payload, timeout=240)
    if status != 200 or result.get("model") != HOPPER:
        raise RuntimeError(f"Hopper inference failed: HTTP {status}")
    answer = result.get("result", {}).get("answers", {}).get("billing", {})
    meter = result.get("usage", {})
    if answer.get("type") != "choice" or answer.get("choice") != "billing":
        raise RuntimeError("Hopper did not return the expected synthetic choice")
    if meter.get("gpu") != "A10" or not isinstance(meter.get("gpuSeconds"), (int, float)):
        raise RuntimeError("Hopper response did not contain an A10 usage meter")
    after = {model: usage(token, model) for model in (HOPPER, *OTHER)}
    if after[HOPPER]["requestCount"] != before[HOPPER]["requestCount"] + 1:
        raise RuntimeError("Hopper's separate request count did not increment")
    if abs(after[HOPPER]["gpuSeconds"] - before[HOPPER]["gpuSeconds"] - meter["gpuSeconds"]) > 0.00001:
        raise RuntimeError("Hopper's separate GPU total did not match the inference meter")
    if any(after[model] != before[model] for model in OTHER):
        raise RuntimeError("A Laya model's usage changed during the Hopper probe")
    print(json.dumps({
        "result": "verified",
        "model": HOPPER,
        "answer": answer["choice"],
        "gpu": meter["gpu"],
        "gpuSeconds": meter["gpuSeconds"],
        "requestCount": after[HOPPER]["requestCount"],
        "layaTotalsUnchanged": True,
    }, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, KeyError, TypeError, urllib.error.URLError) as error:
        print(json.dumps({"result": "not_verified", "reason": str(error)}), file=sys.stderr)
        raise SystemExit(1)
