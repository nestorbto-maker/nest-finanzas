// Simulador local de Google Apps Script + Google Sheets.
// Ejecuta el backend/Code.gs REAL dentro de Node con servicios falsos (SpreadsheetApp, LockService, …)
// y sirve la PWA en el mismo origen. Imita el redirect 302 de Apps Script.
//
//   node tests/mock-gas.mjs [puerto]   → http://localhost:8787/index.html
//   API:      /__api                    (equivalente a .../exec)
//   Control:  GET /__sheet · POST /__control { reset, seed, dropNextResponse, visionFixture, delayMs }

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TOKEN = 'test-token';

// ───────────── Hoja de cálculo falsa ─────────────
class FakeRange {
  constructor(sheet, row, col, nRows, nCols) { Object.assign(this, { sheet, row, col, nRows, nCols }); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nRows; r++) {
      const src = this.sheet.data[this.row - 1 + r] || [];
      out.push(Array.from({ length: this.nCols }, (_, c) => src[this.col - 1 + c] ?? ''));
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(vals) {
    vals.forEach((rowVals, r) => {
      const idx = this.row - 1 + r;
      this.sheet.data[idx] ||= [];
      rowVals.forEach((v, c) => { this.sheet.data[idx][this.col - 1 + c] = v; });
    });
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  createTextFinder(text) {
    const range = this;
    let entire = false;
    return {
      matchEntireCell(b) { entire = b; return this; },
      findNext() {
        const vals = range.getValues();
        for (let r = 0; r < vals.length; r++) for (let c = 0; c < vals[r].length; c++) {
          const s = String(vals[r][c]);
          if (entire ? s === String(text) : s.includes(String(text))) return { getRow: () => range.row + r };
        }
        return null;
      },
    };
  }
  setFontWeight() { return this; } setBackground() { return this; } setFontColor() { return this; } setNumberFormat() { return this; }
}

class FakeSheet {
  constructor(name) { this.name = name; this.data = []; }
  getName() { return this.name; }
  getLastRow() { let n = this.data.length; while (n && !(this.data[n - 1] || []).some(v => v !== '' && v != null)) n--; return n; }
  getLastColumn() { return Math.max(0, ...this.data.map(r => r.length)); }
  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const [s, e] = a.split(':').map(x => x.charCodeAt(0) - 64);
      return new FakeRange(this, 1, s, Math.max(1, this.getLastRow()), e - s + 1);
    }
    return new FakeRange(this, a, b, c || 1, d || 1);
  }
  appendRow(vals) { this.data[this.getLastRow()] = [...vals]; return this; }
  deleteRow(r) { this.data.splice(r - 1, 1); }
  setFrozenRows() { return this; }
}

function createWorld() {
  const sheets = new Map();
  const props = new Map([['APP_TOKEN', TOKEN], ['ANTHROPIC_API_KEY', 'sk-test']]);
  const control = { visionFixture: null, visionCalls: [] };
  const fmtDate = (d, f) => {
    const p = n => String(n).padStart(2, '0');
    return f.replace('yyyy', d.getFullYear()).replace('MM', p(d.getMonth() + 1)).replace('dd', p(d.getDate()));
  };
  const ss = {
    getSheetByName: n => sheets.get(n) || null,
    insertSheet: n => { const s = new FakeSheet(n); sheets.set(n, s); return s; },
    getSheets: () => [...sheets.values()],
    deleteSheet: s => sheets.delete(s.name),
  };
  const context = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush: () => {} },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ content: s, setMimeType() { return this; } }) },
    Utilities: { getUuid: () => crypto.randomUUID(), formatDate: (d, tz, f) => fmtDate(d, f) },
    Session: { getScriptTimeZone: () => 'America/Mexico_City' },
    Logger: { log: () => {} },
    UrlFetchApp: {
      fetch: (url, opts) => {
        const body = JSON.parse(opts.payload);
        control.visionCalls.push({ url, model: body.model, headers: opts.headers, hasImage: body.messages[0].content[0].type === 'image' });
        const fx = control.visionFixture || { amount: 0, amount_legible: false, merchant: '', date: '', concept: '', category: 'Otros', confidence: 'baja', issues: ['Sin fixture'] };
        const resp = { model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(fx) }], usage: { input_tokens: 1900, output_tokens: 260 } };
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(resp) };
      },
    },
    console,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'backend/Code.gs'), 'utf8'), context, { filename: 'Code.gs' });
  context.setup();
  return { context, sheets, control };
}

let world = createWorld();

function seed() {
  const D = vm.runInContext('Date', world.context); // fechas del mismo "realm" que Code.gs, como en Sheets
  const g = world.sheets.get('Gastos');
  const items = [
    ['Café Starbucks', 'Starbucks', 'Comida', 89], ['Uber', 'Uber', 'Transporte', 132], ['Súper semanal', 'Walmart', 'Súper', 1240],
    ['Tacos', 'El Califa', 'Comida', 210], ['Gasolina', 'Pemex', 'Transporte', 850], ['Netflix', 'Netflix', 'Suscripciones', 299],
    ['Farmacia', 'Similares', 'Salud', 180], ['Cine', 'Cinépolis', 'Ocio', 320], ['Rappi cena', 'Rappi', 'Comida', 365],
    ['Café', 'Starbucks', 'Comida', 75], ['Spotify', 'Spotify', 'Suscripciones', 129], ['Renta', '', 'Hogar', 8500],
    ['Oxxo', 'Oxxo', 'Súper', 64], ['Libro', 'Gandhi', 'Educación', 349], ['Uber', 'Uber', 'Transporte', 98],
  ];
  const today = new D();
  const rows = [];
  for (let i = 0; i < 38; i++) {
    const it = items[i % items.length];
    const d = new D(today.getTime()); d.setDate(today.getDate() - Math.floor(i * 1.15)); d.setHours(12);
    if (it[0] === 'Renta' && i > 15) continue;
    rows.push([crypto.randomUUID(), d, Math.round(it[3] * (0.85 + ((i * 37) % 30) / 100)), it[0], it[1], it[2], 'texto', d, '']);
  }
  rows.forEach(r => g.appendRow(r));
  const m = world.sheets.get('Metas');
  const dl = new D(today.getFullYear() + 1, 5, 1, 12);
  m.appendRow(['goal-car', 'Mi coche', 280000, 117600, 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=1200&q=70', dl, today]);
  m.appendRow(['goal-trip', 'Viaje a Japón', 60000, 45600, 'https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?w=1200&q=70', '', today]);
}

const control = { dropNext: 0, delayMs: 0, posts: 0, dropped: 0, blockApi: false };
const echoes = new Map();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const readBody = req => new Promise(r => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => r(b)); });
const sendJSON = (res, obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); };

export function startServer(port = 8787) {
  const server = http.createServer(async (req, res) => {
   try {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname === '/__api' || url.pathname === '/__api/echo') {
      if (url.pathname === '/__api/echo') {
        const out = echoes.get(url.searchParams.get('k'));
        echoes.delete(url.searchParams.get('k'));
        return out ? (res.writeHead(200, { 'Content-Type': 'application/json' }), res.end(out)) : sendJSON(res, { ok: false, error: 'echo expirado' }, 404);
      }
      if (control.blockApi) { req.socket.destroy(); return; } // Sheets inaccesible
      if (control.delayMs) await new Promise(r => setTimeout(r, control.delayMs));
      let out;
      if (req.method === 'POST') {
        control.posts++;
        const body = await readBody(req);
        out = world.context.doPost({ postData: { contents: body }, parameter: {} }).content;
      } else {
        out = world.context.doGet({ parameter: Object.fromEntries(url.searchParams) }).content;
      }
      // Falla simulada: el servidor YA escribió en la hoja, pero la respuesta se pierde
      if (req.method === 'POST' && control.dropNext > 0) { control.dropNext--; control.dropped++; req.socket.destroy(); return; }
      // Igual que Apps Script: 302 → URL de "echo" que entrega el resultado
      const k = crypto.randomUUID();
      echoes.set(k, out);
      res.writeHead(302, { Location: `/__api/echo?k=${k}`, 'Access-Control-Allow-Origin': '*' });
      return res.end();
    }

    if (url.pathname === '/__sheet') {
      const dump = {};
      for (const [name, s] of world.sheets) dump[name] = s.data.slice(1).filter(r => r.some(v => v !== ''));
      return sendJSON(res, dump);
    }
    if (url.pathname === '/__control' && req.method === 'POST') {
      const c = JSON.parse(await readBody(req) || '{}');
      if (c.reset) { world = createWorld(); control.dropNext = 0; control.delayMs = 0; control.blockApi = false; }
      if (c.seed) seed();
      if ('dropNextResponse' in c) control.dropNext = Number(c.dropNextResponse);
      if ('delayMs' in c) control.delayMs = Number(c.delayMs);
      if ('blockApi' in c) control.blockApi = !!c.blockApi;
      if ('visionFixture' in c) world.control.visionFixture = c.visionFixture;
      return sendJSON(res, { ok: true, visionCalls: world.control.visionCalls, posts: control.posts, dropped: control.dropped });
    }

    // Archivos estáticos de la PWA
    let file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
   } catch (err) { console.error('[simulador]', err); try { res.writeHead(500); res.end(String(err)); } catch {} }
  });
  server.on('clientError', (err, sock) => sock.destroy());
  return new Promise(r => server.listen(port, () => r(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.argv[2] || 8787);
  await startServer(port);
  if (process.argv.includes('--seed')) seed();
  console.log(`Simulador listo: http://localhost:${port}/index.html  ·  API: http://localhost:${port}/__api  ·  token: ${TOKEN}`);
}
