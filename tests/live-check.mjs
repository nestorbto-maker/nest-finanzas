// Verificación rápida de la app publicada (sin backend): carga, recursos, service worker y arranque offline.
//   node tests/live-check.mjs [url]
import { chromium, webkit } from 'playwright';

const URL_APP = process.argv[2] || 'https://nestorbto-maker.github.io/nest-finanzas/';
const IPHONE = { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'es-MX' };
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '✅' : '❌'} ${msg}`); if (!ok) failures++; };

for (const [name, type] of [['webkit', webkit], ['chromium', chromium]]) {
  const browser = await type.launch();
  const ctx = await browser.newContext(IPHONE);
  const page = await ctx.newPage();
  const bad = [], errors = [];
  page.on('response', r => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(URL_APP + '#add');
  await page.waitForSelector('#view-add:not(.hidden)');
  check(await page.textContent('#screen-title') === 'Registrar', `[${name}] abre en Registrar`);
  const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]').href)).json());
  check(manifest.start_url === './index.html#add' && manifest.display === 'standalone', `[${name}] manifest: start_url ${manifest.start_url}, display ${manifest.display}`);
  const icon = await page.evaluate(async () => (await fetch(document.querySelector('link[rel=apple-touch-icon]').href)).status);
  check(icon === 200, `[${name}] ícono de pantalla de inicio (HTTP ${icon})`);
  check(await page.evaluate(() => !!window.Chart), `[${name}] Chart.js local cargado`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  const controlled = await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 }).then(() => true, () => false);
  check(controlled, `[${name}] service worker activo`);
  const cached = await page.evaluate(async () => (await (await caches.open((await caches.keys())[0])).keys()).length);
  check(cached >= 15, `[${name}] ${cached} archivos guardados para uso offline`);
  if (name === 'chromium') {
    await ctx.setOffline(true);
    const p2 = await ctx.newPage();
    await p2.goto(URL_APP + '#add');
    check(await p2.isVisible('#btn-save'), `[${name}] reabre sin internet y muestra el formulario`);
    await ctx.setOffline(false);
  }
  check(bad.length === 0, `[${name}] sin recursos rotos ${bad.length ? bad.join(', ') : ''}`);
  check(errors.length === 0, `[${name}] sin errores de JavaScript ${errors.join(' | ')}`);
  await browser.close();
}
console.log(failures ? `\n${failures} fallo(s)` : '\nTodo correcto');
process.exit(failures ? 1 : 0);
