// Cálculos del dashboard: totales del mes, hábitos y sugerencias de ahorro.
import { todayISO } from './store.js';

const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export function monthStats(data, now = new Date()) {
  const y = now.getFullYear(), m = now.getMonth(), day = now.getDate();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const ym = `${y}-${String(m + 1).padStart(2, '0')}`;
  const prev = new Date(y, m - 1, 1);
  const pym = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;

  const month = data.expenses.filter(e => e.date?.startsWith(ym));
  const prevToDate = data.expenses.filter(e => e.date?.startsWith(pym) && Number(e.date.slice(8, 10)) <= day);

  const spent = sum(month);
  const prevSpent = sum(prevToDate);
  const budget = Number(data.config?.presupuesto_mensual) || 0;
  const daily = spent / day;
  const projection = daily * daysInMonth;

  const byCat = {};
  month.forEach(e => { byCat[e.category || 'Otros'] = (byCat[e.category || 'Otros'] || 0) + Number(e.amount); });

  return {
    month, spent, prevSpent, budget, remaining: budget - spent, daily, projection, day, daysInMonth,
    delta: prevSpent ? (spent - prevSpent) / prevSpent : null,
    byCat: Object.entries(byCat).sort((a, b) => b[1] - a[1]),
  };
}

export function weekStats(data, now = new Date()) {
  const s = monthStats(data, now);
  const start = new Date(now); start.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // lunes
  const startISO = todayISO(start);
  const week = data.expenses.filter(e => e.date >= startISO);
  const daysLeft = s.daysInMonth - s.day + 1;
  return { weekSpent: sum(week), remaining: s.remaining, perDay: s.remaining / daysLeft, daysLeft, budget: s.budget };
}

export function last30(data) {
  const out = [];
  const map = {};
  data.expenses.forEach(e => { map[e.date] = (map[e.date] || 0) + Number(e.amount); });
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = todayISO(d);
    out.push({ date: iso, label: d.getDate(), total: map[iso] || 0 });
  }
  return out;
}

export function habits(data, fmt) {
  const recent = recentDays(data, 60);
  if (recent.length < 3) return [{ icon: '🌱', text: 'Registra unos días más y aquí verás tus patrones de gasto.' }];
  const list = [];

  const byDow = Array(7).fill(0);
  recent.forEach(e => { byDow[new Date(e.date + 'T12:00').getDay()] += Number(e.amount); });
  const topDow = byDow.indexOf(Math.max(...byDow));
  list.push({ icon: '📆', text: `Gastas más los <b>${DAY_NAMES[topDow]}</b> (${fmt(byDow[topDow])} en 60 días).` });

  const byMerchant = groupBy(recent, e => (e.merchant || e.concept || '').trim().toLowerCase());
  const top = Object.entries(byMerchant).filter(([k]) => k).sort((a, b) => b[1].length - a[1].length)[0];
  if (top && top[1].length >= 2) {
    list.push({ icon: '🔁', text: `Tu gasto más frecuente: <b>${cap(top[0])}</b> — ${top[1].length} veces, ${fmt(sum(top[1]))}.` });
  }

  const small = recent.filter(e => e.amount <= 150);
  if (small.length >= 5) {
    list.push({ icon: '☕', text: `${small.length} gastos hormiga (≤ ${fmt(150)}) suman <b>${fmt(sum(small))}</b>.` });
  }

  const avgTicket = sum(recent) / recent.length;
  list.push({ icon: '🎯', text: `Tu ticket promedio es de <b>${fmt(avgTicket)}</b>.` });
  return list;
}

export function tips(data, stats, fmt) {
  const out = [];
  const cats = data.categories || [];

  if (stats.budget && stats.projection > stats.budget) {
    const cut = (stats.projection - stats.budget) / (stats.daysInMonth - stats.day + 1);
    out.push({ icon: '⚠️', text: `A este ritmo cerrarás el mes en <b>${fmt(stats.projection)}</b>. Reduce ~${fmt(cut)} al día para no pasarte.` });
  } else if (stats.budget && stats.spent > 0) {
    out.push({ icon: '✅', text: `Vas en camino: proyectas <b>${fmt(stats.projection)}</b> de ${fmt(stats.budget)}. Podrías apartar ${fmt(Math.max(0, stats.budget - stats.projection))} a tus metas.` });
  }

  stats.byCat.forEach(([name, total]) => {
    const c = cats.find(x => x.name === name);
    if (c?.budget && total > c.budget) {
      out.push({ icon: esc(c.emoji || '•'), text: `<b>${esc(name)}</b> ya superó su presupuesto (${fmt(total)} de ${fmt(c.budget)}).` });
    } else if (c?.budget && total > c.budget * 0.8) {
      out.push({ icon: esc(c.emoji || '•'), text: `<b>${esc(name)}</b> va al ${Math.round((total / c.budget) * 100)}% de su presupuesto.` });
    }
  });

  const recent = recentDays(data, 30);
  const coffee = recent.filter(e => /caf[eé]|starbucks|coffee/i.test(`${e.concept} ${e.merchant}`));
  if (coffee.length >= 4) {
    out.push({ icon: '☕', text: `${coffee.length} cafés en 30 días = ${fmt(sum(coffee))}. Recortar a la mitad te ahorra ~${fmt(sum(coffee) / 2 * 12)} al año.` });
  }
  const delivery = recent.filter(e => /rappi|uber eats|didi food/i.test(`${e.concept} ${e.merchant}`));
  if (delivery.length >= 3) {
    out.push({ icon: '🛵', text: `Pediste a domicilio ${delivery.length} veces (${fmt(sum(delivery))}). Cocinar 2 de esas veces ahorra ~${fmt(sum(delivery) * 0.4)} al mes.` });
  }
  const subs = recent.filter(e => e.category === 'Suscripciones');
  if (subs.length >= 3) out.push({ icon: '📺', text: `Tienes ${subs.length} cargos de suscripciones (${fmt(sum(subs))}/mes). ¿Usas todas?` });

  if (!out.length) out.push({ icon: '✨', text: 'Todo en orden. Sigue registrando para recibir sugerencias personalizadas.' });
  return out.slice(0, 5);
}

// ── utilidades ──
const sum = arr => arr.reduce((s, e) => s + Number(e.amount || 0), 0);
const groupBy = (arr, fn) => arr.reduce((acc, x) => ((acc[fn(x)] ||= []).push(x), acc), {});
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = s => esc(s.charAt(0).toUpperCase() + s.slice(1));
function recentDays(data, n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  const since = todayISO(d);
  return data.expenses.filter(e => e.date >= since);
}
