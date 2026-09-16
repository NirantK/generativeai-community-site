CREATE TABLE chat_groups (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, source_ref TEXT NOT NULL UNIQUE,
 published INTEGER NOT NULL DEFAULT 0, imported_at INTEGER NOT NULL, coverage_note TEXT NOT NULL
);
CREATE TABLE chat_messages (
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES chat_groups(id), source_id TEXT NOT NULL,
 posted_at INTEGER NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL,
 hidden INTEGER NOT NULL DEFAULT 0, UNIQUE(group_id, source_id)
);
CREATE INDEX chat_message_timeline ON chat_messages(group_id, posted_at DESC, id DESC);
CREATE INDEX chat_message_recent ON chat_messages(posted_at DESC, id DESC);
CREATE VIRTUAL TABLE chat_search USING fts5(body, author, tokenize='unicode61 remove_diacritics 2');
CREATE TABLE chat_archive_actions (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, at INTEGER NOT NULL);
