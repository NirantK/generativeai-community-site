CREATE TABLE IF NOT EXISTS administrator_invites (
 id TEXT PRIMARY KEY, email TEXT NOT NULL, invited_by TEXT NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, accepted_at INTEGER,
 revoked_at INTEGER, revoked_by TEXT, delivery TEXT NOT NULL DEFAULT 'pending', message_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS administrator_active_email ON administrator_invites(email) WHERE revoked_at IS NULL;
