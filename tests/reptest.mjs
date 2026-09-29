// Repeat-for-End-of-Quarter and automatic cloud backup, against the local server.
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
const B = 'http://localhost:8787';
const REPO = process.env.REPO || fileURLToPath(new URL('..', import.meta.url));
const S = { adm: 'tst-adm-2026', au1: 'tst-au1-2026' };
const AU1 = 'a1fd8b2b-b220-45f5-b2ba-623700ae9e0b', AU2 = '6a45c7e7-5e68-46aa-93aa-726d4312d59a';
let pass = 0, bad = 0;
const ok = (c, l, x = '') => { c ? pass++ : bad++; console.log((c ? '  ✓ ' : '  ✗ ') + l + (x ? '  ' + x : '')); };
const call = async (who, method, path, body) => {
  const h = { 'Content-Type': 'application/json' }; if (who) h.Cookie = 'qa_session=' + S[who];
  const r = await fetch(B + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, j, t };
};
const Q = '2031-Q2';                                   // a quarter nobody uses, so the test stands alone
const board = async (type) => (await call('adm', 'GET', `/api/officer/board?quarter=${Q}&type=${type}`)).j.buildings;
const blds = (await board('BOQI')).slice(0, 9).map((b) => b.buildingId);

console.log('Setup: BOQI for two auditors, some EOQI already given out');
await call('adm', 'POST', '/api/assignments/bulk', { quarter: Q, type: 'BOQI', auditorId: AU1, buildingIds: blds.slice(0, 6) });
await call('adm', 'POST', '/api/assignments/bulk', { quarter: Q, type: 'BOQI', auditorId: AU2, buildingIds: blds.slice(6, 9) });
await call('adm', 'POST', '/api/assignments/bulk', { quarter: Q, type: 'EOQI', auditorId: AU1, buildingIds: [blds[0]] });   // already theirs
await call('adm', 'POST', '/api/assignments/bulk', { quarter: Q, type: 'EOQI', auditorId: AU2, buildingIds: [blds[1]] });   // someone else

console.log('Permissions');
ok((await call('au1', 'POST', '/api/assignments/repeat', { quarter: Q })).s === 403, 'an auditor cannot repeat assignments');
ok((await call('adm', 'POST', '/api/assignments/repeat', { quarter: 'nope' })).s === 400, 'bad quarter refused');
ok((await call('adm', 'POST', '/api/assignments/repeat', { quarter: Q, dueDate: '2031-02-30' })).s === 400, 'impossible deadline refused');

console.log('One auditor, keeping what is given to someone else');
let r = await call('adm', 'POST', '/api/assignments/repeat', { quarter: Q, auditorIds: [AU1], dueDate: '2031-06-30' });
ok(r.s === 200 && r.j.assigned === 4 && r.j.alreadyTheirs === 1 && r.j.keptOther === 1, 'Auditor One: 4 new, 1 already theirs, 1 kept with Auditor Two', JSON.stringify(r.j));
let end = new Map((await board('EOQI')).map((b) => [b.buildingId, b]));
ok(blds.slice(2, 6).every((id) => end.get(id).auditorId === AU1), 'the four are now Auditor One’s for EOQI');
ok(end.get(blds[1]).auditorId === AU2, 'the one given to Auditor Two stayed with Auditor Two');
ok(blds.slice(0, 6).filter((id) => id !== blds[1]).every((id) => end.get(id).dueDate === '2031-06-30'), 'deadline set on all of Auditor One’s EOQI buildings', end.get(blds[2]).dueDate);
ok(blds.slice(6, 9).every((id) => !end.get(id).auditorId), 'Auditor Two’s BOQI buildings were not touched (not chosen)');

console.log('Replace, and a building filter');
r = await call('adm', 'POST', '/api/assignments/repeat', { quarter: Q, replace: true, buildingIds: [blds[1], blds[6]] });
end = new Map((await board('EOQI')).map((b) => [b.buildingId, b]));
ok(r.j.assigned === 2 && end.get(blds[1]).auditorId === AU1 && end.get(blds[6]).auditorId === AU2, 'replace gives the EOQI back to the BOQI auditor; the filter limits it to those buildings', JSON.stringify(r.j));
ok(!end.get(blds[7]).auditorId, 'buildings outside the filter untouched');
r = await call('adm', 'POST', '/api/assignments/repeat', { quarter: Q });
ok(r.j.assigned === 2 && r.j.alreadyTheirs === 7, 'running it again only adds what is missing', JSON.stringify(r.j));

console.log('Emergency change afterwards');
r = await call('adm', 'POST', '/api/assignments', { quarter: Q, type: 'EOQI', buildingId: blds[3], auditorId: AU2 });
end = new Map((await board('EOQI')).map((b) => [b.buildingId, b]));
ok(r.s === 200 && end.get(blds[3]).auditorId === AU2, 'one EOQI building moved to someone else');
const beg = new Map((await board('BOQI')).map((b) => [b.buildingId, b]));
ok(beg.get(blds[3]).auditorId === AU1, 'its BOQI assignment is unchanged');

console.log('Notifications and audit');
const n = await call('au1', 'GET', '/api/notifications');
const items = n.j?.notifications || n.j?.items || [];
ok(items.some((x) => /end of the quarter|End of quarter/i.test(x.title) && /same buildings as your BOQI/.test(x.body || '')), 'the auditor was told, once, about the end-of-quarter buildings');
const au = await call('adm', 'GET', '/api/admin/audit?limit=20');
ok((au.j?.entries || au.j?.rows || []).some((e) => e.action === 'assignment.repeat'), 'the audit log records it');

console.log('Cleanup of the test quarter');
execSync(`cd "${REPO}" && npx wrangler d1 execute facility-qa --local --command "DELETE FROM assignments WHERE quarter='${Q}'"`, { stdio: 'ignore' });
console.log(`\n${pass} passed, ${bad} failed`);
