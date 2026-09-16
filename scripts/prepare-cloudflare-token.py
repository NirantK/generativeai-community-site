"""Normalize copy/paste whitespace without logging the deployment credential."""
import os
import re

raw = os.environ.get("CLOUDFLARE_API_TOKEN", "")
token = raw.strip()
if len(token) >= 2 and token[0] == token[-1] and token[0] in (chr(34), chr(39)):
    token = token[1:-1].strip()
if not re.fullmatch(r"(?:[A-Za-z0-9_-]{40}|cf(?:at|ut)_[A-Za-z0-9_-]{41,100})", token):
    raise SystemExit("CLOUDFLARE_API_TOKEN is not a recognized raw Cloudflare API token. Replace the GitHub secret with only the token value; do not include a curl command, token ID, or JSON.")
with open(os.environ["GITHUB_ENV"], "a") as output:
    output.write("CLOUDFLARE_API_TOKEN=" + token + "\n")
print("Deployment token format is valid.")
