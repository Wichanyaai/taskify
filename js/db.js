// Data layer: local state + offline outbox + Supabase sync/realtime.
// With no Supabase config it runs in local demo mode (data stays on this device).
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const configured = !SUPABASE_URL.startsWith('YOUR_');
export const sb = configured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'taskify.auth' },
    })
  : null;

export const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

export const store = {
  user: null,
  members: [],
  tasks: new Map(),
  categories: new Map(),
  activity: [],          // ascending by created_at
  sync: configured ? 'syncing' : 'local',
  loaded: false,
};

const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

export const me = () => store.members.find(m => m.user_id && m.user_id === store.user?.id);
export const partner = () => store.members.find(m => !(m.user_id && m.user_id === store.user?.id) && m.email !== store.user?.email?.toLowerCase());
export const memberById = id => store.members.find(m => m.user_id === id);

/* ---------- change notifications ---------- */
const listeners = new Set();
export const subscribe = fn => listeners.add(fn);
let emitQueued = false;
function emit() {
  if (emitQueued) return;
  emitQueued = true;
  queueMicrotask(() => { emitQueued = false; saveCache(); listeners.forEach(f => f()); });
}
let errorHandler = () => {};
export const onError = fn => { errorHandler = fn; };
let remoteHandler = () => {};
export const onRemote = fn => { remoteHandler = fn; };
function setSync(s) { if (!configured) s = 'local'; if (store.sync !== s) { store.sync = s; emit(); } }

/* ---------- cache ---------- */
const CACHE_KEY = 'taskify.cache.v2';
const OUTBOX_KEY = 'taskify.outbox.v2';
let cacheTimer;
function saveCache() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    if (!store.user) return;
    LS.set(CACHE_KEY, {
      uid: store.user.id,
      members: store.members,
      tasks: [...store.tasks.values()],
      categories: [...store.categories.values()],
      activity: store.activity.slice(-1500),
    });
  }, 200);
}
function loadCache() {
  const c = LS.get(CACHE_KEY, null);
  if (!c || c.uid !== store.user?.id) return false;
  store.members = c.members || store.members;
  store.tasks = new Map((c.tasks || []).map(t => [t.id, t]));
  store.categories = new Map((c.categories || []).map(t => [t.id, t]));
  store.activity = c.activity || [];
  store.loaded = true;
  return true;
}

/* ---------- outbox ---------- */
let outbox = LS.get(OUTBOX_KEY, []);
const persistOutbox = () => LS.set(OUTBOX_KEY, outbox);
const opId = op => op.id || op.row?.id;
const pendingIds = () => new Set(outbox.map(opId));
export const pendingCount = () => outbox.length;

function applyOp(op) {
  if (op.table === 'activity') {
    if (op.kind === 'insert' && !store.activity.some(a => a.id === op.row.id)) store.activity.push({ ...op.row });
    if (op.kind === 'delete') store.activity = store.activity.filter(a => a.id !== op.id);
    return;
  }
  const m = store[op.table];
  if (op.kind === 'insert') m.set(op.row.id, { ...m.get(op.row.id), ...op.row });
  else if (op.kind === 'update') { const r = m.get(op.id); if (r) m.set(op.id, { ...r, ...op.patch }); }
  else if (op.kind === 'delete') m.delete(op.id);
}

function enqueue(op) {
  applyOp(op);
  // collapse consecutive updates of the same row
  const last = outbox[outbox.length - 1];
  if (op.kind === 'update' && last && last.kind === 'update' && last.table === op.table && last.id === op.id && !flushing) {
    last.patch = { ...last.patch, ...op.patch };
  } else outbox.push(op);
  persistOutbox();
  emit();
  scheduleFlush();
}

const isNet = e => !navigator.onLine || /failed to fetch|load failed|networkerror|network request|fetch/i.test(e?.message || '');
let flushing = false, flushTimer;
function scheduleFlush() { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 60); }

export async function flush() {
  if (!configured) { outbox = []; persistOutbox(); return; }
  if (flushing || !store.user) return;
  if (!navigator.onLine) { setSync('offline'); return; }
  if (!outbox.length) { setSync('idle'); return; }
  flushing = true;
  setSync('syncing');
  try {
    while (outbox.length) {
      const op = outbox[0];
      let res;
      if (op.kind === 'insert') res = await sb.from(op.table).upsert(op.row);
      else if (op.kind === 'update') res = await sb.from(op.table).update(op.patch).eq('id', op.id);
      else res = await sb.from(op.table).delete().eq('id', op.id);
      if (res.error) {
        if (isNet(res.error)) { setSync('offline'); return; }
        console.error('sync error', op, res.error);
        errorHandler('บันทึกไม่สำเร็จ: ' + res.error.message);
      }
      outbox.shift();
      persistOutbox();
    }
    setSync('idle');
  } catch (e) {
    setSync(isNet(e) ? 'offline' : 'error');
  } finally {
    flushing = false;
  }
}

/* ---------- loading & realtime ---------- */
let channel = null;
let lastRefresh = 0;

export async function refresh() {
  if (!configured || !store.user) return;
  if (!navigator.onLine) { setSync('offline'); return; }
  lastRefresh = Date.now();
  const [t, c, a, m] = await Promise.all([
    sb.from('tasks').select('*'),
    sb.from('categories').select('*'),
    sb.from('activity').select('*').order('created_at', { ascending: false }).limit(3000),
    sb.from('members').select('*'),
  ]);
  const err = t.error || c.error || a.error || m.error;
  if (err) { setSync(isNet(err) ? 'offline' : 'error'); if (!isNet(err)) errorHandler(err.message); return; }
  store.tasks = new Map(t.data.map(r => [r.id, r]));
  store.categories = new Map(c.data.map(r => [r.id, r]));
  store.activity = a.data.reverse();
  store.members = m.data;
  outbox.forEach(applyOp);
  store.loaded = true;
  emit();
  flush();
}

function onRealtime(table, p) {
  const id = p.new?.id || p.old?.id;
  if (pendingIds().has(id)) return;
  if (table === 'members') { refresh(); return; }
  if (table === 'activity') {
    if (p.eventType === 'INSERT' && !store.activity.some(x => x.id === id)) store.activity.push(p.new);
    else if (p.eventType === 'DELETE') store.activity = store.activity.filter(x => x.id !== id);
  } else {
    const map = store[table];
    if (p.eventType === 'DELETE') map.delete(id); else map.set(id, p.new);
  }
  emit();
  remoteHandler(table, p);
}

let authHooked = false;
async function subscribeRealtime() {
  if (channel) sb.removeChannel(channel);
  const { data } = await sb.auth.getSession();
  if (data.session) sb.realtime.setAuth(data.session.access_token);
  if (!authHooked) {
    authHooked = true;
    sb.auth.onAuthStateChange((_ev, session) => { if (session) sb.realtime.setAuth(session.access_token); });
  }
  channel = sb.channel('taskify-sync');
  for (const table of ['tasks', 'categories', 'activity', 'members']) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, p => onRealtime(table, p));
  }
  channel.subscribe(status => {
    if (status === 'SUBSCRIBED' && Date.now() - lastRefresh > 3000) refresh();
  });
}

const LOCAL_MEMBERS = [
  { email: 'me@local', display_name: 'ฉัน', color: '#2f6fed', user_id: 'local-me' },
  { email: 'partner@local', display_name: 'แฟน', color: '#e8508a', user_id: 'local-partner' },
];

export async function getSession() {
  if (!configured) { store.user = { id: 'local-me', email: 'me@local' }; return store.user; }
  const { data } = await sb.auth.getSession();
  store.user = data.session?.user ?? null;
  return store.user;
}

export async function start() {
  if (!configured) {
    store.members = LS.get('taskify.localMembers', LOCAL_MEMBERS);
    loadCache();
    store.loaded = true;
    emit();
    return;
  }
  loadCache();
  emit();
  await subscribeRealtime();
  await refresh();
  window.addEventListener('online', () => { flush(); refresh(); });
  window.addEventListener('offline', () => setSync('offline'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastRefresh > 20000) refresh();
  });
  setInterval(() => { if (outbox.length) flush(); }, 15000);
}

/* ---------- auth ---------- */
export async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
  if (error) throw error;
  store.user = data.user;
}
export async function signUp(email, password) {
  const { data, error } = await sb.auth.signUp({ email: email.trim().toLowerCase(), password });
  if (error) throw error;
  if (!data.session) throw new Error('confirm-required');
  store.user = data.user;
}
export async function signOut() {
  if (channel) sb.removeChannel(channel);
  await sb.auth.signOut().catch(() => {});
  LS.del(CACHE_KEY); LS.del(OUTBOX_KEY);
  outbox = [];
  store.user = null;
}

/* ---------- helpers ---------- */
export function computeDueAt(date, time) {
  if (!date) return null;
  const d = new Date(`${date}T${(time || '09:00').slice(0, 5)}:00`);
  return isNaN(d) ? null : d.toISOString();
}
function isoDate(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }
export function shiftDate(dateStr, repeat) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (repeat === 'daily') dt.setUTCDate(dt.getUTCDate() + 1);
  else if (repeat === 'weekly') dt.setUTCDate(dt.getUTCDate() + 7);
  else if (repeat === 'monthly') {
    const target = new Date(Date.UTC(y, m, 1));
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(d, last));
    return isoDate(target);
  }
  return isoDate(dt);
}
export function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export const runningSeconds = t => t.timer_started_at ? Math.max(0, Math.floor((Date.now() - new Date(t.timer_started_at)) / 1000)) : 0;

/* ---------- tasks ---------- */
export function createTask(fields = {}) {
  const sorts = [...store.tasks.values()].map(t => t.sort || 0);
  const row = {
    id: uuid(), title: '', note: '', status: 'todo', priority: 'mid', category_id: null, assignee: null,
    due_date: null, due_time: null, due_at: null, remind_before: null, reminded_at: null, repeat: 'none',
    pinned: false, sort: (sorts.length ? Math.min(...sorts) : 0) - 1, subtasks: [], attachments: [],
    time_spent: 0, timer_started_at: null, started_at: null, completed_at: null,
    created_by: store.user.id, created_at: nowIso(), updated_at: nowIso(),
    ...fields,
  };
  row.due_at = computeDueAt(row.due_date, row.due_time);
  if (row.status === 'done') row.completed_at = row.completed_at || nowIso();
  if (row.status !== 'todo') row.started_at = row.started_at || nowIso();
  enqueue({ kind: 'insert', table: 'tasks', row });
  addActivity(row.id, 'created', fields._fromRepeat ? 'repeat' : '');
  delete row._fromRepeat;
  return row;
}

export function updateTask(id, patch) {
  const t = store.tasks.get(id);
  if (!t) return;
  patch = { ...patch };
  if ('due_date' in patch || 'due_time' in patch) {
    const date = 'due_date' in patch ? patch.due_date : t.due_date;
    const time = 'due_time' in patch ? patch.due_time : t.due_time;
    patch.due_at = computeDueAt(date, time);
  }
  if ('status' in patch && patch.status !== t.status) {
    if (patch.status === 'done') {
      patch.completed_at = nowIso();
      if (t.timer_started_at) { patch.time_spent = (t.time_spent || 0) + runningSeconds(t); patch.timer_started_at = null; }
    } else patch.completed_at = null;
    if (patch.status !== 'todo' && !t.started_at) patch.started_at = nowIso();
    addActivity(id, 'status', patch.status);
  }
  if ('assignee' in patch && patch.assignee !== t.assignee) {
    addActivity(id, 'assigned', patch.assignee || '');
  }
  patch.updated_at = nowIso();
  enqueue({ kind: 'update', table: 'tasks', id, patch });
  if (patch.status === 'done' && t.status !== 'done' && t.repeat && t.repeat !== 'none') spawnNext(t);
}

function spawnNext(t) {
  const today = localToday();
  let next = shiftDate(t.due_date || today, t.repeat);
  let guard = 0;
  while (next < today && guard++ < 400) next = shiftDate(next, t.repeat);
  return createTask({
    title: t.title, note: t.note, priority: t.priority, category_id: t.category_id, assignee: t.assignee,
    due_date: next, due_time: t.due_time, remind_before: t.remind_before, repeat: t.repeat, pinned: t.pinned,
    subtasks: (t.subtasks || []).map(s => ({ ...s, done: false })), attachments: t.attachments || [],
    _fromRepeat: true,
  });
}

export function deleteTask(id) {
  const t = store.tasks.get(id);
  if (!t) return;
  enqueue({ kind: 'delete', table: 'tasks', id });
  store.activity = store.activity.filter(a => a.task_id !== id);
  const photos = (t.attachments || []).filter(a => a.type === 'photo').map(a => a.path);
  if (configured && photos.length) sb.storage.from('attachments').remove(photos).catch(() => {});
}

export function startTimer(id) {
  const t = store.tasks.get(id);
  if (!t || t.timer_started_at) return;
  const patch = { timer_started_at: nowIso() };
  if (t.status === 'todo') patch.status = 'doing';
  updateTask(id, patch);
}
export function stopTimer(id) {
  const t = store.tasks.get(id);
  if (!t?.timer_started_at) return;
  updateTask(id, { time_spent: (t.time_spent || 0) + runningSeconds(t), timer_started_at: null });
}

/* ---------- categories ---------- */
export function createCategory(name, color) {
  const sorts = [...store.categories.values()].map(c => c.sort || 0);
  const row = { id: uuid(), name: name.trim().slice(0, 40), color, sort: (sorts.length ? Math.max(...sorts) : 0) + 1, created_at: nowIso(), updated_at: nowIso() };
  enqueue({ kind: 'insert', table: 'categories', row });
  return row;
}
export function updateCategory(id, patch) { enqueue({ kind: 'update', table: 'categories', id, patch }); }
export function deleteCategory(id) {
  for (const t of store.tasks.values()) if (t.category_id === id) store.tasks.set(t.id, { ...t, category_id: null });
  enqueue({ kind: 'delete', table: 'categories', id });
}

/* ---------- activity ---------- */
export function addActivity(taskId, kind, body = '') {
  enqueue({ kind: 'insert', table: 'activity', row: { id: uuid(), task_id: taskId, user_id: store.user.id, kind, body, created_at: nowIso() } });
}
export function deleteActivity(id) { enqueue({ kind: 'delete', table: 'activity', id }); }

/* ---------- profile ---------- */
export async function updateProfile(name, color) {
  const m = me();
  if (m) { m.display_name = name; m.color = color; emit(); }
  if (!configured) { LS.set('taskify.localMembers', store.members); return; }
  const { error } = await sb.rpc('update_my_profile', { p_name: name, p_color: color });
  if (error) errorHandler(error.message);
}

/* ---------- photos ---------- */
async function compress(file, max = 1600) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(b => r(b || file), 'image/jpeg', 0.82));
  } catch { return file; }
}
const localPhotos = new Map();
export async function uploadPhoto(file) {
  const blob = await compress(file);
  const path = `${store.user.id}/${uuid()}.jpg`;
  if (!configured) {
    const url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
    localPhotos.set(path, url);
    LS.set('taskify.photo.' + path, url);
    return path;
  }
  const { error } = await sb.storage.from('attachments').upload(path, blob, { contentType: 'image/jpeg' });
  if (error) throw error;
  return path;
}
const urlCache = new Map();
export async function photoUrl(path) {
  if (!configured) return localPhotos.get(path) || LS.get('taskify.photo.' + path, '');
  const c = urlCache.get(path);
  if (c && c.exp > Date.now()) return c.url;
  const { data, error } = await sb.storage.from('attachments').createSignedUrl(path, 3600);
  if (error) return '';
  urlCache.set(path, { url: data.signedUrl, exp: Date.now() + 3500e3 });
  return data.signedUrl;
}
export function removePhoto(path) {
  if (configured) sb.storage.from('attachments').remove([path]).catch(() => {});
  else LS.del('taskify.photo.' + path);
}

/* ---------- push ---------- */
export async function savePushSubscription(sub) {
  const j = sub.toJSON();
  const { error } = await sb.from('push_subscriptions').upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_id: store.user.id });
  if (error) throw error;
}
export async function removePushSubscription(endpoint) {
  await sb.from('push_subscriptions').delete().eq('endpoint', endpoint);
}
export function notify(toUserId, title, body, taskId, test = false) {
  if (!configured || !toUserId || !navigator.onLine) return Promise.resolve();
  return sb.functions.invoke('push', { body: { type: 'notify', to: toUserId, title, body, taskId, test } });
}

/* ---------- import / export ---------- */
export function exportData() {
  return {
    app: 'taskify', version: 2, exported_at: nowIso(),
    categories: [...store.categories.values()],
    tasks: [...store.tasks.values()],
  };
}
export function importData(obj) {
  let n = 0;
  if (Array.isArray(obj?.categories)) for (const c of obj.categories) {
    if (!c.id || !c.name) continue;
    enqueue({ kind: 'insert', table: 'categories', row: { id: c.id, name: c.name, color: c.color || '#2f6fed', sort: c.sort || 0 } });
  }
  const known = new Set(['id','title','note','status','priority','category_id','assignee','due_date','due_time','due_at','remind_before','repeat','pinned','sort','subtasks','attachments','time_spent','started_at','completed_at','created_by','created_at']);
  const memberIds = new Set(store.members.map(m => m.user_id).filter(Boolean));
  if (Array.isArray(obj?.tasks)) for (const t of obj.tasks) {
    if (!t.id || !t.title) continue;
    const row = Object.fromEntries(Object.entries(t).filter(([k]) => known.has(k)));
    if (row.assignee && !memberIds.has(row.assignee)) row.assignee = null;
    if (row.created_by && !memberIds.has(row.created_by)) row.created_by = store.user.id;
    if (row.category_id && !store.categories.has(row.category_id)) row.category_id = null;
    enqueue({ kind: 'insert', table: 'tasks', row });
    n++;
  }
  return n;
}
export function importLegacy(list) {
  let n = 0;
  for (const x of list) {
    if (!x?.title) continue;
    createTask({ title: String(x.title).slice(0, 300), note: x.note || '', due_date: x.due || null, priority: ['high','mid','low'].includes(x.prio) ? x.prio : 'mid', status: ['todo','doing','done'].includes(x.status) ? x.status : 'todo' });
    n++;
  }
  return n;
}
