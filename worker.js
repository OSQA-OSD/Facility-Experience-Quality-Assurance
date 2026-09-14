/**
 * Facility Experience QA — Worker API
 * Serves the static app and a small JSON API backed by Cloudflare D1.
 */

import {
  hashPassword, verifyPassword, createSession, destroySession, getUserFromRequest,
  readCookie, sessionCookieHeader, clearCookieHeader, isLocked,
  registerFailedAttempt, clearFailedAttempts, SESSION_COOKIE, MAX_FAILED_ATTEMPTS,
} from './auth.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

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
function recordToRow(rec) {
  const { id, inspector, facility, division, date, type, typeLabel,
          overall, filename, ...rest } = rec;
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
  };
}

async function listInspections(env, limit = 500) {
  const { results } = await env.DB
    .prepare('SELECT * FROM inspections ORDER BY id DESC LIMIT ?1')
    .bind(limit)
    .all();
  return (results || []).map(rowToRecord);
}

async function insertInspection(env, rec) {
  const r = recordToRow(rec);
  if (r.id == null) return fail('id is required', 400);

  const assignmentId = rec?.assignmentId != null ? Number(rec.assignmentId) : null;
  let firstCompletion = false;
  if (assignmentId) {
    const prior = await env.DB.prepare(
      "SELECT 1 AS x FROM inspections WHERE json_extract(data, '$.assignmentId') = ?1 LIMIT 1",
    ).bind(assignmentId).first();
    firstCompletion = !prior;
  }

  await env.DB.prepare(
    `INSERT INTO inspections
       (id, inspector, facility, division, date, type, type_label, overall, filename, data)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
  ).bind(r.id, r.inspector, r.facility, r.division, r.date,
         r.type, r.type_label, r.overall, r.filename, r.data).run();

  if (firstCompletion) await notifyAssignmentCompleted(env, assignmentId, r.overall);
  return json({ ok: true, id: r.id }, 201);
}

/** Tells every active Quality Leader (and whoever made the assignment) that it was completed. */
async function notifyAssignmentCompleted(env, assignmentId, overall) {
  const a = await env.DB.prepare(
    `SELECT a.quarter, a.type, a.assigned_by, a.auditor_id, b.name AS building, u.name AS auditor, o.role AS assigner_role
     FROM assignments a
     JOIN buildings b ON b.id = a.building_id
     JOIN qa_users u ON u.id = a.auditor_id
     LEFT JOIN qa_users o ON o.id = a.assigned_by
     WHERE a.id = ?1`,
  ).bind(assignmentId).first();
  if (!a) return;

  const title = `Completed: ${a.building}`;
  const score = overall != null ? ` — score ${Math.round(overall)}/100` : '';
  const body = `${a.auditor} completed ${a.building} for ${a.quarter} ${a.type}${score}.`;

  const recipients = new Map();
  const { results: leaders } = await env.DB.prepare(
    "SELECT id FROM qa_users WHERE role = 'quality_leader' AND status = 'active'",
  ).all();
  for (const l of leaders || []) recipients.set(l.id, '#pg-overview');
  recipients.delete(a.auditor_id);
  if (a.assigned_by && a.assigned_by !== a.auditor_id && !recipients.has(a.assigned_by)) {
    recipients.set(a.assigned_by, a.assigner_role === 'quality_officer' || a.assigner_role === 'quality_admin' ? '#pg-officer' : null);
  }
  for (const [userId, link] of recipients) await notify(env, userId, 'completion', title, body, link);
}

async function updateInspection(env, id, rec) {
  const r = recordToRow(rec);
  const res = await env.DB.prepare(
    `UPDATE inspections SET
       inspector = ?2, facility = ?3, division = ?4, date = ?5,
       type = ?6, type_label = ?7, overall = ?8, filename = ?9,
       data = ?10, updated_at = datetime('now')
     WHERE id = ?1`
  ).bind(id, r.inspector, r.facility, r.division, r.date,
         r.type, r.type_label, r.overall, r.filename, r.data).run();
  if (!res.meta.changes) return fail('record not found', 404);
  return json({ ok: true, id });
}

async function deleteInspection(env, user, id) {
  const row = await env.DB.prepare('SELECT facility, date, inspector FROM inspections WHERE id = ?1').bind(id).first();
  const res = await env.DB.prepare('DELETE FROM inspections WHERE id = ?1').bind(id).run();
  if (!res.meta.changes) return fail('record not found', 404);
  await audit(env, user, 'inspection.delete', String(id), row ? `${row.facility} · ${row.date}` : `#${id}`,
    row ? `Inspection by ${row.inspector}` : null);
  return json({ ok: true, id });
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
    `INSERT INTO assignments (building_id, auditor_id, quarter, type, assigned_by)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(building_id, quarter, type)
     DO UPDATE SET auditor_id = excluded.auditor_id, assigned_by = excluded.assigned_by, updated_at = datetime('now')`,
  ).bind(buildingId, auditorId, quarter, type, officer.id).run();

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

async function officerBoard(env, viewer, url) {
  const quarter = url.searchParams.get('quarter') || '';
  const type = url.searchParams.get('type') || '';
  if (!QUARTER_RE.test(quarter) || !ASSIGNMENT_TYPES.has(type)) {
    return fail('quarter (YYYY-Qn) and a valid type (BOQI/EOQI) are required', 400);
  }
  const [b, a, u, i] = await Promise.all([
    env.DB.prepare('SELECT id, location, division, area, name FROM buildings ORDER BY division, area, name').all(),
    env.DB.prepare('SELECT id, building_id, auditor_id, quarter, type, assigned_by, created_at, updated_at FROM assignments').all(),
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
      inspector: row.inspector, date: row.date, submissions: (prev ? prev.submissions : 0) + 1,
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
      status: !asg ? 'unassigned' : res ? 'completed' : 'pending',
      score: res ? res.score : null,
      completedAt: res ? res.completedAt : null,
      inspectionDate: res ? res.date : null,
      inspector: res ? res.inspector : null,
    };
  });

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

/* Assign (or unassign) many buildings in one go. Uses json_each so the
 * whole set is one statement regardless of D1's bound-parameter limit.
 * Buildings already inspected for the period are left untouched. */
async function bulkAssign(env, officer, body) {
  const quarter = String(body?.quarter || '').trim();
  const type = body?.type;
  const auditorId = body?.auditorId || null;
  const ids = [...new Set((Array.isArray(body?.buildingIds) ? body.buildingIds : [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!QUARTER_RE.test(quarter) || !ASSIGNMENT_TYPES.has(type) || !ids.length) {
    return fail('quarter (YYYY-Qn), a valid type (BOQI/EOQI) and at least one building are required', 400);
  }
  if (ids.length > 1000) return fail('too many buildings in one request', 400);

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
    if (auditor ? cur && cur.auditor_id === auditor.id : !cur) { unchanged += 1; continue; }
    change.push(id);
  }

  if (change.length && auditor) {
    await env.DB.prepare(
      `INSERT INTO assignments (building_id, auditor_id, quarter, type, assigned_by)
       SELECT CAST(value AS INTEGER), ?2, ?3, ?4, ?5 FROM json_each(?1) WHERE true
       ON CONFLICT(building_id, quarter, type)
       DO UPDATE SET auditor_id = excluded.auditor_id, assigned_by = excluded.assigned_by, updated_at = datetime('now')`,
    ).bind(JSON.stringify(change), auditor.id, quarter, type, officer.id).run();
    const names = change.map((id) => buildingName.get(id));
    const list = names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
    if (auditor.id !== officer.id) await notify(
      env, auditor.id, 'assignment',
      change.length === 1 ? `New assignment: ${names[0]}` : `${change.length} new assignments`,
      `${officer.name} assigned you ${list} for ${quarter} ${type}.`,
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
      `SELECT a.id, a.quarter, a.type, a.building_id, a.updated_at, b.name AS building_name, b.division, b.area, b.location, o.name AS assigned_by
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
      status: r ? 'completed' : 'pending', score: r ? r.score : null, completedAt: r ? r.completedAt : null,
      inspectionId: r ? r.inspectionId : null, inspectionDate: r ? r.date : null,
    };
  });
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
const average = (xs) => (xs.length ? Math.round(xs.reduce((sum, x) => sum + x, 0) / xs.length) : null);

async function leaderOverview(env, url) {
  const quarter = url.searchParams.get('quarter') || 'all';
  const type = url.searchParams.get('type') || 'all';
  const division = url.searchParams.get('division') || 'all';

  const [b, a, u, i] = await Promise.all([
    env.DB.prepare('SELECT id, location, division, area, name FROM buildings').all(),
    env.DB.prepare('SELECT id, building_id, auditor_id, quarter, type, assigned_by, created_at, updated_at FROM assignments').all(),
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

async function handleAssignments(request, env, url, path, user) {
  const method = request.method.toUpperCase();
  if (!path.startsWith('assignments')) return null;

  const canManage = can(user, 'assign');
  const canView = canManage || can(user, 'team');

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
     WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 50`,
  ).bind(userId).all();
  const notifications = (results || []).map((n) => ({
    id: n.id, type: n.type, title: n.title, body: n.body, link: n.link,
    read: !!n.read_at, createdAt: n.created_at,
  }));
  const unreadCount = notifications.filter((n) => !n.read).length;
  return json({ notifications, unreadCount });
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

async function handleNotifications(request, env, path, user) {
  const method = request.method.toUpperCase();
  if (!path.startsWith('notifications')) return null;

  if (path === 'notifications' && method === 'GET') return listNotifications(env, user.id);
  if (path === 'notifications/read-all' && method === 'POST') return markAllNotificationsRead(env, user.id);
  const idMatch = path.match(/^notifications\/(\d+)\/read$/);
  if (idMatch && method === 'POST') return markNotificationRead(env, user.id, Number(idMatch[1]));

  return fail('not found', 404);
}

/* ── CSV export ─────────────────────────────────────────── */

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

async function exportCsv(env) {
  const records = await listInspections(env, 10000);
  const head = ['ID', 'Auditor', 'Facility', 'Division', 'Date',
                'Type', 'Type Label', 'Overall Score', 'Section', 'Item', 'Score', 'Comment'];
  const lines = [head.join(',')];

  for (const rec of records) {
    const base = [rec.id, rec.inspector, rec.facility, rec.division,
                  rec.date, rec.type, rec.typeLabel, rec.overall];
    const sections = Array.isArray(rec.sections) ? rec.sections : [];
    if (!sections.length) { lines.push([...base, '', '', '', ''].map(csvCell).join(',')); continue; }
    for (const sec of sections) {
      const items = Array.isArray(sec?.items) ? sec.items : [];
      if (!items.length) { lines.push([...base, sec?.title ?? '', '', '', ''].map(csvCell).join(',')); continue; }
      for (const it of items) {
        lines.push([...base, sec?.title ?? '', it?.label ?? it?.text ?? '',
                    it?.score ?? '', it?.comment ?? ''].map(csvCell).join(','));
      }
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response('﻿' + lines.join('\r\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="facility-qa-${stamp}.csv"`,
    },
  });
}

/* ── Auth ───────────────────────────────────────────────── */

const MIN_PASSWORD_LENGTH = 8;

const ADMIN_ROLE = 'quality_admin';
const ASSIGNABLE_ROLES = new Set(['quality_leader', 'quality_officer', 'quality_auditor', 'data_analyst']);
const ALL_ROLES = new Set([ADMIN_ROLE, ...ASSIGNABLE_ROLES]);

/* ── Permissions ───────────────────────────────────────────
 * Each role comes with a default set; an admin can tailor any non-admin
 * account (stored as a JSON array in qa_users.permissions, NULL = defaults).
 * Quality Admins always hold every permission, and managing users, buildings
 * and the audit log stays with that role so access can't be escalated.
 * can_edit / can_delete / can_export are kept in step for older code paths. */

const PERMISSIONS = ['inspect', 'delete', 'export', 'assign', 'team', 'profiles', 'reports'];
const ROLE_PERMISSIONS = {
  quality_admin: PERMISSIONS,
  quality_leader: ['team', 'profiles', 'reports', 'export'],
  quality_officer: ['inspect', 'assign', 'profiles', 'reports', 'export'],
  quality_auditor: ['inspect', 'reports', 'export'],
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

async function authBootstrap(env, body) {
  const name = (body?.name || '').trim();
  const username = (body?.username || '').trim().toLowerCase();
  const password = body?.password || '';
  if (!name || !username || password.length < MIN_PASSWORD_LENGTH) {
    return fail(`name, username, and a password of at least ${MIN_PASSWORD_LENGTH} characters are required`, 400);
  }
  if (await hasAnyUser(env)) return fail('an administrator already exists', 409);

  const { hash, salt, iterations, rounds } = await hashPassword(password);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO qa_users (id, name, username, password_hash, password_salt, password_iterations, password_rounds, role)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(id, name, username, hash, salt, iterations, rounds, ADMIN_ROLE).run();

  const { token, expiresAt } = await createSession(env, id);
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

async function authLogin(env, body) {
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

  const { token, expiresAt } = await createSession(env, user.id);
  await touchLogin(env, user.id);
  return json(
    { ok: true, user: publicUser(user) },
    200,
    { 'Set-Cookie': sessionCookieHeader(token, expiresAt) },
  );
}

async function authCompleteSetup(env, body) {
  const username = (body?.username || '').trim().toLowerCase();
  const currentPassword = body?.currentPassword || '';
  const newPassword = body?.newPassword || '';
  if (!username || !currentPassword) return fail('username and current password are required', 400);
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return fail(`new password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
  }

  const user = await env.DB.prepare('SELECT * FROM qa_users WHERE username = ?1').bind(username).first();
  if (!user || user.status !== 'active') return fail('invalid username or password', 401);
  if (!user.must_change_password) return fail('this account does not require a password change', 400);
  if (!(await verifyPassword(currentPassword, user))) return fail('invalid username or password', 401);

  const { hash, salt, iterations, rounds } = await hashPassword(newPassword);
  await env.DB.prepare(
    `UPDATE qa_users SET password_hash = ?2, password_salt = ?3, password_iterations = ?4, password_rounds = ?5,
       must_change_password = 0, updated_at = datetime('now') WHERE id = ?1`,
  ).bind(user.id, hash, salt, iterations, rounds).run();

  const { token, expiresAt } = await createSession(env, user.id);
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
  return json({ user: publicUser(user) });
}

async function authChangePassword(request, env, body) {
  const user = await getUserFromRequest(request, env);
  if (!user) return fail('not authenticated', 401);

  const currentPassword = body?.currentPassword || '';
  const newPassword = body?.newPassword || '';
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return fail(`new password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
  }

  const row = await env.DB.prepare('SELECT * FROM qa_users WHERE id = ?1').bind(user.id).first();
  if (!row) return fail('account not found', 404);
  if (!(await verifyPassword(currentPassword, row))) return fail('current password is incorrect', 401);

  const { hash, salt, iterations, rounds } = await hashPassword(newPassword);
  await env.DB.prepare(
    `UPDATE qa_users SET password_hash = ?2, password_salt = ?3, password_iterations = ?4, password_rounds = ?5,
       must_change_password = 0, updated_at = datetime('now') WHERE id = ?1`,
  ).bind(user.id, hash, salt, iterations, rounds).run();

  return json({ ok: true });
}

/* ── Admin: user management ────────────────────────────────── */

async function adminListUsers(env) {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.username, u.role, u.status, u.can_edit, u.can_delete, u.can_export, u.permissions,
            u.must_change_password, u.failed_attempts, u.locked_until, u.last_login_at, u.created_at,
            (SELECT COUNT(*) FROM qa_sessions s WHERE s.user_id = u.id AND s.expires_at > ?1) AS sessions
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
  if (!name || !username || password.length < MIN_PASSWORD_LENGTH) {
    return fail(`name, username, and a temporary password of at least ${MIN_PASSWORD_LENGTH} characters are required`, 400);
  }
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
  if (password.length < MIN_PASSWORD_LENGTH) {
    return fail(`temporary password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
  }
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
  if (path === 'auth/bootstrap' && method === 'POST') return authBootstrap(env, await request.json());
  if (path === 'auth/login' && method === 'POST') return authLogin(env, await request.json());
  if (path === 'auth/complete-setup' && method === 'POST') return authCompleteSetup(env, await request.json());
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

  const authResponse = await handleAuth(request, env, path);
  if (authResponse) return authResponse;
  if (path.startsWith('auth/')) return fail('not found', 404);

  const user = await getUserFromRequest(request, env);
  if (!user) return fail('authentication required', 401);

  const adminResponse = await handleAdmin(request, env, path, user);
  if (adminResponse) return adminResponse;
  if (path.startsWith('admin/')) return fail('not found', 404);

  if (path === 'export.csv' && method === 'GET') {
    if (!can(user, 'export')) return fail('you do not have permission to export data', 403);
    return exportCsv(env);
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

  if (path === 'reports/inspections' && method === 'GET') {
    if (!can(user, 'reports')) return fail('you do not have permission to view reports', 403);
    return reportInspections(env);
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

  const notificationResponse = await handleNotifications(request, env, path, user);
  if (notificationResponse) return notificationResponse;
  if (path.startsWith('notifications')) return fail('not found', 404);

  if (path === 'inspections') {
    if (method === 'GET') return json(await listInspections(env));
    if (method === 'POST') {
      if (!can(user, 'inspect')) return fail('you do not have permission to create inspections', 403);
      return insertInspection(env, await request.json());
    }
    return fail('method not allowed', 405);
  }

  const match = path.match(/^inspections\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    if (method === 'PATCH' || method === 'PUT') {
      if (!can(user, 'inspect')) return fail('you do not have permission to edit inspections', 403);
      return updateInspection(env, id, await request.json());
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
  if (isAppShell || isAdminShell || isAssignShell) {
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
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith('/api/');
    try {
      return isApi ? await handleApi(request, env, url) : await handleAssets(request, env, url);
    } catch (err) {
      if (isApi) return fail(err?.message || 'unexpected error', 500);
      return new Response('Service temporarily unavailable.', { status: 503 });
    }
  },
};
