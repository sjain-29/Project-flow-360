/**
 * Controlled project closure (section 16).
 *
 * A project becomes Completed or Cancelled only together with a closure record
 * written by an authorised person; the security rules reject a status change
 * without one. Nothing is ever deleted: all history stays readable.
 */
import { store } from './store.js';
import { requirePerm, me, session } from './session.js';
import { runTx } from './tx.js';
import { recipients } from './notify.js';
import { liveItems, projectExpenditure } from './insights.js';
import { itemQuantities } from './quantities.js';
import { AppError, num, today } from '../utils/format.js';

export const CHECKS = [
  ['c_development', 'Development completed'],
  ['c_testing', 'Testing approved'],
  ['c_material', 'Required material received'],
  ['c_procurement', 'Outstanding procurement reviewed'],
  ['c_payments', 'Pending payments reviewed'],
  ['c_rgp', 'RGP items returned or formally resolved'],
  ['c_nrgp', 'NRGP records reviewed'],
  ['c_documents', 'Final documents uploaded'],
  ['c_approval', 'Authorised closure approval recorded'],
];

/**
 * The closure checklist. `auto` is what the system can see in the data
 * (true = fine, false = problem found, null = cannot be judged automatically);
 * every line additionally needs the approver's explicit confirmation.
 */
export function closureChecklist(pid) {
  const items = liveItems(pid).filter((i) => i.itemStatus !== 'Closed' || true);
  const devOpen = items.filter((i) => store.get('development', pid, i.id)?.status !== 'Completed');
  const testOpen = items.filter((i) => { const t = store.where('testing', pid, (x) => x.itemId === i.id).sort((a, b) => a.cycle - b.cycle).slice(-1)[0]; return !t || t.status !== 'Approved'; });
  const short = items.filter((i) => itemQuantities(pid, i.id).outstanding > 0.001 || !store.get('inventoryChecks', pid, i.id));
  const openReqs = store.where('procurement', pid, (r) => ['Open', 'Under Review', 'Pending Approval'].includes(r.status));
  const openPrs = store.where('purchaseRequests', pid, (r) => ['Pending Approval', 'Changes Requested'].includes(r.status));
  const openPos = store.where('purchaseOrders', pid, (p) => p.status === 'Issued' && num(p.acceptedQty) < num(p.quantity) - 0.001);
  const exp = projectExpenditure(pid);
  const gps = store.list('gatePasses', pid);
  const rgpOpen = gps.filter((g) => g.type === 'RGP' && !['Closed', 'Cancelled', 'Rejected'].includes(g.status));
  const nrgp = gps.filter((g) => g.type === 'NRGP');
  const n = (list, word) => `${list.length} ${word}${list.length === 1 ? '' : 's'}`;
  const auto = {
    c_development: [devOpen.length === 0, devOpen.length ? `${n(devOpen, 'item')} without completed development: ${devOpen.slice(0, 5).map((i) => i.itemCode).join(', ')}` : `Development completed for all ${items.length} items`],
    c_testing: [testOpen.length === 0, testOpen.length ? `${n(testOpen, 'item')} without an approved test: ${testOpen.slice(0, 5).map((i) => i.itemCode).join(', ')}` : 'Latest test cycle approved for all items'],
    c_material: [short.length === 0, short.length ? `${n(short, 'item')} with outstanding or unverified material: ${short.slice(0, 5).map((i) => i.itemCode).join(', ')}` : 'All required quantities accepted'],
    c_procurement: [openReqs.length + openPrs.length + openPos.length === 0, `${n(openReqs, 'open requirement')}, ${n(openPrs, 'undecided PR')}, ${n(openPos, 'PO')} not fully received`],
    c_payments: [exp.total.outstanding <= 0.005, exp.total.outstanding > 0.005 ? `Outstanding payments: ${exp.total.outstanding}` : 'No outstanding payments on purchase orders'],
    c_rgp: [rgpOpen.length === 0, rgpOpen.length ? `${n(rgpOpen, 'returnable gate pass')} not closed: ${rgpOpen.map((g) => g.id).join(', ')}` : 'All returnable gate passes are closed'],
    c_nrgp: [null, `${n(nrgp, 'NRGP record')} to review`],
    c_documents: [null, 'Confirm that the completion report and final documents are attached to the project'],
    c_approval: [null, 'Your confirmation records the closure approval'],
  };
  return CHECKS.map(([key, label]) => ({ key, label, auto: auto[key][0], detail: auto[key][1] }));
}

export async function completeProject(pid, { confirm = {}, override, overrideReason, completionDate, finalRemarks }) {
  requirePerm('closure.approve', pid, 'approve project completion');
  const p = store.project(pid);
  if (!p) throw new AppError('Project not found.');
  if (['Completed', 'Cancelled'].includes(p.status)) throw new AppError(`This project is already ${p.status.toLowerCase()}.`);
  if (!completionDate) throw new AppError('Enter the final completion date.');
  const list = closureChecklist(pid);
  const resolved = Object.fromEntries(list.map((c) => [c.key, c.auto !== false && confirm[c.key] === true]));
  const unresolved = list.filter((c) => !resolved[c.key]);
  if (unresolved.length) {
    if (!override) throw new AppError(`The closure checklist is not complete: ${unresolved.map((c) => c.label).join('; ')}. Resolve these, or record an authorised override with a reason.`);
    if (!overrideReason || overrideReason.trim().length < 5) throw new AppError('An override needs a written reason.');
  }
  const rec = { kind: 'completion', ...resolved, unresolved: unresolved.map((c) => `${c.label} — ${c.detail}`).join('\n'), override: unresolved.length ? true : null, overrideReason: unresolved.length ? overrideReason : null,
    completionDate, approvedBy: me(), approvedByName: session.user.displayName, finalRemarks, previousStatus: p.status };
  await runTx(pid, (tx) => {
    if (store.get('closures', pid, 'completion')) tx.patch('closures', 'completion', rec, 'Completion record updated'); else tx.create('closures', 'completion', rec, 'Completion record created');
    tx.patch('projects', pid, { status: 'Completed' }, unresolved.length ? `Project completed with override: ${overrideReason}` : 'Project completed — closure checklist satisfied');
    tx.notify([p.managerId, ...recipients('projects.view', pid, { depts: ['project_management'] })], { title: `Project completed: ${pid} — ${p.name}`, body: finalRemarks || '', link: `#/projects/${pid}`, module: 'closure' });
  });
}

export async function cancelProject(pid, input) {
  requirePerm('closure.approve', pid, 'approve project cancellation');
  const p = store.project(pid);
  if (!p) throw new AppError('Project not found.');
  if (['Completed', 'Cancelled'].includes(p.status)) throw new AppError(`This project is already ${p.status.toLowerCase()}.`);
  if (!input.reason?.trim()) throw new AppError('Enter the cancellation reason.');
  if (!input.cancellationDate) throw new AppError('Enter the cancellation date.');
  for (const [k, label] of [['materialStatus', 'material status'], ['procurementCancellationStatus', 'procurement cancellation status'], ['paymentSettlementStatus', 'payment settlement status']]) {
    if (!input[k]?.trim()) throw new AppError(`Describe the ${label}.`);
  }
  const rec = { kind: 'cancellation', reason: input.reason, cancellationDate: input.cancellationDate, approvedBy: me(), approvedByName: session.user.displayName,
    materialStatus: input.materialStatus, stockReturnStatus: input.stockReturnStatus, procurementCancellationStatus: input.procurementCancellationStatus, vendorCommitments: input.vendorCommitments,
    paymentSettlementStatus: input.paymentSettlementStatus, outstandingLiabilities: input.outstandingLiabilities === '' || input.outstandingLiabilities === undefined ? null : num(input.outstandingLiabilities),
    gatePassStatus: input.gatePassStatus, finalRemarks: input.finalRemarks, previousStatus: p.status };
  await runTx(pid, (tx) => {
    if (store.get('closures', pid, 'cancellation')) tx.patch('closures', 'cancellation', rec, 'Cancellation record updated'); else tx.create('closures', 'cancellation', rec, 'Cancellation record created');
    tx.patch('projects', pid, { status: 'Cancelled' }, `Project cancelled: ${input.reason}`);
    tx.notify([p.managerId, ...recipients('projects.view', pid, { depts: ['project_management'] })], { title: `Project cancelled: ${pid} — ${p.name}`, body: input.reason, link: `#/projects/${pid}`, module: 'closure' });
  });
}

/** Bring a closed project back to Active. History and the earlier closure record are kept. */
export async function reopenProject(pid, { reason }) {
  requirePerm('closure.approve', pid, 'reopen projects');
  const p = store.project(pid);
  if (!['Completed', 'Cancelled'].includes(p?.status)) throw new AppError('Only a completed or cancelled project can be reopened.');
  if (!reason || reason.trim().length < 5) throw new AppError('Give the reason for reopening the project.');
  const rec = { kind: 'reopen', reason, approvedBy: me(), approvedByName: session.user.displayName, previousStatus: p.status, completionDate: today() };
  await runTx(pid, (tx) => {
    if (store.get('closures', pid, 'reopen')) tx.patch('closures', 'reopen', rec, 'Reopen record updated'); else tx.create('closures', 'reopen', rec, 'Reopen record created');
    tx.patch('projects', pid, { status: 'Active' }, `Project reopened (was ${p.status}): ${reason}`);
  });
}
