'use strict';

const crypto = require('crypto');

function env(name) {
  return process.env[name] || '';
}

function dbUrlBase() {
  return ['DATABASE', 'URL'].join('_');
}

const ALLOWED_ORIGINS = new Set([
  'https://theshy718.github.io',
  'https://yuejian-zhongkao.vercel.app',
  'http://localhost:8876',
  'http://127.0.0.1:8876',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const USER_RE = /^[A-Za-z0-9_\u4e00-\u9fff]{2,20}$/;
const RATE_LIMITS = { register: 8, login: 20 };
const POINT_NAMES = [
  '',
  '文章内容理解与概括',
  '揣摩人物内心 + 分析人物形象',
  '把握作者情感态度',
  '关键语句含义理解',
  '记叙顺序判断及作用',
  '标题的含义与作用',
  '梳理情节、人物心理变化',
  '描写方法判断及其作用',
];
const TAB_NAMES = new Set(['texts', 'questions', 'points']);
const QUESTION_ID_RE = /^(?=.*[A-Za-z0-9])[A-Za-z0-9_\u4e00-\u9fff.，-]{1,80}$/;

function corsOrigin(req) {
  const origin = String((req.headers && req.headers.origin) || '');
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return '';
}

function setCors(req, res) {
  const origin = corsOrigin(req);
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Yuejian-Pass, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function json(res, code, obj) {
  if (res.writableEnded || res.headersSent) return;
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    if (!req.body) return Promise.resolve({});
    try { return Promise.resolve(JSON.parse(req.body)); }
    catch (e) { return Promise.reject(Object.assign(new Error('invalid_json'), { code: 'invalid_json' })); }
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 32 * 1024) {
        reject(Object.assign(new Error('body_too_large'), { code: 'body_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(Object.assign(new Error('invalid_json'), { code: 'invalid_json' })); }
    });
    req.on('error', reject);
  });
}

function joinParts(base, max) {
  let joined = '';
  for (let i = 1; i <= max; i++) {
    const part = env(base + '_P' + i);
    if (!part) break;
    joined += part;
  }
  return joined;
}

function sanitizeDbUrl(url) {
  if (!url) return '';
  return url.replace(/([?&])channel_binding=require&?/, '$1').replace(/[?&]$/, '');
}

function databaseUrl() {
  const base = dbUrlBase();
  const joined = joinParts(base, 32);
  if (joined.length >= 20) return sanitizeDbUrl(joined);
  const direct = env(base);
  if (direct && direct.length >= 20) return sanitizeDbUrl(direct);
  return sanitizeDbUrl(joined || '');
}

let sqlClient = null;
function getSql() {
  if (sqlClient) return sqlClient;
  const url = databaseUrl();
  if (!url) {
    const err = new Error('db_not_configured');
    err.code = 'db_not_configured';
    throw err;
  }
  // eslint-disable-next-line global-require
  const { neon } = require('@neondatabase/serverless');
  sqlClient = neon(url);
  return sqlClient;
}

let schemaSql = null;
let schemaReady = null;
function resetSchemaForTests() {
  schemaSql = null;
  schemaReady = null;
  sqlClient = null;
}

async function runSchema(sql) {
  await sql`CREATE TABLE IF NOT EXISTS yuejian_student_users (
    id bigserial PRIMARY KEY,
    username text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    display_name text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz
  )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS yuejian_student_users_username_lower_idx
    ON yuejian_student_users (lower(username))`;
  await sql`CREATE TABLE IF NOT EXISTS yuejian_student_sessions (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES yuejian_student_users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS yuejian_student_sessions_user_idx
    ON yuejian_student_sessions (user_id)`;
  await sql`CREATE TABLE IF NOT EXISTS yuejian_student_visits (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES yuejian_student_users(id) ON DELETE CASCADE,
    event text NOT NULL,
    point_id smallint,
    detail text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (point_id IS NULL OR (point_id BETWEEN 1 AND 8))
  )`;
  await sql`CREATE INDEX IF NOT EXISTS yuejian_student_visits_user_created_idx
    ON yuejian_student_visits (user_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS yuejian_student_visits_event_point_idx
    ON yuejian_student_visits (event, point_id)`;
  await sql`CREATE TABLE IF NOT EXISTS yuejian_student_rate (
    id bigserial PRIMARY KEY,
    ip_hash text NOT NULL,
    action text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS yuejian_student_rate_lookup_idx
    ON yuejian_student_rate (action, ip_hash, created_at)`;
}

function ensureSchema(sql) {
  if (schemaSql !== sql) {
    schemaSql = sql;
    schemaReady = null;
  }
  if (!schemaReady) {
    schemaReady = runSchema(sql).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

function expectedPass() {
  const expected = env(['YUEJIAN', 'TEACHER', 'PASS'].join('_'));
  return expected || 'yuejian-laoshi';
}

function checkPassphrase(got) {
  return String(got || '').trim() === expectedPass();
}

function passFromReq(req, body) {
  const q = (req && req.query) || {};
  const header = (req && req.headers && (req.headers['x-yuejian-pass'] || req.headers['X-Yuejian-Pass'])) || '';
  return (
    (body && body.passphrase) ||
    q.pass ||
    q.passphrase ||
    header ||
    ''
  );
}

function clientIp(req) {
  const headers = (req && req.headers) || {};
  const xf = headers['x-forwarded-for'];
  if (xf) {
    const first = String(xf).split(',')[0].trim();
    if (first) return first.slice(0, 80);
  }
  if (headers['x-real-ip']) return String(headers['x-real-ip']).trim().slice(0, 80);
  return 'unknown';
}

function ipHash(ip) {
  return crypto.createHash('sha256').update('yuejian-rate:' + String(ip || 'unknown')).digest('hex');
}

function validateUsername(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'invalid_username', message: '用户名需为 2–20 位，只能包含字母、数字、下划线或中文。' };
  }
  const value = raw.trim().normalize('NFC');
  if (value.length < 2 || value.length > 20 || !USER_RE.test(value)) {
    return { ok: false, error: 'invalid_username', message: '用户名需为 2–20 位，只能包含字母、数字、下划线或中文。' };
  }
  return { ok: true, value };
}

function validatePassword(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'invalid_password', message: '密码至少 8 位。' };
  }
  if (raw.length < 8) return { ok: false, error: 'invalid_password', message: '密码至少 8 位。' };
  if (raw.length > 128) return { ok: false, error: 'invalid_password', message: '密码过长，请控制在 128 位以内。' };
  return { ok: true, value: raw };
}

function cleanDisplayName(raw) {
  if (raw == null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_display_name', message: '显示名最多 20 个字。' };
  const value = raw.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  if (!value) return { ok: true, value: null };
  if (value.length > 20) return { ok: false, error: 'invalid_display_name', message: '显示名最多 20 个字。' };
  return { ok: true, value };
}

function scryptKey(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: 64 * 1024 * 1024,
    }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptKey(password, salt);
  return [
    'scrypt',
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch (e) {
    return false;
  }
  if (salt.length < 8 || expected.length !== SCRYPT_KEYLEN) return false;
  const key = await scryptKey(password, salt);
  if (key.length !== expected.length) return false;
  return crypto.timingSafeEqual(key, expected);
}

let dummyHashPromise = null;
function dummyVerify(password) {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('yuejian-dummy-password');
  return dummyHashPromise.then((stored) => verifyPassword(password, stored));
}

function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function bearerToken(req) {
  const headers = (req && req.headers) || {};
  const raw = headers.authorization || headers.Authorization || '';
  const m = /^Bearer\s+(\S+)$/i.exec(String(raw).trim());
  if (!m) return '';
  const token = m[1].trim();
  if (token.length < 20 || token.length > 200) return '';
  return token;
}

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString();
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: String(row.username || ''),
    displayName: row.display_name ? String(row.display_name) : null,
    createdAt: iso(row.created_at),
    lastLoginAt: row.last_login_at ? iso(row.last_login_at) : null,
  };
}

function isUniqueViolation(err) {
  if (!err) return false;
  if (err.code === '23505') return true;
  return /duplicate key/i.test(String(err.message || ''));
}

async function consumeRate(sql, ip, action) {
  const limit = RATE_LIMITS[action];
  if (!limit) return true;
  const hashed = ipHash(ip);
  await sql`DELETE FROM yuejian_student_rate WHERE created_at < now() - interval '1 day'`;
  const rows = await sql`
    SELECT count(*)::int AS n
    FROM yuejian_student_rate
    WHERE action = ${action} AND ip_hash = ${hashed}
      AND created_at > now() - interval '15 minutes'
  `;
  const n = Number(rows && rows[0] && rows[0].n) || 0;
  if (n >= limit) return false;
  await sql`INSERT INTO yuejian_student_rate (ip_hash, action) VALUES (${hashed}, ${action})`;
  return true;
}

async function findUserByUsername(sql, username) {
  const rows = await sql`
    SELECT id, username, password_hash, display_name, created_at, last_login_at
    FROM yuejian_student_users
    WHERE lower(username) = lower(${username})
    LIMIT 1
  `;
  return rows[0] || null;
}

async function insertSession(sql, userId) {
  const token = newSessionToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_MS).toISOString();
  await sql`DELETE FROM yuejian_student_sessions WHERE expires_at < now()`;
  await sql`
    INSERT INTO yuejian_student_sessions (user_id, token_hash, expires_at)
    VALUES (${userId}, ${tokenHash}, ${expiresAt})
  `;
  return token;
}

async function recordVisit(sql, userId, event, pointId, detail) {
  if (event !== 'login') {
    const dup = await sql`
      SELECT id FROM yuejian_student_visits
      WHERE user_id = ${userId}
        AND event = ${event}
        AND point_id IS NOT DISTINCT FROM ${pointId}
        AND detail IS NOT DISTINCT FROM ${detail}
        AND created_at > now() - interval '20 seconds'
      LIMIT 1
    `;
    if (dup && dup.length) return false;
  }
  await sql`
    INSERT INTO yuejian_student_visits (user_id, event, point_id, detail)
    VALUES (${userId}, ${event}, ${pointId}, ${detail})
  `;
  return true;
}

async function userFromToken(sql, token) {
  if (!token) return null;
  const rows = await sql`
    SELECT u.id, u.username, u.display_name, u.created_at, u.last_login_at
    FROM yuejian_student_sessions s
    JOIN yuejian_student_users u ON u.id = s.user_id
    WHERE s.token_hash = ${hashToken(token)} AND s.expires_at > now()
    LIMIT 1
  `;
  return rows[0] || null;
}

function sanitizeClientEvent(input) {
  if (!input || typeof input !== 'object') return null;
  const event = String(input.event || '').trim();
  if (event === 'view_tab') {
    const detail = String(input.detail || '').trim();
    if (!TAB_NAMES.has(detail)) return null;
    return { event, pointId: null, detail };
  }
  if (event === 'view_point') {
    const pointId = Number(input.pointId != null ? input.pointId : input.point_id);
    if (!Number.isInteger(pointId) || pointId < 1 || pointId > 8) return null;
    return { event, pointId, detail: POINT_NAMES[pointId] };
  }
  if (event === 'play_lecture') {
    return { event, pointId: null, detail: '记叙文阅读八考点' };
  }
  if (event === 'view_question') {
    const raw = String(input.detail || input.questionId || input.question_id || '').trim();
    const detail = QUESTION_ID_RE.test(raw) ? raw : null;
    return { event, pointId: null, detail };
  }
  return null;
}

function dbError(err) {
  return err && err.code === 'db_not_configured';
}

module.exports = {
  ALLOWED_ORIGINS,
  POINT_NAMES,
  SESSION_MS,
  setCors,
  corsOrigin,
  json,
  readBody,
  databaseUrl,
  getSql,
  ensureSchema,
  resetSchemaForTests,
  expectedPass,
  checkPassphrase,
  passFromReq,
  clientIp,
  validateUsername,
  validatePassword,
  cleanDisplayName,
  hashPassword,
  verifyPassword,
  dummyVerify,
  newSessionToken,
  hashToken,
  bearerToken,
  iso,
  publicUser,
  isUniqueViolation,
  consumeRate,
  findUserByUsername,
  insertSession,
  recordVisit,
  userFromToken,
  sanitizeClientEvent,
  dbError,
};
