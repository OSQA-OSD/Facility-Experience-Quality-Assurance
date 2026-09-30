// The hardening fixes: forged server marks, input limits, photo signatures, sign-in throttle, timing.
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
const B = 'http://localhost:8787';
const REPO = process.env.REPO || fileURLToPath(new URL('..', import.meta.url));
const S = { adm: 'tst-adm-2026', au1: 'tst-au1-2026' };
let pass = 0, bad = 0;
const ok = (c, l, x = '') => { c ? pass++ : bad++; console.log((c ? '  ✓ ' : '  ✗ ') + l + (x ? '  ' + x : '')); };
const call = async (who, method, path, body, headers = {}) => {
  const h = { 'Content-Type': 'application/json', ...headers }; if (who) h.Cookie = 'qa_session=' + S[who];
  const r = await fetch(B + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, j };
};
const base = (over = {}) => ({ id: 2600000000 + Math.floor(Math.random() * 1e6), facility: 'Hardening ' + Math.random().toString(36).slice(2, 7), date: '2031-05-10', type: 'Follow-up',
  sections: [{ title: 'Entrance & Lobby', items: [{ label: 'a', score: 0, comment: 'x' }, { label: 'b', score: 0 }] }], ...over });

console.log('A report cannot claim server-only marks');
let rec = base({ trialImport: 'forged', overall: 99 });
let r = await call('au1', 'POST', '/api/inspections', rec);
let g = await call('au1', 'GET', '/api/inspections/' + rec.id);
ok(r.s === 201 && g.j.record.overall === 0 && !g.j.record.trialImport, 'forged trialImport dropped; the score is still worked out (0, not 99)', `${r.s} ${g.j?.record?.overall} ${g.j?.record?.trialImport}`);
const dupe = base({ facility: 'Dup ' + rec.id, type: 'BOQI', date: '2031-04-10' });
await call('au1', 'POST', '/api/inspections', dupe);
r = await call('au1', 'POST', '/api/inspections', { ...base({ facility: dupe.facility, type: 'BOQI', date: '2031-05-11' }), trialImport: 'x' });
ok(r.s === 409, 'forging trialImport no longer slips past the one-report-per-building check', String(r.s));

console.log('Report fields are checked');
for (const [bad_, what] of [[{ type: 'SPOT' }, 'unknown type'], [{ date: '2031-02-30' }, 'impossible date'], [{ date: '31/05/2031' }, 'wrong date format'], [{ facility: 'x'.repeat(201) }, 'building name over 200'], [{ facility: '   ' }, 'blank building name'],
  [{ sections: [{ title: 't', items: [{ label: 'a', score: 1, comment: 'c'.repeat(5001) }] }] }, 'comment over 5000'], [{ sections: Array.from({ length: 31 }, () => ({ title: 't', items: [] })) }, 'more than 30 sections'],
  [{ sections: [{ title: 't', items: [{ label: 'a', score: 1, photos: Array(31).fill('x') }] }] }, 'more than 30 photos on an item']]) {
  r = await call('au1', 'POST', '/api/inspections', base(bad_));
  ok(r.s === 400, `refused: ${what}`, r.j?.error);
}
ok((await call('au1', 'POST', '/api/inspections', [1, 2])).s === 400, 'refused: not an object');

console.log('Photos must really be what they claim');
const pngBytes = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
for (const [p, what] of [[`data:image/jpeg;base64,${pngBytes}`, 'PNG bytes labelled JPEG'], [`data:image/png;base64,${html}`, 'HTML labelled PNG'], [`data:image/webp;base64,${html}`, 'HTML labelled WebP']]) {
  r = await call('au1', 'POST', '/api/inspections', base({ sections: [{ title: 't', items: [{ label: 'a', score: 1, photos: [p] }] }] }));
  ok(r.s === 400 && /real image/.test(r.j?.error || ''), `refused: ${what}`, r.j?.error);
}
r = await call('au1', 'POST', '/api/inspections', base({ sections: [{ title: 't', items: [{ label: 'a', score: 1, photos: [`data:image/png;base64,${pngBytes}`] }] }] }));
ok(r.s === 201, 'a real PNG is accepted');

console.log('Wrong usernames take as long as wrong passwords');
const time = async (u) => { const t = []; for (let i = 0; i < 3; i++) { const t0 = performance.now(); await call(null, 'POST', '/api/auth/login', { username: u, password: 'Wrong!pass1' }); t.push(performance.now() - t0); } return t.sort((a, b) => a - b)[1]; };
execSync(`cd "${REPO}" && node tests/sql.mjs --command "DELETE FROM auth_throttle; UPDATE qa_users SET failed_attempts=0, locked_until=NULL"`, { stdio: 'ignore' });
const ghost = await time('nobody-' + Date.now()), real = await time('auditor2');
ok(ghost > real * 0.5 && ghost < real * 2, `similar time (unknown ${ghost.toFixed(0)} ms vs real ${real.toFixed(0)} ms)`);
execSync(`cd "${REPO}" && node tests/sql.mjs --command "UPDATE qa_users SET failed_attempts=0, locked_until=NULL"`, { stdio: 'ignore' });

console.log('Sign-in attempts per network');
execSync(`cd "${REPO}" && node tests/sql.mjs --command "DELETE FROM auth_throttle"`, { stdio: 'ignore' });
let last = 0, first429 = null;
for (let i = 1; i <= 62; i++) { const x = await call(null, 'POST', '/api/auth/login', { username: 'nobody', password: 'x' }); last = x.s; if (x.s === 429 && !first429) first429 = i; }
ok(first429 === 61 && last === 429, 'the 61st attempt in 5 minutes from one network is refused (429)', `first 429 at #${first429}`);
ok((await call('au1', 'GET', '/api/auth/me')).s === 200, 'people already signed in are not affected');
execSync(`cd "${REPO}" && node tests/sql.mjs --command "DELETE FROM auth_throttle"`, { stdio: 'ignore' });
console.log(`\n${pass} passed, ${bad} failed`);
