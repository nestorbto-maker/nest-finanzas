// Pruebas de extremo a extremo: PWA real + backend/Code.gs real (en el simulador).
//   node tests/e2e.mjs [webkit|chromium]
// Resultados: tests/output/results.md y capturas en tests/output/*.png

import { webkit, chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, TOKEN } from './mock-gas.mjs';

const ENGINE = process.argv[2] || 'webkit';
const PORT = 8790 + (ENGINE === 'webkit' ? 0 : 1);
const BASE = `http://localhost:${PORT}`;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'output');
fs.mkdirSync(OUT, { recursive: true });

const IPHONE = { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: ENGINE !== 'firefox', hasTouch: true, locale: 'es-MX', timezoneId: 'America/Mexico_City' };
const setupHash = '#setup=' + Buffer.from(JSON.stringify({ u: `${BASE}/__api`, t: TOKEN })).toString('base64');

// Simula las áreas seguras de un iPhone 15/16 Pro (barra de estado 59 px, indicador de inicio 34 px)
const SAFE_AREA = ':root{--sat:59px;--sab:34px}';
const newIPhonePage = async c => { const p = await c.newPage(); await p.addInitScript(css => { document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); }); }, SAFE_AREA); return p; };

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try { const note = await fn(); results.push({ name, ok: true, ms: Date.now() - t0, note: note || '' }); console.log(`✅ ${name}${note ? ' — ' + note : ''}`); }
  catch (err) { await ctx.setOffline(false).catch(() => {}); await ctl({ blockApi: false }).catch(() => {}); results.push({ name, ok: false, ms: Date.now() - t0, note: err.message.split('\n')[0] }); console.log(`❌ ${name}\n   ${err.message.split('\n').slice(0, 4).join('\n   ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const ctl = body => fetch(`${BASE}/__control`, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
const sheet = () => fetch(`${BASE}/__sheet`).then(r => r.json());
const countId = (rows, id) => rows.filter(r => r[0] === id).length;
const api = (action, payload) => fetch(`${BASE}/__api`, { method: 'POST', redirect: 'follow', body: JSON.stringify({ token: TOKEN, action, payload }) }).then(r => r.json());

async function waitSynced(page, timeout = 15000) {
  await page.waitForFunction(() => document.querySelectorAll('[data-sync="local"]').length === 0 && document.querySelector('#sync-pill')?.dataset.state === 'ok', null, { timeout });
}
async function idsOnPage(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('nest.cache')).expenses.map(e => ({ id: e.id, concept: e.concept, amount: e.amount })));
}
/** Tras una respuesta perdida: el navegador puede reenviar solo, o la app marca error y se reintenta con el indicador. */
async function watchPill(page) {
  await page.evaluate(() => {
    window.__pill = [];
    new MutationObserver(() => window.__pill.push(document.querySelector('#sync-pill').dataset.state))
      .observe(document.querySelector('#sync-pill'), { attributes: true, attributeFilter: ['data-state'] });
  });
}
async function recoverFromDrop(page) {
  let taps = 0, errorText = '';
  for (let i = 0; i < 20; i++) {
    const st = await page.$eval('#sync-pill', e => e.dataset.state);
    const pending = await page.$$eval('[data-sync="local"]', els => els.length);
    if (st === 'ok' && !pending && (await page.evaluate(() => window.__pill.length)) > 0) break;
    if (st === 'error') { errorText ||= await page.textContent('#sync-pill'); taps++; await page.click('#sync-pill'); }
    await page.waitForTimeout(1500);
  }
  await waitSynced(page);
  const sawError = await page.evaluate(() => window.__pill.includes('error'));
  return sawError ? `la app mostró "${errorText}" sin declarar éxito; ${taps} reintento(s) con el indicador` : 'el navegador reenvió la petición automáticamente';
}

async function quickSave(page, amount, concept) {
  await page.fill('#in-amount', String(amount));
  await page.fill('#in-concept', concept);
  await page.click('#btn-save');
}

const server = await startServer(PORT);
const browserType = ENGINE === 'webkit' ? webkit : chromium;
const browser = await browserType.launch();
console.log(`Motor: ${ENGINE} ${browser.version()} · ${BASE}\n`);

let ctx = await browser.newContext(IPHONE);
let page = await newIPhonePage(ctx);
const consoleErrors = [];
const watch = p => p.on('pageerror', e => consoleErrors.push(e.message));
watch(page);

// ───────────── 1. Experiencia principal ─────────────
await ctl({ reset: true });

await test('Abre directamente en Registrar con Texto/Voz/Foto visibles sin desplazarse', async () => {
  await page.goto(`${BASE}/index.html${setupHash}`);
  await page.waitForSelector('#view-add:not(.hidden)');
  assert(await page.textContent('#screen-title') === 'Registrar', 'El título no es Registrar');
  const segs = await page.$$eval('.seg', els => els.map(e => ({ t: e.textContent.trim(), b: e.getBoundingClientRect().bottom })));
  assert(segs.length === 3 && segs.every(s => s.b < 852), 'Modos no visibles en la primera pantalla');
  await page.waitForSelector('#weekly-banner:not(.hidden)');
  const save = await page.$eval('#btn-save', e => e.getBoundingClientRect().bottom);
  const tabTop = await page.$eval('.tabbar', e => e.getBoundingClientRect().top);
  assert(save < tabTop, `El botón Registrar (${Math.round(save)} px) queda detrás de la barra (${Math.round(tabTop)} px)`);
  return `modos: ${segs.map(s => s.t).join(' / ')}; con el resumen semanal visible, el botón Registrar termina en ${Math.round(save)} px y la barra empieza en ${Math.round(tabTop)} px`;
});

await test('Gasto simple en 3 pasos: monto → concepto → Registrar, con estado "en el iPhone" y luego "confirmado por Sheets"', async () => {
  await page.waitForFunction(() => document.querySelector('#sync-pill').dataset.state === 'ok');
  await ctl({ delayMs: 900 }); // red lenta para poder observar el estado intermedio
  await quickSave(page, 200, 'café en Starbucks');
  const first = await page.textContent('#save-status');
  await ctl({ delayMs: 0 });
  assert(/guardado en el iPhone/i.test(first), `Estado inicial inesperado: ${first}`);
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'synced', null, { timeout: 10000 });
  const s = await sheet();
  const row = s.Gastos.find(r => r[3] === 'café en Starbucks');
  assert(row && row[2] === 200 && row[5] === 'Comida', 'No está en Sheets con monto/categoría correctos');
  assert(await page.textContent('#save-status') === '✓ Confirmado por Google Sheets', 'No muestra la confirmación de Sheets');
  const btnText = await page.textContent('#btn-save');
  assert(btnText === '✓ Confirmado en Sheets', `El botón no confirma: ${btnText}`);
  return `botón: "✓ En el iPhone · enviando…" → "${btnText}"; en Sheets: $${row[2]} · ${row[3]} · ${row[5]}`;
});

// ───────────── 3. Recorrido offline ─────────────
await test('Offline: 2 gastos sin internet → cerrar → reabrir sin internet → volver internet → llegan a Sheets exactamente una vez', async () => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
  const before = (await sheet()).Gastos.length;

  await ctx.setOffline(true);
  await page.waitForFunction(() => !navigator.onLine);
  await quickSave(page, 85, 'uber al trabajo');
  assert(/se enviará a Sheets al volver internet/i.test(await page.textContent('#save-status')), 'No indica guardado local');
  await quickSave(page, 120, 'tacos');
  const pill = await page.textContent('#sync-pill');
  assert(/Sin internet · 2 en iPhone/.test(pill), `Indicador inesperado: ${pill}`);
  const local = (await idsOnPage(page)).filter(e => ['uber al trabajo', 'tacos'].includes(e.concept));
  assert(local.length === 2, 'No quedaron 2 gastos locales');
  assert((await sheet()).Gastos.length === before, 'Llegó algo a Sheets sin internet');

  await page.close();                                  // cerrar la app
  page = await newIPhonePage(ctx); watch(page);             // reabrir, aún sin internet
  // Playwright-WebKit no permite navegar en modo offline emulado aunque el service worker
  // tenga la app; ahí se reabre con la API de Sheets bloqueada (Chromium sí reabre 100% offline).
  const realOffline = ENGINE !== 'webkit';
  if (!realOffline) { await ctl({ blockApi: true }); await ctx.setOffline(false); }
  await page.goto(`${BASE}/index.html#add`);
  await page.waitForSelector('#view-add:not(.hidden)');
  const badges = await page.$$eval('[data-sync="local"]', els => els.length);
  assert(badges === 2, `Tras reabrir se esperaban 2 pendientes, hay ${badges}`);

  if (realOffline) await ctx.setOffline(false);        // vuelve internet
  else { await ctl({ blockApi: false }); await page.click('#sync-pill'); }
  await waitSynced(page);
  const s = await sheet();
  const counts = local.map(e => countId(s.Gastos, e.id));
  assert(counts.every(c => c === 1), `Conteos en Sheets: ${counts}`);
  assert(s.Gastos.length === before + 2, `Filas nuevas: ${s.Gastos.length - before}`);

  await page.reload(); await waitSynced(page);         // reabrir otra vez: no reenvía
  const s2 = await sheet();
  assert(local.every(e => countId(s2.Gastos, e.id) === 1) && s2.Gastos.length === before + 2, 'Hubo reenvío duplicado');
  return `${realOffline ? 'reapertura 100% offline' : 'reapertura con Sheets inaccesible'}; Sheets: Uber×${counts[0]}, Tacos×${counts[1]}; ${s2.Gastos.length - before} filas nuevas tras 2 reaperturas`;
});

await test('Respuesta perdida: Sheets escribe pero la conexión se corta → reintento → sigue habiendo una sola fila', async () => {
  await watchPill(page);
  const c0 = await ctl({ dropNextResponse: 2 }); // se pierden el envío y el reenvío automático del navegador
  await quickSave(page, 49, 'agua');
  const how = await recoverFromDrop(page);
  const c1 = await ctl({});
  const id = (await idsOnPage(page)).find(e => e.concept === 'agua').id;
  assert(c1.dropped - c0.dropped === 2, 'No se simuló la respuesta perdida');
  assert(countId((await sheet()).Gastos, id) === 1, 'Se duplicó al reintentar');
  return `respuesta perdida tras escribir; ${how}; el servidor recibió ${c1.posts - c0.posts} envíos y hay 1 sola fila`;
});

// ───────────── 4. Metas ─────────────
await test('Meta: la imagen se revela según el ahorro y conserva el progreso al reabrir (abonos sin duplicados)', async () => {
  await page.click('.tab[data-view="goals"]');
  await page.click('#btn-new-goal');
  await page.fill('#g-name', 'Coche');
  await page.fill('#g-target', '10000');
  await page.fill('#g-saved', '2000');
  await page.fill('#g-image', `${BASE}/icons/goal-default.svg`);
  await page.click('#g-save');
  const clip = () => page.$eval('.goal .goal-img.revealed', e => e.style.clipPath);
  assert((await clip()).includes('80'), `clip-path inicial: ${await clip()}`);
  await page.click('[data-contrib]');
  await page.fill('#contrib-amount', '3000');
  await page.click('#contrib-save');
  assert((await clip()).includes('50'), `clip-path tras abonar: ${await clip()}`);
  await waitSynced(page);

  await watchPill(page);
  await ctl({ dropNextResponse: 1 });                  // abono con respuesta perdida
  await page.click('[data-contrib]');
  await page.fill('#contrib-amount', '1000');
  await page.click('#contrib-save');
  await recoverFromDrop(page);

  await page.close(); page = await newIPhonePage(ctx); watch(page);
  await page.goto(`${BASE}/index.html#goals`);
  await page.waitForSelector('.goal');
  await page.waitForFunction(() => document.querySelector('#sync-pill').dataset.state === 'ok');
  const pct = await page.$eval('.goal', e => e.dataset.pct);
  const s = await sheet();
  const goal = s.Metas.find(r => r[1] === 'Coche');
  assert(goal[3] === 6000, `Ahorrado en Sheets: ${goal[3]} (esperado 6000)`);
  assert(pct === '60.0', `Progreso tras reabrir: ${pct}%`);
  assert(s.Abonos.length === 2, `Abonos registrados: ${s.Abonos.length}`);
  return `20% → 50% → 60%; Sheets: $${goal[3]} ahorrado, ${s.Abonos.length} abonos; clip-path ${await clip()}`;
});

// ───────────── 5. Foto y voz ─────────────
await test('Foto ambigua: no rellena el monto, pide revisión y no guarda hasta que lo confirmes', async () => {
  await ctl({ visionFixture: { amount: 0, amount_legible: false, merchant: 'OXXO', date: '', concept: 'Compra en OXXO', category: 'Súper', confidence: 'baja', issues: ['Aparecen dos montos (152.00 y 125.00) y no está claro cuál es el total'] } });
  await page.goto(`${BASE}/index.html#add`);
  await page.click('.seg[data-mode="photo"]');
  await page.setInputFiles('#in-photo', path.join(path.dirname(OUT), '..', 'icons', 'icon-512.png'));
  await page.waitForSelector('#review-card:not(.hidden).warn');
  assert(await page.inputValue('#in-amount') === '', 'Rellenó un monto dudoso');
  assert(await page.textContent('#btn-save') === 'Confirmar y registrar', 'El botón no pide confirmación');
  const issues = await page.textContent('#review-issues');
  const before = (await sheet()).Gastos.length;
  await page.click('#btn-save');
  assert(/Falta el monto/.test(await page.textContent('#save-status')), 'No bloqueó el guardado sin monto');
  assert((await sheet()).Gastos.length === before, 'Guardó sin monto');
  await page.screenshot({ path: path.join(OUT, '04-foto-revision.png') });
  await page.fill('#in-amount', '152');
  await page.click('#btn-save');
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'synced', null, { timeout: 10000 });
  const row = (await sheet()).Gastos.at(-1);
  assert(row[2] === 152 && row[4] === 'OXXO' && row[6] === 'foto' && row[8] === 'foto: corregido', `Fila: ${JSON.stringify(row)}`);
  return `avisos mostrados: ${issues.replace(/\s+/g, ' ').trim()}; guardado tras corregir: $152 · OXXO · "foto: corregido"`;
});

await test('Foto clara: rellena monto, comercio y fecha; todo editable antes de guardar', async () => {
  await ctl({ visionFixture: { amount: 487.5, amount_legible: true, merchant: 'Walmart Express', date: '2026-11-18', concept: 'Despensa', category: 'Súper', confidence: 'alta', issues: [] } });
  await page.setInputFiles('#in-photo', path.join(path.dirname(OUT), '..', 'icons', 'icon-512.png'));
  await page.waitForSelector('#review-card:not(.hidden):not(.warn)');
  assert(await page.inputValue('#in-amount') === '487.5', 'Monto no rellenado');
  assert(await page.inputValue('#in-date') === '2026-11-18', 'Fecha no rellenada');
  await page.fill('#in-concept', 'Despensa semanal');
  await page.click('#btn-save');
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'synced', null, { timeout: 10000 });
  const row = (await sheet()).Gastos.at(-1);
  assert(row[3] === 'Despensa semanal' && row[8] === 'foto: corregido', `Fila: ${JSON.stringify(row)}`);
  const calls = (await ctl({})).visionCalls;
  assert(calls.at(-1).model === 'claude-opus-5-5' && calls.at(-1).hasImage, 'Llamada a visión inesperada');
  return `concepto corregido a mano; modelo solicitado: ${calls.at(-1).model}`;
});

await test('Voz (reconocimiento simulado): interpreta "doscientos cincuenta en tacos" y deja corregir antes de guardar', async () => {
  const p2 = await newIPhonePage(ctx); watch(p2);
  await p2.addInitScript(() => {
    window.webkitSpeechRecognition = class {
      start() { setTimeout(() => { this.onresult?.({ results: [Object.assign([{ transcript: 'doscientos cincuenta en tacos' }], { isFinal: true })] }); this.onend?.(); }, 50); }
      stop() { this.onend?.(); }
    };
  });
  await p2.goto(`${BASE}/index.html#add`);
  await p2.click('.seg[data-mode="voice"]');
  await p2.click('#btn-mic');
  await p2.waitForSelector('#review-card:not(.hidden)');
  assert(await p2.inputValue('#in-amount') === '250' && await p2.inputValue('#in-concept') === 'Tacos', 'Interpretación incorrecta');
  await p2.fill('#in-amount', '260');
  await p2.click('#btn-save');
  await p2.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'synced', null, { timeout: 10000 });
  const row = (await sheet()).Gastos.at(-1);
  assert(row[2] === 260 && row[6] === 'voz' && row[8] === 'voz: corregido', `Fila: ${JSON.stringify(row)}`);
  await p2.close();
  return 'interpretado $250 · Tacos → corregido a $260 → en Sheets';
});

// ───────────── 2. Atajo (API) ─────────────
await test('Atajo: vista previa no escribe; confirmar escribe una vez; repetir no duplica; sin monto no guarda', async () => {
  const before = (await sheet()).Gastos.length;
  const prev = await api('quickAdd', { text: '200 pesos en café', dryRun: true });
  assert(prev.status === 'preview' && prev.review === '$200 · Café · Comida' && prev.editText === '200 Café' && prev.id, JSON.stringify(prev));
  assert((await sheet()).Gastos.length === before, 'La vista previa escribió');
  const c1 = await api('quickAdd', { text: prev.editText, id: prev.id });
  const c2 = await api('quickAdd', { text: prev.editText, id: prev.id });
  assert(c1.status === 'saved' && c2.status === 'saved', 'No confirmó');
  assert(countId((await sheet()).Gastos, prev.id) === 1, 'Duplicado');
  const bad = await api('quickAdd', { text: 'café', dryRun: true });
  assert(bad.status === 'error', 'Aceptó texto sin monto');
  const badTok = await fetch(`${BASE}/__api`, { method: 'POST', redirect: 'follow', body: JSON.stringify({ token: 'x', action: 'quickAdd', payload: { text: '10 x', id: 'z' } }) }).then(r => r.json());
  assert(badTok.status === 'error' && countId((await sheet()).Gastos, 'z') === 0, 'Token inválido aceptado');
  return `mensaje: "${c1.message}"`;
});

// ───────────── 6. Banner semanal ─────────────
await test('Banner semanal con presupuesto restante', async () => {
  await page.goto(`${BASE}/index.html#add`);
  await page.waitForSelector('#weekly-banner:not(.hidden)');
  return (await page.textContent('#weekly-text')).trim();
});

await test('Sin errores de JavaScript durante todo el recorrido', async () => {
  assert(consoleErrors.length === 0, consoleErrors.join(' | '));
});

// ───────────── Capturas tamaño iPhone (datos de ejemplo) ─────────────
await ctx.close();
await ctl({ reset: true, seed: true });
ctx = await browser.newContext(IPHONE);
page = await newIPhonePage(ctx);
await page.goto(`${BASE}/index.html${setupHash}`);
await page.waitForFunction(() => document.querySelector('#sync-pill').dataset.state === 'ok');
await page.waitForTimeout(3000); // deja que desaparezca el aviso "App configurada"
await page.screenshot({ path: path.join(OUT, '01-registro-banner.png') });
await page.click('#weekly-close');
await page.fill('#in-amount', '200');
await page.fill('#in-concept', 'café en Starbucks');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT, '01-registro.png') });
await page.click('#btn-save');
await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'synced');
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, '01-registro-confirmado.png') });
await page.waitForTimeout(2800);
await page.click('.tab[data-view="dash"]');
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(OUT, '02-resumen.png') });
await page.screenshot({ path: path.join(OUT, '02-resumen-completo.png'), fullPage: true });
await page.click('.tab[data-view="goals"]');
await page.waitForFunction(() => [...document.querySelectorAll('.goal-img')].length >= 4);
await page.waitForTimeout(2500); // carga de imágenes y animación de revelado
await page.screenshot({ path: path.join(OUT, '03-metas.png') });
await ctx.setOffline(true);
await page.click('.tab[data-view="add"]');
await page.fill('#in-amount', '85');
await page.fill('#in-concept', 'uber');
await page.click('#btn-save');
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, '05-offline-guardado-local.png') });

await browser.close();
server.close();

const passed = results.filter(r => r.ok).length;
const md = [`# Resultados (${ENGINE} ${new Date().toISOString().slice(0, 16).replace('T', ' ')})`, '', `**${passed}/${results.length} pruebas superadas**`, '',
  '| | Prueba | Detalle |', '|---|---|---|', ...results.map(r => `| ${r.ok ? '✅' : '❌'} | ${r.name} | ${r.note.replace(/\|/g, '/')} |`)].join('\n');
fs.writeFileSync(path.join(OUT, `results-${ENGINE}.md`), md + '\n');
console.log(`\n${passed}/${results.length} superadas · capturas en tests/output/`);
process.exit(passed === results.length ? 0 : 1);
