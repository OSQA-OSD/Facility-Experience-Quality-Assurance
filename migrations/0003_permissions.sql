-- Facility Experience QA — roles, permissions, account status
ALTER TABLE qa_users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE qa_users ADD COLUMN can_edit INTEGER NOT NULL DEFAULT 1;
ALTER TABLE qa_users ADD COLUMN can_delete INTEGER NOT NULL DEFAULT 1;
ALTER TABLE qa_users ADD COLUMN can_export INTEGER NOT NULL DEFAULT 1;
ALTER TABLE qa_users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
