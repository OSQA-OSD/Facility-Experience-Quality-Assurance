/**
 * Facility Experience QA — Worker API
 * Serves the static app and a small JSON API backed by Cloudflare D1.
 */

import {
  hashPassword, verifyPassword, createSession, destroySession, getUserFromRequest,
  readCookie, sessionCookieHeader, clearCookieHeader, isLocked,
  registerFailedAttempt, clearFailedAttempts, SESSION_COOKIE, MAX_FAILED_ATTEMPTS,
  passwordProblem, revokeSessions, sha256Hex,
} from './auth.js';

// API answers describe live data, so no browser may keep a copy — Safari in particular will
// otherwise hand back an old list for the same URL.
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });

const fail = (message, status = 500) => json({ error: message }, status);

/** DB row -> shape the front-end expects */
function rowToRecord(row) {
  let extra = {};
  try { extra = JSON.parse(row.data || '{}'); } catch { extra = {}; }
  return {
    id: row.id,
    inspector: row.inspector,
    facility: row.facility,
    division: row.division,
    date: row.date,
    type: row.type,
    typeLabel: row.type_label,
    overall: row.overall,
    filename: row.filename,
    ...extra,
  };
}

/** Front-end record -> column values */
/** The score is worked out here from the answers, the same way the form does, so a saved
 *  report's score always matches its items. Sections marked '02' score 0 or 2 per item. */
const TWO_POINT_SECTIONS = new Set(['food & concession', 'miscellaneous']);
function scoreReport(body) {
  if (!Array.isArray(body?.sections) || !body.sections.length) return { overall: null };
  let total = 0;
  for (const sec of body.sections) {
    if (!sec || typeof sec !== 'object' || !Array.isArray(sec.items)) return { error: 'a section of this report could not be read' };
    const perItem = sec.mode === '02' || (sec.mode !== '01' && TWO_POINT_SECTIONS.has(normName(sec.title))) ? 2 : 1;
    const max = Number(sec.max) > 0 ? Number(sec.max) : 10;
    let sum = 0;
    for (const it of sec.items) {
      const v = it && typeof it === 'object' ? it.score : null;
      if (v == null) continue;
      if (!Number.isInteger(v) || v < 0 || v > perItem) return { error: `“${String(sec.title || 'a section')}” has a score that is not allowed` };
      sum += v;
    }
    const raw = sec.items.length * perItem;
    sec.score = raw ? Math.round((sum / raw) * max * 10) / 10 : 0;
    total += sec.score;
  }
  return { overall: Math.round(total) };
}

function recordToRow(rec) {
  const { id, inspector, facility, division, date, type, typeLabel,
          overall: sentOverall, filename, ...rest } = rec;
  const scored = rest.trialImport ? { overall: sentOverall ?? null } : scoreReport(rest);
  if (scored.error) return { error: scored.error };
  const overall = scored.overall ?? sentOverall;
  return {
    id,
    inspector: inspector ?? '',
    facility: facility ?? '',
    division: division ?? '',
    date: date ?? '',
    type: type ?? '',
    type_label: typeLabel ?? '',
    overall: overall ?? null,
    filename: filename ?? '',
    data: JSON.stringify(rest ?? {}),
    body: rest ?? {},
  };
}


// Selecting a record's assignment without breaking on a row whose JSON is invalid.
const AID_SQL = "CASE WHEN json_valid(data) THEN CAST(json_extract(data, '$.assignmentId') AS INTEGER) END";

async function insertInspection(env, user, rec) {
  const r = recordToRow(rec);
  if (r.error) return fail(r.error, 400);
  if (r.id == null || !Number.isSafeInteger(Number(r.id)) || Number(r.id) <= 0) return fail('id is required', 400);
  const assignmentId = Number(rec?.assignmentId) > 0 ? Number(rec.assignmentId) : null;

  // The same submission arriving twice (a double tap, a retried request) is kept once.
  const same = await env.DB.prepare('SELECT id FROM inspections WHERE id = ?1').bind(r.id).first();
  if (same) return json({ ok: true, id: r.id, alreadySaved: true });
  const archived = await env.DB.prepare('SELECT id FROM inspection_archive WHERE id = ?1').bind(r.id).first();
  if (archived) return fail('this report number belongs to an archived report — start a new inspection', 409);

  // Who the report belongs to comes from the session, never from the form: an auditor always
  // files under their own account. Only an administrator may record it for someone else.
  const who = await reportOwner(env, user, r.inspector);
  r.inspector = who.name;

  if (assignmentId) {
    const asg = await env.DB.prepare('SELECT auditor_id FROM assignments WHERE id = ?1').bind(assignmentId).first();
    if (!asg) return fail('that assignment no longer exists — reopen it from My Assignments', 400);
    if (user.role !== ADMIN_ROLE && asg.auditor_id !== user.id) return fail('this building is assigned to someone else', 403);
  }

  const existing = await findExistingSubmission(env, r, assignmentId, null);
  if (existing) return json({ error: duplicateMessage(existing), existing }, 409);

  const stored = await storeReportPhotos(env, r.body, Number(r.id));
  if (stored.error) return fail(stored.error, 400);
  r.data = stored.data;

  try {
    await env.DB.prepare(
      `INSERT INTO inspections
         (id, inspector, facility, division, date, type, type_label, overall, filename, data, inspector_id, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
    ).bind(r.id, r.inspector, r.facility, r.division, r.date,
           r.type, r.type_label, r.overall, r.filename, r.data, who.id, user.id).run();
  } catch (err) {
    if (/UNIQUE|PRIMARY KEY/i.test(String(err?.message))) return json({ ok: true, id: r.id, alreadySaved: true });
    throw err;
  }

  await saveVersion(env, Number(r.id), 'submitted', user, { ...r, inspector_id: who.id });
  await audit(env, user, 'inspection.create', String(r.id), `${r.facility} · ${r.date}${r.type ? ' ' + r.type : ''}`,
    `Submitted${who.id !== user.id ? ` for ${who.name}` : ''} · score ${r.overall ?? '–'}`);
  await notifySubmission(env, user, r, assignmentId);
  return json({ ok: true, id: r.id }, 201);
}

/** The account a report is filed under. Non-admins: always themselves. Admins: the active
 *  account whose name they chose, or themselves. */
async function reportOwner(env, user, requestedName) {
  if (user.role !== ADMIN_ROLE) return { id: user.id, name: user.name };
  const wanted = normName(requestedName);
  if (!wanted || wanted === normName(user.name)) return { id: user.id, name: user.name };
  const { results } = await env.DB.prepare("SELECT id, name FROM qa_users WHERE status = 'active'").all();
  const match = (results || []).filter((u) => normName(u.name) === wanted);
  return match.length === 1 ? { id: match[0].id, name: match[0].name } : { id: null, name: String(requestedName).trim().slice(0, 120) };
}

/* ── Photos: stored once each, by content ────────────────────────────────────────────
 * A report arrives with its photos inline (data: URLs straight from the camera). Each photo
 * is checked (JPEG, PNG, WebP or HEIC only — never SVG, which can carry script), stored once
 * under the SHA-256 of its contents, and replaced in the report by its address. The same photo
 * in ten versions of a report is stored one time, reports stay small, and nothing the app does
 * ever deletes a photo. */
const PHOTO_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const PHOTO_ADDR = /^\/api\/photos\/([0-9a-f]{64})$/;
const MAX_PHOTO_BASE64 = 1_900_000; // ~1.4 MB of image, under D1's 2 MB row limit; the app sends ~0.2–0.6 MB JPEGs

const b64ToBytes = (b64) => { const bin = atob(b64), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i); return out; };
function bytesToB64(bytes) { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); }
const photoKey = (sha) => `photos/${sha}`;

/** Takes the report body (object or JSON text), files new photos, returns the body with addresses.
 *  With photo storage (R2, binding PHOTOS) switched on, the image goes there and the database
 *  keeps only its record; without it, the database keeps the image too. */
async function storeReportPhotos(env, body, inspectionId) {
  let data = body;
  if (typeof body === 'string' || body == null) {
    try { data = JSON.parse(body || '{}'); } catch { return { error: 'the report could not be read' }; }
  }
  const fresh = new Map(), refs = new Set();
  for (const sec of Array.isArray(data.sections) ? data.sections : []) {
    for (const item of Array.isArray(sec?.items) ? sec.items : []) {
      if (!item || typeof item !== 'object' || !Array.isArray(item.photos)) continue;
      const out = [];
      for (const p of item.photos) {
        if (typeof p !== 'string') return { error: 'a photo in this report could not be read' };
        const inline = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(p);
        if (inline) {
          let mime = inline[1].toLowerCase();
          if (mime === 'image/jpg') mime = 'image/jpeg';
          if (!PHOTO_MIME.has(mime)) return { error: `photos must be JPEG, PNG, WebP or HEIC (one is ${mime})` };
          const b64 = inline[2].replace(/\s+/g, '');
          if (b64.length > MAX_PHOTO_BASE64) return { error: 'one photo is larger than 1.4 MB — take it again or choose a smaller one' };
          const sha = await sha256Hex(b64);
          fresh.set(sha, { mime, b64 });
          out.push(`/api/photos/${sha}`);
          continue;
        }
        const addr = PHOTO_ADDR.exec(p);
        if (addr) { refs.add(addr[1]); out.push(p); continue; }
        return { error: 'a photo in this report is not in a supported format' };
      }
      item.photos = out;
    }
  }
  if (fresh.size) {
    // a photo already on file (the same picture saved twice) is not stored again
    const { results } = await env.DB.prepare('SELECT id FROM photo_blobs WHERE id IN (SELECT value FROM json_each(?1))')
      .bind(JSON.stringify([...fresh.keys()])).all();
    for (const x of results || []) fresh.delete(x.id);
  }
  const stmts = [];
  for (const [sha, { mime, b64 }] of fresh) {
    let kept = b64;
    if (env.PHOTOS) { await env.PHOTOS.put(photoKey(sha), b64ToBytes(b64), { httpMetadata: { contentType: mime } }); kept = ''; }
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO photo_blobs (id, mime, bytes, data, first_inspection_id) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(sha, mime, Math.floor(b64.length * 3 / 4), kept, inspectionId || null));
  }
  for (let i = 0; i < stmts.length; i += 10) await env.DB.batch(stmts.slice(i, i + 10));
  const known = [...refs].filter((sha) => !fresh.has(sha));
  if (known.length) {
    const { results } = await env.DB.prepare('SELECT id FROM photo_blobs WHERE id IN (SELECT value FROM json_each(?1))')
      .bind(JSON.stringify(known)).all();
    const have = new Set((results || []).map((x) => x.id));
    if (known.some((sha) => !have.has(sha))) return { error: 'a photo in this report is missing — add it again' };
  }
  return { data: JSON.stringify(data), stored: fresh.size };
}

async function servePhoto(env, sha) {
  if (!/^[0-9a-f]{64}$/.test(sha)) return fail('not found', 404);
  const row = await env.DB.prepare('SELECT mime, data FROM photo_blobs WHERE id = ?1').bind(sha).first();
  if (!row) return fail('not found', 404);
  let body;
  if (row.data) body = b64ToBytes(row.data);
  else {
    const obj = env.PHOTOS ? await env.PHOTOS.get(photoKey(sha)) : null;
    if (!obj) return fail('this photo is in photo storage, which is not connected', 503);
    body = obj.body;
  }
  return new Response(body, { headers: {
    'Content-Type': PHOTO_MIME.has(row.mime) ? row.mime : 'application/octet-stream',
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
}

/* ── History: every saved state of a report, numbered ───────────────────────────────── */
async function saveVersion(env, id, reason, user, r, savedAt = null) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { v } = await env.DB.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM inspection_versions WHERE inspection_id = ?1').bind(id).first();
    try {
      await env.DB.prepare(
        `INSERT INTO inspection_versions
           (inspection_id, version, reason, inspector, inspector_id, facility, division, date, type, type_label, overall, filename, data, saved_by_id, saved_by_name, saved_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, COALESCE(?16, datetime('now')))`,
      ).bind(id, v + 1, reason, r.inspector ?? '', r.inspector_id ?? null, r.facility ?? '', r.division ?? '', r.date ?? '',
        r.type ?? '', r.type_label ?? '', r.overall ?? null, r.filename ?? '', r.data || '{}',
        user?.id ?? null, user?.name ?? null, savedAt).run();
      return v + 1;
    } catch (err) {
      if (!/UNIQUE/i.test(String(err?.message))) throw err;       // two saves at once: take the next number
    }
  }
  return null;
}

/** Every report saved before history existed gets its current state recorded as version 1, in
 *  one statement. Reports that still carry photos inline wait until those photos are filed. */
async function recordBaselines(env) {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO inspection_versions
       (inspection_id, version, reason, inspector, inspector_id, facility, division, date, type, type_label, overall, filename, data, saved_by_id, saved_by_name, saved_at)
     SELECT id, 1, 'before-history', inspector, inspector_id, facility, division, date, type, type_label, overall, filename, data,
            inspector_id, inspector, COALESCE(updated_at, created_at, datetime('now'))
     FROM inspections i
     WHERE instr(i.data, '"data:image/') = 0 AND NOT EXISTS (SELECT 1 FROM inspection_versions v WHERE v.inspection_id = i.id)
     LIMIT 1000`,
  ).run();
  return res.meta?.changes || 0;
}

/** Reports saved before history existed get their current state recorded as version 1 the
 *  first time anything happens to them, so the first change is never the first thing on file. */
async function ensureFirstVersion(env, row) {
  const has = await env.DB.prepare('SELECT 1 AS x FROM inspection_versions WHERE inspection_id = ?1 LIMIT 1').bind(row.id).first();
  if (has) return;
  const stored = await storeReportPhotos(env, row.data, row.id);
  if (stored.data && stored.data !== row.data) {
    await env.DB.prepare('UPDATE inspections SET data = ?2 WHERE id = ?1').bind(row.id, stored.data).run();
    row.data = stored.data;
  }
  await saveVersion(env, row.id, 'before-history', { id: row.inspector_id || null, name: row.inspector || null }, row, row.updated_at || row.created_at);
}


/** A report already on file for the same assignment, or for the same building, type and quarter
 *  (one BOQI and one EOQI per building each quarter). Imported trial scores never block a real report. */
async function findExistingSubmission(env, r, assignmentId, excludeId) {
  const quarter = quarterOf(r.date);
  const perQuarter = (r.type === 'BOQI' || r.type === 'EOQI') && quarter;
  if (!assignmentId && !perQuarter) return null;
  const asg = assignmentId
    ? await env.DB.prepare('SELECT a.building_id, b.name FROM assignments a JOIN buildings b ON b.id = a.building_id WHERE a.id = ?1').bind(assignmentId).first()
    : null;
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.inspector, i.facility, i.date, i.type, i.aid, a.building_id AS bid
     FROM (SELECT id, inspector, facility, date, type, ${AID_SQL} AS aid,
                  CASE WHEN json_valid(data) THEN json_extract(data, '$.trialImport') END AS trial
           FROM inspections WHERE id != ?4) i
     LEFT JOIN assignments a ON a.id = i.aid
     WHERE i.trial IS NULL AND ((?1 > 0 AND i.aid = ?1) OR (i.type = ?2 AND substr(i.date, 1, 4) = ?3))`,
  ).bind(assignmentId || 0, r.type, (quarter || '').slice(0, 4), excludeId ?? -1).all();
  const name = normName(asg ? asg.name : r.facility);
  for (const x of results || []) {
    const sameAssignment = assignmentId && Number(x.aid) === assignmentId;
    const sameSlot = perQuarter && x.type === r.type && quarterOf(x.date) === quarter
      && ((asg && x.bid === asg.building_id) || normName(x.facility) === name);
    if (sameAssignment || sameSlot) {
      return { id: x.id, auditor: x.inspector, date: x.date, type: x.type, quarter: quarterOf(x.date), building: asg ? asg.name : x.facility, sameAssignment: !!sameAssignment };
    }
  }
  return null;
}
const duplicateMessage = (x) => (x.sameAssignment
  ? `This assignment was already submitted by ${x.auditor || 'an auditor'} on ${x.date}. Open that report to make changes.`
  : `${x.building} already has a ${x.type} report for ${x.quarter}, submitted by ${x.auditor || 'an auditor'} on ${x.date}. Open that report to make changes.`);

/** Active accounts, with what is needed to work out their permissions. */
async function activeAccounts(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, role, permissions, can_edit, can_delete, can_export FROM qa_users WHERE status = 'active'",
  ).all();
  return results || [];
}

/** A new report: Quality Leaders, everyone who reviews reports and whoever assigned it hear about it at once.
 *  The auditor gets a receipt (already marked read) so the submission is on record in their list. */
async function notifySubmission(env, user, r, assignmentId) {
  const a = assignmentId
    ? await env.DB.prepare('SELECT a.assigned_by, b.name AS building FROM assignments a JOIN buildings b ON b.id = a.building_id WHERE a.id = ?1').bind(assignmentId).first()
    : null;
  const building = a?.building || r.facility || 'a building';
  const what = [r.type, quarterOf(r.date)].filter(Boolean).join(' ');
  const score = r.overall != null ? ` · score ${Math.round(r.overall)}/100` : '';
  const link = `#pg-library/${r.id}`;
  const accounts = await activeAccounts(env);
  const recipients = new Set(accounts.filter((u) => u.role === 'quality_leader' || can(u, 'review')).map((u) => u.id));
  if (a?.assigned_by && accounts.some((u) => u.id === a.assigned_by)) recipients.add(a.assigned_by);
  recipients.delete(user.id);
  const insert = 'INSERT INTO notifications (user_id, type, title, body, link, read_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)';
  const statements = [...recipients].map((id) => env.DB.prepare(insert)
    .bind(id, 'submission', `New report to review: ${building}`, `${user.name} submitted ${what}${score}.`, link, null));
  statements.push(env.DB.prepare(insert).bind(user.id, 'receipt', `Report submitted: ${building}`,
    `${what}${score} — sent for review.`, link, new Date().toISOString().replace('T', ' ').slice(0, 19)));
  await env.DB.batch(statements);
}

async function updateInspection(env, user, id, rec) {
  const row = await env.DB.prepare('SELECT * FROM inspections WHERE id = ?1').bind(id).first();
  if (!row) return fail('record not found', 404);
  const ctx = await libraryContext(env);
  const before = libraryRow({ ...row, aid: jsonAid(row.data) }, ctx);
  if (user.role !== ADMIN_ROLE && !isOwnReport(user, before)) return fail('you can only edit your own reports', 403);
  if (user.role !== ADMIN_ROLE && before.status === 'approved') {
    return fail('this report is approved and locked — ask an administrator if it needs to change', 403);
  }

  const r = recordToRow(rec);
  if (r.error) return fail(r.error, 400);
  // The owner never changes on an edit, except when an administrator says so.
  let ownerId = row.inspector_id || null;
  if (user.role === ADMIN_ROLE) { const who = await reportOwner(env, user, r.inspector); r.inspector = who.name; ownerId = who.id ?? ownerId; }
  else r.inspector = row.inspector;
  const assignmentId = Number(rec?.assignmentId) > 0 ? Number(rec.assignmentId) : null;
  const existing = await findExistingSubmission(env, r, assignmentId, id);
  if (existing) return json({ error: duplicateMessage(existing), existing }, 409);

  const stored = await storeReportPhotos(env, r.body, id);
  if (stored.error) return fail(stored.error, 400);
  r.data = stored.data;
  await ensureFirstVersion(env, row);

  const res = await env.DB.prepare(
    `UPDATE inspections SET
       inspector = ?2, facility = ?3, division = ?4, date = ?5,
       type = ?6, type_label = ?7, overall = ?8, filename = ?9,
       data = ?10, inspector_id = ?11, updated_at = datetime('now')
     WHERE id = ?1`
  ).bind(id, r.inspector, r.facility, r.division, r.date,
         r.type, r.type_label, r.overall, r.filename, r.data, ownerId).run();
  if (!res.meta.changes) return fail('record not found', 404);

  const version = await saveVersion(env, id, 'edited', user, { ...r, inspector_id: ownerId });
  const moved = typeof row.overall === 'number' && typeof r.overall === 'number' && row.overall !== r.overall ? ` · score ${row.overall} → ${r.overall}` : '';
  await audit(env, user, 'inspection.update', String(id), `${r.facility} · ${r.date}${r.type ? ' ' + r.type : ''}`, `Saved as version ${version}${moved}`);

  // The first save after "changes requested" tells that reviewer the report is ready again.
  const decision = ctx.decision.get(id);
  if (before.status === 'changes' && decision?.reviewer_id && decision.reviewer_id !== user.id
      && ctx.users.some((u) => u.id === decision.reviewer_id)) {
    await notify(env, decision.reviewer_id, 'resubmission', `Updated for review: ${before.building}`,
      `${user.name} made the requested changes${before.type ? ` to the ${before.type}` : ''}. Ready to review again.`, `#pg-library/${id}`);
  }
  return json({ ok: true, id, version });
}

const jsonAid = (text) => { try { const a = JSON.parse(text || '{}').assignmentId; return a == null ? null : Number(a); } catch { return null; } };

/** Deleting never destroys a report: it moves to the archive, with every version, review and
 *  photo still on file, and an administrator can put it back. */
async function deleteInspection(env, user, id) {
  const row = await env.DB.prepare('SELECT * FROM inspections WHERE id = ?1').bind(id).first();
  if (!row) return fail('record not found', 404);
  if (user.role !== ADMIN_ROLE) {
    const ctx = await libraryContext(env);
    const summary = libraryRow({ ...row, aid: jsonAid(row.data) }, ctx);
    if (!isOwnReport(user, summary)) return fail('you can only delete your own reports — an administrator can remove others', 403);
    if (summary.status === 'approved') return fail('this report is approved and locked — ask an administrator', 403);
  }
  await ensureFirstVersion(env, row);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO inspection_archive
         (id, inspector, inspector_id, facility, division, date, type, type_label, overall, filename, data, created_by, created_at, updated_at, deleted_by_id, deleted_by_name)
       SELECT id, inspector, inspector_id, facility, division, date, type, type_label, overall, filename, data, created_by, created_at, updated_at, ?2, ?3
       FROM inspections WHERE id = ?1`,
    ).bind(id, user.id, user.name),
    env.DB.prepare('DELETE FROM inspections WHERE id = ?1').bind(id),
  ]);
  await saveVersion(env, id, 'deleted', user, row);
  await audit(env, user, 'inspection.delete', String(id), `${row.facility} · ${row.date}`,
    `Moved to the archive · inspection by ${row.inspector}`);
  return json({ ok: true, id, archived: true });
}

async function restoreInspection(env, user, id) {
  const row = await env.DB.prepare('SELECT * FROM inspection_archive WHERE id = ?1').bind(id).first();
  if (!row) return fail('that report is not in the archive', 404);
  const live = await env.DB.prepare('SELECT id FROM inspections WHERE id = ?1').bind(id).first();
  if (live) return fail('a report with this number is already live', 409);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO inspections (id, inspector, inspector_id, facility, division, date, type, type_label, overall, filename, data, created_by, created_at, updated_at)
       SELECT id, inspector, inspector_id, facility, division, date, type, type_label, overall, filename, data, created_by, created_at, updated_at
       FROM inspection_archive WHERE id = ?1`,
    ).bind(id),
    env.DB.prepare('DELETE FROM inspection_archive WHERE id = ?1').bind(id),
  ]);
  await saveVersion(env, id, 'restored', user, row);
  await audit(env, user, 'inspection.restore', String(id), `${row.facility} · ${row.date}`, `Restored from the archive (deleted by ${row.deleted_by_name || 'unknown'} on ${row.deleted_at})`);
  return json({ ok: true, id });
}

async function listArchive(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, inspector, facility, division, date, type, overall, deleted_at, deleted_by_name,
            (SELECT COUNT(*) FROM inspection_versions v WHERE v.inspection_id = a.id) AS versions
     FROM inspection_archive a ORDER BY deleted_at DESC LIMIT 500`,
  ).all();
  return json({ reports: (results || []).map((x) => ({ id: x.id, auditor: x.inspector, building: x.facility, division: x.division,
    date: x.date, type: x.type, overall: x.overall, deletedAt: x.deleted_at, deletedBy: x.deleted_by_name, versions: x.versions })) });
}

/** The saved states of one report, newest first, with what changed from the one before. */
async function listVersions(env, id) {
  const { results } = await env.DB.prepare(
    `SELECT version, reason, inspector, facility, date, type, overall, saved_by_name, saved_at, data
     FROM inspection_versions WHERE inspection_id = ?1 ORDER BY version`,
  ).bind(id).all();
  const rows = results || [];
  const items = (text) => {
    const m = new Map();
    try { (JSON.parse(text || '{}').sections || []).forEach((s, si) => (s.items || []).forEach((it, ii) => {
      if (it && typeof it === 'object') m.set(`${si}.${ii}`, [it.score ?? null, String(it.comment || ''), (it.photos || []).length]);
    })); } catch { /* unreadable versions still list */ }
    return m;
  };
  let prev = null;
  const out = rows.map((r) => {
    const cur = items(r.data);
    let scores = 0, comments = 0, photos = 0;
    if (prev) for (const [k, [sc, cm, ph]] of cur) {
      const o = prev.get(k) || [null, '', 0];
      if (o[0] !== sc) scores += 1;
      if (o[1] !== cm) comments += 1;
      if (o[2] !== ph) photos += 1;
    }
    prev = cur;
    return { version: r.version, reason: r.reason, by: r.saved_by_name, at: r.saved_at, overall: r.overall,
      building: r.facility, date: r.date, type: r.type, auditor: r.inspector, changes: { scores, comments, photos } };
  });
  return json({ versions: out.reverse() });
}

async function getVersion(env, id, version) {
  const row = await env.DB.prepare('SELECT * FROM inspection_versions WHERE inspection_id = ?1 AND version = ?2').bind(id, version).first();
  if (!row) return fail('that version was not found', 404);
  return json({ record: { ...rowToRecord({ ...row, id }), version: row.version, reason: row.reason, savedBy: row.saved_by_name, savedAt: row.saved_at } });
}

/* ── Keeping everything: backups, the archive and the full export ─────────────────────
 *
 * Three independent copies protect the reports:
 *  1. The database itself (Cloudflare D1): replicated storage, and Cloudflare can put it back
 *     to any minute of the last 30 days ("Time Travel").
 *  2. An automatic backup every night, kept outside the database (Workers KV, binding BACKUPS).
 *     History in this app only ever grows, so the backup only ever adds: every saved version
 *     of every report is written once and never again, the audit log and review history are
 *     added in blocks, and the small tables that do change (accounts, buildings, assignments…)
 *     are copied whole each night, one copy per day for 30 days and one per month for good.
 *     Photos live in photo storage (R2, binding PHOTOS) once it is switched on, and in the
 *     database until then.
 *  3. The full export an administrator downloads from Admin Control: every table, photos
 *     included, as one SQL file that loads straight back into a database.
 */
const BACKUP_TABLES = {                // table → primary key used to page through it
  buildings: 'id', qa_users: 'id', assignments: 'id', inspections: 'id', inspection_reviews: 'id',
  inspection_versions: 'id', inspection_archive: 'id', photo_blobs: 'id', notifications: 'id',
  audit_log: 'id', saved_reports: 'id', system_state: 'key',
};

async function setState(env, key, value) {
  await env.DB.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(key, JSON.stringify(value)).run();
}
async function getState(env, key) {
  const row = await env.DB.prepare('SELECT value, updated_at FROM system_state WHERE key = ?1').bind(key).first();
  if (!row) return null;
  try { return { ...JSON.parse(row.value), updatedAt: row.updated_at }; } catch { return null; }
}

async function gzipText(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** One night's work, in small steps so it stays well inside Cloudflare's per-run limits. Each
 *  step moves a cursor forward only after its copy is written, so a run that stops half way,
 *  or has more to do than one run allows, simply carries on the next time. */
async function runBackup(env, trigger) {
  const started = Date.now();
  const status = { ok: false, trigger, startedAt: new Date(started).toISOString() };
  try {
    if (!env.BACKUPS) throw new Error('backup storage is not connected (KV binding BACKUPS)');
    const kv = env.BACKUPS;
    const day = new Date().toISOString().slice(0, 10);
    const pad = (n) => String(n).padStart(10, '0');
    let writes = 0;

    // 1. Older reports: file their inline photos, then record their current state as version 1.
    status.photosFiled = await externalizeLegacyPhotos(env, 4);
    status.baselines = await recordBaselines(env);
    // 2. With photo storage switched on, photos still kept in the database move there.
    status.photosMovedToStorage = env.PHOTOS ? await movePhotosToStorage(env, 10) : 0;

    // 3. Every saved version, in blocks, written once and never again.
    const cur = (await getState(env, 'backup.cursor')) || {};
    let vAfter = Number(cur.versions) || 0, versions = 0;
    for (let page = 0; page < 3; page += 1) {
      const { results } = await env.DB.prepare('SELECT * FROM inspection_versions WHERE id > ?1 ORDER BY id LIMIT 60').bind(vAfter).all();
      if (!results?.length) break;
      const last = results[results.length - 1].id;
      await kv.put(`versions/${pad(results[0].id)}-${pad(last)}.json.gz`, await gzipText(JSON.stringify(results)));
      vAfter = last; versions += results.length; writes += 1;
    }
    cur.versions = vAfter;

    // 4. Audit log and review history, the same way.
    const blocks = {};
    for (const [table, key] of [['audit_log', 'audit'], ['inspection_reviews', 'reviews']]) {
      let after = Number(cur[key]) || 0, n = 0;
      for (let page = 0; page < 2; page += 1) {
        const { results } = await env.DB.prepare(`SELECT * FROM ${table} WHERE id > ?1 ORDER BY id LIMIT 500`).bind(after).all();
        if (!results?.length) break;
        const last = results[results.length - 1].id;
        await kv.put(`${key}/${pad(results[0].id)}-${pad(last)}.json.gz`, await gzipText(JSON.stringify(results)));
        after = last; n += results.length; writes += 1;
      }
      cur[key] = after; blocks[key] = n;
    }
    await setState(env, 'backup.cursor', cur);

    // 5. The tables that change, whole, as tonight's copy, with the list of live and archived
    //    reports and the version each is at (the versions themselves are in versions/…).
    const snapshot = { format: 'facility-qa-daily', version: 2, createdAt: new Date().toISOString(), tables: {} };
    for (const table of ['qa_users', 'buildings', 'assignments', 'notifications', 'saved_reports', 'system_state']) {
      const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
      snapshot.tables[table] = results || [];
    }
    const live = await env.DB.prepare(
      'SELECT i.id, i.updated_at, (SELECT MAX(v.version) FROM inspection_versions v WHERE v.inspection_id = i.id) AS version FROM inspections i',
    ).all();
    const gone = await env.DB.prepare('SELECT id, deleted_at, deleted_by_name FROM inspection_archive').all();
    const photos = await env.DB.prepare("SELECT id, mime, bytes, first_inspection_id, created_at, data = '' AS in_storage FROM photo_blobs").all();
    snapshot.tables.inspections_index = live.results || [];
    snapshot.tables.archive_index = gone.results || [];
    snapshot.tables.photo_index = photos.results || [];
    await kv.put(`daily/${day}.json.gz`, await gzipText(JSON.stringify(snapshot)));
    writes += 1;

    // 6. Daily copies: the last 30 days, and the first of every month for good.
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    let removed = 0, listed = await kv.list({ prefix: 'daily/' });
    for (;;) {
      for (const k of listed.keys) {
        const d = k.name.slice(6, 16);
        if (d < cutoff && !d.endsWith('-01')) { await kv.delete(k.name); removed += 1; }
      }
      if (listed.list_complete) break;
      listed = await kv.list({ prefix: 'daily/', cursor: listed.cursor });
    }

    const waiting = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM inspection_versions WHERE id > ?1) AS versions,
              (SELECT COUNT(*) FROM inspections WHERE instr(data, '"data:image/') > 0) AS legacy`,
    ).bind(vAfter).first();
    Object.assign(status, {
      ok: true, finishedAt: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 100) / 10,
      day, versionsCopied: versions, versionsWaiting: waiting.versions, legacyWaiting: waiting.legacy,
      auditRows: blocks.audit, reviewRows: blocks.reviews, writes, oldDailyCopiesRemoved: removed,
      photoStorage: !!env.PHOTOS, reports: (live.results || []).length, archived: (gone.results || []).length, photos: (photos.results || []).length,
    });
  } catch (err) {
    status.error = String(err?.message || err);
    status.finishedAt = new Date().toISOString();
  }
  await setState(env, 'backup.last', status).catch(() => {});
  if (status.ok) await setState(env, 'backup.lastOk', status).catch(() => {});
  return status;
}

/** Reports saved before photos had their own storage: file a few reports' photos per call. The
 *  report's saved time is left alone, so its review status does not change. */
async function externalizeLegacyPhotos(env, limit) {
  const { results } = await env.DB.prepare(
    "SELECT id, data FROM inspections WHERE instr(data, '\"data:image/') > 0 ORDER BY id LIMIT ?1",
  ).bind(limit).all();
  let moved = 0;
  for (const row of results || []) {
    const stored = await storeReportPhotos(env, row.data, row.id);
    if (stored.error || !stored.data) continue;
    await env.DB.prepare('UPDATE inspections SET data = ?2 WHERE id = ?1').bind(row.id, stored.data).run();
    moved += stored.stored || 0;
  }
  return moved;
}

/** Photos kept in the database move to photo storage once it is switched on. Each is written
 *  and checked there before the database copy is cleared. */
async function movePhotosToStorage(env, limit) {
  const { results } = await env.DB.prepare("SELECT id, mime, data FROM photo_blobs WHERE data != '' LIMIT ?1").bind(limit).all();
  const done = [];
  for (const p of results || []) {
    const bytes = b64ToBytes(p.data);
    await env.PHOTOS.put(photoKey(p.id), bytes, { httpMetadata: { contentType: p.mime } });
    const head = await env.PHOTOS.head(photoKey(p.id));
    if (head && head.size === bytes.length) done.push(p.id);
  }
  if (done.length) await env.DB.batch(done.map((id) => env.DB.prepare("UPDATE photo_blobs SET data = '' WHERE id = ?1").bind(id)));
  return done.length;
}

async function backupStatus(env) {
  const [last, lastOk, counts] = await Promise.all([
    getState(env, 'backup.last'), getState(env, 'backup.lastOk'),
    env.DB.prepare(`SELECT (SELECT COUNT(*) FROM inspections) AS reports, (SELECT COUNT(*) FROM inspection_archive) AS archived,
      (SELECT COUNT(*) FROM inspection_versions) AS versions, (SELECT COUNT(*) FROM photo_blobs) AS photos,
      (SELECT COALESCE(SUM(bytes),0) FROM photo_blobs) AS photoBytes,
      (SELECT COALESCE(SUM(bytes),0) FROM photo_blobs WHERE data != '') AS photoBytesInDb,
      (SELECT COUNT(*) FROM inspections WHERE instr(data, '"data:image/') > 0) AS legacyReports,
      (SELECT COUNT(*) FROM inspections i WHERE NOT EXISTS (SELECT 1 FROM inspection_versions v WHERE v.inspection_id = i.id)) AS withoutHistory,
      (SELECT COUNT(*) FROM audit_log) AS auditRows`).first(),
  ]);
  return json({ last, lastOk, counts, storage: { backups: !!env.BACKUPS, photos: !!env.PHOTOS } });
}

/** One page of one table for the full export. Photos come a few at a time (they are large). */
async function exportTablePage(env, url) {
  const table = url.searchParams.get('table') || '';
  const key = BACKUP_TABLES[table];
  if (!key) return fail('unknown table', 400);
  const after = url.searchParams.get('after');
  const limit = table === 'photo_blobs' ? 8 : table === 'inspection_versions' || table === 'inspections' || table === 'inspection_archive' ? 100 : 1000;
  const numeric = key === 'id' && !['qa_users', 'photo_blobs'].includes(table);
  const { results } = after == null || after === ''
    ? await env.DB.prepare(`SELECT * FROM ${table} ORDER BY ${key} LIMIT ?1`).bind(limit).all()
    : await env.DB.prepare(`SELECT * FROM ${table} WHERE ${key} > ?1 ORDER BY ${key} LIMIT ?2`).bind(numeric ? Number(after) : after, limit).all();
  const rows = results || [];
  if (table === 'photo_blobs' && env.PHOTOS) {
    // photos in photo storage come back into the copy, so the file stands on its own
    for (const row of rows) if (!row.data) {
      const obj = await env.PHOTOS.get(photoKey(row.id));
      if (obj) row.data = bytesToB64(new Uint8Array(await obj.arrayBuffer()));
    }
  }
  const { c } = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first();
  return json({ table, total: c, rows, next: rows.length === limit ? rows[rows.length - 1][key] : null });
}

/* ── Buildings ──────────────────────────────────────────── */

async function listBuildings(env, url, user) {
  if (url.searchParams.get('usage') === '1' && user.role === ADMIN_ROLE) {
    const { results } = await env.DB.prepare(
      `SELECT b.id, b.location, b.division, b.area, b.name, b.created_at,
              (SELECT COUNT(*) FROM assignments a WHERE a.building_id = b.id) AS assignments
       FROM buildings b ORDER BY b.division, b.area, b.name`,
    ).all();
    return json({ buildings: results || [] });
  }
  return listBuildingsBasic(env);
}

function cleanBuilding(body) {
  const out = {};
  for (const key of ['location', 'division', 'area', 'name']) out[key] = String(body?.[key] || '').trim().replace(/\s+/g, ' ');
  return Object.values(out).every(Boolean) ? out : null;
}

async function createBuilding(env, user, body) {
  const b = cleanBuilding(body);
  if (!b) return fail('location, division, area and name are all required', 400);
  const dup = await env.DB.prepare('SELECT id FROM buildings WHERE lower(name) = lower(?1)').bind(b.name).first();
  if (dup) return fail('a building with that name already exists', 409);
  const res = await env.DB.prepare('INSERT INTO buildings (location, division, area, name) VALUES (?1, ?2, ?3, ?4)')
    .bind(b.location, b.division, b.area, b.name).run();
  await audit(env, user, 'building.create', String(res.meta.last_row_id), b.name, `${b.division} · ${b.area} · ${b.location}`);
  return json({ ok: true, id: res.meta.last_row_id }, 201);
}

async function updateBuilding(env, user, id, body) {
  const b = cleanBuilding(body);
  if (!b) return fail('location, division, area and name are all required', 400);
  const cur = await env.DB.prepare('SELECT * FROM buildings WHERE id = ?1').bind(id).first();
  if (!cur) return fail('building not found', 404);
  const dup = await env.DB.prepare('SELECT id FROM buildings WHERE lower(name) = lower(?1) AND id != ?2').bind(b.name, id).first();
  if (dup) return fail('a building with that name already exists', 409);
  await env.DB.prepare('UPDATE buildings SET location = ?2, division = ?3, area = ?4, name = ?5 WHERE id = ?1')
    .bind(id, b.location, b.division, b.area, b.name).run();
  const changed = ['name', 'division', 'area', 'location'].filter((k) => cur[k] !== b[k]).map((k) => `${k}: ${cur[k]} → ${b[k]}`);
  if (changed.length) await audit(env, user, 'building.update', String(id), b.name, changed.join(' · '));
  return json({ ok: true });
}

async function deleteBuilding(env, user, id) {
  const cur = await env.DB.prepare('SELECT name FROM buildings WHERE id = ?1').bind(id).first();
  if (!cur) return fail('building not found', 404);
  const { c } = await env.DB.prepare('SELECT COUNT(*) AS c FROM assignments WHERE building_id = ?1').bind(id).first();
  if (c) return fail(`this building has ${c} assignment${c === 1 ? '' : 's'} and cannot be deleted`, 409);
  await env.DB.prepare('DELETE FROM buildings WHERE id = ?1').bind(id).run();
  await audit(env, user, 'building.delete', String(id), cur.name, null);
  return json({ ok: true });
}

async function listBuildingsBasic(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, location, division, area, name FROM buildings ORDER BY division, area, name',
  ).all();
  return json({ buildings: results || [] });
}

/* ── Assignments (Officer -> Auditor) ──────────────────────
 * A completed assignment is one an auditor reached the "Start
 * Inspection" flow for and saved -- the saved inspection carries the
 * assignment id in its JSON payload (assignmentId), so completion is
 * read straight from qa's own data rather than a status column that
 * could drift out of sync. ─────────────────────────────────── */

const ASSIGNMENT_TYPES = new Set(['BOQI', 'EOQI']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** '' or null clears the deadline; anything else must be a real calendar date. */
function dueDateOf(value) {
  if (value == null || value === '') return { ok: true, value: null };
  const text = String(value).trim();
  if (!DATE_RE.test(text)) return { ok: false };
  const d = new Date(text + 'T12:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text) return { ok: false };
  return { ok: true, value: text };
}

async function completedAssignmentIds(env) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT CAST(json_extract(data, '$.assignmentId') AS INTEGER) as assignment_id
     FROM inspections WHERE json_extract(data, '$.assignmentId') IS NOT NULL`,
  ).all();
  return new Set((results || []).map((r) => r.assignment_id));
}

async function isAssignmentCompleted(env, assignmentId) {
  const row = await env.DB.prepare(
    "SELECT 1 AS x FROM inspections WHERE CAST(json_extract(data, '$.assignmentId') AS INTEGER) = ?1 LIMIT 1",
  ).bind(assignmentId).first();
  return !!row;
}

async function listAuditors(env, actor) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM qa_users WHERE status = 'active' ORDER BY name",
  ).all();
  const auditors = (results || []).filter((u) => !assigneeProblem(actor, u))
    .map((u) => ({ id: u.id, name: u.name, username: u.username, role: u.role }));
  return json({ auditors });
}

async function listAssignmentBoard(env, quarter, type) {
  const { results: buildings } = await env.DB.prepare(
    'SELECT id, location, division, area, name FROM buildings ORDER BY division, area, name',
  ).all();
  const { results: assignmentRows } = await env.DB.prepare(
    `SELECT a.id, a.building_id, a.auditor_id, u.name as auditor_name
     FROM assignments a JOIN qa_users u ON u.id = a.auditor_id
     WHERE a.quarter = ?1 AND a.type = ?2`,
  ).bind(quarter, type).all();
  const byBuilding = new Map((assignmentRows || []).map((a) => [a.building_id, a]));
  const completedIds = await completedAssignmentIds(env);

  const board = (buildings || []).map((b) => {
    const a = byBuilding.get(b.id);
    return {
      buildingId: b.id, location: b.location, division: b.division, area: b.area, name: b.name,
      assignmentId: a ? a.id : null,
      auditorId: a ? a.auditor_id : null,
      auditorName: a ? a.auditor_name : null,
      completed: a ? completedIds.has(a.id) : false,
    };
  });
  const total = board.length;
  const completed = board.filter((b) => b.completed).length;
  const assigned = board.filter((b) => b.assignmentId).length;

  const byAuditor = new Map();
  for (const a of assignmentRows || []) {
    const entry = byAuditor.get(a.auditor_id) || { auditorId: a.auditor_id, auditorName: a.auditor_name, count: 0, completed: 0 };
    entry.count += 1;
    if (completedIds.has(a.id)) entry.completed += 1;
    byAuditor.set(a.auditor_id, entry);
  }
  const auditorCounts = [...byAuditor.values()].sort((x, y) => y.count - x.count);

  return json({ quarter, type, board, summary: { total, assigned, completed }, auditorCounts });
}

async function upsertAssignment(env, officer, body) {
  const buildingId = Number(body?.buildingId);
  const auditorId = body?.auditorId;
  const quarter = (body?.quarter || '').trim();
  const type = body?.type;
  if (!buildingId || !auditorId || !quarter || !ASSIGNMENT_TYPES.has(type)) {
    return fail('buildingId, auditorId, quarter, and a valid type (BOQI/EOQI) are required', 400);
  }
  const due = 'dueDate' in (body || {}) ? dueDateOf(body.dueDate) : null;
  if (due && !due.ok) return fail('a deadline must be a date like 2026-09-30', 400);
  const assignee = await env.DB.prepare('SELECT * FROM qa_users WHERE id = ?1').bind(auditorId).first();
  const problem = assigneeProblem(officer, assignee);
  if (problem) return fail(problem[1], problem[0]);
  const building = await env.DB.prepare('SELECT id, name FROM buildings WHERE id = ?1').bind(buildingId).first();
  if (!building) return fail('building not found', 404);

  const existing = await env.DB.prepare(
    'SELECT id, auditor_id FROM assignments WHERE building_id = ?1 AND quarter = ?2 AND type = ?3',
  ).bind(buildingId, quarter, type).first();
  if (existing && existing.auditor_id !== auditorId && await isAssignmentCompleted(env, existing.id)) {
    return fail('this building was already inspected for that quarter, so its auditor cannot change', 409);
  }

  await env.DB.prepare(
    `INSERT INTO assignments (building_id, auditor_id, quarter, type, assigned_by, due_date)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(building_id, quarter, type)
     DO UPDATE SET auditor_id = excluded.auditor_id, assigned_by = excluded.assigned_by, updated_at = datetime('now')${due ? ', due_date = excluded.due_date' : ''}`,
  ).bind(buildingId, auditorId, quarter, type, officer.id, due ? due.value : null).run();

  if ((!existing || existing.auditor_id !== auditorId) && auditorId !== officer.id) {
    await notify(
      env, auditorId, 'assignment',
      `New assignment: ${building.name}`,
      `${officer.name} assigned you ${building.name} for ${quarter} ${type}.`,
      '#pg-auditor',
    );
  }

  return json({ ok: true });
}

async function deleteAssignment(env, id) {
  if (await isAssignmentCompleted(env, id)) {
    return fail('this assignment is already completed and cannot be removed', 409);
  }
  const res = await env.DB.prepare('DELETE FROM assignments WHERE id = ?1').bind(id).run();
  if (!res.meta.changes) return fail('assignment not found', 404);
  return json({ ok: true });
}

/* ── Quality Officer: board with live progress ─────────────
 * Every building for one quarter + type with its assignment and, once an
 * auditor has submitted it, the result. Per-auditor numbers are rolled up
 * in the browser so the division filter applies without another request. */

const QUARTER_RE = /^\d{4}-Q[1-4]$/;

/** Every building for one quarter and type: who holds it, and what came back. */
async function quarterBoard(env, quarter, type) {
  const [b, a, u, i] = await Promise.all([
    env.DB.prepare('SELECT id, location, division, area, name FROM buildings ORDER BY division, area, name').all(),
    env.DB.prepare('SELECT id, building_id, auditor_id, quarter, type, assigned_by, due_date, created_at, updated_at FROM assignments').all(),
    env.DB.prepare('SELECT id, name, role, status, can_edit, can_delete, can_export, permissions FROM qa_users').all(),
    env.DB.prepare(
      `SELECT id, inspector, date, overall, created_at, CAST(json_extract(data, '$.assignmentId') AS INTEGER) AS assignment_id
       FROM inspections WHERE json_extract(data, '$.assignmentId') IS NOT NULL ORDER BY id`,
    ).all(),
  ]);
  const users = new Map((u.results || []).map((x) => [x.id, x]));
  const assignments = a.results || [];

  // First submission marks completion time; the latest one carries the current score.
  const results = new Map();
  for (const row of i.results || []) {
    const prev = results.get(row.assignment_id);
    results.set(row.assignment_id, {
      completedAt: prev ? prev.completedAt : row.created_at,
      score: typeof row.overall === 'number' ? Math.round(row.overall) : (prev ? prev.score : null),
      inspector: row.inspector, date: row.date, submissions: (prev ? prev.submissions : 0) + 1, inspectionId: row.id,
    });
  }

  const inPeriod = assignments.filter((x) => x.quarter === quarter && x.type === type);
  const byBuilding = new Map(inPeriod.map((x) => [x.building_id, x]));
  const buildings = (b.results || []).map((x) => {
    const asg = byBuilding.get(x.id);
    const res = asg ? results.get(asg.id) : null;
    return {
      buildingId: x.id, name: x.name, location: x.location, division: x.division, area: x.area,
      assignmentId: asg ? asg.id : null,
      auditorId: asg ? asg.auditor_id : null,
      auditorName: asg ? (users.get(asg.auditor_id)?.name || null) : null,
      assignedBy: asg ? (users.get(asg.assigned_by)?.name || null) : null,
      assignedAt: asg ? asg.updated_at : null,
      dueDate: asg ? (asg.due_date || null) : null,
      status: !asg ? 'unassigned' : res ? 'completed' : 'pending',
      score: res ? res.score : null,
      completedAt: res ? res.completedAt : null,
      inspectionDate: res ? res.date : null,
      inspector: res ? res.inspector : null,
      inspectionId: res ? res.inspectionId : null,
    };
  });
  const boardReviews = await reviewStateFor(env, buildings.map((b) => b.inspectionId));
  for (const b of buildings) b.review = b.inspectionId ? (boardReviews.get(b.inspectionId) || { status: 'pending' }) : null;
  return { buildings, assignments, users, results, inPeriod };
}

async function officerBoard(env, viewer, url) {
  const quarter = url.searchParams.get('quarter') || '';
  const type = url.searchParams.get('type') || '';
  if (!QUARTER_RE.test(quarter) || !ASSIGNMENT_TYPES.has(type)) {
    return fail('quarter (YYYY-Qn) and a valid type (BOQI/EOQI) are required', 400);
  }
  const { buildings, assignments, users, results, inPeriod } = await quarterBoard(env, quarter, type);

  // Auditors: everyone active, plus suspended ones still holding work this period.
  const openElsewhere = new Map();
  for (const x of assignments) {
    if ((x.quarter === quarter && x.type === type) || results.has(x.id)) continue;
    openElsewhere.set(x.auditor_id, (openElsewhere.get(x.auditor_id) || 0) + 1);
  }
  // Everyone this viewer may give buildings to, plus anyone already holding some this period.
  const holding = new Set(inPeriod.map((x) => x.auditor_id));
  const auditors = [...users.values()]
    .filter((x) => ASSIGNEE_ROLES.has(x.role) && ((x.status === 'active' && canAssignTo(viewer, x)) || holding.has(x.id)))
    .map((x) => ({
      id: x.id, name: x.name, status: x.status, role: x.role, openElsewhere: openElsewhere.get(x.id) || 0,
      assignable: !assigneeProblem(viewer, x),
    }))
    .sort((x, y) => (x.role === 'quality_auditor' ? 0 : 1) - (y.role === 'quality_auditor' ? 0 : 1) || x.name.localeCompare(y.name));

  const events = [
    ...inPeriod.map((x) => ({
      kind: 'assigned', at: x.updated_at, buildingId: x.building_id,
      actor: users.get(x.assigned_by)?.name || 'Someone', auditor: users.get(x.auditor_id)?.name || 'an auditor',
    })),
    ...inPeriod.filter((x) => results.has(x.id)).map((x) => ({
      kind: 'completed', at: results.get(x.id).completedAt, buildingId: x.building_id,
      auditor: users.get(x.auditor_id)?.name || 'an auditor', score: results.get(x.id).score,
    })),
  ].filter((x) => x.at).sort((x, y) => (y.at > x.at ? 1 : y.at < x.at ? -1 : 0)).slice(0, 25);

  const quarters = [...new Set(assignments.map((x) => x.quarter))].sort().reverse();
  return json({ quarter, type, quarters, buildings, auditors, events, serverTime: new Date().toISOString() });
}

/** The quarter's plan, as everyone may see it: each auditor's buildings, and the whole list. */
async function assignmentSchedule(env, quarter, type) {
  const { buildings, assignments, users, inPeriod } = await quarterBoard(env, quarter, type);
  const byAuditor = new Map();
  for (const x of inPeriod) {
    const entry = byAuditor.get(x.auditor_id) || { id: x.auditor_id, name: users.get(x.auditor_id)?.name || 'Unknown', count: 0, completed: 0 };
    entry.count += 1;
    byAuditor.set(x.auditor_id, entry);
  }
  for (const b of buildings) {
    if (b.auditorId && b.status === 'completed') byAuditor.get(b.auditorId).completed += 1;
  }
  const auditors = [...byAuditor.values()].sort((x, y) => x.name.localeCompare(y.name));
  const assigned = buildings.filter((b) => b.assignmentId).length;
  const completed = buildings.filter((b) => b.status === 'completed').length;
  const quarters = [...new Set(assignments.map((x) => x.quarter))].sort().reverse();
  return json({
    quarter, type, quarters, auditors,
    buildings: buildings.map(({ review, assignmentId, assignedBy, completedAt, ...rest }) => rest),
    totals: { buildings: buildings.length, assigned, completed, unassigned: buildings.length - assigned, auditors: auditors.length },
  });
}

/** The deadline for a set of buildings already assigned this quarter. */
async function setAssignmentDue(env, officer, body) {
  const quarter = String(body?.quarter || '').trim();
  const type = body?.type;
  const due = dueDateOf(body?.dueDate);
  const ids = [...new Set((Array.isArray(body?.buildingIds) ? body.buildingIds : [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!QUARTER_RE.test(quarter) || !ASSIGNMENT_TYPES.has(type) || !ids.length) {
    return fail('quarter (YYYY-Qn), a valid type (BOQI/EOQI) and at least one building are required', 400);
  }
  if (!due.ok) return fail('a deadline must be a date like 2026-09-30', 400);
  if (ids.length > 1000) return fail('too many buildings in one request', 400);

  const { results } = await env.DB.prepare(
    `SELECT a.id, a.building_id, a.auditor_id, b.name
     FROM assignments a JOIN buildings b ON b.id = a.building_id
     WHERE a.quarter = ?1 AND a.type = ?2 AND a.building_id IN (SELECT value FROM json_each(?3))`,
  ).bind(quarter, type, JSON.stringify(ids)).all();
  const rows = results || [];
  if (!rows.length) return json({ updated: 0, skipped: ids.length, dueDate: due.value });

  await env.DB.prepare(
    `UPDATE assignments SET due_date = ?1, updated_at = datetime('now')
     WHERE quarter = ?2 AND type = ?3 AND building_id IN (SELECT value FROM json_each(?4))`,
  ).bind(due.value, quarter, type, JSON.stringify(rows.map((r) => r.building_id))).run();

  // Tell each auditor once, not once per building.
  const byAuditor = new Map();
  for (const r of rows) byAuditor.set(r.auditor_id, (byAuditor.get(r.auditor_id) || 0) + 1);
  await Promise.all([...byAuditor.entries()].filter(([id]) => id !== officer.id).map(([id, n]) => notify(
    env, id, 'assignment',
    due.value ? `Deadline ${due.value} for ${n} building${n === 1 ? '' : 's'}` : `Deadline removed for ${n} building${n === 1 ? '' : 's'}`,
    `${quarter} · ${type} · set by ${officer.name}`, '#pg-auditor',
  )));
  await audit(env, officer, 'assignment.due', `${quarter}|${type}`, `${rows.length} buildings`, { dueDate: due.value });
  return json({ updated: rows.length, skipped: ids.length - rows.length, dueDate: due.value });
}

/* Assign (or unassign) many buildings in one go. Uses json_each so the
 * whole set is one statement regardless of D1's bound-parameter limit.
 * Buildings already inspected for the period are left untouched. */
async function bulkAssign(env, officer, body) {
  const quarter = String(body?.quarter || '').trim();
  const type = body?.type;
  const auditorId = body?.auditorId || null;
  const due = 'dueDate' in (body || {}) ? dueDateOf(body.dueDate) : null;
  const ids = [...new Set((Array.isArray(body?.buildingIds) ? body.buildingIds : [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!QUARTER_RE.test(quarter) || !ASSIGNMENT_TYPES.has(type) || !ids.length) {
    return fail('quarter (YYYY-Qn), a valid type (BOQI/EOQI) and at least one building are required', 400);
  }
  if (ids.length > 1000) return fail('too many buildings in one request', 400);
  if (due && !due.ok) return fail('a deadline must be a date like 2026-09-30', 400);

  let auditor = null;
  if (auditorId) {
    auditor = await env.DB.prepare('SELECT * FROM qa_users WHERE id = ?1').bind(auditorId).first();
    const problem = assigneeProblem(officer, auditor);
    if (problem) return fail(problem[1], problem[0]);
  }

  const [{ results: buildingRows }, { results: existingRows }, completedIds] = await Promise.all([
    env.DB.prepare('SELECT id, name FROM buildings').all(),
    env.DB.prepare('SELECT id, building_id, auditor_id FROM assignments WHERE quarter = ?1 AND type = ?2').bind(quarter, type).all(),
    completedAssignmentIds(env),
  ]);
  const buildingName = new Map((buildingRows || []).map((x) => [x.id, x.name]));
  const existing = new Map((existingRows || []).map((x) => [x.building_id, x]));

  let skippedCompleted = 0, unchanged = 0, notFound = 0;
  const change = [];
  for (const id of ids) {
    if (!buildingName.has(id)) { notFound += 1; continue; }
    const cur = existing.get(id);
    if (cur && completedIds.has(cur.id)) { skippedCompleted += 1; continue; }
    if (auditor ? cur && cur.auditor_id === auditor.id && !due : !cur) { unchanged += 1; continue; }
    change.push(id);
  }

  if (change.length && auditor) {
    await env.DB.prepare(
      `INSERT INTO assignments (building_id, auditor_id, quarter, type, assigned_by, due_date)
       SELECT CAST(value AS INTEGER), ?2, ?3, ?4, ?5, ?6 FROM json_each(?1) WHERE true
       ON CONFLICT(building_id, quarter, type)
       DO UPDATE SET auditor_id = excluded.auditor_id, assigned_by = excluded.assigned_by,
         updated_at = datetime('now')${due ? ', due_date = excluded.due_date' : ''}`,
    ).bind(JSON.stringify(change), auditor.id, quarter, type, officer.id, due ? due.value : null).run();
    const names = change.map((id) => buildingName.get(id));
    const list = names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
    if (auditor.id !== officer.id) await notify(
      env, auditor.id, 'assignment',
      change.length === 1 ? `New assignment: ${names[0]}` : `${change.length} new assignments`,
      `${officer.name} assigned you ${list} for ${quarter} ${type}.${due && due.value ? ` Due ${due.value}.` : ''}`,
      '#pg-auditor',
    );
  } else if (change.length) {
    await env.DB.prepare(
      `DELETE FROM assignments WHERE quarter = ?2 AND type = ?3
       AND building_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?1))`,
    ).bind(JSON.stringify(change), quarter, type).run();
  }

  return json({ ok: true, changed: change.length, unchanged, skippedCompleted, notFound });
}

/* ── Auditor profile ───────────────────────────────────────
 * One view of an auditor's work, used both by the auditor ("My Assignments")
 * and by officers, leaders and admins looking at any auditor: the quarter's
 * buildings, work carried over, next quarter, and all-time performance —
 * results by quarter, turnaround, section averages and the items most often
 * marked non-compliant (read from the latest submission per assignment). */

const nextQuarterOf = (q) => {
  let y = Number(q.slice(0, 4)), n = Number(q.slice(-1)) + 1;
  if (n > 4) { n = 1; y += 1; }
  return `${y}-Q${n}`;
};
const daysBetween = (a, b) => (new Date(b.replace(' ', 'T') + 'Z') - new Date(a.replace(' ', 'T') + 'Z')) / 86400000;

async function auditorProfile(env, viewer, url) {
  const quarter = url.searchParams.get('quarter') || '';
  if (!QUARTER_RE.test(quarter)) return fail('quarter (YYYY-Qn) is required', 400);
  const requested = url.searchParams.get('auditorId') || viewer.id;
  const isSelf = requested === viewer.id;
  if (!isSelf && !can(viewer, 'profiles')) return fail('you can only view your own assignments', 403);

  const auditor = await env.DB.prepare(
    "SELECT id, name, username, status, role FROM qa_users WHERE id = ?1",
  ).bind(requested).first();
  if (!auditor || (!isSelf && !ASSIGNEE_ROLES.has(auditor.role))) return fail('person not found', 404);

  const [a, i, team] = await Promise.all([
    env.DB.prepare(
      `SELECT a.id, a.quarter, a.type, a.building_id, a.updated_at, a.due_date, b.name AS building_name, b.division, b.area, b.location, o.name AS assigned_by
       FROM assignments a JOIN buildings b ON b.id = a.building_id LEFT JOIN qa_users o ON o.id = a.assigned_by
       WHERE a.auditor_id = ?1 ORDER BY b.division, b.area, b.name`,
    ).bind(auditor.id).all(),
    env.DB.prepare(
      `SELECT id, inspector, date, overall, created_at, CAST(json_extract(data, '$.assignmentId') AS INTEGER) AS assignment_id
       FROM inspections WHERE CAST(json_extract(data, '$.assignmentId') AS INTEGER) IN (SELECT id FROM assignments WHERE auditor_id = ?1)
       ORDER BY id`,
    ).bind(auditor.id).all(),
    can(viewer, 'profiles')
      ? env.DB.prepare(
        `SELECT u.id, u.name, u.status, u.role FROM qa_users u
         WHERE u.role = 'quality_auditor' OR EXISTS (SELECT 1 FROM assignments x WHERE x.auditor_id = u.id)
         ORDER BY CASE WHEN u.role = 'quality_auditor' THEN 0 ELSE 1 END, u.name`,
      ).all()
      : Promise.resolve({ results: [] }),
  ]);

  const results = new Map();
  for (const row of i.results || []) {
    const prev = results.get(row.assignment_id);
    results.set(row.assignment_id, {
      completedAt: prev ? prev.completedAt : row.created_at,
      score: typeof row.overall === 'number' ? Math.round(row.overall) : (prev ? prev.score : null),
      inspectionId: row.id, date: row.date,
    });
  }
  const all = (a.results || []).map((x) => {
    const r = results.get(x.id);
    return {
      id: x.id, quarter: x.quarter, type: x.type, buildingId: x.building_id, buildingName: x.building_name,
      division: x.division, area: x.area, location: x.location, assignedBy: x.assigned_by, assignedAt: x.updated_at,
      dueDate: x.due_date || null,
      status: r ? 'completed' : 'pending', score: r ? r.score : null, completedAt: r ? r.completedAt : null,
      inspectionId: r ? r.inspectionId : null, inspectionDate: r ? r.date : null,
    };
  });
  const assignmentReviews = await reviewStateFor(env, all.map((x) => x.inspectionId));
  for (const x of all) x.review = x.inspectionId ? (assignmentReviews.get(x.inspectionId) || { status: 'pending' }) : null;
  const done = all.filter((x) => x.status === 'completed');

  // Performance, all quarters
  const quarters = [...new Set(all.map((x) => x.quarter))].sort();
  const byQuarter = quarters.map((q) => {
    const inQ = all.filter((x) => x.quarter === q);
    const scores = inQ.map((x) => x.score).filter((n) => typeof n === 'number');
    return { quarter: q, assigned: inQ.length, completed: inQ.filter((x) => x.status === 'completed').length, avgScore: average(scores) };
  });
  const byType = Object.fromEntries(['BOQI', 'EOQI'].map((t) => {
    const scores = done.filter((x) => x.type === t).map((x) => x.score).filter((n) => typeof n === 'number');
    return [t, { completed: done.filter((x) => x.type === t).length, avgScore: average(scores) }];
  }));
  const turnarounds = done.filter((x) => x.assignedAt && x.completedAt)
    .map((x) => Math.max(0, daysBetween(x.assignedAt, x.completedAt)));

  const latestIds = JSON.stringify(done.map((x) => x.inspectionId));
  const [sec, find] = done.length ? await Promise.all([
    env.DB.prepare(
      `SELECT json_extract(s.value, '$.title') AS title,
              AVG(CAST(json_extract(s.value, '$.score') AS REAL) * 10.0 / NULLIF(CAST(json_extract(s.value, '$.max') AS REAL), 0)) AS avg10,
              COUNT(*) AS n
       FROM inspections i, json_each(i.data, '$.sections') s
       WHERE i.id IN (SELECT value FROM json_each(?1))
       GROUP BY title`,
    ).bind(latestIds).all(),
    env.DB.prepare(
      `SELECT json_extract(s.value, '$.title') AS section, json_extract(it.value, '$.label') AS item, COUNT(*) AS count
       FROM inspections i, json_each(i.data, '$.sections') s, json_each(s.value, '$.items') it
       WHERE i.id IN (SELECT value FROM json_each(?1)) AND json_extract(it.value, '$.score') = 0
       GROUP BY section, item ORDER BY count DESC, section, item LIMIT 10`,
    ).bind(latestIds).all(),
  ]) : [{ results: [] }, { results: [] }];

  const events = [
    ...all.map((x) => ({ kind: 'assigned', at: x.assignedAt, building: x.buildingName, quarter: x.quarter, type: x.type, actor: x.assignedBy })),
    ...done.map((x) => ({ kind: 'completed', at: x.completedAt, building: x.buildingName, quarter: x.quarter, type: x.type, score: x.score })),
  ].filter((x) => x.at).sort((x, y) => (y.at > x.at ? 1 : y.at < x.at ? -1 : 0)).slice(0, 20);

  const next = nextQuarterOf(quarter);
  return json({
    auditor: { id: auditor.id, name: auditor.name, username: auditor.username, status: auditor.status, role: auditor.role },
    assignable: ASSIGNEE_ROLES.has(auditor.role),
    isSelf, canManage: can(viewer, 'assign'),
    auditors: team.results || [],
    quarter, quarters: [...quarters].reverse(),
    assignments: all.filter((x) => x.quarter === quarter),
    carriedOver: all.filter((x) => x.status === 'pending' && x.quarter < quarter),
    upcoming: { quarter: next, total: all.filter((x) => x.quarter === next).length },
    performance: {
      assigned: all.length, completed: done.length,
      avgScore: average(done.map((x) => x.score).filter((n) => typeof n === 'number')),
      avgTurnaroundDays: turnarounds.length ? Math.round((turnarounds.reduce((t, n) => t + n, 0) / turnarounds.length) * 10) / 10 : null,
      byQuarter, byType,
      sections: (sec.results || []).filter((x) => x.title).map((x) => ({ title: x.title, avg: Math.round(x.avg10 * 10) / 10, n: x.n })),
      findings: (find.results || []).map((x) => ({ section: x.section, item: x.item, count: x.count })),
      results: [...done].sort((x, y) => (y.completedAt || '').localeCompare(x.completedAt || '')),
    },
    events,
  });
}

/* ── Quality Leader: team overview ─────────────────────────
 * One aggregate over buildings, assignments, users and inspections,
 * filtered by quarter / type / division. An inspection is tied to a
 * building through its assignment when it has one, otherwise by
 * matching the building name. Assignment completion uses every
 * inspection regardless of filters, same as the assignment board. */

function quarterOf(date) {
  const m = /^(\d{4})-(\d{2})/.exec(date || '');
  return m ? `${m[1]}-Q${Math.floor((Number(m[2]) - 1) / 3) + 1}` : null;
}
const normName = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
// One decimal everywhere, so the same average reads the same on Home, Team Overview, profiles and Analytics.
const average = (xs) => (xs.length ? Math.round((xs.reduce((sum, x) => sum + x, 0) / xs.length) * 10) / 10 : null);

async function leaderOverview(env, url) {
  const quarter = url.searchParams.get('quarter') || 'all';
  const type = url.searchParams.get('type') || 'all';
  const division = url.searchParams.get('division') || 'all';

  const [b, a, u, i] = await Promise.all([
    env.DB.prepare('SELECT id, location, division, area, name FROM buildings').all(),
    env.DB.prepare('SELECT id, building_id, auditor_id, quarter, type, assigned_by, due_date, created_at, updated_at FROM assignments').all(),
    env.DB.prepare('SELECT id, name, role, status FROM qa_users').all(),
    env.DB.prepare('SELECT id, inspector, facility, division, date, type, overall, data, created_at FROM inspections ORDER BY id').all(),
  ]);
  const buildings = b.results || [];
  const assignments = a.results || [];
  const users = u.results || [];

  const userById = new Map(users.map((x) => [x.id, x]));
  const buildingById = new Map(buildings.map((x) => [x.id, x]));
  const buildingByName = new Map(buildings.map((x) => [normName(x.name), x]));
  const assignmentById = new Map(assignments.map((x) => [x.id, x]));
  const inDivision = (d) => division === 'all' || d === division;

  const completedIds = new Set();
  const scoreByAssignment = new Map();
  const inspections = [];
  for (const row of i.results || []) {
    let extra = {};
    try { extra = JSON.parse(row.data || '{}'); } catch { extra = {}; }
    const asg = extra.assignmentId != null ? assignmentById.get(Number(extra.assignmentId)) : null;
    if (asg) {
      completedIds.add(asg.id);
      if (typeof row.overall === 'number') scoreByAssignment.set(asg.id, row.overall);
    }
    const bld = (asg && buildingById.get(asg.building_id)) || buildingByName.get(normName(row.facility)) || null;
    const q = quarterOf(row.date);
    const div = bld ? bld.division : String(row.division || '').trim();
    if (quarter !== 'all' && q !== quarter) continue;
    if (type !== 'all' && row.type !== type) continue;
    if (!inDivision(div)) continue;
    inspections.push({
      inspector: row.inspector, facility: row.facility, date: row.date, type: row.type, overall: row.overall,
      quarter: q, division: div, area: bld ? bld.area : null, buildingId: bld ? bld.id : null,
      linked: !!asg, createdAt: row.created_at,
    });
  }

  const scopedBuildings = buildings.filter((x) => inDivision(x.division));
  const scopedAssignments = assignments.filter((x) => {
    const bld = buildingById.get(x.building_id);
    return bld && inDivision(bld.division)
      && (quarter === 'all' || x.quarter === quarter) && (type === 'all' || x.type === type);
  });
  const isDone = (x) => completedIds.has(x.id);

  // Rollups by division and by area.
  const divisions = new Map();
  const areas = new Map();
  const bucket = (map, key, seed) => {
    if (!map.has(key)) map.set(key, { ...seed, buildings: 0, assignments: 0, completed: 0, inspections: 0, scores: [] });
    return map.get(key);
  };
  const groupsFor = (div, area) => [
    bucket(divisions, div, { division: div }),
    ...(area ? [bucket(areas, `${div}|${area}`, { division: div, area })] : []),
  ];
  for (const x of scopedBuildings) groupsFor(x.division, x.area).forEach((g) => { g.buildings += 1; });
  for (const x of scopedAssignments) {
    const bld = buildingById.get(x.building_id);
    groupsFor(bld.division, bld.area).forEach((g) => { g.assignments += 1; if (isDone(x)) g.completed += 1; });
  }
  for (const x of inspections) {
    if (!x.division) continue;
    groupsFor(x.division, x.area).forEach((g) => {
      g.inspections += 1;
      if (typeof x.overall === 'number') g.scores.push(x.overall);
    });
  }
  const finish = ({ scores, ...rest }) => ({ ...rest, avgScore: average(scores) });
  const byDivision = [...divisions.values()].map(finish).sort((x, y) => x.division.localeCompare(y.division));
  const byArea = [...areas.values()].map(finish)
    .sort((x, y) => x.division.localeCompare(y.division) || x.area.localeCompare(y.area));

  // Team.
  const auditors = users.filter((x) => x.role === 'quality_auditor' || scopedAssignments.some((y) => y.auditor_id === x.id)).map((x) => {
    const mine = scopedAssignments.filter((y) => y.auditor_id === x.id);
    const done = mine.filter(isDone);
    const scores = done.map((y) => scoreByAssignment.get(y.id)).filter((n) => typeof n === 'number');
    return { id: x.id, name: x.name, status: x.status, role: x.role, assigned: mine.length, completed: done.length, avgScore: average(scores) };
  }).sort((x, y) => y.assigned - x.assigned || x.name.localeCompare(y.name));

  const madeBy = new Map();
  for (const x of scopedAssignments) madeBy.set(x.assigned_by, (madeBy.get(x.assigned_by) || 0) + 1);
  const officers = users.filter((x) => x.role === 'quality_officer' || madeBy.has(x.id)).map((x) => {
    const made = scopedAssignments.filter((y) => y.assigned_by === x.id);
    return { id: x.id, name: x.name, role: x.role, status: x.status, assignmentsMade: made.length, completed: made.filter(isDone).length };
  }).sort((x, y) => y.assignmentsMade - x.assignmentsMade || x.name.localeCompare(y.name));

  // Buildings.
  const latestInspection = new Map();
  const inspectionCount = new Map();
  for (const x of inspections) {
    if (x.buildingId == null) continue;
    inspectionCount.set(x.buildingId, (inspectionCount.get(x.buildingId) || 0) + 1);
    const cur = latestInspection.get(x.buildingId);
    if (!cur || (x.date || '') >= (cur.date || '')) latestInspection.set(x.buildingId, x);
  }
  const latestAssignment = new Map();
  for (const x of scopedAssignments) {
    const cur = latestAssignment.get(x.building_id);
    if (!cur || (x.updated_at || '') > (cur.updated_at || '')) latestAssignment.set(x.building_id, x);
  }
  const byBuilding = scopedBuildings.map((x) => {
    const asg = latestAssignment.get(x.id);
    const last = latestInspection.get(x.id);
    return {
      buildingId: x.id, name: x.name, division: x.division, area: x.area, location: x.location,
      auditorName: asg ? (userById.get(asg.auditor_id)?.name || null) : null,
      status: !asg ? 'unassigned' : isDone(asg) ? 'completed' : 'pending',
      inspections: inspectionCount.get(x.id) || 0,
      lastScore: last && typeof last.overall === 'number' ? Math.round(last.overall) : null,
      lastDate: last ? last.date : null,
    };
  }).sort((x, y) => x.division.localeCompare(y.division) || x.area.localeCompare(y.area) || x.name.localeCompare(y.name));

  // Recent activity from the people below the leader.
  const activity = [
    ...scopedAssignments.map((x) => ({
      kind: 'assignment', at: x.updated_at || x.created_at,
      actor: userById.get(x.assigned_by)?.name || 'Someone',
      target: userById.get(x.auditor_id)?.name || 'an auditor',
      building: buildingById.get(x.building_id)?.name || '', quarter: x.quarter, type: x.type,
    })),
    ...inspections.map((x) => ({
      kind: 'inspection', at: x.createdAt, actor: x.inspector, building: x.facility,
      score: typeof x.overall === 'number' ? Math.round(x.overall) : null, quarter: x.quarter, type: x.type, linked: x.linked,
    })),
  ].filter((x) => x.at).sort((x, y) => (y.at > x.at ? 1 : y.at < x.at ? -1 : 0)).slice(0, 30);

  const completed = scopedAssignments.filter(isDone).length;
  const scores = inspections.map((x) => x.overall).filter((n) => typeof n === 'number');
  const summary = {
    buildings: scopedBuildings.length,
    buildingsCovered: new Set(scopedAssignments.map((x) => x.building_id)).size,
    assignments: scopedAssignments.length,
    completed,
    completionPct: scopedAssignments.length ? Math.round((completed / scopedAssignments.length) * 100) : 0,
    inspections: inspections.length,
    avgScore: average(scores),
    activeAuditors: auditors.filter((x) => x.status === 'active').length,
  };

  const quarters = [...new Set([
    ...assignments.map((x) => x.quarter),
    ...(i.results || []).map((row) => quarterOf(row.date)).filter(Boolean),
  ])].sort().reverse();
  const divisionList = [...new Set(buildings.map((x) => x.division))].sort();

  return json({
    filters: { quarter, type, division }, quarters, divisions: divisionList,
    summary, byDivision, byArea, byBuilding, auditors, officers, activity,
  });
}

/* ── Reports: filterable inspection data for every role ───
 * Returns each inspection resolved to its building (through its
 * assignment, else by building name) with per-section scores only --
 * item details and photos are left out so the payload stays small.
 * Filtering and grouping happen in the browser. */

async function reportInspections(env) {
  const [b, a, i] = await Promise.all([
    env.DB.prepare('SELECT id, location, division, area, name FROM buildings ORDER BY division, area, name').all(),
    env.DB.prepare('SELECT id, building_id FROM assignments').all(),
    env.DB.prepare('SELECT id, inspector, facility, division, date, type, overall, data FROM inspections ORDER BY date DESC, id DESC').all(),
  ]);
  const buildings = b.results || [];
  const buildingById = new Map(buildings.map((x) => [x.id, x]));
  const buildingByName = new Map(buildings.map((x) => [normName(x.name), x]));
  const assignmentBuilding = new Map((a.results || []).map((x) => [x.id, x.building_id]));

  const inspections = (i.results || []).map((row) => {
    let extra = {};
    try { extra = JSON.parse(row.data || '{}'); } catch { extra = {}; }
    const assignmentId = extra.assignmentId != null ? Number(extra.assignmentId) : null;
    const viaAssignment = assignmentId != null ? buildingById.get(assignmentBuilding.get(assignmentId)) : null;
    const bld = viaAssignment || buildingByName.get(normName(row.facility)) || null;
    const sections = Array.isArray(extra.sections)
      ? extra.sections.map((sec) => ({
        title: String(sec?.title || ''),
        score: typeof sec?.score === 'number' ? sec.score : null,
        max: typeof sec?.max === 'number' && sec.max > 0 ? sec.max : 10,
        // Item scores only (0 / 1 / 2 or null) so analysts can see which checklist items fail most.
        items: Array.isArray(sec?.items) ? sec.items.map((it) => (typeof it?.score === 'number' ? it.score : null)) : [],
      }))
      : [];
    return {
      id: row.id,
      date: row.date || '',
      quarter: quarterOf(row.date),
      type: row.type || '',
      inspector: row.inspector || '',
      building: bld ? bld.name : (row.facility || ''),
      buildingId: bld ? bld.id : null,
      division: bld ? bld.division : String(row.division || '').trim(),
      area: bld ? bld.area : null,
      location: bld ? bld.location : null,
      overall: typeof row.overall === 'number' ? row.overall : null,
      assigned: !!viaAssignment,
      sections,
    };
  });

  return json({ inspections, buildings });
}

/* ── Inspection reports: search, open and review ────────────
 * The library lists every saved inspection without loading photos: the row
 * columns plus the assignment link, resolved to its building the same way as
 * Reports. Free text matches building, auditor, division, area and location;
 * with comments=1 it also looks inside item comments and section notes using
 * SQLite's JSON functions (so photo data is never scanned as text).
 * Review status comes from the latest decision: approved / changes requested,
 * and "resubmitted" when the report was edited after that decision. */

const REVIEW_DECISIONS = new Set(['approved', 'changes_requested', 'comment']);

function reviewStatus(updatedAt, decision) {
  if (!decision) return 'pending';
  if ((updatedAt || '') > decision.created_at) return 'resubmitted';
  return decision.decision === 'approved' ? 'approved' : 'changes';
}

/** Review state for a set of reports, so boards and profiles can show it without opening anything. */
async function reviewStateFor(env, ids) {
  const list = [...new Set((ids || []).filter((x) => Number.isInteger(Number(x)) && x != null).map(Number))];
  if (!list.length) return new Map();
  const { results } = await env.DB.prepare(
    `SELECT r.inspection_id AS id, r.decision, r.reviewer_name, r.created_at, i.updated_at
     FROM inspection_reviews r JOIN inspections i ON i.id = r.inspection_id
     WHERE r.inspection_id IN (SELECT value FROM json_each(?1))
       AND r.id = (SELECT MAX(x.id) FROM inspection_reviews x WHERE x.inspection_id = r.inspection_id AND x.decision != 'comment')`,
  ).bind(JSON.stringify(list)).all();
  const map = new Map();
  for (const r of results || []) {
    map.set(r.id, { status: reviewStatus(r.updated_at, { decision: r.decision, created_at: r.created_at }), by: r.reviewer_name, at: r.created_at });
  }
  return map;
}

async function libraryContext(env) {
  const [b, a, u, d] = await Promise.all([
    env.DB.prepare('SELECT id, location, division, area, name FROM buildings').all(),
    env.DB.prepare('SELECT id, building_id, auditor_id FROM assignments').all(),
    env.DB.prepare("SELECT id, name FROM qa_users WHERE status = 'active'").all(),
    env.DB.prepare(
      `SELECT r.inspection_id, r.decision, r.comment, r.reviewer_id, r.reviewer_name, r.created_at FROM inspection_reviews r
       WHERE r.id = (SELECT MAX(x.id) FROM inspection_reviews x WHERE x.inspection_id = r.inspection_id AND x.decision != 'comment')`,
    ).all(),
  ]);
  const buildings = b.results || [];
  return {
    buildingById: new Map(buildings.map((x) => [x.id, x])),
    buildingByName: new Map(buildings.map((x) => [normName(x.name), x])),
    assignment: new Map((a.results || []).map((x) => [x.id, x])),
    users: u.results || [],
    decision: new Map((d.results || []).map((x) => [x.inspection_id, x])),
  };
}

function libraryRow(row, ctx) {
  const asg = row.aid != null ? ctx.assignment.get(Number(row.aid)) : null;
  const bld = (asg && ctx.buildingById.get(asg.building_id)) || ctx.buildingByName.get(normName(row.facility)) || null;
  const decision = ctx.decision.get(row.id) || null;
  return {
    id: row.id, date: row.date || '', quarter: quarterOf(row.date), type: row.type || '', typeLabel: row.type_label || '',
    building: bld ? bld.name : (row.facility || ''), buildingId: bld ? bld.id : null,
    division: bld ? bld.division : String(row.division || '').trim(), area: bld ? bld.area : null, location: bld ? bld.location : null,
    auditor: row.inspector || '', auditorId: asg ? asg.auditor_id : null, inspectorId: row.inspector_id || null,
    overall: typeof row.overall === 'number' ? Math.round(row.overall) : null,
    assigned: !!asg, updatedAt: row.updated_at, createdAt: row.created_at,
    status: reviewStatus(row.updated_at, decision),
    lastDecision: decision ? { decision: decision.decision, by: decision.reviewer_name, at: decision.created_at, comment: decision.comment } : null,
  };
}

/** The report belongs to this person: they were assigned it, or it is saved under their name. */
const isOwnReport = (user, r) => (r.inspectorId ? r.inspectorId === user.id
  : r.auditorId ? r.auditorId === user.id : normName(r.auditor) === normName(user.name));
const bandOf = (v) => (v == null ? null : v >= 91 ? 'Excellent' : v >= 81 ? 'Good' : v >= 71 ? 'Acceptable' : v >= 51 ? 'Poor' : 'Critical');

async function reportLibrary(env, user, url) {
  const p = url.searchParams;
  const q = (p.get('q') || '').trim().slice(0, 100);
  const inComments = p.get('comments') === '1' && q.length >= 2;
  const f = (k) => (p.get(k) || '').trim();
  const limit = Math.min(Math.max(Number(p.get('limit') ?? 50) || 0, 0), 200);
  const offset = Math.max(Number(p.get('offset')) || 0, 0);

  const [ctx, ins] = await Promise.all([
    libraryContext(env),
    env.DB.prepare(
      `SELECT id, inspector, inspector_id, facility, division, date, type, type_label, overall, created_at, updated_at,
              CAST(json_extract(data, '$.assignmentId') AS INTEGER) AS aid
       FROM inspections WHERE json_valid(data) ORDER BY date DESC, id DESC`,
    ).all(),
  ]);
  const all = (ins.results || []).map((row) => libraryRow(row, ctx));

  // Words in comments / notes (only when asked, and only as plain text via LIKE with escaping).
  const snippets = new Map();
  if (inComments) {
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const { results } = await env.DB.prepare(
      `SELECT i.id AS id, json_extract(s.value, '$.title') AS section, json_extract(it.value, '$.label') AS item, json_extract(it.value, '$.comment') AS text
       FROM inspections i, json_each(i.data, '$.sections') s, json_each(s.value, '$.items') it
       WHERE json_valid(i.data) AND json_extract(it.value, '$.comment') LIKE ?1 ESCAPE '\\'
       UNION ALL
       SELECT i.id, json_extract(s.value, '$.title'), 'Section notes', json_extract(s.value, '$.notes')
       FROM inspections i, json_each(i.data, '$.sections') s
       WHERE json_valid(i.data) AND json_extract(s.value, '$.notes') LIKE ?1 ESCAPE '\\'`,
    ).bind(like).all();
    for (const r of results || []) if (!snippets.has(r.id)) snippets.set(r.id, { section: r.section, item: r.item, text: r.text });
  }

  const needle = q.toLowerCase();
  const textHit = (r) => !needle || [r.building, r.auditor, r.division, r.area, r.location, r.typeLabel, r.type, String(r.id)]
    .some((v) => String(v || '').toLowerCase().includes(needle)) || snippets.has(r.id);
  const base = all.filter((r) => textHit(r)
    && (!f('quarter') || r.quarter === f('quarter'))
    && (!f('year') || (r.quarter || '').startsWith(f('year') + '-'))
    && (!f('type') || r.type === f('type'))
    && (!f('division') || r.division === f('division'))
    && (!f('area') || r.area === f('area'))
    && (!f('auditor') || r.auditor === f('auditor'))
    && (!f('rating') || bandOf(r.overall) === f('rating'))
    && (!f('from') || r.date >= f('from'))
    && (!f('to') || r.date <= f('to'))
    && (f('mine') !== '1' || isOwnReport(user, r)));

  const counts = { all: base.length, pending: 0, resubmitted: 0, changes: 0, approved: 0 };
  base.forEach((r) => { counts[r.status] += 1; });
  const status = f('status');
  let list = status === 'review' ? base.filter((r) => r.status === 'pending' || r.status === 'resubmitted')
    : status ? base.filter((r) => r.status === status) : base;

  const sort = f('sort') || 'newest';
  const byDate = (a, b) => a.date.localeCompare(b.date) || a.id - b.id;
  list = [...list].sort(
    sort === 'oldest' ? byDate
      : sort === 'high' ? (a, b) => (b.overall ?? -1) - (a.overall ?? -1) || byDate(b, a)
        : sort === 'low' ? (a, b) => (a.overall ?? 101) - (b.overall ?? 101) || byDate(b, a)
          : sort === 'building' ? (a, b) => a.building.localeCompare(b.building) || byDate(b, a)
            : (a, b) => byDate(b, a),
  );

  const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  // Whole-archive figures for Home (independent of search and filters).
  const scored = all.map((r) => r.overall).filter((v) => typeof v === 'number');
  const currentQuarter = quarterOf(new Date().toISOString().slice(0, 10));
  // Where the highest and the lowest score were given — the most recent report on a tie.
  const pick = (better) => all.filter((r) => typeof r.overall === 'number')
    .reduce((b, r) => (!b || better(r, b) ? r : b), null);
  const brief = (r) => (r ? { id: r.id, score: r.overall, building: r.building, division: r.division, area: r.area, date: r.date } : null);
  const best = pick((r, b) => r.overall > b.overall || (r.overall === b.overall && byDate(r, b) > 0));
  const worst = pick((r, b) => r.overall < b.overall || (r.overall === b.overall && byDate(r, b) > 0));
  const overview = {
    count: all.length, avg: average(scored), max: scored.length ? Math.max(...scored) : null,
    best: brief(best), worst: brief(worst),
    currentQuarter, currentQuarterCount: all.filter((r) => r.quarter === currentQuarter).length,
  };
  return json({
    overview,
    total: list.length, offset, limit,
    rows: list.slice(offset, offset + limit).map((r) => ({ ...r, own: isOwnReport(user, r), snippet: snippets.get(r.id) || null })),
    counts,
    facets: {
      quarters: uniq(all.map((r) => r.quarter)).reverse(),
      divisions: uniq(all.map((r) => r.division)),
      areas: uniq(all.filter((r) => !f('division') || r.division === f('division')).map((r) => r.area)),
      auditors: uniq(all.map((r) => r.auditor)),
    },
    canReview: can(user, 'review'),
  });
}

async function getInspectionForReview(env, user, id) {
  const row = await env.DB.prepare('SELECT * FROM inspections WHERE id = ?1').bind(id).first();
  if (!row) return fail('record not found', 404);
  const ctx = await libraryContext(env);
  let aid = null;
  try { aid = JSON.parse(row.data || '{}').assignmentId ?? null; } catch { aid = null; }
  const summary = libraryRow({ ...row, aid }, ctx);
  const { results } = await env.DB.prepare(
    'SELECT id, reviewer_id, reviewer_name, decision, comment, created_at FROM inspection_reviews WHERE inspection_id = ?1 ORDER BY id DESC',
  ).bind(id).all();
  const own = isOwnReport(user, summary);
  return json({
    record: rowToRecord(row), summary: { ...summary, own },
    reviews: (results || []).map((r) => ({ id: r.id, by: r.reviewer_name, byId: r.reviewer_id, decision: r.decision, comment: r.comment, at: r.created_at })),
    canReview: can(user, 'review') && !own,
    reviewBlockedReason: own ? 'own' : !can(user, 'review') ? 'permission' : null,
  });
}

async function reviewInspection(env, user, id, body) {
  if (!can(user, 'review')) return fail('you do not have permission to review reports', 403);
  const decision = body?.decision;
  const comment = String(body?.comment || '').trim();
  if (!REVIEW_DECISIONS.has(decision)) return fail('choose approve, request changes or comment', 400);
  if (decision !== 'approved' && !comment) return fail(decision === 'comment' ? 'write a comment first' : 'explain what needs to change', 400);
  if (comment.length > 2000) return fail('keep the comment under 2000 characters', 400);
  const row = await env.DB.prepare('SELECT * FROM inspections WHERE id = ?1').bind(id).first();
  if (!row) return fail('record not found', 404);
  const ctx = await libraryContext(env);
  let aid = null;
  try { aid = JSON.parse(row.data || '{}').assignmentId ?? null; } catch { aid = null; }
  const summary = libraryRow({ ...row, aid }, ctx);
  if (isOwnReport(user, summary)) return fail('you cannot review your own report', 403);

  await env.DB.prepare('INSERT INTO inspection_reviews (inspection_id, reviewer_id, reviewer_name, decision, comment) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(id, user.id, user.name, decision, comment || null).run();
  const label = `${summary.building} · ${summary.date}${summary.type ? ' ' + summary.type : ''}`;
  await audit(env, user, 'inspection.review', String(id), label,
    `${decision === 'approved' ? 'Approved' : decision === 'changes_requested' ? 'Changes requested' : 'Comment'}${comment ? ': ' + comment.slice(0, 200) : ''}`);

  // Tell the auditor: the assigned account, or the single active account with the report's name.
  const byName = ctx.users.filter((x) => normName(x.name) === normName(summary.auditor));
  const recipient = summary.auditorId || (byName.length === 1 ? byName[0].id : null);
  if (recipient && recipient !== user.id) {
    const title = decision === 'approved' ? `Report approved: ${summary.building}`
      : decision === 'changes_requested' ? `Changes requested: ${summary.building}` : `New comment: ${summary.building}`;
    await notify(env, recipient, 'review', title,
      `${user.name}${comment ? ': ' + comment.slice(0, 180) : ' approved your report'}`, `#pg-library/${id}`);
  }
  const fresh = await env.DB.prepare('SELECT updated_at FROM inspections WHERE id = ?1').bind(id).first();
  const latest = decision === 'comment' ? ctx.decision.get(id) : { decision, created_at: new Date().toISOString().replace('T', ' ').slice(0, 19) };
  return json({ ok: true, status: reviewStatus(fresh?.updated_at, latest) }, 201);
}

/* ── Saved reports ─────────────────────────────────────────
 * A named Report Builder setup (filters, grouping, sort, chart choices).
 * Private to its owner unless shared with everyone who can view reports. */

async function listSavedReports(env, user) {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.owner_id, r.name, r.config, r.shared, r.updated_at, u.name AS owner_name
     FROM saved_reports r LEFT JOIN qa_users u ON u.id = r.owner_id
     WHERE r.owner_id = ?1 OR r.shared = 1 ORDER BY lower(r.name)`,
  ).bind(user.id).all();
  const reports = (results || []).map((r) => {
    let config = {};
    try { config = JSON.parse(r.config); } catch { config = {}; }
    return {
      id: r.id, name: r.name, config, shared: !!r.shared, updatedAt: r.updated_at,
      owner: r.owner_name || 'Former member', mine: r.owner_id === user.id,
      canDelete: r.owner_id === user.id || user.role === ADMIN_ROLE,
    };
  });
  return json({ reports });
}

async function saveReport(env, user, body) {
  const name = String(body?.name || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 80) return fail('give the report a name of up to 80 characters', 400);
  if (!body?.config || typeof body.config !== 'object' || Array.isArray(body.config)) return fail('config is required', 400);
  const config = JSON.stringify(body.config);
  if (config.length > 8000) return fail('that report setup is too large to save', 400);
  const shared = body.shared ? 1 : 0;
  // Saving under a name you already use updates that report instead of creating a copy.
  const existing = await env.DB.prepare('SELECT id FROM saved_reports WHERE owner_id = ?1 AND lower(name) = lower(?2)')
    .bind(user.id, name).first();
  if (existing) {
    await env.DB.prepare("UPDATE saved_reports SET config = ?2, shared = ?3, updated_at = datetime('now') WHERE id = ?1")
      .bind(existing.id, config, shared).run();
    return json({ ok: true, id: existing.id, updated: true });
  }
  const res = await env.DB.prepare('INSERT INTO saved_reports (owner_id, name, config, shared) VALUES (?1, ?2, ?3, ?4)')
    .bind(user.id, name, config, shared).run();
  return json({ ok: true, id: res.meta.last_row_id }, 201);
}

async function deleteSavedReport(env, user, id) {
  const row = await env.DB.prepare('SELECT owner_id FROM saved_reports WHERE id = ?1').bind(id).first();
  if (!row) return fail('saved report not found', 404);
  if (row.owner_id !== user.id && user.role !== ADMIN_ROLE) return fail('only the person who saved it can delete this report', 403);
  await env.DB.prepare('DELETE FROM saved_reports WHERE id = ?1').bind(id).run();
  return json({ ok: true });
}

async function handleAssignments(request, env, url, path, user) {
  const method = request.method.toUpperCase();
  if (!path.startsWith('assignments')) return null;

  const canManage = can(user, 'assign');
  const canView = canManage || can(user, 'team');

  if (path === 'assignments/schedule' && method === 'GET') {
    const quarter = url.searchParams.get('quarter') || '';
    const type = url.searchParams.get('type') || '';
    if (!QUARTER_RE.test(quarter) || !ASSIGNMENT_TYPES.has(type)) return fail('quarter (YYYY-Qn) and a valid type (BOQI/EOQI) are required', 400);
    return assignmentSchedule(env, quarter, type);          // the plan is for the whole team to see
  }
  if (path === 'assignments/auditors' && method === 'GET') {
    if (!canManage) return fail('you do not have permission to view this', 403);
    return listAuditors(env, user);
  }
  if (path === 'assignments' && method === 'GET') {
    if (!canView) return fail('you do not have permission to view assignments', 403);
    const quarter = url.searchParams.get('quarter') || '';
    const type = url.searchParams.get('type') || '';
    if (!quarter || !ASSIGNMENT_TYPES.has(type)) return fail('quarter and a valid type (BOQI/EOQI) are required', 400);
    return listAssignmentBoard(env, quarter, type);
  }
  if (path === 'assignments' && method === 'POST') {
    if (!canManage) return fail('you do not have permission to assign buildings', 403);
    return upsertAssignment(env, user, await request.json());
  }
  if (path === 'assignments/due' && method === 'POST') {
    if (!canManage) return fail('you do not have permission to set deadlines', 403);
    return setAssignmentDue(env, user, await request.json());
  }
  if (path === 'assignments/bulk' && method === 'POST') {
    if (!canManage) return fail('you do not have permission to assign buildings', 403);
    return bulkAssign(env, user, await request.json());
  }
  const idMatch = path.match(/^assignments\/(\d+)$/);
  if (idMatch && method === 'DELETE') {
    if (!canManage) return fail('you do not have permission to unassign buildings', 403);
    return deleteAssignment(env, Number(idMatch[1]));
  }

  return fail('not found', 404);
}

/* ── Notifications ──────────────────────────────────────── */

async function notify(env, userId, type, title, body, link) {
  await env.DB.prepare(
    `INSERT INTO notifications (user_id, type, title, body, link) VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(userId, type, title, body || null, link || null).run();
}

async function listNotifications(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT id, type, title, body, link, read_at, created_at FROM notifications
     WHERE user_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 50`,
  ).bind(userId).all();
  const notifications = (results || []).map((n) => ({
    id: n.id, type: n.type, title: n.title, body: n.body, link: n.link,
    read: !!n.read_at, createdAt: n.created_at,
  }));
  const unread = await env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?1 AND read_at IS NULL').bind(userId).first();
  return json({ notifications, unreadCount: unread?.n || 0 });
}

/** The quick check the app makes every few seconds: unread count, newest id, and anything unread since `after`. */
async function pollNotifications(env, userId, url) {
  const after = Math.max(Number(url.searchParams.get('after')) || 0, 0);
  const [counts, fresh] = await env.DB.batch([
    env.DB.prepare('SELECT SUM(read_at IS NULL) AS unread, MAX(id) AS latest FROM notifications WHERE user_id = ?1').bind(userId),
    env.DB.prepare(
      `SELECT id, type, title, body, link, created_at FROM notifications
       WHERE user_id = ?1 AND id > ?2 AND read_at IS NULL ORDER BY id LIMIT 10`,
    ).bind(userId, after),
  ]);
  const c = counts.results?.[0] || {};
  return json({
    unreadCount: c.unread || 0, latestId: c.latest || 0,
    fresh: (fresh.results || []).map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, createdAt: n.created_at })),
  }, 200, { 'Cache-Control': 'no-store' });
}

async function markNotificationRead(env, userId, id) {
  const res = await env.DB.prepare(
    `UPDATE notifications SET read_at = datetime('now') WHERE id = ?1 AND user_id = ?2 AND read_at IS NULL`,
  ).bind(id, userId).run();
  return json({ ok: true, changed: res.meta.changes > 0 });
}

async function markAllNotificationsRead(env, userId) {
  await env.DB.prepare(
    `UPDATE notifications SET read_at = datetime('now') WHERE user_id = ?1 AND read_at IS NULL`,
  ).bind(userId).run();
  return json({ ok: true });
}

async function handleNotifications(request, env, path, user, url) {
  const method = request.method.toUpperCase();
  if (!path.startsWith('notifications')) return null;

  if (path === 'notifications' && method === 'GET') return listNotifications(env, user.id);
  if (path === 'notifications/poll' && method === 'GET') return pollNotifications(env, user.id, url);
  if (path === 'notifications/read-all' && method === 'POST') return markAllNotificationsRead(env, user.id);
  const idMatch = path.match(/^notifications\/(\d+)\/read$/);
  if (idMatch && method === 'POST') return markNotificationRead(env, user.id, Number(idMatch[1]));

  return fail('not found', 404);
}

/* ── Item-level export ─────────────────────────────────── */

// Every checklist item (label, score, comment, photo count) for the given reports, read straight
// from the JSON so photos are never loaded. The page joins these rows to the report list it has.
async function exportItems(env, request) {
  const body = await request.json().catch(() => ({}));
  const ids = Array.isArray(body?.ids) ? [...new Set(body.ids.map(Number).filter(Number.isInteger))].slice(0, 5000) : [];
  if (!ids.length) return json({ items: [] });
  const { results } = await env.DB.prepare(
    `SELECT i.id AS id, CAST(s.key AS INTEGER) AS si, CAST(it.key AS INTEGER) AS ii,
            json_extract(s.value, '$.title') AS section,
            CASE WHEN it.type = 'object' THEN COALESCE(json_extract(it.value, '$.label'), json_extract(it.value, '$.text')) ELSE it.value END AS item,
            CASE WHEN it.type = 'object' THEN json_extract(it.value, '$.score') END AS score,
            CASE WHEN it.type = 'object' THEN json_extract(it.value, '$.comment') END AS comment,
            CASE WHEN it.type = 'object' AND json_type(it.value, '$.photos') = 'array' THEN json_array_length(it.value, '$.photos') ELSE 0 END AS photos
     FROM inspections i, json_each(i.data, '$.sections') s, json_each(s.value, '$.items') it
     WHERE i.id IN (SELECT value FROM json_each(?1)) AND json_valid(i.data) AND s.type = 'object'
     ORDER BY i.id, si, ii`,
  ).bind(JSON.stringify(ids)).all();
  return json({ items: results || [] });
}

/* ── Auth ───────────────────────────────────────────────── */

/** "iPhone · Safari" — enough for an admin to recognise a sign-in, nothing more. */
function deviceLabel(request) {
  const ua = request.headers.get('user-agent') || '';
  if (!ua) return null;
  const device = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua)) ? 'iPad'
      : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet')
        : /Macintosh/.test(ua) ? 'Mac'
          : /Windows/.test(ua) ? 'Windows'
            : /Linux/.test(ua) ? 'Linux' : 'Computer';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
      : /Chrome\//.test(ua) && !/Chromium/.test(ua) ? 'Chrome'
        : /CriOS\//.test(ua) ? 'Chrome'
          : /FxiOS\//.test(ua) || /Firefox\//.test(ua) ? 'Firefox'
            : /Safari\//.test(ua) ? 'Safari' : null;
  return browser ? `${device} · ${browser}` : device;
}


const ADMIN_ROLE = 'quality_admin';
const ASSIGNABLE_ROLES = new Set(['quality_leader', 'quality_officer', 'quality_auditor', 'data_analyst']);
const ALL_ROLES = new Set([ADMIN_ROLE, ...ASSIGNABLE_ROLES]);

/* ── Permissions ───────────────────────────────────────────
 * Each role comes with a default set; an admin can tailor any non-admin
 * account (stored as a JSON array in qa_users.permissions, NULL = defaults).
 * Quality Admins always hold every permission, and managing users, buildings
 * and the audit log stays with that role so access can't be escalated.
 * can_edit / can_delete / can_export are kept in step for older code paths. */

const PERMISSIONS = ['inspect', 'delete', 'export', 'review', 'assign', 'team', 'profiles', 'reports'];
const ROLE_PERMISSIONS = {
  quality_admin: PERMISSIONS,
  quality_leader: ['review', 'team', 'profiles', 'reports', 'export'],
  quality_officer: ['inspect', 'review', 'assign', 'profiles', 'reports', 'export'],
  // Reviewing and exporting are opt-in for auditors (an admin can switch them on per person).
  quality_auditor: ['inspect', 'reports'],
  data_analyst: ['reports', 'export'],
};
const LEGACY_FLAGS = { inspect: 'can_edit', delete: 'can_delete', export: 'can_export' };

function effectivePermissions(user) {
  if (user.role === ADMIN_ROLE) return [...PERMISSIONS];
  if (user.permissions) {
    try {
      const list = JSON.parse(user.permissions);
      if (Array.isArray(list)) return PERMISSIONS.filter((k) => list.includes(k));
    } catch { /* fall through to defaults */ }
  }
  // Accounts from before detailed permissions: role defaults, with the three original switches as they were.
  const set = new Set((ROLE_PERMISSIONS[user.role] || []).filter((k) => !LEGACY_FLAGS[k]));
  for (const [key, col] of Object.entries(LEGACY_FLAGS)) if (user[col]) set.add(key);
  return PERMISSIONS.filter((k) => set.has(k));
}
const can = (user, key) => effectivePermissions(user).includes(key);

/* Who can be given buildings, and by whom:
 *  - Quality Admin: themselves, other admins, officers and auditors (never leaders or analysts)
 *  - Quality Officer: admins, themselves and auditors
 *  - anyone else granted "assign": auditors, and themselves if their role can hold buildings
 * The person must also be active and allowed to create inspections. */
const ASSIGNEE_ROLES = new Set(['quality_auditor', 'quality_officer', 'quality_admin']);
const ROLE_NAMES = {
  quality_admin: 'Quality Admin', quality_leader: 'Quality Leader', quality_officer: 'Quality Officer',
  quality_auditor: 'Quality Auditor', data_analyst: 'Data Analyst',
};
function canAssignTo(actor, target) {
  if (!target || !ASSIGNEE_ROLES.has(target.role)) return false;
  if (actor.role === 'quality_admin') return true;
  if (actor.role === 'quality_officer') return target.role !== 'quality_officer' || target.id === actor.id;
  return target.role === 'quality_auditor' || target.id === actor.id;
}
function assigneeProblem(actor, target) {
  if (!target) return [404, 'that person was not found'];
  if (!canAssignTo(actor, target)) return [403, `you cannot assign buildings to a ${ROLE_NAMES[target.role] || target.role}`];
  if (target.status !== 'active') return [400, `${target.name}'s account is suspended`];
  if (!can(target, 'inspect')) return [400, `${target.name} does not have permission to create inspections — an admin can grant it in Admin Control`];
  return null;
}
const sameSet = (a, b) => a.length === b.length && a.every((k) => b.includes(k));

async function audit(env, actor, action, targetId, target, details) {
  try {
    await env.DB.prepare(
      'INSERT INTO audit_log (actor_id, actor_name, action, target_id, target, details) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    ).bind(actor?.id || null, actor?.name || null, action, targetId || null, target || null, details || null).run();
  } catch { /* logging must never block the action itself */ }
}
const touchLogin = (env, id) => env.DB.prepare("UPDATE qa_users SET last_login_at = datetime('now') WHERE id = ?1").bind(id).run()
  .catch(() => {});

async function hasAnyUser(env) {
  const row = await env.DB.prepare('SELECT id FROM qa_users LIMIT 1').first();
  return !!row;
}

async function authStatus(env) {
  return json({ hasUsers: await hasAnyUser(env) });
}

async function authBootstrap(env, body, request) {
  const name = (body?.name || '').trim();
  const username = (body?.username || '').trim().toLowerCase();
  const password = body?.password || '';
  if (!name || !username) return fail('name and username are required', 400);
  const weak = passwordProblem(password);
  if (weak) return fail(weak, 400);
  if (await hasAnyUser(env)) return fail('an administrator already exists', 409);

  const { hash, salt, iterations, rounds } = await hashPassword(password);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO qa_users (id, name, username, password_hash, password_salt, password_iterations, password_rounds, role)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(id, name, username, hash, salt, iterations, rounds, ADMIN_ROLE).run();

  const { token, expiresAt } = await createSession(env, id, deviceLabel(request));
  await touchLogin(env, id);
  await audit(env, { id, name }, 'user.create', id, `${name} (@${username})`, 'First administrator created at setup');
  return json(
    { ok: true, user: publicUser({ id, name, username, role: ADMIN_ROLE }) },
    201,
    { 'Set-Cookie': sessionCookieHeader(token, expiresAt) },
  );
}

function publicUser(user) {
  const permissions = effectivePermissions(user);
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    permissions,
    canEdit: permissions.includes('inspect'),
    canDelete: permissions.includes('delete'),
    canExport: permissions.includes('export'),
  };
}

async function authLogin(env, body, request) {
  const username = (body?.username || '').trim().toLowerCase();
  const password = body?.password || '';
  if (!username || !password) return fail('username and password are required', 400);

  const user = await env.DB.prepare('SELECT * FROM qa_users WHERE username = ?1').bind(username).first();
  if (!user) return fail('invalid username or password', 401);
  if (user.status !== 'active') return fail('this account has been suspended', 403);
  if (isLocked(user)) return fail('account locked — try again in 15 minutes', 423);

  const valid = await verifyPassword(password, user);
  if (!valid) {
    await registerFailedAttempt(env, user);
    if ((user.failed_attempts || 0) + 1 === MAX_FAILED_ATTEMPTS) {
      await audit(env, null, 'security.lockout', user.id, `${user.name} (@${user.username})`,
        `Locked for 15 minutes after ${MAX_FAILED_ATTEMPTS} failed sign-in attempts`);
    }
    return fail('invalid username or password', 401);
  }

  await clearFailedAttempts(env, user.id);

  if (user.must_change_password) {
    return json({ ok: true, mustChangePassword: true, username: user.username });
  }

  const { token, expiresAt } = await createSession(env, user.id, deviceLabel(request));
  await touchLogin(env, user.id);
  return json(
    { ok: true, user: publicUser(user) },
    200,
    { 'Set-Cookie': sessionCookieHeader(token, expiresAt) },
  );
}

async function authCompleteSetup(env, body, request) {
  const username = (body?.username || '').trim().toLowerCase();
  const currentPassword = body?.currentPassword || '';
  const newPassword = body?.newPassword || '';
  if (!username || !currentPassword) return fail('username and current password are required', 400);
  const weak = passwordProblem(newPassword);
  if (weak) return fail(weak, 400);
  if (newPassword === currentPassword) return fail('choose a new password, not the temporary one', 400);

  const user = await env.DB.prepare('SELECT * FROM qa_users WHERE username = ?1').bind(username).first();
  if (!user || user.status !== 'active') return fail('invalid username or password', 401);
  if (!user.must_change_password) return fail('this account does not require a password change', 400);
  // the temporary password is guarded exactly like a sign-in: five wrong tries lock the account
  if (isLocked(user)) return fail('account locked — try again in 15 minutes', 423);
  if (!(await verifyPassword(currentPassword, user))) {
    await registerFailedAttempt(env, user);
    if ((user.failed_attempts || 0) + 1 === MAX_FAILED_ATTEMPTS) {
      await audit(env, null, 'security.lockout', user.id, `${user.name} (@${user.username})`,
        `Locked for 15 minutes after ${MAX_FAILED_ATTEMPTS} wrong temporary passwords`);
    }
    return fail('invalid username or password', 401);
  }
  await clearFailedAttempts(env, user.id);

  const { hash, salt, iterations, rounds } = await hashPassword(newPassword);
  await env.DB.prepare(
    `UPDATE qa_users SET password_hash = ?2, password_salt = ?3, password_iterations = ?4, password_rounds = ?5,
       must_change_password = 0, updated_at = datetime('now') WHERE id = ?1`,
  ).bind(user.id, hash, salt, iterations, rounds).run();
  await revokeSessions(env, user.id);
  await audit(env, user, 'user.password_set', user.id, `${user.name} (@${user.username})`, 'Replaced the temporary password');

  const { token, expiresAt } = await createSession(env, user.id, deviceLabel(request));
  await touchLogin(env, user.id);
  return json(
    { ok: true, user: publicUser(user) },
    200,
    { 'Set-Cookie': sessionCookieHeader(token, expiresAt) },
  );
}

async function authLogout(request, env) {
  await destroySession(env, readCookie(request, SESSION_COOKIE));
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookieHeader() });
}

async function authMe(request, env) {
  const user = await getUserFromRequest(request, env);
  if (!user) return fail('not authenticated', 401);
  return json({ user: publicUser(user) }, 200, user.renewCookie ? { 'Set-Cookie': user.renewCookie } : {});
}

async function authChangePassword(request, env, body) {
  const user = await getUserFromRequest(request, env);
  if (!user) return fail('not authenticated', 401);

  const currentPassword = body?.currentPassword || '';
  const newPassword = body?.newPassword || '';
  const weak = passwordProblem(newPassword);
  if (weak) return fail(weak, 400);
  if (newPassword === currentPassword) return fail('the new password must be different from the current one', 400);

  const row = await env.DB.prepare('SELECT * FROM qa_users WHERE id = ?1').bind(user.id).first();
  if (!row) return fail('account not found', 404);
  if (!(await verifyPassword(currentPassword, row))) return fail('current password is incorrect', 401);

  const { hash, salt, iterations, rounds } = await hashPassword(newPassword);
  await env.DB.prepare(
    `UPDATE qa_users SET password_hash = ?2, password_salt = ?3, password_iterations = ?4, password_rounds = ?5,
       must_change_password = 0, updated_at = datetime('now') WHERE id = ?1`,
  ).bind(user.id, hash, salt, iterations, rounds).run();
  // A new password signs out every other device; this one stays signed in.
  const ended = await revokeSessions(env, user.id, user.sessionHash);
  await audit(env, user, 'user.password_change', user.id, `${user.name} (@${user.username})`,
    `Password changed${ended ? ` · signed out ${ended} other device${ended === 1 ? '' : 's'}` : ''}`);
  return json({ ok: true, signedOutElsewhere: ended });
}

/* ── Admin: user management ────────────────────────────────── */

async function adminListUsers(env) {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.username, u.role, u.status, u.can_edit, u.can_delete, u.can_export, u.permissions,
            u.must_change_password, u.failed_attempts, u.locked_until, u.last_login_at, u.created_at,
            (SELECT COUNT(*) FROM qa_sessions s WHERE s.user_id = u.id AND s.expires_at > ?1) AS sessions,
            (SELECT group_concat(DISTINCT s.device) FROM qa_sessions s WHERE s.user_id = u.id AND s.expires_at > ?1 AND s.device IS NOT NULL) AS devices
     FROM qa_users u ORDER BY u.created_at ASC`,
  ).bind(Date.now()).all();
  const users = (results || []).map((u) => {
    const permissions = effectivePermissions(u);
    return {
      id: u.id, name: u.name, username: u.username, role: u.role, status: u.status,
      permissions, customPermissions: u.role !== ADMIN_ROLE && !sameSet(permissions, ROLE_PERMISSIONS[u.role] || []),
      canEdit: permissions.includes('inspect'), canDelete: permissions.includes('delete'), canExport: permissions.includes('export'),
      mustChangePassword: !!u.must_change_password,
      failedAttempts: u.failed_attempts || 0,
      lockedUntil: u.locked_until && u.locked_until > Date.now() ? new Date(u.locked_until).toISOString() : null,
      lastLoginAt: u.last_login_at, activeSessions: u.sessions, createdAt: u.created_at,
      sessionDevices: u.devices ? u.devices.split(',').filter(Boolean) : [],
    };
  });
  return json({ users, catalog: PERMISSIONS, roleDefaults: ROLE_PERMISSIONS });
}

function cleanPermissions(list) {
  return Array.isArray(list) ? PERMISSIONS.filter((k) => list.includes(k)) : null;
}
/** Columns for a permission set; NULL JSON when it equals the role defaults. */
function permissionColumns(role, perms) {
  const custom = role !== ADMIN_ROLE && !sameSet(perms, ROLE_PERMISSIONS[role] || []);
  return {
    permissions: custom ? JSON.stringify(perms) : null,
    can_edit: perms.includes('inspect') ? 1 : 0,
    can_delete: perms.includes('delete') ? 1 : 0,
    can_export: perms.includes('export') ? 1 : 0,
  };
}

async function adminCreateUser(env, actingUser, body) {
  const name = (body?.name || '').trim();
  const username = (body?.username || '').trim().toLowerCase();
  const password = body?.password || '';
  const role = ALL_ROLES.has(body?.role) ? body.role : 'quality_auditor';
  if (!name || !username) return fail('name and username are required', 400);
  const weak = passwordProblem(password);
  if (weak) return fail(`Temporary password: ${weak.charAt(0).toLowerCase()}${weak.slice(1)}`, 400);
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) return fail('username must be 3–40 characters: letters, numbers, dot, dash or underscore', 400);
  const existing = await env.DB.prepare('SELECT id FROM qa_users WHERE username = ?1').bind(username).first();
  if (existing) return fail('that username is already taken', 409);

  const perms = role === ADMIN_ROLE ? [...PERMISSIONS] : (cleanPermissions(body?.permissions) || ROLE_PERMISSIONS[role]);
  const cols = permissionColumns(role, perms);
  const { hash, salt, iterations, rounds } = await hashPassword(password);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO qa_users
       (id, name, username, password_hash, password_salt, password_iterations, password_rounds,
        role, can_edit, can_delete, can_export, permissions, must_change_password)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1)`,
  ).bind(id, name, username, hash, salt, iterations, rounds, role, cols.can_edit, cols.can_delete, cols.can_export, cols.permissions).run();

  await audit(env, actingUser, 'user.create', id, `${name} (@${username})`,
    `Role ${role}${cols.permissions ? ` · custom permissions: ${perms.join(', ') || 'none'}` : ''}`);
  return json({ ok: true, id }, 201);
}

async function adminUpdateUser(env, actingUser, targetId, body) {
  if (targetId === actingUser.id) return fail('use your account settings to change your own access', 400);
  const target = await env.DB.prepare('SELECT * FROM qa_users WHERE id = ?1').bind(targetId).first();
  if (!target) return fail('user not found', 404);
  const label = `${target.name} (@${target.username})`;
  const sets = [];
  const values = [targetId];
  const put = (col, val) => { sets.push(`${col} = ?${values.length + 1}`); values.push(val); };
  const notes = [];

  const before = effectivePermissions(target);
  let role = target.role;
  if (ALL_ROLES.has(body?.role) && body.role !== target.role) {
    if (target.role === ADMIN_ROLE) {
      const { c } = await env.DB.prepare("SELECT COUNT(*) AS c FROM qa_users WHERE role = ?1 AND status = 'active'").bind(ADMIN_ROLE).first();
      if (c <= 1) return fail('cannot change the role of the last active administrator', 400);
    }
    role = body.role;
    put('role', role);
    notes.push(['user.role', `${target.role} → ${role} (permissions reset to role defaults)`]);
  }
  // A role change resets to that role's defaults unless a new set arrives with it.
  let perms = null;
  if (body && 'permissions' in body) perms = body.permissions === null ? [...(ROLE_PERMISSIONS[role] || [])] : cleanPermissions(body.permissions);
  else if (role !== target.role) perms = [...(ROLE_PERMISSIONS[role] || [])];
  if (body && 'permissions' in body && perms === null) return fail('permissions must be a list', 400);
  if (perms) {
    const cols = permissionColumns(role, perms);
    for (const [col, val] of Object.entries(cols)) put(col, val);
    const added = perms.filter((k) => !before.includes(k)), removed = before.filter((k) => !perms.includes(k));
    if (role === target.role && (added.length || removed.length)) {
      notes.push(['user.permissions', [added.length ? `granted ${added.join(', ')}` : '', removed.length ? `removed ${removed.join(', ')}` : ''].filter(Boolean).join(' · ')]);
    }
  }
  if ((body?.status === 'active' || body?.status === 'suspended') && body.status !== target.status) {
    if (body.status === 'suspended' && target.role === ADMIN_ROLE) {
      const { c } = await env.DB.prepare("SELECT COUNT(*) AS c FROM qa_users WHERE role = ?1 AND status = 'active'").bind(ADMIN_ROLE).first();
      if (c <= 1) return fail('cannot suspend the last active administrator', 400);
    }
    put('status', body.status);
    notes.push(['user.status', body.status === 'suspended' ? 'Suspended' : 'Reactivated']);
  }
  if (typeof body?.name === 'string' && body.name.trim() && body.name.trim() !== target.name) {
    put('name', body.name.trim());
    notes.push(['user.update', `name: ${target.name} → ${body.name.trim()}`]);
  }
  if (!sets.length) return json({ ok: true, unchanged: true });
  sets.push(`updated_at = datetime('now')`);

  await env.DB.prepare(`UPDATE qa_users SET ${sets.join(', ')} WHERE id = ?1`).bind(...values).run();
  if (body?.status === 'suspended') await env.DB.prepare('DELETE FROM qa_sessions WHERE user_id = ?1').bind(targetId).run();
  for (const [action, details] of notes) await audit(env, actingUser, action, targetId, label, details);
  return json({ ok: true });
}

async function adminResetPassword(env, actingUser, targetId, body) {
  if (targetId === actingUser.id) return fail('use "Change Password" in your account menu instead', 400);
  const password = body?.password || '';
  const weak = passwordProblem(password);
  if (weak) return fail(`Temporary password: ${weak.charAt(0).toLowerCase()}${weak.slice(1)}`, 400);
  const target = await env.DB.prepare('SELECT name, username FROM qa_users WHERE id = ?1').bind(targetId).first();
  if (!target) return fail('user not found', 404);
  const { hash, salt, iterations, rounds } = await hashPassword(password);
  await env.DB.prepare(
    `UPDATE qa_users SET password_hash = ?2, password_salt = ?3, password_iterations = ?4, password_rounds = ?5,
       must_change_password = 1, failed_attempts = 0, locked_until = NULL, updated_at = datetime('now')
     WHERE id = ?1`,
  ).bind(targetId, hash, salt, iterations, rounds).run();
  await env.DB.prepare('DELETE FROM qa_sessions WHERE user_id = ?1').bind(targetId).run();
  await audit(env, actingUser, 'user.password_reset', targetId, `${target.name} (@${target.username})`, 'Temporary password issued; signed out everywhere');
  return json({ ok: true });
}

async function adminUnlockUser(env, actingUser, targetId) {
  const target = await env.DB.prepare('SELECT name, username FROM qa_users WHERE id = ?1').bind(targetId).first();
  if (!target) return fail('user not found', 404);
  await clearFailedAttempts(env, targetId);
  await audit(env, actingUser, 'security.unlock', targetId, `${target.name} (@${target.username})`, 'Failed sign-in attempts cleared');
  return json({ ok: true });
}

async function adminSignOutUser(env, actingUser, targetId) {
  if (targetId === actingUser.id) return fail('use Sign out to end your own session', 400);
  const target = await env.DB.prepare('SELECT name, username FROM qa_users WHERE id = ?1').bind(targetId).first();
  if (!target) return fail('user not found', 404);
  const res = await env.DB.prepare('DELETE FROM qa_sessions WHERE user_id = ?1').bind(targetId).run();
  await audit(env, actingUser, 'security.signout', targetId, `${target.name} (@${target.username})`,
    `Ended ${res.meta.changes} session${res.meta.changes === 1 ? '' : 's'}`);
  return json({ ok: true, ended: res.meta.changes });
}

async function adminDeleteUser(env, actingUser, targetId) {
  if (targetId === actingUser.id) return fail('you cannot delete your own account', 400);
  const target = await env.DB.prepare('SELECT name, username, role FROM qa_users WHERE id = ?1').bind(targetId).first();
  if (!target) return fail('user not found', 404);
  if (target.role === ADMIN_ROLE) {
    const { c } = await env.DB.prepare('SELECT COUNT(*) as c FROM qa_users WHERE role = ?1').bind(ADMIN_ROLE).first();
    if (c <= 1) return fail('cannot delete the last administrator', 400);
  }
  const { a } = await env.DB.prepare('SELECT COUNT(*) AS a FROM assignments WHERE auditor_id = ?1 OR assigned_by = ?1').bind(targetId).first();
  if (a) return fail(`this account is linked to ${a} assignment${a === 1 ? '' : 's'} — suspend it instead so the history stays intact`, 409);
  await env.DB.prepare('DELETE FROM notifications WHERE user_id = ?1').bind(targetId).run();
  await env.DB.prepare('DELETE FROM qa_sessions WHERE user_id = ?1').bind(targetId).run();
  await env.DB.prepare('DELETE FROM qa_users WHERE id = ?1').bind(targetId).run();
  await audit(env, actingUser, 'user.delete', targetId, `${target.name} (@${target.username})`, `Role ${target.role}`);
  return json({ ok: true });
}

async function adminAuditLog(env, url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
  const before = Number(url.searchParams.get('before')) || null;
  const target = url.searchParams.get('target') || null;
  const where = [], binds = [];
  if (before) { where.push(`id < ?${binds.length + 1}`); binds.push(before); }
  if (target) { where.push(`target_id = ?${binds.length + 1}`); binds.push(target); }
  const { results } = await env.DB.prepare(
    `SELECT id, actor_id, actor_name, action, target_id, target, details, created_at FROM audit_log
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit + 1}`,
  ).bind(...binds).all();
  const rows = results || [];
  return json({
    entries: rows.slice(0, limit).map((r) => ({
      id: r.id, actorId: r.actor_id, actor: r.actor_name, action: r.action, targetId: r.target_id,
      target: r.target, details: r.details, at: r.created_at,
    })),
    more: rows.length > limit,
  });
}

async function handleAdmin(request, env, path, user) {
  const method = request.method.toUpperCase();
  if (!path.startsWith('admin/')) return null;
  if (!user || user.role !== ADMIN_ROLE) return fail('administrator access required', 403);

  if (path === 'admin/users' && method === 'GET') return adminListUsers(env);
  if (path === 'admin/users' && method === 'POST') return adminCreateUser(env, user, await request.json());
  if (path === 'admin/audit' && method === 'GET') return adminAuditLog(env, new URL(request.url));
  if (path === 'admin/archive' && method === 'GET') return listArchive(env);
  const restoreMatch = path.match(/^admin\/archive\/(\d+)\/restore$/);
  if (restoreMatch && method === 'POST') return restoreInspection(env, user, Number(restoreMatch[1]));
  if (path === 'admin/backup' && method === 'GET') return backupStatus(env);
  if (path === 'admin/backup/run' && method === 'POST') {
    const status = await runBackup(env, `run by ${user.name}`);
    await audit(env, user, 'backup.run', null, 'Backup', status.ok ? `Backup finished in ${status.seconds}s` : `Backup failed: ${status.error}`);
    return json(status, status.ok ? 200 : 500);
  }
  if (path === 'admin/export' && method === 'GET') {
    const url = new URL(request.url);
    if (url.searchParams.get('start') === '1') await audit(env, user, 'backup.download', null, 'Full export', 'Downloaded a full copy of the database');
    return exportTablePage(env, url);
  }
  if (path === 'admin/maintenance/photos' && method === 'POST') {
    const moved = await externalizeLegacyPhotos(env, 8);
    const baselines = await recordBaselines(env);
    const toStorage = env.PHOTOS ? await movePhotosToStorage(env, 10) : 0;
    const left = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM inspections WHERE instr(data, '"data:image/') > 0) AS legacy,
      (SELECT COUNT(*) FROM photo_blobs WHERE data != '') AS inDb`).first();
    return json({ moved, baselines, toStorage, reportsLeft: left.legacy, photosInDatabase: env.PHOTOS ? left.inDb : 0 });
  }

  const idMatch = path.match(/^admin\/users\/([^/]+)$/);
  if (idMatch && method === 'PATCH') return adminUpdateUser(env, user, idMatch[1], await request.json());
  if (idMatch && method === 'DELETE') return adminDeleteUser(env, user, idMatch[1]);

  const resetMatch = path.match(/^admin\/users\/([^/]+)\/reset-password$/);
  if (resetMatch && method === 'POST') return adminResetPassword(env, user, resetMatch[1], await request.json());
  const unlockMatch = path.match(/^admin\/users\/([^/]+)\/unlock$/);
  if (unlockMatch && method === 'POST') return adminUnlockUser(env, user, unlockMatch[1]);
  const signoutMatch = path.match(/^admin\/users\/([^/]+)\/signout$/);
  if (signoutMatch && method === 'POST') return adminSignOutUser(env, user, signoutMatch[1]);

  return fail('not found', 404);
}

async function handleAuth(request, env, path) {
  const method = request.method.toUpperCase();
  if (path === 'auth/status' && method === 'GET') return authStatus(env);
  if (path === 'auth/bootstrap' && method === 'POST') return authBootstrap(env, await request.json(), request);
  if (path === 'auth/login' && method === 'POST') return authLogin(env, await request.json(), request);
  if (path === 'auth/complete-setup' && method === 'POST') return authCompleteSetup(env, await request.json(), request);
  if (path === 'auth/logout' && method === 'POST') return authLogout(request, env);
  if (path === 'auth/me' && method === 'GET') return authMe(request, env);
  if (path === 'auth/change-password' && method === 'POST') return authChangePassword(request, env, await request.json());
  return null;
}

/* ── Router ─────────────────────────────────────────────── */

async function handleApi(request, env, url) {
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const method = request.method.toUpperCase();

  if (path === 'health') return json({ ok: true });

  // Anything that changes data must come from this site's own pages (defence against a
  // hostile page submitting a form to the API in a signed-in browser).
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const origin = request.headers.get('Origin');
    const site = request.headers.get('Sec-Fetch-Site');
    if ((origin && origin !== url.origin) || (site && site !== 'same-origin' && site !== 'none')) {
      return fail('request blocked: it did not come from this site', 403);
    }
  }

  const authResponse = await handleAuth(request, env, path);
  if (authResponse) return authResponse;
  if (path.startsWith('auth/')) return fail('not found', 404);

  const user = await getUserFromRequest(request, env);
  if (!user) return fail('authentication required', 401);
  const res = await handleApiAuthed(request, env, url, path, method, user);
  if (!user.renewCookie || res.headers.has('Set-Cookie')) return res;
  const headers = new Headers(res.headers);
  headers.append('Set-Cookie', user.renewCookie);                  // the session was extended: so is the cookie
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function handleApiAuthed(request, env, url, path, method, user) {
  const adminResponse = await handleAdmin(request, env, path, user);
  if (adminResponse) return adminResponse;
  if (path.startsWith('admin/')) return fail('not found', 404);

  if (path === 'export/items' && method === 'POST') {
    if (!can(user, 'export')) return fail('you do not have permission to export data', 403);
    return exportItems(env, request);
  }

  if (path === 'buildings' && method === 'GET') return listBuildings(env, url, user);
  if (path === 'buildings' && method === 'POST') {
    if (user.role !== ADMIN_ROLE) return fail('administrator access required', 403);
    return createBuilding(env, user, await request.json());
  }
  const buildingMatch = path.match(/^buildings\/(\d+)$/);
  if (buildingMatch && (method === 'PATCH' || method === 'DELETE')) {
    if (user.role !== ADMIN_ROLE) return fail('administrator access required', 403);
    return method === 'PATCH'
      ? updateBuilding(env, user, Number(buildingMatch[1]), await request.json())
      : deleteBuilding(env, user, Number(buildingMatch[1]));
  }

  if (path === 'reports/library' && method === 'GET') return reportLibrary(env, user, url);

  if (path === 'reports/inspections' && method === 'GET') {
    if (!can(user, 'reports')) return fail('you do not have permission to view reports', 403);
    return reportInspections(env);
  }
  if (path.startsWith('reports/saved')) {
    if (!can(user, 'reports')) return fail('you do not have permission to view reports', 403);
    if (path === 'reports/saved' && method === 'GET') return listSavedReports(env, user);
    if (path === 'reports/saved' && method === 'POST') return saveReport(env, user, await request.json());
    const savedMatch = path.match(/^reports\/saved\/(\d+)$/);
    if (savedMatch && method === 'DELETE') return deleteSavedReport(env, user, Number(savedMatch[1]));
    return fail('not found', 404);
  }

  if (path === 'leader/overview' && method === 'GET') {
    if (!can(user, 'team')) {
      return fail('you do not have permission to view the team overview', 403);
    }
    return leaderOverview(env, url);
  }

  if (path === 'auditor/profile' && method === 'GET') return auditorProfile(env, user, url);

  if (path === 'officer/board' && method === 'GET') {
    if (!can(user, 'assign')) {
      return fail('you do not have permission to view the assignment board', 403);
    }
    return officerBoard(env, user, url);
  }

  const assignmentResponse = await handleAssignments(request, env, url, path, user);
  if (assignmentResponse) return assignmentResponse;
  if (path.startsWith('assignments')) return fail('not found', 404);

  const notificationResponse = await handleNotifications(request, env, path, user, url);
  if (notificationResponse) return notificationResponse;
  if (path.startsWith('notifications')) return fail('not found', 404);

  const photoMatch = path.match(/^photos\/([0-9a-f]{64})$/);
  if (photoMatch && method === 'GET') return servePhoto(env, photoMatch[1]);

  const versionsMatch = path.match(/^inspections\/(\d+)\/versions(?:\/(\d+))?$/);
  if (versionsMatch && method === 'GET') {
    // a deleted report's history is for administrators only, like the archive itself
    if (user.role !== ADMIN_ROLE) {
      const live = await env.DB.prepare('SELECT 1 AS x FROM inspections WHERE id = ?1').bind(Number(versionsMatch[1])).first();
      if (!live) return fail('record not found', 404);
    }
    return versionsMatch[2] ? getVersion(env, Number(versionsMatch[1]), Number(versionsMatch[2])) : listVersions(env, Number(versionsMatch[1]));
  }

  if (path === 'inspections') {
    if (method === 'POST') {
      if (!can(user, 'inspect')) return fail('you do not have permission to create inspections', 403);
      return insertInspection(env, user, await request.json());
    }
    return fail('method not allowed', 405);
  }

  const reviewMatch = path.match(/^inspections\/(\d+)\/reviews$/);
  if (reviewMatch && method === 'POST') return reviewInspection(env, user, Number(reviewMatch[1]), await request.json());

  const match = path.match(/^inspections\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    if (method === 'GET') return getInspectionForReview(env, user, id);
    if (method === 'PATCH' || method === 'PUT') {
      if (!can(user, 'inspect')) return fail('you do not have permission to edit inspections', 403);
      return updateInspection(env, user, id, await request.json());
    }
    if (method === 'DELETE') {
      if (!can(user, 'delete')) return fail('you do not have permission to delete inspections', 403);
      return deleteInspection(env, user, id);
    }
    return fail('method not allowed', 405);
  }

  return fail('not found', 404);
}

async function handleAssets(request, env, url) {
  const isAppShell = url.pathname === '/app.html' || url.pathname === '/app';
  const isAdminShell = url.pathname === '/admin.html' || url.pathname === '/admin';
  const isAssignShell = url.pathname === '/assign.html' || url.pathname === '/assign';
  const isReportShell = url.pathname === '/report.html' || url.pathname === '/report';
  if (isAppShell || isAdminShell || isAssignShell || isReportShell) {
    const user = await getUserFromRequest(request, env);
    if (!user) return Response.redirect(new URL('/login.html', url).toString(), 302);
    // User management and assigning moved inside the app; keep old links working.
    if (isAdminShell) {
      return Response.redirect(new URL(user.role === ADMIN_ROLE ? '/app#pg-admin' : '/app', url).toString(), 302);
    }
    if (isAssignShell) return Response.redirect(new URL('/app#pg-officer', url).toString(), 302);
  }
  return env.ASSETS.fetch(request);
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runBackup(env, 'nightly'));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith('/api/');
    try {
      return isApi ? await handleApi(request, env, url) : await handleAssets(request, env, url);
    } catch (err) {
      // A body that is not JSON is the caller's mistake, not a server fault.
      if (isApi && err instanceof SyntaxError) return fail('the request body is not valid JSON', 400);
      // Anything else stays in the log; the person sees a plain message, not a database error.
      console.error('unhandled error', url.pathname, err && err.stack || err);
      if (isApi) return fail('something went wrong on the server — please try again', 500);
      return new Response('Service temporarily unavailable.', { status: 503 });
    }
  },
};
