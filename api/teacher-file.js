'use strict';

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Yuejian-Pass');
  res.setHeader('Access-Control-Max-Age', '86400');
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

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

async function ensureColumns(sql) {
  // Soft-ensure for older deployments that hit teacher-file before teacher-chat
  try {
    await sql`ALTER TABLE yuejian_teacher_files ADD COLUMN IF NOT EXISTS blob_url text`;
    await sql`ALTER TABLE yuejian_teacher_files ADD COLUMN IF NOT EXISTS size_bytes bigint`;
  } catch (e) {
    // table may not exist yet
  }
}

async function loadFile(id) {
  const sql = getSql();
  await ensureColumns(sql);
  const rows = await sql`
    SELECT id, filename, mime, data_b64, blob_url, size_bytes
    FROM yuejian_teacher_files
    WHERE id = ${id}
    LIMIT 1
  `;
  return rows[0] || null;
}

function contentDisposition(mime, filename, asAttachment) {
  const safe = String(filename || 'file').replace(/["\r\n]/g, '');
  const kind = asAttachment ? 'attachment' : 'inline';
  return kind + '; filename="' + safe + '"';
}

module.exports = async function handler(req, res) {
  try {
    setCors(req, res);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method !== 'GET') {
      return json(res, 405, { ok: false, error: 'method_not_allowed' });
    }
    const q = req.query || {};
    const id = String(q.id || '').trim();
    if (!id || !UUID_RE.test(id)) {
      return json(res, 404, { ok: false, error: 'not_found' });
    }
    let row;
    try {
      row = await loadFile(id);
    } catch (e) {
      if (e && e.code === 'db_not_configured') {
        return json(res, 503, { ok: false, error: 'db_not_configured' });
      }
      throw e;
    }
    if (!row) {
      return json(res, 404, { ok: false, error: 'not_found' });
    }

    const mime = String(row.mime || 'application/octet-stream');
    const filename = String(row.filename || 'file').replace(/["\r\n]/g, '');
    const blobUrl = row.blob_url ? String(row.blob_url) : '';

    if (blobUrl) {
      // Prefer downloadUrl-style query if caller asks download=1; Blob public URL works as-is
      let target = blobUrl;
      if (String(q.download || '') === '1') {
        try {
          const u = new URL(blobUrl);
          u.searchParams.set('download', filename);
          target = u.toString();
        } catch (e) {
          target = blobUrl;
        }
      }
      res.statusCode = 302;
      res.setHeader('Location', target);
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.end();
      return;
    }

    const buf = Buffer.from(String(row.data_b64 || ''), 'base64');
    const isImage = mime.indexOf('image/') === 0;
    const isPdf = mime === 'application/pdf';
    res.statusCode = 200;
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader(
      'Content-Disposition',
      contentDisposition(mime, filename, !(isImage || isPdf))
    );
    res.end(buf);
  } catch (e) {
    json(res, 500, { ok: false, error: e && e.message ? e.message : 'server_error' });
  }
};
