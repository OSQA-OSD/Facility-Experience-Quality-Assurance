// Loads a data copy (the .sql files from Admin Control › Backup & Archive › Data / Photos) into the
// company server's database. Use it once, on a new database, before people start working.
//   npm run server:import -- facility-qa-data-2026-10-01.sql facility-qa-photos-2026-10-01.sql
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { openDatabase } from './d1.mjs';
import { migrate } from './migrate.mjs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Give the .sql file(s) to load, e.g.: npm run server:import -- facility-qa-data-2026-10-01.sql');
  process.exit(1);
}
const cfg = loadConfig();
fs.mkdirSync(cfg.dataDir, { recursive: true });
const db = openDatabase(path.join(cfg.dataDir, 'osqa.sqlite'));
migrate(db, path.join(cfg.repo, 'migrations'));
const count = () => Object.fromEntries(['qa_users', 'buildings', 'inspections', 'assignments', 'photo_blobs']
  .map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
const before = count();
if (before.inspections > 0 || before.qa_users > 0) {
  console.error('This database already has accounts or reports. Import into a new database (move data/osqa.sqlite aside first).');
  process.exit(1);
}
db.exec('PRAGMA foreign_keys = OFF');          // the copy is complete; rows arrive table by table
db.exec('BEGIN');
try {
  for (const f of files) db.exec(fs.readFileSync(f, 'utf8'));
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('Nothing was loaded:', err.message);
  process.exit(1);
}
db.exec('PRAGMA foreign_keys = ON');
// The copy carries the old site's backup bookmarks ("copied up to here" — true of *its* backup
// storage, not of this server's empty one). Without them, the first backups here copy everything.
const reset = db.prepare("DELETE FROM system_state WHERE key LIKE 'backup.%'").run().changes;
if (reset) console.log('Backup bookmarks reset: the first backups on this server copy everything.');
const broken = db.prepare('PRAGMA foreign_key_check').all();
console.log('Loaded:', JSON.stringify(count()));
if (broken.length) console.warn(`${broken.length} row(s) point at something that is not in the copy:`, broken.slice(0, 5));
db.close();
