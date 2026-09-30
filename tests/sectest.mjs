// End-to-end checks of the security, history, archive and backup paths against the local server.
const B = 'http://localhost:8787';
const S = { adm: 'tst-adm-2026', au1: 'tst-au1-2026', au2: 'tst-au2-2026', ldr: 'tst-ldr-2026' };
let pass = 0, failN = 0;
const ok = (cond, label, extra = '') => { if (cond) pass++; else failN++; console.log((cond ? '  ✓ ' : '  ✗ ') + label + (extra ? '  ' + extra : '')); };
async function call(who, method, path, body, headers = {}) {
  const h = { ...headers };
  if (who) h.Cookie = 'qa_session=' + S[who];
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(B + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { s: r.status, j, text, h: r.headers };
}
// a tiny real JPEG (1x1) and a PNG, as data URLs
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SVG = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');

const ID = 2100000000 + Math.floor(Math.random() * 1e6);
const rec = (over = {}) => ({
  id: ID, inspector: 'Somebody Else', facility: 'Test Building ' + ID, division: 'Test', date: '2026-09-20', type: 'Follow-up', typeLabel: 'Follow-up',
  overall: 70, filename: 'x.pdf',
  sections: [{ title: 'Entrance & Lobby', max: 10, items: [{ label: 'Clean floor', score: 1, comment: 'ok', photos: [JPG, PNG] }, { label: 'Lights', score: 0, comment: 'dim', photos: [] }] },
             { title: 'Food & Concession', max: 10, items: [{ label: 'Menu', score: 2 }, { label: 'Tables', score: 0 }] }],
  ...over,
});

console.log('Same-origin guard');
ok((await call('au1', 'POST', '/api/inspections', rec(), { Origin: 'https://evil.example' })).s === 403, 'cross-site Origin blocked');
ok((await call('au1', 'POST', '/api/inspections', rec(), { 'Sec-Fetch-Site': 'cross-site' })).s === 403, 'Sec-Fetch-Site cross-site blocked');
ok((await call('au1', 'POST', '/api/auth/change-password', { currentPassword: 'x', newPassword: 'y' }, { Origin: 'https://evil.example' })).s === 403, 'auth endpoints guarded too');
ok((await call(null, 'GET', '/api/admin/backup')).s === 401, 'no session → 401');
ok((await call('au1', 'GET', '/api/admin/backup')).s === 403, 'auditor cannot read admin backup');
ok((await call('au1', 'GET', '/api/admin/export?table=qa_users')).s === 403, 'auditor cannot export');
ok((await call('au1', 'GET', '/api/inspections')).s === 405, 'bulk report list endpoint is gone');

console.log('Photos: allowlist');
let r = await call('au1', 'POST', '/api/inspections', rec({ sections: [{ items: [{ text: 'a', score: 1, photos: [SVG] }] }] }));
ok(r.s === 400 && /JPEG, PNG/.test(r.j?.error), 'SVG photo refused', r.j?.error);
r = await call('au1', 'POST', '/api/inspections', rec({ sections: [{ items: [{ text: 'a', score: 1, photos: ['https://evil.example/x.jpg'] }] }] }));
ok(r.s === 400, 'external photo URL refused');
r = await call('au1', 'POST', '/api/inspections', rec({ sections: [{ items: [{ text: 'a', score: 1, photos: ['/api/photos/' + 'a'.repeat(64)] }] }] }));
ok(r.s === 400 && /missing/.test(r.j?.error), 'reference to a photo that does not exist refused');

console.log('Scores are worked out by the server');
r = await call('au1', 'POST', '/api/inspections', rec({ sections: [{ title: 'Entrance & Lobby', items: [{ label: 'a', score: 3 }] }] }));
ok(r.s === 400 && /not allowed/.test(r.j?.error), 'an impossible item score is refused', r.j?.error);
r = await call('au1', 'POST', '/api/inspections', rec({ sections: [{ title: 'Food & Concession', items: [{ label: 'a', score: 5 }] }] }));
ok(r.s === 400, 'a score above 2 in a 0/2 section is refused');

console.log('Create: owner comes from the session');
r = await call('au1', 'POST', '/api/inspections', rec({ overall: 99 }));
ok(r.s === 201, 'auditor submits', JSON.stringify(r.j));
let g = await call('au1', 'GET', '/api/inspections/' + ID);
ok(g.j?.record?.inspector === 'Auditor One', 'forged inspector name ignored → Auditor One', g.j?.record?.inspector);
ok(g.j?.summary?.own === true, 'report is marked own');
ok(g.j?.record?.overall === 10 && g.j.record.sections[0].score === 5 && g.j.record.sections[1].score === 5, 'a forged overall of 99 is replaced by the real score (10)', `overall ${g.j?.record?.overall}`);
const photos = g.j?.record?.sections?.[0]?.items?.[0]?.photos || [];
ok(photos.length === 2 && photos.every((p) => /^\/api\/photos\/[0-9a-f]{64}$/.test(p)), 'photos stored separately, report holds addresses');
const ph = await fetch(B + photos[0], { headers: { Cookie: 'qa_session=' + S.au2 } });
const phBuf = Buffer.from(await ph.arrayBuffer());
ok(ph.status === 200 && ph.headers.get('content-type') === 'image/jpeg' && phBuf.equals(Buffer.from(JPG.split(',')[1], 'base64')), 'photo served back byte-for-byte as image/jpeg');
ok(/sandbox/.test(ph.headers.get('content-security-policy') || '') && ph.headers.get('x-content-type-options') === 'nosniff', 'photo response is sandboxed + nosniff');
ok((await fetch(B + photos[0])).status === 401, 'photo needs a session');
r = await call('au1', 'POST', '/api/inspections', rec());
ok(r.j?.alreadySaved === true, 'double submit kept once');

console.log('Assignments belong to their auditor');
const asgList = await call('adm', 'GET', '/api/assignments?all=1');
const foreign = (asgList.j?.assignments || []).find((a) => a.auditorId && a.auditorId !== 'a1fd8b2b-b220-45f5-b2ba-623700ae9e0b');
if (foreign) {
  r = await call('au1', 'POST', '/api/inspections', rec({ id: ID + 1, assignmentId: foreign.id, facility: 'Other ' + ID }));
  ok(r.s === 403, 'auditor cannot submit against someone else’s assignment', r.j?.error);
} else console.log('  (no foreign assignment found to test)');

console.log('Editing');
r = await call('au2', 'PATCH', '/api/inspections/' + ID, rec({ overall: 10 }));
ok(r.s === 403, 'another auditor cannot edit it');
r = await call('au1', 'PATCH', '/api/inspections/' + ID, rec({ overall: 75, inspector: 'Auditor Two', sections: [{ title: 'Entrance & Lobby', items: [{ label: 'Clean floor', score: 0, comment: 'better now', photos: [photos[0]] }, { label: 'Lights', score: 0, comment: 'dim', photos: [] }] }, { title: 'Food & Concession', items: [{ label: 'Menu', score: 2 }, { label: 'Tables', score: 2 }] }] }));
ok(r.s === 200 && r.j?.version === 2, 'owner edits → version 2', JSON.stringify(r.j));
g = await call('au1', 'GET', '/api/inspections/' + ID);
ok(g.j?.record?.inspector === 'Auditor One', 'owner cannot hand the report to someone else');
let v = await call('au2', 'GET', `/api/inspections/${ID}/versions`);
ok(v.j?.versions?.length === 2 && v.j.versions[0].reason === 'edited' && v.j.versions[1].reason === 'submitted', 'history lists submitted + edited', JSON.stringify(v.j?.versions?.map((x) => x.reason)));
ok(v.j?.versions?.[0]?.changes?.scores === 2 && v.j.versions[0].changes.comments === 1 && v.j.versions[0].changes.photos === 1, 'history counts what changed', JSON.stringify(v.j?.versions?.[0]?.changes));
let v1 = await call('au1', 'GET', `/api/inspections/${ID}/versions/1`);
ok(v1.j?.record?.overall === 10 && v1.j.record.sections[0].items[0].photos.length === 2, 'version 1 opens with its original score and both photos');
ok(v.j?.versions?.[0]?.overall === 10 && v.j.versions[0].building, 'version 2 score is 10 as well (0+10)', String(v.j?.versions?.[0]?.overall));

console.log('Approved reports are locked');
r = await call('ldr', 'POST', `/api/inspections/${ID}/reviews`, { decision: 'approved', comment: 'fine' });
ok(r.s === 200 || r.s === 201, 'leader approves', r.j?.error || '');
r = await call('au1', 'PATCH', '/api/inspections/' + ID, rec({ overall: 99 }));
ok(r.s === 403 && /locked/.test(r.j?.error), 'owner cannot edit an approved report', r.j?.error);
r = await call('au1', 'DELETE', '/api/inspections/' + ID);
ok(r.s === 403 || /permission/.test(r.j?.error || ''), 'owner cannot delete an approved report', r.j?.error);
r = await call('adm', 'PATCH', '/api/inspections/' + ID, rec({ overall: 80, inspector: 'Auditor One' }));
ok(r.s === 200 && r.j?.version === 3, 'admin can still correct it → version 3');

console.log('Delete → archive → restore');
// its review status before it is deleted (approved, or "resubmitted" if the admin's correction
// landed in a later second than the approval) must be exactly what comes back
const statusBefore = (await call('au1', 'GET', '/api/inspections/' + ID)).j?.summary?.status;
r = await call('adm', 'DELETE', '/api/inspections/' + ID);
ok(r.s === 200 && r.j?.archived, 'admin delete moves it to the archive');
ok((await call('au1', 'GET', '/api/inspections/' + ID)).s === 404, 'no longer live');
ok((await call('au1', 'GET', `/api/inspections/${ID}/versions`)).s === 404, 'deleted report history hidden from non-admins');
let a = await call('adm', 'GET', '/api/admin/archive');
ok((a.j?.reports || []).some((x) => x.id === ID), 'listed in the archive');
r = await call('au1', 'POST', '/api/inspections', rec());
ok(r.s === 409, 'its number cannot be reused', r.j?.error);
r = await call('au1', 'POST', `/api/admin/archive/${ID}/restore`);
ok(r.s === 403, 'only an admin can restore');
r = await call('adm', 'POST', `/api/admin/archive/${ID}/restore`);
ok(r.s === 200, 'admin restores');
g = await call('au1', 'GET', '/api/inspections/' + ID);
ok(g.s === 200 && g.j?.record?.overall === 10 && g.j.summary.status === statusBefore && g.j.summary.lastDecision?.decision === 'approved', 'back with its score, its approval and the same status as before', `${g.j?.record?.overall} ${g.j?.summary?.status} (before: ${statusBefore})`);
v = await call('adm', 'GET', `/api/inspections/${ID}/versions`);
ok(v.j?.versions?.map((x) => x.reason).join(',') === 'restored,deleted,edited,edited,submitted', 'full history kept', v.j?.versions?.map((x) => x.reason).join(','));

console.log('Audit log');
const au = await call('adm', 'GET', '/api/admin/audit?limit=40');
const acts = (au.j?.entries || au.j?.rows || au.j?.log || []).map((x) => x.action);
for (const act of ['inspection.create', 'inspection.update', 'inspection.delete', 'inspection.restore']) ok(acts.includes(act), 'audit has ' + act);

console.log('Backup');
r = await call('adm', 'POST', '/api/admin/backup/run');
ok(r.s === 200 && r.j?.ok, 'backup runs', r.j?.error || `${r.j?.seconds}s versions=${r.j?.versionsCopied} waiting=${r.j?.versionsWaiting}`);
const st = await call('adm', 'GET', '/api/admin/backup');
ok(st.j?.lastOk?.ok && st.j.storage.backups, 'status shows last good backup');
console.log('   counts', JSON.stringify(st.j?.counts));

console.log('Full export');
let rows = 0, pages = 0, after = '';
for (;;) { const e = await call('adm', 'GET', `/api/admin/export?table=inspection_versions&after=${after}`); rows += e.j.rows.length; pages++; if (e.j.next == null) break; after = e.j.next; }
ok(rows === st.j?.counts?.versions, `export pages through every version (${rows} in ${pages} pages)`);
const pb = await call('adm', 'GET', '/api/admin/export?table=photo_blobs');
ok(pb.j?.rows?.length > 0 && pb.j.rows[0].data, 'photos included in the export');
ok((await call('adm', 'GET', '/api/admin/export?table=qa_sessions')).s === 400, 'sessions are never exported');

console.log('Session renewal');
const me = await call('au1', 'GET', '/api/auth/me');
console.log('   set-cookie on /me:', me.h.get('set-cookie') ? 'yes' : 'no (fresh session, not due yet)');

console.log(`\n${pass} passed, ${failN} failed  (test report id ${ID})`);
