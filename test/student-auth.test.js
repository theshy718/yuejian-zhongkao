'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const shared = require('../api/_shared');
const auth = require('../api/student-auth');
const visit = require('../api/student-visit');

const root = path.join(__dirname, '..');

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = String(v); },
    end(body) {
      this.raw = body == null ? '' : String(body);
      this.json = this.raw ? JSON.parse(this.raw) : null;
      this.writableEnded = true;
    },
  };
}

function mockReq({ method = 'POST', body = {}, headers = {}, query = {} } = {}) {
  return { method, body, headers, query };
}

function authSql(state) {
  state.visits = state.visits || [];
  return async function sql(strings, ...vals) {
    const q = strings.join(' ').replace(/\s+/g, ' ').toLowerCase();
    if (q.includes('create table') || q.includes('create index') || q.includes('create unique index')) return [];
    if (q.includes('delete from yuejian_student_rate')) return [];
    if (q.includes('delete from yuejian_student_sessions')) {
      if (vals.length) state.deletedSession = vals[0];
      return [];
    }
    if (q.includes('from yuejian_student_rate') && q.includes('count')) {
      return [{ n: state.rateCount || 0 }];
    }
    if (q.includes('insert into yuejian_student_rate')) return [];
    if (q.includes('from yuejian_student_sessions') && q.includes('join')) {
      return state.sessionUser ? [state.sessionUser] : [];
    }
    if (q.includes('from yuejian_student_users') && q.includes('password_hash')) {
      return state.user ? [state.user] : [];
    }
    if (q.includes('insert into yuejian_student_users')) {
      if (state.duplicate) {
        const err = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        throw err;
      }
      state.insertedUser = { vals };
      return [{
        id: 7,
        username: vals[0],
        display_name: vals[2],
        created_at: new Date('2026-11-16T00:00:00.000Z'),
        last_login_at: new Date('2026-11-16T00:00:00.000Z'),
      }];
    }
    if (q.includes('update yuejian_student_users')) {
      state.updatedLogin = vals[0];
      return [];
    }
    if (q.includes('insert into yuejian_student_sessions')) {
      state.session = { userId: vals[0], tokenHash: vals[1], expiresAt: vals[2] };
      return [];
    }
    if (q.includes('from yuejian_student_visits') && q.includes('interval \'20 seconds\'')) return [];
    if (q.includes('insert into yuejian_student_visits')) {
      state.visits.push({ userId: vals[0], event: vals[1], pointId: vals[2], detail: vals[3] });
      return [];
    }
    throw new Error('unhandled sql: ' + q);
  };
}

function walkKeys(value, found) {
  if (Array.isArray(value)) {
    value.forEach((item) => walkKeys(item, found));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      found.push(key);
      walkKeys(inner, found);
    }
  }
}

function assertNoPasswordMaterial(payload, rawToken) {
  const keys = [];
  walkKeys(payload, keys);
  for (const key of keys) {
    assert.equal(/password|passphrase|token_hash|password_hash|secret/i.test(key), false, key);
  }
  const raw = JSON.stringify(payload);
  assert.equal(raw.includes('scrypt$'), false);
  if (rawToken) assert.equal(raw.includes(shared.hashToken(rawToken)), false);
}

test('username and password rules', () => {
  assert.equal(shared.validateUsername('ab').ok, true);
  assert.equal(shared.validateUsername(' 小明 ').value, '小明');
  assert.equal(shared.validateUsername('user_name').ok, true);
  assert.equal(shared.validateUsername('a').ok, false);
  assert.equal(shared.validateUsername('user name').ok, false);
  assert.equal(shared.validateUsername('user-name').ok, false);
  assert.equal(shared.validateUsername('a'.repeat(21)).ok, false);
  assert.equal(shared.validateUsername(123).ok, false);
  assert.equal(shared.validatePassword('1234567').ok, false);
  assert.equal(shared.validatePassword('12345678').ok, true);
  assert.equal(shared.validatePassword('x'.repeat(129)).ok, false);
  assert.equal(shared.cleanDisplayName('').value, null);
  assert.equal(shared.cleanDisplayName('同学').value, '同学');
  assert.equal(shared.cleanDisplayName('名'.repeat(21)).ok, false);
});

test('passwords are scrypt hashes and tokens are hashed', async () => {
  const a = await shared.hashPassword('correct-horse');
  const b = await shared.hashPassword('correct-horse');
  assert.notEqual(a, b);
  assert.equal(a.startsWith('scrypt$'), true);
  assert.equal(a.includes('correct-horse'), false);
  assert.equal(await shared.verifyPassword('correct-horse', a), true);
  assert.equal(await shared.verifyPassword('wrong-horse', a), false);
  const token = shared.newSessionToken();
  const hashed = shared.hashToken(token);
  assert.notEqual(hashed, token);
  assert.equal(hashed.length, 64);
});

test('cors allows the student site and rejects wildcards', () => {
  const ok = mockRes();
  shared.setCors(mockReq({ headers: { origin: 'https://theshy718.github.io' } }), ok);
  assert.equal(ok.headers['access-control-allow-origin'], 'https://theshy718.github.io');
  assert.match(ok.headers['access-control-allow-headers'], /Authorization/);
  assert.match(ok.headers['access-control-allow-headers'], /X-Yuejian-Pass/);
  assert.equal(ok.headers['access-control-allow-origin'].includes('*'), false);

  const bad = mockRes();
  shared.setCors(mockReq({ headers: { origin: 'https://evil.example' } }), bad);
  assert.equal(bad.headers['access-control-allow-origin'], undefined);

  const prefixed = mockRes();
  shared.setCors(mockReq({ headers: { origin: 'https://theshy718.github.io.evil.com' } }), prefixed);
  assert.equal(prefixed.headers['access-control-allow-origin'], undefined);

  const local = mockRes();
  shared.setCors(mockReq({ headers: { origin: 'http://localhost:8876' } }), local);
  assert.equal(local.headers['access-control-allow-origin'], 'http://localhost:8876');
});

test('register stores a hash, returns a bearer token, and records login', async () => {
  const state = {};
  const res = mockRes();
  await auth.handle(mockReq({
    body: { action: 'register', username: '小明', password: 'secret-pass', displayName: '明明' },
    headers: { origin: 'https://theshy718.github.io' },
  }), res, { getSql: () => authSql(state) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.user.username, '小明');
  assert.equal(res.json.user.displayName, '明明');
  assert.equal(typeof res.json.token, 'string');
  assert.equal(state.insertedUser.vals[1].startsWith('scrypt$'), true);
  assert.notEqual(state.insertedUser.vals[1], 'secret-pass');
  assert.equal(state.session.tokenHash, shared.hashToken(res.json.token));
  assert.equal(state.visits[0].event, 'login');
  assertNoPasswordMaterial(res.json, res.json.token);
  assert.equal(JSON.stringify(res.json).includes('secret-pass'), false);
});

test('duplicate username is rejected in Chinese', async () => {
  const state = { user: { id: 1, username: '小明', password_hash: 'scrypt$x', display_name: null } };
  const res = mockRes();
  await auth.handle(mockReq({
    body: { action: 'register', username: '小明', password: 'secret-pass' },
  }), res, { getSql: () => authSql(state) });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json.message, '这个用户名已被注册，请换一个。');
  assert.equal(state.insertedUser, undefined);
});

test('login accepts the same password and logout drops the session', async () => {
  const passwordHash = await shared.hashPassword('secret-pass');
  const state = {
    user: {
      id: 7,
      username: '小明',
      password_hash: passwordHash,
      display_name: null,
      created_at: new Date('2026-11-16T00:00:00.000Z'),
      last_login_at: null,
    },
  };
  const res = mockRes();
  await auth.handle(mockReq({
    body: { action: 'login', username: '小明', password: 'secret-pass' },
  }), res, { getSql: () => authSql(state) });
  assert.equal(res.statusCode, 200);
  assert.equal(state.session.tokenHash, shared.hashToken(res.json.token));
  assert.equal(state.visits.some((v) => v.event === 'login'), true);
  assertNoPasswordMaterial(res.json, res.json.token);

  const bad = mockRes();
  await auth.handle(mockReq({
    body: { action: 'login', username: '小明', password: 'nope-pass' },
  }), bad, { getSql: () => authSql(state) });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.json.message, '用户名或密码不正确。');

  const missing = mockRes();
  const empty = {};
  await auth.handle(mockReq({
    body: { action: 'login', username: '别人', password: 'secret-pass' },
  }), missing, { getSql: () => authSql(empty) });
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.json.message, '用户名或密码不正确。');

  const out = mockRes();
  await auth.handle(mockReq({
    body: { action: 'logout' },
    headers: { authorization: 'Bearer ' + res.json.token },
  }), out, { getSql: () => authSql(state) });
  assert.equal(out.statusCode, 200);
  assert.equal(state.deletedSession, shared.hashToken(res.json.token));
});

test('me requires a session and rate limit blocks stuffing', async () => {
  const state = {};
  const res = mockRes();
  await auth.handle(mockReq({
    body: { action: 'me' },
  }), res, { getSql: () => authSql(state) });
  assert.equal(res.statusCode, 401);

  const limited = mockRes();
  await auth.handle(mockReq({
    body: { action: 'login', username: '小明', password: 'secret-pass' },
  }), limited, { getSql: () => authSql({ rateCount: 20 }) });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json.message, '尝试太频繁，请稍后再试。');
});

test('client visit events keep point names and drop search-like text', () => {
  const point = shared.sanitizeClientEvent({ event: 'view_point', pointId: 2, detail: '随意搜索词 背影 情感' });
  assert.equal(point.detail, '揣摩人物内心 + 分析人物形象');
  assert.equal(point.pointId, 2);
  assert.equal(shared.sanitizeClientEvent({ event: 'login' }), null);
  assert.equal(shared.sanitizeClientEvent({ event: 'view_tab', detail: '全文搜索：背影' }), null);
  assert.deepEqual(shared.sanitizeClientEvent({ event: 'view_tab', detail: 'points' }), {
    event: 'view_tab', pointId: null, detail: 'points',
  });
  const question = shared.sanitizeClientEvent({
    event: 'view_question',
    detail: '请概括这篇文章的主要内容并且写出依据',
  });
  assert.equal(question.detail, null);
  assert.equal(shared.sanitizeClientEvent({
    event: 'view_question',
    detail: 'YT2024-微弱的光亮-17',
  }).detail, 'YT2024-微弱的光亮-17');
  assert.equal(shared.sanitizeClientEvent({
    event: 'view_question',
    detail: 'AH2025-海一样的棉田里，我像只船-8',
  }).detail, 'AH2025-海一样的棉田里，我像只船-8');
  assert.equal(shared.sanitizeClientEvent({ event: 'play_lecture', detail: 'typed query' }).detail, '记叙文阅读八考点');
});

test('teacher stats omit password material and count the eight points', () => {
  const stats = visit.buildVisitStats({
    studentCount: 1,
    users: [{
      id: 3,
      username: '小明',
      display_name: '明明',
      password_hash: 'scrypt$should-not-leak',
      token_hash: 'abc',
      created_at: '2026-11-16T01:00:00.000Z',
      last_login_at: '2026-11-16T02:00:00.000Z',
    }],
    events: [
      { event: 'login', n: 1 },
      { event: 'view_point', n: 2 },
      { event: 'play_lecture', n: 4 },
    ],
    pointRows: [{ point_id: 1, n: 2 }],
    userPointRows: [{ user_id: 3, point_id: 1, n: 2 }],
    recentRows: [{
      user_id: 3,
      event: 'view_point',
      point_id: 1,
      detail: '文章内容理解与概括',
      created_at: '2026-11-16T03:00:00.000Z',
    }],
  });
  assert.equal(stats.studentCount, 1);
  assert.equal(stats.lecturePlays, 4);
  assert.equal(stats.points.length, 8);
  assert.equal(stats.points[0].visits, 2);
  assert.equal(stats.points[1].name, '揣摩人物内心 + 分析人物形象');
  assert.equal(stats.students[0].pointVisits[0], 2);
  assert.equal(stats.students[0].recentEvents[0].event, 'view_point');
  assertNoPasswordMaterial(stats);
  assert.equal(JSON.stringify(stats).includes('should-not-leak'), false);
});

function visitSql(state) {
  state.visits = state.visits || [];
  return async function sql(strings, ...vals) {
    const q = strings.join(' ').replace(/\s+/g, ' ').toLowerCase();
    if (q.includes('create table') || q.includes('create index') || q.includes('create unique index')) return [];
    if (q.includes('from yuejian_student_sessions') && q.includes('join')) {
      return state.sessionUser ? [state.sessionUser] : [];
    }
    if (q.includes('interval \'10 minutes\'')) return [{ n: state.recentVisitCount || 0 }];
    if (q.includes('interval \'20 seconds\'')) {
      const hit = state.visits.find((item) => item.userId === vals[0] && item.event === vals[1] && item.pointId === vals[2]);
      return hit ? [{ id: 1 }] : [];
    }
    if (q.includes('insert into yuejian_student_visits')) {
      state.visits.push({ userId: vals[0], event: vals[1], pointId: vals[2], detail: vals[3] });
      return [];
    }
    if (q.includes('from yuejian_student_users') && q.includes('count')) return [{ n: state.studentCount || 0 }];
    if (q.includes('from yuejian_student_users') && q.includes('order by')) return state.userRows || [];
    if (q.includes('group by event')) return state.events || [];
    if (q.includes('group by user_id, point_id')) return state.userPointRows || [];
    if (q.includes('group by point_id')) return state.pointRows || [];
    if (q.includes('row_number') || q.includes('ranked')) return state.recentRows || [];
    throw new Error('unhandled sql: ' + q);
  };
}

test('visit post is authenticated and teacher get requires the pass', async () => {
  const state = {
    sessionUser: {
      id: 3,
      username: '小明',
      display_name: null,
      created_at: new Date(),
      last_login_at: new Date(),
    },
  };
  const denied = mockRes();
  await visit.handle(mockReq({
    body: { events: [{ event: 'view_point', pointId: 1 }] },
  }), denied, { getSql: () => visitSql(state) });
  assert.equal(denied.statusCode, 401);

  const ok = mockRes();
  await visit.handle(mockReq({
    headers: { authorization: 'Bearer ' + shared.newSessionToken() },
    body: { events: [{ event: 'view_point', pointId: 1, detail: '搜索词不该入库' }, { event: 'play_lecture' }] },
  }), ok, { getSql: () => visitSql(state) });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json.accepted, 2);
  assert.equal(state.visits[0].detail, '文章内容理解与概括');
  assert.equal(state.visits[1].event, 'play_lecture');

  const again = mockRes();
  await visit.handle(mockReq({
    headers: { authorization: 'Bearer ' + shared.newSessionToken() },
    body: { events: [{ event: 'view_point', pointId: 1 }] },
  }), again, { getSql: () => visitSql(state) });
  assert.equal(again.json.accepted, 0);

  const hammer = mockRes();
  await visit.handle(mockReq({
    headers: { authorization: 'Bearer ' + shared.newSessionToken() },
    body: { events: [{ event: 'view_tab', detail: 'texts' }] },
  }), hammer, { getSql: () => visitSql({ ...state, visits: [], recentVisitCount: 80 }) });
  assert.equal(hammer.json.accepted, 0);

  const noPass = mockRes();
  let queried = false;
  await visit.handle(mockReq({ method: 'GET' }), noPass, {
    getSql() { queried = true; return visitSql(state); },
  });
  assert.equal(noPass.statusCode, 401);
  assert.equal(queried, false);

  const stats = mockRes();
  await visit.handle(mockReq({
    method: 'GET',
    headers: { 'x-yuejian-pass': shared.expectedPass() },
  }), stats, {
    getSql: () => visitSql({
      studentCount: 1,
      userRows: [{
        id: 3,
        username: '小明',
        display_name: null,
        password_hash: 'scrypt$nope',
        created_at: new Date(),
        last_login_at: new Date(),
      }],
      events: [{ event: 'view_point', n: 1 }],
      pointRows: [{ point_id: 1, n: 1 }],
      userPointRows: [{ user_id: 3, point_id: 1, n: 1 }],
      recentRows: [],
    }),
  });
  assert.equal(stats.statusCode, 200);
  assert.equal(stats.json.studentCount, 1);
  assert.equal(stats.json.points.length, 8);
  assertNoPasswordMaterial(stats.json);
});

test('database failure stays a 503 without a password echo', async (t) => {
  if (process.env.DATABASE_URL || process.env.DATABASE_URL_P1) {
    t.skip('database is configured');
    return;
  }
  const res = mockRes();
  await auth(mockReq({
    body: { action: 'register', username: '小明', password: 'secret-pass' },
  }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.json.error, 'db_not_configured');
  assert.equal(JSON.stringify(res.json).includes('secret-pass'), false);
});

test('responses do not assign the read-only writableEnded property', async () => {
  function lockedRes() {
    let ended = false;
    const res = {
      statusCode: 0,
      headersSent: false,
      setHeader() {},
      end() { ended = true; },
    };
    Object.defineProperty(res, 'writableEnded', {
      configurable: false,
      enumerable: true,
      get() { return ended; },
    });
    return res;
  }
  const sent = lockedRes();
  shared.json(sent, 200, { ok: true });
  assert.equal(sent.statusCode, 200);
  assert.equal(sent.writableEnded, true);
  shared.json(sent, 500, { ok: false });
  assert.equal(sent.statusCode, 200);

  const authOpt = lockedRes();
  await auth.handle(mockReq({ method: 'OPTIONS' }), authOpt, {
    getSql() { throw new Error('no db'); },
  });
  assert.equal(authOpt.statusCode, 204);
  assert.equal(authOpt.writableEnded, true);

  const visitOpt = lockedRes();
  await visit.handle(mockReq({ method: 'OPTIONS' }), visitOpt, {
    getSql() { throw new Error('no db'); },
  });
  assert.equal(visitOpt.statusCode, 204);
  assert.equal(visitOpt.writableEnded, true);
});

test('pages gate the library and keep the lecture on the points tab', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const teacherHtml = fs.readFileSync(path.join(root, 'teacher', 'index.html'), 'utf8');
  const teacherApp = fs.readFileSync(path.join(root, 'teacher', 'app.js'), 'utf8');
  const gate = html.indexOf('id="auth-gate"');
  const home = html.indexOf('id="student-home"');
  const lecture = html.indexOf('id="point-lecture"');
  assert.ok(gate > 0 && home > gate && lecture > home);
  assert.match(html, /id="student-home"[^>]*hidden/);
  assert.match(html, /app\.js\?v=/);
  assert.match(html, /style\.css\?v=/);
  assert.match(html, /id="logout"/);
  assert.match(app, /function trackVisit/);
  assert.match(app, /localStorage/);
  assert.equal(app.includes('trackVisit') && app.includes("$('#search').value"), true);
  const trackStart = app.indexOf('function trackVisit');
  const trackEnd = app.indexOf('function flushVisits');
  const trackBody = app.slice(trackStart, trackEnd);
  assert.equal(trackBody.includes('#search'), false);
  assert.equal(trackBody.includes('keydown'), false);
  assert.match(teacherHtml, /访问数据/);
  assert.match(teacherHtml, /app\.js\?v=/);
  assert.match(teacherHtml, /style\.css\?v=/);
  assert.match(teacherApp, /loadVisits/);
  assert.match(teacherApp, /X-Yuejian-Pass/);
});
