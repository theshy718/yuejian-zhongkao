'use strict';

const shared = require('./_shared');

function fail(res, code, error, message) {
  shared.json(res, code, { ok: false, error, message });
}

async function handle(req, res, deps) {
  const getSql = (deps && deps.getSql) || shared.getSql;
  shared.setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  let body = {};
  if (req.method === 'POST') {
    try { body = await shared.readBody(req); }
    catch (e) {
      const tooBig = e && e.code === 'body_too_large';
      return fail(res, 400, tooBig ? 'body_too_large' : 'invalid_json', tooBig ? '提交内容过长。' : '请求格式不正确。');
    }
  } else if (req.method !== 'GET') {
    return fail(res, 405, 'method_not_allowed', '不支持的请求方式。');
  }

  const action = req.method === 'GET' ? 'me' : String((body && body.action) || '').trim();
  if (!action) return fail(res, 400, 'missing_action', '请指定操作。');
  if (action !== 'register' && action !== 'login' && action !== 'logout' && action !== 'me') {
    return fail(res, 400, 'unknown_action', '不支持的操作。');
  }

  const sql = getSql();
  await shared.ensureSchema(sql);

  if (action === 'me') {
    const row = await shared.userFromToken(sql, shared.bearerToken(req));
    if (!row) return fail(res, 401, 'unauthorized', '请先登录。');
    return shared.json(res, 200, { ok: true, user: shared.publicUser(row) });
  }

  if (action === 'logout') {
    const token = shared.bearerToken(req);
    if (token) {
      const tokenHash = shared.hashToken(token);
      await sql`DELETE FROM yuejian_student_sessions WHERE token_hash = ${tokenHash}`;
    }
    return shared.json(res, 200, { ok: true });
  }

  const username = shared.validateUsername(body.username);
  if (!username.ok) return fail(res, 400, username.error, username.message);
  const password = shared.validatePassword(body.password);
  if (!password.ok) return fail(res, 400, password.error, password.message);
  let display = { ok: true, value: null };
  if (action === 'register') {
    display = shared.cleanDisplayName(body.displayName);
    if (!display.ok) return fail(res, 400, display.error, display.message);
  }

  const allowed = await shared.consumeRate(sql, shared.clientIp(req), action);
  if (!allowed) return fail(res, 429, 'rate_limited', '尝试太频繁，请稍后再试。');

  if (action === 'register') {
    const passwordHash = await shared.hashPassword(password.value);
    const existing = await shared.findUserByUsername(sql, username.value);
    if (existing) return fail(res, 409, 'username_taken', '这个用户名已被注册，请换一个。');
    let rows;
    try {
      rows = await sql`
        INSERT INTO yuejian_student_users (username, password_hash, display_name, last_login_at)
        VALUES (${username.value}, ${passwordHash}, ${display.value}, now())
        RETURNING id, username, display_name, created_at, last_login_at
      `;
    } catch (e) {
      if (shared.isUniqueViolation(e)) {
        return fail(res, 409, 'username_taken', '这个用户名已被注册，请换一个。');
      }
      throw e;
    }
    const row = rows[0];
    const token = await shared.insertSession(sql, row.id);
    await shared.recordVisit(sql, row.id, 'login', null, null);
    return shared.json(res, 200, { ok: true, token, user: shared.publicUser(row) });
  }

  const row = await shared.findUserByUsername(sql, username.value);
  const matches = row
    ? await shared.verifyPassword(password.value, row.password_hash)
    : await shared.dummyVerify(password.value).then(() => false);
  if (!row || !matches) return fail(res, 401, 'invalid_credentials', '用户名或密码不正确。');
  await sql`UPDATE yuejian_student_users SET last_login_at = now() WHERE id = ${row.id}`;
  const token = await shared.insertSession(sql, row.id);
  await shared.recordVisit(sql, row.id, 'login', null, null);
  const fresh = Object.assign({}, row, { last_login_at: new Date() });
  return shared.json(res, 200, { ok: true, token, user: shared.publicUser(fresh) });
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
module.exports = handler;
