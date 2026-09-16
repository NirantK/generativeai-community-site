"""Write only the deployment secrets needed by Wrangler, without logging values."""
import json
import os
import sys

value = os.environ.get('LINKEDIN_CLIENT_SECRET', '')
if not value:
    raise SystemExit('LINKEDIN_CLIENT_SECRET must be set as a GitHub Actions secret.')
secrets = {'LINKEDIN_CLIENT_SECRET': value}
for name in ('ADMIN_EMAILS', 'WHATSAPP_INVITE_URL'):
    if os.environ.get(name):
        secrets[name] = os.environ[name]
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as output:
    json.dump(secrets, output)
