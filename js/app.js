import * as db from './db.js';
import { VAPID_PUBLIC_KEY, APP_VERSION } from './config.js';

const { store, LS } = db;

/* =========================================================
   utils
   ========================================================= */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const today = db.localToday;
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };

function fmtDay(s) {
  const t = today();
  if (s === t) return 'วันนี้';
  if (s === addDays(t, 1)) return 'พรุ่งนี้';
  if (s === addDays(t, -1)) return 'เมื่อวาน';
  const d = parseYmd(s), diff = (d - parseYmd(t)) / 864e5;
  if (diff > 1 && diff < 7) return d.toLocaleDateString('th-TH', { weekday: 'long' });
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = '2-digit';
  return d.toLocaleDateString('th-TH', opts);
}
const fmtTime = t => (t ? t.slice(0, 5) : '');
function fmtDur(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function fmtDurShort(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (!h && !m) return sec ? '<1 นาที' : '0 นาที';
  return h ? `${h} ชม.${m ? ` ${m} น.` : ''}` : `${m} นาที`;
}
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'เมื่อสักครู่';
  if (s < 3600) return `${Math.floor(s / 60)} นาทีที่แล้ว`;
  if (s < 86400) return `${Math.floor(s / 3600)} ชม.ที่แล้ว`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} วันที่แล้ว`;
  return new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
}
const isOverdue = t => {
  if (t.status === 'done' || !t.due_date) return false;
  return t.due_time ? new Date(t.due_at) < new Date() : t.due_date < today();
};
const totalTime = t => (t.time_spent || 0) + db.runningSeconds(t);
function initial(name) {
  const s = (name || '?').trim();
  return /^[เแโใไ]/.test(s) ? s.slice(0, 2) : s.charAt(0).toUpperCase();
}
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

function haptic() {
  try {
    if (navigator.vibrate) { navigator.vibrate(12); return; }
    // iOS 18+: toggling a switch input triggers the system haptic
    const l = document.createElement('label');
    l.style.display = 'none';
    const i = document.createElement('input');
    i.type = 'checkbox'; i.setAttribute('switch', '');
    l.appendChild(i); document.body.appendChild(l); l.click(); l.remove();
  } catch {}
}

/* =========================================================
   constants & icons
   ========================================================= */
const STATUS = { todo: 'ยังไม่เริ่ม', doing: 'กำลังทำ', done: 'เสร็จแล้ว' };
const PRIO = { high: 'สูง', mid: 'กลาง', low: 'ต่ำ' };
const REPEAT = { none: 'ไม่ซ้ำ', daily: 'ทุกวัน', weekly: 'ทุกสัปดาห์', monthly: 'ทุกเดือน' };
const REMIND = [['', 'ไม่เตือน'], ['0', 'ตรงเวลา'], ['15', 'ก่อน 15 นาที'], ['60', 'ก่อน 1 ชั่วโมง'], ['180', 'ก่อน 3 ชั่วโมง'], ['1440', 'ก่อน 1 วัน']];
const REMIND_SHORT = { 0: 'เตือนตรงเวลา', 15: 'เตือนก่อน 15 นาที', 60: 'เตือนก่อน 1 ชม.', 180: 'เตือนก่อน 3 ชม.', 1440: 'เตือนก่อน 1 วัน' };
const COLORS = ['#2f6fed', '#7c5cff', '#e8508a', '#e5484d', '#e8811c', '#d4a514', '#2e9e66', '#12a3a3', '#8a8f98'];
const ACCENTS = ['#2f6fed', '#7c5cff', '#e8508a', '#e5484d', '#e8811c', '#2e9e66', '#12a3a3'];
const VIEWS = [
  { id: 'list', label: 'รายการ', icon: 'list' },
  { id: 'board', label: 'บอร์ด', icon: 'board' },
  { id: 'calendar', label: 'ปฏิทิน', icon: 'cal' },
  { id: 'stats', label: 'สรุปผล', icon: 'chart' },
];

const svg = d => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const I = {
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  list: svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'),
  board: svg('<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>'),
  cal: svg('<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  chart: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  pin: svg('<path d="M15 3l6 6-3 1-4 4 .5 4.5L13 20l-4-4-5 5M9 16l-4-4 1.5-1.5L11 11l4-4 1-3"/>'),
  flag: svg('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  repeat: svg('<path d="M17 2l3 3-3 3M4 11V9a4 4 0 014-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 01-4 4H4"/>'),
  bell: svg('<path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0"/>'),
  link: svg('<path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>'),
  clip: svg('<path d="M21 11l-8.5 8.5a5 5 0 01-7-7L14 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L15 7"/>'),
  chat: svg('<path d="M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z"/>'),
  tasks: svg('<path d="M9 11l3 3 8-8M20 12v7a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2h9"/>'),
  grip: svg('<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>'),
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  left: svg('<path d="M15 18l-6-6 6-6"/>'),
  right: svg('<path d="M9 18l6-6-6-6"/>'),
  play: svg('<path d="M7 4l13 8-13 8z"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  send: svg('<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>'),
};

/* =========================================================
   UI state
   ========================================================= */
const ui = {
  view: LS.get('taskify.view', 'list'),
  listMode: LS.get('taskify.listMode', 'time'),
  theme: LS.get('taskify.theme', 'auto'),
  accent: LS.get('taskify.accent', '#2f6fed'),
  person: 'all',
  category: '',
  search: '',
  searchOpen: false,
  showAllDone: false,
  doneOpen: false,
  calMonth: today().slice(0, 7),
  calDay: today(),
  hidden: new Set(),
  pushOn: false,
  welcomeDismissed: LS.get('taskify.welcomeDone', false),
};
const sheet = { open: false, kind: null, id: null, isNew: false, draft: null, drafts: {}, addingLink: false, catColor: null };
const photoSrc = new Map();
let busy = false, renderQueued = false;
const pendingDeletes = new Map();

/* =========================================================
   theme
   ========================================================= */
function applyTheme() {
  const r = document.documentElement;
  if (ui.theme === 'auto') r.removeAttribute('data-theme'); else r.dataset.theme = ui.theme;
  r.style.setProperty('--accent', ui.accent);
  const dark = ui.theme === 'dark' || (ui.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', dark ? '#121214' : '#f4f3ef'));
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

/* =========================================================
   toast
   ========================================================= */
function toast(msg, opts = {}) {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast' + (opts.err ? ' err' : '');
  el.innerHTML = `<span>${esc(msg)}</span>${opts.action ? `<button>${esc(opts.action)}</button>` : ''}`;
  let done = false;
  const close = () => { if (done) return; done = true; el.style.opacity = '0'; el.style.transition = 'opacity .2s'; setTimeout(() => el.remove(), 200); };
  if (opts.action) el.querySelector('button').onclick = () => { opts.onAction?.(); close(); };
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(close, opts.ms || (opts.action ? 5000 : 2600));
}

/* =========================================================
   derived data
   ========================================================= */
const allTasks = () => [...store.tasks.values()].filter(t => !ui.hidden.has(t.id));
const categories = () => [...store.categories.values()].sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name));
const activityFor = id => store.activity.filter(a => a.task_id === id);
const commentCount = id => store.activity.reduce((n, a) => n + (a.task_id === id && a.kind === 'comment' ? 1 : 0), 0);

function filtered(list = allTasks()) {
  const M = db.me(), P = db.partner();
  const q = ui.search.trim().toLowerCase();
  return list.filter(t => {
    if (ui.person === 'me' && t.assignee !== M?.user_id) return false;
    if (ui.person === 'partner' && (!P?.user_id || t.assignee !== P.user_id)) return false;
    if (ui.person === 'shared' && t.assignee) return false;
    if (ui.category && t.category_id !== ui.category) return false;
    if (q) {
      const hay = [t.title, t.note, ...(t.subtasks || []).map(s => s.text)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
const prioRank = { high: 0, mid: 1, low: 2 };
const byDue = (a, b) =>
  (b.pinned - a.pinned) ||
  (a.due_at || '9999').localeCompare(b.due_at || '9999') ||
  (prioRank[a.priority] - prioRank[b.priority]) ||
  ((a.sort || 0) - (b.sort || 0));
const byManual = (a, b) => (b.pinned - a.pinned) || ((a.sort || 0) - (b.sort || 0));
const byCompleted = (a, b) => (b.completed_at || '').localeCompare(a.completed_at || '');

function bucket(t) {
  if (t.status === 'done') return 'done';
  if (t.pinned) return 'pinned';
  if (isOverdue(t)) return 'overdue';
  if (!t.due_date) return 'nodate';
  const td = today();
  if (t.due_date === td) return 'today';
  if (t.due_date === addDays(td, 1)) return 'tomorrow';
  if (t.due_date <= addDays(td, 7)) return 'week';
  return 'later';
}
const BUCKETS = [
  ['pinned', 'ปักหมุด'], ['overdue', 'เลยกำหนด'], ['today', 'วันนี้'], ['tomorrow', 'พรุ่งนี้'],
  ['week', '7 วันข้างหน้า'], ['later', 'ภายหลัง'], ['nodate', 'ไม่มีกำหนด'],
];

function ctxDefaults() {
  const M = db.me(), P = db.partner();
  const d = {};
  if (ui.category) d.category_id = ui.category;
  if (ui.person === 'me' && M?.user_id) d.assignee = M.user_id;
  if (ui.person === 'partner' && P?.user_id) d.assignee = P.user_id;
  if (ui.view === 'calendar') d.due_date = ui.calDay;
  return d;
}

/* =========================================================
   components
   ========================================================= */
function avatar(m, cls = '') {
  if (!m) return '';
  return `<span class="avatar ${cls}" style="--c:${esc(m.color)}" title="${esc(m.display_name)}">${esc(initial(m.display_name))}</span>`;
}

// shared task (no assignee): both members' circles, slightly overlapped
function sharedAvatars() {
  const ms = store.members.slice(0, 2);
  if (ms.length < 2) return '';
  return `<span class="avatars" title="ร่วมกัน">${ms.map(m => avatar(m, 'sm')).join('')}</span>`;
}

function card(t, opts = {}) {
  const cat = store.categories.get(t.category_id);
  const subs = t.subtasks || [];
  const sd = subs.filter(s => s.done).length;
  const od = isOverdue(t);
  const asg = t.assignee ? db.memberById(t.assignee) : null;
  const cc = commentCount(t.id);
  const att = (t.attachments || []).length;
  // always-visible fields: status, priority, category, due date, reminder (who = avatars on the right)
  const tags = [];
  tags.push(`<span class="tag st-${t.status}">${STATUS[t.status]}</span>`);
  tags.push(`<span class="tag ${t.priority}">${I.flag}${PRIO[t.priority]}</span>`);
  tags.push(cat
    ? `<span class="tag" style="--c:${esc(cat.color)}"><span class="dot"></span>${esc(cat.name)}</span>`
    : `<span class="tag none">ไม่มีหมวด</span>`);
  if (t.due_date) {
    const cls = od ? 'od' : (t.due_date === today() && t.status !== 'done' ? 'today' : '');
    tags.push(`<span class="tag ${cls}">${I.cal}${fmtDay(t.due_date)}${t.due_time ? ' ' + fmtTime(t.due_time) : ''}</span>`);
  } else tags.push(`<span class="tag none">${I.cal}ไม่มีกำหนด</span>`);
  tags.push(t.remind_before != null && t.due_date
    ? `<span class="tag">${I.bell}${REMIND_SHORT[t.remind_before] ?? 'เตือน'}</span>`
    : `<span class="tag none">${I.bell}ไม่เตือน</span>`);
  if (t.repeat !== 'none') tags.push(`<span class="tag">${I.repeat}${REPEAT[t.repeat]}</span>`);
  if (subs.length) tags.push(`<span class="tag">${I.tasks}${sd}/${subs.length}</span>`);
  if (att) tags.push(`<span class="tag">${I.clip}${att}</span>`);
  if (cc) tags.push(`<span class="tag">${I.chat}${cc}</span>`);
  if (t.timer_started_at) tags.push(`<span class="tag run">${I.clock}<span data-timer="${t.id}">${fmtDur(totalTime(t))}</span></span>`);
  else if (t.time_spent) tags.push(`<span class="tag">${I.clock}${fmtDurShort(t.time_spent)}</span>`);

  return `<div class="swipe" data-id="${t.id}">
    <div class="swipe-bg"><span class="l">${I.check} ${t.status === 'done' ? 'ยังไม่เสร็จ' : 'เสร็จแล้ว'}</span><span class="r">ลบ ${I.trash}</span></div>
    <div class="task ${t.status} p-${t.priority}" data-id="${t.id}" ${opts.board ? 'data-board' : 'data-swipe'} style="${cat ? `--cat:${esc(cat.color)}` : ''}">
      <button class="check" data-act="toggle-done" data-id="${t.id}" aria-label="ทำเครื่องหมายว่าเสร็จ">${I.check}</button>
      <div class="t-body" data-act="open" data-id="${t.id}">
        <div class="t-title">${esc(t.title)}</div>
        ${t.note && !opts.compact ? `<div class="t-note">${esc(t.note)}</div>` : ''}
        ${tags.length ? `<div class="meta">${tags.join('')}</div>` : ''}
        ${subs.length && t.status !== 'done' ? `<div class="sub-bar"><div style="width:${(sd / subs.length) * 100}%"></div></div>` : ''}
      </div>
      <div class="t-side">
        ${asg ? avatar(asg, 'sm') : sharedAvatars()}
        ${t.pinned ? `<span class="pin">${I.pin}</span>` : ''}
        ${opts.handle ? `<button class="handle" data-drag="reorder" aria-label="ลากเพื่อเรียงลำดับ">${I.grip}</button>` : ''}
      </div>
    </div>
  </div>`;
}

/* =========================================================
   shell
   ========================================================= */
function renderShell() {
  document.body.innerHTML = `
    <div class="top"><div class="wrap">
      <div class="top-row">
        <div class="hello"><small id="greet"></small><h1 id="viewTitle"></h1></div>
        <span class="sync" id="sync"></span>
        <button class="avatar" id="meBtn" data-act="settings" aria-label="ตั้งค่า"></button>
      </div>
      <div class="summary" id="summary"></div>
      <div class="quick" id="quickRow">
        <div class="quick-field">${I.plus}<input id="quick" placeholder="เพิ่มงานด่วน… แล้วกด Enter" enterkeyhint="done" autocomplete="off" maxlength="300"></div>
        <button class="icon-btn" id="searchBtn" data-act="search-toggle" aria-label="ค้นหา">${I.search}</button>
      </div>
      <div class="quick hidden" id="searchRow">
        <div class="quick-field">${I.search}<input id="search" type="search" placeholder="ค้นหาชื่องาน โน้ต หรืองานย่อย…" autocomplete="off"></div>
      </div>
      <div class="chips" id="chips"></div>
    </div></div>
    <main><div class="wrap" id="view"></div></main>
    <button class="fab" data-act="new" aria-label="เพิ่มงานใหม่">${I.plus}</button>
    <nav class="tabbar"><div class="tabbar-in" id="tabbar"></div></nav>
    <div class="backdrop" id="backdrop" data-act="close-sheet"></div>
    <div class="sheet" id="sheet" role="dialog" aria-modal="true"></div>
    <div class="toasts" id="toasts"></div>`;
}

function render() {
  if (busy) { renderQueued = true; return; }
  if (!$('#view')) return;
  renderHeader();
  renderView();
  if (sheet.open) renderSheet();
}

function renderHeader() {
  const M = db.me();
  const name = M?.display_name || store.user?.email?.split('@')[0] || '';
  const h = new Date().getHours();
  $('#greet').textContent = `${h < 12 ? 'อรุณสวัสดิ์' : h < 17 ? 'สวัสดีตอนบ่าย' : 'สวัสดีตอนเย็น'}, ${name}`;
  $('#viewTitle').textContent = { list: 'งานของเรา', board: 'บอร์ดงาน', calendar: 'ปฏิทิน', stats: 'สรุปผล' }[ui.view];
  const meBtn = $('#meBtn');
  meBtn.style.setProperty('--c', M?.color || 'var(--accent)');
  meBtn.textContent = initial(name);

  const syncLabel = { idle: 'ซิงก์แล้ว', syncing: 'กำลังซิงก์', offline: 'ออฟไลน์', error: 'ผิดพลาด', local: 'โหมดทดลอง' }[store.sync];
  const s = $('#sync');
  s.dataset.s = store.sync;
  s.textContent = db.pendingCount() && store.sync === 'offline' ? `ออฟไลน์ · รอ ${db.pendingCount()}` : syncLabel;

  const open = allTasks().filter(t => t.status !== 'done');
  const todayN = open.filter(t => t.due_date === today()).length;
  const od = open.filter(isOverdue).length;
  $('#summary').innerHTML = `ค้างอยู่ <b>${open.length}</b> งาน · วันนี้ <b>${todayN}</b>${od ? ` · <span class="od">เลยกำหนด ${od}</span>` : ''}`;

  $('#quickRow').classList.toggle('hidden', ui.view === 'stats');
  $('#searchRow').classList.toggle('hidden', !ui.searchOpen || ui.view === 'stats');
  $('#searchBtn').classList.toggle('on', ui.searchOpen);
  $('.fab').classList.toggle('hidden', ui.view === 'stats');

  const P = db.partner();
  const people = [['all', 'ทุกคน'], ['me', M ? `ของฉัน` : 'ของฉัน']];
  if (P) people.push(['partner', `ของ${P.display_name}`]);
  people.push(['shared', 'ร่วมกัน']);
  $('#chips').innerHTML =
    people.map(([v, l]) => `<button class="chip-btn ${ui.person === v ? 'on' : ''}" data-act="person" data-v="${v}">${esc(l)}</button>`).join('') +
    `<span class="chip-sep"></span>` +
    `<button class="chip-btn ${!ui.category ? 'on' : ''}" data-act="cat" data-v="">ทุกหมวด</button>` +
    categories().map(c => `<button class="chip-btn ${ui.category === c.id ? 'on' : ''}" data-act="cat" data-v="${c.id}" style="--c:${esc(c.color)}"><span class="dot"></span>${esc(c.name)}</button>`).join('') +
    `<button class="chip-btn" data-act="manage-cats">${I.plus.replace('class="i"', 'class="i" style="width:14px;height:14px"')} หมวด</button>`;

  $('#tabbar').innerHTML = VIEWS.map(v =>
    `<button class="${ui.view === v.id ? 'on' : ''}" data-act="view" data-v="${v.id}">${I[v.icon]}<span>${v.label}</span></button>`).join('');
}

function renderView() {
  const el = $('#view');
  const banner = db.configured ? '' : `<div class="banner">โหมดทดลอง: ข้อมูลเก็บในเครื่องนี้เท่านั้น ยังไม่ได้เชื่อมกับฐานข้อมูลออนไลน์</div>`;
  if (ui.view === 'board') el.innerHTML = banner + viewBoard();
  else if (ui.view === 'calendar') el.innerHTML = banner + viewCalendar();
  else if (ui.view === 'stats') el.innerHTML = banner + viewStats();
  else el.innerHTML = banner + viewList();
}

/* =========================================================
   list view
   ========================================================= */
function welcome() {
  return `<div class="welcome">
    <h3>ยินดีต้อนรับสู่ Taskify 👋</h3>
    <p>รายการงานที่คุณกับ${esc(db.partner()?.display_name || 'แฟน')}เห็นตรงกันแบบเรียลไทม์</p>
    <ul>
      <li><span>⌨️</span><span>พิมพ์ในช่องด้านบนแล้วกด Enter เพื่อเพิ่มงานด่วน ลงท้ายด้วย “พรุ่งนี้” หรือขึ้นต้นด้วย “!” ได้</span></li>
      <li><span>👉</span><span>ปัดงานไปทางขวา = เสร็จ · ปัดไปทางซ้าย = ลบ</span></li>
      <li><span>✋</span><span>ในหน้าบอร์ด กดค้างที่งานแล้วลากไปคอลัมน์อื่น</span></li>
      <li><span>🔔</span><span>เปิดการแจ้งเตือนได้ที่ปุ่มโปรไฟล์มุมขวาบน</span></li>
    </ul>
  </div>`;
}

function viewList() {
  const list = filtered();
  const open = list.filter(t => t.status !== 'done');
  const done = list.filter(t => t.status === 'done').sort(byCompleted);
  const anyTasks = store.tasks.size > 0;
  let html = `<div class="seg-row"><span></span><div class="mini-seg">
      <button class="${ui.listMode === 'time' ? 'on' : ''}" data-act="list-mode" data-v="time">ตามเวลา</button>
      <button class="${ui.listMode === 'manual' ? 'on' : ''}" data-act="list-mode" data-v="manual">เรียงเอง</button>
    </div></div>`;

  if (!anyTasks) return html + welcome();
  if (!list.length) return html + `<div class="empty"><div class="big">🔍</div>ไม่พบงานที่ตรงกับตัวกรอง</div>`;
  if (!open.length) html += `<div class="empty"><div class="big">🎉</div>ไม่มีงานค้าง เยี่ยมมาก!</div>`;

  if (ui.listMode === 'manual') {
    if (open.length) html += `<div class="group-title">ลากที่ ⋮⋮ เพื่อเรียงลำดับ</div><div class="list" data-reorder>${open.sort(byManual).map(t => card(t, { handle: true })).join('')}</div>`;
  } else {
    const groups = {};
    for (const t of open) (groups[bucket(t)] ||= []).push(t);
    for (const [k, label] of BUCKETS) {
      const g = groups[k];
      if (!g?.length) continue;
      html += `<div class="group-title ${k === 'overdue' ? 'od' : ''}">${label} <span class="n">${g.length}</span></div>
        <div class="list">${g.sort(byDue).map(t => card(t)).join('')}</div>`;
    }
  }
  if (done.length) {
    const shown = ui.showAllDone ? done : done.slice(0, 20);
    html += `<div class="group-title">เสร็จแล้ว <span class="n">${done.length}</span>
      <button data-act="toggle-done-group">${ui.doneOpen ? 'ซ่อน' : 'แสดง'}</button></div>`;
    if (ui.doneOpen) {
      html += `<div class="list">${shown.map(t => card(t, { compact: true })).join('')}</div>`;
      if (done.length > shown.length) html += `<div class="empty" style="padding:14px"><button class="btn ghost" data-act="show-all-done">แสดงทั้งหมด (${done.length})</button></div>`;
    }
  }
  return html;
}

/* =========================================================
   board view
   ========================================================= */
function viewBoard() {
  const list = filtered();
  const cols = [['todo', 'ยังไม่เริ่ม', 'var(--faint)'], ['doing', 'กำลังทำ', 'var(--doing)'], ['done', 'เสร็จแล้ว', 'var(--done)']];
  return `<div class="board">${cols.map(([s, label, c]) => {
    let items = list.filter(t => t.status === s);
    items = s === 'done' ? items.sort(byCompleted).slice(0, 40) : items.sort(byDue);
    return `<section class="col" data-col="${s}">
      <div class="col-head"><span class="bullet" style="--c:${c}"></span>${label} <span class="n">${list.filter(t => t.status === s).length}</span>
        ${s !== 'done' ? `<button class="icon-btn plain" data-act="col-add" data-v="${s}" aria-label="เพิ่มงานในคอลัมน์นี้">${I.plus}</button>` : ''}</div>
      <div class="list">${items.map(t => card(t, { board: true, compact: true })).join('') || `<div class="empty" style="padding:24px 8px;font-size:14px">ลากงานมาวางที่นี่</div>`}</div>
    </section>`;
  }).join('')}</div><div class="board-hint">กดค้างที่งานแล้วลากเพื่อย้ายสถานะ · ปัดซ้าย/ขวาเพื่อดูคอลัมน์อื่น</div>`;
}

/* =========================================================
   calendar view
   ========================================================= */
function viewCalendar() {
  const [y, m] = ui.calMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const start = new Date(first); start.setDate(1 - first.getDay());
  const list = filtered();
  const byDay = {};
  for (const t of list) if (t.due_date) (byDay[t.due_date] ||= []).push(t);
  const td = today();
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = ymd(d);
    const items = byDay[key] || [];
    const open = items.filter(t => t.status !== 'done');
    const od = open.some(isOverdue);
    const dots = open.slice(0, 4).map(t => `<i style="--c:${esc(store.categories.get(t.category_id)?.color || 'var(--accent)')}"></i>`).join('')
      + (items.length && !open.length ? `<i style="--c:var(--done);opacity:.5"></i>` : '');
    cells += `<button class="cal-day ${d.getMonth() !== m - 1 ? 'other' : ''} ${key === td ? 'today' : ''} ${key === ui.calDay ? 'sel' : ''} ${od ? 'od' : ''}" data-act="cal-day" data-d="${key}">
      <span class="num">${d.getDate()}</span><span class="cal-dots">${dots}</span></button>`;
    if (i >= 34 && d.getMonth() !== m - 1 && d.getDay() === 6) break;
  }
  const dayItems = (byDay[ui.calDay] || []).sort((a, b) => (a.status === 'done') - (b.status === 'done') || byDue(a, b));
  const monthLabel = first.toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });
  const noDate = list.filter(t => !t.due_date && t.status !== 'done').length;
  return `
    <div class="cal-head"><h2>${monthLabel}</h2><div class="btns">
      <button class="icon-btn" data-act="cal-prev" aria-label="เดือนก่อน">${I.left}</button>
      <button class="icon-btn" data-act="cal-today" aria-label="วันนี้" style="width:auto;padding:0 12px;font-size:14px">วันนี้</button>
      <button class="icon-btn" data-act="cal-next" aria-label="เดือนถัดไป">${I.right}</button></div></div>
    <div class="cal"><div class="cal-grid">
      ${['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'].map(d => `<div class="cal-dow">${d}</div>`).join('')}
      ${cells}
    </div></div>
    <div class="group-title">${parseYmd(ui.calDay).toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long' })} <span class="n">${dayItems.length}</span>
      <button data-act="new">+ เพิ่มงานวันนี้</button></div>
    <div class="list">${dayItems.map(t => card(t)).join('') || `<div class="empty" style="padding:20px">ไม่มีงานในวันนี้</div>`}</div>
    ${noDate ? `<div class="empty" style="padding:16px;font-size:13px">มีอีก ${noDate} งานที่ไม่มีกำหนดส่ง (ดูได้ในหน้ารายการ)</div>` : ''}`;
}

/* =========================================================
   stats view
   ========================================================= */
function weekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
function viewStats() {
  const list = filtered();
  const members = store.members;
  const done = list.filter(t => t.status === 'done' && t.completed_at);
  const open = list.filter(t => t.status !== 'done');
  const ws = weekStart(new Date());
  const doneWeek = done.filter(t => new Date(t.completed_at) >= ws);
  const od = open.filter(isOverdue).length;
  const weekSecs = list.reduce((s, t) => s + (new Date(t.updated_at) >= ws || t.timer_started_at ? totalTime(t) : 0), 0);
  const withDue = done.filter(t => t.due_at);
  const onTime = withDue.length ? Math.round(withDue.filter(t => t.completed_at <= (t.due_time ? t.due_at : computeEndOfDay(t.due_date))).length / withDue.length * 100) : null;

  // 8-week bars, stacked by who completed it (assignee, else creator)
  const weeks = [];
  for (let i = 7; i >= 0; i--) { const s = new Date(ws); s.setDate(s.getDate() - i * 7); weeks.push(s); }
  const who = t => t.assignee || t.created_by;
  const colorOf = id => db.memberById(id)?.color || 'var(--faint)';
  const series = weeks.map((s, i) => {
    const e = weeks[i + 1] || new Date(8.64e15);
    const items = done.filter(t => { const c = new Date(t.completed_at); return c >= s && c < e; });
    const by = {};
    for (const t of items) by[who(t)] = (by[who(t)] || 0) + 1;
    return { s, n: items.length, by };
  });
  const max = Math.max(1, ...series.map(x => x.n));
  const bars = series.map(x => `<div class="bar-col"><b>${x.n || ''}</b>
      <div class="bar" style="height:${Math.max(2, x.n / max * 100)}%">${Object.entries(x.by).map(([id, n]) => `<i style="--c:${esc(colorOf(id))};height:${n / x.n * 100}%"></i>`).join('')}</div>
      <small>${x.s.getDate()}/${x.s.getMonth() + 1}</small></div>`).join('');

  const people = members.filter(m => m.user_id).map(m => {
    const d = done.filter(t => who(t) === m.user_id).length;
    const o = open.filter(t => t.assignee === m.user_id).length;
    return { m, d, o };
  });
  const shared = { d: done.filter(t => !t.assignee).length, o: open.filter(t => !t.assignee).length };
  const pmax = Math.max(1, ...people.map(p => p.d + p.o), shared.d + shared.o);
  const hbar = (name, color, d, o, m) => `<div class="hbar"><span class="name">${name}</span>
      <span class="track"><i style="--c:${color};width:${d / m * 100}%"></i><i class="open" style="--c:${color};width:${o / m * 100}%"></i></span>
      <span class="num">${d}/${d + o}</span></div>`;

  const cats = categories().map(c => ({ c, d: done.filter(t => t.category_id === c.id).length, o: open.filter(t => t.category_id === c.id).length }))
    .filter(x => x.d + x.o);
  const none = { d: done.filter(t => !t.category_id).length, o: open.filter(t => !t.category_id).length };
  const cmax = Math.max(1, ...cats.map(x => x.d + x.o), none.d + none.o);

  return `
    <div class="tiles">
      <div class="tile"><div class="v">${doneWeek.length}</div><div class="l">เสร็จสัปดาห์นี้</div></div>
      <div class="tile"><div class="v">${open.length}</div><div class="l">ค้างอยู่</div></div>
      <div class="tile ${od ? 'od' : ''}"><div class="v">${od}</div><div class="l">เลยกำหนด</div></div>
      <div class="tile"><div class="v">${onTime == null ? '–' : onTime + '%'}</div><div class="l">เสร็จทันกำหนด</div></div>
    </div>
    <div class="card"><h3>งานที่เสร็จ 8 สัปดาห์ล่าสุด</h3>
      <div class="bars">${bars}</div>
      <div class="legend">${members.filter(m => m.user_id).map(m => `<span><i style="--c:${esc(m.color)}"></i>${esc(m.display_name)}</span>`).join('')}</div>
    </div>
    <div class="card"><h3>แยกตามคน <small>· เสร็จ / ทั้งหมด</small></h3>
      ${people.map(p => hbar(`${avatar(p.m, 'sm')} ${esc(p.m.display_name)}`, esc(p.m.color), p.d, p.o, pmax)).join('')}
      ${shared.d + shared.o ? hbar('👫 ร่วมกัน', 'var(--accent)', shared.d, shared.o, pmax) : ''}
    </div>
    <div class="card"><h3>แยกตามหมวดหมู่ <small>· เสร็จ / ทั้งหมด</small></h3>
      ${cats.map(x => hbar(`<span class="tag" style="--c:${esc(x.c.color)};border:none;padding:0;background:none"><span class="dot"></span></span>${esc(x.c.name)}`, esc(x.c.color), x.d, x.o, cmax)).join('')}
      ${none.d + none.o ? hbar('ไม่มีหมวด', 'var(--faint)', none.d, none.o, cmax) : ''}
      ${!cats.length && !(none.d + none.o) ? `<div class="help">ยังไม่มีข้อมูล</div>` : ''}
    </div>
    <div class="card"><h3>เวลาที่จับไว้ <small>· ทั้งหมด</small></h3>
      ${timeByPerson()}
    </div>`;
}
function computeEndOfDay(date) { return new Date(`${date}T23:59:59`).toISOString(); }
function timeByPerson() {
  const rows = store.members.filter(m => m.user_id).map(m => {
    const s = allTasks().filter(t => (t.assignee || t.created_by) === m.user_id).reduce((a, t) => a + totalTime(t), 0);
    return { m, s };
  });
  const top = allTasks().filter(t => totalTime(t) > 0).sort((a, b) => totalTime(b) - totalTime(a)).slice(0, 5);
  if (!top.length) return `<div class="help">ยังไม่ได้จับเวลางานไหน กดปุ่ม “เริ่มจับเวลา” ในรายละเอียดงาน</div>`;
  return rows.map(r => `<div class="hbar"><span class="name">${avatar(r.m, 'sm')} ${esc(r.m.display_name)}</span><span></span><span class="num" style="grid-column:2/4;text-align:right">${fmtDurShort(r.s)}</span></div>`).join('')
    + `<div class="group-title" style="margin:14px 0 6px">ใช้เวลามากที่สุด</div>`
    + top.map(t => `<div class="hbar" data-act="open" data-id="${t.id}" style="cursor:pointer"><span class="name" style="grid-column:1/3">${esc(t.title)}</span><span class="num">${fmtDurShort(totalTime(t))}</span></div>`).join('');
}

/* =========================================================
   sheets
   ========================================================= */
function openTask(id) {
  if (!store.tasks.has(id)) return;
  Object.assign(sheet, { open: true, kind: 'task', id, isNew: false, draft: null, drafts: {}, addingLink: false });
  renderSheet(true);
}
function openNew(defaults = {}) {
  Object.assign(sheet, {
    open: true, kind: 'task', id: null, isNew: true, drafts: {}, addingLink: false,
    draft: { title: '', note: '', status: 'todo', priority: 'mid', category_id: null, assignee: null, due_date: null, due_time: null, remind_before: null, repeat: 'none', pinned: false, subtasks: [], attachments: [], ...ctxDefaults(), ...defaults },
  });
  renderSheet(true);
  setTimeout(() => $('#dTitle')?.focus(), 320);
}
function openSettings(scrollTo) {
  Object.assign(sheet, { open: true, kind: 'settings', id: null, isNew: false, drafts: {} });
  renderSheet(true);
  if (scrollTo) setTimeout(() => $('#' + scrollTo)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 320);
}
function closeSheet() {
  if (!sheet.open) return;
  const a = document.activeElement;
  if (a && $('#sheet').contains(a)) a.blur();
  sheet.open = false;
  $('#sheet').classList.remove('open');
  $('#backdrop').classList.remove('open');
  $('#sheet').style.transform = '';
  setTimeout(() => { if (!sheet.open) $('#sheet').innerHTML = ''; }, 320);
}

function renderSheet(first = false) {
  const el = $('#sheet');
  if (!el) return;
  // preserve focus, caret, scroll and unsent text across re-renders
  const active = document.activeElement;
  const focusId = active && el.contains(active) ? active.id : null;
  const sel = focusId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  if (focusId && ('value' in active)) sheet.drafts[focusId] = active.value;
  const scroll = $('#sheetBody')?.scrollTop || 0;

  el.innerHTML = sheet.kind === 'settings' ? settingsSheet() : taskSheet();
  if (!sheet.open) return;

  for (const [id, v] of Object.entries(sheet.drafts)) { const f = document.getElementById(id); if (f && f.value !== v) f.value = v; }
  const body = $('#sheetBody');
  if (body && !first) body.scrollTop = scroll;
  if (focusId) { const f = document.getElementById(focusId); if (f) { f.focus({ preventScroll: true }); if (sel && f.setSelectionRange) try { f.setSelectionRange(...sel); } catch {} } }
  autosize($('#dTitle'));
  loadPhotos();
  if (first) { requestAnimationFrame(() => { el.classList.add('open'); $('#backdrop').classList.add('open'); }); }
}

function currentTask() { return sheet.isNew ? sheet.draft : store.tasks.get(sheet.id); }

function seg(field, map, value, extra = {}) {
  return Object.entries(map).map(([v, l]) =>
    `<button class="${String(value ?? '') === v ? 'on' : ''}" data-act="seg" data-f="${field}" data-v="${esc(v)}" ${extra.disabled?.includes(v) ? 'disabled' : ''}>${esc(l)}</button>`).join('');
}

function taskSheet() {
  const t = currentTask();
  if (!t) { setTimeout(closeSheet); return ''; }
  const M = db.me(), P = db.partner();
  const subs = t.subtasks || [];
  const sd = subs.filter(s => s.done).length;
  const links = (t.attachments || []).map((a, i) => ({ ...a, i })).filter(a => a.type === 'link');
  const photos = (t.attachments || []).map((a, i) => ({ ...a, i })).filter(a => a.type === 'photo');
  const asgMap = { '': '👫 ร่วมกัน' };
  if (M?.user_id) asgMap[M.user_id] = M.display_name;
  if (P) asgMap[P.user_id || 'pending-partner'] = P.display_name;
  const disabled = P && !P.user_id ? ['pending-partner'] : [];
  const cats = categories();

  let html = `
    <div class="sheet-grab" data-grab></div>
    <div class="sheet-head" data-grab>
      <button class="text-btn muted" data-act="close-sheet">${sheet.isNew ? 'ยกเลิก' : 'ปิด'}</button>
      <div class="ttl">${sheet.isNew ? 'งานใหม่' : ''}</div>
      ${sheet.isNew
        ? `<button class="text-btn" data-act="create-task">เพิ่ม</button>`
        : `<button class="icon-btn plain" data-act="seg" data-f="pinned" data-v="${t.pinned ? '' : '1'}" aria-label="ปักหมุด" style="color:${t.pinned ? 'var(--accent)' : 'var(--faint)'}">${I.pin}</button>`}
    </div>
    <div class="sheet-body" id="sheetBody">
      <textarea id="dTitle" class="title-input" data-f="title" rows="1" placeholder="ชื่องาน" maxlength="300" enterkeyhint="done">${esc(t.title)}</textarea>
      <div class="group">
        <div class="row"><div class="seg">${seg('status', STATUS, t.status)}</div></div>
        <div class="row"><span class="lbl">ความสำคัญ</span><div class="ctl"><div class="seg">${seg('priority', PRIO, t.priority)}</div></div></div>
        <div class="row"><span class="lbl">ใครทำ</span><div class="ctl"><div class="seg">${seg('assignee', asgMap, t.assignee || '', { disabled })}</div></div></div>
        <div class="row"><span class="lbl">หมวดหมู่</span><div class="ctl nowrap">
          <span class="cat-dot" style="--c:${esc(store.categories.get(t.category_id)?.color || 'transparent')}"></span>
          <select id="dCat" data-f="category_id" aria-label="หมวดหมู่">
            <option value="" ${!t.category_id ? 'selected' : ''}>ไม่มีหมวด</option>
            ${cats.map(c => `<option value="${c.id}" ${t.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
            <option value="__new">+ เพิ่มหมวดใหม่…</option>
          </select>
        </div></div>
      </div>
      <div class="group">
        <div class="row"><span class="lbl">${I.cal} กำหนดส่ง</span><div class="ctl nowrap">
          <input type="date" id="dDate" data-f="due_date" value="${t.due_date || ''}">
          <input type="time" id="dTime" data-f="due_time" value="${fmtTime(t.due_time)}" ${t.due_date ? '' : 'disabled'} aria-label="เวลา">
          ${t.due_date ? `<button class="x-btn" data-act="clear-due" aria-label="ล้างกำหนดส่ง">${I.x}</button>` : ''}
        </div></div>
        ${!t.due_date ? `<div class="row" style="justify-content:flex-start;gap:6px;flex-wrap:wrap">
          ${[['วันนี้', 0], ['พรุ่งนี้', 1], ['สัปดาห์หน้า', 7]].map(([l, n]) => `<button class="chip-btn" data-act="quick-due" data-v="${n}">${l}</button>`).join('')}</div>` : ''}
        <div class="row"><span class="lbl">${I.repeat} ทำซ้ำ</span><div class="ctl"><select id="dRepeat" data-f="repeat">
          ${Object.entries(REPEAT).map(([v, l]) => `<option value="${v}" ${t.repeat === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
        <div class="row"><span class="lbl">${I.bell} เตือน</span><div class="ctl"><select id="dRemind" data-f="remind_before" ${t.due_date ? '' : 'disabled'}>
          ${REMIND.map(([v, l]) => `<option value="${v}" ${String(t.remind_before ?? '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
        ${db.configured && t.due_date && t.remind_before != null && !ui.pushOn ? `<div class="help" style="border-top:1px solid var(--line)">ยังไม่ได้เปิดการแจ้งเตือนในเครื่องนี้ · <a href="#" data-act="settings-push" style="color:var(--accent)">เปิดเลย</a></div>` : ''}
      </div>
      <div class="group"><textarea id="dNote" class="note" data-f="note" placeholder="รายละเอียด / โน้ต">${esc(t.note)}</textarea></div>

      <div class="sec-title">งานย่อย <span class="n">${subs.length ? `${sd}/${subs.length}` : ''}</span>${subs.length ? `<div class="sub-bar"><div style="width:${sd / subs.length * 100}%"></div></div>` : ''}</div>
      <div class="group">
        ${subs.map(s => `<div class="sub-row ${s.done ? 'done' : ''}">
          <button class="check" data-act="sub-toggle" data-sid="${s.id}" aria-label="ติ๊กงานย่อย">${I.check}</button>
          <input id="sub-${s.id}" data-sub="${s.id}" value="${esc(s.text)}" maxlength="200">
          <button class="x-btn" data-act="sub-del" data-sid="${s.id}" aria-label="ลบงานย่อย">${I.x}</button></div>`).join('')}
        <div class="add-row">${I.plus}<input id="dSubAdd" placeholder="เพิ่มงานย่อย" enterkeyhint="enter" maxlength="200"></div>
      </div>

      <div class="sec-title">ไฟล์แนบ <span class="n">${(t.attachments || []).length || ''}</span></div>
      <div class="group">
        ${links.length ? `<div class="att-links">${links.map(a => `<a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${I.link}<span>${esc(a.title || a.url)}</span><button class="x-btn" data-act="att-del" data-i="${a.i}" aria-label="ลบลิงก์">${I.x}</button></a>`).join('')}</div>` : ''}
        ${photos.length ? `<div class="photos" style="${links.length ? 'border-top:1px solid var(--line)' : ''}">${photos.map(a => `<div class="photo loading" data-path="${esc(a.path)}" data-act="photo-view"><img alt="" data-src="${esc(a.path)}"><button class="x-btn" data-act="att-del" data-i="${a.i}" aria-label="ลบรูป">${I.x}</button></div>`).join('')}</div>` : ''}
        ${sheet.addingLink ? `<div class="add-row" style="${links.length || photos.length ? '' : 'border-top:none'}">${I.link}<input id="dLink" type="url" inputmode="url" placeholder="วางลิงก์ https://…" enterkeyhint="done"><button class="text-btn" data-act="att-link-add">เพิ่ม</button></div>` : ''}
        <div class="att-actions" style="${links.length || photos.length || sheet.addingLink ? 'border-top:1px solid var(--line)' : ''}">
          <button data-act="att-link-show">${I.link} ลิงก์</button>
          <label>${I.image} รูปภาพ<input type="file" id="dPhoto" accept="image/*" multiple></label>
        </div>
      </div>`;

  if (!sheet.isNew) {
    const running = !!t.timer_started_at;
    const acts = activityFor(t.id).slice().reverse();
    html += `
      <div class="sec-title">จับเวลา</div>
      <div class="group"><div class="timer">
        <div class="big"><span data-timer="${t.id}">${fmtDur(totalTime(t))}</span><small>${running ? 'กำลังจับเวลา…' : t.time_spent ? 'เวลาที่ใช้ไปทั้งหมด' : 'ยังไม่เริ่มจับเวลา'}</small></div>
        ${running
          ? `<button class="btn stop" data-act="timer-stop">${I.stop} หยุด</button>`
          : `<button class="btn primary" data-act="timer-start">${I.play} เริ่ม</button>`}
        ${t.time_spent && !running ? `<button class="x-btn" data-act="timer-reset" aria-label="ล้างเวลา">${I.x}</button>` : ''}
      </div></div>

      <div class="sec-title">ความคิดเห็นและประวัติ</div>
      <div class="group">
        <div class="comment-box">
          <textarea id="dComment" rows="1" placeholder="เขียนความคิดเห็น…" maxlength="1000"></textarea>
          <button class="btn primary" data-act="comment-send" aria-label="ส่ง" style="padding:10px 12px">${I.send}</button>
        </div>
        <div class="timeline">${acts.map(eventHTML).join('') || `<div class="help" style="padding:0">ยังไม่มีประวัติ</div>`}</div>
      </div>
      <button class="btn danger block" data-act="delete-task" style="margin-top:20px">${I.trash} ลบงานนี้</button>
      <div class="foot-meta">สร้างโดย ${esc(db.memberById(t.created_by)?.display_name || '—')} · ${new Date(t.created_at).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
        ${t.completed_at ? `<br>เสร็จเมื่อ ${new Date(t.completed_at).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</div>`;
  } else {
    html += `<button class="btn primary block" data-act="create-task" style="margin-top:20px">เพิ่มงาน</button>`;
  }
  return html + `</div>`;
}

function eventHTML(a) {
  const m = db.memberById(a.user_id);
  const name = `<b>${esc(m?.display_name || 'ใครบางคน')}</b>`;
  let txt;
  if (a.kind === 'created') txt = a.body === 'repeat' ? `${name} สร้างงานรอบใหม่ (งานซ้ำ)` : `${name} สร้างงานนี้`;
  else if (a.kind === 'status') txt = `${name} เปลี่ยนสถานะเป็น “${STATUS[a.body] || a.body}”`;
  else if (a.kind === 'assigned') txt = a.body ? `${name} มอบหมายให้ ${esc(db.memberById(a.body)?.display_name || '—')}` : `${name} เปลี่ยนเป็นงานร่วมกัน`;
  else if (a.kind === 'comment') txt = `${name}<div class="bubble">${esc(a.body)}</div>`;
  else txt = `${name} แก้ไขงาน`;
  const del = a.kind === 'comment' && a.user_id === store.user?.id ? `<button class="del" data-act="act-del" data-id="${a.id}">ลบ</button>` : '';
  return `<div class="ev">${avatar(m, 'sm')}<div class="txt">${txt}<div class="when">${ago(a.created_at)}${del}</div></div></div>`;
}

function settingsSheet() {
  const M = db.me(), P = db.partner();
  const push = pushState();
  const pushHTML = {
    unsupported: `<div class="help">เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน</div>`,
    'need-install': `<div class="help"><b>ต้องติดตั้งแอปก่อน:</b> ใน Safari กดปุ่มแชร์ → “เพิ่มไปยังหน้าจอโฮม” แล้วเปิด Taskify จากไอคอนบนหน้าโฮม จากนั้นกลับมาเปิดการแจ้งเตือนที่นี่ (ต้องใช้ iOS 16.4 ขึ้นไป)</div>`,
    denied: `<div class="help">การแจ้งเตือนถูกปิดอยู่ ไปที่ <b>การตั้งค่า iPhone → การแจ้งเตือน → Taskify</b> แล้วเปิด “อนุญาตการแจ้งเตือน”</div>`,
    off: `<div class="row"><span class="lbl">${I.bell} สถานะ</span><div class="ctl"><button class="btn primary" data-act="push-enable">เปิดการแจ้งเตือน</button></div></div>
          <div class="help">แจ้งเตือนเมื่อใกล้ถึงกำหนดส่ง เมื่อมีคนมอบหมายงานให้ และเมื่อมีความคิดเห็นใหม่</div>`,
    on: `<div class="row"><span class="lbl">${I.bell} สถานะ</span><div class="ctl"><span style="color:var(--done);font-weight:600">เปิดอยู่</span>
          <button class="btn ghost" data-act="push-test">ทดสอบ</button></div></div>`,
    local: `<div class="help">ใช้ได้หลังเชื่อมฐานข้อมูลออนไลน์</div>`,
  }[push];

  return `
    <div class="sheet-grab" data-grab></div>
    <div class="sheet-head" data-grab><span style="width:52px"></span><div class="ttl">ตั้งค่า</div><button class="text-btn" data-act="close-sheet">เสร็จ</button></div>
    <div class="sheet-body" id="sheetBody">
      <div class="sec-title">โปรไฟล์ของฉัน</div>
      <div class="group">
        <div class="row"><span class="lbl">ชื่อที่แสดง</span><div class="ctl"><input class="inp" id="sName" value="${esc(M?.display_name || '')}" maxlength="40"></div></div>
        <div class="row"><span class="lbl">สีประจำตัว</span><div class="ctl"><div class="color-row">${COLORS.map(c => `<button class="swatch ${M?.color === c ? 'on' : ''}" style="--c:${c}" data-act="my-color" data-v="${c}" aria-label="สี"></button>`).join('')}</div></div></div>
        <div class="row"><span class="lbl">อีเมล</span><div class="ctl" style="color:var(--muted);font-size:14px">${esc(store.user?.email || '')}</div></div>
      </div>
      ${P ? `<div class="group"><div class="row"><span class="lbl">ใช้ร่วมกับ</span><div class="ctl">${avatar(P, 'sm')} <span>${esc(P.display_name)}</span>
        ${P.user_id ? '' : `<span style="color:var(--mid);font-size:13px">· ยังไม่ได้สมัคร</span>`}</div></div></div>` : ''}

      <div class="sec-title" id="sPush">การแจ้งเตือน</div>
      <div class="group">${pushHTML}</div>

      <div class="sec-title">หน้าตา</div>
      <div class="group">
        <div class="row"><span class="lbl">ธีม</span><div class="ctl"><div class="seg">
          ${[['auto', 'อัตโนมัติ'], ['light', 'สว่าง'], ['dark', 'มืด']].map(([v, l]) => `<button class="${ui.theme === v ? 'on' : ''}" data-act="theme" data-v="${v}">${l}</button>`).join('')}</div></div></div>
        <div class="row"><span class="lbl">สีหลัก</span><div class="ctl"><div class="color-row">${ACCENTS.map(c => `<button class="swatch ${ui.accent === c ? 'on' : ''}" style="--c:${c}" data-act="accent" data-v="${c}" aria-label="สี"></button>`).join('')}</div></div></div>
      </div>

      <div class="sec-title" id="sCats">หมวดหมู่</div>
      <div class="group">
        ${categories().map(c => `<div class="cat-row">
          <button class="swatch" style="--c:${esc(c.color)}" data-act="cat-color-open" data-id="${c.id}" aria-label="เปลี่ยนสี"></button>
          <input id="cat-${c.id}" data-cat-name="${c.id}" value="${esc(c.name)}" maxlength="40">
          <button class="x-btn" data-act="cat-del" data-id="${c.id}" aria-label="ลบหมวดหมู่">${I.trash}</button></div>
          ${sheet.catColor === c.id ? `<div class="color-pop">${COLORS.map(x => `<button class="swatch ${c.color === x ? 'on' : ''}" style="--c:${x}" data-act="cat-color" data-id="${c.id}" data-v="${x}"></button>`).join('')}</div>` : ''}`).join('')}
        <div class="add-row">${I.plus}<input id="sCatAdd" placeholder="เพิ่มหมวดหมู่ เช่น บ้าน, งาน, เที่ยว" enterkeyhint="done" maxlength="40"></div>
      </div>

      <div class="sec-title">ข้อมูล</div>
      <div class="group">
        <div class="row link" data-act="export"><span class="lbl" style="width:auto;color:var(--text)">ส่งออกข้อมูลสำรอง (.json)</span><div class="ctl">${I.right}</div></div>
        <label class="row link" style="cursor:pointer"><span class="lbl" style="width:auto;color:var(--text)">นำเข้าข้อมูลสำรอง</span><div class="ctl">${I.right}</div><input type="file" id="sImport" accept="application/json,.json" style="display:none"></label>
        ${legacyTasks().length && !LS.get('taskify.v1.imported', false) ? `<div class="row link" data-act="import-legacy"><span class="lbl" style="width:auto;color:var(--text)">นำเข้างานจากเวอร์ชันเก่า (${legacyTasks().length})</span><div class="ctl">${I.right}</div></div>` : ''}
      </div>

      ${db.configured ? `<button class="btn danger block" data-act="signout" style="margin-top:20px">ออกจากระบบ</button>` : ''}
      <div class="foot-meta">Taskify v${APP_VERSION}${db.configured ? '' : ' · โหมดทดลอง'}</div>
    </div>`;
}

/* =========================================================
   task actions
   ========================================================= */
function commit(patch) {
  if (sheet.isNew) { Object.assign(sheet.draft, patch); renderSheet(); return; }
  const t = store.tasks.get(sheet.id);
  if (!t) return;
  const prevAssignee = t.assignee;
  const prevStatus = t.status;
  db.updateTask(t.id, patch);
  afterChange(t, patch, prevAssignee, prevStatus);
}

function afterChange(t, patch, prevAssignee, prevStatus) {
  const P = db.partner();
  if ('assignee' in patch && patch.assignee && patch.assignee !== prevAssignee && patch.assignee === P?.user_id) {
    db.notify(P.user_id, 'มอบหมายงานให้คุณ 📌', t.title, t.id);
  }
  if (patch.status === 'done' && prevStatus !== 'done') {
    haptic();
    if (P?.user_id && (t.assignee === P.user_id || (t.created_by === P.user_id && t.assignee !== store.user.id))) {
      db.notify(P.user_id, 'งานเสร็จแล้ว ✅', t.title, t.id);
    }
    if (t.repeat && t.repeat !== 'none') toast(`สร้างรอบถัดไปแล้ว (${REPEAT[t.repeat]})`);
  }
}

function toggleDone(id) {
  const t = store.tasks.get(id);
  if (!t) return;
  const status = t.status === 'done' ? 'todo' : 'done';
  const prev = t.status;
  db.updateTask(id, { status });
  afterChange(t, { status }, t.assignee, prev);
  if (status === 'done' && t.repeat === 'none') {
    toast('เสร็จแล้ว ✓', { action: 'เลิกทำ', onAction: () => db.updateTask(id, { status: prev }) });
  }
}

function deleteWithUndo(id) {
  const t = store.tasks.get(id);
  if (!t) return;
  ui.hidden.add(id);
  if (sheet.open && sheet.id === id) closeSheet();
  haptic();
  render();
  const timer = setTimeout(() => commitDelete(id), 5000);
  pendingDeletes.set(id, timer);
  toast(`ลบ “${t.title.slice(0, 30)}” แล้ว`, {
    action: 'เลิกทำ',
    onAction: () => { clearTimeout(timer); pendingDeletes.delete(id); ui.hidden.delete(id); render(); },
  });
}
function commitDelete(id) {
  pendingDeletes.delete(id);
  ui.hidden.delete(id);
  db.deleteTask(id);
}
function flushDeletes() { for (const [id, timer] of pendingDeletes) { clearTimeout(timer); commitDelete(id); } }
window.addEventListener('pagehide', flushDeletes);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDeletes(); });

function createFromDraft() {
  const d = sheet.draft;
  const title = ($('#dTitle')?.value || d.title).trim();
  if (!title) { $('#dTitle')?.focus(); toast('ใส่ชื่องานก่อนนะ'); return; }
  const note = $('#dNote')?.value ?? d.note;
  const pendingSub = $('#dSubAdd')?.value.trim();
  if (pendingSub) d.subtasks = [...d.subtasks, { id: crypto.randomUUID(), text: pendingSub, done: false }];
  const row = db.createTask({ ...d, title, note });
  const P = db.partner();
  if (row.assignee && row.assignee === P?.user_id) db.notify(P.user_id, 'งานใหม่สำหรับคุณ 📌', row.title, row.id);
  haptic();
  closeSheet();
  toast('เพิ่มงานแล้ว');
}

function parseQuick(text) {
  let title = text.trim(), due_date = null, priority = 'mid';
  if (/^!|!$/.test(title)) { priority = 'high'; title = title.replace(/^!+|!+$/g, '').trim(); }
  const m = title.match(/\s+(วันนี้|พรุ่งนี้|มะรืน(?:นี้)?)$/);
  if (m) {
    due_date = m[1] === 'วันนี้' ? today() : m[1] === 'พรุ่งนี้' ? addDays(today(), 1) : addDays(today(), 2);
    title = title.slice(0, m.index).trim();
  }
  return { title, due_date, priority };
}

/* =========================================================
   attachments
   ========================================================= */
async function loadPhotos() {
  for (const img of document.querySelectorAll('#sheet img[data-src]')) {
    const path = img.dataset.src;
    const show = url => { if (!url) return; img.src = url; img.closest('.photo')?.classList.remove('loading'); };
    if (photoSrc.has(path)) { show(photoSrc.get(path)); continue; }
    db.photoUrl(path).then(url => { if (url) { photoSrc.set(path, url); show(url); } });
  }
}
async function addPhotos(files) {
  const t = currentTask();
  if (!t || !files.length) return;
  if (db.configured && !navigator.onLine) { toast('ต้องต่ออินเทอร์เน็ตเพื่ออัปโหลดรูป', { err: true }); return; }
  toast(`กำลังอัปโหลด ${files.length} รูป…`);
  const added = [];
  for (const f of files) {
    try { added.push({ type: 'photo', path: await db.uploadPhoto(f), name: f.name }); }
    catch (e) { toast('อัปโหลดไม่สำเร็จ: ' + e.message, { err: true }); }
  }
  const cur = currentTask();
  if (added.length && cur) commit({ attachments: [...(cur.attachments || []), ...added] });
}
function addLink() {
  const input = $('#dLink');
  let url = input?.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { toast('ลิงก์ไม่ถูกต้อง', { err: true }); return; }
  const t = currentTask();
  let title = url;
  try { const u = new URL(url); title = u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname : ''); } catch {}
  delete sheet.drafts.dLink;
  sheet.addingLink = false;
  commit({ attachments: [...(t.attachments || []), { type: 'link', url, title }] });
}
function viewPhoto(path) {
  const url = photoSrc.get(path);
  if (!url) return;
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `<img src="${esc(url)}" alt=""><button aria-label="ปิด">${I.x}</button>`;
  lb.onclick = () => lb.remove();
  document.body.appendChild(lb);
}

/* =========================================================
   push notifications
   ========================================================= */
function pushState() {
  if (!db.configured) return 'local';
  if (isIOS && !isStandalone()) return 'need-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return ui.pushOn ? 'on' : 'off';
}
const b64ToBytes = s => { const p = '='.repeat((4 - s.length % 4) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); };
async function checkPush() {
  if (!db.configured || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    ui.pushOn = !!sub && Notification.permission === 'granted';
    if (sub && ui.pushOn) db.savePushSubscription(sub).catch(() => {});
  } catch {}
}
async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('ไม่ได้รับอนุญาตให้แจ้งเตือน', { err: true }); renderSheet(); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY) });
    await db.savePushSubscription(sub);
    ui.pushOn = true;
    toast('เปิดการแจ้งเตือนแล้ว 🔔');
  } catch (e) {
    toast('เปิดการแจ้งเตือนไม่สำเร็จ: ' + e.message, { err: true });
  }
  renderSheet();
}

/* =========================================================
   import / export
   ========================================================= */
const legacyTasks = () => { const v = LS.get('taskify.v1', []); return Array.isArray(v) ? v : []; };
async function doExport() {
  const json = JSON.stringify(db.exportData(), null, 2);
  const name = `taskify-backup-${today()}.json`;
  const file = new File([json], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Taskify backup' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function doImport(file) {
  try {
    const obj = JSON.parse(await file.text());
    if (obj?.app !== 'taskify') throw new Error('ไม่ใช่ไฟล์สำรองของ Taskify');
    const n = db.importData(obj);
    toast(`นำเข้าแล้ว ${n} งาน`);
  } catch (e) { toast('นำเข้าไม่สำเร็จ: ' + e.message, { err: true }); }
}
function importLegacy() {
  const n = db.importLegacy(legacyTasks());
  LS.set('taskify.v1.imported', true);
  toast(`นำเข้างานเดิม ${n} งานแล้ว`);
  if (sheet.open) renderSheet();
}

/* =========================================================
   events
   ========================================================= */
let suppressClick = false;

function bindEvents() {
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('touchmove', e => { if (drag) e.preventDefault(); }, { passive: false });
}

function onClick(e) {
  if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); return; }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, v = el.dataset.v, id = el.dataset.id;
  if (el.tagName === 'A' || act === 'settings-push') e.preventDefault();

  switch (act) {
    case 'view': ui.view = v; LS.set('taskify.view', v); window.scrollTo(0, 0); render(); break;
    case 'new': openNew(); break;
    case 'col-add': openNew({ status: v }); break;
    case 'open': openTask(id); break;
    case 'toggle-done': toggleDone(id); break;
    case 'person': ui.person = v; render(); break;
    case 'cat': ui.category = v; render(); break;
    case 'manage-cats': openSettings('sCats'); break;
    case 'search-toggle':
      ui.searchOpen = !ui.searchOpen;
      if (!ui.searchOpen) { ui.search = ''; $('#search').value = ''; }
      render();
      if (ui.searchOpen) setTimeout(() => $('#search').focus(), 50);
      break;
    case 'settings': openSettings(); break;
    case 'settings-push': openSettings('sPush'); break;
    case 'list-mode': ui.listMode = v; LS.set('taskify.listMode', v); render(); break;
    case 'toggle-done-group': ui.doneOpen = !ui.doneOpen; render(); break;
    case 'show-all-done': ui.showAllDone = true; render(); break;
    case 'cal-prev': case 'cal-next': {
      const [y, m] = ui.calMonth.split('-').map(Number);
      const d = new Date(y, m - 1 + (act === 'cal-next' ? 1 : -1), 1);
      ui.calMonth = ymd(d).slice(0, 7); render(); break;
    }
    case 'cal-today': ui.calMonth = today().slice(0, 7); ui.calDay = today(); render(); break;
    case 'cal-day': ui.calDay = el.dataset.d; if (el.dataset.d.slice(0, 7) !== ui.calMonth) ui.calMonth = el.dataset.d.slice(0, 7); render(); break;

    // sheet
    case 'close-sheet': closeSheet(); break;
    case 'create-task': createFromDraft(); break;
    case 'seg': {
      const f = el.dataset.f;
      let val = v;
      if (f === 'assignee' || f === 'category_id') val = v || null;
      if (f === 'pinned') val = !!v;
      commit({ [f]: val });
      break;
    }
    case 'quick-due': commit({ due_date: addDays(today(), Number(v)) }); break;
    case 'clear-due': commit({ due_date: null, due_time: null, remind_before: null }); break;
    case 'quick-cat': {
      const name = prompt('ชื่อหมวดหมู่ใหม่');
      if (name?.trim()) {
        const c = db.createCategory(name, COLORS[store.categories.size % COLORS.length]);
        commit({ category_id: c.id });
      }
      break;
    }
    case 'sub-toggle': {
      const t = currentTask();
      commit({ subtasks: t.subtasks.map(s => s.id === el.dataset.sid ? { ...s, done: !s.done } : s) });
      haptic();
      break;
    }
    case 'sub-del': {
      const t = currentTask();
      delete sheet.drafts['sub-' + el.dataset.sid];
      commit({ subtasks: t.subtasks.filter(s => s.id !== el.dataset.sid) });
      break;
    }
    case 'att-link-show': sheet.addingLink = true; renderSheet(); setTimeout(() => $('#dLink')?.focus(), 30); break;
    case 'att-link-add': addLink(); break;
    case 'att-del': {
      e.preventDefault(); e.stopPropagation();
      const t = currentTask();
      const i = Number(el.dataset.i);
      const a = t.attachments[i];
      if (a?.type === 'photo') { if (!confirm('ลบรูปนี้?')) return; db.removePhoto(a.path); }
      commit({ attachments: t.attachments.filter((_, j) => j !== i) });
      break;
    }
    case 'photo-view': viewPhoto(el.dataset.path); break;
    case 'timer-start': db.startTimer(sheet.id); haptic(); break;
    case 'timer-stop': db.stopTimer(sheet.id); haptic(); break;
    case 'timer-reset': if (confirm('ล้างเวลาที่จับไว้ทั้งหมด?')) db.updateTask(sheet.id, { time_spent: 0 }); break;
    case 'comment-send': sendComment(); break;
    case 'act-del': if (confirm('ลบความคิดเห็นนี้?')) db.deleteActivity(id); break;
    case 'delete-task': deleteWithUndo(sheet.id); break;

    // settings
    case 'theme': ui.theme = v; LS.set('taskify.theme', v); applyTheme(); renderSheet(); break;
    case 'accent': ui.accent = v; LS.set('taskify.accent', v); applyTheme(); renderSheet(); break;
    case 'my-color': db.updateProfile(db.me()?.display_name || '', v); break;
    case 'cat-color-open': sheet.catColor = sheet.catColor === id ? null : id; renderSheet(); break;
    case 'cat-color': db.updateCategory(id, { color: v }); sheet.catColor = null; break;
    case 'cat-del': {
      const c = store.categories.get(id);
      const n = allTasks().filter(t => t.category_id === id).length;
      if (confirm(`ลบหมวด “${c?.name}”?${n ? ` (${n} งานจะกลายเป็นไม่มีหมวด)` : ''}`)) {
        db.deleteCategory(id);
        if (ui.category === id) ui.category = '';
      }
      break;
    }
    case 'export': doExport(); break;
    case 'import-legacy': importLegacy(); break;
    case 'push-enable': enablePush(); break;
    case 'push-test':
      db.notify(store.user.id, 'ทดสอบการแจ้งเตือน 🔔', 'ถ้าเห็นข้อความนี้ แปลว่าใช้งานได้แล้ว', null, true)
        .then(r => toast(r?.error ? 'ส่งไม่สำเร็จ' : 'ส่งแล้ว ลองดูที่หน้าจอล็อก'));
      break;
    case 'signout':
      if (confirm('ออกจากระบบ?')) db.signOut().then(() => location.reload());
      break;
  }
}

function sendComment() {
  const box = $('#dComment');
  const text = box?.value.trim();
  if (!text) return;
  const t = currentTask();
  db.addActivity(t.id, 'comment', text);
  box.value = '';
  delete sheet.drafts.dComment;
  const P = db.partner();
  if (P?.user_id) db.notify(P.user_id, `💬 ${t.title.slice(0, 40)}`, text, t.id);
  haptic();
}

function onChange(e) {
  const el = e.target;
  if (el.id === 'sImport' && el.files[0]) { doImport(el.files[0]); el.value = ''; return; }
  if (el.id === 'dPhoto') { addPhotos([...el.files]); el.value = ''; return; }
  if (el.id === 'sName') { const name = el.value.trim(); if (name) db.updateProfile(name, db.me()?.color || COLORS[0]); delete sheet.drafts.sName; return; }
  if (el.dataset.catName) { const name = el.value.trim(); delete sheet.drafts[el.id]; if (name) db.updateCategory(el.dataset.catName, { name }); return; }
  if (el.dataset.sub) {
    const t = currentTask();
    const text = el.value.trim();
    delete sheet.drafts[el.id];
    commit({ subtasks: text ? t.subtasks.map(s => s.id === el.dataset.sub ? { ...s, text } : s) : t.subtasks.filter(s => s.id !== el.dataset.sub) });
    return;
  }
  const f = el.dataset.f;
  if (!f || !$('#sheet').contains(el)) return;
  const t = currentTask();
  if (!t) return;
  let val = el.value;
  delete sheet.drafts[el.id];
  if (f === 'title') { val = val.trim(); if (!val) { if (!sheet.isNew) { el.value = t.title; return; } } }
  if (f === 'note') val = val.replace(/\s+$/, '');
  if (f === 'due_date') {
    if (!val) { commit({ due_date: null, due_time: null, remind_before: null }); return; }
  }
  if (f === 'category_id') {
    if (val === '__new') {
      const name = prompt('ชื่อหมวดหมู่ใหม่');
      if (name?.trim()) commit({ category_id: db.createCategory(name, COLORS[store.categories.size % COLORS.length]).id });
      else el.value = t.category_id || '';
      return;
    }
    val = val || null;
  }
  if (f === 'due_time') val = val || null;
  if (f === 'remind_before') val = val === '' ? null : Number(val);
  if (t[f] === val) return;
  commit({ [f]: val });
}

function onInput(e) {
  const el = e.target;
  if (el.id === 'search') { ui.search = el.value; renderView(); return; }
  if (el.id === 'dTitle') autosize(el);
  if (el.id === 'dComment') { el.style.height = 'auto'; el.style.height = Math.min(140, el.scrollHeight) + 'px'; }
  if ($('#sheet')?.contains(el) && el.id && 'value' in el && el.type !== 'file' && el.tagName !== 'SELECT') sheet.drafts[el.id] = el.value;
}
function autosize(el) { if (!el) return; el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }

function onKey(e) {
  const el = e.target;
  if (e.key === 'Escape' && sheet.open) { closeSheet(); return; }
  if (e.key !== 'Enter' || e.isComposing) return;
  if (el.id === 'quick') {
    const { title, due_date, priority } = parseQuick(el.value);
    if (!title) return;
    const row = db.createTask({ ...ctxDefaults(), title, priority, ...(due_date ? { due_date } : {}) });
    const P = db.partner();
    if (row.assignee && row.assignee === P?.user_id) db.notify(P.user_id, 'งานใหม่สำหรับคุณ 📌', row.title, row.id);
    el.value = '';
    haptic();
    toast(`เพิ่ม “${title.slice(0, 30)}”${due_date ? ' · ' + fmtDay(due_date) : ''}`);
  } else if (el.id === 'dTitle') {
    e.preventDefault(); el.blur();
  } else if (el.id === 'dSubAdd') {
    e.preventDefault();
    const text = el.value.trim();
    if (!text) return;
    const t = currentTask();
    el.value = ''; delete sheet.drafts.dSubAdd;
    commit({ subtasks: [...(t.subtasks || []), { id: crypto.randomUUID(), text, done: false }] });
    setTimeout(() => $('#dSubAdd')?.focus(), 0);
  } else if (el.id === 'dLink') {
    e.preventDefault(); addLink();
  } else if (el.id === 'sCatAdd') {
    e.preventDefault();
    const name = el.value.trim();
    if (!name) return;
    el.value = ''; delete sheet.drafts.sCatAdd;
    db.createCategory(name, COLORS[store.categories.size % COLORS.length]);
    setTimeout(() => $('#sCatAdd')?.focus(), 0);
  } else if (el.id === 'sName' || el.dataset.catName || el.dataset.sub) {
    e.preventDefault(); el.blur();
  }
}

/* =========================================================
   gestures: swipe, long-press drag, reorder, sheet pull-down
   ========================================================= */
let swipe = null, drag = null, press = null, pull = null;

function onPointerDown(e) {
  if (e.button !== 0) return;
  const handle = e.target.closest('[data-drag="reorder"]');
  if (handle) { e.preventDefault(); startDrag(handle.closest('.task'), e, 'reorder'); return; }

  const grab = e.target.closest('[data-grab]');
  if (grab && !e.target.closest('button')) { pull = { y: e.clientY, dy: 0, id: e.pointerId }; return; }

  const task = e.target.closest('.task');
  if (!task || e.target.closest('.check')) return;
  if (task.hasAttribute('data-board')) {
    press = { task, x: e.clientX, y: e.clientY, id: e.pointerId, timer: setTimeout(() => { if (press) { const p = press; press = null; startDrag(p.task, e, 'board', p); } }, 380) };
    // also allow swipe on board cards? no: board uses long-press drag only
    return;
  }
  if (task.hasAttribute('data-swipe')) swipe = { task, wrap: task.parentElement, x: e.clientX, y: e.clientY, dx: 0, active: false, id: e.pointerId };
}

window.addEventListener('pointermove', e => {
  if (press && e.pointerId === press.id) {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) { clearTimeout(press.timer); press = null; }
    else { press.lastX = e.clientX; press.lastY = e.clientY; }
  }
  if (pull && e.pointerId === pull.id) {
    pull.dy = Math.max(0, e.clientY - pull.y);
    const sh = $('#sheet');
    sh.style.transition = 'none';
    sh.style.transform = `translateY(${pull.dy}px)`;
  }
  if (swipe && e.pointerId === swipe.id) {
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    if (!swipe.active) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; }
      if (Math.abs(dx) < 12) return;
      swipe.active = true; busy = true;
      swipe.task.classList.add('swiping');
      try { swipe.task.setPointerCapture(e.pointerId); } catch {}
    }
    swipe.dx = dx;
    const damp = Math.sign(dx) * Math.min(Math.abs(dx), 140 + (Math.abs(dx) - 140) * 0.25);
    swipe.task.style.transform = `translateX(${Math.abs(dx) > 140 ? damp : dx}px)`;
    swipe.wrap.dataset.dir = dx > 0 ? 'right' : 'left';
    const armed = Math.abs(dx) > 90;
    if (armed !== swipe.wrap.classList.contains('armed')) { swipe.wrap.classList.toggle('armed', armed); if (armed) haptic(); }
  }
}, { passive: true });

function endPointer(e) {
  if (press && e.pointerId === press.id) { clearTimeout(press.timer); press = null; }
  if (pull && e.pointerId === pull.id) {
    const sh = $('#sheet');
    sh.style.transition = '';
    if (pull.dy > 110) closeSheet(); else sh.style.transform = '';
    pull = null;
  }
  if (swipe && e.pointerId === swipe.id) {
    const s = swipe; swipe = null;
    if (!s.active) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 50);
    s.task.classList.remove('swiping');
    const id = s.task.dataset.id;
    if (s.dx > 90) {
      s.task.style.transform = 'translateX(110%)';
      setTimeout(() => { busy = false; toggleDone(id); render(); }, 180);
    } else if (s.dx < -90) {
      s.task.style.transform = 'translateX(-110%)';
      setTimeout(() => { busy = false; deleteWithUndo(id); }, 180);
    } else {
      s.task.style.transform = '';
      setTimeout(() => { delete s.wrap.dataset.dir; s.wrap.classList.remove('armed'); busy = false; if (renderQueued) { renderQueued = false; render(); } }, 200);
    }
  }
}
window.addEventListener('pointerup', endPointer);
window.addEventListener('pointercancel', e => {
  if (swipe && e.pointerId === swipe.id && swipe.active) { swipe.dx = 0; }
  endPointer(e);
});

function startDrag(task, e, mode, p) {
  if (!task) return;
  const rect = task.getBoundingClientRect();
  const x0 = p?.lastX ?? p?.x ?? e.clientX, y0 = p?.lastY ?? p?.y ?? e.clientY;
  const ghost = task.cloneNode(true);
  ghost.classList.add('drag-ghost');
  Object.assign(ghost.style, { width: rect.width + 'px', left: rect.left + 'px', top: rect.top + 'px' });
  document.body.appendChild(ghost);
  task.classList.add('drag-src');
  busy = true;
  haptic();
  drag = { task, ghost, mode, id: task.dataset.id, offX: x0 - rect.left, offY: y0 - rect.top, rect, target: null, before: null };
  suppressClick = true;

  const move = ev => {
    const gx = ev.clientX - drag.offX, gy = ev.clientY - drag.offY;
    ghost.style.transform = `translate(${gx - rect.left}px, ${gy - rect.top}px) rotate(${mode === 'board' ? 2 : 0}deg)`;
    // autoscroll
    const edge = 70;
    if (ev.clientY < edge + 100) window.scrollBy(0, -10); else if (ev.clientY > innerHeight - edge - 60) window.scrollBy(0, 10);
    if (mode === 'board') {
      const board = $('.board');
      if (board) { if (ev.clientX < 30) board.scrollLeft -= 12; else if (ev.clientX > innerWidth - 30) board.scrollLeft += 12; }
      const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.col');
      document.querySelectorAll('.col.over').forEach(c => c !== under && c.classList.remove('over'));
      if (under) under.classList.add('over');
      drag.target = under?.dataset.col || null;
    } else {
      const list = task.closest('[data-reorder]');
      const cards = [...list.querySelectorAll(':scope > .swipe')].filter(w => w.dataset.id !== drag.id);
      let before = null;
      for (const w of cards) { const r = w.getBoundingClientRect(); if (ev.clientY < r.top + r.height / 2) { before = w; break; } }
      document.querySelectorAll('.drop-line').forEach(l => l.remove());
      const line = document.createElement('div'); line.className = 'drop-line';
      if (before) list.insertBefore(line, before); else list.appendChild(line);
      drag.before = before ? before.dataset.id : 'end';
      drag.order = cards.map(w => w.dataset.id);
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    ghost.remove();
    task.classList.remove('drag-src');
    document.querySelectorAll('.col.over').forEach(c => c.classList.remove('over'));
    document.querySelectorAll('.drop-line').forEach(l => l.remove());
    const d = drag; drag = null; busy = false;
    setTimeout(() => { suppressClick = false; }, 60);
    if (d.mode === 'board' && d.target) {
      const t = store.tasks.get(d.id);
      if (t && t.status !== d.target) {
        const prev = t.status;
        db.updateTask(d.id, { status: d.target });
        afterChange(t, { status: d.target }, t.assignee, prev);
        haptic();
      }
    } else if (d.mode === 'reorder' && d.before && d.order) {
      const sortOf = id => store.tasks.get(id)?.sort ?? 0;
      const idx = d.before === 'end' ? d.order.length : d.order.indexOf(d.before);
      const prevId = d.order[idx - 1], nextId = d.order[idx];
      let sort;
      if (prevId == null && nextId == null) sort = 0;
      else if (prevId == null) sort = sortOf(nextId) - 1;
      else if (nextId == null) sort = sortOf(prevId) + 1;
      else sort = (sortOf(prevId) + sortOf(nextId)) / 2;
      const t = store.tasks.get(d.id);
      if (t && sort !== t.sort) db.updateTask(d.id, { sort });
    }
    render();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  move(e);
}

/* =========================================================
   live timers
   ========================================================= */
setInterval(() => {
  for (const el of document.querySelectorAll('[data-timer]')) {
    const t = store.tasks.get(el.dataset.timer);
    if (t?.timer_started_at) el.textContent = fmtDur(totalTime(t));
  }
}, 1000);

/* =========================================================
   login
   ========================================================= */
function renderLogin(mode = 'signin', msg = '') {
  document.body.innerHTML = `
    <div class="login">
      <img class="logo" src="icon-192.png" alt="">
      <h1>Taskify</h1>
      <p class="sub">รายการงานของเราสองคน</p>
      <form id="loginForm" novalidate>
        <input class="inp" id="lEmail" type="email" inputmode="email" autocomplete="email" placeholder="อีเมล" required>
        <div class="pw"><input class="inp" id="lPw" type="password" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" placeholder="${mode === 'signup' ? 'ตั้งรหัสผ่าน (อย่างน้อย 8 ตัว)' : 'รหัสผ่าน'}" required minlength="8" style="width:100%;padding-right:64px">
          <button type="button" id="lShow">แสดง</button></div>
        <div class="err" id="lErr">${esc(msg)}</div>
        <button class="btn primary block" id="lBtn" type="submit">${mode === 'signup' ? 'สร้างบัญชี' : 'เข้าสู่ระบบ'}</button>
      </form>
      <div class="switch">${mode === 'signup'
        ? `มีบัญชีแล้ว? <button data-mode="signin">เข้าสู่ระบบ</button>`
        : `ใช้ครั้งแรก? <button data-mode="signup">สร้างบัญชี</button>`}</div>
      <div class="hint">เฉพาะอีเมลที่อยู่ในรายชื่อเท่านั้นที่สร้างบัญชีได้<br>ลืมรหัสผ่าน: ให้เจ้าของระบบรีเซ็ตใน Supabase</div>
    </div>`;
  $('#lShow').onclick = () => { const p = $('#lPw'); p.type = p.type === 'password' ? 'text' : 'password'; $('#lShow').textContent = p.type === 'password' ? 'แสดง' : 'ซ่อน'; };
  document.querySelector('[data-mode]').onclick = ev => renderLogin(ev.target.dataset.mode);
  $('#loginForm').onsubmit = async ev => {
    ev.preventDefault();
    const email = $('#lEmail').value.trim(), pw = $('#lPw').value;
    if (!email || !pw) { $('#lErr').textContent = 'กรอกอีเมลและรหัสผ่าน'; return; }
    if (mode === 'signup' && pw.length < 8) { $('#lErr').textContent = 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร'; return; }
    $('#lBtn').disabled = true; $('#lErr').textContent = '';
    try {
      if (mode === 'signup') await db.signUp(email, pw); else await db.signIn(email, pw);
      await startApp();
    } catch (e) {
      const m = e.message || '';
      $('#lErr').textContent =
        /invalid login/i.test(m) ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' :
        /database error|not allowed/i.test(m) ? 'อีเมลนี้ไม่ได้อยู่ในรายชื่อผู้ใช้' :
        /already registered|already been registered/i.test(m) ? 'อีเมลนี้สมัครแล้ว ให้กด “เข้าสู่ระบบ”' :
        /password/i.test(m) ? 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' :
        m === 'confirm-required' ? 'ต้องยืนยันอีเมลก่อน (ให้เจ้าของระบบปิด “Confirm email” ใน Supabase)' :
        /fetch|network/i.test(m) ? 'เชื่อมต่ออินเทอร์เน็ตไม่ได้' : m;
      $('#lBtn').disabled = false;
    }
  };
}

/* =========================================================
   boot
   ========================================================= */
let started = false;
async function startApp() {
  if (started) return;
  started = true;
  renderShell();
  bindEvents();
  db.subscribe(render);
  db.onError(msg => toast(msg, { err: true }));
  db.onRemote((table, p) => {
    if (table === 'tasks' && p.eventType === 'INSERT' && p.new.created_by !== store.user.id) {
      const who = db.memberById(p.new.created_by)?.display_name || 'แฟน';
      toast(`${who} เพิ่มงาน: ${p.new.title.slice(0, 40)}`);
    }
  });
  render();
  await db.start();
  render();
  checkPush().then(() => { if (sheet.open) renderSheet(); });
  const legacy = legacyTasks();
  if (legacy.length && !LS.get('taskify.v1.imported', false)) {
    toast(`พบงานจากเวอร์ชันเก่า ${legacy.length} งาน`, { action: 'นำเข้า', onAction: importLegacy, ms: 9000 });
  }
  const q = new URLSearchParams(location.search).get('task');
  if (q) { history.replaceState(null, '', location.pathname); setTimeout(() => openTask(q), 300); }
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'open-task' && e.data.id) openTask(e.data.id);
  });
}

applyTheme();
db.getSession().then(user => (user ? startApp() : renderLogin()));
