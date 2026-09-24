"""Expose only Xor health and typed decisions; time completed inference calls."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import base64
import io
import json
import re
from threading import Lock
from time import perf_counter
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

UPSTREAM = "http://127.0.0.1:30002"
LOCK = Lock()
MAX_BODY = 8 * 1024 * 1024
MAX_TEXT_TOKENS = 12_000
IMAGE_URL = re.compile(r"^data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$")


def validate_decoded_images(payload):
    images = json.loads(payload).get("images") or []
    if not images:
        return
    from PIL import Image, UnidentifiedImageError
    if not isinstance(images, list) or len(images) > 8:
        raise ValueError("invalid images")
    total_bytes = total_pixels = 0
    for image in images:
        match = IMAGE_URL.fullmatch(image) if isinstance(image, str) else None
        if not match:
            raise ValueError("invalid image data URL")
        data = base64.b64decode(match.group(2), validate=True)
        total_bytes += len(data)
        if total_bytes > 5 * 1024 * 1024:
            raise ValueError("image byte limit")
        try:
            with Image.open(io.BytesIO(data)) as decoded:
                if decoded.format.lower() != match.group(1).split("/")[1]:
                    raise ValueError("image MIME mismatch")
                if getattr(decoded, "is_animated", False):
                    raise ValueError("animated image")
                total_pixels += decoded.width * decoded.height
                if total_pixels > 16_000_000:
                    raise ValueError("image pixel limit")
                decoded.load()
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
            raise ValueError("invalid decoded image") from exc


def token_budget_exceeded(payload):
    """Count both option orders and leave headroom for wrapper formatting."""
    from tokenizers import Tokenizer

    if not hasattr(token_budget_exceeded, "tokenizer"):
        token_budget_exceeded.tokenizer = Tokenizer.from_file("/models/xor/tokenizer.json")
    data = json.loads(payload)
    state = data.get("state", "")
    if not isinstance(state, str):
        return False  # The released wrapper validates the request schema.
    total = 0
    for question in data.get("questions", {}).values():
        if not isinstance(question, dict):
            continue
        criteria = question.get("criteria") or []
        options = list(criteria.values()) if isinstance(criteria, dict) else criteria
        text = state + "\n" + str(question.get("instructions", "")) + "\n" + "\n".join(str(x) for x in options)
        total += 2 * (len(token_budget_exceeded.tokenizer.encode(text, add_special_tokens=False).ids) + 180)
        if total > MAX_TEXT_TOKENS:
            return True
    return False


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass

    def respond(self, status, payload, elapsed=None):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        if elapsed is not None:
            self.send_header("X-GPU-Seconds", f"{elapsed:.6f}")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path != "/health":
            return self.respond(404, b'{"error":"not_found"}')
        self.forward(None)

    def do_POST(self):
        if self.path != "/v1/systemone":
            return self.respond(404, b'{"error":"not_found"}')
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.respond(400, b'{"error":"invalid_length"}')
        if size < 1 or size > MAX_BODY:
            return self.respond(413, b'{"error":"body_size"}')
        payload = self.rfile.read(size)
        if len(payload) != size:
            return self.respond(400, b'{"error":"incomplete_body"}')
        with LOCK:
            try:
                validate_decoded_images(payload)
                if token_budget_exceeded(payload):
                    return self.respond(422, b'{"error":"token_budget"}', 0.0)
            except (ValueError, TypeError, KeyError):
                return self.respond(422, b'{"error":"invalid_input"}', 0.0)
            self.forward(payload)

    def forward(self, payload):
        request = Request(
            UPSTREAM + self.path,
            data=payload,
            headers={"Content-Type": "application/json"} if payload is not None else {},
            method="POST" if payload is not None else "GET",
        )
        start = perf_counter()
        try:
            with urlopen(request, timeout=90) as response:
                body = response.read(1_000_001)
                status = response.status
        except HTTPError as error:
            body = error.read(1_000_001)
            status = error.code
        except (URLError, TimeoutError, OSError):
            # The wrapper may have accepted an inference request before the
            # connection failed. Mark it as entered so callers never replay it.
            elapsed = perf_counter() - start if payload is not None else None
            return self.respond(503, b'{"error":"model_unavailable"}', elapsed)
        if len(body) > 1_000_000:
            return self.respond(502, b'{"error":"model_response_too_large"}')
        self.respond(status, body, perf_counter() - start if payload is not None else None)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
