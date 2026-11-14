/** Reports module (section 23): 25 reports, common filters, CSV and Excel export. */
import { store } from '../services/store.js';
import { can } from '../services/session.js';
import { availableReports, runReport, reportTable } from '../services/reports.js';
import { esc, icon, table, pageHead, btn, toast } from '../components/ui.js';
import { downloadCSV, downloadExcel } from '../utils/csv.js';
import { today } from '../utils/format.js';

export function reportsView(ctx) {
  const list = availableReports();
  const id = ctx.params[0];
  if (!can('reports.view')) return { title: 'Reports', html: '<div class="panel"><div class="empty"><b>You do not have permission to view reports.</b></div></div>' };
  if (!id) {
    return { title: 'Reports', html: `${pageHead({ title: 'Reports', sub: 'Each report only contains records you are allowed to see.' })}
      <section class="panel">${table({ cols: [{ key: 'n', label: '#', num: true }, { key: 'title', label: 'Report', cls: 'id' }, { key: 'cols', label: 'Columns', html: (r) => `<span class="muted small">${esc(r.cols.slice(0, 7).map((c) => c.label).join(', '))}…</span>` }], rows: list.map((r, i) => ({ ...r, n: i + 1 })), href: (r) => `#/reports/${r.id}`, empty: '<b>No reports are available with your permissions.</b>' })}</section>` };
  }
  const s = ctx.state;
  const f = { from: s.from, to: s.to, project: s.project, item: s.item, dept: s.dept, vendor: s.vendor, status: s.status };
  const res = runReport(id, f);
  if (!res.def || !list.includes(res.def)) return { title: 'Reports', html: '<div class="panel"><div class="empty"><b>This report is not available to you.</b><a href="#/reports">All reports</a></div></div>' };
  const sel = (key, label, opts) => `<div class="field"><label for="rf_${key}">${label}</label><select id="rf_${key}" data-bind="${key}"><option value="">All</option>${opts.map(([v, l]) => `<option value="${esc(v)}"${String(s[key] || '') === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
  const inp = (key, label, type = 'text') => `<div class="field"><label for="rf_${key}">${label}</label><input id="rf_${key}" type="${type}" data-bind="${key}" value="${esc(s[key] || '')}"></div>`;
  const shown = res.rows.slice(0, 500);
  const fileName = `${res.def.id}-report-${today()}`;
  return {
    title: res.def.title,
    html: `${pageHead({ title: esc(res.def.title), crumbs: '<a href="#/reports">Reports</a>', actions: can('reports.export') ? `${btn('csv', 'Export CSV', { ic: 'download' })}${btn('xls', 'Export Excel', { ic: 'sheet' })}` : '' })}
      <div class="filters">${inp('from', 'Date from', 'date')}${inp('to', 'Date to', 'date')}${sel('project', 'Project', store.projects({ archived: true }).map((p) => [p.id, p.id]))}${inp('item', 'Item')}${sel('dept', 'Department', store.departments().map((d) => [d.id, d.name]))}${inp('vendor', 'Vendor')}${sel('status', 'Status', (res.statuses || []).map((x) => [x, x]))}<button class="btn ghost" data-act="clear">Clear filters</button></div>
      <section class="panel">${table({ cols: res.def.cols.map((c) => ({ key: c.key, label: c.label, type: c.type })), rows: shown, href: (r) => r._link, empty: '<b>No rows match these filters.</b>' })}<div class="tablefoot">${res.rows.length} row${res.rows.length === 1 ? '' : 's'}${res.rows.length > shown.length ? ` — showing the first ${shown.length}; the export contains all of them` : ''}</div></section>`,
    actions: {
      clear: () => { Object.keys(s).forEach((k) => delete s[k]); ctx.rerender(); },
      csv: () => { downloadCSV(fileName, reportTable(res)); toast('CSV exported.'); },
      xls: () => { downloadExcel(fileName, reportTable(res)); toast('Excel file exported.'); },
    },
  };
}
export { icon };
