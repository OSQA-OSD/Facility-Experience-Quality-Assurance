-- Facility Experience QA — remember which device each sign-in came from
ALTER TABLE qa_sessions ADD COLUMN device TEXT;
