// A complete copy of the company server's data, in the same format as Admin Control › Backup &
// Archive › Data / Photos (SQL that loads into a new database with `npm run server:import`).
//   npm run server:export -- <folder>        → facility-qa-data-<date>.sql and facility-qa-photos-<date>.sql
// Safe to run while the server is up (it only reads).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { openDatabase } from './d1.mjs';

const DATA = ['buildings', 'qa_users', 'assignments', 'inspections', 'inspection_versions', 'inspection_archive', 'inspection_reviews', 'notifications', 'saved_reports', 'audit_log', 'system_state'];
const PHOTOS = ['photo_blobs'];
const q = (v) => (v == null ? 'NULL' : typeof v === 'number' || typeof v === 'bigint' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

const cfg = loadConfig();
const out = path.resolve(process.argv[2] || '.');
fs.mkdirSync(out, { recursive: true });
const db = openDatabase(path.join(cfg.dataDir, 'osqa.sqlite'));
const day = new Date().toISOString().slice(0, 10);
for (const [kind, tables] of [['data', DATA], ['photos', PHOTOS]]) {
  const file = path.join(out, `facility-qa-${kind}-${day}.sql`);
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, `-- Facility Experience QA — ${kind}, ${new Date().toISOString()}\n-- Load into a new database: npm run server:import -- <this file>\n`);
  let rows = 0;
  for (const table of tables) {
    fs.writeSync(fd, `\n-- ${table}\n`);
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) {
      const cols = Object.keys(row);
      fs.writeSync(fd, `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((k) => q(row[k])).join(', ')});\n`);
      rows += 1;
    }
  }
  fs.closeSync(fd);
  console.log(`${file}: ${rows} rows`);
}
db.close();
