/**
 * Charts (Chart.js, vendored). One visual system for every chart:
 * thin bars with rounded ends, recessive grid, ink-coloured text, a legend only
 * when there are two or more series, hover tooltips, and a "Table" view of the
 * same numbers for accessibility. Colours come from a palette validated for
 * colour-vision deficiency on this dark surface; status colours are used only
 * for states (for example "overdue").
 */
import { esc, table } from './ui.js';

export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500'];
export const STATUS = { good: '#0ca30c', warn: '#fab219', serious: '#ec835a', crit: '#d03b3b' };
const INK = '#b6c1d2'; const MUTED = '#8191a9'; const GRID = '#1d2940';

/** def: { id, title, note, labels, series: [{ name, data, color }], stacked, unit, max } */
export function chartPanel(def, state) {
  const asTable = state[`tbl_${def.id}`];
  const total = def.series.reduce((a, s) => a + s.data.reduce((x, y) => x + (Number(y) || 0), 0), 0);
  const body = !def.labels.length || total === 0 ? `<div class="empty">${esc(def.empty || 'No data yet.')}</div>`
    : asTable ? table({ cols: [{ key: 'label', label: def.dim || 'Category' }, ...def.series.map((s, i) => ({ key: `s${i}`, label: s.name || def.title, num: true }))], rows: def.labels.map((l, r) => ({ label: l, ...Object.fromEntries(def.series.map((s, i) => [`s${i}`, s.data[r]])) })) })
      : `<div class="chartbox" style="height:${Math.max(170, def.labels.length * (def.series.length > 1 && !def.stacked ? 20 * def.series.length + 14 : 34) + 50)}px"><canvas id="cv_${def.id}" role="img" aria-label="${esc(def.title)}"></canvas></div>`;
  return `<section class="panel chartcard"><header><h3>${esc(def.title)}</h3><button type="button" class="btn sm ghost" data-act="toggleChart" data-id="${def.id}">${asTable ? 'Chart' : 'Table'}</button></header><div class="body">${body}${def.note ? `<p class="muted small" style="margin:8px 0 0">${esc(def.note)}</p>` : ''}</div></section>`;
}

/** Draw every chart whose canvas is on the page. Returns a cleanup function. */
export function drawCharts(root, defs) {
  const made = [];
  if (typeof Chart === 'undefined') return () => {};
  for (const def of defs) {
    const cv = root.querySelector(`#cv_${def.id}`);
    if (!cv) continue;
    made.push(new Chart(cv, {
      type: 'bar',
      data: { labels: def.labels, datasets: def.series.map((s, i) => ({ label: s.name || def.title, data: s.data, backgroundColor: s.color || SERIES[i % SERIES.length], borderRadius: 4, borderSkipped: 'start', maxBarThickness: 16, borderColor: '#111a2c', borderWidth: def.stacked ? { right: 2 } : 0 })) },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { display: def.series.length > 1, position: 'bottom', align: 'start', labels: { color: INK, boxWidth: 10, boxHeight: 10, font: { size: 12 } } },
          tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${Number(c.parsed.x).toLocaleString('en-IN')}${def.unit || ''}` } },
        },
        scales: {
          x: { stacked: !!def.stacked, beginAtZero: true, max: def.max, grid: { color: GRID }, border: { display: false }, ticks: { color: MUTED, precision: 0, maxTicksLimit: 6, callback: (v) => `${Number(v).toLocaleString('en-IN')}${def.unit || ''}` } },
          y: { stacked: !!def.stacked, grid: { display: false }, border: { color: '#26344d' }, ticks: { color: INK, font: { size: 12 }, callback(v) { const l = String(this.getLabelForValue(v)); return l.length > 26 ? `${l.slice(0, 25)}…` : l; } } },
        },
      },
    }));
  }
  return () => made.forEach((c) => c.destroy());
}
export const chartActions = (ctx) => ({ toggleChart: (d) => { ctx.state[`tbl_${d.id}`] = !ctx.state[`tbl_${d.id}`]; ctx.rerender(); } });
