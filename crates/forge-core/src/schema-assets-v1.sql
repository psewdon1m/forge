CREATE TABLE IF NOT EXISTS asset_versions (
  version_id TEXT PRIMARY KEY,
  metadata TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS asset_intents (
  version_id TEXT PRIMARY KEY,
  suffix TEXT NOT NULL,
  bytes INTEGER CHECK (bytes > 0 AND bytes <= 134217728),
  sha256 TEXT CHECK (length(sha256) = 64),
  CHECK ((bytes IS NULL) = (sha256 IS NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS asset_import_batches (
  operation_id TEXT PRIMARY KEY,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  response BLOB NOT NULL
) STRICT;
