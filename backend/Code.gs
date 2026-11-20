/**
 * NEST Finanzas — API sobre Google Sheets (Google Apps Script)
 *
 * Hojas que crea setup():
 *   Gastos      → ID | Fecha | Monto | Concepto | Comercio | Categoría | Método | Creado | Revisión
 *   Categorias  → Categoría | Emoji | Palabras clave | Presupuesto
 *   Metas       → ID | Nombre | Objetivo | Ahorrado | Imagen | Fecha límite | Creado
 *   Abonos      → ID | Meta | Monto | Fecha            (registro de abonos; evita duplicados)
 *   Config      → Clave | Valor
 *   Vision      → Fecha | Modelo | Segundos | Tokens entrada | Tokens salida | Costo USD | Confianza | Problemas
 *
 * Propiedades del script (Configuración del proyecto → Propiedades del script):
 *   APP_TOKEN          → contraseña compartida con la PWA y el Atajo (setup() la genera)
 *   ANTHROPIC_API_KEY  → clave de la API de Claude para leer tickets (opcional)
 *   CLAUDE_MODEL       → opcional; por defecto claude-opus-5-5
 */

const API_VERSION = 2;

const SHEETS = {
  gastos: { name: 'Gastos', headers: ['ID', 'Fecha', 'Monto', 'Concepto', 'Comercio', 'Categoría', 'Método', 'Creado', 'Revisión'] },
  categorias: { name: 'Categorias', headers: ['Categoría', 'Emoji', 'Palabras clave', 'Presupuesto'] },
  metas: { name: 'Metas', headers: ['ID', 'Nombre', 'Objetivo', 'Ahorrado', 'Imagen', 'Fecha límite', 'Creado'] },
  abonos: { name: 'Abonos', headers: ['ID', 'Meta', 'Monto', 'Fecha'] },
  config: { name: 'Config', headers: ['Clave', 'Valor'] },
  vision: { name: 'Vision', headers: ['Fecha', 'Modelo', 'Segundos', 'Tokens entrada', 'Tokens salida', 'Costo USD', 'Confianza', 'Problemas'] },
};

// USD por millón de tokens (entrada, salida) — para estimar el costo real por ticket
const PRICES = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};

const DEFAULT_CATEGORIES = [
  ['Comida', '🍽️', 'restaurante,comida,cena,desayuno,almuerzo,tacos,pizza,sushi,hamburguesa,rappi,uber eats,didi food,cafe,café,starbucks,panaderia,antojo', 4000],
  ['Súper', '🛒', 'super,súper,walmart,soriana,chedraui,costco,sams,oxxo,7 eleven,heb,la comer,mercado,despensa', 5000],
  ['Transporte', '🚗', 'uber,didi,taxi,gasolina,gas,metro,camion,autobus,estacionamiento,caseta,peaje,cabify,pemex', 2500],
  ['Hogar', '🏠', 'renta,luz,cfe,agua,internet,telmex,izzi,totalplay,mantenimiento,limpieza,muebles', 9000],
  ['Suscripciones', '📺', 'netflix,spotify,disney,hbo,max,prime,amazon prime,icloud,apple,youtube,chatgpt,claude,suscripcion', 800],
  ['Salud', '💊', 'farmacia,doctor,medico,médico,consulta,hospital,dentista,gimnasio,gym,similares,benavides', 1500],
  ['Compras', '🛍️', 'amazon,mercado libre,liverpool,zara,ropa,zapatos,shein,palacio,tienda', 2000],
  ['Ocio', '🎉', 'cine,cinepolis,bar,fiesta,concierto,boletos,viaje,hotel,airbnb,juego,steam,playstation', 2000],
  ['Educación', '📚', 'curso,libro,escuela,colegiatura,udemy,platzi,clase', 1000],
  ['Otros', '✨', '', 1000],
];

const DEFAULT_CONFIG = [
  ['presupuesto_mensual', 25000],
  ['moneda', 'MXN'],
  ['locale', 'es-MX'],
];

// ─────────────────────────────── Configuración inicial ───────────────────────────────

/** Ejecuta esta función desde el editor. Es segura de repetir: solo crea lo que falte. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.values(SHEETS).forEach(def => {
    let sh = ss.getSheetByName(def.name);
    if (!sh) sh = ss.insertSheet(def.name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers])
        .setFontWeight('bold').setBackground('#111827').setFontColor('#ffffff');
      sh.setFrozenRows(1);
    } else if (sh.getLastColumn() < def.headers.length) {
      // Añade columnas nuevas de versiones posteriores sin tocar los datos
      sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
    }
  });

  const cat = ss.getSheetByName(SHEETS.categorias.name);
  if (cat.getLastRow() === 1) cat.getRange(2, 1, DEFAULT_CATEGORIES.length, 4).setValues(DEFAULT_CATEGORIES);

  const cfg = ss.getSheetByName(SHEETS.config.name);
  if (cfg.getLastRow() === 1) cfg.getRange(2, 1, DEFAULT_CONFIG.length, 2).setValues(DEFAULT_CONFIG);

  ss.getSheetByName(SHEETS.gastos.name).getRange('B:B').setNumberFormat('yyyy-mm-dd');
  ss.getSheetByName(SHEETS.gastos.name).getRange('C:C').setNumberFormat('$#,##0.00');
  ss.getSheetByName(SHEETS.metas.name).getRange('C:D').setNumberFormat('$#,##0.00');
  ss.getSheetByName(SHEETS.abonos.name).getRange('C:C').setNumberFormat('$#,##0.00');

  const blank = ss.getSheetByName('Hoja 1') || ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('APP_TOKEN')) props.setProperty('APP_TOKEN', Utilities.getUuid().replace(/-/g, '').slice(0, 16));
  Logger.log('APP_TOKEN: ' + props.getProperty('APP_TOKEN') + '  ← cópialo en la app (Ajustes) y en el Atajo');
}

// ─────────────────────────────── Router HTTP ───────────────────────────────

function doGet(e) {
  return handle_(() => {
    const action = e.parameter.action || 'bootstrap';
    if (action === 'bootstrap') return bootstrap_(Number(e.parameter.days || 120));
    if (action === 'ping') return { version: API_VERSION };
    throw new Error('Acción GET desconocida: ' + action);
  }, e.parameter.token);
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, status: 'error', message: 'JSON inválido', error: 'JSON inválido' }); }
  return handle_(() => {
    const p = body.payload || {};
    switch (body.action) {
      case 'addExpenses': return addExpenses_(p.expenses || []);
      case 'quickAdd': return quickAdd_(p);
      case 'deleteExpense': return deleteExpense_(p.id);
      case 'parseReceipt': return parseReceipt_(p.image, p.mediaType);
      case 'saveGoal': return saveGoal_(p);
      case 'contributeGoal': return contributeGoal_(p.id, Number(p.amount), p.opId);
      case 'deleteGoal': return deleteGoal_(p.id);
      case 'setConfig': return setConfig_(p);
      default: throw new Error('Acción desconocida: ' + body.action);
    }
  }, body.token);
}

/**
 * Respuesta: { ok, data, error }. Para el Atajo de iOS también se copian
 * status/message a primer nivel (más fácil de leer en Atajos).
 */
function handle_(fn, token) {
  try {
    const expected = PropertiesService.getScriptProperties().getProperty('APP_TOKEN');
    if (!expected || token !== expected) return json_({ ok: false, status: 'error', message: 'Token inválido', error: 'No autorizado' });
    const data = fn();
    const out = { ok: true, data };
    if (data && data.status) {
      out.status = data.status; out.message = data.message || '';
      ['id', 'review', 'editText'].forEach(k => { if (data[k] !== undefined) out[k] = data[k]; });
    }
    return json_(out);
  } catch (err) {
    const msg = String((err && err.message) || err);
    return json_({ ok: false, status: 'error', message: msg, error: msg });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_(key) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS[key].name);
}

function rows_(key) {
  const sh = sheet_(key);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, SHEETS[key].headers.length).getValues();
}

function findRow_(key, id) {
  const cell = sheet_(key).getRange('A:A').createTextFinder(String(id)).matchEntireCell(true).findNext();
  return cell ? cell.getRow() : 0;
}

function iso_(d) {
  if (Object.prototype.toString.call(d) !== '[object Date]' || isNaN(d.getTime())) return /^\d{4}-\d{2}-\d{2}/.test(String(d || '')) ? String(d).slice(0, 10) : '';
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ─────────────────────────────── Lectura ───────────────────────────────

function bootstrap_(days) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceISO = iso_(since);

  const expenses = rows_('gastos')
    .filter(r => r[0] && iso_(r[1]) >= sinceISO)
    .map(r => ({
      id: String(r[0]), date: iso_(r[1]), amount: Number(r[2]) || 0, concept: r[3],
      merchant: r[4], category: r[5], method: r[6], review: r[8] || '',
    }));

  const categories = rows_('categorias').filter(r => r[0]).map(r => ({
    name: r[0], emoji: r[1], keywords: String(r[2] || '').split(',').map(s => s.trim()).filter(Boolean), budget: Number(r[3]) || 0,
  }));

  const goals = rows_('metas').filter(r => r[0]).map(r => ({
    id: String(r[0]), name: r[1], target: Number(r[2]) || 0, saved: Number(r[3]) || 0, image: r[4], deadline: iso_(r[5]),
  }));

  const config = {};
  rows_('config').forEach(r => { if (r[0]) config[r[0]] = r[1]; });

  return { version: API_VERSION, expenses, categories, goals, config, serverTime: new Date().toISOString() };
}

// ─────────────────────────────── Gastos ───────────────────────────────

/**
 * Inserta gastos de forma idempotente: si un ID ya existe, no lo duplica.
 * Responde solo con los IDs que quedaron escritos y verificados en la hoja.
 */
function addExpenses_(list) {
  return withLock_(() => {
    const sh = sheet_('gastos');
    const existing = new Set(rows_('gastos').map(r => String(r[0])));
    const categories = rows_('categorias');
    const now = new Date();
    const toInsert = [];
    const rejected = [];
    const wanted = [];

    (list || []).forEach(x => {
      if (!x || !x.id) return;
      const id = String(x.id);
      if (existing.has(id)) { wanted.push(id); return; }
      const amount = Math.round(Number(x.amount) * 100) / 100;
      if (!(amount > 0) || amount > 10000000) { rejected.push({ id, reason: 'Monto inválido' }); return; }
      const category = x.category || categorize_(`${x.concept || ''} ${x.merchant || ''}`, categories);
      toInsert.push([
        id,
        /^\d{4}-\d{2}-\d{2}$/.test(String(x.date)) ? new Date(x.date + 'T12:00:00') : now,
        amount,
        String(x.concept || '').slice(0, 200),
        String(x.merchant || '').slice(0, 120),
        category,
        x.method || 'texto',
        now,
        x.review || '',
      ]);
      existing.add(id);
      wanted.push(id);
    });

    if (toInsert.length) {
      sh.getRange(sh.getLastRow() + 1, 1, toInsert.length, toInsert[0].length).setValues(toInsert);
      SpreadsheetApp.flush();
    }
    // Verificación: relee la columna de IDs y confirma solo lo que realmente está escrito
    const written = new Set(rows_('gastos').map(r => String(r[0])));
    return { saved: wanted.filter(id => written.has(id)), rejected };
  });
}

function deleteExpense_(id) {
  return withLock_(() => {
    const row = findRow_('gastos', id);
    if (row) sheet_('gastos').deleteRow(row);
    return { deleted: true };
  });
}

/** Interpreta "200 pesos en café", "uber 85.50", "$1,250 walmart", "1.2k gasolina". */
function parseText_(text) {
  const raw = String(text || '').trim();
  const m = raw.match(/\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)\s*(k|mil)?(?![\w])/i);
  if (!m) return null;
  let n = m[1];
  n = /^\d{1,3}(,\d{3})+/.test(n) ? n.replace(/,/g, '') : n.replace(',', '.');
  const amount = Math.round(parseFloat(n) * (m[2] ? 1000 : 1) * 100) / 100;
  const filler = ['peso', 'pesos', 'mxn', 'en', 'de', 'del', 'por', 'para', 'un', 'una', 'el', 'la', 'los', 'las', 'gaste', 'pague', 'compre', 'me', 'y'];
  let concept = raw.replace(m[0], ' ').split(/\s+/)
    .filter(w => w && filler.indexOf(normalize_(w).replace(/[.,!?]/g, '')) < 0).join(' ');
  concept = concept ? concept.charAt(0).toUpperCase() + concept.slice(1) : 'Gasto';
  return amount > 0 ? { amount, concept } : null;
}

/**
 * Atajo de iOS (Botón de Acción). Dos pasos:
 *  1) { text, dryRun: true }       → status "preview": interpreta, NO escribe nada.
 *  2) { text, id, confirm: true }   → status "saved" solo si la fila quedó en la hoja.
 * Reintentar el paso 2 con el mismo id nunca duplica el gasto.
 */
function quickAdd_(p) {
  const parsed = parseText_(p.text);
  if (!parsed) return { status: 'error', message: 'No encontré el monto en "' + String(p.text || '') + '". No se guardó nada.' };
  const category = categorize_(parsed.concept, rows_('categorias'));
  const money = v => '$' + (Math.round(v * 100) / 100).toLocaleString('en-US');

  if (p.dryRun) {
    return {
      status: 'preview',
      id: Utilities.getUuid(),
      amount: parsed.amount, concept: parsed.concept, category,
      review: `${money(parsed.amount)} · ${parsed.concept} · ${category}`,
      editText: `${parsed.amount} ${parsed.concept}`,
      message: 'Revisa antes de guardar',
    };
  }

  if (!p.id) return { status: 'error', message: 'Falta el id de la vista previa. No se guardó nada.' };
  const result = addExpenses_([{ id: p.id, amount: parsed.amount, concept: parsed.concept, category, method: 'atajo' }]);
  if (result.saved.indexOf(String(p.id)) < 0) return { status: 'error', message: 'Sheets no confirmó el registro. No se guardó.' };

  const ym = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  const spent = rows_('gastos').filter(r => iso_(r[1]).indexOf(ym) === 0).reduce((s, r) => s + (Number(r[2]) || 0), 0);
  const cfg = {}; rows_('config').forEach(r => { cfg[r[0]] = r[1]; });
  const remaining = (Number(cfg.presupuesto_mensual) || 0) - spent;

  return {
    status: 'saved', id: p.id, amount: parsed.amount, concept: parsed.concept, category, remaining,
    message: `✓ En Sheets: ${money(parsed.amount)} · ${parsed.concept} (${category}). Te quedan ${money(Math.round(remaining))} este mes.`,
  };
}

/** Clasificación por palabras clave (misma lógica que la app). */
function categorize_(text, categories) {
  const t = normalize_(text);
  let best = 'Otros', bestLen = 0;
  categories.forEach(r => {
    String(r[2] || '').split(',').map(k => normalize_(k.trim())).filter(Boolean).forEach(k => {
      if (k.length > bestLen && new RegExp('(^|\\W)' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\W|$)').test(t)) {
        best = r[0]; bestLen = k.length;
      }
    });
  });
  return best;
}

function normalize_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ─────────────────────────────── Visión (tickets y capturas) ───────────────────────────────

/**
 * Envía la imagen a Claude y devuelve los datos para que el usuario los REVISE.
 * Nunca inventa: si algo no se lee, lo marca (amount_legible=false, campos vacíos, issues).
 * Apps Script no tiene SDK oficial de Anthropic, así que se usa HTTP directo.
 */
function parseReceipt_(base64, mediaType) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('Falta ANTHROPIC_API_KEY en las propiedades del script');
  if (!base64) throw new Error('No llegó ninguna imagen');
  const model = props.getProperty('CLAUDE_MODEL') || 'claude-opus-5-5';

  const categoryNames = rows_('categorias').map(r => r[0]).filter(Boolean);
  const body = {
    model,
    max_tokens: 4000,
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            amount: { type: 'number', description: 'Total pagado o transferido. 0 si no se puede leer con certeza.' },
            amount_legible: { type: 'boolean', description: 'true solo si el total es claramente legible y no hay duda de cuál es' },
            merchant: { type: 'string', description: 'Comercio o destinatario tal como aparece. Vacío si no aparece.' },
            date: { type: 'string', description: 'Fecha YYYY-MM-DD tal como aparece. Vacío si no aparece.' },
            concept: { type: 'string', description: 'Descripción corta en español basada solo en lo visible' },
            category: { type: 'string', enum: categoryNames },
            confidence: { type: 'string', enum: ['alta', 'media', 'baja'] },
            issues: { type: 'array', items: { type: 'string' }, description: 'Dudas concretas, en español, máx. 3. Vacío si todo es claro.' },
          },
          required: ['amount', 'amount_legible', 'merchant', 'date', 'concept', 'category', 'confidence', 'issues'],
          additionalProperties: false,
        },
      },
    },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 } },
        {
          type: 'text',
          text: 'La imagen debería ser un ticket de compra o una captura de transferencia bancaria (México). ' +
            'Extrae el TOTAL pagado (no subtotal, propina por separado, saldo disponible ni límite de crédito), ' +
            'el comercio o destinatario, la fecha y un concepto corto. ' +
            'No inventes ni completes datos: si algo no se ve, está cortado o hay varios montos posibles sin un total claro, ' +
            'deja el campo vacío (o amount=0 y amount_legible=false), baja la confianza y explica la duda en issues. ' +
            'Si la imagen no es un ticket ni una transferencia, amount=0, amount_legible=false y dilo en issues.',
        },
      ],
    }],
  };

  const headers = { 'x-api-key': key, 'anthropic-version': '2026-10-21' };
  // Respaldo automático si el modelo rechaza la solicitud (disponible en Opus 5.5 y Sonnet 5.5)
  if (/^claude-(opus|sonnet)-5-5$/.test(model)) {
    body.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }

  const t0 = Date.now();
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', headers, payload: JSON.stringify(body), muteHttpExceptions: true,
  });
  const seconds = Math.round((Date.now() - t0) / 100) / 10;

  const code = res.getResponseCode();
  const data = JSON.parse(res.getContentText());
  if (code !== 200) throw new Error('Claude API ' + code + ': ' + ((data.error && data.error.message) || 'error'));
  if (data.stop_reason === 'refusal') throw new Error('No se pudo analizar la imagen. Captura los datos a mano.');
  if (data.stop_reason === 'max_tokens') throw new Error('Respuesta incompleta, intenta de nuevo');
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('Respuesta vacía del modelo');

  const r = JSON.parse(textBlock.text);
  const usage = data.usage || {};
  const price = PRICES[data.model] || PRICES[model] || [0, 0];
  const cost = ((usage.input_tokens || 0) * price[0] + (usage.output_tokens || 0) * price[1]) / 1e6;
  try {
    sheet_('vision').appendRow([new Date(), data.model || model, seconds, usage.input_tokens || 0, usage.output_tokens || 0,
      Math.round(cost * 100000) / 100000, r.confidence, (r.issues || []).join(' | ')]);
  } catch (err) { /* el registro es informativo; no debe romper la lectura */ }

  r.needsReview = !r.amount_legible || !(r.amount > 0) || r.confidence !== 'alta' || (r.issues || []).length > 0 || !r.date;
  r.seconds = seconds;
  r.model = data.model || model;
  return r;
}

// ─────────────────────────────── Metas ───────────────────────────────

function saveGoal_(g) {
  return withLock_(() => {
    const sh = sheet_('metas');
    const id = String(g.id || Utilities.getUuid());
    const row = findRow_('metas', id);
    const values = [id, String(g.name || '').slice(0, 80), Number(g.target) || 0, Number(g.saved) || 0, g.image || '',
      g.deadline ? new Date(g.deadline + 'T12:00:00') : ''];
    if (row) sh.getRange(row, 1, 1, 6).setValues([values]);
    else sh.appendRow(values.concat([new Date()]));
    return { id };
  });
}

/** Abono idempotente: cada abono lleva opId; si ya se aplicó, no se vuelve a sumar. */
function contributeGoal_(id, amount, opId) {
  return withLock_(() => {
    const row = findRow_('metas', id);
    if (!row) throw new Error('Meta no encontrada');
    const savedCell = sheet_('metas').getRange(row, 4);
    if (opId && findRow_('abonos', opId)) return { id, saved: Number(savedCell.getValue()) || 0, duplicate: true };
    const saved = Math.max(0, (Number(savedCell.getValue()) || 0) + (Number(amount) || 0));
    savedCell.setValue(saved);
    sheet_('abonos').appendRow([opId || Utilities.getUuid(), id, Number(amount) || 0, new Date()]);
    SpreadsheetApp.flush();
    return { id, saved };
  });
}

function deleteGoal_(id) {
  return withLock_(() => {
    const row = findRow_('metas', id);
    if (row) sheet_('metas').deleteRow(row);
    return { deleted: true };
  });
}

// ─────────────────────────────── Config ───────────────────────────────

function setConfig_(obj) {
  return withLock_(() => {
    const sh = sheet_('config');
    const data = rows_('config');
    Object.keys(obj || {}).forEach(k => {
      const idx = data.findIndex(r => r[0] === k);
      if (idx >= 0) sh.getRange(idx + 2, 2).setValue(obj[k]);
      else { sh.appendRow([k, obj[k]]); data.push([k, obj[k]]); }
    });
    return { ok: true };
  });
}
