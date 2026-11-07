'use strict';

function env(name) {
  return process.env[name] || '';
}

function keyBase() {
  return ['YUEJIAN', 'TEACHER', 'WEBHOOK', 'KEY'].join('_');
}

function replyTokenBase() {
  return ['YUEJIAN', 'TEACHER', 'REPLY', 'TOKEN'].join('_');
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

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-7z-compressed',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/x-markdown',
  'application/octet-stream',
]);

const ALLOWED_CONTENT_TYPES = Array.from(ALLOWED_MIME);

const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100MB
const MAX_ATTACHMENTS = 8;
const FILE_PUBLIC_BASE = 'https://yuejian-zhongkao.vercel.app/api/teacher-file';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BLOB_HOST_RE = /\.public\.blob\.vercel-storage\.com$|\.blob\.vercel-storage\.com$/i;

function corsOrigin(req) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (origin.startsWith('https://theshy718.github.io')) return origin;
  if (origin.startsWith('https://yuejian-zhongkao.vercel.app')) return origin;
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Yuejian-Pass');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

function expectedPass() {
  const expected = env(['YUEJIAN', 'TEACHER', 'PASS'].join('_'));
  return expected || 'yuejian-laoshi';
}

function checkPassphrase(got) {
  return String(got || '').trim() === expectedPass();
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

function webhookKey() {
  const base = keyBase();
  const joined = joinParts(base, 12);
  if (joined.length >= 20) return joined;
  const direct = env(base);
  if (direct && direct.length >= 20 && direct.indexOf('crsr_') === 0) return direct;
  const b64 = env(base + '_B64');
  if (b64) {
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      if (decoded.length >= 20) return decoded;
    } catch (e) {}
  }
  return joined || '';
}

function webhookUrl() {
  return env(['YUEJIAN', 'TEACHER', 'WEBHOOK', 'URL'].join('_'));
}

function replyToken() {
  const base = replyTokenBase();
  const joined = joinParts(base, 12);
  if (joined.length >= 20) return joined;
  const direct = env(base);
  if (direct && direct.length >= 20) return direct;
  return joined || '';
}

function databaseUrl() {
  const base = dbUrlBase();
  const joined = joinParts(base, 32);
  if (joined.length >= 20) return sanitizeDbUrl(joined);
  const direct = env(base);
  if (direct && direct.length >= 20) return sanitizeDbUrl(direct);
  return sanitizeDbUrl(joined || '');
}

function sanitizeDbUrl(url) {
  if (!url) return '';
  return url.replace(/([?&])channel_binding=require&?/, '$1').replace(/[?&]$/, '');
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

async function ensureSchema(sql) {
  await sql`CREATE TABLE IF NOT EXISTS yuejian_teacher_messages (
    id bigserial PRIMARY KEY,
    thread_id text NOT NULL,
    role text NOT NULL CHECK (role IN ('user','bot')),
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS yuejian_teacher_messages_thread_id_id_idx
    ON yuejian_teacher_messages (thread_id, id)`;
  await sql`CREATE TABLE IF NOT EXISTS yuejian_teacher_files (
    id text PRIMARY KEY,
    thread_id text NOT NULL,
    filename text NOT NULL,
    mime text NOT NULL,
    data_b64 text NOT NULL DEFAULT '',
    blob_url text,
    size_bytes bigint,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`ALTER TABLE yuejian_teacher_files ADD COLUMN IF NOT EXISTS blob_url text`;
  await sql`ALTER TABLE yuejian_teacher_files ADD COLUMN IF NOT EXISTS size_bytes bigint`;
  // Keep legacy rows; new blob-backed rows insert data_b64='' 
  await sql`CREATE INDEX IF NOT EXISTS yuejian_teacher_files_thread_id_idx
    ON yuejian_teacher_files (thread_id)`;
}

async function insertMessage(threadId, role, body) {
  const sql = getSql();
  await ensureSchema(sql);
  const rows = await sql`
    INSERT INTO yuejian_teacher_messages (thread_id, role, body)
    VALUES (${threadId}, ${role}, ${body})
    RETURNING id, thread_id, role, body, created_at
  `;
  return rows[0];
}

async function listMessages(threadId, afterId) {
  const sql = getSql();
  await ensureSchema(sql);
  const rows = await sql`
    SELECT id, role, body, created_at
    FROM yuejian_teacher_messages
    WHERE thread_id = ${threadId} AND id > ${afterId}
    ORDER BY id ASC
    LIMIT 200
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    role: r.role,
    body: r.body,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

async function upsertFile({ id, threadId, filename, mime, dataB64, blobUrl, sizeBytes }) {
  const sql = getSql();
  await ensureSchema(sql);
  const rows = await sql`
    INSERT INTO yuejian_teacher_files (id, thread_id, filename, mime, data_b64, blob_url, size_bytes)
    VALUES (
      ${id},
      ${threadId},
      ${filename},
      ${mime},
      ${dataB64 == null ? '' : String(dataB64)},
      ${blobUrl || null},
      ${sizeBytes == null ? null : Number(sizeBytes)}
    )
    ON CONFLICT (id) DO UPDATE SET
      thread_id = EXCLUDED.thread_id,
      filename = EXCLUDED.filename,
      mime = EXCLUDED.mime,
      blob_url = COALESCE(EXCLUDED.blob_url, yuejian_teacher_files.blob_url),
      size_bytes = COALESCE(EXCLUDED.size_bytes, yuejian_teacher_files.size_bytes),
      data_b64 = CASE
        WHEN EXCLUDED.data_b64 IS NOT NULL AND EXCLUDED.data_b64 <> '' THEN EXCLUDED.data_b64
        ELSE yuejian_teacher_files.data_b64
      END
    RETURNING id, filename, mime, blob_url, size_bytes
  `;
  return rows[0];
}

function newFileId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // eslint-disable-next-line global-require
  return require('crypto').randomUUID();
}

function isAllowedBlobUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return BLOB_HOST_RE.test(u.hostname) && (u.protocol === 'https:');
  } catch (e) {
    return false;
  }
}

function isAllowedAttachmentUrl(url) {
  const s = String(url || '').trim();
  if (!s) return false;
  if (s.indexOf(FILE_PUBLIC_BASE) === 0) return true;
  return isAllowedBlobUrl(s);
}

function normalizeAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, MAX_ATTACHMENTS)) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '').trim();
    const filename = String(item.filename || item.name || '').trim().slice(0, 200);
    const mime = String(item.mime || '').trim().toLowerCase();
    let url = String(item.url || '').trim();
    if (!id || !UUID_RE.test(id)) continue;
    if (!ALLOWED_MIME.has(mime)) continue;
    if (!filename) continue;
    const expected = FILE_PUBLIC_BASE + '?id=' + encodeURIComponent(id);
    if (!url || !isAllowedAttachmentUrl(url)) url = expected;
    out.push({ id, filename, mime, url });
  }
  return out;
}

function formatPersistBody(message, attachments) {
  if (!attachments.length) return message;
  const lines = attachments.map((a) => '- ' + a.filename + ' (' + a.mime + '): ' + a.url);
  const block = '【附件】\n' + lines.join('\n');
  return message ? message + '\n\n' + block : block;
}

async function forwardWebhook(payload) {
  const url = webhookUrl();
  const key = webhookKey();
  if (!url || !key) {
    const err = new Error('not_configured');
    err.code = 'not_configured';
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { ok: r.ok, status: r.status };
  } finally {
    clearTimeout(timer);
  }
}

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function passFromReq(req, body) {
  const q = req.query || {};
  const header = req.headers['x-yuejian-pass'] || '';
  return (
    (body && body.passphrase) ||
    q.pass ||
    q.passphrase ||
    header ||
    ''
  );
}

function parseClientPayload(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch (e) {
    return null;
  }
}

function safeFilename(name) {
  const s = String(name || 'file').trim().slice(0, 200);
  return s || 'file';
}

async function handleGet(req, res) {
  const q = req.query || {};
  if (!checkPassphrase(passFromReq(req, {}))) {
    return json(res, 401, { ok: false, error: 'unauthorized' });
  }
  const threadId = String(q.threadId || '').trim();
  if (!threadId) {
    return json(res, 400, { ok: false, error: 'missing_thread' });
  }
  const afterId = Math.max(0, Number(q.afterId || 0) || 0);
  try {
    const messages = await listMessages(threadId, afterId);
    return json(res, 200, { ok: true, messages });
  } catch (e) {
    if (e && e.code === 'db_not_configured') {
      return json(res, 503, { ok: false, error: 'db_not_configured' });
    }
    throw e;
  }
}

async function handleReply(body, res) {
  const token = replyToken();
  const got = String(body.replyToken || '').trim();
  if (!token || got !== token) {
    return json(res, 401, { ok: false, error: 'unauthorized' });
  }
  const threadId = String(body.threadId || '').trim();
  const message = String(body.message || '').trim();
  if (!threadId || !message) {
    return json(res, 400, { ok: false, error: 'missing_fields' });
  }
  try {
    const row = await insertMessage(threadId, 'bot', message);
    return json(res, 200, {
      ok: true,
      id: Number(row.id),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    });
  } catch (e) {
    if (e && e.code === 'db_not_configured') {
      return json(res, 503, { ok: false, error: 'db_not_configured' });
    }
    throw e;
  }
}

async function handleRegisterBlob(body, res) {
  if (!checkPassphrase(body.passphrase)) {
    return json(res, 401, { ok: false, error: 'unauthorized' });
  }
  const threadId = String(body.threadId || '').trim();
  const id = String(body.id || '').trim();
  const filename = safeFilename(body.filename);
  const mime = String(body.mime || '').trim().toLowerCase() || 'application/octet-stream';
  const blobUrl = String(body.blobUrl || body.url || '').trim();
  const sizeBytes = Number(body.size || body.sizeBytes || 0) || 0;
  if (!threadId) return json(res, 400, { ok: false, error: 'missing_thread' });
  if (!id || !UUID_RE.test(id)) return json(res, 400, { ok: false, error: 'invalid_id' });
  if (!ALLOWED_MIME.has(mime)) return json(res, 400, { ok: false, error: 'unsupported_mime' });
  if (!isAllowedBlobUrl(blobUrl)) return json(res, 400, { ok: false, error: 'invalid_blob_url' });
  if (sizeBytes > MAX_FILE_BYTES) return json(res, 400, { ok: false, error: 'file_too_large' });
  try {
    await upsertFile({
      id,
      threadId,
      filename,
      mime,
      dataB64: '',
      blobUrl,
      sizeBytes: sizeBytes || null,
    });
  } catch (e) {
    if (e && e.code === 'db_not_configured') {
      return json(res, 503, { ok: false, error: 'db_not_configured' });
    }
    throw e;
  }
  const url = FILE_PUBLIC_BASE + '?id=' + encodeURIComponent(id);
  return json(res, 200, { ok: true, id, url, filename, mime, blobUrl });
}

async function handleBlobProtocol(body, req, res) {
  // eslint-disable-next-line global-require
  const { handleUpload } = require('@vercel/blob/client');
  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const payload = parseClientPayload(clientPayload);
        if (!payload) throw new Error('invalid_payload');
        if (!checkPassphrase(payload.passphrase)) throw new Error('unauthorized');
        const threadId = String(payload.threadId || '').trim();
        if (!threadId) throw new Error('missing_thread');
        const path = String(pathname || '');
        if (!path.startsWith('teacher/' + threadId + '/') && !path.startsWith('teacher/')) {
          throw new Error('invalid_pathname');
        }
        const fileId = String(payload.fileId || '').trim();
        if (fileId && !UUID_RE.test(fileId)) throw new Error('invalid_id');
        const filename = safeFilename(payload.filename);
        const mime = String(payload.mime || '').trim().toLowerCase() || 'application/octet-stream';
        if (!ALLOWED_MIME.has(mime)) throw new Error('unsupported_mime');
        const size = Number(payload.size || 0) || 0;
        if (size > MAX_FILE_BYTES) throw new Error('file_too_large');
        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: MAX_FILE_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({
            threadId,
            fileId: fileId || newFileId(),
            filename,
            mime,
            size,
          }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        let meta = {};
        try { meta = JSON.parse(tokenPayload || '{}'); } catch (e) { meta = {}; }
        const id = (meta.fileId && UUID_RE.test(meta.fileId)) ? meta.fileId : newFileId();
        const threadId = String(meta.threadId || '').trim() || 'unknown';
        const filename = safeFilename(meta.filename || (blob && blob.pathname) || 'file');
        const mime = String(meta.mime || (blob && blob.contentType) || 'application/octet-stream').toLowerCase();
        const sizeBytes = Number(meta.size || 0) || null;
        try {
          await upsertFile({
            id,
            threadId,
            filename,
            mime: ALLOWED_MIME.has(mime) ? mime : 'application/octet-stream',
            dataB64: '',
            blobUrl: blob && blob.url ? blob.url : null,
            sizeBytes,
          });
        } catch (e) {
          // Let Blob retry onUploadCompleted a few times
          throw e;
        }
      },
    });
    return json(res, 200, jsonResponse);
  } catch (e) {
    const msg = e && e.message ? String(e.message) : 'blob_upload_error';
    const code = msg === 'unauthorized' ? 401 : 400;
    return json(res, code, { ok: false, error: msg });
  }
}

async function handleSend(body, res) {
  if (!checkPassphrase(body.passphrase)) {
    return json(res, 401, { ok: false, error: 'unauthorized' });
  }
  if (!webhookUrl() || !webhookKey()) {
    return json(res, 503, { ok: false, error: '未配置直连' });
  }
  const message = String(body.message || '').trim();
  const attachments = normalizeAttachments(body.attachments);
  if (!message && !attachments.length) {
    return json(res, 400, { ok: false, error: 'empty_message' });
  }
  const threadId = String(body.threadId || '').trim();
  const persistBody = formatPersistBody(message, attachments);
  if (threadId) {
    try {
      await insertMessage(threadId, 'user', persistBody);
    } catch (e) {
      if (e && e.code !== 'db_not_configured') {
        // continue; still forward
      }
    }
  }
  const payload = {
    source: 'yuejian-teacher-chat',
    type: String(body.type || '').trim(),
    message: message || (attachments.length ? '（见附件）' : ''),
    draft: body.draft || null,
    threadId,
    submittedAt: String(body.submittedAt || new Date().toISOString()),
    page: String(body.page || '').trim(),
  };
  if (attachments.length) {
    payload.attachments = attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      mime: a.mime,
      url: a.url,
    }));
  }
  const fwd = await forwardWebhook(payload);
  if (!fwd.ok) {
    return json(res, 502, { ok: false, error: 'webhook_failed', status: fwd.status });
  }
  return json(res, 200, { ok: true });
}

function isBlobProtocol(body) {
  const t = String((body && body.type) || '');
  return t.indexOf('blob.') === 0;
}

module.exports = async function handler(req, res) {
  try {
    setCors(req, res);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method === 'GET') {
      await handleGet(req, res);
      return;
    }
    if (req.method !== 'POST') {
      return json(res, 405, { ok: false, error: 'method_not_allowed' });
    }
    let body;
    try { body = await readBody(req); }
    catch (e) {
      return json(res, 400, { ok: false, error: 'invalid_json' });
    }
    if (isBlobProtocol(body)) {
      await handleBlobProtocol(body, req, res);
      return;
    }
    const action = String(body.action || '').trim();
    if (action === 'reply') {
      await handleReply(body, res);
      return;
    }
    if (action === 'register-blob') {
      await handleRegisterBlob(body, res);
      return;
    }
    // Legacy base64 upload removed — use Vercel Blob client upload
    if (action === 'upload') {
      return json(res, 410, {
        ok: false,
        error: 'upload_deprecated',
        message: '请刷新老师页后使用直传（支持最大 100MB）',
      });
    }
    await handleSend(body, res);
  } catch (e) {
    const code = e && e.code === 'not_configured' ? 503 : 500;
    json(res, code, { ok: false, error: e && e.message ? e.message : 'server_error' });
  }
};
