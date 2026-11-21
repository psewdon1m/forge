CREATE TABLE IF NOT EXISTS revision_navigation (
  revision INTEGER PRIMARY KEY REFERENCES revisions(revision),
  undo_revision INTEGER REFERENCES revisions(revision) CHECK (undo_revision < revision),
  redo_revision INTEGER REFERENCES revisions(revision) CHECK (redo_revision < revision)
) STRICT;
