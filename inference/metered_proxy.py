"""Local HTTP proxy that measures elapsed inference time inside the GPU container.

The public API is responsible for identity and durable accounting. This process
only forwards requests to the model on loopback and reports measured seconds.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock
from time import perf_counter
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

UPSTREAM = "http://127.0.0.1:8001"
INFERENCE_LOCK = Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        # Requests can contain member data. Do not write it to Modal logs.
        pass

    def respond(self, status, payload, gpu_seconds=None):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        if gpu_seconds is not None:
            self.send_header("X-GPU-Seconds", f"{gpu_seconds:.6f}")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path != "/health":
            self.respond(404, b'{"error":"not_found"}')
            return
        self.forward(None)

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
        # One T4 can serve one metered call at a time. Queueing waits outside
        # the timed section so a second member is not charged for the first.
        with INFERENCE_LOCK:
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
                body = response.read(1000001)
                status = response.status
        except HTTPError as error:
            body = error.read(1000001)
            status = error.code
        except URLError:
            self.respond(503, b'{"error":"model_unavailable"}')
            return
        if len(body) > 1000000:
            self.respond(502, b'{"error":"model_response_too_large"}')
            return
        self.respond(status, body, perf_counter() - start if payload is not None else None)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
