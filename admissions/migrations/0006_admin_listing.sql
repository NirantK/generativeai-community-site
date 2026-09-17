ALTER TABLE applications ADD COLUMN approved_at INTEGER;
ALTER TABLE applications ADD COLUMN submitted_at INTEGER;
ALTER TABLE applications ADD COLUMN linkedin_url TEXT;
ALTER TABLE applications ADD COLUMN details_version INTEGER NOT NULL DEFAULT 0;
CREATE INDEX applications_approved_recent ON applications(status, approved_at DESC, id DESC);
