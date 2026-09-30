// Applies migrations/*.sql in order, each once, recorded in d1_migrations (the same table and names
// Cloudflare's wrangler uses, so a copy of the Cloudflare database carries on where it left off).
import fs from 'node:fs';
import path from 'node:path';

export function migrate(db, dir) {
  db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  const done = new Set(db.prepare('SELECT name FROM d1_migrations').all().map((r) => r.name));
  const applied = [];
  for (const name of fs.readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)).sort()) {
    if (done.has(name)) continue;
    db.exec('BEGIN');
    try {
      db.exec(fs.readFileSync(path.join(dir, name), 'utf8'));
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
      db.exec('COMMIT');
      applied.push(name);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${name} failed: ${err.message}`);
    }
  }
  return applied;
}
