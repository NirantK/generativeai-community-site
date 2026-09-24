import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync('admissions/wrangler.jsonc', 'utf8'));
const db = config.d1_databases.find(binding => binding.binding === 'INDEX');
if (!db || db.database_id === '00000000-0000-0000-0000-000000000000') {
  throw new Error('Production admissions database must be approved, provisioned, and committed after staging validation.');
}
if (!process.env.LINKEDIN_CLIENT_SECRET) throw new Error('LinkedIn client secret is not configured.');
if (!process.env.MODAL_PROXY_TOKEN) throw new Error('Modal proxy token is not configured.');
