#!/usr/bin/env python3
"""Read-only production API probe. Never logs credentials or applicant data."""
import argparse
import datetime
import getpass
import json
import urllib.error
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--invalid-token", action="store_true", help="Probe edge access with a synthetic invalid token; cannot prove authenticated success")
args = parser.parse_args()
token = "0" * 64 if args.invalid_token else getpass.getpass("Application API token: ").strip()
if not token:
    parser.error("An application token is required")
request = urllib.request.Request(
    "https://genaicommunity.ai/api/v1/application",
    headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/json",
        "User-Agent": "genaicommunity-application-probe/1.0",
    },
)
# Identify this application explicitly; Cloudflare rejects urllib's default agent.
try:
    response = urllib.request.urlopen(request, timeout=30)
except urllib.error.HTTPError as error:
    response = error
except urllib.error.URLError as error:
    print(json.dumps({"result": "network_error", "reason": str(error.reason)}))
    raise SystemExit(1)
with response:
    try:
        body = json.loads(response.read(1_000_000))
    except (ValueError, UnicodeDecodeError):
        body = {}
    if not isinstance(body, dict):
        body = {}
    edge_block = body.get("cloudflare_error") is True or body.get("error_code") == 1010
    application_response = (
        "application/json" in response.headers.get("content-type", "")
        and isinstance(body.get("profile"), dict)
        and body.get("status") in {"draft", "submitted", "review", "approved", "declined"}
        and "application" in body
    )
    authenticated = response.status == 200 and application_response and not args.invalid_token and not edge_block
    result = "authenticated" if authenticated else "edge_blocked" if edge_block else "token_rejected" if response.status == 401 else "unexpected_response"
    print(json.dumps({
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "method": "GET", "path": "/api/v1/application",
        "credential": "synthetic_invalid" if args.invalid_token else "applicant_token",
        "status": response.status, "ray_id": response.headers.get("cf-ray"),
        "result": result,
        "green": authenticated,
    }, indent=2))
raise SystemExit(0 if authenticated else 1)
