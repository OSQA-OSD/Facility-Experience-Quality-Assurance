-- Facility Experience QA — detailed permissions, sign-in tracking, audit log
-- Additive only, so it can be applied before the code that uses it is deployed.

-- JSON array of permission keys; NULL means "the role's defaults".
ALTER TABLE qa_users ADD COLUMN permissions TEXT;
ALTER TABLE qa_users ADD COLUMN last_login_at TEXT;

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   TEXT,
  actor_name TEXT,
  action     TEXT NOT NULL,   -- e.g. user.create, user.permissions, security.lockout, building.update
  target_id  TEXT,
  target     TEXT,
  details    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_target  ON audit_log(target_id, created_at DESC);
