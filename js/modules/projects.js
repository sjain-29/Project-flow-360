/** Project list and project detail page (sections 5, 6, 16, 27–29). */
import { store } from '../services/store.js';
import { can, canAny, session } from '../services/session.js';
import * as P from '../services/projects.js';
import * as C from '../services/closure.js';
import { projectActivity, projectDocuments } from '../services/records.js';
import { projectProgress, projectHealth, projectExpenditure, activities, pendingApprovals, itemProgress, liveItems, DUE_LABEL } from '../services/insights.js';
import { itemQuantities } from '../services/quantities.js';
import { latestTest } from '../services/devtest.js';
import { formFields, PRIORITIES, PROJECT_STATUSES } from '../config/entities.js';
import { esc, icon, badge, meter, table, pageHead, btn, tabsBar, dl, toast, showError, formModal, confirmDialog, fmtValue, $$ } from '../components/ui.js';
import { panelsHtml, mountPanels, logRowsHtml } from '../components/panels.js';
import { ganttHtml } from '../components/gantt.js';
import { parseCSV, downloadCSV, toCSV, download } from '../utils/csv.js';
import { pct, fmtMoney, fmtQty, fmtDate, today, AppError } from '../utils/format.js';

const healthBadge = (h) => badge(h.label, { green: 'good', amber: 'warn', red: 'crit', closed: '' }[h.level] || '');
const projectFields = (isNew) => [...(isNew ? [{ name: 'id', label: 'Project ID', req: true, hint: 'Unique. Capital letters, digits and hyphens, e.g. DRN-X1.', max: 24 }] : []),
  ...formFields('projects', ['name', 'category', 'managerId', 'departmentId', 'startDate', 'targetDate', 'priority', 'budget']), ...(isNew ? [{ name: 'status', label: 'Project status', type: 'select', req: true, opts: ['Planning', 'Active', 'On Hold'] }] : []), ...formFields('projects', ['description', 'remarks'])];

/* ------------------------------------------------------------------ list */
export function projectsView(ctx) {
  const s = ctx.state;
  if (!can('projects.view')) return { title: 'Projects', html: '<div class="panel"><div class="empty"><b>You do not have permission to view projects.</b></div></div>' };
  const rows = store.projects({ archived: !!s.archived }).filter((p) => (!s.q || `${p.id} ${p.name} ${p.description || ''}`.toLowerCase().includes(s.q.toLowerCase())) && (!s.status || p.status === s.status) && (!s.priority || p.priority === s.priority) && (!s.manager || p.managerId === s.manager) && (!s.archived || p.archived))
    .map((p) => ({ ...p, progress: projectProgress(p.id), health: projectHealth(p.id), overdue: activities(p.id).filter((a) => a.cat === 'overdue').length }));
  const opt = (v, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(v)}</option>`;
  return {
    title: 'Projects',
    html: `${pageHead({ title: 'Projects', sub: `${rows.length} project${rows.length === 1 ? '' : 's'} you have access to`, actions: `${can('projects.create') ? btn('create', 'New project', { ic: 'plus', cls: 'primary' }) : ''}${can('projects.export') ? btn('export', 'Export CSV', { ic: 'download' }) : ''}` })}
      <div class="filters"><div class="field grow"><label for="pq">Search</label><input id="pq" data-bind="q" value="${esc(s.q || '')}" placeholder="Project ID, name or description"></div>
        <div class="field"><label for="ps">Status</label><select id="ps" data-bind="status"><option value="">All</option>${PROJECT_STATUSES.map((x) => opt(x, s.status)).join('')}</select></div>
        <div class="field"><label for="pp">Priority</label><select id="pp" data-bind="priority"><option value="">All</option>${PRIORITIES.map((x) => opt(x, s.priority)).join('')}</select></div>
        <div class="field"><label for="pm">Project manager</label><select id="pm" data-bind="manager"><option value="">All</option>${[...new Set(store.projects({ archived: true }).map((p) => p.managerId))].map((u) => `<option value="${esc(u)}"${u === s.manager ? ' selected' : ''}>${esc(store.userName(u))}</option>`).join('')}</select></div>
        <label class="check" style="padding-bottom:8px"><input type="checkbox" data-bind="archived"${s.archived ? ' checked' : ''}><span>Archived only</span></label></div>
      <section class="panel">${table({
    cols: [{ key: 'id', label: 'Project ID', cls: 'id' }, { key: 'name', label: 'Project name' }, { key: 'managerId', label: 'Project manager', type: 'user' }, { key: 'status', label: 'Status', html: (p) => badge(p.status) }, { key: 'priority', label: 'Priority', html: (p) => badge(p.priority) }, { key: 'targetDate', label: 'Target completion', type: 'date' },
      { key: 'progress', label: 'Progress', html: (p) => `<div style="display:flex;gap:8px;align-items:center;min-width:120px">${meter(p.progress.overall)}<span class="small soft">${pct(p.progress.overall)}</span></div>` }, { key: 'health', label: 'Health', html: (p) => healthBadge(p.health) }, { key: 'overdue', label: 'Overdue', num: true, html: (p) => (p.overdue ? `<b style="color:var(--crit-ink)">${p.overdue}</b>` : '0') }],
    rows, href: (p) => `#/projects/${p.id}`, empty: `<b>No projects${s.q || s.status || s.priority ? ' match these filters' : ' yet'}.</b>${can('projects.create') ? 'Create the first project with “New project”.' : 'Projects appear here when you are given access to them.'}` })}</section>`,
    actions: {
      create: () => formModal({ title: 'New project', wide: true, fields: projectFields(true), values: { startDate: today(), priority: 'Medium', status: 'Planning', managerId: session.userId, departmentId: session.user.departmentId }, submitLabel: 'Create project', successMessage: 'Project created.', onSubmit: (v) => P.createProject(v) }).then((pid) => { if (typeof pid === 'string') location.hash = `#/projects/${pid}`; }),
      export: () => { downloadCSV(`projects-${today()}`, [['Project ID', 'Name', 'Category', 'Manager', 'Department', 'Status', 'Priority', 'Start', 'Target completion', 'Progress %', 'Health', 'Overdue activities'], ...rows.map((p) => [p.id, p.name, p.category, store.userName(p.managerId), store.deptName(p.departmentId), p.status, p.priority, p.startDate, p.targetDate, Math.round(p.progress.overall * 100), p.health.label, p.overdue])]); toast('Exported.'); },
    },
  };
}

/* ------------------------------------------------------------------ detail */
const TABS = [['overview', 'Overview'], ['items', 'Items (BOM)'], ['timeline', 'Timeline'], ['activities', 'Activities'], ['expenditure', 'Expenditure'], ['documents', 'Documents'], ['discussion', 'Comments'], ['history', 'History'], ['closure', 'Closure']];

function overviewTab(p, pr, h, pid) {
  const items = liveItems(pid);
  const od = activities(pid).filter((a) => a.cat === 'overdue');
  const led = items.map((i) => itemQuantities(pid, i.id));
  const row = (label, v, cls = '') => `<div class="progressrow"><span>${label}</span>${v === null || v === undefined ? '<span class="muted small" style="grid-column:2/4">Not applicable yet</span>' : `${meter(v, cls)}<span>${pct(v)}</span>`}</div>`;
  return `<div class="grid c2">
    <section class="panel"><header><h2>Project overview</h2></header><div class="body">${dl([['Project ID', esc(p.id)], ['Project manager', fmtValue('user', p.managerId)], ['Department', fmtValue('dept', p.departmentId)], ['Category', esc(p.category || '')], ['Start date', fmtValue('date', p.startDate)], ['Target completion', fmtValue('date', p.targetDate)], ['Priority', badge(p.priority)], ['Status', badge(p.status)], ['Estimated budget', p.budget ? esc(fmtMoney(p.budget)) : null], ['Cloned from', p.clonedFrom ? esc(p.clonedFrom) : null]])}${p.description ? `<p style="margin-top:12px">${esc(p.description)}</p>` : ''}${p.remarks ? `<p class="soft">${esc(p.remarks)}</p>` : ''}</div></section>
    <section class="panel"><header><h2>Progress</h2></header><div class="body">${row('<b>Overall</b>', pr.overall)}${row('Procurement', pr.procurement)}${row('Material availability', pr.material, 'good')}${row('Development', pr.development)}${row('Testing', pr.testing)}${pr.replenishment !== null ? row('<span class="muted">Stock replenishment</span>', pr.replenishment) : ''}
      <p class="muted small" style="margin-top:8px">Overall progress is the average of the items’ weighted stage progress (Branch A only). Replenishment is shown separately and never counts as project progress. <a href="#/help">How this is calculated</a></p></div></section>
    <section class="panel"><header><h2>Project health</h2>${healthBadge(h)}</header><div class="body"><ul style="margin:0;padding-left:18px">${h.reasons.map((r) => `<li>${esc(r)}</li>`).join('') || '<li class="muted">Project is closed.</li>'}</ul></div></section>
    <section class="panel"><header><h2>At a glance</h2></header><div class="kpis" style="border:0;border-radius:0 0 6px 6px"><a class="kpi" href="#/projects/${pid}?tab=items"><b>${items.length}</b><span>Total items</span></a><a class="kpi ${od.length ? 'alert' : ''}" href="#/projects/${pid}?tab=activities"><b>${od.length}</b><span>Overdue activities</span></a><div class="kpi"><b>${pendingApprovals(pid).length}</b><span>Pending approvals</span></div><div class="kpi"><b>${led.filter((q) => q.verified && q.fulfilled).length}/${items.length}</b><span>Items with all material accepted</span></div><div class="kpi ${led.some((q) => q.uncovered > 0) ? 'warn' : ''}"><b>${led.filter((q) => q.uncovered > 0).length}</b><span>Items with uncovered shortage</span></div><div class="kpi"><b>${led.filter((q) => !q.verified).length}</b><span>Items not yet verified</span></div></div></section></div>`;
}

function itemsTab(ctx, pid, closed) {
  const s = ctx.state;
  const rows = store.list('projectItems', pid).filter((i) => !s.iq || `${i.itemCode} ${i.name}`.toLowerCase().includes(s.iq.toLowerCase())).map((i) => { const q = itemQuantities(pid, i.id); return { ...i, q, check: store.get('inventoryChecks', pid, i.id), dev: store.get('development', pid, i.id)?.status, test: latestTest(pid, i.id)?.status, prog: itemProgress(pid, i.id).overall }; });
  const tools = closed ? '' : `${can('items.create', pid) ? `${btn('addItem', 'Add item', { ic: 'plus', cls: 'primary' })}${btn('importBom', 'Import CSV', { ic: 'upload' })}<input type="file" id="bomFile" accept=".csv,text/csv" hidden>` : ''}${can('items.edit', pid) ? btn('bulk', 'Bulk update', { ic: 'checks' }) : ''}`;
  return `<div class="filters"><div class="field grow"><label for="iq">Search items</label><input id="iq" data-bind="iq" value="${esc(s.iq || '')}" placeholder="Item code or name"></div><div class="actions">${tools}${can('items.export', pid) ? btn('exportBom', 'Export CSV', { ic: 'download' }) : ''}${btn('bomTemplate', 'CSV template', { cls: 'ghost' })}</div></div>
    <section class="panel">${table({ select: can('items.edit', pid) && !closed ? (i) => i.id : null,
    cols: [{ key: 'itemCode', label: 'Item code', cls: 'id' }, { key: 'name', label: 'Item name' }, { key: 'requiredQty', label: 'Required', num: true, html: (i) => `${fmtQty(i.q.required)} ${esc(i.uom || '')}` }, { key: 'priority', label: 'Priority', html: (i) => (i.priority ? badge(i.priority) : '') }, { key: 'check', label: 'In-house availability', html: (i) => badge(i.check?.availability || 'Not verified') },
      { key: 'acc', label: 'Accepted / outstanding', num: true, html: (i) => `${fmtQty(i.q.accepted)} / ${i.q.outstanding > 0 ? `<b style="color:var(--warn-ink)">${fmtQty(i.q.outstanding)}</b>` : '0'}` }, { key: 'dev', label: 'Development', html: (i) => badge(i.dev || 'Not Started') }, { key: 'test', label: 'Testing', html: (i) => badge(i.test || 'Not Started') },
      { key: 'prog', label: 'Progress', html: (i) => `<div style="display:flex;gap:8px;align-items:center;min-width:100px">${meter(i.prog)}<span class="small soft">${pct(i.prog)}</span></div>` }, { key: 'itemStatus', label: 'Item', html: (i) => (i.itemStatus && i.itemStatus !== 'Open' ? badge(i.itemStatus) : '') }],
    rows, href: (i) => `#/items/${pid}/${i.id}`, empty: `<b>This project has no items yet.</b>${can('items.create', pid) && !closed ? 'Add the required items one by one, or import the bill of material from a CSV file.' : ''}` })}<div class="tablefoot">${rows.length} item${rows.length === 1 ? '' : 's'}</div></section>`;
}

function expenditureTab(pid) {
  if (!can('expenditure.view', pid)) return '<div class="panel"><div class="empty"><b>Financial information is restricted.</b>You do not have permission to view project expenditure.</div></div>';
  const e = projectExpenditure(pid);
  const partial = !can('po.view', pid) || !can('payments.view', pid);
  const m = (v) => esc(fmtMoney(v));
  const line = (label, x, note) => `<tr><td data-label="">${label}${note ? `<div class="muted small">${note}</div>` : ''}</td><td class="num" data-label="PR value">${m(x.pr)}</td><td class="num" data-label="Ordered (PO)">${m(x.ordered)}</td><td class="num" data-label="Invoiced (PI)">${m(x.invoiced)}</td><td class="num" data-label="Paid">${m(x.paid)}</td><td class="num" data-label="Outstanding">${m(x.outstanding)}</td></tr>`;
  return `${partial ? '<div class="note warn">Some purchasing or payment records are not visible to you, so these totals may be incomplete.</div>' : ''}
    <div class="kpis" style="margin-bottom:16px"><div class="kpi"><b>${m(e.budget)}</b><span>Estimated budget</span></div><div class="kpi"><b>${m(e.estimated)}</b><span>Estimated cost (BOM)</span></div><div class="kpi"><b>${m(e.total.ordered)}</b><span>Ordered cost (all POs)</span></div><div class="kpi"><b>${m(e.total.invoiced)}</b><span>Invoiced cost</span></div><div class="kpi"><b>${m(e.total.paid)}</b><span>Paid amount</span></div><div class="kpi ${e.total.outstanding > 0 ? 'warn' : ''}"><b>${m(e.total.outstanding)}</b><span>Outstanding amount</span></div></div>
    <div class="stack"><section class="panel"><header><h2>Project procurement and stock replenishment</h2></header><div class="table-wrap"><table class="tbl stack"><thead><tr><th></th><th class="num">PR value</th><th class="num">Ordered (PO)</th><th class="num">Invoiced (PI)</th><th class="num">Paid</th><th class="num">Outstanding</th></tr></thead><tbody>
      ${line('Project procurement', e.project, 'Material bought for this project')}${line('Source stock replenishment', e.replenishment, 'Bought to refill departments that transferred stock')}</tbody><tfoot>${line('Consolidated', e.total, 'Each purchase order counted once')}</tfoot></table></div></section>
    <section class="panel"><header><h2>Item-wise cost</h2></header>${table({ cols: [{ key: 'itemCode', label: 'Item code', cls: 'id' }, { key: 'name', label: 'Item name' }, { key: 'estimated', label: 'Estimated', type: 'money' }, { key: 'ordered', label: 'Ordered', type: 'money' }, { key: 'invoiced', label: 'Invoiced', type: 'money' }, { key: 'paid', label: 'Paid', type: 'money' }, { key: 'replenishment', label: 'Replenishment ordered', type: 'money' }], rows: e.byItem, href: (r) => `#/items/${pid}/${r.itemId}`, empty: 'No items.' })}</section>
    <section class="panel"><header><h2>Vendor-wise cost</h2></header>${table({ cols: [{ key: 'vendor', label: 'Vendor', cls: 'id' }, { key: 'pos', label: 'POs', num: true }, { key: 'ordered', label: 'Ordered', type: 'money' }, { key: 'paid', label: 'Paid', type: 'money' }, { key: 'outstanding', label: 'Outstanding', type: 'money' }], rows: e.byVendor, empty: 'No purchase orders yet.' })}</section></div>`;
}

function closureTab(p, pid) {
  const closed = ['Completed', 'Cancelled'].includes(p.status);
  const may = can('closure.approve', pid);
  const recs = ['completion', 'cancellation', 'reopen'].map((k) => store.get('closures', pid, k)).filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const recHtml = recs.map((r) => `<section class="panel"><header><h2>${{ completion: 'Completion record', cancellation: 'Cancellation record', reopen: 'Reopening record' }[r.kind]}</h2><span class="muted small">${esc(r.approvedByName || '')} · ${fmtValue('ts', r.updatedAt)}</span></header><div class="body">${dl([['Final completion date', r.kind === 'completion' ? fmtValue('date', r.completionDate) : null], ['Cancellation date', fmtValue('date', r.cancellationDate) === '<span class="muted">—</span>' ? null : fmtValue('date', r.cancellationDate)], ['Approved by', esc(r.approvedByName || '')], ['Override used', r.kind === 'completion' ? (r.override ? badge('Yes', 'warn') : 'No') : null], ['Override reason', r.overrideReason ? esc(r.overrideReason) : null], ['Reason', r.reason ? esc(r.reason) : null], ['Unresolved checks', r.unresolved ? esc(r.unresolved) : null], ['Material status', r.materialStatus ? esc(r.materialStatus) : null], ['Stock return / disposal', r.stockReturnStatus ? esc(r.stockReturnStatus) : null], ['Procurement cancellation', r.procurementCancellationStatus ? esc(r.procurementCancellationStatus) : null], ['Vendor commitments', r.vendorCommitments ? esc(r.vendorCommitments) : null], ['Payment settlement', r.paymentSettlementStatus ? esc(r.paymentSettlementStatus) : null], ['Outstanding liabilities', r.outstandingLiabilities !== undefined ? esc(fmtMoney(r.outstandingLiabilities)) : null], ['RGP / NRGP status', r.gatePassStatus ? esc(r.gatePassStatus) : null], ['Final remarks', r.finalRemarks ? esc(r.finalRemarks) : null]])}</div></section>`).join('');
  if (closed) return `<div class="stack"><div class="note">This project is <b>${esc(p.status.toLowerCase())}</b>. All of its records are kept and remain readable; nothing can be changed unless the project is reopened.</div>${may ? `<div>${btn('reopen', 'Reopen project', { ic: 'refresh' })}</div>` : ''}${recHtml}</div>`;
  const list = C.closureChecklist(pid);
  return `<div class="stack"><section class="panel"><header><h2>Closure checklist</h2><span class="muted small">${list.filter((c) => c.auto === false).length} check(s) not satisfied by the records</span></header><div class="body"><div class="checklist">${list.map((c) => `<div class="row"><input type="checkbox" id="chk_${c.key}" data-check="${c.key}"${may ? '' : ' disabled'}><label for="chk_${c.key}"><b>${esc(c.label)}</b><div class="soft small">${esc(c.detail)}</div></label>${c.auto === true ? badge('Records agree', 'good') : c.auto === false ? badge('Not satisfied', 'crit') : badge('Manual check', 'plain')}</div>`).join('')}</div>
    ${may ? `<p class="muted small" style="margin-top:12px">Tick each line you have verified. Lines the records contradict can only be passed with an authorised override and a written reason.</p><div class="actions">${btn('complete', 'Complete project…', { ic: 'check', cls: 'primary' })}${btn('cancelProject', 'Cancel project…', { ic: 'x', cls: 'danger' })}</div>` : '<p class="muted small" style="margin-top:12px">Only users with the closure approval permission can complete or cancel a project.</p>'}</div></section>${recHtml}</div>`;
}

export function projectView(ctx) {
  const pid = ctx.params[0];
  const p = store.project(pid);
  if (!p) return { title: 'Project', html: `<div class="panel"><div class="empty"><b>Project ${esc(pid)} was not found, or you do not have access to it.</b><a href="#/projects">All projects</a></div></div>` };
  const tab = TABS.some(([t]) => t === ctx.query.get('tab')) ? ctx.query.get('tab') : 'overview';
  const closed = ['Completed', 'Cancelled'].includes(p.status);
  const pr = projectProgress(pid); const h = projectHealth(pid);
  const s = ctx.state;
  let body;
  if (tab === 'overview') body = overviewTab(p, pr, h, pid);
  else if (tab === 'items') body = itemsTab(ctx, pid, closed);
  else if (tab === 'timeline') { const sc = s.scale || 'week'; body = `<section class="panel"><header><h2>Project timeline</h2><div class="actions">${['day', 'week', 'month'].map((x) => `<button class="btn sm ${sc === x ? 'primary' : ''}" data-act="scale" data-scale="${x}">${{ day: 'Daily', week: 'Weekly', month: 'Monthly' }[x]}</button>`).join('')}</div></header>${ganttHtml(pid, sc)}</section>`; }
  else if (tab === 'activities') { const rows = activities(pid); body = `<section class="panel"><header><h2>Dated activities</h2></header>${table({ cols: [{ key: 'itemCode', label: 'Item', cls: 'id' }, { key: 'label', label: 'Activity' }, { key: 'deptId', label: 'Department', type: 'dept' }, { key: 'personId', label: 'Responsible', type: 'user' }, { key: 'due', label: 'Expected date', type: 'date' }, { key: 'cat', label: 'Due status', html: (r) => badge(DUE_LABEL[r.cat], r.cat === 'overdue' ? 'crit' : r.cat === 'ontrack' ? 'good' : 'warn') }, { key: 'status', label: 'Status', html: (r) => badge(r.status) }, { key: 'overdueDays', label: 'Overdue days', num: true, html: (r) => r.overdueDays || '' }], rows, href: (r) => r.link, flag: (r) => r.cat === 'overdue', empty: '<b>No dated activities.</b>Open an item and give its stages expected dates.' })}</section>`; }
  else if (tab === 'expenditure') body = expenditureTab(pid);
  else if (tab === 'documents') body = `${panelsHtml(['documents'])}<section class="panel" style="margin-top:16px"><header><h2>All documents in this project</h2></header><div class="body" id="allDocs"><span class="muted">Loading…</span></div></section>`;
  else if (tab === 'discussion') body = panelsHtml(['comments']);
  else if (tab === 'history') body = '<section class="panel"><header><h2>Project activity history</h2></header><div class="body" id="projLog"><span class="muted">Loading…</span></div></section>';
  else body = closureTab(p, pid);

  const acts = [can('projects.edit', pid) && !closed ? btn('edit', 'Edit', { ic: 'edit' }) : '', can('projects.updateStatus', pid) && !closed ? btn('status', 'Change status', { ic: 'flag' }) : '', can('projects.create') ? btn('clone', 'Clone', { ic: 'copy' }) : '', can('projects.edit', pid) ? btn('archive', p.archived ? 'Restore' : 'Archive', { ic: 'archive' }) : '', can('projects.export', pid) ? btn('exportProject', 'Export', { ic: 'download' }) : ''].join('');
  return {
    title: `${pid} — ${p.name}`,
    html: `${pageHead({ crumbs: '<a href="#/projects">Projects</a>', title: `${esc(pid)} — ${esc(p.name)}`, sub: `${badge(p.status)} ${badge(p.priority)} ${healthBadge(h)} <span class="soft">· ${esc(store.userName(p.managerId))} · target ${esc(fmtDate(p.targetDate))} · ${pct(pr.overall)} complete</span>${p.archived ? ` ${badge('Archived', 'plain')}` : ''}`, actions: acts })}
      ${tabsBar(TABS, tab, (t) => `#/projects/${pid}?tab=${t}`)}${body}`,
    actions: {
      edit: () => formModal({ title: `Edit ${pid}`, wide: true, fields: projectFields(false), values: p, onSubmit: (v) => P.updateProject(pid, v) }),
      status: () => formModal({ title: 'Change project status', intro: 'Completing or cancelling a project is done on the Closure tab.', fields: [{ name: 'status', label: 'Status', type: 'select', req: true, opts: ['Planning', 'Active', 'On Hold'] }], values: p, onSubmit: (v) => P.setProjectStatus(pid, v.status) }),
      clone: () => formModal({ title: `Clone ${pid}`, intro: 'Copies the project details and, if you wish, its bill of material. Transactions are never copied.', fields: [{ name: 'id', label: 'New project ID', req: true }, { name: 'name', label: 'New project name', req: true, value: `${p.name} (copy)` }, { name: 'includeItems', label: 'Copy the items (BOM)', type: 'bool', value: true }], submitLabel: 'Clone project', onSubmit: (v) => P.cloneProject(pid, v) }).then((id) => { if (typeof id === 'string') location.hash = `#/projects/${id}`; }),
      archive: async () => { if (await confirmDialog({ title: p.archived ? 'Restore project' : 'Archive project', body: p.archived ? 'Show this project in the normal project list again?' : 'Archiving hides the project from the normal list. Nothing is deleted.' })) await P.setProjectArchived(pid, !p.archived).then(() => toast(p.archived ? 'Project restored.' : 'Project archived.')); },
      exportProject: () => { const e = can('expenditure.view', pid) ? projectExpenditure(pid) : null; download(`${pid}-project-${today()}.csv`, `﻿${toCSV([['Project ID', pid], ['Name', p.name], ['Description', p.description || ''], ['Category', p.category || ''], ['Manager', store.userName(p.managerId)], ['Department', store.deptName(p.departmentId)], ['Status', p.status], ['Priority', p.priority], ['Start', p.startDate], ['Target completion', p.targetDate], ['Progress %', Math.round(pr.overall * 100)], ['Health', `${h.label}: ${h.reasons.join('; ')}`], ...(e ? [['Estimated budget', e.budget], ['Ordered', e.total.ordered], ['Paid', e.total.paid], ['Outstanding', e.total.outstanding]] : []), [], ['Item code', 'Item name', 'Required', 'Unit', 'Accepted', 'Outstanding'], ...liveItems(pid).map((i) => { const q = itemQuantities(pid, i.id); return [i.itemCode, i.name, q.required, i.uom, q.accepted, q.outstanding]; })])}`, 'text/csv'); toast('Exported.'); },
      scale: (d) => { s.scale = d.scale; ctx.rerender(); },
      addItem: () => formModal({ title: 'Add item', wide: true, fields: formFields('projectItems'), values: { priority: 'Medium' }, submitLabel: 'Add item', successMessage: 'Item added.', onSubmit: async (v) => { const dup = P.duplicateItems(pid, v.itemCode); if (dup.length && !await confirmDialog({ title: 'Duplicate item code', body: `Item code <b>${esc(v.itemCode)}</b> already exists in this project (${dup.length} item${dup.length === 1 ? '' : 's'}). Add it again as a separate item?`, confirmLabel: 'Add anyway' })) throw new AppError('Not added. Change the item code or edit the existing item.'); return P.addItem(pid, v); } }),
      bomTemplate: () => downloadCSV('bom-template', [P.BOM_COLUMNS, ['MTR-2212', 'Brushless motor', '920 KV', 8, 'Nos', '3-4S', 'High', 'Preferred vendor name', 3200, '2026-12-31', '']]),
      exportBom: () => { downloadCSV(`${pid}-bom-${today()}`, [P.BOM_COLUMNS, ...store.list('projectItems', pid).map((i) => P.BOM_COLUMNS.map((c) => i[c] ?? ''))]); toast('BOM exported.'); },
      importBom: () => document.getElementById('bomFile')?.click(),
      bulk: () => { const ids = $$('[data-sel]:checked').map((x) => x.dataset.sel); if (!ids.length) { toast('Tick the items to update first.', 'error'); return null; } return formModal({ title: `Update ${ids.length} item${ids.length === 1 ? '' : 's'}`, intro: 'Only the fields you fill in are changed.', fields: [{ name: 'priority', label: 'Priority', type: 'select', opts: PRIORITIES }, { name: 'requiredBy', label: 'Required by date', type: 'date' }, { name: 'preferredVendor', label: 'Preferred vendor' }], onSubmit: (v) => P.bulkUpdateItems(pid, ids, Object.fromEntries(Object.entries(v).filter(([, x]) => x !== ''))) }); },
      selAll: (d, el) => $$('[data-sel]').forEach((x) => { x.checked = el.checked; }),
      complete: () => { const confirm = Object.fromEntries($$('[data-check]').map((x) => [x.dataset.check, x.checked])); const open = C.closureChecklist(pid).filter((c) => c.auto === false || !confirm[c.key]);
        return formModal({ title: 'Complete project', wide: true, intro: open.length ? `<b>${open.length} checklist line(s) are not resolved:</b> ${open.map((c) => esc(c.label)).join('; ')}. Completion is only possible with an authorised override and a reason.` : 'Every checklist line is confirmed.', fields: [{ name: 'completionDate', label: 'Final completion date', type: 'date', req: true, value: today() }, ...(open.length ? [{ name: 'override', label: 'Authorised override: complete the project although the checklist is not fully resolved', type: 'bool', wide: true }, { name: 'overrideReason', label: 'Override reason', type: 'textarea' }] : []), { name: 'finalRemarks', label: 'Final remarks', type: 'textarea' }], submitLabel: 'Complete project', successMessage: 'Project completed.', onSubmit: (v) => C.completeProject(pid, { ...v, confirm }) }); },
      cancelProject: () => formModal({ title: 'Cancel project', wide: true, danger: true, intro: 'Cancellation keeps every record. Describe the state the project is left in.', fields: [{ name: 'reason', label: 'Cancellation reason', type: 'textarea', req: true }, { name: 'cancellationDate', label: 'Cancellation date', type: 'date', req: true, value: today() }, ...formFields('closures', ['materialStatus', 'stockReturnStatus', 'procurementCancellationStatus', 'vendorCommitments', 'paymentSettlementStatus', 'outstandingLiabilities', 'gatePassStatus', 'finalRemarks'])], submitLabel: 'Cancel project', successMessage: 'Project cancelled.', onSubmit: (v) => C.cancelProject(pid, v) }),
      reopen: () => formModal({ title: 'Reopen project', fields: [{ name: 'reason', label: 'Reason for reopening', type: 'textarea', req: true }], submitLabel: 'Reopen', successMessage: 'Project reopened.', onSubmit: (v) => C.reopenProject(pid, v) }),
    },
    mount(root) {
      if (tab === 'documents' || tab === 'discussion') mountPanels(root, ctx, { coll: 'projects', pid, rid: pid });
      if (tab === 'documents') projectDocuments(pid).then((docs) => { const el = root.querySelector('#allDocs'); if (el) el.innerHTML = table({ cols: [{ key: 'name', label: 'Document', html: (d) => (d.kind === 'link' ? `<a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(d.name)}</a>` : esc(d.name)) }, { key: 'category', label: 'Category' }, { key: 'rid', label: 'Attached to', html: (d) => `<a href="${d.rtype === 'projects' ? `#/projects/${pid}` : d.rtype === 'projectItems' ? `#/items/${pid}/${esc(d.rid)}` : `#/r/${esc(d.rtype)}/${pid}/${encodeURIComponent(d.rid)}`}">${esc(d.rid)}</a>` }, { key: 'uploadedByName', label: 'Added by' }, { key: 'at', label: 'Added on', type: 'ts' }], rows: docs, empty: 'No documents in the parts of this project you can see.' }); }).catch(() => {});
      if (tab === 'history') projectActivity(pid).then((logs) => { const el = root.querySelector('#projLog'); if (el) el.innerHTML = can('activity.view', pid) ? logRowsHtml(logs.slice(0, 300), { withRecord: true }) : '<div class="empty">You do not have permission to view the activity history.</div>'; }).catch(() => {});
      root.querySelector('#bomFile')?.addEventListener('change', async (e) => {
        const file = e.target.files[0]; e.target.value = ''; if (!file) return;
        try {
          const chk = P.checkBomRows(pid, parseCSV(await file.text()));
          const dups = chk.valid.filter((r) => r._duplicate).length;
          const ok = await confirmDialog({ title: 'Import bill of material', body: `<b>${chk.valid.length}</b> valid row(s) will be added.${dups ? ` <b>${dups}</b> of them repeat an item code that already exists — they will be added as separate items.` : ''}${chk.errors.length ? `<br><br><b>${chk.errors.length} row(s) will be skipped:</b><br>${chk.errors.slice(0, 8).map((x) => `Row ${x.row}: ${esc(x.message)}`).join('<br>')}` : ''}`, confirmLabel: chk.valid.length ? `Import ${chk.valid.length} item(s)` : 'Close' });
          if (ok && chk.valid.length) { await P.importBom(pid, chk.valid); toast(`${chk.valid.length} item(s) imported.`); }
        } catch (err) { showError(err); }
      });
    },
  };
}
export { canAny, icon };
