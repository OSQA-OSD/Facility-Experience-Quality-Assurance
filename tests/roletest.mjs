// Every role against every protected endpoint, called directly (no UI). Expected: allowed (2xx or
// a validation 4xx that is not 401/403) vs refused (401/403). Plus privilege-escalation attempts.
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import nodeCrypto from 'node:crypto';
const B = 'http://localhost:8787';
const REPO = process.env.REPO || fileURLToPath(new URL('..', import.meta.url));
const U = { admin: '8c2e36fd-608d-47ac-ae2a-c9f5ec5151ab', officer: '3aacf4c0-8b9a-4c44-8c87-54fde5e063b3', auditor: '6a45c7e7-5e68-46aa-93aa-726d4312d59a', analyst: 'bd3b6842-5e03-44cc-a9c7-9cd8679bc1cb', leader: 'df67488c-ff4b-40d9-95d8-5a8b32847a64' };
const tok = (r) => `tst-role-${r}-2026`;
const now = Date.now();
execSync(`cd "${REPO}" && npx wrangler d1 execute facility-qa --local --command "${Object.entries(U).map(([r, id]) => `INSERT OR REPLACE INTO qa_sessions (token_hash,user_id,expires_at,device,last_seen_at) VALUES ('${nodeCrypto.createHash('sha256').update(tok(r)).digest('hex')}','${id}',${now + 8 * 3600e3},'local test',${now})`).join('; ')}"`, { stdio: 'ignore' });
// the test auditor gets plain auditor rights (no old-style delete/export switches)
execSync(`cd "${REPO}" && npx wrangler d1 execute facility-qa --local --command "UPDATE qa_users SET role='quality_auditor', permissions=NULL, can_edit=1, can_delete=0, can_export=0 WHERE id='${U.auditor}'"`, { stdio: 'ignore' });
let pass = 0, bad = 0;
const ok = (c, l, x = '') => { c ? pass++ : bad++; if (!c) console.log('  ✗ ' + l + (x ? '  ' + x : '')); };
const call = async (role, method, path, body) => {
  const h = { 'Content-Type': 'application/json' }; if (role) h.Cookie = 'qa_session=' + tok(role);
  const r = await fetch(B + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return r.status;
};
const Q = '2026-Q3';
const someReport = 2000000001;
// [method, path, body, roles allowed]
const A = ['admin'], ALL = ['admin', 'officer', 'auditor', 'analyst', 'leader'];
const cases = [
  ['GET', '/api/admin/users', null, A], ['POST', '/api/admin/users', { name: 'x' }, A], ['GET', '/api/admin/audit', null, A],
  ['GET', '/api/admin/archive', null, A], ['GET', '/api/admin/backup', null, A], ['GET', '/api/admin/export?table=buildings', null, A],
  ['POST', `/api/admin/users/${U.auditor}/reset-password`, { password: 'x' }, A], ['POST', `/api/admin/users/${U.auditor}/unlock`, null, A],
  ['PATCH', `/api/admin/users/${U.auditor}`, {}, A], ['POST', '/api/admin/archive/1/restore', null, A],
  ['POST', '/api/buildings', { name: '' }, A], ['PATCH', '/api/buildings/1', { name: '' }, A], ['DELETE', '/api/buildings/999999', null, A],
  ['GET', '/api/buildings?usage=1', null, ALL],                       // everyone may list buildings; usage detail is admin-only (checked below)
  ['GET', `/api/officer/board?quarter=${Q}&type=BOQI`, null, ['admin', 'officer']],
  ['POST', '/api/assignments/bulk', { quarter: Q, type: 'BOQI', buildingIds: [] }, ['admin', 'officer']],
  ['POST', '/api/assignments/repeat', { quarter: 'bad' }, ['admin', 'officer']],
  ['POST', '/api/assignments/due', { quarter: Q, type: 'BOQI', buildingIds: [] }, ['admin', 'officer']],
  ['GET', '/api/assignments/auditors', null, ['admin', 'officer']],
  ['DELETE', '/api/assignments/999999', null, ['admin', 'officer']],
  ['GET', `/api/leader/overview?quarter=${Q}`, null, ['admin', 'leader']],
  ['GET', '/api/reports/inspections', null, ['admin', 'officer', 'auditor', 'analyst', 'leader']],
  ['POST', '/api/export/items', { ids: [] }, ['admin', 'officer', 'analyst', 'leader']],
  ['POST', `/api/inspections/${someReport}/reviews`, { decision: 'nope' }, ['admin', 'officer', 'leader']],
  ['POST', '/api/inspections', { id: 'x' }, ['admin', 'officer', 'auditor']],
  ['DELETE', `/api/inspections/999999999`, null, ['admin']],
  ['GET', `/api/auditor/profile?quarter=${Q}&auditorId=${U.officer}`, null, ['admin', 'officer', 'leader']],
  ['GET', `/api/auditor/profile?quarter=${Q}`, null, ALL],            // your own profile
  ['GET', `/api/inspections/${someReport}`, null, ALL],
  ['GET', `/api/notifications`, null, ALL], ['GET', '/api/account/settings', null, ALL], ['GET', '/api/reports/library', null, ALL],
];
for (const [m, p, body, allowed] of cases) {
  for (const role of ALL) {
    const s = await call(role, m, p, body);
    const denied = s === 401 || s === 403;
    ok(allowed.includes(role) ? !denied : denied, `${role.padEnd(7)} ${m} ${p}`, `→ ${s}`);
  }
  ok([401].includes(await call(null, m, p, body)), `anonymous ${m} ${p} → 401`);
}
console.log(`  matrix: ${cases.length} endpoints × 5 roles + anonymous checked`);

// escalation attempts
const esc = [];
const st = (await fetch(B + '/api/buildings?usage=1', { headers: { Cookie: 'qa_session=' + tok('auditor') } }).then((r) => r.json())).buildings[0];
ok(!('assignments' in st), 'non-admin asking for usage=1 gets the plain list');
ok((await call('auditor', 'PATCH', '/api/account/settings', { notifications: true, role: 'quality_admin' })) === 200 &&
  JSON.parse(execSync(`cd "${REPO}" && npx wrangler d1 execute facility-qa --local --json --command "SELECT role FROM qa_users WHERE id='${U.auditor}'"`, { stdio: ['ignore', 'pipe', 'ignore'] }))[0].results[0].role === 'quality_auditor', 'a role sent with your own settings is ignored');
ok((await call('officer', 'PATCH', `/api/admin/users/${U.officer}`, { role: 'quality_admin' })) === 403, 'an officer cannot promote themselves');
ok((await call('admin', 'PATCH', `/api/admin/users/${U.admin}`, { role: 'quality_auditor' })) === 400, 'an admin cannot demote themselves by accident');
ok((await call('auditor', 'GET', `/api/auditor/profile?quarter=${Q}&auditorId=${U.officer}`)) === 403, 'an auditor cannot open someone else’s profile by changing the id');
const fakeCookie = await fetch(B + '/api/auth/me', { headers: { Cookie: 'qa_session=' + 'forged-' + Date.now() } });
ok(fakeCookie.status === 401, 'a made-up session cookie is refused');
const expired = nodeCrypto.createHash('sha256').update('tst-expired').digest('hex');
execSync(`cd "${REPO}" && npx wrangler d1 execute facility-qa --local --command "INSERT OR REPLACE INTO qa_sessions (token_hash,user_id,expires_at,device,last_seen_at) VALUES ('${expired}','${U.admin}',${now - 1000},'local test',${now - 9 * 3600e3})"`, { stdio: 'ignore' });
ok((await fetch(B + '/api/auth/me', { headers: { Cookie: 'qa_session=tst-expired' } })).status === 401, 'an expired session is refused');
execSync(`cd "${REPO}" && npx wrangler d1 execute facility-qa --local --command "UPDATE qa_users SET status='suspended' WHERE id='${U.analyst}'"`, { stdio: 'ignore' });
ok((await call('analyst', 'GET', '/api/auth/me')) === 401, 'a suspended account’s open session stops working at once');
execSync(`cd "${REPO}" && npx wrangler d1 execute facility-qa --local --command "UPDATE qa_users SET status='active' WHERE id='${U.analyst}'"`, { stdio: 'ignore' });
ok((await call('auditor', 'GET', '/api/admin/users/../users')) !== 200, 'path tricks do not reach admin routes');
{ const t = await (await fetch(B + '/api/photos/../../worker.js', { headers: { Cookie: 'qa_session=' + tok('auditor') } })).text(); ok(!/export default|env\.DB/.test(t), 'no path traversal through photos (only the public page comes back)'); }
const wj = await fetch(B + '/worker.js'); const wt = await wj.text();
ok(!/VAPID_PRIVATE|password_hash\s*=|oauth_token/.test(wt) && !/export default \{/.test(wt), 'server code is not served as a file', `/worker.js → ${wj.status}`);
const dv = await fetch(B + '/.dev.vars'); ok(!(await dv.text()).includes('VAPID_PRIVATE_JWK'), 'local secrets file is not served');
const wr = await fetch(B + '/wrangler.jsonc'); ok(!(await wr.text()).includes('database_id'), 'deployment config is not served');
const mg = await fetch(B + '/migrations/0002_auth.sql'); ok(!(await mg.text()).includes('CREATE TABLE'), 'database schema files are not served');
console.log(`\n${pass} passed, ${bad} failed`);
