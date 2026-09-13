/**
 * Facility Experience QA — Worker API
 * Serves the static app and a small JSON API backed by Cloudflare D1.
 */

import {
  hashPassword, verifyPassword, createSession, destroySession, getUserFromRequest,
  readCookie, sessionCookieHeader, clearCookieHeader, isLocked,
  registerFailedAttempt, clearFailedAttempts, SESSION_COOKIE,
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
    `SELECT a.quarter, a.type, a.assigned_by, b.name AS building, u.name AS auditor, o.role AS assigner_role
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
  if (a.assigned_by && !recipients.has(a.assigned_by)) {
    recipients.set(a.assigned_by, a.assigner_role === 'quality_admin' ? '#pg-overview' : null);
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

async function deleteInspection(env, id) {
  const res = await env.DB.prepare('DELETE FROM inspections WHERE id = ?1').bind(id).run();
  if (!res.meta.changes) return fail('record not found', 404);
  return json({ ok: true, id });
}

/* ── Buildings ──────────────────────────────────────────── */

async function listBuildings(env) {
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

async function listAuditors(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, username FROM qa_users WHERE role = 'quality_auditor' AND status = 'active' ORDER BY name`,
  ).all();
  return json({ auditors: results || [] });
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
  const auditor = await env.DB.prepare(
    "SELECT id FROM qa_users WHERE id = ?1 AND role = 'quality_auditor'",
  ).bind(auditorId).first();
  if (!auditor) return fail('auditor not found', 404);
  const building = await env.DB.prepare('SELECT id, name FROM buildings WHERE id = ?1').bind(buildingId).first();
  if (!building) return fail('building not found', 404);

  const existing = await env.DB.prepare(
    'SELECT auditor_id FROM assignments WHERE building_id = ?1 AND quarter = ?2 AND type = ?3',
  ).bind(buildingId, quarter, type).first();

  await env.DB.prepare(
    `INSERT INTO assignments (building_id, auditor_id, quarter, type, assigned_by)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(building_id, quarter, type)
     DO UPDATE SET auditor_id = excluded.auditor_id, assigned_by = excluded.assigned_by, updated_at = datetime('now')`,
  ).bind(buildingId, auditorId, quarter, type, officer.id).run();

  if (!existing || existing.auditor_id !== auditorId) {
    await notify(
      env, auditorId, 'assignment',
      `New assignment: ${building.name}`,
      `${officer.name} assigned you ${building.name} for ${quarter} ${type}.`,
      '#pg-assignments',
    );
  }

  return json({ ok: true });
}

async function deleteAssignment(env, id) {
  const res = await env.DB.prepare('DELETE FROM assignments WHERE id = ?1').bind(id).run();
  if (!res.meta.changes) return fail('assignment not found', 404);
  return json({ ok: true });
}

async function listMyAssignments(env, auditorId, quarter, type) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.building_id, b.name as building_name, b.division, b.area, b.location
     FROM assignments a JOIN buildings b ON b.id = a.building_id
     WHERE a.auditor_id = ?1 AND a.quarter = ?2 AND a.type = ?3
     ORDER BY b.division, b.area, b.name`,
  ).bind(auditorId, quarter, type).all();
  const completedIds = await completedAssignmentIds(env);

  const assignments = (results || []).map((a) => ({
    id: a.id, buildingId: a.building_id, buildingName: a.building_name,
    division: a.division, area: a.area, location: a.location,
    completed: completedIds.has(a.id),
  }));
  return json({ quarter, type, assignments });
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
  const auditors = users.filter((x) => x.role === 'quality_auditor').map((x) => {
    const mine = scopedAssignments.filter((y) => y.auditor_id === x.id);
    const done = mine.filter(isDone);
    const scores = done.map((y) => scoreByAssignment.get(y.id)).filter((n) => typeof n === 'number');
    return { id: x.id, name: x.name, status: x.status, assigned: mine.length, completed: done.length, avgScore: average(scores) };
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

  if (path === 'assignments/mine' && method === 'GET') {
    const quarter = url.searchParams.get('quarter') || '';
    const type = url.searchParams.get('type') || '';
    if (!quarter || !ASSIGNMENT_TYPES.has(type)) return fail('quarter and a valid type (BOQI/EOQI) are required', 400);
    return listMyAssignments(env, user.id, quarter, type);
  }

  const canManage = user.role === 'quality_officer' || user.role === ADMIN_ROLE;
  const canView = canManage || user.role === 'quality_leader';

  if (path === 'assignments/auditors' && method === 'GET') {
    if (!canManage) return fail('you do not have permission to view this', 403);
    return listAuditors(env);
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
  const head = ['ID', 'Inspector', 'Facility', 'Division', 'Date',
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
  return json(
    { ok: true, user: { id, name, username, role: ADMIN_ROLE, canEdit: true, canDelete: true, canExport: true } },
    201,
    { 'Set-Cookie': sessionCookieHeader(token, expiresAt) },
  );
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    canEdit: !!user.can_edit,
    canDelete: !!user.can_delete,
    canExport: !!user.can_export,
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
    return fail('invalid username or password', 401);
  }

  await clearFailedAttempts(env, user.id);

  if (user.must_change_password) {
    return json({ ok: true, mustChangePassword: true, username: user.username });
  }

  const { token, expiresAt } = await createSession(env, user.id);
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
    `SELECT id, name, username, role, status, can_edit, can_delete, can_export, must_change_password, created_at
     FROM qa_users ORDER BY created_at ASC`,
  ).all();
  const users = (results || []).map((u) => ({
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    status: u.status,
    canEdit: !!u.can_edit,
    canDelete: !!u.can_delete,
    canExport: !!u.can_export,
    mustChangePassword: !!u.must_change_password,
    createdAt: u.created_at,
  }));
  return json({ users });
}

async function adminCreateUser(env, body) {
  const name = (body?.name || '').trim();
  const username = (body?.username || '').trim().toLowerCase();
  const password = body?.password || '';
  const role = ALL_ROLES.has(body?.role) ? body.role : 'quality_auditor';
  if (!name || !username || password.length < MIN_PASSWORD_LENGTH) {
    return fail(`name, username, and a temporary password of at least ${MIN_PASSWORD_LENGTH} characters are required`, 400);
  }
  const existing = await env.DB.prepare('SELECT id FROM qa_users WHERE username = ?1').bind(username).first();
  if (existing) return fail('that username is already taken', 409);

  const canEdit = body?.canEdit !== false ? 1 : 0;
  const canDelete = body?.canDelete === true ? 1 : 0;
  const canExport = body?.canExport !== false ? 1 : 0;

  const { hash, salt, iterations, rounds } = await hashPassword(password);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO qa_users
       (id, name, username, password_hash, password_salt, password_iterations, password_rounds,
        role, can_edit, can_delete, can_export, must_change_password)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1)`,
  ).bind(id, name, username, hash, salt, iterations, rounds, role, canEdit, canDelete, canExport).run();

  return json({ ok: true, id }, 201);
}

async function adminUpdateUser(env, actingUser, targetId, body) {
  if (targetId === actingUser.id) return fail('use your account settings to change your own access', 400);
  const target = await env.DB.prepare('SELECT id, role FROM qa_users WHERE id = ?1').bind(targetId).first();
  if (!target) return fail('user not found', 404);

  const sets = [];
  const values = [targetId];
  let n = 2;
  if (typeof body?.canEdit === 'boolean') { sets.push(`can_edit = ?${n++}`); values.push(body.canEdit ? 1 : 0); }
  if (typeof body?.canDelete === 'boolean') { sets.push(`can_delete = ?${n++}`); values.push(body.canDelete ? 1 : 0); }
  if (typeof body?.canExport === 'boolean') { sets.push(`can_export = ?${n++}`); values.push(body.canExport ? 1 : 0); }
  if (body?.status === 'active' || body?.status === 'suspended') { sets.push(`status = ?${n++}`); values.push(body.status); }
  if (ALL_ROLES.has(body?.role)) { sets.push(`role = ?${n++}`); values.push(body.role); }
  if (!sets.length) return fail('nothing to update', 400);
  sets.push(`updated_at = datetime('now')`);

  await env.DB.prepare(`UPDATE qa_users SET ${sets.join(', ')} WHERE id = ?1`).bind(...values).run();
  return json({ ok: true });
}

async function adminResetPassword(env, actingUser, targetId, body) {
  if (targetId === actingUser.id) return fail('use "Change Password" in your account menu instead', 400);
  const password = body?.password || '';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return fail(`temporary password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
  }
  const { hash, salt, iterations, rounds } = await hashPassword(password);
  const res = await env.DB.prepare(
    `UPDATE qa_users SET password_hash = ?2, password_salt = ?3, password_iterations = ?4, password_rounds = ?5,
       must_change_password = 1, failed_attempts = 0, locked_until = NULL, updated_at = datetime('now')
     WHERE id = ?1`,
  ).bind(targetId, hash, salt, iterations, rounds).run();
  if (!res.meta.changes) return fail('user not found', 404);
  await env.DB.prepare('DELETE FROM qa_sessions WHERE user_id = ?1').bind(targetId).run();
  return json({ ok: true });
}

async function adminDeleteUser(env, actingUser, targetId) {
  if (targetId === actingUser.id) return fail('you cannot delete your own account', 400);
  const target = await env.DB.prepare('SELECT role FROM qa_users WHERE id = ?1').bind(targetId).first();
  if (!target) return fail('user not found', 404);
  if (target.role === ADMIN_ROLE) {
    const { c } = await env.DB.prepare('SELECT COUNT(*) as c FROM qa_users WHERE role = ?1').bind(ADMIN_ROLE).first();
    if (c <= 1) return fail('cannot delete the last administrator', 400);
  }
  await env.DB.prepare('DELETE FROM qa_users WHERE id = ?1').bind(targetId).run();
  await env.DB.prepare('DELETE FROM qa_sessions WHERE user_id = ?1').bind(targetId).run();
  return json({ ok: true });
}

async function handleAdmin(request, env, path, user) {
  const method = request.method.toUpperCase();
  if (!path.startsWith('admin/')) return null;
  if (!user || user.role !== ADMIN_ROLE) return fail('administrator access required', 403);

  if (path === 'admin/users' && method === 'GET') return adminListUsers(env);
  if (path === 'admin/users' && method === 'POST') return adminCreateUser(env, await request.json());

  const idMatch = path.match(/^admin\/users\/([^/]+)$/);
  if (idMatch && method === 'PATCH') return adminUpdateUser(env, user, idMatch[1], await request.json());
  if (idMatch && method === 'DELETE') return adminDeleteUser(env, user, idMatch[1]);

  const resetMatch = path.match(/^admin\/users\/([^/]+)\/reset-password$/);
  if (resetMatch && method === 'POST') return adminResetPassword(env, user, resetMatch[1], await request.json());

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
    if (!user.can_export) return fail('you do not have permission to export data', 403);
    return exportCsv(env);
  }

  if (path === 'buildings' && method === 'GET') return listBuildings(env);

  if (path === 'reports/inspections' && method === 'GET') return reportInspections(env);

  if (path === 'leader/overview' && method === 'GET') {
    if (user.role !== 'quality_leader' && user.role !== ADMIN_ROLE) {
      return fail('you do not have permission to view the team overview', 403);
    }
    return leaderOverview(env, url);
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
      if (!user.can_edit) return fail('you do not have permission to create inspections', 403);
      return insertInspection(env, await request.json());
    }
    return fail('method not allowed', 405);
  }

  const match = path.match(/^inspections\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    if (method === 'PATCH' || method === 'PUT') {
      if (!user.can_edit) return fail('you do not have permission to edit inspections', 403);
      return updateInspection(env, id, await request.json());
    }
    if (method === 'DELETE') {
      if (!user.can_delete) return fail('you do not have permission to delete inspections', 403);
      return deleteInspection(env, id);
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
    if (isAdminShell && user.role !== ADMIN_ROLE) {
      return Response.redirect(new URL('/app.html', url).toString(), 302);
    }
    if (isAssignShell && user.role !== 'quality_officer' && user.role !== ADMIN_ROLE) {
      return Response.redirect(new URL('/app.html', url).toString(), 302);
    }
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
