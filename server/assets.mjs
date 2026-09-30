// The site's files (the build in dist/), served the way Cloudflare serves them: /app answers with
// app.html, /app.html redirects to /app, unknown addresses get index.html, and the rules in
// dist/_headers (the security headers) are added to every file.
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

/** _headers: a path pattern on its own line, then indented "Name: value" lines. */
function readRules(file) {
  if (!fs.existsSync(file)) return [];
  const rules = [];
  let cur = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const pattern = line.trim();
      cur = { re: new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'), headers: [] };
      rules.push(cur);
    } else if (cur) {
      const i = line.indexOf(':');
      if (i > 0) cur.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return rules;
}

export function assets(dir) {
  const root = path.resolve(dir);
  const rules = readRules(path.join(root, '_headers'));
  const find = (p) => {
    const f = path.resolve(root, '.' + p);
    if (!f.startsWith(root + path.sep)) return null;
    if (path.basename(f).startsWith('_') || path.basename(f).startsWith('.')) return null;   // _headers is not a page
    try { const st = fs.statSync(f); return st.isFile() ? { f, st } : null; } catch { return null; }
  };
  const withRules = (pathname, headers) => {
    for (const r of rules) {
      if (!r.re.test(pathname)) continue;
      for (const [k, v] of r.headers) headers.has(k) ? headers.set(k, `${headers.get(k)}, ${v}`) : headers.set(k, v);
    }
    return headers;
  };
  return {
    async fetch(request) {
      const url = new URL(request.url);
      let p;
      try { p = decodeURIComponent(url.pathname); } catch { return new Response('Bad request', { status: 400 }); }
      if (p.includes('\0')) return new Response('Bad request', { status: 400 });
      if (p.endsWith('.html') && find(p)) {
        const to = p === '/index.html' ? '/' : p.slice(0, -5);
        return new Response(null, { status: 307, headers: withRules(p, new Headers({ Location: to + url.search })) });
      }
      const hit = (p.endsWith('/') ? find(p + 'index.html') : find(p) || find(p + '.html')) || find('/index.html');
      if (!hit) return new Response('Not found', { status: 404 });
      const etag = `W/"${hit.st.size.toString(16)}-${Math.floor(hit.st.mtimeMs).toString(16)}"`;
      const headers = withRules(p, new Headers({
        'Content-Type': TYPES[path.extname(hit.f).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=0, must-revalidate', ETag: etag,
      }));
      if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers });
      return new Response(request.method === 'HEAD' ? null : fs.readFileSync(hit.f), { status: 200, headers });
    },
  };
}
