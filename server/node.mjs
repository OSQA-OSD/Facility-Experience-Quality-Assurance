// OSQA on a company server: the same worker.js that runs on Cloudflare, on Node.js.
//   npm run build && npm run server
// Cloudflare's pieces are replaced one for one: D1 → a SQLite file, KV (backups) → a folder,
// the static files → dist/, cron triggers → timers.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { openDatabase, d1 } from './d1.mjs';
import { kvStore } from './kv.mjs';
import { assets } from './assets.mjs';
import { migrate } from './migrate.mjs';

const cfg = loadConfig();
if (!fs.existsSync(path.join(cfg.distDir, 'app.html'))) {
  console.error(`No build in ${cfg.distDir} — run: npm run build`);
  process.exit(1);
}
if (!cfg.vars.VAPID_PUBLIC_KEY || !cfg.vars.VAPID_PRIVATE_JWK) {
  console.warn('Phone notifications are off: VAPID_PUBLIC_KEY / VAPID_PRIVATE_JWK are not set (npm run server:setup makes a key pair). In-app notifications still work.');
}
fs.mkdirSync(cfg.dataDir, { recursive: true });
const dbFile = path.join(cfg.dataDir, 'osqa.sqlite');
const db = openDatabase(dbFile);
const applied = migrate(db, path.join(cfg.repo, 'migrations'));
if (applied.length) console.log(`Database ${dbFile}: applied ${applied.length} migration(s), last ${applied.at(-1)}`);

const worker = (await import('../worker.js')).default;
const pending = new Set();
const ctx = {
  waitUntil(p) {
    const q = Promise.resolve(p).catch((err) => console.error('background task failed:', err?.stack || err)).finally(() => pending.delete(q));
    pending.add(q);
  },
  passThroughOnException() {},
};
const env = { DB: d1(db), BACKUPS: kvStore(path.join(cfg.dataDir, 'backups')), ASSETS: assets(cfg.distDir), ...cfg.vars };

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > cfg.maxBody) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function handle(req, res) {
  const started = Date.now();
  let status = 500;
  try {
    const forwarded = (h) => (cfg.trustProxy ? String(req.headers[h] || '').split(',')[0].trim() : '');
    const proto = forwarded('x-forwarded-proto') || (cfg.tlsCert ? 'https' : 'http');
    const host = forwarded('x-forwarded-host') || req.headers.host || `localhost:${cfg.port}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v != null && !k.startsWith(':')) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    // the address the rate limits and the audit log use — set here, never taken from the client as sent
    headers.set('CF-Connecting-IP', forwarded('x-forwarded-for') || (req.socket.remoteAddress || '').replace(/^::ffff:/, ''));
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
    const request = new Request(`${proto}://${host}${req.url}`, { method: req.method, headers, body });
    const response = await worker.fetch(request, env, ctx);
    status = response.status;
    const out = {};
    response.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(status, out);
    if (response.body && req.method !== 'HEAD') res.end(Buffer.from(await response.arrayBuffer()));
    else res.end();
  } catch (err) {
    status = err.status || 500;
    if (status === 500) console.error('request failed:', req.method, req.url, err?.stack || err);
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(status === 413 ? 'Request too large' : 'Server error');
  } finally {
    console.log(`${new Date().toISOString()} ${req.method} ${String(req.url).split('?')[0]} ${status} ${Date.now() - started}ms`);
  }
}

const server = cfg.tlsCert && cfg.tlsKey
  ? https.createServer({ cert: fs.readFileSync(cfg.tlsCert), key: fs.readFileSync(cfg.tlsKey) }, handle)
  : http.createServer(handle);
server.listen(cfg.port, cfg.host, () => console.log(`OSQA on ${cfg.tlsCert ? 'https' : 'http'}://${cfg.host}:${cfg.port} · data in ${cfg.dataDir}`));

// Scheduled work, as on Cloudflare (UTC): changes backed up every 10 minutes, a full copy at 23:30.
const NIGHTLY = '30 23 * * *', FREQUENT = '*/10 * * * *';
let lastMinute = '';
const timer = setInterval(() => {
  const now = new Date(), minute = now.toISOString().slice(0, 16);
  if (minute === lastMinute) return;
  const cron = now.getUTCHours() === 23 && now.getUTCMinutes() === 30 ? NIGHTLY : now.getUTCMinutes() % 10 === 0 ? FREQUENT : null;
  if (!cron) return;
  lastMinute = minute;
  Promise.resolve(worker.scheduled({ cron, scheduledTime: now.getTime() }, env, ctx)).catch((err) => console.error('scheduled run failed:', err?.stack || err));
}, 15000);

async function stop() {
  clearInterval(timer);
  server.close();
  await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, 10000))]);
  db.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
