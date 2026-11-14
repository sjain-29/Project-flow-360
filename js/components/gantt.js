/** Project timeline / Gantt from the real stage dates. Day, week and month scales; parallel branches; overdue outlined. */
import { store } from '../services/store.js';
import { dueInfo } from '../services/insights.js';
import { esc } from './ui.js';
import { parseISO, daysBetween, addDays, today, toISO } from '../utils/format.js';

const PX = { day: 26, week: 8, month: 2.6 };
const tone = (s) => (s === 'Completed' ? 'done' : s === 'In Progress' ? 'active' : s === 'Waiting for Approval' ? 'wait' : ['Blocked', 'On Hold'].includes(s) ? 'held' : '');
const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function ganttHtml(pid, scale = 'week') {
  const p = store.project(pid);
  const items = store.where('projectItems', pid, (i) => i.itemStatus !== 'Cancelled');
  const rows = [];
  for (const it of items) {
    const st = store.where('stages', pid, (s) => s.itemId === it.id && s.status !== 'Cancelled').sort((a, b) => (a.branch + String(a.seq).padStart(3, '0')).localeCompare(b.branch + String(b.seq).padStart(3, '0')));
    const dated = st.map((s) => ({ s, from: s.actStart || s.expStart, to: s.actEnd || s.expEnd || s.expStart || s.actStart })).filter((x) => x.from && x.to);
    if (!dated.length) continue;
    rows.push({ group: `${it.itemCode} — ${it.name}`, href: `#/items/${pid}/${it.id}` });
    let prev = null;
    for (const x of dated) { rows.push({ ...x, item: it, prev: prev && prev.s.branch === x.s.branch ? prev : null }); prev = x; }
  }
  const dates = [p.startDate, p.targetDate, today(), ...rows.filter((r) => r.s).flatMap((r) => [r.from, r.to])].filter(Boolean).sort();
  if (!rows.length) return '<div class="empty"><b>No dated activities yet.</b>Open an item and give its workflow stages expected start and completion dates — they will appear here.</div>';
  const start = addDays(dates[0], -3); const end = addDays(dates[dates.length - 1], 7);
  const px = PX[scale] || PX.week;
  const x = (d) => Math.round(daysBetween(start, d) * px);
  const width = x(end);
  const ticks = [];
  for (let d = parseISO(start); toISO(d) <= end; d.setDate(d.getDate() + 1)) {
    const iso = toISO(d);
    if (scale === 'day') ticks.push([iso, d.getDate() === 1 || iso === start ? `${d.getDate()} ${M[d.getMonth()]}` : String(d.getDate())]);
    else if (scale === 'week' && d.getDay() === 1) ticks.push([iso, `${d.getDate()} ${M[d.getMonth()]}`]);
    else if (scale === 'month' && d.getDate() === 1) ticks.push([iso, `${M[d.getMonth()]} ${d.getFullYear()}`]);
  }
  const lane = (inner) => `<div class="g-lane" style="width:${width}px">${inner}</div>`;
  const todayLine = `<div class="g-today" style="left:${x(today())}px" title="Today"></div>`;
  const bar = (r) => {
    const late = !['Completed'].includes(r.s.status) && r.s.expEnd && dueInfo(r.s.expEnd).cat === 'overdue';
    const left = x(r.from); const w = Math.max(px, x(r.to) - left + px);
    const linkEl = r.prev && x(r.prev.to) + px <= left ? `<div class="g-link" style="left:${x(r.prev.to) + px}px;width:${left - x(r.prev.to) - px}px;top:15px" title="Follows ${esc(r.prev.s.name)}"></div>` : '';
    return `${linkEl}<a class="g-bar ${tone(r.s.status)} ${late ? 'late' : ''}" href="#/items/${pid}/${r.item.id}?stage=${encodeURIComponent(r.s.id)}" style="left:${left}px;width:${w}px" title="${esc(`${r.s.name}: ${r.from} → ${r.to} · ${r.s.status}${late ? ' · OVERDUE' : ''}`)}"></a>`;
  };
  const body = rows.map((r) => (r.group
    ? `<div class="g-row group"><a class="g-name" href="${r.href}">${esc(r.group)}</a>${lane(todayLine)}</div>`
    : `<div class="g-row"><div class="g-name" title="${esc(r.s.name)}">${r.s.branch === 'B' ? '<span class="muted">B ·&nbsp;</span>' : ''}${esc(r.s.name)}</div>${lane(todayLine + bar(r))}</div>`)).join('');
  const projBar = p.startDate && p.targetDate ? `<div class="g-bar proj" style="left:${x(p.startDate)}px;width:${Math.max(4, x(p.targetDate) - x(p.startDate))}px" title="${esc(`Project: ${p.startDate} → ${p.targetDate}`)}"></div>` : '';
  return `<div class="gantt"><div class="gantt-grid">
    <div class="g-row head"><div class="g-name muted">Activity</div>${lane(ticks.map(([d, l]) => `<div class="g-tick" style="left:${x(d)}px">${esc(l)}</div>`).join(''))}</div>
    <div class="g-row group"><div class="g-name">${esc(p.id)} — project start to target</div>${lane(todayLine + projBar)}</div>${body}</div></div>
    <div class="body legend"><span><i style="background:var(--g-idle)"></i>Not started</span><span><i style="background:var(--accent)"></i>In progress</span><span><i style="background:var(--warn)"></i>Waiting for approval</span><span><i style="background:var(--serious)"></i>On hold / blocked</span><span><i style="background:var(--good)"></i>Completed</span><span><i style="outline:2px solid var(--crit);background:none"></i>Overdue</span><span><i style="background:var(--crit);width:2px"></i>Today</span><span class="muted">Rows marked “B” are source-stock replenishment, running in parallel.</span></div>`;
}
