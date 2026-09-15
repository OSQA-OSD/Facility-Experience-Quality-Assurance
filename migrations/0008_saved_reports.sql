-- Facility Experience QA — saved report definitions (Reports → Report Builder)
CREATE TABLE IF NOT EXISTS saved_reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   TEXT    NOT NULL REFERENCES qa_users(id),
  name       TEXT    NOT NULL,
  config     TEXT    NOT NULL,          -- JSON: filters, grouping, sort and chart choices
  shared     INTEGER NOT NULL DEFAULT 0, -- 1 = visible to everyone who can view reports
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_saved_reports_owner  ON saved_reports(owner_id);
CREATE INDEX IF NOT EXISTS idx_saved_reports_shared ON saved_reports(shared);
