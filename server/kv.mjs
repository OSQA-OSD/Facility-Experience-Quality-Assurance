// The part of Cloudflare Workers KV that the backup uses (put, list, delete, get), as files in a folder.
// Include this folder in the server's own backups: it is the second copy of the data.
import fs from 'node:fs';
import path from 'node:path';

export function kvStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const root = path.resolve(dir);
  const fileOf = (key) => {
    const k = String(key);
    if (!/^[A-Za-z0-9._/-]{1,512}$/.test(k) || k.split('/').some((s) => s === '' || s === '.' || s === '..')) throw new Error(`not a valid key: ${k}`);
    const f = path.join(root, ...k.split('/'));
    if (!f.startsWith(root + path.sep)) throw new Error(`not a valid key: ${k}`);
    return f;
  };
  const bytesOf = async (value) => {
    if (typeof value === 'string') return Buffer.from(value);
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (value && typeof value.getReader === 'function') return Buffer.from(await new Response(value).arrayBuffer());
    return Buffer.from(String(value));
  };
  const keys = () => {
    const out = [];
    const walk = (d, prefix) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name), `${prefix}${e.name}/`);
        else if (!e.name.endsWith('.meta.json') && !e.name.endsWith('.tmp')) out.push(prefix + e.name);
      }
    };
    walk(root, '');
    return out.sort();
  };
  return {
    async put(key, value, options = {}) {
      const f = fileOf(key);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(`${f}.tmp`, await bytesOf(value));
      fs.renameSync(`${f}.tmp`, f);                              // never a half-written copy
      if (options.metadata) fs.writeFileSync(`${f}.meta.json`, JSON.stringify(options.metadata));
    },
    async get(key, type = 'text') {
      const f = fileOf(key);
      if (!fs.existsSync(f)) return null;
      const buf = fs.readFileSync(f);
      if (type === 'arrayBuffer') return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      if (type === 'json') return JSON.parse(buf.toString('utf8'));
      return buf.toString('utf8');
    },
    async delete(key) {
      const f = fileOf(key);
      fs.rmSync(f, { force: true });
      fs.rmSync(`${f}.meta.json`, { force: true });
    },
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
      const all = keys().filter((k) => k.startsWith(prefix));
      const start = Number(cursor) || 0, end = Math.min(all.length, start + Math.min(limit, 1000));
      return { keys: all.slice(start, end).map((name) => ({ name })), list_complete: end >= all.length, cursor: end < all.length ? String(end) : undefined };
    },
  };
}
