-- Facility Experience QA — initial schema
CREATE TABLE IF NOT EXISTS inspections (
  id          INTEGER PRIMARY KEY,
  inspector   TEXT    NOT NULL DEFAULT '',
  facility    TEXT    NOT NULL DEFAULT '',
  division    TEXT    NOT NULL DEFAULT '',
  date        TEXT    NOT NULL DEFAULT '',
  type        TEXT    NOT NULL DEFAULT '',
  type_label  TEXT    NOT NULL DEFAULT '',
  overall     REAL,
  filename    TEXT    NOT NULL DEFAULT '',
  data        TEXT    NOT NULL DEFAULT '{}',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inspections_date      ON inspections(date);
CREATE INDEX IF NOT EXISTS idx_inspections_inspector ON inspections(inspector);
CREATE INDEX IF NOT EXISTS idx_inspections_facility  ON inspections(facility);
