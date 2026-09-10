-- Facility Experience QA — authentication
CREATE TABLE IF NOT EXISTS qa_users (
  id                   TEXT PRIMARY KEY,
  name                 TEXT    NOT NULL,
  username             TEXT    NOT NULL,
  password_hash        TEXT    NOT NULL,
  password_salt        TEXT    NOT NULL,
  password_iterations  INTEGER NOT NULL,
  password_rounds      INTEGER NOT NULL,
  role                 TEXT    NOT NULL DEFAULT 'inspector',
  failed_attempts      INTEGER NOT NULL DEFAULT 0,
  locked_until         INTEGER,
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_users_username ON qa_users(username);

CREATE TABLE IF NOT EXISTS qa_sessions (
  token_hash  TEXT    PRIMARY KEY,
  user_id     TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_qa_sessions_user     ON qa_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_qa_sessions_expires  ON qa_sessions(expires_at);
