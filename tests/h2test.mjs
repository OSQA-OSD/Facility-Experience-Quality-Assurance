// Hardening round 2: page security policy, the converter page, private caching, the app code behind
// sign-in, sign-in audit entries, network and per-person limits, duplicate reviews, device cap.
// Local server and local D1 only.
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
const B = 'http://localhost:8787';
const REPO = process.env.REPO || fileURLToPath(new URL('..', import.meta.url));
const S = { adm: 'tst-adm-2026', au1: 'tst-au1-2026', au2: 'tst-au2-2026' };
const AU1 = 'a1fd8b2b-b220-45f5-b2ba-623700ae9e0b';
let pass = 0, bad = 0;
const ok = (c, l, x = '') => { c ? pass++ : bad++; console.log((c ? '  ✓ ' : '  ✗ ') + l + (x ? '  ' + x : '')); };
async function call(who, method, path, body, headers = {}) {
  const h = { ...headers }; if (who) h.Cookie = 'qa_session=' + (S[who] || who);
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(B + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { s: r.status, j, text, h: r.headers, cookie: (r.headers.get('set-cookie') || '').match(/qa_session=([^;]+)/)?.[1] };
}
const sql = (q) => JSON.parse(execSync(`cd "${REPO}" && npx wrangler d1 execute facility-qa --local --json --command "${q}"`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString())[0].results;
const auditSince = (id) => sql(`SELECT action, actor_name, target, details FROM audit_log WHERE id > ${id} ORDER BY id`);
const lastAudit = () => sql('SELECT MAX(id) AS m FROM audit_log')[0].m || 0;
const scriptSrc = (csp) => (csp.match(/script-src ([^;]+)/) || [])[1] || '';

console.log('Page security policy');
for (const [path, who] of [['/login', null], ['/', null], ['/app', 'adm'], ['/report', 'adm']]) {
  const r = await call(who, 'GET', path);
  const csp = r.h.get('content-security-policy') || '', ss = scriptSrc(csp);
  ok(r.s === 200 && ss && !/unsafe-inline|unsafe-eval/.test(ss), `${path}: no inline script and no eval allowed`, ss.slice(0, 80));
  ok(!/https:\/\/(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com)(\s|;|$)/.test(ss) && !/heic2any/.test(ss), `${path}: CDNs allowed file by file, never whole hosts`);
  ok(!/<script>|\son[a-z]+="/.test(r.text), `${path}: no inline script or inline handler in the markup`);
}
{
  const r = await call(null, 'GET', '/heic');
  const csp = r.h.get('content-security-policy') || '';
  ok(r.s === 200 && /default-src 'none'/.test(csp) && /'unsafe-eval'/.test(csp) && /heic2any@0\.0\.4/.test(csp) && !/connect-src[^;]*'self'/.test(csp),
    'converter page: eval allowed there only, and it can fetch nothing', csp.slice(0, 90));
  ok(!/<script>/.test(r.text), 'converter page has no inline script either');
}

console.log('Cross-site isolation');
{
  const p = await call('adm', 'GET', '/app');
  ok(p.h.get('cross-origin-opener-policy') === 'same-origin', 'pages: other sites cannot keep a handle on this window (COOP)');
  const a = await call('adm', 'GET', '/api/auth/me');
  ok(a.h.get('cross-origin-resource-policy') === 'same-origin', 'API answers cannot be embedded by other sites (CORP)');
  const lib = await call('adm', 'GET', '/api/reports/library?limit=50');
  const withPhoto = (lib.j.rows || []).find((x) => x.photos > 0) || null;
  let photoUrl = null;
  for (const row of (lib.j.rows || []).slice(0, 30)) {
    const rec = (await call('adm', 'GET', `/api/inspections/${row.id}`)).j;
    photoUrl = JSON.stringify(rec).match(/\/api\/photos\/[0-9a-f]{64}/)?.[0];
    if (photoUrl) break;
  }
  if (photoUrl) {
    const ph = await call('adm', 'GET', photoUrl);
    ok(ph.s === 200 && ph.h.get('cross-origin-resource-policy') === 'same-origin', 'photos cannot be embedded by other sites (CORP)');
  } else ok(true, 'photos: no stored photo in the local data to check (skipped)');
  const js = await call(null, 'GET', '/js/heic-frame.js');
  ok(js.s === 200 && !js.h.get('cross-origin-resource-policy'), 'the converter script stays loadable by its sealed frame');
}

console.log('Cross-site isolation');
{
  const p = await call('adm', 'GET', '/app');
  ok(p.h.get('cross-origin-opener-policy') === 'same-origin', 'pages: other sites cannot keep a handle on this window (COOP)');
  const a = await call('adm', 'GET', '/api/auth/me');
  ok(a.h.get('cross-origin-resource-policy') === 'same-origin', 'API answers cannot be embedded by other sites (CORP)');
  // a stored photo: submit a report with one, then fetch it
  const PID = 2300000000 + Math.floor(Math.random() * 1e6);
  const jpg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
  await call('au1', 'POST', '/api/inspections', { id: PID, inspector: 'x', facility: 'CORP Building ' + PID, division: 'Test', date: '2026-09-22', type: 'Follow-up', typeLabel: 'Follow-up', overall: 90, filename: 'c.pdf',
    sections: [{ title: 'Entrance & Lobby', max: 10, items: [{ label: 'Clean floor', score: 1, comment: '', photos: [jpg] }] }] });
  const photoUrl = JSON.stringify((await call('au1', 'GET', `/api/inspections/${PID}`)).j).match(/\/api\/photos\/[0-9a-f]{64}/)?.[0];
  const ph = photoUrl ? await call('au1', 'GET', photoUrl) : { s: 0, h: new Headers() };
  ok(ph.s === 200 && ph.h.get('cross-origin-resource-policy') === 'same-origin', 'photos cannot be embedded by other sites (CORP)');
  await call('adm', 'DELETE', `/api/inspections/${PID}`);
  const js = await call(null, 'GET', '/js/heic-frame.js');
  ok(js.s === 200 && !js.h.get('cross-origin-resource-policy'), 'the converter script stays loadable by its sealed frame');
}

console.log('Private pages and code');
{
  const a = await call('adm', 'GET', '/app');
  ok(/no-store/.test(a.h.get('cache-control') || ''), 'the signed-in app page is never cached', a.h.get('cache-control'));
  const js0 = await call(null, 'GET', '/js/app.js');
  ok(js0.s === 401 && !/API_BASE/.test(js0.text), 'the app code needs a session');
  const js1 = await call('adm', 'GET', '/js/app.js');
  ok(js1.s === 200 && /API_BASE/.test(js1.text) && /private/.test(js1.h.get('cache-control') || ''), 'signed in: the app code loads, marked private');
  ok((await call(null, 'GET', '/js/theme.js')).s === 200, 'the theme and sign-in scripts are public (no data in them)');
}

console.log('Odd paths');
for (const p of ['constructor', '__proto__', 'hasOwnProperty', 'toString']) {
  const r = await call(null, 'POST', '/api/' + p, {});
  ok(r.s === 401 || r.s === 404, `POST /api/${p} is refused normally, not a server error`, String(r.s));
}

console.log('Sign-ins are in the audit log (never what was typed)');
const uname = 'h2t' + Date.now().toString(36).slice(-6), temp = 'Temp!' + Date.now() + 'aA', pw2 = 'Final!' + Date.now() + 'bB';
let r = await call('adm', 'POST', '/api/admin/users', { name: 'H2 Test', username: uname, password: temp, role: 'quality_auditor' });
const uid = r.j?.id;
ok(r.s === 201 && uid, 'test account created');
let mark = lastAudit();
r = await call(null, 'POST', '/api/auth/login', { username: uname, password: 'Wrong!pass1' });
let a = auditSince(mark);
ok(r.s === 401 && a.some((e) => e.action === 'auth.failed' && /Wrong password \(1 of 5\)/.test(e.details) && /network/.test(e.details)), 'a wrong password is recorded with the device and network', JSON.stringify(a));
ok(!a.some((e) => (e.details || '').includes('Wrong!pass1')), 'the wrong password itself is not in the log');
mark = lastAudit();
r = await call(null, 'POST', '/api/auth/login', { username: 'nobody-' + uname, password: 'Guess!ing1' });
ok(r.s === 401 && auditSince(mark).length === 0, 'an unknown username is not logged one attempt at a time (it could be a mistyped password)');
r = await call(null, 'POST', '/api/auth/complete-setup', { username: uname, currentPassword: temp, newPassword: pw2 });
ok(r.s === 200 && r.cookie, 'temporary password replaced');
mark = lastAudit();
r = await call(null, 'POST', '/api/auth/login', { username: uname, password: pw2 });
a = auditSince(mark);
ok(r.s === 200 && a.some((e) => e.action === 'auth.login' && e.actor_name === 'H2 Test'), 'a successful sign-in is recorded', JSON.stringify(a));
ok(!a.some((e) => (e.details || '').includes(pw2)), 'the password is not in the log');
await call('adm', 'PATCH', `/api/admin/users/${uid}`, { status: 'suspended' });
mark = lastAudit();
r = await call(null, 'POST', '/api/auth/login', { username: uname, password: pw2 });
ok(r.s === 403 && auditSince(mark).some((e) => e.action === 'auth.blocked'), 'a suspended account signing in is recorded');
await call('adm', 'DELETE', `/api/admin/users/${uid}`);

console.log('Too many sign-in attempts from one network');
sql("DELETE FROM auth_throttle WHERE key LIKE 'auth/login:%'");
mark = lastAudit();
let codes = [];
for (let i = 0; i < 62; i++) codes.push((await call(null, 'POST', '/api/auth/login', { username: 'nobody-' + i, password: 'Guess!ing1' })).s);
a = auditSince(mark).filter((e) => e.action === 'security.throttle');
ok(codes.slice(0, 60).every((c) => c === 401) && codes[60] === 429 && codes[61] === 429, 'the 61st attempt in 5 minutes is refused (429)', codes.slice(58).join(','));
ok(a.length === 1 && /Network/.test(a[0].target), 'one audit entry for it, not one per attempt', JSON.stringify(a));
sql("DELETE FROM auth_throttle WHERE key LIKE 'auth/login:%'");

console.log('Limits per signed-in person');
sql("DELETE FROM auth_throttle WHERE key LIKE 'user:%'");
mark = lastAudit();
codes = [];
for (let i = 0; i < 11; i++) codes.push((await call('au1', 'POST', '/api/push/test', {})).s);
ok(codes.slice(0, 10).every((c) => c === 200) && codes[10] === 429, 'the 11th test notification in 10 minutes is refused', codes.join(','));
ok(auditSince(mark).filter((e) => e.action === 'security.throttle').length === 1, 'and recorded once in the audit log');
ok((await call('au2', 'POST', '/api/push/test', {})).s === 200, 'another person is not affected');
ok((await call('au1', 'GET', '/api/account/settings')).s === 200, 'reading still works for the limited person');
sql("DELETE FROM auth_throttle WHERE key LIKE 'user:%'");

console.log('At most ten notification devices per person');
sql(`DELETE FROM push_subscriptions WHERE user_id='${AU1}'`);
const key = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
for (let i = 0; i < 12; i++) {
  if (i === 9) sql("DELETE FROM auth_throttle WHERE key LIKE 'user:%'");
  await call('au1', 'POST', '/api/push/subscribe', { quiet: true, subscription: { endpoint: `http://localhost:9913/cap-${i}`, keys: { p256dh: key, auth: 'tBHItJI5svbpez7KI4CCXg' } } });
}
const devs = sql(`SELECT endpoint FROM push_subscriptions WHERE user_id='${AU1}' ORDER BY id`);
ok(devs.length === 10 && devs[0].endpoint.endsWith('cap-2') && devs[9].endpoint.endsWith('cap-11'), 'twelve devices → the ten newest are kept', String(devs.length));
sql(`DELETE FROM push_subscriptions WHERE user_id='${AU1}'`);
sql("DELETE FROM auth_throttle WHERE key LIKE 'user:%'");

console.log('The same review twice is kept once');
const ID = 2200000000 + Math.floor(Math.random() * 1e6);
r = await call('au1', 'POST', '/api/inspections', {
  id: ID, inspector: 'x', facility: 'H2 Building ' + ID, division: 'Test', date: '2026-09-21', type: 'Follow-up', typeLabel: 'Follow-up', overall: 80, filename: 'h2.pdf',
  sections: [{ title: 'Entrance & Lobby', max: 10, items: [{ label: 'Clean floor', score: 1, comment: 'ok', photos: [] }] }],
});
ok(r.s === 201, 'report submitted', r.j?.error || '');
const notes0 = sql(`SELECT COUNT(*) n FROM notifications WHERE user_id='${AU1}'`)[0].n;
const r1 = await call('adm', 'POST', `/api/inspections/${ID}/reviews`, { decision: 'changes_requested', comment: 'Please add photos' });
const r2 = await call('adm', 'POST', `/api/inspections/${ID}/reviews`, { decision: 'changes_requested', comment: 'Please add photos' });
const rows = sql(`SELECT COUNT(*) n FROM inspection_reviews WHERE inspection_id=${ID}`)[0].n;
const notes1 = sql(`SELECT COUNT(*) n FROM notifications WHERE user_id='${AU1}'`)[0].n;
ok(r1.s === 201 && r2.s === 200 && r2.j?.duplicate === true && r2.j?.status === r1.j?.status, 'the repeat is answered, not stored again', `${r1.s}/${r2.s} ${JSON.stringify(r2.j)}`);
ok(rows === 1 && notes1 - notes0 === 1, 'one review row, one notification to the auditor', `${rows} rows, ${notes1 - notes0} notifications`);
const r3 = await call('adm', 'POST', `/api/inspections/${ID}/reviews`, { decision: 'approved' });
ok(r3.s === 201 && sql(`SELECT COUNT(*) n FROM inspection_reviews WHERE inspection_id=${ID}`)[0].n === 2, 'a different decision is still recorded');
await call('adm', 'DELETE', `/api/inspections/${ID}`);

console.log('Deadline changes reach the audit log');
{
  const Q = '2031-Q4';
  const blds = (await call('adm', 'GET', `/api/officer/board?quarter=${Q}&type=BOQI`)).j.buildings;
  await call('adm', 'POST', '/api/assignments', { quarter: Q, type: 'BOQI', buildingId: blds[0].buildingId, auditorId: AU1 });
  mark = lastAudit();
  r = await call('adm', 'POST', '/api/assignments/due', { quarter: Q, type: 'BOQI', buildingIds: [blds[0].buildingId], dueDate: '2031-12-20' });
  a = auditSince(mark).filter((e) => e.action === 'assignment.due');
  ok(r.s === 200 && a.length === 1 && a[0].details === 'Deadline set to 2031-12-20', 'recorded with the new date', JSON.stringify(a));
  sql(`DELETE FROM assignments WHERE quarter='${Q}'`);
}

console.log(`\n${pass} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
