-- Facility Experience QA — building assignments (Officer -> Auditor)
CREATE TABLE IF NOT EXISTS assignments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  building_id INTEGER NOT NULL REFERENCES buildings(id),
  auditor_id  TEXT    NOT NULL REFERENCES qa_users(id),
  quarter     TEXT    NOT NULL,  -- e.g. '2026-Q1'
  type        TEXT    NOT NULL,  -- 'BOQI' | 'EOQI'
  assigned_by TEXT    NOT NULL REFERENCES qa_users(id),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(building_id, quarter, type)
);

CREATE INDEX IF NOT EXISTS idx_assignments_auditor       ON assignments(auditor_id);
CREATE INDEX IF NOT EXISTS idx_assignments_quarter_type  ON assignments(quarter, type);
