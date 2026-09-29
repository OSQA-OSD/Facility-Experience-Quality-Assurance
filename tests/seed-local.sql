-- Test data for tests/run.sh — the LOCAL development database only (`wrangler d1 execute --local`).
-- Never run this against the live database.
--
-- One account per role (two auditors). None of them can sign in with a password: the stored hash
-- matches nothing. The runner gives them sessions directly in the local database instead.
-- Everything is INSERT OR IGNORE, so running it twice changes nothing.

INSERT OR IGNORE INTO qa_users
  (id, name, username, password_hash, password_salt, password_iterations, password_rounds, role, can_edit, can_delete, can_export)
VALUES
  ('8c2e36fd-608d-47ac-ae2a-c9f5ec5151ab', 'Boss Admin',       'boss',     'no-password', 'AAAAAAAAAAAAAAAAAAAAAA==', 100000, 6, 'quality_admin',   1, 1, 1),
  ('3aacf4c0-8b9a-4c44-8c87-54fde5e063b3', 'Officer One',      'officer1', 'no-password', 'AAAAAAAAAAAAAAAAAAAAAA==', 100000, 6, 'quality_officer', 1, 0, 1),
  ('df67488c-ff4b-40d9-95d8-5a8b32847a64', 'Leader One',       'leader1',  'no-password', 'AAAAAAAAAAAAAAAAAAAAAA==', 100000, 6, 'quality_leader',  0, 0, 1),
  ('a1fd8b2b-b220-45f5-b2ba-623700ae9e0b', 'Auditor One',      'auditor1', 'no-password', 'AAAAAAAAAAAAAAAAAAAAAA==', 100000, 6, 'quality_auditor', 1, 0, 1),
  ('6a45c7e7-5e68-46aa-93aa-726d4312d59a', 'Auditor Two',      'auditor2', 'no-password', 'AAAAAAAAAAAAAAAAAAAAAA==', 100000, 6, 'quality_auditor', 1, 0, 0),
  ('bd3b6842-5e03-44cc-a9c7-9cd8679bc1cb', 'Data Analyst One', 'analystx', 'no-password', 'AAAAAAAAAAAAAAAAAAAAAA==', 100000, 6, 'data_analyst',    0, 0, 1);

-- Buildings: the migrations already load the building list, so none are added here.

-- One report that the role checks read and try to review.
INSERT OR IGNORE INTO inspections
  (id, inspector, facility, division, date, type, type_label, overall, filename, data, inspector_id, created_by)
VALUES
  (2000000001, 'Auditor Two', 'Test Building', 'Test Division', '2026-07-05', 'BOQI',
   'Beginning of Quarter Inspection (BOQI)', 82, 'test-report.pdf',
   '{"sections":[{"title":"Entrance & Lobby","max":10,"items":[{"label":"Clean floor","score":1,"comment":"","photos":[]}]}]}',
   '6a45c7e7-5e68-46aa-93aa-726d4312d59a', '6a45c7e7-5e68-46aa-93aa-726d4312d59a');
