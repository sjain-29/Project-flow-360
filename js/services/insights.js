/**
 * Read-only calculations over the data the user is allowed to see:
 * deadlines (section 19), progress and health (27), expenditure (29) and KPIs (20).
 *
 * Nothing here ever changes a record. In particular, the deadline engine only
 * LABELS activities as due / overdue — it never touches a workflow status.
 */
import { store } from './store.js';
import { STAGE_TEMPLATES, stageTemplate, defaultSettings } from '../config/app-config.js';
import { itemQuantities } from './quantities.js';
import { daysBetween, today, sum, num, round, groupBy } from '../utils/format.js';

const CLOSED = ['Completed', 'Cancelled'];
const REPL = 'Source Stock Replenishment';
const cfg = () => ({ ...defaultSettings(), ...store.settings(), health: { ...defaultSettings().health, ...(store.settings().health || {}) }, stageScores: { ...defaultSettings().stageScores, ...(store.settings().stageScores || {}) } });
export const liveItems = (pid) => store.where('projectItems', pid, (i) => i.itemStatus !== 'Cancelled');
const openProject = (pid) => { const p = store.project(pid); return p && !CLOSED.includes(p.status); };

/* ------------------------------------------------------------------ deadlines */
export const DUE_LABEL = { overdue: 'Overdue', today: 'Due today', soon: 'Due soon', upcoming: 'Upcoming', ontrack: 'On track', none: 'No date' };

/** Classify a due date. Categories: overdue | today | soon (≤3 d) | upcoming (≤7 d) | ontrack | none */
export function dueInfo(due, todayIso = today()) {
  if (!due) return { cat: 'none', days: null, overdueDays: 0 };
  const s = cfg();
  const days = daysBetween(todayIso, due);
  if (days < 0) return { cat: 'overdue', days, overdueDays: -days };
  if (days === 0) return { cat: 'today', days, overdueDays: 0 };
  if (days <= s.dueSoonDays) return { cat: 'soon', days, overdueDays: 0 };
  if (days <= s.upcomingDays) return { cat: 'upcoming', days, overdueDays: 0 };
  return { cat: 'ontrack', days, overdueDays: 0 };
}

/**
 * Every open, dated activity the user can see: workflow stages, RGP returns,
 * logistics deliveries and vendor deliveries waiting for receipt.
 */
export function activities(pid, todayIso = today()) {
  const out = [];
  const add = (a) => { const d = dueInfo(a.due, todayIso); out.push({ ...a, ...d, projectName: store.project(a.pid)?.name || a.pid }); };
  const itemOf = (p, id) => store.get('projectItems', p, id);
  for (const s of store.list('stages', pid)) {
    if (!openProject(s.pid) || CLOSED.includes(s.status) || !s.expEnd) continue;
    const it = itemOf(s.pid, s.itemId);
    if (!it || it.itemStatus === 'Cancelled') continue;
    add({ key: `stage:${s.pid}:${s.id}`, kind: 'stage', pid: s.pid, itemId: s.itemId, itemCode: it.itemCode, label: s.branch === 'B' ? `${s.name} (replenishment)` : s.name, module: s.module, stageKey: s.key, branch: s.branch,
      deptId: s.deptId, personId: s.personId, due: s.expEnd, status: s.status, priority: it.priority, link: `#/items/${s.pid}/${s.itemId}?stage=${encodeURIComponent(s.id)}` });
  }
  for (const g of store.list('gatePasses', pid)) {
    if (g.type !== 'RGP' || !g.expectedReturn || !['Issued', 'Partially Returned'].includes(g.status) || !openProject(g.pid)) continue;
    add({ key: `rgp:${g.pid}:${g.id}`, kind: 'rgp', pid: g.pid, itemId: g.itemId, itemCode: g.itemCode || '—', label: `RGP return ${g.id}`, module: 'gatepass', deptId: 'planning', personId: g.generatedBy, due: g.expectedReturn, status: g.status, link: `#/r/gatePasses/${g.pid}/${g.id}` });
  }
  for (const l of store.list('logistics', pid)) {
    if (!l.expectedDelivery || ['Delivered', 'Cancelled'].includes(l.status) || !openProject(l.pid)) continue;
    add({ key: `log:${l.pid}:${l.id}`, kind: 'logistics', pid: l.pid, itemId: l.itemId, itemCode: itemOf(l.pid, l.itemId)?.itemCode || '—', label: `Logistics delivery ${l.id}`, module: 'logistics', deptId: 'logistics', personId: l.assignedPersonId, due: l.expectedDelivery, status: l.status, link: `#/r/logistics/${l.pid}/${l.id}` });
  }
  for (const d of store.list('dispatches', pid)) {
    if (!d.expectedDelivery || num(d.receivedQty) >= num(d.qty) || !openProject(d.pid)) continue;
    add({ key: `dsp:${d.pid}:${d.id}`, kind: 'dispatch', pid: d.pid, itemId: d.itemId, itemCode: d.itemCode, label: `Vendor delivery ${d.id} awaiting receipt`, module: 'receipts', deptId: 'stores', due: d.expectedDelivery, status: 'Awaiting receipt', link: `#/r/dispatches/${d.pid}/${d.id}` });
  }
  return out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
}
export const overdue = (pid, todayIso) => activities(pid, todayIso).filter((a) => a.cat === 'overdue');

/* ------------------------------------------------------------------ progress */
export const stageWeight = (s) => { const w = cfg().stageWeights?.[s.key]; return w !== undefined && w !== null && w !== '' ? Number(w) : (stageTemplate(s.branch, s.key)?.w ?? 1); };
export const stageScore = (s) => cfg().stageScores[s.status] ?? 0;
const weighted = (stages) => { const live = stages.filter((s) => s.status !== 'Cancelled'); const w = sum(live, stageWeight); return w ? sum(live, (s) => stageWeight(s) * stageScore(s)) / w : null; };
const groupOfStage = (s) => stageTemplate(s.branch, s.key)?.group;

/** Progress of one item (branch A only — replenishment never counts as project progress). */
export function itemProgress(pid, itemId) {
  const all = store.where('stages', pid, (s) => s.itemId === itemId);
  const a = all.filter((s) => s.branch === 'A');
  const g = (name) => weighted(a.filter((s) => groupOfStage(s) === name));
  return { overall: weighted(a) ?? 0, procurement: g('procurement'), material: g('material'), development: g('development'), testing: g('testing'), replenishment: weighted(all.filter((s) => s.branch === 'B')) };
}

const avg = (xs) => { const v = xs.filter((x) => x !== null && x !== undefined); return v.length ? sum(v, (x) => x) / v.length : null; };
/** Project progress = average of its items' weighted stage progress (weights and scores are editable in Settings). */
export function projectProgress(pid) {
  const items = liveItems(pid);
  const ip = items.map((i) => itemProgress(pid, i.id));
  const led = items.map((i) => itemQuantities(pid, i.id));
  const required = sum(led, 'required');
  return {
    items: items.length,
    overall: avg(ip.map((p) => p.overall)) ?? 0,
    procurement: avg(ip.map((p) => p.procurement)),
    material: required ? Math.min(1, sum(led, 'accepted') / required) : null,
    development: avg(ip.map((p) => p.development)),
    testing: avg(ip.map((p) => p.testing)),
    replenishment: avg(ip.map((p) => p.replenishment)),
  };
}

/* ------------------------------------------------------------------ pending approvals */
export function pendingApprovals(pid) {
  const out = [];
  const add = (coll, r, label, perm, since) => out.push({ coll, pid: r.pid, id: r.id, label, perm, since: since || r.updatedAt || r.createdAt, itemCode: r.itemCode, link: `#/r/${coll}/${r.pid}/${encodeURIComponent(r.id)}` });
  for (const r of store.list('purchaseRequests', pid)) if (r.status === 'Pending Approval') add('purchaseRequests', r, `PR ${r.id}`, 'pr.approve');
  for (const r of store.list('stockTransfers', pid)) if (r.status === 'Requested' && store.settings().transferApprovalRequired !== false) add('stockTransfers', r, `Stock transfer ${r.id}`, 'transfers.approve');
  for (const r of store.list('procurement', pid)) if (['Pending Approval', 'Under Review'].includes(r.status)) add('procurement', r, `${r.status === 'Under Review' ? 'Replenishment review' : 'Additional material'} ${r.id}`, 'procurement.approve');
  for (const r of store.list('materialRequests', pid)) if (r.status === 'Created') add('materialRequests', r, `MR ${r.id}`, 'mr.approve');
  for (const r of store.list('gatePasses', pid)) if (['Pending Approval', 'Returned – Pending Closure'].includes(r.status)) add('gatePasses', r, `${r.status === 'Pending Approval' ? 'Gate pass' : 'RGP closure'} ${r.id}`, 'gatepass.approve');
  for (const r of store.list('travelDesk', pid)) if (r.approvalStatus === 'Pending' && r.status !== 'Cancelled') add('travelDesk', r, `Travel request ${r.id}`, 'travel.approve');
  for (const r of store.list('testing', pid)) if (r.status === 'Passed') add('testing', r, `Test approval ${r.itemCode} cycle ${r.cycle}`, 'testing.approve');
  return out.filter((a) => openProject(a.pid));
}

/* ------------------------------------------------------------------ project health */
/**
 * Green / Amber / Red from configurable rules (Settings → Project health).
 * Every rule that fires is returned as a reason, so the status is never a black box.
 */
export function projectHealth(pid, todayIso = today()) {
  const p = store.project(pid);
  if (!p) return { level: 'none', label: '—', reasons: [] };
  if (CLOSED.includes(p.status)) return { level: 'closed', label: p.status, reasons: [] };
  const h = cfg().health;
  const od = overdue(pid, todayIso);
  const red = []; const amber = [];
  const critical = od.filter((a) => ['High', 'Critical'].includes(a.priority));
  if (h.redOverdueCritical > 0 && critical.length >= h.redOverdueCritical) red.push(`${critical.length} overdue activit${critical.length === 1 ? 'y' : 'ies'} on high-priority or critical items`);
  const worst = Math.max(0, ...od.map((a) => a.overdueDays));
  if (h.redOverdueDays > 0 && worst >= h.redOverdueDays) red.push(`An activity is ${worst} days overdue`);
  const items = liveItems(pid);
  const failed = items.filter((i) => { const t = store.where('testing', pid, (x) => x.itemId === i.id).sort((a, b) => a.cycle - b.cycle).slice(-1)[0]; return t && t.status === 'Failed'; });
  if (h.redTestFailures > 0 && failed.length >= h.redTestFailures) red.push(`${failed.length} items have an unresolved test failure`);
  else if (failed.length) amber.push(`${failed.length} item${failed.length === 1 ? ' has' : 's have'} an unresolved test failure`);
  if (h.amberOverdue > 0 && od.length >= h.amberOverdue) amber.push(`${od.length} overdue activit${od.length === 1 ? 'y' : 'ies'}`);
  const stale = pendingApprovals(pid).filter((a) => a.since && (Date.now() - a.since) / 86400000 >= h.amberPendingApprovalDays);
  if (stale.length) amber.push(`${stale.length} approval${stale.length === 1 ? '' : 's'} waiting ${h.amberPendingApprovalDays}+ days`);
  const uncovered = items.filter((i) => itemQuantities(pid, i.id).uncovered > 0);
  if (h.amberUncoveredItems > 0 && uncovered.length >= h.amberUncoveredItems) amber.push(`${uncovered.length} item${uncovered.length === 1 ? ' has' : 's have'} a material shortage with no procurement planned`);
  const rgp = od.filter((a) => a.kind === 'rgp');
  if (h.amberRgpOverdue > 0 && rgp.length >= h.amberRgpOverdue) amber.push(`${rgp.length} returnable gate pass${rgp.length === 1 ? '' : 'es'} overdue`);
  if (p.targetDate && daysBetween(todayIso, p.targetDate) < 0) amber.push(`Target completion date passed ${-daysBetween(todayIso, p.targetDate)} days ago`);
  if (red.length) return { level: 'red', label: 'Critical', reasons: [...red, ...amber] };
  if (amber.length) return { level: 'amber', label: 'At risk', reasons: amber };
  return { level: 'green', label: 'On track', reasons: ['No overdue activities, stale approvals, uncovered shortages or test failures'] };
}

/* ------------------------------------------------------------------ expenditure */
/** Financial summary of a project. Project procurement and replenishment are kept apart; "total" adds each PO once. */
export function projectExpenditure(pid) {
  const p = store.project(pid) || {};
  const items = liveItems(pid);
  const pos = store.where('purchaseOrders', pid, (x) => x.status !== 'Cancelled');
  const poIds = new Set(pos.map((x) => x.id));
  const pis = store.where('proformaInvoices', pid, (x) => poIds.has(x.poId));
  const prs = store.where('purchaseRequests', pid, (x) => !['Rejected', 'Cancelled'].includes(x.status));
  const estOf = (itemId) => num(store.get('projectItems', pid, itemId)?.estUnitCost);
  const prValue = (pr) => { const q = pr.selectedQuotationId ? store.get('quotations', pid, pr.selectedQuotationId) : null; return q ? num(q.totalAmount) : num(pr.qty) * estOf(pr.itemId); };
  const part = (filter) => {
    const po = pos.filter(filter); const ids = new Set(po.map((x) => x.id));
    const payable = sum(po, (x) => num(x.totalValue) + num(x.adjTotal));
    const paid = sum(po, 'paidTotal');
    return { pr: round(sum(prs.filter((x) => filter({ procurementType: x.procurementType })), prValue), 2), ordered: round(sum(po, 'totalValue'), 2), adjustments: round(sum(po, 'adjTotal'), 2), invoiced: round(sum(pis.filter((x) => ids.has(x.poId)), 'totalAmount'), 2), paid: round(paid, 2), outstanding: round(Math.max(0, payable - paid), 2) };
  };
  const byItem = items.map((i) => {
    const po = pos.filter((x) => x.itemId === i.id && x.procurementType !== REPL); const ids = new Set(po.map((x) => x.id));
    const repl = pos.filter((x) => x.itemId === i.id && x.procurementType === REPL);
    return { itemId: i.id, itemCode: i.itemCode, name: i.name, estimated: round(num(i.requiredQty) * num(i.estUnitCost), 2), ordered: round(sum(po, 'totalValue'), 2), invoiced: round(sum(pis.filter((x) => ids.has(x.poId)), 'totalAmount'), 2), paid: round(sum(po, 'paidTotal'), 2), replenishment: round(sum(repl, 'totalValue'), 2) };
  });
  const byVendor = Object.entries(groupBy(pos, 'vendorName')).map(([vendor, po]) => ({ vendor, pos: po.length, ordered: round(sum(po, 'totalValue'), 2), paid: round(sum(po, 'paidTotal'), 2), outstanding: round(Math.max(0, sum(po, (x) => num(x.totalValue) + num(x.adjTotal)) - sum(po, 'paidTotal')), 2) })).sort((a, b) => b.ordered - a.ordered);
  return {
    budget: num(p.budget), estimated: round(sum(byItem, 'estimated'), 2),
    project: part((x) => x.procurementType !== REPL), replenishment: part((x) => x.procurementType === REPL), total: part(() => true),
    byItem, byVendor, canSee: true,
  };
}

/* ------------------------------------------------------------------ dashboard KPIs */
export function kpis(todayIso = today()) {
  const projects = store.projects();
  const count = (s) => projects.filter((p) => p.status === s).length;
  const open = new Set(projects.filter((p) => !CLOSED.includes(p.status)).map((p) => p.id));
  const items = store.list('projectItems').filter((i) => i.itemStatus !== 'Cancelled');
  const openItems = items.filter((i) => open.has(i.pid));
  const reqs = store.list('procurement').filter((r) => open.has(r.pid));
  const awaitingProc = new Set(reqs.filter((r) => ['Open', 'Under Review', 'Pending Approval'].includes(r.status)).map((r) => `${r.pid}/${r.itemId}`));
  const pos = store.list('purchaseOrders').filter((p) => open.has(p.pid) && p.status === 'Issued');
  const awaitingReceipt = new Set(pos.filter((p) => num(p.acceptedQty) < num(p.quantity)).map((p) => `${p.pid}/${p.itemId}`));
  for (const t of store.list('stockTransfers')) if (open.has(t.pid) && !['Cancelled', 'Rejected', 'Received'].includes(t.status)) awaitingReceipt.add(`${t.pid}/${t.itemId}`);
  return {
    totalProjects: projects.length, active: count('Active'), planning: count('Planning'), completed: count('Completed'), onHold: count('On Hold'), cancelled: count('Cancelled'),
    totalItems: items.length,
    awaitingProcurement: awaitingProc.size,
    awaitingReceipt: awaitingReceipt.size,
    pendingPRs: reqs.filter((r) => r.status === 'Open').length,
    pendingPRApprovals: store.list('purchaseRequests').filter((r) => open.has(r.pid) && r.status === 'Pending Approval').length,
    pendingPayments: pos.filter((p) => num(p.totalValue) + num(p.adjTotal) - num(p.paidTotal) > 0.005).length,
    overdue: overdue(undefined, todayIso).length,
    unverifiedItems: openItems.filter((i) => !store.get('inventoryChecks', i.pid, i.id)).length,
  };
}

/** Where each procurement line currently stands (for the stage-distribution chart and reports). */
export function procurementStage(req) {
  if (['Cancelled', 'Rejected'].includes(req.status)) return req.status;
  if (req.status === 'Pending Approval') return 'Awaiting approval of request';
  if (req.status === 'Under Review') return 'Under review';
  const pr = req.prId ? store.get('purchaseRequests', req.pid, req.prId) : null;
  if (!pr) return 'Awaiting PR';
  if (pr.status !== 'Approved') return pr.status === 'Pending Approval' ? 'PR pending approval' : `PR ${pr.status.toLowerCase()}`;
  const pos = store.where('purchaseOrders', req.pid, (p) => p.prId === pr.id && p.status !== 'Cancelled');
  if (!pos.length) return pr.selectedQuotationId ? 'Vendor selected — awaiting PO' : 'Quotations';
  const qty = sum(pos, 'quantity'); const disp = sum(pos, 'dispatchedQty'); const acc = sum(pos, 'acceptedQty');
  if (acc >= qty - 0.001 && qty >= num(pr.qty) - 0.001) return 'Received';
  if (disp > 0) return acc > 0 ? 'Partially received' : 'Dispatched by vendor';
  return 'PO issued — awaiting dispatch';
}
export const STAGE_GROUPS = [...new Set(STAGE_TEMPLATES.map((t) => t.group))];
