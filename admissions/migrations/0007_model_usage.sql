CREATE TABLE IF NOT EXISTS model_usage (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  model TEXT NOT NULL,
  gpu_microseconds INTEGER NOT NULL CHECK (gpu_microseconds >= 0),
  http_status INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS model_usage_account_model ON model_usage(account_id, model, created_at);
