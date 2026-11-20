// Interpreta texto libre o dictado ("200 pesos en café", "uber 85.50", "1.2k súper")
// y clasifica por palabras clave.

const NUMBER_WORDS = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50,
  sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100, doscientos: 200, trescientos: 300,
  cuatrocientos: 400, quinientos: 500, seiscientos: 600, setecientos: 700, ochocientos: 800, novecientos: 900,
};

const FILLER = new Set(['peso', 'pesos', 'mxn', 'varos', 'bolas', 'en', 'de', 'del', 'por', 'para', 'un', 'una', 'el', 'la', 'los', 'las', 'gaste', 'pague', 'compre', 'me', 'y', 'mil', 'k']);

/** Quita palabras de relleno y números escritos, palabra por palabra (respeta acentos). */
const cleanConcept = text => String(text).split(/\s+/)
  .filter(w => w && !FILLER.has(normalize(w).replace(/[.,!?]/g, '')) && !(normalize(w) in NUMBER_WORDS))
  .join(' ');

export const normalize = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Convierte "doscientos cincuenta" → 250 (casos simples del dictado). */
function wordsToNumber(text) {
  const words = normalize(text).split(/\s+/);
  let total = 0, current = 0, found = false;
  for (const w of words) {
    if (w === 'mil') { current = (current || 1) * 1000; total += current; current = 0; found = true; continue; }
    if (w === 'y' && found) continue;
    if (w in NUMBER_WORDS) { current += NUMBER_WORDS[w]; found = true; continue; }
    if (found) break;
  }
  return found ? total + current : null;
}

export function parseExpense(text) {
  const raw = String(text || '').trim();
  if (!raw) return { amount: null, concept: '' };

  // $1,250.50 · 1250,50 · 1.2k · 3 mil
  const m = raw.match(/\$?\s*(\d{1,3}(?:[,\s]\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)\s*(k|mil)?\b/i);
  let amount = null, concept = raw;

  if (m) {
    let n = m[1].replace(/\s/g, '');
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(n)) n = n.replace(/,/g, '');
    else n = n.replace(',', '.');
    amount = parseFloat(n);
    if (m[2]) amount *= 1000;
    concept = raw.replace(m[0], ' ');
  } else {
    const w = wordsToNumber(raw);
    if (w) amount = w;
  }

  concept = cleanConcept(concept).trim();
  concept = concept.charAt(0).toUpperCase() + concept.slice(1);
  return { amount: amount && amount > 0 ? Math.round(amount * 100) / 100 : null, concept };
}

/** Devuelve el nombre de la categoría cuyo keyword más largo aparezca en el texto. */
export function categorize(text, categories) {
  const t = ` ${normalize(text)} `;
  let best = null, bestLen = 0;
  for (const c of categories) {
    for (const k of c.keywords || []) {
      const nk = normalize(k);
      if (nk.length > bestLen && new RegExp(`(^|\\W)${nk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`).test(t)) {
        best = c.name; bestLen = nk.length;
      }
    }
  }
  return best;
}
