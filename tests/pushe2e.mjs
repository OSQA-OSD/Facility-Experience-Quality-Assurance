// End to end: a stand-in push service on localhost receives what the Worker sends, checks the
// VAPID signature and decrypts each message with the "phone's" private key.
import http from 'node:http';
import nodeCrypto from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
const B = 'http://localhost:8787';
// the public key the local server signs with: .dev.vars (tests/dev-keys.mjs) wins over wrangler.jsonc
const devVars = existsSync(new URL('../.dev.vars', import.meta.url)) ? readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8') : '';
const PUB = (devVars.match(/^VAPID_PUBLIC_KEY=(\S+)/m) || readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').match(/"VAPID_PUBLIC_KEY"\s*:\s*"([^"]+)"/))[1];
const S = { adm: 'tst-adm-2026', au1: 'tst-au1-2026', ldr: 'tst-ldr-2026' };
const AU1 = 'a1fd8b2b-b220-45f5-b2ba-623700ae9e0b';
let pass = 0, bad = 0;
const ok = (c, l, x = '') => { c ? pass++ : bad++; console.log((c ? '  ✓ ' : '  ✗ ') + l + (x ? '  ' + x : '')); };
const call = async (who, method, path, body) => {
  const h = { 'Content-Type': 'application/json' }; if (who) h.Cookie = 'qa_session=' + S[who];
  const r = await fetch(B + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, j };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// two "phones": each has its own keys
const phone = (name) => { const e = nodeCrypto.createECDH('prime256v1'); e.generateKeys(); return { name, ecdh: e, auth: nodeCrypto.randomBytes(16), got: [] }; };
const phones = { a: phone('a'), l: phone('l'), gone: phone('gone') };
const pubRaw = Buffer.from(PUB, 'base64url');
const pubKey = nodeCrypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pubRaw.subarray(1, 33).toString('base64url'), y: pubRaw.subarray(33).toString('base64url') }, format: 'jwk' });
function decrypt(p, box) {
  const s = box.subarray(0, 16), idlen = box[20], asPublic = box.subarray(21, 21 + idlen), sealed = box.subarray(21 + idlen);
  const shared = p.ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(nodeCrypto.hkdfSync('sha256', shared, p.auth, Buffer.concat([Buffer.from('WebPush: info\0'), p.ecdh.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, s, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, s, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(0, -1).toString());
}
const badSig = [];
const server = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    const name = req.url.slice(1), p = phones[name];
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(req.headers.authorization || '');
    const sigOk = m && m[4] === PUB && nodeCrypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'));
    const claims = m ? JSON.parse(Buffer.from(m[2], 'base64url').toString()) : {};
    if (!sigOk || claims.aud !== 'http://localhost:9911' || req.headers['content-encoding'] !== 'aes128gcm' || !req.headers.ttl) badSig.push(name);
    if (name === 'gone') { res.writeHead(410); return res.end(); }
    try { p.got.push(decrypt(p, Buffer.concat(chunks))); } catch (e) { p.got.push({ error: e.message }); }
    res.writeHead(201); res.end();
  });
});
await new Promise((r) => server.listen(9911, r));
const sub = (p) => ({ subscription: { endpoint: `http://localhost:9911/${p.name}`, keys: { p256dh: p.ecdh.getPublicKey().toString('base64url'), auth: p.auth.toString('base64url') } } });

console.log('Turning notifications on');
let r = await call('au1', 'GET', '/api/push/key');
ok(r.j?.enabled && r.j.publicKey === PUB, 'server has push keys; hands out the public one');
ok((await call('au1', 'POST', '/api/push/subscribe', { subscription: { endpoint: 'https://evil.example/x', keys: sub(phones.a).subscription.keys } })).s === 400, 'an address that is not a push service is refused');
ok((await call(null, 'POST', '/api/push/subscribe', sub(phones.a))).s === 401, 'needs to be signed in');
r = await call('au1', 'POST', '/api/push/subscribe', sub(phones.a));
await wait(300);
ok(r.s === 200 && r.j.sent === 1 && phones.a.got[0]?.title === 'Notifications are on', 'Auditor One’s phone gets the welcome message', JSON.stringify(phones.a.got[0]));
await call('ldr', 'POST', '/api/push/subscribe', sub(phones.l));
await call('au1', 'POST', '/api/push/subscribe', sub(phones.gone));                  // a phone that later uninstalls
ok(badSig.filter((n) => n !== 'gone').length === 0, 'every message signed by this site (VAPID) and encrypted (aes128gcm)');

console.log('Real events reach the phone');
const before = phones.a.got.length;
const blds = (await call('adm', 'GET', '/api/officer/board?quarter=2031-Q3&type=BOQI')).j.buildings;
r = await call('adm', 'POST', '/api/assignments', { quarter: '2031-Q3', type: 'BOQI', buildingId: blds[0].buildingId, auditorId: AU1 });
await wait(800);
const m1 = phones.a.got[before];
ok(r.s === 200 && m1 && /New assignment/.test(m1.title) && m1.url === '/app#pg-auditor' && m1.badge >= 1, 'an assignment arrives on the phone, opens My Assignments, shows the unread count', JSON.stringify(m1));
ok(!phones.gone.got.length, 'the uninstalled phone got nothing');
const goneLeft = (await call('au1', 'GET', '/api/push/status?endpoint=' + encodeURIComponent('http://localhost:9911/gone'))).j;
ok(goneLeft && goneLeft.on === false, 'its address was forgotten after the push service said 410');
const lBefore = phones.l.got.length;
const ID = 2400000000 + Math.floor(Math.random() * 1e6);
await call('au1', 'POST', '/api/inspections', { id: ID, facility: 'Push test ' + ID, date: '2031-07-10', type: 'Follow-up', sections: [{ title: 'Entrance & Lobby', items: [{ label: 'a', score: 1 }] }] });
await wait(800);
ok(phones.l.got.slice(lBefore).some((x) => /New report to review/.test(x.title)), 'a submitted report reaches the leader’s phone', JSON.stringify(phones.l.got.at(-1)));
ok(!phones.a.got.slice(before + 1).some((x) => /Report submitted/.test(x.title)), 'the auditor’s own receipt is not pushed');
r = await call('au1', 'POST', '/api/push/test');
await wait(300);
ok(r.j.sent === 1 && phones.a.got.at(-1).title === 'Test notification', '“Send a test” works');

console.log('Only while signed in');
await call('au1', 'POST', '/api/auth/logout');
const after = phones.a.got.length;
await call('adm', 'POST', '/api/assignments', { quarter: '2031-Q3', type: 'BOQI', buildingId: blds[1].buildingId, auditorId: AU1 });
await wait(800);
ok(phones.a.got.length === after, 'signed out: nothing reaches the phone');

console.log('Cleanup');
server.close();
console.log(`\n${pass} passed, ${bad} failed`);
