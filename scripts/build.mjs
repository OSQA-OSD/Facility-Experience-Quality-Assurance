// Builds dist/ — the pages, their scripts, the vendor files and the images — which both Cloudflare
// and the Node server (server/node.mjs) serve. Works on Windows, Linux and macOS.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dist = path.join(repo, 'dist');
const FILES = [
  'index.html', 'app.html', 'login.html', 'report.html', 'heic.html',
  'journey-map-QA-2026-Q3-EOQ-009.svg', 'osqa-logo.svg', 'osqa-logo-white.svg', 'osqa-icon.svg', 'osqa-icon-180.png', 'osqa-icon-512.png',
  'manifest.webmanifest', 'sw.js', '_headers',
];
fs.mkdirSync(path.join(dist, 'js'), { recursive: true });
for (const f of FILES) fs.copyFileSync(path.join(repo, f), path.join(dist, f));
for (const f of fs.readdirSync(path.join(repo, 'js')).filter((f) => f.endsWith('.js'))) fs.copyFileSync(path.join(repo, 'js', f), path.join(dist, 'js', f));
fs.rmSync(path.join(dist, 'vendor'), { recursive: true, force: true });
fs.cpSync(path.join(repo, 'vendor'), path.join(dist, 'vendor'), { recursive: true });
console.log(`Built ${path.relative(repo, dist)}/: ${FILES.length} files, js/, vendor/`);
