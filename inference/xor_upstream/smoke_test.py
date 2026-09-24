#!/usr/bin/env python3
import json
import sys
import urllib.request


def post(url, payload):
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.load(response)


def main():
    base_url = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:30002"
    result = post(
        f"{base_url}/v1/systemone",
        {
            "state": "The customer was charged twice and needs a refund.",
            "model": "xor",
            "questions": {
                "urgent": {
                    "type": "noul",
                    "instructions": "Does the customer need prompt help?",
                },
                "department": {
                    "type": "choice",
                    "instructions": "Which department should handle this?",
                    "criteria": {
                        "billing": "Payments, refunds, and invoices",
                        "technical": "Software bugs and outages",
                        "sales": "Pricing and purchasing",
                    },
                },
                "mood": {
                    "type": "score",
                    "instructions": "How frustrated is the customer?",
                    "criteria": ["Calm", "Frustrated", "Very frustrated"],
                },
            },
        },
    )
    assert result["model"] == "xor"
    assert result["answers"]["urgent"]["type"] == "noul"
    assert result["answers"]["department"]["type"] == "choice"
    assert result["answers"]["mood"]["type"] == "score"
    for key in ("department", "mood"):
        total = sum(result["answers"][key]["probabilities"].values())
        assert abs(total - 1.0) <= 0.02, (key, total)
    print(json.dumps({"status": "ok", "model": result["model"]}))


if __name__ == "__main__":
    main()
