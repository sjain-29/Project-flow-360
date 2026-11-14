/** Item detail page (section 18): quantities, the two-branch workflow, linked records. */
import { store } from '../services/store.js';
import { can, canAny } from '../services/session.js';
import * as P from '../services/projects.js';
import { addMovementStages } from '../services/stages.js';
import { itemQuantities } from '../services/quantities.js';
import { itemProgress } from '../services/insights.js';
import { itemTests } from '../services/devtest.js';
import { ENTITIES, formFields } from '../config/entities.js';
import { esc, badge, table, pageHead, btn, tabsBar, dl, toast, formModal, confirmDialog, fmtValue, withBusy } from '../components/ui.js';
import { panelsHtml, mountPanels } from '../components/panels.js';
import { workflowHtml, openStage } from '../components/workflow.js';
import { verifyAvailabilityForm, coverageForm, additionalMaterialForm, startDevForm, testCycleForm, mrForm, prForm, newRecordForm } from '../actions.js';
import { fmtQty, pct } from '../utils/format.js';

const REPL = 'Source Stock Replenishment';
const cols = (coll, extra = []) => [{ key: 'id', label: ENTITIES[coll].idLabel || 'Ref', cls: 'id' }, ...ENTITIES[coll].fields.filter((f) => f.list && !['itemCode', 'itemName'].includes(f.name)).map((f) => ({ key: f.name, label: f.label, type: f.name === 'status' || f.name === 'approvalStatus' || f.name === 'inspectionStatus' ? 'status' : f.type })), ...extra];

export function itemView(ctx) {
  const [pid, itemId] = ctx.params;
  const p = store.project(pid); const it = store.get('projectItems', pid, itemId);
  if (!p || !it) return { title: 'Item', html: '<div class="panel"><div class="empty"><b>This item was not found, or you do not have access to its project.</b><a href="#/projects">All projects</a></div></div>' };
  const closed = ['Completed', 'Cancelled'].includes(p.status) || it.itemStatus !== 'Open' || it.deleted;
  const q = itemQuantities(pid, itemId);
  const check = store.get('inventoryChecks', pid, itemId);
  const dev = store.get('development', pid, itemId);
  const tests = itemTests(pid, itemId);
  const of = (coll, pred = () => true) => (can(`${ENTITIES[coll].module}.view`, pid) ? store.where(coll, pid, (r) => r.itemId === itemId && pred(r)) : []);
  const reqs = of('procurement');
  const hasMove = !!store.get('stages', pid, `${itemId}__A_mr`);
  const tab = ['workflow', 'records', 'discussion', 'documents', 'history'].includes(ctx.query.get('tab')) ? ctx.query.get('tab') : 'workflow';

  // next steps the signed-in user is allowed to take
  const next = [];
  if (!closed) {
    if (!check && can('inventory.create', pid)) next.push(btn('verify', 'Verify in-house availability', { ic: 'stock', cls: 'primary' }));
    for (const r of reqs.filter((x) => x.status === 'Open')) if (can('pr.create', pid)) next.push(btn('raisePr', `Raise PR — ${r.type === REPL ? 'replenishment' : 'project'} (${fmtQty(r.qty)})`, { ic: 'doc', cls: 'primary', data: { id: r.id } }));
    if (q.uncovered > 0 && can('procurement.create', pid)) next.push(btn('coverage', `Procure uncovered quantity (${fmtQty(q.uncovered)})`, { ic: 'cart', cls: 'primary' }));
    if (check && q.spifAvailable > 0 && can('mr.create', pid)) next.push(btn('mr', 'Material request SPIF → GVT', { ic: 'clipboard' }));
    if (check && !dev && can('development.create', pid)) next.push(btn('startDev', 'Start development', { ic: 'wrench' }));
    if (dev?.status === 'Completed' && !tests.some((t) => ['Not Started', 'In Progress', 'Passed'].includes(t.status)) && tests.slice(-1)[0]?.status !== 'Approved' && can('testing.create', pid)) next.push(btn('testCycle', `New test cycle (${tests.length + 1})`, { ic: 'flask', cls: 'primary' }));
    if (check && canAny(['development.create', 'development.edit'], pid)) next.push(btn('additional', 'Request additional material', { ic: 'plus' }));
    if (can('gatepass.create', pid)) next.push(btn('gatepass', 'Gate pass', { ic: 'ticket' }));
    if (can('logistics.create', pid)) next.push(btn('logistics', 'Logistics request', { ic: 'truck' }));
    if (check && !hasMove && canAny(['items.edit', 'procurement.create', 'inventory.create'], pid)) next.push(btn('moveStages', 'Add SPIF → GVT stages', { cls: 'ghost' }));
  }
  const cell = (label, v, cls = '') => `<div class="kpi ${cls}"><b>${esc(fmtQty(v))}</b><span>${esc(label)}</span></div>`;
  const ledger = `<div class="kpis">${cell('Required', q.required)}${cell('Available in-house', q.available)}${cell('Reserved for transfer', q.reserved)}${cell('Transferred', q.transferred)}${cell('Procured for project', q.procuredProject)}${cell('Procured for replenishment', q.procuredReplenishment)}${cell('Dispatched', q.dispatched)}${cell('Received', q.received)}${cell('Accepted', q.accepted)}${cell('Rejected', q.rejected, q.rejected ? 'warn' : '')}${cell('Outstanding', q.outstanding, q.outstanding ? 'warn' : '')}</div>
    ${q.uncovered > 0 ? `<div class="note warn" style="margin-top:12px"><b>${fmtQty(q.uncovered)} unit(s) are not covered</b> by a stock transfer or by project procurement (for example after a cancelled transfer or rejected stock). Raise project procurement for the uncovered quantity.</div>` : ''}
    ${q.pendingExtra > 0 ? `<div class="note" style="margin-top:12px">${fmtQty(q.pendingExtra)} additional unit(s) requested by Development are waiting for approval.</div>` : ''}`;

  let body;
  if (tab === 'workflow') {
    const ip = itemProgress(pid, itemId);
    body = `<div class="stack"><section class="panel"><header><h2>Quantities</h2><span class="muted small">Replenishment purchases are for the source department and never count towards the project.</span></header><div class="body">${ledger}</div></section>
      <section class="panel"><header><h2>Workflow</h2><span class="soft small">${pct(ip.overall)} complete</span></header><div class="body">${workflowHtml(pid, itemId, ctx.query.get('stage'))}<p class="muted small" style="margin:8px 0 0">Select a stage to see its details, linked records, responsible person and dates.</p></div></section>
      <section class="panel"><header><h2>Item information</h2></header><div class="body">${dl([...formFields('projectItems').map((f) => [f.label, it[f.name] !== undefined && it[f.name] !== '' ? fmtValue(f.name === 'priority' ? 'status' : f.type, it[f.name]) : null]), ['Availability', check ? `${badge(check.availability)} verified by ${esc(store.userName(check.verifiedBy))} on ${fmtValue('date', check.verifiedAt)}${check.sourceDeptId ? `, source: ${esc(store.deptName(check.sourceDeptId))}` : ''}` : badge('Not verified')], ['Project', `<a href="#/projects/${esc(pid)}">${esc(pid)} — ${esc(p.name)}</a>`]])}</div></section></div>`;
  } else if (tab === 'records') {
    const sec = (title, coll, rows, extraCols) => (rows.length ? `<section class="panel"><header><h2>${title}</h2><span class="muted small">${rows.length}</span></header>${table({ cols: cols(coll, extraCols), rows, href: (r) => `#/r/${coll}/${pid}/${encodeURIComponent(r.id)}` })}</section>` : '');
    const parts = [
      sec('Procurement requirements', 'procurement', reqs), sec('Stock transfers', 'stockTransfers', of('stockTransfers')), sec('Purchase requests', 'purchaseRequests', of('purchaseRequests')), sec('Purchase orders', 'purchaseOrders', of('purchaseOrders')),
      sec('Vendor dispatches', 'dispatches', of('dispatches')), sec('Material receipts (GRN)', 'materialReceipts', of('materialReceipts')), sec('Material requests', 'materialRequests', of('materialRequests')), sec('GVT receipts', 'gvtReceipts', of('gvtReceipts')),
      sec('Gate passes', 'gatePasses', of('gatePasses')), sec('Logistics', 'logistics', of('logistics')),
      dev && can('development.view', pid) ? sec('Development', 'development', [dev]) : '', sec('Development updates', 'developmentUpdates', of('developmentUpdates').sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))), sec('Test cycles', 'testing', can('testing.view', pid) ? tests : []),
    ].filter(Boolean);
    body = parts.length ? `<div class="stack">${parts.join('')}</div>` : '<div class="panel"><div class="empty"><b>No linked records yet.</b>Records appear here as the item moves through its workflow.</div></div>';
  } else body = panelsHtml([{ discussion: 'comments', documents: 'documents', history: 'history' }[tab]]);

  const acts = closed ? (canAny(['items.updateStatus', 'closure.approve'], pid) && it.itemStatus !== 'Open' && !['Completed', 'Cancelled'].includes(p.status) ? btn('reopenItem', 'Reopen item', { ic: 'refresh' }) : '')
    : [can('items.edit', pid) ? btn('edit', 'Edit', { ic: 'edit' }) : '', can('items.create', pid) ? btn('duplicate', 'Duplicate', { ic: 'copy' }) : '', canAny(['items.updateStatus', 'closure.approve', 'closure.updateStatus'], pid) ? btn('closeItem', 'Close or cancel item', { ic: 'flag' }) : '', can('items.delete', pid) && !check ? btn('remove', 'Remove', { ic: 'trash', cls: 'danger' }) : ''].join('');
  return {
    title: `${it.itemCode} — ${it.name}`,
    html: `${pageHead({ crumbs: `<a href="#/projects">Projects</a> / <a href="#/projects/${esc(pid)}?tab=items">${esc(pid)}</a>`, title: `${esc(it.itemCode)} — ${esc(it.name)}`, sub: `${it.priority ? badge(it.priority) : ''} ${badge(it.itemStatus || 'Open')} <span class="soft">· ${esc(fmtQty(it.requiredQty))} ${esc(it.uom || '')} required${it.requiredBy ? ` by ${fmtValue('date', it.requiredBy)}` : ''} · development ${esc(dev?.status || 'not started')} · testing ${esc(tests.slice(-1)[0]?.status || 'not started')}</span>`, actions: acts })}
      ${next.length ? `<section class="panel" style="margin-bottom:16px"><header><h3>Next steps you can take</h3></header><div class="body actions">${next.join('')}</div></section>` : ''}
      ${tabsBar([['workflow', 'Workflow'], ['records', 'Linked records'], ['discussion', 'Comments'], ['documents', 'Documents'], ['history', 'History']], tab, (t) => `#/items/${pid}/${itemId}?tab=${t}`)}${body}`,
    actions: {
      stage: (d) => openStage(pid, d.id),
      verify: () => verifyAvailabilityForm(pid, it),
      raisePr: (d) => prForm(pid, store.get('procurement', pid, d.id)),
      coverage: () => coverageForm(pid, it), additional: () => additionalMaterialForm(pid, it), startDev: () => startDevForm(pid, it), testCycle: () => testCycleForm(pid, it), mr: () => mrForm(pid, it),
      gatepass: () => newRecordForm('gatePasses', pid, { itemId, qty: 1 }), logistics: () => newRecordForm('logistics', pid, { itemId }),
      moveStages: (d, el) => withBusy(el, () => addMovementStages(pid, itemId), 'Movement stages added.'),
      edit: () => formModal({ title: `Edit ${it.itemCode}`, wide: true, fields: formFields('projectItems'), values: it, onSubmit: (v) => P.updateItem(pid, itemId, v) }),
      duplicate: async () => { if (await confirmDialog({ title: 'Duplicate item', body: `This adds another item with the same item code <b>${esc(it.itemCode)}</b>. Two items with one code are tracked separately. Continue?`, confirmLabel: 'Duplicate' })) { const id = await P.duplicateItem(pid, itemId); toast('Item duplicated.'); location.hash = `#/items/${pid}/${id}`; } },
      remove: async () => { if (await confirmDialog({ title: 'Remove item', body: 'Remove this item from the bill of material? It has no transactions yet. The removal is recorded in the history.', danger: true, confirmLabel: 'Remove' })) { await P.removeItem(pid, itemId); toast('Item removed.'); location.hash = `#/projects/${pid}?tab=items`; } },
      closeItem: () => formModal({ title: `Close or cancel ${it.itemCode}`, intro: `Outstanding quantity: ${fmtQty(q.outstanding)} · development: ${esc(dev?.status || 'not started')} · testing: ${esc(tests.slice(-1)[0]?.status || 'not started')}.`, fields: [{ name: 'status', label: 'New item status', type: 'select', req: true, opts: ['Closed', 'Cancelled'] }, { name: 'reason', label: 'Reason / remarks', type: 'textarea', req: true }], onSubmit: (v) => P.setItemStatus(pid, itemId, v.status, { reason: v.reason }) }),
      reopenItem: (d, el) => withBusy(el, () => P.setItemStatus(pid, itemId, 'Open', { reason: 'Reopened' }), 'Item reopened.'),
    },
    mount(root) {
      if (['discussion', 'documents', 'history'].includes(tab)) mountPanels(root, ctx, { coll: 'projectItems', pid, rid: itemId });
      const sid = ctx.query.get('stage');
      if (sid && ctx.state.opened !== sid && store.get('stages', pid, sid)) { ctx.state.opened = sid; setTimeout(() => openStage(pid, sid), 50); }
    },
  };
}
