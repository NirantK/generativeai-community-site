CREATE TABLE chat_routing_decisions (
 id TEXT PRIMARY KEY, message_id TEXT NOT NULL, content_hash TEXT NOT NULL,
 group_id TEXT NOT NULL, choice TEXT NOT NULL, probabilities TEXT NOT NULL DEFAULT '{}',
 confidence REAL NOT NULL DEFAULT 0, proposal INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL, historical INTEGER NOT NULL DEFAULT 1,
 model TEXT NOT NULL, prompt_version TEXT NOT NULL,
 created_at INTEGER NOT NULL, UNIQUE(message_id,content_hash)
);
CREATE INDEX chat_routing_review ON chat_routing_decisions(created_at DESC);
CREATE TABLE chat_routing_labels (
 decision_id TEXT PRIMARY KEY REFERENCES chat_routing_decisions(id),
 label TEXT NOT NULL, explanation TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL,
 holdout INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE chat_routing_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), trial_started_at INTEGER NOT NULL,
 replies_enabled INTEGER NOT NULL DEFAULT 0, enabled_at INTEGER,
 test_verified INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1
);
INSERT INTO chat_routing_settings(id,trial_started_at) VALUES(1,unixepoch()*1000);
CREATE TABLE chat_routing_sends (
 message_id TEXT PRIMARY KEY, decision_id TEXT NOT NULL,
 destination TEXT NOT NULL, status TEXT NOT NULL,
 requested_by TEXT, test INTEGER NOT NULL DEFAULT 0,
 whatsapp_message_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
ALTER TABLE chat_routing_settings ADD COLUMN test_source_group TEXT;
ALTER TABLE chat_routing_settings ADD COLUMN test_destination TEXT;
ALTER TABLE chat_routing_settings ADD COLUMN test_requested_by TEXT;
ALTER TABLE chat_routing_settings ADD COLUMN test_requested_at INTEGER;
ALTER TABLE chat_routing_settings ADD COLUMN active_policy TEXT NOT NULL DEFAULT 'routing-2026-10-11-v1';
ALTER TABLE chat_routing_settings ADD COLUMN policy_requested_at INTEGER;
CREATE TABLE chat_routing_policies (
 version TEXT PRIMARY KEY, examples TEXT NOT NULL, status TEXT NOT NULL,
 evaluation TEXT NOT NULL, created_at INTEGER NOT NULL, activated_at INTEGER
);
