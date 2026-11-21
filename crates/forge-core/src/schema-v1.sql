PRAGMA application_id = 0x464F5247;
PRAGMA user_version = 1;

CREATE TABLE head (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  viewport BLOB NOT NULL CHECK (length(viewport) <= 512)
) STRICT;

CREATE TABLE revisions (
  revision INTEGER PRIMARY KEY CHECK (revision >= 0),
  operation_id TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  snapshot BLOB NOT NULL CHECK (length(snapshot) <= 33554432),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  request_digest TEXT CHECK (request_digest IS NULL OR length(request_digest) = 64)
) STRICT;
