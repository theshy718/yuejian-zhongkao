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

function appendBubble({ role, text, kind }) {
  const box = $('#messages');
  const div = document.createElement('div');
  div.className = 'bubble ' + role + (kind ? ' ' + kind : '');
  div.innerHTML = '<div class="bubble-meta">' + esc(role === 'user' ? '你' : '小克') + '</div>'
    + '<div class="bubble-body">' + esc(text).replace(/\n/g, '<br>') + '</div>';
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
let afterId = 0;
let pollTimer = null;
let lastActivity = Date.now();
let pollFailStreak = 0;

function markActivity() {
  lastActivity = Date.now();
}

function pollIntervalMs() {
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
      for (const m of data.messages) {
        const id = Number(m.id);
        if (!Number.isFinite(id)) continue;
        if (id > afterId) afterId = id;
        if (m.role !== 'bot') continue;
        if (seenBotIds.has(id)) continue;
        seenBotIds.add(id);
        appendBubble({ role: 'bot', text: String(m.body || '') });
        markActivity();
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

async function sendChat({ type, message, draft }) {
  const text = String(message || '').trim();
  if (!text) return;

  const display = (type && type !== '其他' ? '【' + type + '】\n' : '') + text;
  appendBubble({ role: 'user', text: display });
  lastPlain = buildPlainText({ type, message: text, draft });

  const payload = {
    source: 'yuejian-teacher-chat',
    type: type || '其他',
    message: text,
    draft: draft || null,
    threadId: threadId(),
    submittedAt: nowISO(),
    page: location.href,
    passphrase: DEFAULT_PASS,
  };

  const btn = $('#send');
  btn.disabled = true;
  try {
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
      let bursts = 0;
      const burst = () => {
        bursts += 1;
        resetPollSoon();
        if (bursts < 45) setTimeout(burst, 2000);
      };
      burst();
    } else {
      const err = (data && data.error) ? String(data.error) : ('HTTP ' + r.status);
      appendStatus('发送失败：' + err + '。可点「复制」后粘贴到和小克的对话。', false);
    }
  } catch (e) {
    appendStatus('网络异常：' + (e.message || String(e)) + '。可点「复制」离线发给小克。', false);
  } finally {
    btn.disabled = false;
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

  $('#send').onclick = async () => {
    const message = ($('#chat-input').value || '').trim();
    if (!message) return;
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
    afterId = 0;
    seenBotIds.clear();
    document.querySelectorAll('#messages .bubble.bot').forEach(el => {
      if (el.classList.contains('system') || el.classList.contains('ok') || el.classList.contains('err')) return;
      el.remove();
    });
    resetPollSoon();
    appendStatus('正在拉取回复…', true);
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
