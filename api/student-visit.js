'use strict';

const shared = require('./_shared');

const VISIT_CAP = 80;

function fail(res, code, error, message) {
  shared.json(res, code, { ok: false, error, message });
}

function buildVisitStats({ studentCount, users, events, pointRows, userPointRows, recentRows }) {
  const eventTotals = {
    login: 0,
    view_tab: 0,
    view_point: 0,
    play_lecture: 0,
    view_question: 0,
  };
  for (const row of events || []) {
    const name = String(row.event || '');
    if (!Object.prototype.hasOwnProperty.call(eventTotals, name)) continue;
    eventTotals[name] = Number(row.n) || 0;
  }
  const visitTotal = Object.keys(eventTotals).reduce((sum, key) => sum + eventTotals[key], 0);
  const pointMap = new Map();
  for (const row of pointRows || []) pointMap.set(Number(row.point_id), Number(row.n) || 0);
  const points = [];
  for (let id = 1; id <= 8; id++) {
    points.push({
      pointId: id,
      name: shared.POINT_NAMES[id],
      visits: pointMap.get(id) || 0,
    });
  }
  const perUser = new Map();
  for (const row of userPointRows || []) {
    const uid = String(row.user_id);
    if (!perUser.has(uid)) perUser.set(uid, [0, 0, 0, 0, 0, 0, 0, 0]);
    const pid = Number(row.point_id);
    if (pid >= 1 && pid <= 8) perUser.get(uid)[pid - 1] = Number(row.n) || 0;
  }
  const recentMap = new Map();
  for (const row of recentRows || []) {
    const uid = String(row.user_id);
    if (!recentMap.has(uid)) recentMap.set(uid, []);
    const list = recentMap.get(uid);
    if (list.length >= 8) continue;
    const event = String(row.event || '');
    if (!Object.prototype.hasOwnProperty.call(eventTotals, event)) continue;
    list.push({
      event,
      pointId: row.point_id == null ? null : Number(row.point_id),
      detail: row.detail == null || row.detail === '' ? null : String(row.detail).slice(0, 80),
      createdAt: shared.iso(row.created_at),
    });
  }
  for (const list of recentMap.values()) {
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  const students = (users || []).slice(0, 300).map((row) => {
    const uid = String(row.id);
    return {
      id: Number(row.id),
      username: String(row.username || ''),
      displayName: row.display_name ? String(row.display_name) : null,
      createdAt: shared.iso(row.created_at),
      lastLoginAt: row.last_login_at ? shared.iso(row.last_login_at) : null,
      pointVisits: perUser.get(uid) || [0, 0, 0, 0, 0, 0, 0, 0],
      recentEvents: recentMap.get(uid) || [],
    };
  });
  const count = Number(studentCount) || 0;
  return {
    ok: true,
    studentCount: count,
    studentsTruncated: count > students.length,
    visitTotal,
    lecturePlays: eventTotals.play_lecture,
    eventTotals,
    points,
    students,
    generatedAt: new Date().toISOString(),
  };
}

async function loadStats(sql) {
  const countRows = await sql`SELECT count(*)::int AS n FROM yuejian_student_users`;
  const users = await sql`
    SELECT id, username, display_name, created_at, last_login_at
    FROM yuejian_student_users
    ORDER BY last_login_at DESC NULLS LAST, id DESC
    LIMIT 300
  `;
  const events = await sql`
    SELECT event, count(*)::int AS n
    FROM yuejian_student_visits
    GROUP BY event
  `;
  const pointRows = await sql`
    SELECT point_id, count(*)::int AS n
    FROM yuejian_student_visits
    WHERE event = 'view_point' AND point_id BETWEEN 1 AND 8
    GROUP BY point_id
  `;
  const userPointRows = await sql`
    SELECT user_id, point_id, count(*)::int AS n
    FROM yuejian_student_visits
    WHERE event = 'view_point' AND point_id BETWEEN 1 AND 8
    GROUP BY user_id, point_id
  `;
  const recentRows = await sql`
    SELECT user_id, event, point_id, detail, created_at
    FROM (
      SELECT user_id, event, point_id, detail, created_at,
             row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS rn
      FROM yuejian_student_visits
    ) ranked
    WHERE rn <= 8
  `;
  return buildVisitStats({
    studentCount: countRows && countRows[0] ? countRows[0].n : 0,
    users,
    events,
    pointRows,
    userPointRows,
    recentRows,
  });
}

async function handle(req, res, deps) {
  const getSql = (deps && deps.getSql) || shared.getSql;
  shared.setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.writableEnded = true;
    res.end();
    return;
  }

  if (req.method === 'GET') {
    if (!shared.checkPassphrase(shared.passFromReq(req, {}))) {
      return fail(res, 401, 'unauthorized', '口令不正确。');
    }
    const sql = getSql();
    await shared.ensureSchema(sql);
    const stats = await loadStats(sql);
    return shared.json(res, 200, stats);
  }

  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', '不支持的请求方式。');

  let body = {};
  try { body = await shared.readBody(req); }
  catch (e) {
    const tooBig = e && e.code === 'body_too_large';
    return fail(res, 400, tooBig ? 'body_too_large' : 'invalid_json', tooBig ? '提交内容过长。' : '请求格式不正确。');
  }

  const sql = getSql();
  await shared.ensureSchema(sql);
  const row = await shared.userFromToken(sql, shared.bearerToken(req));
  if (!row) return fail(res, 401, 'unauthorized', '请先登录。');

  let rawEvents = [];
  if (Array.isArray(body.events)) rawEvents = body.events;
  else if (body && body.event) rawEvents = [body];
  else return fail(res, 400, 'missing_events', '没有可记录的访问。');

  const events = rawEvents.slice(0, 20).map(shared.sanitizeClientEvent).filter(Boolean);
  const recent = await sql`
    SELECT count(*)::int AS n
    FROM yuejian_student_visits
    WHERE user_id = ${row.id} AND created_at > now() - interval '10 minutes'
  `;
  const recentN = Number(recent && recent[0] && recent[0].n) || 0;
  if (recentN >= VISIT_CAP) {
    return shared.json(res, 200, { ok: true, accepted: 0, ignored: events.length });
  }

  let accepted = 0;
  for (const item of events) {
    if (recentN + accepted >= VISIT_CAP) break;
    const wrote = await shared.recordVisit(sql, row.id, item.event, item.pointId, item.detail);
    if (wrote) accepted += 1;
  }
  return shared.json(res, 200, { ok: true, accepted });
}

async function handler(req, res) {
  try {
    await handle(req, res);
  } catch (e) {
    if (res.writableEnded) return;
    const missing = shared.dbError(e);
    shared.json(res, missing ? 503 : 500, {
      ok: false,
      error: missing ? 'db_not_configured' : 'server_error',
      message: missing ? '资料服务暂未就绪，请稍后再试。' : '服务器繁忙，请稍后再试。',
    });
  }
}

handler.handle = handle;
handler.buildVisitStats = buildVisitStats;
module.exports = handler;
