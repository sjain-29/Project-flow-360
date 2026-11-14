/**
 * Main dashboard (section 20). Every number and chart is computed from the
 * records in the store — which only holds what this user may see — so the
 * dashboard adapts to role, department and project access by construction.
 */
import { store } from '../services/store.js';
import { session, can, isSuperAdmin } from '../services/session.js';
import { isDemo, be } from '../services/backend.js';
import { kpis, activities, pendingApprovals, projectProgress, projectExpenditure, procurementStage, liveItems, DUE_LABEL } from '../services/insights.js';
import { itemQuantities } from '../services/quantities.js';
import { latestTest } from '../services/devtest.js';
import { loadSampleData } from '../services/demo-data.js';
import { PROJECT_STATUSES } from '../config/entities.js';
import { esc, icon, badge, table, pageHead, btn, toast, showError, confirmDialog, openModal } from '../components/ui.js';
import { chartPanel, drawCharts, chartActions, STATUS } from '../components/charts.js';
import { groupBy, fmtDate } from '../utils/format.js';

const count = (list, order) => { const g = groupBy(list, (x) => x); const keys = order ? order.filter((k) => g[k]) : Object.keys(g).sort((a, b) => g[b].length - g[a].length); return { labels: keys, data: keys.map((k) => g[k].length) }; };

function charts() {
  const projects = store.projects();
  const open = projects.filter((p) => !['Completed', 'Cancelled'].includes(p.status));
  const openIds = new Set(open.map((p) => p.id));
  const items = open.flatMap((p) => liveItems(p.id));
  const defs = [];
  const st = count(projects.map((p) => p.status), PROJECT_STATUSES);
  defs.push({ id: 'pstatus', title: 'Project status distribution', dim: 'Status', labels: st.labels, series: [{ name: 'Projects', data: st.data }] });
  if (can('procurement.view')) { const c = count(store.list('procurement').filter((r) => openIds.has(r.pid) && !['Cancelled', 'Rejected'].includes(r.status)).map(procurementStage)); defs.push({ id: 'pstage', title: 'Procurement stage distribution', dim: 'Stage', labels: c.labels, series: [{ name: 'Procurement lines', data: c.data }], note: 'Each line is one procurement requirement (project or replenishment).' }); }
  const mat = count(items.map((i) => { const q = itemQuantities(i.pid, i.id); return !q.verified ? 'Availability not verified' : q.fulfilled ? 'Fully received' : q.accepted > 0 ? 'Partially received' : q.dispatched > 0 ? 'In transit' : 'Awaiting material'; }), ['Availability not verified', 'Awaiting material', 'In transit', 'Partially received', 'Fully received']);
  defs.push({ id: 'material', title: 'Material movement status', dim: 'State', labels: mat.labels, series: [{ name: 'Items', data: mat.data }] });
  if (can('development.view')) { const c = count(items.map((i) => store.get('development', i.pid, i.id)?.status || 'Not Started'), ['Not Started', 'In Progress', 'Blocked', 'Under Review', 'Reopened', 'Completed']); defs.push({ id: 'dev', title: 'Development progress', dim: 'Status', labels: c.labels, series: [{ name: 'Items', data: c.data }] }); }
  if (can('testing.view')) { const c = count(items.map((i) => latestTest(i.pid, i.id)?.status || 'Not Started'), ['Not Started', 'In Progress', 'Passed', 'Failed', 'Retest Required', 'Approved']); defs.push({ id: 'test', title: 'Testing status', dim: 'Latest cycle', labels: c.labels, series: [{ name: 'Items', data: c.data }] }); }
  const stages = store.list('stages').filter((s) => openIds.has(s.pid) && !['Completed', 'Cancelled'].includes(s.status) && s.status !== 'Not Started');
  const late = new Set(activities().filter((a) => a.cat === 'overdue' && a.kind === 'stage').map((a) => a.key));
  const byDept = groupBy([...stages, ...store.list('stages').filter((s) => openIds.has(s.pid) && s.status === 'Not Started' && late.has(`stage:${s.pid}:${s.id}`))], (s) => s.deptId || '');
  const depts = Object.keys(byDept).sort((a, b) => byDept[b].length - byDept[a].length);
  defs.push({ id: 'dept', title: 'Department-wise pending activities', dim: 'Department', stacked: true, labels: depts.map((d) => store.deptName(d)), series: [{ name: 'In hand, on time', data: depts.map((d) => byDept[d].filter((s) => !late.has(`stage:${s.pid}:${s.id}`)).length) }, { name: 'Overdue', color: STATUS.crit, data: depts.map((d) => byDept[d].filter((s) => late.has(`stage:${s.pid}:${s.id}`)).length) }], note: 'Stages that are in progress, waiting, on hold or blocked — plus anything overdue.', empty: 'No activities in hand.' });
  defs.push({ id: 'progress', title: 'Project-wise progress', dim: 'Project', unit: '%', max: 100, labels: open.map((p) => p.id), series: [{ name: 'Progress', data: open.map((p) => Math.round(projectProgress(p.id).overall * 100)) }], empty: 'No open projects.' });
  if (can('expenditure.view') && can('po.view')) { const e = open.map((p) => projectExpenditure(p.id).total); defs.push({ id: 'spend', title: 'Project expenditure', dim: 'Project', labels: open.map((p) => p.id), series: [{ name: 'Ordered', data: e.map((x) => x.ordered) }, { name: 'Invoiced', data: e.map((x) => x.invoiced) }, { name: 'Paid', data: e.map((x) => x.paid) }], note: 'Includes source-stock replenishment; each purchase order is counted once.', empty: 'No purchase orders yet.' }); }
  return defs;
}

export function dashboardView(ctx) {
  const k = kpis();
  const role = store.role(session.user.roleId);
  const kind = role?.dashboard || 'user';
  const myDepts = session.acl.d || {};
  const sub = { org: 'Organisation-wide overview', pm: 'Your projects and their activities', dept: `Department workload — ${Object.keys(myDepts).map((d) => store.deptName(d)).join(', ')}`, user: 'Your tasks and updates', viewer: 'Read-only overview of the projects shared with you' }[kind];
  const tile = (n, label, href, cls = '') => `<a class="kpi ${n > 0 ? cls : ''}" href="${href}"><b>${n}</b><span>${esc(label)}</span></a>`;
  // six headline figures; the remaining ones fold away under "More figures"
  const head = [tile(k.active, 'Active projects', '#/projects'), tile(k.totalItems, 'Project items', '#/reports/items'),
    tile(k.awaitingProcurement, 'Awaiting procurement', '#/m/procurement', 'warn'),
    can('pr.view') ? tile(k.pendingPRApprovals, 'PRs to approve', '#/m/purchaseRequests', 'warn') : tile(k.awaitingReceipt, 'Awaiting material receipt', '#/reports/movement', 'warn'),
    can('payments.view') ? tile(k.pendingPayments, 'Pending payments', '#/m/payments', 'warn') : tile(k.completed, 'Completed projects', '#/projects'),
    tile(k.overdue, 'Overdue activities', '#/deadlines', 'alert')];
  const all = [tile(k.totalProjects, 'Total projects', '#/projects'), tile(k.completed, 'Completed projects', '#/projects'), tile(k.onHold, 'On-hold projects', '#/projects'), tile(k.cancelled, 'Cancelled projects', '#/projects'),
    tile(k.awaitingReceipt, 'Awaiting material receipt', '#/reports/movement', 'warn'), can('procurement.view') ? tile(k.pendingPRs, 'Requirements without a PR', '#/m/procurement', 'warn') : '',
    can('pr.view') ? tile(k.pendingPRApprovals, 'PRs to approve', '#/m/purchaseRequests', 'warn') : '', can('payments.view') ? tile(k.pendingPayments, 'Pending payments', '#/m/payments', 'warn') : ''];
  const rest = all.filter((t) => t && !head.includes(t));
  const tiles = `<div class="kpis">${head.join('')}</div>${rest.length ? `<details class="more"><summary>More figures <span class="muted">(${rest.length})</span></summary><div class="kpis">${rest.join('')}</div></details>` : ''}`;

  const approvals = pendingApprovals().filter((a) => can(a.perm, a.pid));
  const mine = activities().filter((a) => a.kind === 'stage' && (a.personId === session.userId || (!a.personId && myDepts[a.deptId])));
  const attention = `<section class="panel"><header><h2>Waiting for you</h2><span class="muted small">${approvals.length} approval${approvals.length === 1 ? '' : 's'} · ${mine.length} dated task${mine.length === 1 ? '' : 's'}</span></header>
    ${approvals.length || mine.length ? table({ cols: [{ key: 'what', label: 'What' }, { key: 'pid', label: 'Project' }, { key: 'itemCode', label: 'Item' }, { key: 'due', label: 'Expected', type: 'date' }, { key: 'state', label: 'Status', html: (r) => badge(r.state) }],
    rows: [...approvals.map((a) => ({ what: `Approve: ${a.label}`, pid: a.pid, itemCode: a.itemCode, state: 'Pending Approval', link: a.link })), ...mine.slice(0, 12).map((a) => ({ what: a.label, pid: a.pid, itemCode: a.itemCode, due: a.due, state: a.cat === 'overdue' ? 'Overdue' : a.status, link: a.link }))], href: (r) => r.link })
    : '<div class="empty"><b>Nothing is waiting for you.</b>Approvals you can give and dated stages assigned to you or your department appear here.</div>'}</section>`;

  const critical = activities().filter((a) => ['overdue', 'today', 'soon'].includes(a.cat)).sort((a, b) => b.overdueDays - a.overdueDays || (a.due < b.due ? -1 : 1)).slice(0, 15);
  const crit = `<section class="panel"><header><h2>Critical activities</h2><a class="btn sm ghost" href="#/deadlines">All deadlines</a></header>${table({
    cols: [{ key: 'pid', label: 'Project ID', cls: 'id' }, { key: 'projectName', label: 'Project name' }, { key: 'itemCode', label: 'Item code' }, { key: 'label', label: 'Activity' }, { key: 'deptId', label: 'Department', type: 'dept' }, { key: 'personId', label: 'Responsible person', type: 'user' }, { key: 'due', label: 'Expected date', type: 'date' }, { key: 'status', label: 'Status', html: (r) => `${badge(r.status)} ${r.cat !== 'overdue' ? badge(DUE_LABEL[r.cat]) : ''}` }, { key: 'overdueDays', label: 'Overdue days', num: true, html: (r) => (r.overdueDays ? `<b style="color:var(--crit-ink)">${r.overdueDays}</b>` : '') }],
    rows: critical, href: (r) => r.link, flag: (r) => r.cat === 'overdue', empty: '<b>No overdue or imminent activities.</b>Stages with an expected completion date appear here when they are due within 3 days or late.' })}</section>`;

  const defs = charts();
  const PRIORITY = ['progress', 'dept', 'pstage', 'material', 'pstatus', 'spend', 'dev', 'test'];
  defs.sort((a, b) => PRIORITY.indexOf(a.id) - PRIORITY.indexOf(b.id));
  const grid = (list) => `<div class="grid c2">${list.map((d) => chartPanel(d, ctx.state)).join('')}</div>`;
  const chartGrid = grid(defs.slice(0, 4)) + (defs.length > 4 ? `<details class="more" data-charts><summary>More charts <span class="muted">(${defs.length - 4})</span></summary>${grid(defs.slice(4))}</details>` : '');
  const demoTools = isDemo() && isSuperAdmin() && !store.projects({ archived: true }).length ? `<section class="panel"><header><h2>Start with a sample project</h2></header><div class="body"><p>The demo is empty. You can create your own project, or load a sample drone project that is built by running the real workflow with the demo accounts (stock check, transfers, purchase requests, approvals, quotations, PO, payment, receipts, development, a failed and a passed test, a gate pass).</p>${btn('sample', 'Load the sample project', { ic: 'download', cls: 'primary' })} <a class="btn" href="#/projects">Create my own project</a></div></section>` : '';
  const order = kind === 'user' || kind === 'dept' ? [attention, tiles, crit, chartGrid] : [tiles, demoTools, attention, crit, chartGrid];

  return {
    title: 'Dashboard',
    html: `${pageHead({ title: 'Dashboard', sub: `${esc(sub)} · ${esc(fmtDate(Date.now()))}` })}<div class="stack">${order.filter(Boolean).join('')}</div>`,
    actions: {
      ...chartActions(ctx),
      async sample() {
        if (!await confirmDialog({ title: 'Load the sample project', body: 'This signs in as each demo account in turn to run the workflow (about 15 seconds). You will be signed out at the end and can then sign in with any demo account.', confirmLabel: 'Load sample data' })) return;
        const m = openModal({ title: 'Loading sample project…', body: '<div class="spinner"></div><p id="sampleStep" style="text-align:center;margin-top:12px" class="soft">Starting…</p>' });
        try { await loadSampleData((s) => { const el = document.getElementById('sampleStep'); if (el) el.textContent = s; }); location.replace('login.html?reason=reset'); } catch (e) { m.close(); showError(e); be().auth.signOut().finally(() => location.replace('login.html')); }
      },
    },
    mount(root) {
      ctx.onCleanup(drawCharts(root, defs));
      // charts inside a closed <details> have no size yet: resize once it opens
      root.querySelector('details[data-charts]')?.addEventListener('toggle', () => window.dispatchEvent(new Event('resize')));
    },
  };
}
export { toast, icon };
