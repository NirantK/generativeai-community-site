"""Protected Xor text, image, and input-limit smoke tests."""

import argparse
import base64
import json
import struct
import subprocess
import zlib


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def png(width, height, padding=0):
    signature = b"\x89PNG\r\n\x1a\n"
    header = chunk(b"IHDR", struct.pack(">2I5B", width, height, 8, 2, 0, 0, 0))
    pixels = (b"\0" + b"\xff\0\0" * width) * height
    image = chunk(b"IDAT", zlib.compress(pixels, 9))
    metadata = chunk(b"tEXt", b"pad\0" + b"x" * padding) if padding else b""
    return signature + header + metadata + image + chunk(b"IEND", b"")


def data_url(raw):
    return "data:image/png;base64," + base64.b64encode(raw).decode("ascii")


def send(endpoint, payload):
    body = json.dumps(payload)
    command = ["uv", "run", "modal", "curl", "-sS", "-i", "--max-time", "120", "-X", "POST",
               endpoint.rstrip("/") + "/v1/systemone", "-H", "Content-Type: application/json", "--data-binary", "@-"]
    result = subprocess.run(command, input=body, text=True, capture_output=True, timeout=140)
    if result.returncode:
        raise RuntimeError(f"Modal curl exited {result.returncode}")
    header, sep, content = result.stdout.replace("\r\n", "\n").rpartition("\n\n")
    if not sep or " 200 " not in header.splitlines()[0]:
        status = header.splitlines()[0] if sep and header else "missing HTTP response"
        raise RuntimeError(f"Xor did not return HTTP 200: {status}")
    parsed = json.loads(content)
    if "answers" not in parsed or set(parsed["answers"]) != set(payload["questions"]) or "decision" not in parsed["answers"]:
        raise RuntimeError("Xor answer is missing")
    return parsed["answers"]["decision"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--maximum", action="store_true")
    parser.add_argument("--output", help="Write fixed fixture probabilities for candidate comparison")
    args = parser.parse_args()
    request = {
        "model": "xor", "state": "The customer was charged twice.",
        "questions": {"decision": {"type": "noul", "instructions": "Is this about billing?"}},
    }
    answer = send(args.endpoint, request)
    assert answer["type"] == "noul" and 0 <= answer["noul"] <= 1
    fixtures = {"binary": {"yes": answer["noul"], "no": 1 - answer["noul"]}}
    request["questions"] = {"decision": {"type": "score", "instructions": "How urgent is the billing issue?",
                                          "criteria": ["low", "medium", "high"]}}
    answer = send(args.endpoint, request)
    assert answer["type"] == "score" and list(answer["legend"].values()) == ["low", "medium", "high"]
    assert set(answer["probabilities"]) == {"0", "1", "2"}
    fixtures["score"] = answer["probabilities"]
    request["state"] = "Describe the attached image."
    request["images"] = [data_url(png(1, 1))]
    request["questions"] = {"decision": {"type": "choice", "instructions": "What color is the image?",
                                            "criteria": {"red": "red", "blue": "blue"}}}
    answer = send(args.endpoint, request)
    assert answer["type"] == "choice" and "probabilities" in answer
    fixtures["image"] = answer["probabilities"]
    if args.maximum:
        # Eight 2MP images reach the 16MP pixel limit. A benign PNG text chunk
        # brings the decoded file total close to 5 MiB without changing pixels.
        ordinary = data_url(png(2000, 1000))
        padded = data_url(png(2000, 1000, 4_900_000))
        request["images"] = [padded] + [ordinary] * 7
        answer = send(args.endpoint, request)
        assert answer["type"] == "choice"
        request.pop("images")
        request["state"] = "charge " * 4800
        request["questions"] = {"decision": {"type": "noul", "instructions": "Is this about billing?"}}
        answer = send(args.endpoint, request)
        assert answer["type"] == "noul" and 0 <= answer["noul"] <= 1
        request["state"] = "The customer was charged twice."
        request["questions"] = {"decision": {"type": "choice", "instructions": "Choose the best label.",
                                              "criteria": {chr(65 + i): f"label {i}" for i in range(26)}}}
        answer = send(args.endpoint, request)
        assert answer["type"] == "choice" and len(answer["probabilities"]) == 26
        request["questions"] = {"decision": {"type": "noul", "instructions": "Is this about billing?"},
                                **{f"q{i}": {"type": "noul", "instructions": "Is this a customer issue?"}
                                   for i in range(1, 16)}}
        answer = send(args.endpoint, request)
        assert answer["type"] == "noul"
        request["images"] = [data_url(png(1, 1))] * 8
        answer = send(args.endpoint, request)
        assert answer["type"] == "noul"
    if args.output:
        with open(args.output, "w") as stream:
            json.dump(fixtures, stream, indent=2)
    print(json.dumps({"text": "ok", "score": "ok", "image": "ok", "maximum": "ok" if args.maximum else "skipped"}))
