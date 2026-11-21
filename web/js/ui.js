// Small DOM helpers shared by the pages.
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

/** Wire up [data-act="name"] elements to handlers[name](element, event). */
export function bind(root, handlers) {
  root.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (el && root.contains(el) && handlers[el.dataset.act]) handlers[el.dataset.act](el, e);
  });
}

export const pill = (text, kind) => `<span class="pill ${kind}">${esc(text)}</span>`;
export const check = (ok, label, detail, action = '') => `
  <div class="check"><div class="mark ${ok ? 'ok' : 'no'}">${ok ? '✓' : '✗'}</div>
    <div style="flex:1"><b>${esc(label)}</b> <span class="muted">— ${esc(detail)}</span></div>${action}</div>`;

/** GitHub-style calendar: one column per week, Monday at the top. cells: [{day, cls, tip, future}] */
export function heatmap(cells) {
  return `<div class="heat">${cells.map(c => `<i class="${c.cls || ''} ${c.future ? 'f' : ''}" title="${esc(c.day + ': ' + c.tip)}"></i>`).join('')}</div>`;
}

/** Minimal line chart (inline SVG, follows the theme colors). points: [{x, y}] */
export function lineChart(points, { width = 600, height = 140, xMin, xMax, yMin, yMax, label = v => v } = {}) {
  if (points.length < 2) return '<p class="muted small">Not enough data yet.</p>';
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const x0 = xMin ?? Math.min(...xs), x1 = xMax ?? Math.max(...xs);
  const lo = yMin ?? Math.min(...ys), hi = yMax ?? Math.max(...ys);
  const sx = x => 30 + ((x - x0) / (x1 - x0 || 1)) * (width - 40);
  const sy = y => height - 18 - ((y - lo) / (hi - lo || 1)) * (height - 30);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img">
    <text x="0" y="${sy(hi) + 4}" class="axis">${esc(label(hi))}</text>
    <text x="0" y="${sy(lo) + 4}" class="axis">${esc(label(lo))}</text>
    <path d="${d}" class="line"/></svg>`;
}

export function bars(items, { max, goal, height = 120 } = {}) {
  const top = Math.max(max ?? 0, goal ?? 0, ...items.map(i => i.v), 1);
  return `<div class="bars" style="height:${height}px">${items.map(i => `
    <div class="b ${goal && i.v >= goal ? 'hit' : ''}" title="${esc(i.tip)}"><div style="height:${(i.v / top) * 100}%"></div></div>`).join('')}
    ${goal ? `<div class="goal" style="bottom:${(goal / top) * 100}%"></div>` : ''}</div>`;
}
