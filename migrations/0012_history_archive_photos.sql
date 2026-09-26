-- Keep everything, for good.
--
-- * Who a report belongs to is the signed-in account that saved it (inspector_id), not a
--   name typed into the form.
-- * Every saved state of a report is kept as a numbered version, with who saved it and when.
-- * Deleting a report moves it to the archive; an administrator can put it back. Nothing the
--   app does removes a report, a version or a photo.
-- * Photos are stored once each, by the SHA-256 of their contents, and reports refer to them
--   by address. A photo kept in ten versions of a report is stored one time.
-- * The outcome of the automatic daily backup is recorded so the admin page can show it.

ALTER TABLE inspections ADD COLUMN inspector_id TEXT;
ALTER TABLE inspections ADD COLUMN created_by TEXT;

-- Reports already on file belong to the account with exactly that name, where there is one.
UPDATE inspections
SET inspector_id = (SELECT u.id FROM qa_users u WHERE lower(trim(u.name)) = lower(trim(inspections.inspector)))
WHERE inspector_id IS NULL
  AND (SELECT COUNT(*) FROM qa_users u WHERE lower(trim(u.name)) = lower(trim(inspections.inspector))) = 1;

CREATE TABLE IF NOT EXISTS inspection_versions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  inspection_id  INTEGER NOT NULL,
  version        INTEGER NOT NULL,
  reason         TEXT    NOT NULL,          -- submitted | edited | deleted | restored | before-history
  inspector      TEXT,
  inspector_id   TEXT,
  facility       TEXT,
  division       TEXT,
  date           TEXT,
  type           TEXT,
  type_label     TEXT,
  overall        REAL,
  filename       TEXT,
  data           TEXT    NOT NULL,
  saved_by_id    TEXT,
  saved_by_name  TEXT,
  saved_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (inspection_id, version)
);
CREATE INDEX IF NOT EXISTS idx_versions_inspection ON inspection_versions (inspection_id, version);

CREATE TABLE IF NOT EXISTS inspection_archive (
  id               INTEGER PRIMARY KEY,
  inspector        TEXT,
  inspector_id     TEXT,
  facility         TEXT,
  division         TEXT,
  date             TEXT,
  type             TEXT,
  type_label       TEXT,
  overall          REAL,
  filename         TEXT,
  data             TEXT    NOT NULL,
  created_by       TEXT,
  created_at       TEXT,
  updated_at       TEXT,
  deleted_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_by_id    TEXT,
  deleted_by_name  TEXT
);

CREATE TABLE IF NOT EXISTS photo_blobs (
  id                   TEXT    PRIMARY KEY,  -- sha256 hex of the base64 body
  mime                 TEXT    NOT NULL,
  bytes                INTEGER NOT NULL,
  data                 TEXT    NOT NULL,     -- base64
  first_inspection_id  INTEGER,
  created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS system_state (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE qa_sessions ADD COLUMN last_seen_at INTEGER;
