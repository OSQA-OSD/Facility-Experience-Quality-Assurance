-- Sign-in attempts per network in the current window (see authThrottled in worker.js). Rows are
-- small counters; old ones are cleared by the nightly backup run. Nothing else depends on them.
CREATE TABLE IF NOT EXISTS auth_throttle (
  key     TEXT PRIMARY KEY,      -- '<action>:<ip>'
  window  INTEGER NOT NULL,      -- minutes since 1970, divided by the window length
  hits    INTEGER NOT NULL
);
