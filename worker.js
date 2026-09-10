/**
 * Facility Experience QA — Worker API
 * Serves the static app and a small JSON API backed by Cloudflare D1.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

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

/* ── Router ─────────────────────────────────────────────── */

async function handleApi(request, env, url) {
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const method = request.method.toUpperCase();

  if (path === 'health') return json({ ok: true });
  if (path === 'export.csv' && method === 'GET') return exportCsv(env);

  if (path === 'inspections') {
    if (method === 'GET') return json(await listInspections(env));
    if (method === 'POST') return insertInspection(env, await request.json());
    return fail('method not allowed', 405);
  }

  const match = path.match(/^inspections\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    if (method === 'PATCH' || method === 'PUT') return updateInspection(env, id, await request.json());
    if (method === 'DELETE') return deleteInspection(env, id);
    return fail('method not allowed', 405);
  }

  return fail('not found', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (err) {
      return fail(err?.message || 'unexpected error', 500);
    }
  },
};
