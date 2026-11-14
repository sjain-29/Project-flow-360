/**
 * The item workflow as two parallel tracks:
 *   Branch A — project material fulfilment (availability → … → closure)
 *   Branch B — source stock replenishment (only when in-house stock was used)
 * Every stop is a workflow stage; clicking it opens the stage with its evidence.
 */
import { store } from '../services/store.js';
import { itemStages, updateStage, canPlanStage, canUpdateStage } from '../services/stages.js';
import { dueInfo } from '../services/insights.js';
import { itemQuantities } from '../services/quantities.js';
import { STAGE_STATUSES } from '../config/app-config.js';
import { esc, icon, badge, formModal, fmtValue } from './ui.js';
import { fmtDate, fmtQty, sum } from '../utils/format.js';

const REPL = 'Source Stock Replenishment';
const cls = (s) => (s.status === 'Completed' ? 'done' : s.status === 'In Progress' ? 'active' : s.status === 'Waiting for Approval' ? 'wait' : ['Blocked', 'On Hold'].includes(s.status) ? 'held' : s.status === 'Cancelled' ? 'off' : '');
const glyph = (s) => (s.status === 'Completed' ? 'check' : s.status === 'Waiting for Approval' ? 'time' : ['Blocked', 'On Hold'].includes(s.status) ? 'alert' : s.status === 'Cancelled' ? 'x' : 'chevRight');

export function workflowHtml(pid, itemId, selected) {
  const a = itemStages(pid, itemId, 'A'); const b = itemStages(pid, itemId, 'B');
  if (!a.length) return '<div class="empty"><b>The workflow starts with the in-house availability check.</b>Once Stores has verified availability, the stages for this item appear here.</div>';
  const stop = (s) => {
    const due = s.expEnd && !['Completed', 'Cancelled'].includes(s.status) ? dueInfo(s.expEnd) : null;
    const sub = s.status === 'Completed' ? (s.actEnd ? fmtDate(s.actEnd) : 'Completed') : due?.cat === 'overdue' ? `${due.overdueDays} d overdue` : s.expEnd ? `due ${fmtDate(s.expEnd)}` : s.status;
    return `<button type="button" class="stop ${cls(s)} ${due?.cat === 'overdue' ? 'late' : ''} ${selected === s.id ? 'sel' : ''}" data-act="stage" data-id="${esc(s.id)}" title="${esc(`${s.name} — ${s.status}`)}"><i>${icon(glyph(s))}</i><span>${esc(s.name)}</span><small>${esc(sub)}</small></button>`;
  };
  return `<div class="flow">
    <div class="track"><div class="track-label"><b>Branch A</b><span>Project fulfilment</span></div>${a.map(stop).join('')}</div>
    ${b.length ? `<div class="track"><div class="track-label"><b>Branch B</b><span>Source stock replenishment</span></div>${b.map(stop).join('')}</div>` : ''}
  </div>`;
}

/** What the records say about a stage: a summary and links to the linked records. */
export function stageEvidence(pid, s) {
  const of = (coll, pred = () => true) => store.where(coll, pid, (r) => r.itemId === s.itemId && pred(r));
  const type = s.branch === 'B' ? (r) => (r.procurementType || r.type) === REPL : (r) => (r.procurementType || r.type) !== REPL;
  const link = (coll, r, label) => ({ href: `#/r/${coll}/${pid}/${encodeURIComponent(r.id)}`, label: label || r.id, status: r.status });
  const q = itemQuantities(pid, s.itemId);
  const prs = of('purchaseRequests', type); const pos = of('purchaseOrders', type); const poIds = new Set(pos.map((p) => p.id));
  switch (s.key) {
    case 'availability': { const c = store.get('inventoryChecks', pid, s.itemId); return { text: c ? `${c.availability}: ${fmtQty(c.availableQty)} available of ${fmtQty(c.requiredQty)} required. Transfer ${fmtQty(c.transferQty)}, shortage ${fmtQty(c.shortageQty)}.` : 'Not verified yet.', links: [] }; }
    case 'transfer': { const t = of('stockTransfers'); return { text: `${fmtQty(q.transferred)} dispatched of ${fmtQty(q.transferPlanned)} planned.`, links: t.map((r) => link('stockTransfers', r)) }; }
    case 'projReceipt': { const t = of('stockTransfers'); return { text: `${fmtQty(q.transferAccepted)} accepted at the requesting department of ${fmtQty(q.transferPlanned)} planned.`, links: t.map((r) => link('stockTransfers', r)) }; }
    case 'pr': { const reqs = of('procurement', type); return { text: prs.length ? `${prs.length} PR(s) raised.` : `${reqs.filter((r) => r.status === 'Open').length} requirement(s) waiting for a PR.`, links: [...reqs.map((r) => link('procurement', r)), ...prs.map((r) => link('purchaseRequests', r))] }; }
    case 'prApproval': return { text: prs.length ? prs.map((r) => `${r.id}: ${r.status}`).join('; ') : 'No PR yet.', links: prs.map((r) => link('purchaseRequests', r)) };
    case 'quotation': { const qs = store.where('quotations', pid, (x) => prs.some((p) => p.id === x.prId)); return { text: `${qs.length} quotation(s); ${prs.filter((p) => p.selectedQuotationId).length} of ${prs.length} PR(s) have a selected vendor.`, links: prs.map((r) => link('purchaseRequests', r, `${r.id} — comparison`)) }; }
    case 'po': return { text: `${fmtQty(sum(pos.filter((p) => p.status !== 'Cancelled'), 'quantity'))} ordered of ${fmtQty(sum(prs.filter((p) => p.status === 'Approved'), 'qty'))} approved.`, links: pos.map((r) => link('purchaseOrders', r)) };
    case 'pi': { const pis = store.where('proformaInvoices', pid, (x) => poIds.has(x.poId)); return { text: `${pis.length} proforma invoice(s) recorded.`, links: pos.map((r) => link('purchaseOrders', r)) }; }
    case 'payment': return { text: store.list('payments', pid).length || pos.some((p) => 'paidTotal' in p) ? `${pos.filter((p) => p.status !== 'Cancelled' && Number(p.totalValue) + Number(p.adjTotal || 0) - Number(p.paidTotal || 0) > 0.005).length} of ${pos.length} PO(s) have an outstanding amount.` : 'Payment details are visible to authorised users only.', links: pos.map((r) => link('purchaseOrders', r)) };
    case 'dispatch': { const d = of('dispatches', type); return { text: `${fmtQty(sum(d, 'qty'))} dispatched by vendors of ${fmtQty(sum(pos.filter((p) => p.status !== 'Cancelled'), 'quantity'))} ordered.`, links: d.map((r) => link('dispatches', r)) }; }
    case 'spifReceipt': { const g = of('materialReceipts', type); return { text: `${fmtQty(sum(g, 'acceptedQty'))} accepted, ${fmtQty(sum(g, 'rejectedQty'))} rejected in ${g.length} GRN(s).`, links: g.map((r) => link('materialReceipts', r)) }; }
    case 'mr': { const m = of('materialRequests'); return { text: `${m.length} material request(s); ${fmtQty(sum(m, 'dispatchedQty'))} dispatched to GVT.`, links: m.map((r) => link('materialRequests', r)) }; }
    case 'logistics': { const l = of('logistics'); return { text: `${l.length} logistics request(s).`, links: l.map((r) => link('logistics', r)) }; }
    case 'gvtReceipt': { const g = of('gvtReceipts'); return { text: `${fmtQty(sum(g, 'acceptedQty'))} accepted at GVT in ${g.length} receipt(s).`, links: g.map((r) => link('gvtReceipts', r)) }; }
    case 'development': { const d = store.get('development', pid, s.itemId); return { text: d ? `Development is “${d.status}”, revision ${d.revision || 1}${d.reopenCount ? `, reopened ${d.reopenCount}×` : ''}.` : 'Development has not been started.', links: d ? [link('development', d, 'Development record')] : [] }; }
    case 'testing': { const t = of('testing').sort((x, y) => x.cycle - y.cycle); return { text: t.length ? t.map((x) => `Cycle ${x.cycle}: ${x.status}`).join('; ') : 'No test cycle yet.', links: t.map((r) => link('testing', r, `Cycle ${r.cycle}`)) }; }
    case 'closure': { const it = store.get('projectItems', pid, s.itemId); return { text: `Item status: ${it?.itemStatus || 'Open'}. Outstanding quantity: ${fmtQty(q.outstanding)}.`, links: [] }; }
    default: return { text: '', links: [] };
  }
}

/** Stage dialog: details, evidence, and — for authorised people — planning and status. */
export function openStage(pid, id) {
  const s = store.get('stages', pid, id);
  if (!s) return null;
  const ev = stageEvidence(pid, s);
  const plan = canPlanStage(s, pid); const upd = canUpdateStage(s, pid);
  const due = s.expEnd && !['Completed', 'Cancelled'].includes(s.status) ? dueInfo(s.expEnd) : null;
  const info = `<dl class="dl" style="margin-bottom:12px"><div><dt>Status</dt><dd>${badge(s.status)}${due?.cat === 'overdue' ? ` ${badge(`Overdue ${due.overdueDays} d`, 'crit')}` : ''}</dd></div><div><dt>Branch</dt><dd>${s.branch === 'B' ? 'B — source stock replenishment' : 'A — project fulfilment'}</dd></div><div><dt>Last updated</dt><dd>${esc(store.userName(s.updatedBy))}, ${fmtValue('ts', s.updatedAt)}</dd></div></dl>
    <p><b>What the records show:</b> ${esc(ev.text)}</p>${ev.links.length ? `<p>${ev.links.map((l) => `<a href="${l.href}" data-close-modal>${esc(l.label)}</a>${l.status ? ` ${badge(l.status)}` : ''}`).join(' &nbsp; ')}</p>` : ''}
    <p class="muted small">A stage is never completed by a date. Dates only decide whether it is shown as due or overdue; the status is set by an authorised person.</p>`;
  const fields = [{ type: 'static', name: '_info', html: info }];
  if (plan) fields.push({ name: 'deptId', label: 'Responsible department', type: 'dept' }, { name: 'personId', label: 'Responsible person', type: 'user', main: true }, { name: 'expStart', label: 'Expected start date', type: 'date', main: true }, { name: 'expEnd', label: 'Expected completion date', type: 'date', main: true });
  if (upd) fields.push({ name: 'status', label: 'Status', type: 'select', req: true, opts: STAGE_STATUSES }, { name: 'actStart', label: 'Actual start date', type: 'date' }, { name: 'actEnd', label: 'Actual completion date', type: 'date', hint: 'Filled in automatically when you set “Completed”.' });
  if (plan) fields.push({ name: 'remarks', label: 'Remarks', type: 'textarea' });
  const p = formModal({ title: s.name, wide: true, fields, values: s, submitLabel: plan || upd ? 'Save stage' : 'Close', successMessage: plan || upd ? 'Stage updated.' : false, onSubmit: (v) => (plan || upd ? updateStage(pid, id, v) : true) });
  setTimeout(() => document.querySelectorAll('[data-close-modal]').forEach((a) => a.addEventListener('click', () => document.querySelector('.modal-back [data-close]')?.click())), 60);
  return p;
}
