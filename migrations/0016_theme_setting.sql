-- Each person's appearance: 'auto' follows the device's light or dark setting (the default for
-- everyone, so nothing changes until someone chooses), 'light' or 'dark' fixes it.
ALTER TABLE qa_users ADD COLUMN theme TEXT NOT NULL DEFAULT 'auto';
