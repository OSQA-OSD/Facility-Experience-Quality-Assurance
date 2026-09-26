-- Each person chooses whether they receive notifications (Settings → Notifications).
-- On for everyone to begin with, so nothing changes until someone turns them off.
-- Security alerts about a person's own account (password changed or reset, account locked)
-- are always sent, whatever this says.
ALTER TABLE qa_users ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 1;
