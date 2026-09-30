// Notification setting: stored per person, only by that person, honoured by the in-app list and
// by phone pushes; security alerts always delivered. Uses a stand-in push service on :9912.
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import nodeCrypto from 'node:crypto';
import { execSync } from 'node:child_process';
const B = 'http://localhost:8787';
const REPO = process.env.REPO || fileURLToPath(new URL('..', import.meta.url));
const S = { adm: 'tst-adm-2026', au1: 'tst-au1-2026', au2: 'tst-au2-2026', ldr: 'tst-ldr-2026' };
const ID = { adm: '8c2e36fd-608d-47ac-ae2a-c9f5ec5151ab', au1: 'a1fd8b2b-b220-45f5-b2ba-623700ae9e0b', au2: '6a45c7e7-5e68-46aa-93aa-726d4312d59a', ldr: 'df67488c-ff4b-40d9-95d8-5a8b32847a64' };
let pass = 0, bad = 0;
const ok = (c, l, x = '') => { c ? pass++ : bad++; console.log((c ? '  ✓ ' : '  ✗ ') + l + (x ? '  ' + x : '')); };
const call = async (who, method, path, body) => {
  const h = { 'Content-Type': 'application/json' }; if (who) h.Cookie = 'qa_session=' + S[who];
  const r = await fetch(B + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, j };
};
const sql = (q) => JSON.parse(execSync(`cd "${REPO}" && node tests/sql.mjs --json --command "${q}"`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString())[0].results;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const count = (who, extra = '') => sql(`SELECT COUNT(*) n FROM notifications WHERE user_id='${ID[who]}' ${extra}`)[0].n;

// a stand-in push service: counts what reaches each "phone"
const got = { au1: [] };
const ecdh = nodeCrypto.createECDH('prime256v1'); ecdh.generateKeys(); const auth = nodeCrypto.randomBytes(16);
const server = http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
  const box = Buffer.concat(c), s = box.subarray(0, 16), idlen = box[20], asPublic = box.subarray(21, 21 + idlen), sealed = box.subarray(21 + idlen);
  const ikm = Buffer.from(nodeCrypto.hkdfSync('sha256', ecdh.computeSecret(asPublic), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, s, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, s, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(sealed.subarray(-16));
  got.au1.push(JSON.parse(Buffer.concat([d.update(sealed.subarray(0, -16)), d.final()]).subarray(0, -1).toString()));
  res.writeHead(201); res.end(); }); });
await new Promise((r) => server.listen(9912, r));

console.log('The setting itself');
let r = await call('au1', 'GET', '/api/account/settings');
ok(r.s === 200 && r.j.notifications === true, 'on by default');
ok((await call(null, 'GET', '/api/account/settings')).s === 401, 'needs to be signed in');
ok((await call('au1', 'PATCH', '/api/account/settings', { notifications: 'no' })).s === 400, 'only true/false accepted');
ok((await call('au1', 'PUT', '/api/account/settings', { notifications: false })).s === 405, 'wrong method refused');
r = await call('au1', 'PATCH', '/api/account/settings', { notifications: false, userId: ID.au2, id: ID.au2, role: 'quality_admin', notifications_enabled: 1 });
ok(r.s === 200 && r.j.notifications === false, 'Auditor One turns them off');
ok(sql(`SELECT notifications_enabled n FROM qa_users WHERE id='${ID.au2}'`)[0].n === 1, 'another person’s id in the request is ignored — Auditor Two unchanged');
ok(sql(`SELECT role FROM qa_users WHERE id='${ID.au1}'`)[0].role === 'quality_auditor', 'a role in the request is ignored (no mass assignment)');
ok((await call('au1', 'GET', '/api/auth/me')).j.user.notificationsEnabled === false, 'the app sees it (auth/me)');
r = await call('adm', 'PATCH', `/api/admin/users/${ID.au1}`, { notifications_enabled: 1, notificationsEnabled: true });
ok(sql(`SELECT notifications_enabled n FROM qa_users WHERE id='${ID.au1}'`)[0].n === 0, 'an administrator cannot switch it for them', `admin PATCH → ${r.s}`);
const list = (await call('adm', 'GET', '/api/admin/users')).j.users.find((u) => u.id === ID.au1);
ok(list && !('notificationsEnabled' in list) && !('notifications_enabled' in list), 'the admin user list does not expose it');

console.log('Honoured by the notification system');
await call('au1', 'POST', '/api/push/subscribe', { subscription: { endpoint: 'http://localhost:9912/au1', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } });
await wait(400);
const pushesAtStart = got.au1.length;
const blds = (await call('adm', 'GET', '/api/officer/board?quarter=2032-Q1&type=BOQI')).j.buildings;
let before = count('au1');
await call('adm', 'POST', '/api/assignments', { quarter: '2032-Q1', type: 'BOQI', buildingId: blds[0].buildingId, auditorId: ID.au1 });
await wait(700);
ok(count('au1') === before, 'off: an assignment does not create a notification for Auditor One');
ok(got.au1.length === pushesAtStart, 'off: nothing reaches the phone');
const cur = 'Aa!' + nodeCrypto.randomBytes(4).toString('hex');
// Auditor One's password is unknown to the test, so use the security path an admin triggers: a reset
before = count('au1');
r = await call('adm', 'POST', `/api/admin/users/${ID.au1}/reset-password`, { password: 'Tmp!' + nodeCrypto.randomBytes(5).toString('hex') + 'Q' });
await wait(700);
ok(r.s === 200 && count('au1', "AND type='security'") >= 1 && count('au1') === before + 1, 'a security alert (password reset) is still written while off');
ok(got.au1.length === pushesAtStart, 'the reset signed them out, so no push goes to their phone (only while signed in)');
// sign Auditor One back in (a fresh test session) for the rest
execSync(`cd "${REPO}" && node tests/sql.mjs --command "UPDATE qa_users SET must_change_password=0 WHERE id='${ID.au1}'; INSERT INTO qa_sessions (token_hash,user_id,expires_at,device,last_seen_at) VALUES ('${nodeCrypto.createHash('sha256').update(S.au1).digest('hex')}','${ID.au1}',${Date.now() + 8 * 3600e3},'local test',${Date.now()})"`, { stdio: 'ignore' });
await call('au1', 'POST', '/api/push/subscribe', { subscription: { endpoint: 'http://localhost:9912/au1', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } });
await wait(400);
ok((await call('au1', 'GET', '/api/account/settings')).j.notifications === false, 'the choice survives signing out and in again');

console.log('Reports to review');
await call('ldr', 'PATCH', '/api/account/settings', { notifications: false });
const ldrBefore = count('ldr'), admBefore = count('adm'), au1Before = count('au1');
const RID = 2500000000 + Math.floor(Math.random() * 1e6);
await call('au1', 'POST', '/api/inspections', { id: RID, facility: 'Setting test ' + RID, date: '2032-01-10', type: 'Follow-up', sections: [{ title: 'Entrance & Lobby', items: [{ label: 'a', score: 1 }] }] });
await wait(700);
ok(count('ldr') === ldrBefore, 'the leader (off) is not told about the new report');
ok(count('adm') === admBefore + 1, 'the admin (on) is told exactly once — no duplicates');
ok(count('au1') === au1Before, 'the auditor (off) gets no receipt either');

console.log('Turned back on');
await call('au1', 'PATCH', '/api/account/settings', { notifications: true });
const p0 = got.au1.length, n0 = count('au1');
await call('adm', 'POST', '/api/assignments', { quarter: '2032-Q1', type: 'BOQI', buildingId: blds[1].buildingId, auditorId: ID.au1 });
await wait(800);
ok(count('au1') === n0 + 1 && got.au1.length === p0 + 1, 'on again: exactly one notification and one push', JSON.stringify(got.au1.at(-1)?.title));
r = await call('au1', 'GET', '/api/notifications');
const newest = r.j.notifications[0];
ok(newest && newest.read === false, 'arrives unread');
await call('au1', 'POST', `/api/notifications/${newest.id}/read`);
ok((await call('au1', 'GET', '/api/notifications')).j.notifications[0].read === true, 'marking read works');
r = await call('au2', 'POST', `/api/notifications/${newest.id}/read`);
ok(r.j?.changed === false, 'someone else cannot mark it (their request changes nothing)');

console.log('Cleanup');
await call('ldr', 'PATCH', '/api/account/settings', { notifications: true });
execSync(`cd "${REPO}" && node tests/sql.mjs --command "DELETE FROM assignments WHERE quarter='2032-Q1'; DELETE FROM push_subscriptions"`, { stdio: 'ignore' });
server.close();
console.log(`\n${pass} passed, ${bad} failed`);
