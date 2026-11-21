CREATE TABLE IF NOT EXISTS analyses (
  sequence INTEGER PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  project_revision INTEGER NOT NULL REFERENCES revisions(revision),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  summary BLOB NOT NULL,
  result BLOB NOT NULL,
  result_digest TEXT NOT NULL CHECK (length(result_digest) = 64)
) STRICT;

CREATE INDEX IF NOT EXISTS analyses_target_history ON analyses(target_id, kind, sequence DESC);
