/** Generic module list pages (#/m/<collection>) and record pages (#/r/<collection>/<project>/<id>). */
import { store } from '../services/store.js';
import { can } from '../services/session.js';
import { saveStockRecord } from '../services/inventory.js';
import { poFinance } from '../services/procurement.js';
import { rgpDue } from '../services/material.js';
import { ENTITIES, formFields } from '../config/entities.js';
import { MODULE_BY_ID } from '../config/app-config.js';
import { esc, icon, badge, table, pageHead, btn, dl, toast, formModal, fmtValue, tabsBar } from '../components/ui.js';
import { panelsHtml, mountPanels } from '../components/panels.js';
import { recordActions, runAction, newRecordForm, CREATABLE } from '../actions.js';
import { downloadCSV } from '../utils/csv.js';
import { fmtMoney, fmtQty, today, round, num } from '../utils/format.js';

/** Menu areas: each is one menu entry whose modules appear as tabs. */
export const GROUPS = {
  procurement: { label: 'Procurement', items: [['procurement', 'Requirements'], ['purchaseRequests', 'Purchase requests'], ['quotations', 'Quotations'], ['purchaseOrders', 'Purchase orders'], ['proformaInvoices', 'Proforma invoices'], ['payments', 'Payments'], ['dispatches', 'Vendor dispatch']], also: ['paymentAdjustments'] },
  material: { label: 'Material', items: [['inventory', 'Stock'], ['stockTransfers', 'Transfers'], ['materialReceipts', 'Receipts (GRN)'], ['materialRequests', 'Material requests'], ['gvtReceipts', 'GVT receipts']], also: ['inventoryChecks'] },
  movement: { label: 'Movement', items: [['logistics', 'Logistics'], ['travelDesk', 'Travel'], ['gatePasses', 'Gate passes']], also: ['gatePassReturns'] },
  engineering: { label: 'Engineering', items: [['development', 'Development'], ['testing', 'Testing']], also: ['developmentUpdates'] },
};
export const groupFor = (coll) => Object.keys(GROUPS).find((k) => GROUPS[k].items.some(([c]) => c === coll) || GROUPS[k].also.includes(coll)) || null;
export const permittedTabs = (key) => GROUPS[key].items.filter(([c]) => can(`${ENTITIES[c].module}.view`));

const STATUS_FIELDS = ['status', 'approvalStatus', 'inspectionStatus', 'itemStatus', 'availability', 'type', 'priority'];
const typeOf = (f) => (STATUS_FIELDS.includes(f.name) ? 'status' : f.type);
const listCols = (coll, { withProject = true } = {}) => [{ key: 'id', label: ENTITIES[coll].idLabel || 'Reference', cls: 'id' }, ...(withProject && !ENTITIES[coll].global ? [{ key: 'pid', label: 'Project' }] : []), ...ENTITIES[coll].fields.filter((f) => f.list).map((f) => ({ key: f.name, label: f.label, type: typeOf(f) }))];
const hrefOf = (coll, r) => (coll === 'inventoryChecks' ? `#/items/${r.pid}/${r.id}` : coll === 'inventory' ? `#/r/inventory/_/${encodeURIComponent(r.id)}` : `#/r/${coll}/${r.pid}/${encodeURIComponent(r.id)}`);
const HINTS = {
  stockTransfers: 'Stock transfers are created by the in-house availability check of an item.', procurement: 'Requirements are created by the availability check (project shortage and source-stock replenishment) or by an approved request for additional material.',
  purchaseRequests: 'A PR is raised from an open procurement requirement.', quotations: 'Quotations are added on an approved PR.', purchaseOrders: 'A PO is created on an approved PR after a vendor quotation has been selected.', proformaInvoices: 'Proforma invoices are recorded on a purchase order.',
  payments: 'Payments are recorded on a purchase order.', dispatches: 'Vendor dispatches are recorded on a purchase order.', materialReceipts: 'A GRN is created by Stores when confirming receipt of a vendor dispatch.', materialRequests: 'Material requests are raised from an item that has accepted material at SPIF.',
  gvtReceipts: 'GVT receipts are confirmed on a dispatched material request.', development: 'Development is started from the item page.', testing: 'Test cycles are created from the item page once development is completed.',
};

/* ------------------------------------------------------------------ list */
export function listView(ctx) {
  const coll = ctx.params[0]; const e = ENTITIES[coll];
  if (!e || ['stages', 'closures', 'projects', 'projectItems'].includes(coll)) return { title: 'Not found', html: '<div class="panel"><div class="empty"><b>This page does not exist.</b></div></div>' };
  const mod = MODULE_BY_ID[e.module];
  if (!can(`${e.module}.view`)) return { title: e.label, html: `<div class="panel"><div class="empty"><b>You do not have permission to view ${esc(mod?.label || e.label).toLowerCase()}.</b></div></div>` };
  const s = ctx.state;
  const all = coll === 'inventory' ? store.stock() : store.list(coll);
  const statusKey = e.fields.find((f) => ['status', 'approvalStatus', 'inspectionStatus', 'availability'].includes(f.name))?.name;
  const rows = all.filter((r) => (!s.q || Object.values(r).some((v) => typeof v === 'string' && v.toLowerCase().includes(s.q.toLowerCase()))) && (!s.project || r.pid === s.project) && (!s.status || r[statusKey] === s.status))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const cols = listCols(coll);
  if (coll === 'gatePasses') cols.push({ key: 'due', label: 'Return', html: (r) => { const d = rgpDue(r); return d === null ? '' : d < 0 ? badge(`${-d} d overdue`, 'crit') : badge(`due in ${d} d`, d <= 3 ? 'warn' : 'info'); } });
  if (coll === 'purchaseOrders' && can('payments.view')) cols.push({ key: 'out', label: 'Outstanding', num: true, html: (r) => esc(fmtMoney(poFinance(r).outstanding)) });
  if (coll === 'inventory') cols.push({ key: 'free', label: 'Free', num: true, html: (r) => esc(fmtQty(round(num(r.onHand) - num(r.reserved)))) });
  const statuses = statusKey ? [...new Set(all.map((r) => r[statusKey]).filter(Boolean))].sort() : [];
  const createPerm = coll === 'inventory' ? 'inventory.create' : CREATABLE[coll];
  const projects = store.projects().filter((p) => !['Completed', 'Cancelled'].includes(p.status));
  const extra = coll === 'inventory' && can('inventory.view') ? `<section class="panel" style="margin-top:16px"><header><h2>In-house availability checks</h2></header>${table({ cols: listCols('inventoryChecks'), rows: store.list('inventoryChecks').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)), href: (r) => hrefOf('inventoryChecks', r), empty: 'No availability checks yet. They are recorded from the item page.' })}</section>` : '';
  return {
    title: e.label,
    html: `${pageHead({ title: esc(GROUPS[groupFor(coll)]?.label || e.label), sub: HINTS[coll] ? esc(HINTS[coll]) : '', actions: `${createPerm && can(createPerm) ? btn('create', coll === 'inventory' ? 'New stock record' : `New ${e.one.toLowerCase()}`, { ic: 'plus', cls: 'primary' }) : ''}${can(`${e.module}.export`) ? btn('export', 'Export CSV', { ic: 'download' }) : ''}` })}
      ${groupFor(coll) && permittedTabs(groupFor(coll)).length > 1 ? tabsBar(permittedTabs(groupFor(coll)), coll, (c) => `#/m/${c}`) : ''}
      <div class="filters"><div class="field grow"><label for="lq">Search</label><input id="lq" data-bind="q" value="${esc(s.q || '')}" placeholder="Reference, item, vendor…"></div>
        ${e.global ? '' : `<div class="field"><label for="lp">Project</label><select id="lp" data-bind="project"><option value="">All</option>${store.projects({ archived: true }).map((p) => `<option value="${esc(p.id)}"${p.id === s.project ? ' selected' : ''}>${esc(p.id)}</option>`).join('')}</select></div>`}
        ${statuses.length ? `<div class="field"><label for="ls">Status</label><select id="ls" data-bind="status"><option value="">All</option>${statuses.map((x) => `<option${x === s.status ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></div>` : ''}</div>
      <section class="panel">${coll === 'inventory' ? '<header><h2>Stock register</h2></header>' : ''}${table({ cols, rows: rows.slice(0, 400), href: (r) => hrefOf(coll, r), flag: coll === 'gatePasses' ? (r) => (rgpDue(r) ?? 0) < 0 : null, empty: `<b>No ${esc(e.label.toLowerCase())}${all.length ? ' match these filters' : ' yet'}.</b>${esc(HINTS[coll] || '')}` })}<div class="tablefoot">${rows.length} record${rows.length === 1 ? '' : 's'}${rows.length > 400 ? ' — showing the first 400' : ''}</div></section>${extra}`,
    actions: {
      export: () => { downloadCSV(`${coll}-${today()}`, [cols.filter((c) => !c.html).map((c) => c.label), ...rows.map((r) => cols.filter((c) => !c.html).map((c) => (c.type === 'user' ? store.userName(r[c.key]) : c.type === 'dept' ? store.deptName(r[c.key]) : r[c.key] ?? '')))]); toast('Exported.'); },
      create: async () => {
        if (coll === 'inventory') return formModal({ title: 'New stock record', fields: formFields('inventory'), submitLabel: 'Add stock record', onSubmit: (v) => saveStockRecord(null, v) });
        if (!projects.length) { toast('There is no open project to create this for.', 'error'); return null; }
        let pid = s.project || (projects.length === 1 ? projects[0].id : null);
        if (!pid) { const r = await formModal({ title: 'Which project?', fields: [{ name: 'pid', label: 'Project', type: 'select', req: true, opts: projects.map((p) => [p.id, `${p.id} — ${p.name}`]) }], submitLabel: 'Continue', successMessage: false, onSubmit: (v) => v.pid }); if (typeof r !== 'string') return null; pid = r; }
        return newRecordForm(coll, pid);
      },
    },
  };
}

/* ------------------------------------------------------------------ record */
function related(coll, r, pid) {
  const list = (c, rows, title) => ({ coll: c, rows, title: title || ENTITIES[c].label });
  const where = (c, pred) => (can(`${ENTITIES[c].module}.view`, pid) ? store.where(c, pid, pred) : []);
  const one = (c, id) => (id && can(`${ENTITIES[c].module}.view`, pid) && store.get(c, pid, id) ? [store.get(c, pid, id)] : []);
  switch (coll) {
    case 'procurement': return [list('stockTransfers', one('stockTransfers', r.transferId), 'Linked stock transfer'), list('purchaseRequests', where('purchaseRequests', (x) => x.requirementId === r.id), 'Purchase requests')];
    case 'stockTransfers': return [list('procurement', one('procurement', r.requirementId), 'Linked replenishment requirement')];
    case 'purchaseRequests': return [list('procurement', one('procurement', r.requirementId), 'Procurement requirement'), list('purchaseOrders', where('purchaseOrders', (x) => x.prId === r.id))];
    case 'quotations': return [list('purchaseRequests', one('purchaseRequests', r.prId), 'Purchase request')];
    case 'purchaseOrders': return [list('purchaseRequests', one('purchaseRequests', r.prId), 'Purchase request'), list('proformaInvoices', where('proformaInvoices', (x) => x.poId === r.id)), list('payments', where('payments', (x) => x.poId === r.id)), list('paymentAdjustments', where('paymentAdjustments', (x) => x.poId === r.id), 'Authorised payable adjustments'), list('dispatches', where('dispatches', (x) => x.poId === r.id)), list('materialReceipts', where('materialReceipts', (x) => x.poId === r.id), 'Material receipts (GRN)')];
    case 'proformaInvoices': case 'payments': case 'paymentAdjustments': return [list('purchaseOrders', one('purchaseOrders', r.poId), 'Purchase order')];
    case 'dispatches': return [list('purchaseOrders', one('purchaseOrders', r.poId), 'Purchase order'), list('materialReceipts', where('materialReceipts', (x) => x.dispatchId === r.id), 'Material receipts (GRN)')];
    case 'materialReceipts': return [list('purchaseOrders', one('purchaseOrders', r.poId), 'Purchase order'), list('dispatches', one('dispatches', r.dispatchId), 'Vendor dispatch')];
    case 'materialRequests': return [list('gvtReceipts', where('gvtReceipts', (x) => x.mrId === r.id))];
    case 'gvtReceipts': return [list('materialRequests', one('materialRequests', r.mrId), 'Material request')];
    case 'gatePasses': return [list('gatePassReturns', where('gatePassReturns', (x) => x.gatePassId === r.id), 'Returns')];
    case 'gatePassReturns': return [list('gatePasses', one('gatePasses', r.gatePassId), 'Gate pass')];
    case 'development': return [list('developmentUpdates', where('developmentUpdates', (x) => x.itemId === r.id).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)), 'Development updates (timestamped)'), list('testing', where('testing', (x) => x.itemId === r.id), 'Test cycles')];
    case 'testing': return [list('development', one('development', r.itemId), 'Development record')];
    default: return [];
  }
}

function quotationComparison(pr, pid) {
  if (!can('quotations.view', pid)) return '';
  const qs = store.where('quotations', pid, (q) => q.prId === pr.id).sort((a, b) => a.totalAmount - b.totalAmount);
  const low = qs[0]?.totalAmount;
  return `<section class="panel"><header><h2>Vendor quotation comparison</h2><span class="muted small">${qs.length} quotation${qs.length === 1 ? '' : 's'} · sorted by total</span></header>${pr.status !== 'Approved' ? '<div class="body"><div class="note warn" style="margin:0">Vendor quotations cannot be added until this PR is approved.</div></div>' : table({
    cols: [{ key: 'vendorName', label: 'Vendor', cls: 'id', html: (q) => `${esc(q.vendorName)}${q.selected ? ` ${badge('Selected', 'good')}` : ''}` }, { key: 'quotationNumber', label: 'Quotation no.' }, { key: 'unitPrice', label: 'Unit price', type: 'money' }, { key: 'gstPercent', label: 'GST %', type: 'number' }, { key: 'shippingCharges', label: 'Shipping', type: 'money' }, { key: 'otherCharges', label: 'Other', type: 'money' },
      { key: 'totalAmount', label: `Total for ${fmtQty(pr.qty)}`, num: true, html: (q) => `<b>${esc(fmtMoney(q.totalAmount))}</b>${q.totalAmount === low && qs.length > 1 ? ' <span class="badge good plain">Lowest</span>' : ''}` }, { key: 'deliveryTime', label: 'Delivery' }, { key: 'validity', label: 'Valid until', type: 'date' }, { key: 'paymentTerms', label: 'Payment terms' }],
    rows: qs, href: (q) => `#/r/quotations/${pid}/${encodeURIComponent(q.id)}`, empty: '<b>No quotations yet.</b>Sourcing adds vendor quotations here; several can be compared before one is selected.' })}${pr.selectionJustification ? `<div class="tablefoot"><b>Selection justification:</b> ${esc(pr.selectionJustification)} — ${esc(store.userName(pr.selectedBy))}</div>` : ''}</section>`;
}

export function recordView(ctx) {
  const [coll, pidRaw, id] = ctx.params; const e = ENTITIES[coll];
  const pid = pidRaw === '_' ? null : pidRaw;
  const r = e && (coll === 'inventory' ? store.stockRecord(id) : store.get(coll, pid, id));
  if (!e || !r || !can(`${e.module}.view`, pid || undefined)) return { title: 'Record', html: '<div class="panel"><div class="empty"><b>This record was not found, or you do not have permission to see it.</b><a href="#/dashboard">Go to the dashboard</a></div></div>' };
  const rec = { ...r, pid };
  const actions = pid && ['Completed', 'Cancelled'].includes(store.project(pid)?.status) ? [] : recordActions(coll, rec);
  const status = r.status || r.approvalStatus;
  const fields = e.fields.filter((f) => !['itemId', 'stockId'].includes(f.name) && r[f.name] !== undefined && r[f.name] !== '').map((f) => [f.label, f.name === 'itemCode' && r.itemId && pid ? `<a href="#/items/${esc(pid)}/${esc(r.itemId)}">${esc(r.itemCode)}</a>` : ['prId', 'poId', 'requirementId', 'transferId', 'mrId', 'dispatchId', 'gatePassId', 'quotationId', 'selectedQuotationId', 'piId'].includes(f.name) ? linkTo(f.name, r[f.name], pid) : fmtValue(typeOf(f), r[f.name])]);
  const rel = related(coll, rec, pid).filter((x) => x.rows.length);
  const fin = coll === 'purchaseOrders' && can('payments.view', pid) ? (() => { const f = poFinance(r); return `<section class="panel"><header><h2>Payment position</h2></header><div class="kpis" style="border:0"><div class="kpi"><b>${esc(fmtMoney(r.totalValue))}</b><span>PO value</span></div><div class="kpi"><b>${esc(fmtMoney(r.adjTotal || 0))}</b><span>Authorised adjustments</span></div><div class="kpi"><b>${esc(fmtMoney(f.payable))}</b><span>Total payable</span></div><div class="kpi"><b>${esc(fmtMoney(f.paid))}</b><span>Successful payments</span></div><div class="kpi ${f.outstanding > 0 ? 'warn' : ''}"><b>${esc(fmtMoney(f.outstanding))}</b><span>Outstanding</span></div></div></section>`; })() : '';
  const due = coll === 'gatePasses' ? rgpDue(r) : null;
  return {
    title: `${e.one} ${id}`,
    html: `${pageHead({ crumbs: `<a href="#/m/${coll === 'inventoryChecks' ? 'inventory' : ['gatePassReturns'].includes(coll) ? 'gatePasses' : ['paymentAdjustments'].includes(coll) ? 'payments' : ['developmentUpdates'].includes(coll) ? 'development' : coll}">${esc(e.label)}</a>${pid ? ` / <a href="#/projects/${esc(pid)}">${esc(pid)}</a>` : ''}`, title: `${esc(e.one)} ${esc(id)}`,
      sub: `${status ? badge(status) : ''}${r.procurementType || r.type ? ` ${badge(r.procurementType || r.type, 'plain')}` : ''}${due !== null && due < 0 ? ` ${badge(`Return overdue by ${-due} d`, 'crit')}` : ''} <span class="soft">· created by ${esc(store.userName(r.createdBy))} on ${fmtValue('ts', r.createdAt)} · last updated ${fmtValue('ts', r.updatedAt)} by ${esc(store.userName(r.updatedBy))}</span>`,
      actions: actions.map((a, i) => `<button type="button" class="btn ${a.cls}" data-act="run" data-i="${i}">${a.ic ? icon(a.ic) : ''}${esc(a.label)}</button>`).join('') })}
      <div class="stack"><section class="panel"><div class="body">${dl(fields)}</div></section>${fin}${coll === 'purchaseRequests' ? quotationComparison(r, pid) : ''}
      ${rel.map((x) => `<section class="panel"><header><h2>${esc(x.title)}</h2><span class="muted small">${x.rows.length}</span></header>${table({ cols: listCols(x.coll, { withProject: false }), rows: x.rows, href: (y) => hrefOf(x.coll, { ...y, pid }) })}</section>`).join('')}
      ${pid ? panelsHtml() : panelsHtml(['history'])}</div>`,
    actions: { run: (d) => runAction(actions[Number(d.i)]) },
    mount(root) { mountPanels(root, ctx, { coll, pid: pid || '_global', rid: id }); },
  };
}
function linkTo(name, value, pid) {
  const coll = { prId: 'purchaseRequests', poId: 'purchaseOrders', requirementId: 'procurement', transferId: 'stockTransfers', mrId: 'materialRequests', dispatchId: 'dispatches', gatePassId: 'gatePasses', quotationId: 'quotations', selectedQuotationId: 'quotations', piId: 'proformaInvoices' }[name];
  return pid && store.get(coll, pid, value) ? `<a href="#/r/${coll}/${esc(pid)}/${encodeURIComponent(value)}">${esc(value)}</a>` : esc(value);
}
