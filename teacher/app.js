'use strict';

const PASS_KEY = 'yuejian-teacher-ok';
const DEFAULT_PASS = 'yuejian-laoshi';
const MAILTO = 'qiuke+yuejian-teacher@mail.grokbot.com';
const SHORT_NAMES = ['内容概括','心理与形象','作者情感','语句含义','记叙顺序','标题含义作用','情节心理变化','描写方法'];

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function unlocked() {
  try { return sessionStorage.getItem(PASS_KEY) === '1'; } catch { return false; }
}
function setUnlocked(v) {
  try { sessionStorage.setItem(PASS_KEY, v ? '1' : '0'); } catch {}
}

function showWorkbench(ok) {
  $('#gate').classList.toggle('hidden', ok);
  $('#workbench').classList.toggle('hidden', !ok);
  if (ok) loadStats();
}

function status(id, msg, good) {
  const el = $(id);
  el.textContent = msg || '';
  el.className = 'status ' + (good ? 'success' : (msg ? 'error' : ''));
}

function nowISO() {
  return new Date().toISOString();
}

function buildPlainText({ type, message, draft, contact }) {
  const lines = [
    '【阅见老师需求】',
    '类型：' + type,
    '提交时间：' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（Asia/Shanghai）',
    '页面：' + location.href,
  ];
  if (contact) lines.push('联系备注：' + contact);
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

function buildPayload({ type, message, draft, contact }) {
  return {
    source: 'yuejian-teacher',
    type,
    message: contact ? (message + '\n\n联系备注：' + contact) : message,
    draft: draft || null,
    submittedAt: nowISO(),
    page: location.href,
  };
}

async function tryWebhook(payload) {
  const url = (typeof window.YUEJIAN_TEACHER_WEBHOOK === 'string' && window.YUEJIAN_TEACHER_WEBHOOK.trim()) || '';
  if (!url) return { attempted: false, ok: false };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      mode: 'cors',
    });
    return { attempted: true, ok: r.ok, status: r.status };
  } catch (e) {
    return { attempted: true, ok: false, error: e.message || String(e) };
  }
}

function openMailto(type, plain) {
  const subject = '【阅见老师】' + type;
  const href = 'mailto:' + encodeURIComponent(MAILTO)
    + '?subject=' + encodeURIComponent(subject)
    + '&body=' + encodeURIComponent(plain);
  // Prefer location for mobile mail apps; fallback to window.open if too long may truncate
  const a = document.createElement('a');
  a.href = href;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
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

async function submitRequest({ type, message, draft, contact, statusId }) {
  if (!message || !String(message).trim()) {
    status(statusId, '请填写需求说明。');
    return;
  }
  const payload = buildPayload({ type, message: message.trim(), draft, contact: (contact || '').trim() });
  const plain = buildPlainText({ type, message: message.trim(), draft, contact: (contact || '').trim() });

  status(statusId, '正在提交…', true);
  const wh = await tryWebhook(payload);
  openMailto(type, plain);

  let note = '已打开邮件应用，请确认发送给小克。若未弹出邮件，请点「复制需求全文」，粘贴到和小克的对话里。';
  if (wh.attempted && wh.ok) note = '已尝试推送 webhook，并已打开邮件应用。若邮件未弹出，请复制全文发给小克。';
  else if (wh.attempted && !wh.ok) note = 'webhook 推送未成功（可忽略），已打开邮件应用。也可复制全文发给小克。';
  status(statusId, note, true);
  // stash last plain for copy buttons
  window.__yuejianLastPlain = plain;
  return plain;
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
    '年份/地区：' + [d.year || '', d.region || ''].filter(Boolean).join(' · ') || '未填',
    '出处：' + (d.source || '未填'),
    '',
    '题干：',
    d.stem,
    '',
    '参考答案：',
    d.answer || '（空）',
  ].join('\n');
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
      `<span><strong>${t}</strong>目录条目</span>` +
      `<span><strong>${q}</strong>来源可查试题</span>` +
      `<span><strong>${p}</strong>阅读考点</span>`;
  } catch (e) {
    box.innerHTML = `<span class="error">题库预览读取失败：${esc(e.message)}</span>`;
  }
}

function initPoints() {
  $('#point-checks').innerHTML = SHORT_NAMES.map((name, i) =>
    `<label><input type="checkbox" name="points" value="${i + 1}">${i + 1}. ${esc(name)}</label>`
  ).join('');
}

function tryUnlock() {
  const val = ($('#passphrase').value || '').trim();
  if (val === DEFAULT_PASS) {
    setUnlocked(true);
    status('#gate-status', '');
    showWorkbench(true);
  } else {
    status('#gate-status', '口令不正确，请再试。');
  }
}

function bind() {
  $('#unlock').onclick = tryUnlock;
  $('#passphrase').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); tryUnlock(); }
  });

  $('#ask-form').onsubmit = async e => {
    e.preventDefault();
    const type = $('#ask-type').value || '其他';
    const message = $('#ask-message').value;
    const contact = $('#ask-contact').value;
    await submitRequest({ type, message, contact, draft: null, statusId: '#ask-status' });
  };

  $('#ask-copy').onclick = async () => {
    const type = $('#ask-type').value || '其他';
    const message = ($('#ask-message').value || '').trim();
    const contact = ($('#ask-contact').value || '').trim();
    if (!message) { status('#ask-status', '请先填写需求说明再复制。'); return; }
    const plain = window.__yuejianLastPlain && window.__yuejianLastAsk === message
      ? window.__yuejianLastPlain
      : buildPlainText({ type, message, contact, draft: null });
    try {
      await copyText(plain);
      status('#ask-status', '已复制需求全文，可粘贴给小克。', true);
    } catch {
      status('#ask-status', '复制失败，请长按文本自行选择复制。');
    }
  };

  $('#draft-form').onsubmit = async e => {
    e.preventDefault();
    const draft = readDraftForm(e.target);
    if (!draft.stem) { status('#draft-status', '请填写题干。'); return; }
    if (!draft.point_ids.length) { status('#draft-status', '请至少选择一个考点。'); return; }
    if (!draft.source) { status('#draft-status', '请填写出处。'); return; }
    const message = draftMessage(draft);
    const plain = await submitRequest({
      type: '加题入库',
      message,
      draft,
      contact: '',
      statusId: '#draft-status',
    });
    window.__yuejianLastDraftPlain = plain;
  };

  $('#draft-copy').onclick = async () => {
    const draft = readDraftForm($('#draft-form'));
    if (!draft.stem) { status('#draft-status', '请先填写题干再复制。'); return; }
    if (!draft.point_ids.length) { status('#draft-status', '请至少选择一个考点。'); return; }
    if (!draft.source) { status('#draft-status', '请填写出处。'); return; }
    const plain = buildPlainText({ type: '加题入库', message: draftMessage(draft), draft, contact: '' });
    try {
      await copyText(plain);
      status('#draft-status', '已复制加题需求全文，可粘贴给小克。', true);
    } catch {
      status('#draft-status', '复制失败，请长按文本自行选择复制。');
    }
  };
}

initPoints();
bind();
if (unlocked()) showWorkbench(true);
else showWorkbench(false);
