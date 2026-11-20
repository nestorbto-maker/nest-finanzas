// Estado local + cola offline + comunicación con Apps Script.
// Regla: todo se guarda primero en el teléfono (localStorage) y se marca como
// "sincronizado" SOLO cuando Sheets confirma el ID en su respuesta.

const K = { settings: 'nest.settings', cache: 'nest.cache', queue: 'nest.queue', meta: 'nest.meta' };

const safeGet = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
const safeSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

export const DEFAULT_CATEGORIES = [
  { name: 'Comida', emoji: '🍽️', keywords: ['restaurante', 'comida', 'cena', 'desayuno', 'almuerzo', 'tacos', 'pizza', 'sushi', 'hamburguesa', 'rappi', 'uber eats', 'didi food', 'cafe', 'starbucks', 'panaderia', 'antojo'], budget: 4000 },
  { name: 'Súper', emoji: '🛒', keywords: ['super', 'walmart', 'soriana', 'chedraui', 'costco', 'sams', 'oxxo', '7 eleven', 'heb', 'la comer', 'mercado', 'despensa'], budget: 5000 },
  { name: 'Transporte', emoji: '🚗', keywords: ['uber', 'didi', 'taxi', 'gasolina', 'gas', 'metro', 'camion', 'autobus', 'estacionamiento', 'caseta', 'peaje', 'cabify', 'pemex'], budget: 2500 },
  { name: 'Hogar', emoji: '🏠', keywords: ['renta', 'luz', 'cfe', 'agua', 'internet', 'telmex', 'izzi', 'totalplay', 'mantenimiento', 'limpieza', 'muebles'], budget: 9000 },
  { name: 'Suscripciones', emoji: '📺', keywords: ['netflix', 'spotify', 'disney', 'hbo', 'max', 'prime', 'icloud', 'apple', 'youtube', 'chatgpt', 'claude', 'suscripcion'], budget: 800 },
  { name: 'Salud', emoji: '💊', keywords: ['farmacia', 'doctor', 'medico', 'consulta', 'hospital', 'dentista', 'gimnasio', 'gym', 'similares', 'benavides'], budget: 1500 },
  { name: 'Compras', emoji: '🛍️', keywords: ['amazon', 'mercado libre', 'liverpool', 'zara', 'ropa', 'zapatos', 'shein', 'palacio', 'tienda'], budget: 2000 },
  { name: 'Ocio', emoji: '🎉', keywords: ['cine', 'cinepolis', 'bar', 'fiesta', 'concierto', 'boletos', 'viaje', 'hotel', 'airbnb', 'juego', 'steam', 'playstation'], budget: 2000 },
  { name: 'Educación', emoji: '📚', keywords: ['curso', 'libro', 'escuela', 'colegiatura', 'udemy', 'platzi', 'clase'], budget: 1000 },
  { name: 'Otros', emoji: '✨', keywords: [], budget: 1000 },
];

export const state = {
  settings: safeGet(K.settings, { apiUrl: '', token: '' }),
  data: safeGet(K.cache, { expenses: [], categories: DEFAULT_CATEGORIES, goals: [], config: { presupuesto_mensual: 25000, moneda: 'MXN', locale: 'es-MX' } }),
  queue: safeGet(K.queue, []), // [{ id, action, payload }]
  meta: safeGet(K.meta, { lastSync: null }),
  sync: { status: 'idle', error: '' }, // idle | syncing | offline | error
  listeners: new Set(),
  syncedListeners: new Set(),
};

export const onChange = fn => state.listeners.add(fn);
export const onSynced = fn => state.syncedListeners.add(fn);
const emit = () => state.listeners.forEach(fn => fn(state));

export function saveSettings(s) { state.settings = { ...state.settings, ...s }; safeSet(K.settings, state.settings); }
function persist() {
  const ok = safeSet(K.queue, state.queue) && safeSet(K.cache, state.data);
  safeSet(K.meta, state.meta);
  return ok;
}

export const isConfigured = () => !!(state.settings.apiUrl && state.settings.token);

/** IDs de gastos que existen en el teléfono pero Sheets aún no confirmó. */
export function pendingExpenseIds() {
  return new Set(state.queue.filter(q => q.action === 'addExpenses').flatMap(q => q.payload.expenses.map(e => e.id)));
}

// ── HTTP ──
const TIMEOUT_MS = 20000;
async function request(url, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || json.message || 'Error del servidor');
    return json.data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Sin respuesta de Sheets (tiempo agotado)');
    throw err;
  } finally { clearTimeout(t); }
}

async function get(params) {
  const url = new URL(state.settings.apiUrl);
  Object.entries({ ...params, token: state.settings.token }).forEach(([k, v]) => url.searchParams.set(k, v));
  return request(url, { method: 'GET' });
}

// text/plain evita el "preflight" CORS, que Apps Script no soporta.
export function post(action, payload) {
  return request(state.settings.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: state.settings.token, action, payload }),
  });
}

// ── Lectura ──
/** Aplica sobre datos frescos del servidor los cambios que siguen en cola, para no "perderlos" en pantalla. */
function applyPending(data) {
  for (const job of state.queue) {
    const p = job.payload;
    if (job.action === 'addExpenses') {
      const ids = new Set(data.expenses.map(e => e.id));
      p.expenses.forEach(e => { if (!ids.has(e.id)) data.expenses.push(e); });
    } else if (job.action === 'deleteExpense') {
      data.expenses = data.expenses.filter(e => e.id !== p.id);
    } else if (job.action === 'saveGoal') {
      const i = data.goals.findIndex(g => g.id === p.id);
      if (i >= 0) data.goals[i] = { ...data.goals[i], ...p }; else data.goals.push(p);
    } else if (job.action === 'contributeGoal') {
      const g = data.goals.find(x => x.id === p.id);
      if (g) g.saved = Math.max(0, (g.saved || 0) + p.amount);
    } else if (job.action === 'deleteGoal') {
      data.goals = data.goals.filter(g => g.id !== p.id);
    } else if (job.action === 'setConfig') {
      data.config = { ...data.config, ...p };
    }
  }
  return data;
}

const confirmedAt = new Map(); // id → momento en que Sheets lo confirmó

export async function refresh() {
  if (!isConfigured() || !navigator.onLine) return false;
  const startedAt = Date.now();
  const data = await get({ action: 'bootstrap', days: 120 });
  if (!data.categories?.length) data.categories = DEFAULT_CATEGORIES;
  // Si un gasto se confirmó mientras esta lectura viajaba, consérvalo
  const ids = new Set(data.expenses.map(e => e.id));
  state.data.expenses.forEach(e => { if (!ids.has(e.id) && (confirmedAt.get(e.id) || 0) >= startedAt) data.expenses.push(e); });
  state.data = applyPending(data);
  persist(); emit();
  return true;
}

// ── Escrituras con cola offline ──
function enqueue(action, payload) {
  state.queue.push({ id: crypto.randomUUID(), action, payload });
  const ok = persist();
  emit();
  flush();
  return ok;
}

let flushing = null;
/** Envía la cola. Si llegan cambios nuevos mientras se envía, vuelve a intentar al terminar. */
export function flush() {
  if (flushing) return flushing.then(() => (state.queue.length && navigator.onLine ? flush() : undefined));
  if (!isConfigured() || !state.queue.length) return Promise.resolve();
  if (!navigator.onLine) { setSync('offline'); return Promise.resolve(); }
  flushing = doFlush().finally(() => { flushing = null; });
  return flushing;
}

async function doFlush() {
  setSync('syncing');
  try {
    // 1) Todos los gastos pendientes en una sola petición
    const expenseJobs = state.queue.filter(q => q.action === 'addExpenses');
    if (expenseJobs.length) {
      const expenses = expenseJobs.flatMap(q => q.payload.expenses);
      const res = await post('addExpenses', { expenses });
      const confirmed = new Set(res.saved || []);
      const rejected = new Map((res.rejected || []).map(r => [r.id, r.reason]));
      // Solo sale de la cola lo que Sheets confirmó (o rechazó explícitamente)
      state.queue = state.queue.filter(q => q.action !== 'addExpenses' || !q.payload.expenses.every(e => confirmed.has(e.id) || rejected.has(e.id)));
      state.queue.forEach(q => { if (q.action === 'addExpenses') q.payload.expenses = q.payload.expenses.filter(e => !confirmed.has(e.id) && !rejected.has(e.id)); });
      if (rejected.size) state.data.expenses = state.data.expenses.filter(e => !rejected.has(e.id));
      persist(); emit();
      const done = expenses.filter(e => confirmed.has(e.id)).map(e => e.id);
      done.forEach(id => confirmedAt.set(id, Date.now()));
      if (done.length) state.syncedListeners.forEach(fn => fn({ expenses: done, rejected: [...rejected] }));
      else if (rejected.size) state.syncedListeners.forEach(fn => fn({ expenses: [], rejected: [...rejected] }));
    }
    // 2) El resto, en orden (todas las acciones son idempotentes en el servidor)
    while (state.queue.some(q => q.action !== 'addExpenses')) {
      const job = state.queue.find(q => q.action !== 'addExpenses');
      await post(job.action, job.payload);
      state.queue = state.queue.filter(q => q.id !== job.id);
      persist(); emit();
    }
    state.meta.lastSync = new Date().toISOString();
    persist();
    setSync(state.queue.length ? 'syncing' : 'idle');
  } catch (err) {
    setSync(navigator.onLine ? 'error' : 'offline', err.message);
  }
}

function setSync(status, error = '') {
  state.sync = { status, error };
  emit();
}

export function addExpense(exp) {
  const e = { id: crypto.randomUUID(), date: todayISO(), method: 'texto', merchant: '', review: '', ...exp };
  state.data.expenses.push(e);
  const storedLocally = enqueue('addExpenses', { expenses: [e] });
  return { expense: e, storedLocally };
}

export function deleteExpense(id) {
  const wasPending = pendingExpenseIds().has(id);
  state.data.expenses = state.data.expenses.filter(e => e.id !== id);
  if (wasPending) {
    state.queue.forEach(q => { if (q.action === 'addExpenses') q.payload.expenses = q.payload.expenses.filter(e => e.id !== id); });
    state.queue = state.queue.filter(q => q.action !== 'addExpenses' || q.payload.expenses.length);
    persist(); emit();
  } else enqueue('deleteExpense', { id });
}

export function saveGoal(goal) {
  const g = { saved: 0, ...goal, id: goal.id || crypto.randomUUID() };
  const i = state.data.goals.findIndex(x => x.id === g.id);
  if (i >= 0) state.data.goals[i] = g; else state.data.goals.push(g);
  enqueue('saveGoal', g);
  return g;
}

export function contributeGoal(id, amount) {
  const g = state.data.goals.find(x => x.id === id);
  if (g) g.saved = Math.max(0, (g.saved || 0) + amount);
  enqueue('contributeGoal', { id, amount, opId: crypto.randomUUID() });
}

export function deleteGoal(id) {
  state.data.goals = state.data.goals.filter(x => x.id !== id);
  enqueue('deleteGoal', { id });
}

export function setConfig(obj) {
  state.data.config = { ...state.data.config, ...obj };
  enqueue('setConfig', obj);
}

export function todayISO(d = new Date()) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}
