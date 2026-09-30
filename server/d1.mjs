// The part of Cloudflare D1's API that worker.js uses, on a SQLite file (Node's built-in node:sqlite).
// D1 is SQLite too, so the SQL, the schema and the migrations are exactly the same.
import { DatabaseSync } from 'node:sqlite';

const clean = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const plain = (row) => (row ? { ...row } : row);
const RETURNS_ROWS = /^\s*(SELECT|WITH|PRAGMA|VALUES)\b|\bRETURNING\b/i;

export function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');        // readers never wait for the writer
  db.exec('PRAGMA busy_timeout = 5000');       // a second process (a backup, a test) waits instead of failing
  db.exec('PRAGMA foreign_keys = ON');         // as D1 does
  return db;
}

export function d1(db) {
  const cache = new Map();
  const prepared = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      if (cache.size > 400) cache.clear();
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const result = (rows, info) => ({
    success: true, results: rows,
    meta: info ? { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } : { changes: 0 },
  });
  class Statement {
    constructor(sql, params = []) { this.sql = sql; this.params = params; }
    bind(...params) { return new Statement(this.sql, params.map(clean)); }
    async first(column) {
      const row = prepared(this.sql).get(...this.params);
      if (!row) return null;
      return column ? row[column] ?? null : plain(row);
    }
    async all() { return result(prepared(this.sql).all(...this.params).map(plain)); }
    async run() { return this.exec(); }
    exec() {
      const s = prepared(this.sql);
      if (RETURNS_ROWS.test(this.sql)) return result(s.all(...this.params).map(plain));
      return result([], s.run(...this.params));
    }
  }
  return {
    prepare: (sql) => new Statement(sql),
    /** D1 runs a batch as one transaction: all of it or none of it. */
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out = statements.map((s) => s.exec());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    async exec(sql) { db.exec(sql); return { count: 1, duration: 0 }; },
  };
}
