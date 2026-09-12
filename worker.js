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
  await env.DB.prepare(
    `INSERT INTO inspections
       (id, inspector, facility, division, date, type, type_label, overall, filename, data)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
  ).bind(r.id, r.inspector, r.facility, r.division, r.date,
         r.type, r.type_label, r.overall, r.filename, r.data).run();
  return json({ ok: true, id: r.id }, 201);
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
  if (isAppShell || isAdminShell) {
    const user = await getUserFromRequest(request, env);
    if (!user) return Response.redirect(new URL('/login.html', url).toString(), 302);
    if (isAdminShell && user.role !== ADMIN_ROLE) {
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
