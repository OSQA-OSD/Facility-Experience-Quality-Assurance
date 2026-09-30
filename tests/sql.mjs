// SQL against the local test database, for the tests:
//   node tests/sql.mjs [--json] --command "SQL"      node tests/sql.mjs --file tests/seed-local.sql
// With OSQA_DB=<path to osqa.sqlite> it uses the Node server's database (server/node.mjs);
// otherwise Cloudflare's local D1 (wrangler dev). The --json output has wrangler's shape:
// [{ results: [...], success: true }] — one entry per statement.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const command = at('--command'), file = at('--file');
if (!command && !file) { console.error('usage: node tests/sql.mjs [--json] (--command "SQL" | --file path)'); process.exit(2); }

if (!process.env.OSQA_DB) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'facility-qa', '--local', ...(json ? ['--json'] : []), ...(command ? ['--command', command] : ['--file', file])],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  process.stdout.write(out);
  process.exit(0);
}

const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(process.env.OSQA_DB);
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');
const sql = command ?? fs.readFileSync(file, 'utf8');
// statements, split at semicolons outside quotes and comments
const statements = [];
let cur = '', q = null;
for (let i = 0; i < sql.length; i++) {
  const c = sql[i];
  if (!q && c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; cur += '\n'; continue; }
  if (q) { cur += c; if (c === q) q = null; continue; }
  if (c === "'" || c === '"') { q = c; cur += c; continue; }
  if (c === ';') { if (cur.trim()) statements.push(cur.trim()); cur = ''; continue; }
  cur += c;
}
if (cur.trim()) statements.push(cur.trim());
const results = statements.map((s) => {
  const st = db.prepare(s);
  return /^\s*(SELECT|WITH|PRAGMA|VALUES)\b|\bRETURNING\b/i.test(s)
    ? { results: st.all().map((r) => ({ ...r })), success: true }
    : (st.run(), { results: [], success: true });
});
db.close();
if (json) process.stdout.write(JSON.stringify(results));
