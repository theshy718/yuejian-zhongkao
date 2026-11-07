'use strict';

/**
 * Vercel Node serverless: POST /api/teacher-chat
 * Proxies teacher chat messages to the Grok Bot webhook.
 * Secrets stay in env — never commit URL/KEY.
 */

const ALLOWED_ORIGINS = new Set([
  'https://theshy718.github.io',
  'https://yuejian-zhongkao.vercel.app',
  'http://localhost:8876',
  'http://127.0.0.1:8876',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

function corsOrigin(req) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  // Allow github pages preview / path origins that start with the pages host
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function checkPassphrase(body) {
  const expected = process.env.YUEJIAN_TEACHER_PASS;
  const got = String(body.passphrase || '').trim();
  if (expected) return got === expected;
  // Fallback only when env unset (local/dev)
  return got === 'yuejian-laoshi';
}

function webhookKey() {
  const direct = process.env.YUEJIAN_TEACHER_WEBHOOK_KEY;
  if (direct) return direct;
  const b64 = process.env.YUEJIAN_TEACHER_WEBHOOK_KEY_B64;
  if (b64) {
    try { return Buffer.from(b64, 'base64').toString('utf8'); } catch { return ''; }
  }
  const p1 = process.env.YUEJIAN_TEACHER_WEBHOOK_KEY_P1 || '';
  const p2 = process.env.YUEJIAN_TEACHER_WEBHOOK_KEY_P2 || '';
  const p3 = process.env.YUEJIAN_TEACHER_WEBHOOK_KEY_P3 || '';
  const joined = p1 + p2 + p3;
  return joined || '';
}

async function forwardWebhook(payload) {
  const url = process.env.YUEJIAN_TEACHER_WEBHOOK_URL;
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
        'X-Automation-Key': key,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { ok: r.ok, status: r.status };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
    return;
  }

  if (!checkPassphrase(body)) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return;
  }

  if (!process.env.YUEJIAN_TEACHER_WEBHOOK_URL || !webhookKey()) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: '未配置直连' }));
    return;
  }

  const message = String(body.message || '').trim();
  if (!message) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: 'empty_message' }));
    return;
  }

  const forward = {
    source: body.source || 'yuejian-teacher-chat',
    type: body.type || '其他',
    message,
    draft: body.draft || null,
    threadId: body.threadId || null,
    submittedAt: body.submittedAt || new Date().toISOString(),
    page: body.page || null,
  };

  try {
    const result = await forwardWebhook(forward);
    if (result.ok) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: '转发失败' }));
  } catch (e) {
    if (e && e.code === 'not_configured') {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, error: '未配置直连' }));
      return;
    }
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: '转发失败' }));
  }
};
