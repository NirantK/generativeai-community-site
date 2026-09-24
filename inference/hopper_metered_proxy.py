"""Meter Hopper's one-pass decision endpoint without exposing its HTTP server."""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socket import create_connection
from threading import Lock
from time import perf_counter
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

UPSTREAM = "http://127.0.0.1:8001/v1/systemone"
INFERENCE_LOCK = Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        # Member states and questions must never enter Modal logs.
        pass

    def respond(self, status, payload, seconds=None):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        if seconds is not None:
            self.send_header("X-GPU-Seconds", f"{seconds:.6f}")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path != "/health":
            self.respond(404, b'{"error":"not_found"}')
            return
        try:
            with create_connection(("127.0.0.1", 8001), timeout=1):
                self.respond(200, b'{"ok":true,"model":"HopitAI/hopper"}')
        except OSError:
            self.respond(503, b'{"ok":false}')

    def do_POST(self):
        if self.path != "/v1/decide":
            self.respond(404, b'{"error":"not_found"}')
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.respond(400, b'{"error":"invalid_length"}')
            return
        if length < 1 or length > 20000:
            self.respond(413, b'{"error":"body_size"}')
            return
        payload = self.rfile.read(length)
        try:
            request = json.loads(payload)
            if not isinstance(request, dict) or len(request.get("questions", {})) != 1:
                raise ValueError("exactly one question required")
        except (TypeError, ValueError):
            self.respond(400, b'{"error":"invalid_request"}')
            return
        # Queue outside the meter: a member is not charged for another member's call.
        with INFERENCE_LOCK:
            started = perf_counter()
            upstream = Request(UPSTREAM, data=payload, headers={"Content-Type": "application/json"})
            try:
                with urlopen(upstream, timeout=90) as response:
                    body, status = response.read(1_000_001), response.status
            except HTTPError as error:
                body, status = error.read(1_000_001), error.code
            except URLError:
                self.respond(503, b'{"error":"model_unavailable"}')
                return
            seconds = perf_counter() - started
        if len(body) > 1_000_000:
            self.respond(502, b'{"error":"model_response_too_large"}')
            return
        self.respond(status, body, seconds)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
