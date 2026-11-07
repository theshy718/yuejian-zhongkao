'use strict';

const PASS_KEY = 'yuejian-teacher-ok';
const THREAD_KEY = 'yuejian-teacher-thread';
const DEFAULT_PASS = 'yuejian-laoshi';
const SHORT_NAMES = ['内容概括','心理与形象','作者情感','语句含义','记叙顺序','标题含义作用','情节心理变化','描写方法'];

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let currentType = '其他';
let lastPlain = '';

function unlocked() {
  try { return sessionStorage.getItem(PASS_KEY) === '1'; } catch { return false; }
}
function setUnlocked(v) {
  try { sessionStorage.setItem(PASS_KEY, v ? '1' : '0'); } catch {}
}

function uuid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function threadId() {
  try {
    let id = sessionStorage.getItem(THREAD_KEY);
    if (!id) {
      id = uuid();
      sessionStorage.setItem(THREAD_KEY, id);
    }
    return id;
  } catch {
    return uuid();
  }
}

function chatApi() {
  const u = (typeof window.YUEJIAN_TEACHER_CHAT_API === 'string' && window.YUEJIAN_TEACHER_CHAT_API.trim()) || '';
  return u || 'https://yuejian-zhongkao.vercel.app/api/teacher-chat';
}

function showWorkbench(ok) {
  $('#gate').classList.toggle('hidden', ok);
  $('#workbench').classList.toggle('hidden', !ok);
  if (ok) {
    loadStats();
    if (!$('#messages').dataset.ready) {
      appendSystem('你好，我是小克。改网页、加题、讲解片需求直接发在这里。回复会出现在本对话框里。');
      $('#messages').dataset.ready = '1';
    }
    startPoll();
    $('#chat-input').focus();
  } else {
    stopPoll();
  }
}

function gateStatus(msg) {
  const el = $('#gate-status');
  el.textContent = msg || '';
  el.className = 'status ' + (msg ? 'error' : '');
}

function draftStatus(msg, good) {
  const el = $('#draft-status');
  el.textContent = msg || '';
  el.className = 'status ' + (good ? 'success' : (msg ? 'error' : ''));
}

const FILE_HOST = 'https://yuejian-zhongkao.vercel.app/api/teacher-file?id=';
const FILE_URL_RE = /https:\/\/yuejian-zhongkao\.vercel\.app\/api\/teacher-file\?id=[0-9a-f-]{36}/gi;
const BLOB_URL_RE = /https:\/\/[a-z0-9.-]+\.(?:public\.)?blob\.vercel-storage\.com\/[^\s<>"']+/gi;
const BLOB_CLIENT_URL = 'https://esm.sh/@vercel/blob@2.8.2/client';
const ALLOWED_MIME = new Set([
  'image/jpeg','image/png','image/webp','image/gif',
  'application/pdf',
  'application/zip','application/x-zip-compressed',
  'application/x-rar-compressed','application/vnd.rar',
  'application/x-7z-compressed',
  'application/x-tar','application/gzip','application/x-gzip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain','text/csv','text/markdown','text/x-markdown',
  'application/octet-stream',
]);
const EXT_MIME = {
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif',
  '.pdf':'application/pdf',
  '.zip':'application/zip','.rar':'application/vnd.rar','.7z':'application/x-7z-compressed',
  '.tar':'application/x-tar','.gz':'application/gzip',
  '.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls':'application/vnd.ms-excel','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt':'application/vnd.ms-powerpoint','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt':'text/plain','.csv':'text/csv','.md':'text/markdown',
};
const ALLOWED_EXT = new Set(Object.keys(EXT_MIME));
const MAX_ATTACH = 8;
const MAX_BYTES = 100 * 1024 * 1024; // 100MB
const IMAGE_COMPRESS_UNDER = 2 * 1024 * 1024;

let pendingAttachments = [];

function isImageMime(mime) {
  return String(mime || '').startsWith('image/');
}

function extractFileUrls(text) {
  const s = String(text || '');
  const urls = [];
  for (const reSrc of [FILE_URL_RE, BLOB_URL_RE]) {
    const re = new RegExp(reSrc.source, 'gi');
    let m;
    while ((m = re.exec(s))) {
      const u = m[0];
      if (!urls.includes(u)) urls.push(u);
    }
  }
  return urls;
}

function isOurFileUrl(u) {
  const s = String(u || '');
  if (s.startsWith(FILE_HOST)) return true;
  try {
    const host = new URL(s).hostname;
    return /\.(?:public\.)?blob\.vercel-storage\.com$/i.test(host);
  } catch {
    return false;
  }
}

function formatBytes(n) {
  const x = Number(n) || 0;
  if (x < 1024) return x + ' B';
  if (x < 1024 * 1024) return (x / 1024).toFixed(1) + ' KB';
  return (x / (1024 * 1024)).toFixed(1) + ' MB';
}

function extOf(name) {
  const m = /(\.[a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

function guessMime(file) {
  const mime = String(file && file.type || '').toLowerCase();
  if (mime && ALLOWED_MIME.has(mime) && mime !== 'application/octet-stream') return mime;
  const ext = extOf(file && file.name);
  if (EXT_MIME[ext]) return EXT_MIME[ext];
  if (mime === 'application/octet-stream' && ALLOWED_EXT.has(ext)) return EXT_MIME[ext] || mime;
  return mime || '';
}

function kindLabel(mime, name) {
  const m = String(mime || '');
  if (m.startsWith('image/')) return '图片';
  if (m === 'application/pdf') return 'PDF';
  const ext = extOf(name).replace('.', '').toUpperCase();
  if (ext) return ext;
  return '文件';
}

function renderBodyHtml(text) {
  const raw = String(text ?? '');
  const urls = extractFileUrls(raw);
  let html = esc(raw).replace(/\n/g, '<br>');
  if (!urls.length) return html;
  const parts = ['<div class="bubble-attach">'];
  for (const u of urls) {
    if (!isOurFileUrl(u)) continue;
    const near = raw.slice(Math.max(0, raw.indexOf(u) - 120), raw.indexOf(u) + u.length);
    const nameMatch = /-\s+([^\n(]+?)\s+\(/u.exec(near);
    const name = (nameMatch && nameMatch[1] ? nameMatch[1].trim() : '附件');
    const asImage = /\((image\/(?:jpeg|png|webp|gif))\)/.test(near);
    const dl = u.startsWith(FILE_HOST)
      ? (u + (u.includes('?') ? '&' : '?') + 'download=1')
      : u;
    parts.push('<div class="attach-item">');
    if (asImage) {
      parts.push('<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer"><img src="' + esc(u) + '" alt="' + esc(name) + '" loading="lazy"></a>');
    } else {
      parts.push('<span class="attach-file-label">' + esc(name) + '</span>');
    }
    parts.push('<a class="attach-dl" href="' + esc(dl) + '" target="_blank" rel="noopener noreferrer" download>下载</a>');
    parts.push('</div>');
  }
  parts.push('</div>');
  return html + parts.join('');
}

function appendBubble({ role, text, kind, localThumbs }) {
  const box = $('#messages');
  const div = document.createElement('div');
  div.className = 'bubble ' + role + (kind ? ' ' + kind : '');
  let body = renderBodyHtml(text);
  if (localThumbs && localThumbs.length) {
    const bits = ['<div class="bubble-attach">'];
    for (const t of localThumbs) {
      const name = t.name || '附件';
      const url = t.url || '';
      const dl = url
        ? (String(url).startsWith(FILE_HOST)
            ? (url + (url.includes('?') ? '&' : '?') + 'download=1')
            : url)
        : '';
      bits.push('<div class="attach-item">');
      if (t.blobUrl && isImageMime(t.mime)) {
        bits.push('<img src="' + esc(t.blobUrl) + '" alt="' + esc(name) + '">');
      } else if (url && isImageMime(t.mime) && isOurFileUrl(url)) {
        bits.push('<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer"><img src="' + esc(url) + '" alt="' + esc(name) + '" loading="lazy"></a>');
      } else {
        bits.push('<span class="attach-file-label">' + esc(name) + (t.size ? ' · ' + formatBytes(t.size) : '') + '</span>');
      }
      if (dl) {
        bits.push('<a class="attach-dl" href="' + esc(dl) + '" target="_blank" rel="noopener noreferrer" download>下载</a>');
      }
      bits.push('</div>');
    }
    bits.push('</div>');
    body += bits.join('');
  }
  div.innerHTML = '<div class="bubble-meta">' + esc(role === 'user' ? '你' : '小克') + '</div>'
    + '<div class="bubble-body">' + body + '</div>';
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function appendSystem(text) {
  return appendBubble({ role: 'bot', text, kind: 'system' });
}

function appendStatus(text, ok) {
  return appendBubble({ role: 'bot', text, kind: ok ? 'ok' : 'err' });
}


const seenBotIds = new Set();
const AFTER_KEY = 'yuejian-teacher-after';
function loadAfterId() {
  try {
    const n = Number(sessionStorage.getItem(AFTER_KEY) || '0');
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
function saveAfterId(id) {
  afterId = id;
  try { sessionStorage.setItem(AFTER_KEY, String(id)); } catch {}
}
let afterId = loadAfterId();
let pollTimer = null;
let lastActivity = Date.now();
let pollFailStreak = 0;
let waitingForReply = false;
let waitingSince = 0;

function markActivity() {
  lastActivity = Date.now();
}

function beginWaitingForReply() {
  waitingForReply = true;
  waitingSince = Date.now();
  markActivity();
}

function endWaitingForReply() {
  waitingForReply = false;
  waitingSince = 0;
}

function pollIntervalMs() {
  if (waitingForReply) {
    // 等回复时约每秒拉一次，最长约 5 分钟保持高频
    if (Date.now() - waitingSince > 5 * 60 * 1000) {
      waitingForReply = false;
      return 3000;
    }
    return 900;
  }
  const idle = Date.now() - lastActivity;
  if (idle > 60000) return 5000;
  return 2000;
}

function stopPoll() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function resetPollSoon() {
  markActivity();
  stopPoll();
  pollTimer = setTimeout(pollOnce, 400);
}

async function pollOnce() {
  stopPoll();
  if (!unlocked()) return;
  const tid = threadId();
  const url = chatApi()
    + '?threadId=' + encodeURIComponent(tid)
    + '&afterId=' + encodeURIComponent(String(afterId))
    + '&pass=' + encodeURIComponent(DEFAULT_PASS);
  try {
    const r = await fetch(url, { method: 'GET', mode: 'cors', cache: 'no-store' });
    let data = null;
    try { data = await r.json(); } catch {}
    if (r.ok && data && data.ok && Array.isArray(data.messages)) {
      pollFailStreak = 0;
      let gotNew = false;
      for (const m of data.messages) {
        const id = Number(m.id);
        if (!Number.isFinite(id)) continue;
        if (id > afterId) saveAfterId(id);
        if (m.role !== 'bot') continue;
        if (seenBotIds.has(id)) continue;
        seenBotIds.add(id);
        appendBubble({ role: 'bot', text: String(m.body || '') });
        markActivity();
        gotNew = true;
      }
      if (gotNew && waitingForReply) endWaitingForReply();
      if (window.__refreshPending) {
        window.__refreshPending = false;
        if (!gotNew) appendStatus('暂无新回复。', true);
      }
    } else {
      pollFailStreak += 1;
      if (pollFailStreak === 4) appendStatus('同步回复失败，请强制刷新页面（Ctrl+F5）后再试。', false);
    }
  } catch {
    pollFailStreak += 1;
    if (pollFailStreak === 4) appendStatus('同步回复失败，请强制刷新页面（Ctrl+F5）后再试。', false);
  }
  const delay = pollFailStreak > 3 ? 8000 : pollIntervalMs();
  pollTimer = setTimeout(pollOnce, delay);
}

function startPoll() {
  markActivity();
  stopPoll();
  pollTimer = setTimeout(pollOnce, 500);
}

function nowISO() {
  return new Date().toISOString();
}

function buildPlainText({ type, message, draft }) {
  const lines = [
    '【阅见老师需求】',
    '类型：' + type,
    '提交时间：' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（Asia/Shanghai）',
    '页面：' + location.href,
    '会话：' + threadId(),
  ];
  lines.push('', '需求说明：', message || '（无）');
  if (draft) {
    lines.push('', '—— 题库草稿 ——');
    const fields = [
      ['选文篇名', draft.passage_title],
      ['选文作者', draft.passage_author],
      ['题干', draft.stem],
      ['参考答案', draft.answer],
      ['考点', (draft.point_ids || []).map(id => id + ' ' + (SHORT_NAMES[id - 1] || '')).join('、') || '未选'],
      ['年份', draft.year],
      ['地区', draft.region],
      ['考试类型', draft.exam_type],
      ['关联课文', draft.related_textbook],
      ['课内选文', draft.in_class ? '是' : '否'],
      ['出处', draft.source],
      ['来源网址', draft.url],
    ];
    for (const [k, v] of fields) lines.push(k + '：' + (v === undefined || v === null || v === '' ? '（空）' : v));
  }
  lines.push('', '（请小克处理并更新学生站）');
  return lines.join('\n');
}

async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}

function readDraftForm(form) {
  const fd = new FormData(form);
  const point_ids = fd.getAll('points').map(Number).filter(n => n >= 1 && n <= 8);
  const yearRaw = String(fd.get('year') || '').trim();
  return {
    passage_title: String(fd.get('passage_title') || '').trim(),
    passage_author: String(fd.get('passage_author') || '').trim(),
    stem: String(fd.get('stem') || '').trim(),
    answer: String(fd.get('answer') || '').trim(),
    point_ids,
    year: yearRaw ? Number(yearRaw) : '',
    region: String(fd.get('region') || '').trim(),
    exam_type: String(fd.get('exam_type') || '').trim(),
    related_textbook: String(fd.get('related_textbook') || '').trim(),
    in_class: form.querySelector('[name=in_class]')?.checked || false,
    source: String(fd.get('source') || '').trim(),
    url: String(fd.get('url') || '').trim(),
  };
}

function draftMessage(d) {
  const pts = (d.point_ids || []).map(id => id + '·' + (SHORT_NAMES[id - 1] || '')).join('、') || '未选';
  return [
    '请将以下题目入库（老师草稿，需小克核验后写入学生站）。',
    '篇名：' + (d.passage_title || '未填'),
    '作者：' + (d.passage_author || '未填'),
    '考点：' + pts,
    '年份/地区：' + ([d.year || '', d.region || ''].filter(Boolean).join(' · ') || '未填'),
    '出处：' + (d.source || '未填'),
    '',
    '题干：',
    d.stem,
    '',
    '参考答案：',
    d.answer || '（空）',
  ].join('\n');
}


function renderAttachPreview() {
  const box = $('#attach-preview');
  if (!box) return;
  if (!pendingAttachments.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = pendingAttachments.map((a, i) => {
    const thumb = (a.blobUrl && isImageMime(a.mime))
      ? '<img src="' + esc(a.blobUrl) + '" alt="">'
      : '<span class="attach-kind">' + esc(kindLabel(a.mime, a.name)) + '</span>';
    const size = a.size ? '<span class="attach-size">' + esc(formatBytes(a.size)) + '</span>' : '';
    return '<div class="attach-chip" data-i="' + i + '">'
      + thumb
      + '<span class="attach-name" title="' + esc(a.name) + '">' + esc(a.name) + '</span>'
      + size
      + '<button type="button" class="attach-remove" data-remove="' + i + '" aria-label="移除">×</button>'
      + '</div>';
  }).join('');
  box.querySelectorAll('[data-remove]').forEach(btn => {
    btn.onclick = () => {
      const i = Number(btn.getAttribute('data-remove'));
      const item = pendingAttachments[i];
      if (item && item.blobUrl) {
        try { URL.revokeObjectURL(item.blobUrl); } catch {}
      }
      pendingAttachments.splice(i, 1);
      renderAttachPreview();
    };
  });
}

function clearPendingAttachments() {
  for (const a of pendingAttachments) {
    if (a.blobUrl) {
      try { URL.revokeObjectURL(a.blobUrl); } catch {}
    }
  }
  pendingAttachments = [];
  renderAttachPreview();
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('read_failed'));
    fr.readAsDataURL(file);
  });
}

function dataUrlToBase64(dataUrl) {
  const s = String(dataUrl || '');
  const i = s.indexOf('base64,');
  return i >= 0 ? s.slice(i + 7) : s;
}

function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const maxEdge = 1600;
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        const scale = Math.min(1, maxEdge / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        URL.revokeObjectURL(url);
        // Convert compressed data URL to File for Blob upload
        const b64 = dataUrlToBase64(dataUrl);
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const outName = (file.name || 'image').replace(/\.[^.]+$/, '') + '.jpg';
        const outFile = new File([bytes], outName, { type: 'image/jpeg' });
        resolve({
          name: outName,
          mime: 'image/jpeg',
          file: outFile,
          blobUrl: dataUrl,
          size: outFile.size,
        });
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('无法读取图片'));
    };
    img.src = url;
  });
}

async function prepareFile(file) {
  const mime = guessMime(file);
  const ext = extOf(file.name);
  if (!ALLOWED_MIME.has(mime) && !ALLOWED_EXT.has(ext)) {
    throw new Error('不支持的文件类型。可用：图片 / PDF / 压缩包(zip·rar·7z·tar·gz) / Office / txt·csv·md');
  }
  if (file.size > MAX_BYTES) {
    throw new Error('单文件不能超过 100MB（当前 ' + formatBytes(file.size) + '）');
  }
  const finalMime = ALLOWED_MIME.has(mime) ? mime : (EXT_MIME[ext] || 'application/octet-stream');
  // Optional light compress only for small photos
  if (isImageMime(finalMime) && file.size > 0 && file.size <= IMAGE_COMPRESS_UNDER && finalMime !== 'image/gif') {
    try {
      return await compressImageFile(file);
    } catch {
      // fall through to original
    }
  }
  const preview = isImageMime(finalMime) ? URL.createObjectURL(file) : null;
  return {
    name: file.name || ('file' + (ext || '')),
    mime: finalMime,
    file,
    blobUrl: preview,
    size: file.size,
  };
}

async function addFilesFromInput(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const room = MAX_ATTACH - pendingAttachments.length;
  if (room <= 0) {
    appendStatus('每条消息最多 ' + MAX_ATTACH + ' 个附件。', false);
    return;
  }
  const take = files.slice(0, room);
  if (files.length > room) {
    appendStatus('一次最多 ' + MAX_ATTACH + ' 个附件，已只加入前 ' + room + ' 个。', false);
  }
  for (const f of take) {
    try {
      const prepared = await prepareFile(f);
      pendingAttachments.push({
        name: prepared.name,
        mime: prepared.mime,
        blobUrl: prepared.blobUrl,
        file: prepared.file,
        size: prepared.size,
      });
    } catch (e) {
      appendStatus(e && e.message ? e.message : '附件处理失败', false);
    }
  }
  renderAttachPreview();
}

let blobUploadFn = null;
async function getBlobUpload() {
  if (blobUploadFn) return blobUploadFn;
  const mod = await import(BLOB_CLIENT_URL);
  if (!mod || typeof mod.upload !== 'function') {
    throw new Error('无法加载上传组件，请强制刷新后再试');
  }
  blobUploadFn = mod.upload;
  return blobUploadFn;
}

function safePathName(name) {
  return String(name || 'file')
    .replace(/[^\w.\u4e00-\u9fff-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80) || 'file';
}

async function uploadOneAttachment(att) {
  if (!att.file) throw new Error('缺少文件数据，请重新选择附件');
  if (att.file.size > MAX_BYTES) {
    throw new Error('单文件不能超过 100MB');
  }
  const fileId = uuid();
  const tid = threadId();
  const pathname = 'teacher/' + tid + '/' + fileId + '-' + safePathName(att.name);
  const upload = await getBlobUpload();
  let blob;
  try {
    blob = await upload(pathname, att.file, {
      access: 'public',
      handleUploadUrl: chatApi(),
      multipart: att.file.size > 4 * 1024 * 1024,
      contentType: att.mime || att.file.type || 'application/octet-stream',
      clientPayload: JSON.stringify({
        passphrase: DEFAULT_PASS,
        threadId: tid,
        fileId,
        filename: att.name,
        mime: att.mime,
        size: att.file.size,
      }),
    });
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : String(e);
    if (/unauthorized/i.test(msg)) throw new Error('口令校验失败，请刷新后重试');
    if (/file_too_large|too large|maximumSize/i.test(msg)) throw new Error('文件过大（上限 100MB）');
    if (/unsupported_mime|content type|contentType/i.test(msg)) throw new Error('不支持的文件类型');
    throw new Error('上传失败：' + msg);
  }
  const blobUrl = blob && blob.url ? String(blob.url) : '';
  if (!blobUrl) throw new Error('上传成功但未返回文件地址');

  // Ensure Neon row exists even if Blob callback is delayed
  const r = await fetch(chatApi(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'register-blob',
      passphrase: DEFAULT_PASS,
      threadId: tid,
      id: fileId,
      filename: att.name,
      mime: att.mime,
      blobUrl,
      size: att.file.size,
    }),
    mode: 'cors',
  });
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok || !data || !data.ok) {
    const err = (data && data.error) ? String(data.error) : ('HTTP ' + r.status);
    throw new Error('登记附件失败：' + err);
  }
  return {
    id: data.id || fileId,
    filename: data.filename || att.name,
    mime: data.mime || att.mime,
    url: data.url || (FILE_HOST + fileId),
    size: att.file.size,
  };
}

async function sendChat({ type, message, draft }) {
  const text = String(message || '').trim();
  const pending = pendingAttachments.slice();
  if (!text && !pending.length) return;

  const localThumbs = pending.map(a => ({
    name: a.name,
    mime: a.mime,
    blobUrl: a.blobUrl,
    size: a.size,
  }));
  const display = (type && type !== '其他' ? '【' + type + '】\n' : '') + (text || '（附件）');
  const userBubble = appendBubble({ role: 'user', text: display, localThumbs });
  lastPlain = buildPlainText({ type, message: text || '（附件）', draft });

  const btn = $('#send');
  const attachBtn = $('#attach-file');
  btn.disabled = true;
  if (attachBtn) attachBtn.disabled = true;
  try {
    const uploaded = [];
    for (const att of pending) {
      uploaded.push(await uploadOneAttachment(att));
    }
    clearPendingAttachments();

    // Replace local thumbs with server download links
    if (uploaded.length && userBubble) {
      const bodyEl = userBubble.querySelector('.bubble-body');
      if (bodyEl) {
        const attachHtml = ['<div class="bubble-attach">'];
        for (const u of uploaded) {
          const dl = u.url + (String(u.url).includes('?') ? '&' : '?') + 'download=1';
          attachHtml.push('<div class="attach-item">');
          if (isImageMime(u.mime)) {
            attachHtml.push('<a href="' + esc(u.url) + '" target="_blank" rel="noopener noreferrer"><img src="' + esc(u.url) + '" alt="' + esc(u.filename) + '" loading="lazy"></a>');
          } else {
            attachHtml.push('<span class="attach-file-label">' + esc(u.filename) + (u.size ? ' · ' + formatBytes(u.size) : '') + '</span>');
          }
          attachHtml.push('<a class="attach-dl" href="' + esc(dl) + '" target="_blank" rel="noopener noreferrer" download>下载</a>');
          attachHtml.push('</div>');
        }
        attachHtml.push('</div>');
        const oldAttach = bodyEl.querySelector('.bubble-attach');
        if (oldAttach) oldAttach.outerHTML = attachHtml.join('');
        else bodyEl.insertAdjacentHTML('beforeend', attachHtml.join(''));
      }
    }

    const payload = {
      source: 'yuejian-teacher-chat',
      type: type || '其他',
      message: text || (uploaded.length ? '（见附件）' : ''),
      draft: draft || null,
      threadId: threadId(),
      submittedAt: nowISO(),
      page: location.href,
      passphrase: DEFAULT_PASS,
    };
    if (uploaded.length) payload.attachments = uploaded;

    const r = await fetch(chatApi(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      mode: 'cors',
    });
    let data = null;
    try { data = await r.json(); } catch {}
    if (r.ok && data && data.ok) {
      appendStatus('已送达，等待小克在此回复…', true);
      beginWaitingForReply();
      // 立刻拉一次，随后由 waitingForReply 高频轮询自动冒泡
      resetPollSoon();
    } else {
      const err = (data && data.error) ? String(data.error) : ('HTTP ' + r.status);
      appendStatus('发送失败：' + err + '。可点「复制」后粘贴到和小克的对话。', false);
    }
  } catch (e) {
    appendStatus((e && e.message) ? e.message : ('网络异常：' + String(e)), false);
  } finally {
    btn.disabled = false;
    if (attachBtn) attachBtn.disabled = false;
  }
}

async function loadStats() {
  const box = $('#lib-stats');
  try {
    const r = await fetch('../library.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const lib = await r.json();
    const t = (lib.texts || []).length;
    const q = (lib.questions || []).length;
    const p = (lib.points || []).length;
    box.innerHTML =
      `<span><strong>${t}</strong>目录</span>` +
      `<span><strong>${q}</strong>试题</span>` +
      `<span><strong>${p}</strong>考点</span>`;
  } catch (e) {
    box.innerHTML = `<span class="error">题库预览读取失败：${esc(e.message)}</span>`;
  }
}

function initPoints() {
  $('#point-checks').innerHTML = SHORT_NAMES.map((name, i) =>
    `<label><input type="checkbox" name="points" value="${i + 1}">${i + 1}. ${esc(name)}</label>`
  ).join('');
}

function setDraftOpen(open) {
  $('#draft-panel').classList.toggle('hidden', !open);
  $('#toggle-draft').setAttribute('aria-expanded', open ? 'true' : 'false');
}

function tryUnlock() {
  const val = ($('#passphrase').value || '').trim();
  if (val === DEFAULT_PASS) {
    setUnlocked(true);
    gateStatus('');
    showWorkbench(true);
  } else {
    gateStatus('口令不正确，请再试。');
  }
}

function bind() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && unlocked()) resetPollSoon();
  });
  window.addEventListener('focus', () => {
    if (unlocked()) resetPollSoon();
  });
  $('#unlock').onclick = tryUnlock;
  $('#passphrase').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); tryUnlock(); }
  });

  document.querySelectorAll('.chip').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentType = btn.dataset.type || '其他';
    };
  });

  $('#attach-file').onclick = () => {
    const input = $('#file-input');
    if (input) input.click();
  };
  $('#file-input').addEventListener('change', async (e) => {
    const input = e.target;
    await addFilesFromInput(input.files);
    input.value = '';
  });

  $('#send').onclick = async () => {
    const message = ($('#chat-input').value || '').trim();
    if (!message && !pendingAttachments.length) return;
    $('#chat-input').value = '';
    await sendChat({ type: currentType, message, draft: null });
  };

  $('#chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#send').click();
    }
  });

  
  $('#refresh-replies').onclick = () => {
    markActivity();
    window.__refreshPending = true;
    resetPollSoon();
    appendStatus('正在检查新回复…', true);
  };

  $('#copy-last').onclick = async () => {
    const text = lastPlain || ($('#chat-input').value || '').trim();
    if (!text) {
      appendStatus('暂无可复制内容。先发一条消息，或填写输入框。', false);
      return;
    }
    try {
      await copyText(text);
      appendStatus('已复制到剪贴板（离线备用）。', true);
    } catch {
      appendStatus('复制失败，请长按自行选择。', false);
    }
  };

  $('#toggle-draft').onclick = () => {
    const open = $('#draft-panel').classList.contains('hidden');
    setDraftOpen(open);
  };
  $('#close-draft').onclick = () => setDraftOpen(false);

  $('#draft-form').onsubmit = async e => {
    e.preventDefault();
    const draft = readDraftForm(e.target);
    if (!draft.stem) { draftStatus('请填写题干。'); return; }
    if (!draft.point_ids.length) { draftStatus('请至少选择一个考点。'); return; }
    if (!draft.source) { draftStatus('请填写出处。'); return; }
    draftStatus('');
    setDraftOpen(false);
    currentType = '加题入库';
    document.querySelectorAll('.chip').forEach(b => {
      b.classList.toggle('active', b.dataset.type === '加题入库');
    });
    await sendChat({ type: '加题入库', message: draftMessage(draft), draft });
  };
}

initPoints();
bind();
if (unlocked()) showWorkbench(true);
else showWorkbench(false);
