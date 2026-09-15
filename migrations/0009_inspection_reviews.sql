-- Facility Experience QA — review decisions and comments on saved inspection reports
CREATE TABLE IF NOT EXISTS inspection_reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  inspection_id INTEGER NOT NULL,
  reviewer_id   TEXT,
  reviewer_name TEXT    NOT NULL,
  decision      TEXT    NOT NULL,   -- 'approved' | 'changes_requested' | 'comment'
  comment       TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inspection_reviews_inspection ON inspection_reviews(inspection_id, id);
