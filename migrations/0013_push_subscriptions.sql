-- Phone and desktop notifications (Web Push).
-- One row per device that turned notifications on. It belongs to the session that turned them on:
-- messages go only while that session is signed in, so signing out (or being signed out) stops
-- them on that device.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,
  session_hash  TEXT NOT NULL,
  endpoint      TEXT NOT NULL UNIQUE,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  device        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_sent_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_push_session ON push_subscriptions (session_hash);
