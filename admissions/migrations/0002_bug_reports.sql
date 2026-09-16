CREATE TABLE IF NOT EXISTS bug_reports (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  report TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(account_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS bug_reports_created ON bug_reports(created_at);
