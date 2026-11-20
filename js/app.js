import * as store from './store.js';
import { state } from './store.js';
import { parseExpense, categorize } from './parser.js';
import { monthStats, weekStats, last30, habits, tips } from './insights.js';

// ───────────────────────── utilidades UI ─────────────────────────
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt = (n, decimals = 0) => new Intl.NumberFormat(state.data.config?.locale || 'es-MX', {
  style: 'currency', currency: state.data.config?.moneda || 'MXN', maximumFractionDigits: decimals, minimumFractionDigits: decimals,
}).format(Number(n) || 0);
const money = n => fmt(n, Number(n) % 1 ? 2 : 0);

const catOf = name => state.data.categories.find(c => c.name === name) || { name: name || 'Otros', emoji: '✨' };

/** Vibración: mejora opcional. Android: Vibration API. iOS 18+: alternar un <input switch> nativo. */
function haptic(pattern = 12) {
  if (navigator.vibrate) { navigator.vibrate(pattern); return; }
  try { $('#haptic-label').click(); } catch { /* sin soporte */ }
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function openSheet(html, onMount) {
  $('#sheet-body').innerHTML = html;
  $('#sheet').classList.remove('hidden');
  onMount?.($('#sheet-body'));
}
function closeSheet() { $('#sheet').classList.add('hidden'); }
$('#sheet').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(); });

// ───────────────────────── navegación ─────────────────────────
const TITLES = { add: 'Registrar', dash: 'Resumen', goals: 'Metas' };

function show(view) {
  if (!TITLES[view]) view = 'add';
  $$('.view').forEach(v => v.classList.toggle('hidden', v.id !== `view-${view}`));
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  $('#screen-title').textContent = TITLES[view];
  if (location.hash.slice(1) !== view) history.replaceState(null, '', `${location.pathname}#${view}`);
  if (view === 'dash') renderDashboard();
  if (view === 'goals') renderGoals();
  window.scrollTo({ top: 0 });
}
$$('.tab').forEach(t => t.addEventListener('click', () => { haptic(8); show(t.dataset.view); }));

// ───────────────────────── REGISTRAR ─────────────────────────
const amountEl = $('#in-amount');
const conceptEl = $('#in-concept');
const merchantEl = $('#in-merchant');
const dateEl = $('#in-date');
let selectedCat = null;   // categoría elegida a mano
let autoCat = null;       // categoría sugerida
let captureMethod = 'texto';
let extracted = null;     // lo que leyó la IA, para saber si lo corregiste
let busy = false;         // leyendo una foto

function renderChips() {
  const active = selectedCat || autoCat;
  $('#cat-chips').innerHTML = state.data.categories.map(c =>
    `<button class="chip ${c.name === active ? 'active' : ''}" data-cat="${esc(c.name)}">${esc(c.emoji)} ${esc(c.name)}</button>`).join('');
  $('#cat-auto').classList.toggle('hidden', !(autoCat && !selectedCat));
}
$('#cat-chips').addEventListener('click', e => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  haptic(6);
  selectedCat = selectedCat === b.dataset.cat ? null : b.dataset.cat;
  renderChips();
});

function updateAutoCategory() {
  autoCat = categorize(`${conceptEl.value} ${merchantEl.value}`, state.data.categories);
  renderChips();
}

// Si escribes "200 tacos" en el concepto, separa el monto automáticamente.
conceptEl.addEventListener('input', () => {
  const v = conceptEl.value;
  if (!amountEl.value && /\d/.test(v) && /\s/.test(v)) {
    const p = parseExpense(v);
    if (p.amount) { amountEl.value = p.amount; conceptEl.value = p.concept; }
  }
  updateAutoCategory();
});
merchantEl.addEventListener('input', updateAutoCategory);
amountEl.addEventListener('input', () => {
  amountEl.value = amountEl.value.replace(/[^\d.,]/g, '').replace(',', '.');
  amountEl.classList.remove('needs-review');
});
amountEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); conceptEl.focus(); } });
conceptEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });

function setMode(mode) {
  if (!['text', 'voice', 'photo'].includes(mode)) mode = 'text';
  $$('.seg').forEach(s => s.classList.toggle('active', s.dataset.mode === mode));
  $$('[data-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== mode));
  // Mientras hay datos por revisar, el concepto sigue visible para corregirlo
  if (!$('#review-card').classList.contains('hidden')) $('[data-panel="text"]').classList.remove('hidden');
  captureMethod = { text: 'texto', voice: 'voz', photo: 'foto' }[mode];
}
$$('.seg').forEach(s => s.addEventListener('click', () => { haptic(6); setMode(s.dataset.mode); }));

/** Muestra la tarjeta de revisión con lo que se interpretó (voz o foto). */
function showReview({ title, issues = [], warn = false, showMerchant = false }) {
  $('#review-card').classList.remove('hidden');
  $('#review-card').classList.toggle('warn', warn);
  $('#review-title').textContent = title;
  $('#review-issues').innerHTML = issues.map(i => `<li>• ${esc(i)}</li>`).join('');
  merchantEl.classList.toggle('hidden', !showMerchant);
  merchantEl.previousElementSibling.classList.toggle('hidden', !showMerchant);
  // El concepto siempre queda visible para corregirlo
  $('[data-panel="text"]').classList.remove('hidden');
  $('#btn-save').textContent = warn ? 'Confirmar y registrar' : 'Registrar gasto';
}

function resetForm() {
  amountEl.value = ''; conceptEl.value = ''; merchantEl.value = '';
  amountEl.classList.remove('needs-review');
  selectedCat = null; autoCat = null; extracted = null;
  dateEl.value = store.todayISO();
  renderDateLabel();
  $('#voice-transcript').textContent = '';
  $('#voice-status').textContent = 'Toca y di: “200 pesos en café”';
  $('#photo-preview').classList.add('hidden');
  $('#photo-status').textContent = 'Sube un ticket o captura de transferencia';
  $('.photo-drop').classList.remove('compact');
  $('#review-card').classList.add('hidden');
  $('#btn-save').textContent = 'Registrar gasto';
  setMode({ texto: 'text', voz: 'voice', foto: 'photo' }[captureMethod]);
  renderChips();
}

// ── Guardado + confirmación visual (siempre, haya o no vibración) ──
let lastSavedId = null;
let btnTimer;
/** El botón (siempre visible) confirma el estado: guardado local → confirmado por Sheets. */
function flashButton(text, ms) {
  const btn = $('#btn-save');
  btn.classList.add('done'); btn.textContent = text;
  clearTimeout(btnTimer);
  btnTimer = setTimeout(() => { btn.classList.remove('done'); btn.textContent = 'Registrar gasto'; }, ms);
}
function setSaveStatus(stateName, text) {
  const el = $('#save-status');
  el.dataset.state = stateName;
  el.textContent = text;
}

function save() {
  if (busy) return toast('Espera a que termine de leer la foto');
  const amount = parseFloat(String(amountEl.value).replace(',', '.'));
  if (!(amount > 0)) {
    toast('Escribe el monto'); amountEl.classList.add('needs-review'); amountEl.focus({ preventScroll: true }); amountEl.scrollIntoView({ block: 'center' });
    setSaveStatus('error', 'Falta el monto. No se guardó nada.');
    return;
  }
  const merchant = merchantEl.value.trim();
  const concept = conceptEl.value.trim() || merchant || 'Gasto';
  const category = selectedCat || autoCat || categorize(`${concept} ${merchant}`, state.data.categories) || 'Otros';
  let review = '';
  if (extracted) {
    const changed = Number(extracted.amount) !== amount || (extracted.merchant || '') !== merchant || (extracted.concept || '') !== concept;
    review = `${extracted.source}: ${changed ? 'corregido' : 'sin cambios'}`;
  }

  const { expense, storedLocally } = store.addExpense({ amount, concept, merchant, category, date: dateEl.value || store.todayISO(), method: captureMethod, review });
  if (!storedLocally) {
    setSaveStatus('error', '⚠️ El iPhone no tiene espacio para guardar. Libera espacio e intenta de nuevo.');
    return;
  }
  lastSavedId = expense.id;
  haptic([14, 30, 14]);

  flashButton(store.isConfigured() && navigator.onLine ? '✓ En el iPhone · enviando…' : '✓ Guardado en el iPhone', 2600);

  const label = `${catOf(category).emoji} ${money(amount)} · ${concept}`;
  if (!store.isConfigured()) setSaveStatus('local', `${label} — guardado solo en el iPhone (conecta Sheets en Ajustes)`);
  else if (!navigator.onLine) setSaveStatus('local', `${label} — guardado en el iPhone. Se enviará a Sheets al volver internet.`);
  else setSaveStatus('local', `${label} — guardado en el iPhone, enviando a Sheets…`);

  const r = $('#add-remaining'); r.classList.remove('pop'); void r.offsetWidth; r.classList.add('pop');
  resetForm();
  renderAdd();
}
$('#btn-save').addEventListener('click', save);

store.onSynced(({ expenses, rejected }) => {
  if (lastSavedId && expenses.includes(lastSavedId)) {
    setSaveStatus('synced', '✓ Confirmado por Google Sheets');
    if ($('#btn-save').classList.contains('done')) flashButton('✓ Confirmado en Sheets', 2000);
    lastSavedId = null;
  } else if (expenses.length) {
    setSaveStatus('synced', `✓ ${expenses.length} gasto${expenses.length === 1 ? '' : 's'} confirmado${expenses.length === 1 ? '' : 's'} por Google Sheets`);
  }
  if (rejected.length) toast(`Sheets rechazó ${rejected.length} gasto(s): ${rejected[0][1]}`);
  renderAdd();
});

function renderAdd() {
  const s = monthStats(state.data);
  const pct = s.budget ? Math.max(0, Math.min(100, (s.remaining / s.budget) * 100)) : 0;
  $('#add-remaining').textContent = fmt(s.budget ? s.remaining : 0);
  $('#add-remaining').className = `text-3xl font-semibold tabular-nums mt-1 ${s.remaining < 0 ? 'text-rose-400' : pct < 20 ? 'text-amber-300' : 'text-neon-green'}`;
  $('#add-remaining-bar').style.width = `${pct}%`;

  const today = store.todayISO();
  const pending = store.pendingExpenseIds();
  const recent = [...state.data.expenses].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 8);
  const todayTotal = state.data.expenses.filter(e => e.date === today).reduce((t, e) => t + Number(e.amount), 0);
  $('#today-total').textContent = todayTotal ? `Hoy: ${fmt(todayTotal)}` : '';

  $('#recent-list').innerHTML = recent.length ? recent.map(e => `
    <li class="row glass" data-exp="${esc(e.id)}">
      <div class="row-icon">${esc(catOf(e.category).emoji)}</div>
      <div class="flex-1 min-w-0">
        <p class="text-[15px] truncate">${esc(e.concept || e.merchant || 'Gasto')}</p>
        <p class="text-xs text-white/55 mt-0.5 flex items-center gap-1.5">
          <span>${esc(e.category)} · ${relDate(e.date)}</span>
          ${pending.has(e.id) ? '<span class="badge badge-local" data-sync="local">En el iPhone</span>' : '<span class="badge badge-synced" data-sync="synced">✓ Sheets</span>'}
        </p>
      </div>
      <p class="text-[15px] font-semibold tabular-nums">−${money(e.amount)}</p>
    </li>`).join('')
    : `<li class="text-center text-sm text-white/50 py-8">Aún no hay gastos. Registra el primero ↑</li>`;
}

$('#recent-list').addEventListener('click', e => {
  const li = e.target.closest('[data-exp]');
  if (!li) return;
  const exp = state.data.expenses.find(x => x.id === li.dataset.exp);
  if (!exp) return;
  const pending = store.pendingExpenseIds().has(exp.id);
  openSheet(`
    <div class="text-center">
      <div class="text-4xl">${esc(catOf(exp.category).emoji)}</div>
      <p class="text-4xl font-semibold tabular-nums mt-2">${fmt(exp.amount, 2)}</p>
      <p class="text-white/70 mt-1">${esc(exp.concept)}${exp.merchant && exp.merchant !== exp.concept ? ` · ${esc(exp.merchant)}` : ''}</p>
      <p class="text-xs text-white/55 mt-1">${esc(exp.category)} · ${esc(exp.date)} · vía ${esc(exp.method || 'texto')}</p>
      <p class="mt-3">${pending ? '<span class="badge badge-local">Guardado en el iPhone · pendiente de Sheets</span>' : '<span class="badge badge-synced">✓ Confirmado en Google Sheets</span>'}</p>
    </div>
    <button class="btn-ghost mt-6 text-rose-400" id="del-exp">Eliminar gasto</button>
    <button class="btn-ghost mt-2" data-close>Cerrar</button>`, body => {
    body.querySelector('#del-exp').onclick = () => { store.deleteExpense(exp.id); closeSheet(); toast('Gasto eliminado'); renderAll(); };
  });
});

function renderDateLabel() {
  const v = dateEl.value || store.todayISO();
  const label = new Date(v + 'T12:00').toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
  $('#date-label').textContent = v === store.todayISO() ? `Hoy, ${label}` : relDate(v) === 'Ayer' ? `Ayer, ${label}` : label;
}
dateEl.addEventListener('change', renderDateLabel);

function relDate(iso) {
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (iso === store.todayISO()) return 'Hoy';
  if (iso === store.todayISO(y)) return 'Ayer';
  return new Date(iso + 'T12:00').toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
}

// ── Voz ──
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
$('#btn-mic').addEventListener('click', () => {
  if (!SR) {
    // Respaldo: el dictado del teclado de iOS (🎙) funciona en cualquier campo de texto
    setMode('text'); conceptEl.focus();
    toast('Usa el 🎙 del teclado para dictar');
    return;
  }
  if (recog) { recog.stop(); return; }
  recog = new SR();
  recog.lang = 'es-MX';
  recog.interimResults = true;
  recog.maxAlternatives = 1;
  const mic = $('#btn-mic');
  mic.classList.add('listening'); haptic(8);
  $('#voice-status').textContent = 'Escuchando…';

  recog.onresult = ev => {
    const text = [...ev.results].map(r => r[0].transcript).join(' ');
    $('#voice-transcript').textContent = `“${text}”`;
    if (ev.results[ev.results.length - 1].isFinal) applyVoiceText(text);
  };
  recog.onerror = ev => {
    $('#voice-status').textContent = ev.error === 'not-allowed' ? 'Permite el micrófono para Safari en Ajustes del iPhone' : 'No te escuché. Intenta de nuevo o usa el 🎙 del teclado.';
  };
  recog.onend = () => { mic.classList.remove('listening'); recog = null; };
  recog.start();
});

function applyVoiceText(text) {
  const p = parseExpense(text);
  amountEl.value = p.amount || '';
  conceptEl.value = p.concept;
  extracted = { source: 'voz', amount: p.amount, concept: p.concept, merchant: '' };
  updateAutoCategory();
  $('#voice-status').textContent = '';
  showReview({
    title: p.amount ? `Escuché: “${text}”. Corrige si algo no es correcto.` : `Escuché: “${text}”, pero no el monto.`,
    issues: p.amount ? [] : ['Escribe el monto arriba antes de registrar.'],
    warn: !p.amount,
  });
  if (!p.amount) amountEl.classList.add('needs-review');
}

// ── Foto (visión) ──
$('#in-photo').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const drop = $('.photo-drop');
  const preview = $('#photo-preview');
  preview.src = URL.createObjectURL(file);
  preview.classList.remove('hidden');

  if (!navigator.onLine) { $('#photo-status').textContent = 'Leer la foto requiere internet. Captura el gasto por texto y se guardará en el iPhone.'; return; }
  if (!store.isConfigured()) { openSettings(); return; }

  busy = true;
  drop.classList.add('loading');
  $('#btn-save').disabled = true;
  $('#photo-status').textContent = 'Leyendo ticket…';
  try {
    const { base64, mediaType } = await compressImage(file, 1568, 0.85);
    const r = await store.post('parseReceipt', { image: base64, mediaType });
    applyReceipt(r);
  } catch (err) {
    $('#photo-status').textContent = `No pude leerla: ${err.message}`;
    showReview({ title: 'No se pudo leer la imagen.', issues: ['Captura monto y concepto a mano; nada se guardó.'], warn: true });
  } finally {
    busy = false;
    drop.classList.remove('loading');
    $('#btn-save').disabled = false;
  }
});

/** Llena el formulario con lo leído. Si hay dudas, NO rellena el monto: pide revisión. */
function applyReceipt(r) {
  const amountOk = r.amount_legible && r.amount > 0;
  amountEl.value = amountOk ? r.amount : '';
  merchantEl.value = r.merchant || '';
  conceptEl.value = r.concept || r.merchant || '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) { dateEl.value = r.date; renderDateLabel(); }
  extracted = { source: 'foto', amount: amountOk ? r.amount : null, merchant: r.merchant || '', concept: conceptEl.value };
  autoCat = state.data.categories.some(c => c.name === r.category) ? r.category : categorize(conceptEl.value, state.data.categories);
  renderChips();

  const issues = [...(r.issues || [])];
  if (!amountOk) { issues.unshift('No se leyó el total con certeza: escríbelo tú.'); amountEl.classList.add('needs-review'); }
  if (!r.date) issues.push('La fecha no aparece: se usará la de hoy. Cámbiala si no es correcta.');
  const needsReview = r.needsReview ?? (!amountOk || issues.length > 0);
  $('#photo-status').textContent = r.seconds ? `Leído en ${r.seconds} s · toca para otra foto` : 'Leído · toca para otra foto';
  $('.photo-drop').classList.add('compact');
  showReview({
    title: needsReview ? '⚠️ Revisa antes de guardar: la imagen tiene datos dudosos.' : `✓ ${r.merchant || 'Ticket'} — confirma que todo esté bien.`,
    issues, warn: needsReview, showMerchant: true,
  });
  haptic(10);
}

/** Reduce la imagen antes de subirla (más rápido y barato). */
function compressImage(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve({ base64: c.toDataURL('image/jpeg', quality).split(',')[1], mediaType: 'image/jpeg' });
    };
    img.onerror = () => reject(new Error('Formato de imagen no compatible'));
    img.src = URL.createObjectURL(file);
  });
}

// ───────────────────────── RESUMEN ─────────────────────────
let chartCats, chartDays;
const PALETTE = ['#22d3ee', '#a855f7', '#34d399', '#3b82f6', '#f472b6', '#facc15', '#fb923c', '#818cf8', '#2dd4bf', '#94a3b8'];

function renderDashboard() {
  const s = monthStats(state.data);
  const monthName = new Date().toLocaleDateString('es-MX', { month: 'long' });
  $('#dash-month').textContent = `Gastado en ${monthName}`;
  $('#dash-spent').textContent = fmt(s.spent);

  const d = $('#dash-delta');
  if (s.delta === null) { d.textContent = '—'; d.className = 'px-2 py-0.5 rounded-full text-xs bg-white/10'; }
  else {
    const up = s.delta > 0;
    d.textContent = `${up ? '▲' : '▼'} ${Math.abs(Math.round(s.delta * 100))}%`;
    d.className = `px-2 py-0.5 rounded-full text-xs ${up ? 'bg-rose-500/15 text-rose-300' : 'bg-emerald-500/15 text-emerald-300'}`;
  }

  const pct = s.budget ? (s.spent / s.budget) * 100 : 0;
  $('#dash-budget-label').textContent = `Presupuesto ${fmt(s.budget)}`;
  $('#dash-budget-pct').textContent = `${Math.round(pct)}%`;
  const bar = $('#dash-budget-bar');
  bar.style.width = `${Math.min(100, pct)}%`;
  bar.style.background = pct > 100 ? '#fb7185' : pct > 80 ? 'linear-gradient(90deg,#facc15,#fb923c)' : 'linear-gradient(90deg,#34d399,#22d3ee,#3b82f6)';
  $('#dash-projection').textContent = s.spent ? `Proyección al cierre: ${fmt(s.projection)}` : '';

  $('#kpi-daily').textContent = fmt(s.daily);
  $('#kpi-count').textContent = s.month.length;

  $('#cat-legend').innerHTML = s.byCat.length ? s.byCat.slice(0, 6).map(([name, total], i) => `
    <li class="flex items-center gap-2">
      <span class="w-2 h-2 rounded-full" style="background:${PALETTE[i % PALETTE.length]}"></span>
      <span class="flex-1 truncate text-white/75">${esc(catOf(name).emoji)} ${esc(name)}</span>
      <span class="tabular-nums">${fmt(total)}</span>
    </li>`).join('') : '<li class="text-white/50">Sin gastos este mes</li>';

  $('#habits').innerHTML = habits(state.data, fmt).map(h => `<li class="flex gap-3"><span>${h.icon}</span><span class="text-white/80">${h.text}</span></li>`).join('');
  $('#tips').innerHTML = tips(state.data, s, fmt).map(h => `<li class="flex gap-3"><span>${h.icon}</span><span class="text-white/80">${h.text}</span></li>`).join('');

  if (!window.Chart) return;
  Chart.defaults.color = 'rgba(255,255,255,.55)';
  Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, system-ui, sans-serif';

  const catData = { labels: s.byCat.map(c => c[0]), datasets: [{ data: s.byCat.map(c => c[1]), backgroundColor: PALETTE, borderWidth: 0, hoverOffset: 4 }] };
  if (chartCats) { chartCats.data = catData; chartCats.update(); }
  else chartCats = new Chart($('#chart-cats'), {
    type: 'doughnut', data: catData,
    options: { cutout: '74%', animation: { duration: 500 }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${fmt(c.raw)}` } } } },
  });

  const days = last30(state.data);
  const dayData = {
    labels: days.map(x => x.label),
    datasets: [{
      data: days.map(x => x.total), borderRadius: 6, borderSkipped: false, maxBarThickness: 10,
      backgroundColor: days.map(x => x.date === store.todayISO() ? '#22d3ee' : 'rgba(168,85,247,.6)'),
    }],
  };
  if (chartDays) { chartDays.data = dayData; chartDays.update(); }
  else chartDays = new Chart($('#chart-days'), {
    type: 'bar', data: dayData,
    options: {
      maintainAspectRatio: false, animation: { duration: 500 },
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: c => days[c[0].dataIndex].date, label: c => ` ${fmt(c.raw)}` } } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 6 } },
        y: { grid: { color: 'rgba(255,255,255,.06)' }, border: { display: false }, ticks: { maxTicksLimit: 4, callback: v => fmt(v) } },
      },
    },
  });
}

// ───────────────────────── METAS ─────────────────────────
function renderGoals() {
  const goals = state.data.goals;
  $('#goals-list').innerHTML = goals.length ? goals.map(g => {
    const pct = g.target ? Math.max(0, Math.min(100, (g.saved / g.target) * 100)) : 0;
    const img = g.image || 'icons/goal-default.svg';
    const done = pct >= 100;
    return `
      <article class="goal fade-in" data-goal="${esc(g.id)}" data-pct="${pct.toFixed(1)}">
        <div class="goal-img locked" style="background-image:url('${esc(img)}')"></div>
        <div class="goal-img revealed" style="background-image:url('${esc(img)}'); clip-path: inset(${(100 - pct).toFixed(2)}% 0 0 0)"></div>
        ${done ? '' : `<div class="goal-waterline" style="bottom:${pct}%"></div>`}
        <div class="goal-overlay">
          <div class="flex items-start justify-between">
            <div>
              <p class="text-lg font-semibold drop-shadow">${esc(g.name)}</p>
              ${/^\d{4}-\d{2}-\d{2}$/.test(g.deadline || '') ? `<p class="text-xs text-white/75">Para ${new Date(g.deadline + 'T12:00').toLocaleDateString('es-MX', { month: 'short', year: 'numeric' })}</p>` : ''}
            </div>
            <span class="text-xs px-2.5 py-1 rounded-full glass">${done ? '🎉 ¡Lograda!' : `${Math.round(pct)}%`}</span>
          </div>
          <div class="flex items-end justify-between">
            <div>
              <p class="text-4xl font-semibold tabular-nums tracking-tight drop-shadow">${fmt(g.saved)}</p>
              <p class="text-xs text-white/75">de ${fmt(g.target)}${!done && /^\d{4}-\d{2}-\d{2}$/.test(g.deadline || '') ? ` · ${monthlyNeeded(g)}` : ''}</p>
            </div>
            <button class="w-11 h-11 rounded-full bg-white text-black text-2xl leading-none font-light active:scale-95 transition" data-contrib="${esc(g.id)}" aria-label="Abonar a ${esc(g.name)}">+</button>
          </div>
        </div>
      </article>`;
  }).join('') : `
    <div class="glass rounded-[28px] p-8 text-center">
      <div class="text-4xl">🚗</div>
      <p class="mt-3 font-medium">Crea tu primera meta</p>
      <p class="text-sm text-white/60 mt-1">La imagen se irá revelando conforme ahorres.</p>
    </div>`;
}

function monthlyNeeded(g) {
  const months = Math.max(1, (new Date(g.deadline) - new Date()) / (1000 * 60 * 60 * 24 * 30.4));
  return `${fmt((g.target - g.saved) / months)}/mes`;
}

$('#goals-list').addEventListener('click', e => {
  const c = e.target.closest('[data-contrib]');
  const card = e.target.closest('[data-goal]');
  if (c) return openContribute(c.dataset.contrib);
  if (card) return openGoalEditor(state.data.goals.find(g => g.id === card.dataset.goal));
});
$('#btn-new-goal').addEventListener('click', () => openGoalEditor());

function openContribute(id) {
  const g = state.data.goals.find(x => x.id === id);
  openSheet(`
    <p class="text-center text-white/60 text-sm">Abonar a</p>
    <p class="text-center text-xl font-semibold">${esc(g.name)}</p>
    <div class="flex items-start justify-center gap-1 mt-6">
      <span class="text-3xl font-light text-white/55 mt-3">$</span>
      <input id="contrib-amount" inputmode="decimal" placeholder="0" aria-label="Monto a abonar" class="bg-transparent outline-none text-center text-6xl font-semibold tabular-nums w-48" />
    </div>
    <div class="flex gap-2 justify-center mt-4">${[100, 500, 1000].map(v => `<button class="chip" data-quick="${v}">+${fmt(v)}</button>`).join('')}</div>
    <button class="btn-primary mt-6" id="contrib-save">Abonar</button>
    <button class="btn-ghost mt-2 text-white/70" id="contrib-withdraw">Retirar</button>`, body => {
    const input = body.querySelector('#contrib-amount');
    setTimeout(() => input.focus(), 250);
    body.querySelectorAll('[data-quick]').forEach(b => b.onclick = () => { input.value = (Number(input.value) || 0) + Number(b.dataset.quick); haptic(6); });
    const apply = sign => {
      const v = parseFloat(input.value);
      if (!(v > 0)) return toast('Escribe un monto');
      const before = g.saved / g.target;
      store.contributeGoal(id, sign * v);
      closeSheet(); renderGoals(); haptic([14, 30, 14]);
      toast(g.saved >= g.target && before < 1 ? '🎉 ¡Meta lograda!' : sign > 0 ? `+${fmt(v)} a ${g.name}` : `−${fmt(v)} retirado`);
    };
    body.querySelector('#contrib-save').onclick = () => apply(1);
    body.querySelector('#contrib-withdraw').onclick = () => apply(-1);
  });
}

function openGoalEditor(g = {}) {
  openSheet(`
    <p class="text-xl font-semibold text-center">${g.id ? 'Editar meta' : 'Nueva meta'}</p>
    <label class="field-label">Nombre</label>
    <input class="field" id="g-name" placeholder="Mi coche" value="${esc(g.name || '')}" />
    <label class="field-label">Monto objetivo</label>
    <input class="field" id="g-target" inputmode="decimal" placeholder="250000" value="${esc(g.target || '')}" />
    ${g.id ? '' : `<label class="field-label">Ya ahorrado</label>
    <input class="field" id="g-saved" inputmode="decimal" placeholder="0" />`}
    <label class="field-label">Imagen (URL)</label>
    <input class="field" id="g-image" placeholder="https://…jpg" value="${esc(g.image || '')}" />
    <p class="text-[11px] text-white/50 mt-1.5 px-1">Mantén presionada una foto en Safari → “Copiar enlace de imagen”.</p>
    <label class="field-label">Fecha objetivo (opcional)</label>
    <input class="field" id="g-deadline" type="date" value="${esc(g.deadline || '')}" />
    <button class="btn-primary mt-6" id="g-save">Guardar</button>
    ${g.id ? '<button class="btn-ghost mt-2 text-rose-400" id="g-del">Eliminar meta</button>' : ''}`, body => {
    body.querySelector('#g-save').onclick = () => {
      const name = body.querySelector('#g-name').value.trim();
      const target = parseFloat(body.querySelector('#g-target').value);
      if (!name || !(target > 0)) return toast('Nombre y monto son obligatorios');
      store.saveGoal({
        ...g, name, target,
        saved: g.id ? g.saved : (parseFloat(body.querySelector('#g-saved').value) || 0),
        image: body.querySelector('#g-image').value.trim(),
        deadline: body.querySelector('#g-deadline').value,
      });
      closeSheet(); renderGoals(); toast('Meta guardada');
    };
    const del = body.querySelector('#g-del');
    if (del) del.onclick = () => { if (confirm(`¿Eliminar “${g.name}”?`)) { store.deleteGoal(g.id); closeSheet(); renderGoals(); } };
  });
}

// ───────────────────────── AJUSTES ─────────────────────────
function setupLink() {
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify({ u: state.settings.apiUrl, t: state.settings.token }))));
  return `${location.origin}${location.pathname}#setup=${payload}`;
}

function openSettings() {
  const s = state.settings;
  openSheet(`
    <p class="text-xl font-semibold text-center">Ajustes</p>
    <label class="field-label">URL de la API (Apps Script)</label>
    <input class="field" id="s-url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(s.apiUrl)}" />
    <label class="field-label">Token</label>
    <input class="field" id="s-token" placeholder="APP_TOKEN" value="${esc(s.token)}" />
    <label class="field-label">Presupuesto mensual</label>
    <input class="field" id="s-budget" inputmode="decimal" value="${esc(state.data.config?.presupuesto_mensual || '')}" />
    <button class="btn-primary mt-6" id="s-save">Guardar y conectar</button>
    ${store.isConfigured() ? '<button class="btn-ghost mt-2" id="s-link">Copiar enlace de configuración</button>' : ''}
    <p class="text-[12px] text-white/55 text-center mt-4" id="s-info">${state.queue.length} cambio(s) en el iPhone pendientes de Sheets${state.meta.lastSync ? ` · última sincronización ${new Date(state.meta.lastSync).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}` : ''}</p>`, body => {
    body.querySelector('#s-save').onclick = async () => {
      store.saveSettings({ apiUrl: body.querySelector('#s-url').value.trim(), token: body.querySelector('#s-token').value.trim() });
      const budget = parseFloat(body.querySelector('#s-budget').value);
      if (budget > 0 && budget !== Number(state.data.config?.presupuesto_mensual)) store.setConfig({ presupuesto_mensual: budget });
      body.querySelector('#s-info').textContent = 'Conectando…';
      try {
        await store.flush();
        if (state.sync.status === 'error') throw new Error(state.sync.error);
        await store.refresh();
        toast('✓ Conectado a Google Sheets'); closeSheet();
      } catch (err) { body.querySelector('#s-info').textContent = `No se pudo conectar: ${err.message}`; }
      renderAll();
    };
    const link = body.querySelector('#s-link');
    if (link) link.onclick = async () => {
      try { await navigator.clipboard.writeText(setupLink()); toast('Enlace copiado'); }
      catch { prompt('Copia este enlace:', setupLink()); }
    };
  });
}
$('#btn-settings').addEventListener('click', openSettings);

/** #setup=… configura la app con un toque (útil para Safari o un segundo dispositivo). */
function handleSetupLink() {
  const m = location.hash.match(/^#setup=(.+)$/);
  if (!m) return false;
  try {
    const { u, t } = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
    if (u && t) { store.saveSettings({ apiUrl: u, token: t }); toast('✓ App configurada'); }
  } catch { toast('Enlace de configuración inválido'); }
  history.replaceState(null, '', `${location.pathname}#add`);
  return true;
}

// ───────────────────────── Resumen semanal (banner) ─────────────────────────
function weekKey(d = new Date()) {
  const t = new Date(d); t.setDate(t.getDate() - ((t.getDay() + 6) % 7));
  return store.todayISO(t);
}

function weeklySummary() {
  const w = weekStats(state.data);
  if (!w.budget) return;
  let dismissed = '';
  try { dismissed = localStorage.getItem('nest.weekDismissed') || ''; } catch { /* */ }
  if (dismissed === weekKey()) return;
  $('#weekly-title').textContent = w.remaining >= 0 ? `Te quedan ${fmt(w.remaining)} este mes` : `Te pasaste ${fmt(-w.remaining)} del presupuesto`;
  $('#weekly-text').innerHTML = w.remaining >= 0
    ? `Semana: <b>${fmt(w.weekSpent)}</b> · puedes gastar <b>~${fmt(w.perDay)}/día</b> por ${w.daysLeft} días`
    : `Semana: <b>${fmt(w.weekSpent)}</b> · te pasaste <b>${fmt(-w.remaining)}</b>; pausa lo no esencial`;
  $('#weekly-banner').classList.remove('hidden');
}
$('#weekly-close').addEventListener('click', () => {
  $('#weekly-banner').classList.add('hidden');
  try { localStorage.setItem('nest.weekDismissed', weekKey()); } catch { /* */ }
});

// ───────────────────────── Estado de sincronización ─────────────────────────
function renderSync() {
  const n = store.pendingExpenseIds().size + state.queue.filter(q => q.action !== 'addExpenses').length;
  const pill = $('#sync-pill');
  let st, text;
  if (!store.isConfigured()) { st = 'error'; text = 'Sin conectar'; }
  else if (!navigator.onLine) { st = 'offline'; text = n ? `Sin internet · ${n} en iPhone` : 'Sin internet'; }
  else if (state.sync.status === 'syncing') { st = 'syncing'; text = 'Sincronizando'; }
  else if (state.sync.status === 'error' && n) { st = 'error'; text = `${n} sin enviar · reintentar`; }
  else if (n) { st = 'pending'; text = `${n} en el iPhone`; }
  else { st = 'ok'; text = '✓ Sheets'; }
  pill.dataset.state = st;
  pill.textContent = text;
}
$('#sync-pill').addEventListener('click', () => {
  if (!store.isConfigured()) return openSettings();
  if (state.sync.status === 'error') toast(state.sync.error || 'Reintentando…');
  store.flush().then(() => store.refresh()).catch(() => {});
});

function renderAll() {
  renderAdd(); renderChips(); renderSync();
  if (!$('#view-dash').classList.contains('hidden')) renderDashboard();
  if (!$('#view-goals').classList.contains('hidden')) renderGoals();
}

store.onChange(() => { renderSync(); renderAdd(); });
window.addEventListener('online', async () => { renderSync(); await store.flush(); await store.refresh().catch(() => {}); renderAll(); });
window.addEventListener('offline', renderSync);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') store.flush().then(() => store.refresh()).then(renderAll).catch(() => {});
});
window.addEventListener('hashchange', () => { if (!handleSetupLink()) show(location.hash.slice(1)); });

// ───────────────────────── Arranque ─────────────────────────
// Pinta al instante con la caché local; Sheets se consulta en segundo plano.
handleSetupLink();
$('#today-label').textContent = new Date().toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
dateEl.value = store.todayISO();
renderDateLabel();
show(location.hash.slice(1) || 'add');
setMode(new URLSearchParams(location.search).get('mode') || 'text');
renderAll();
weeklySummary();

if (!store.isConfigured()) setTimeout(openSettings, 400);
else store.flush().then(() => store.refresh()).then(() => { renderAll(); weeklySummary(); }).catch(err => { if (navigator.onLine) toast(err.message); });

window.addEventListener('load', () => { if (!$('#view-dash').classList.contains('hidden')) renderDashboard(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
