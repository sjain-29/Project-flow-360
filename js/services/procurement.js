/**
 * Procurement workflow (section 8): PR → approval → quotations → PO → PI →
 * payments → vendor dispatch → material receipt (GRN).
 *
 * The same flow serves both procurement types. A PR, PO, dispatch or receipt
 * always carries its type ("Project Requirement" or "Source Stock Replenishment"),
 * so the two are separately identifiable everywhere and never double-counted.
 */
import { store } from './store.js';
import { requirePerm, requireAny, me, session } from './session.js';
import { runTx } from './tx.js';
import { recipients, recordLink } from './notify.js';
import { touchStage, branchOf } from './stages.js';
import { assertProjectOpen } from './projects.js';
import { APP } from '../config/app-config.js';
import { AppError, num, round, sum } from '../utils/format.js';

const EPS = APP.eps;
const REPL = 'Source Stock Replenishment';
const money = (n) => round(n, 2);
const need = (coll, pid, id, label) => { const r = store.get(coll, pid, id); if (!r) throw new AppError(`${label} not found.`); return r; };
const itemOf = (r) => ({ itemId: r.itemId, itemCode: r.itemCode, itemName: r.itemName });

/* ------------------------------------------------------------------ Stage 1: purchase request */
export async function createPR(pid, requirementId, input) {
  requirePerm('pr.create', pid, 'create purchase requests');
  assertProjectOpen(pid);
  const req = need('procurement', pid, requirementId, 'Procurement requirement');
  if (req.status !== 'Open') throw new AppError(req.status === 'Under Review' ? 'This requirement is under review after a transfer change. It must be reviewed before a PR can be raised.' : `A PR cannot be raised for a requirement that is "${req.status}".`);
  if (!input.purpose?.trim()) throw new AppError('Enter the purpose of the purchase request.');
  if (!input.requestingDeptId) throw new AppError('Choose the requesting department.');
  if (!input.requestDate) throw new AppError('Enter the request date.');
  if (input.requiredBy && input.requiredBy < input.requestDate) throw new AppError('The required-by date cannot be before the request date.');
  const branch = branchOf(req.type);
  return runTx(pid, async (tx) => {
    const id = await tx.nextId('purchaseRequests');
    tx.create('purchaseRequests', id, {
      requirementId, ...itemOf(req), qty: req.qty, procurementType: req.type, sourceDeptId: req.sourceDeptId,
      purpose: input.purpose, requestingDeptId: input.requestingDeptId, requestDate: input.requestDate, requiredBy: input.requiredBy,
      requestedBy: me(), remarks: input.remarks, status: 'Pending Approval',
    }, `PR submitted for approval (${req.type}, quantity ${req.qty})`);
    tx.patch('procurement', requirementId, { status: 'PR Raised', prId: id }, `PR ${id} raised`);
    touchStage(tx, req.itemId, branch, 'pr', 'complete');
    touchStage(tx, req.itemId, branch, 'prApproval', 'wait');
    tx.notify(recipients('pr.approve', pid), { title: `PR needs approval: ${id}`, body: `${req.itemCode} × ${req.qty} (${req.type}), project ${pid}.`, link: recordLink('purchaseRequests', pid, id), module: 'pr' });
    return id;
  });
}

export async function updatePR(pid, id, input) {
  requirePerm('pr.edit', pid, 'edit purchase requests');
  const pr = need('purchaseRequests', pid, id, 'Purchase request');
  if (!['Pending Approval', 'Changes Requested'].includes(pr.status)) throw new AppError(`A PR that is ${pr.status.toLowerCase()} can no longer be edited.`);
  if (!input.purpose?.trim()) throw new AppError('Enter the purpose of the purchase request.');
  await runTx(pid, (tx) => {
    tx.patch('purchaseRequests', id, { purpose: input.purpose, requestingDeptId: input.requestingDeptId, requestDate: input.requestDate, requiredBy: input.requiredBy, remarks: input.remarks, status: 'Pending Approval' },
      pr.status === 'Changes Requested' ? 'PR revised and resubmitted for approval' : 'PR edited');
    if (pr.status === 'Changes Requested') {
      touchStage(tx, pr.itemId, branchOf(pr.procurementType), 'prApproval', 'wait');
      tx.notify(recipients('pr.approve', pid), { title: `PR resubmitted: ${id}`, body: `${pr.itemCode} × ${pr.qty}, project ${pid}.`, link: recordLink('purchaseRequests', pid, id), module: 'pr' });
    }
  });
}

/* ------------------------------------------------------------------ Stage 2: PR approval */
export async function decidePR(pid, id, { decision, comments, rejectionReason }) {
  requirePerm('pr.approve', pid, 'approve purchase requests');
  const pr = need('purchaseRequests', pid, id, 'Purchase request');
  if (pr.status !== 'Pending Approval') throw new AppError('Only a PR that is pending approval can be decided.');
  if (!['Approved', 'Rejected', 'Changes Requested'].includes(decision)) throw new AppError('Choose approve, reject or request changes.');
  if (store.settings().allowSelfApproval !== true && pr.requestedBy === me()) throw new AppError('You raised this PR, so someone else has to approve it.');
  if (decision === 'Rejected' && !rejectionReason?.trim()) throw new AppError('Give the reason for rejecting the PR.');
  if (decision === 'Changes Requested' && !comments?.trim()) throw new AppError('Describe the changes you are asking for.');
  const req = store.get('procurement', pid, pr.requirementId);
  if (decision === 'Approved' && req?.status === 'Under Review') throw new AppError('The linked requirement is under review after a transfer change. Complete that review before approving this PR.');
  const branch = branchOf(pr.procurementType);
  await runTx(pid, (tx) => {
    tx.patch('purchaseRequests', id, { status: decision, decision, approverId: me(), approverName: session.user.displayName, decisionAt: Date.now(), rejectionReason: decision === 'Rejected' ? rejectionReason : null, approvalComments: comments },
      `PR ${decision === 'Changes Requested' ? 'returned for changes' : decision.toLowerCase()}${rejectionReason ? `: ${rejectionReason}` : ''}`);
    if (decision === 'Approved') {
      touchStage(tx, pr.itemId, branch, 'prApproval', 'complete');
      tx.notify(recipients('quotations.create', pid), { title: `PR approved: ${id} — quotations can start`, body: `${pr.itemCode} × ${pr.qty}, project ${pid}.`, link: recordLink('purchaseRequests', pid, id), module: 'pr' });
    } else if (decision === 'Rejected') {
      // the requirement is still real: reopen it so a new PR can be raised
      if (req && req.status !== 'Cancelled') tx.patch('procurement', pr.requirementId, { ...(req.status === 'PR Raised' ? { status: 'Open' } : {}), prId: null }, `PR ${id} rejected — requirement reopened`);
      touchStage(tx, pr.itemId, branch, 'prApproval', 'reset');
      touchStage(tx, pr.itemId, branch, 'pr', 'reopen');
    } else touchStage(tx, pr.itemId, branch, 'prApproval', 'reopen');
    tx.notify([pr.requestedBy], { title: `PR ${decision === 'Changes Requested' ? 'needs changes' : decision.toLowerCase()}: ${id}`, body: rejectionReason || comments || '', link: recordLink('purchaseRequests', pid, id), module: 'pr' });
  });
}

/* ------------------------------------------------------------------ Stage 3: vendor quotations */
const quotationTotal = (qty, d) => money(num(qty) * num(d.unitPrice) * (1 + num(d.gstPercent) / 100) + num(d.shippingCharges) + num(d.otherCharges));
function cleanQuotation(input) {
  const d = {};
  for (const k of ['vendorName', 'vendorContact', 'quotationNumber', 'quotationDate', 'deliveryTime', 'validity', 'paymentTerms', 'remarks']) if (k in input) d[k] = input[k];
  for (const k of ['unitPrice', 'gstPercent', 'shippingCharges', 'otherCharges']) if (input[k] !== undefined && input[k] !== '') d[k] = num(input[k]);
  if (!d.vendorName?.trim()) throw new AppError('Enter the vendor name.');
  if (!(d.unitPrice > 0)) throw new AppError('Enter the unit price.');
  for (const k of ['gstPercent', 'shippingCharges', 'otherCharges']) if (d[k] < 0) throw new AppError('Charges cannot be negative.');
  return d;
}

export async function addQuotation(pid, prId, input) {
  requirePerm('quotations.create', pid, 'add vendor quotations');
  assertProjectOpen(pid);
  const pr = need('purchaseRequests', pid, prId, 'Purchase request');
  // Mandatory rule: vendor quotations cannot proceed until the PR is approved (also enforced by the security rules).
  if (pr.status !== 'Approved') throw new AppError(`Vendor quotations cannot be added until the PR is approved. ${prId} is "${pr.status}".`);
  const d = cleanQuotation(input);
  return runTx(pid, async (tx) => {
    const id = await tx.nextId('quotations');
    tx.create('quotations', id, { prId, ...itemOf(pr), qty: pr.qty, ...d, totalAmount: quotationTotal(pr.qty, d) }, `Quotation added: ${d.vendorName}`);
    touchStage(tx, pr.itemId, branchOf(pr.procurementType), 'quotation', 'start');
    tx.notify(recipients('quotations.approve', pid), { title: `Quotation added for ${prId}`, body: `${d.vendorName}, ${pr.itemCode}.`, link: recordLink('purchaseRequests', pid, prId), module: 'quotations' });
    return id;
  });
}

export async function updateQuotation(pid, id, input) {
  requirePerm('quotations.edit', pid, 'edit vendor quotations');
  const q = need('quotations', pid, id, 'Quotation');
  const pr = need('purchaseRequests', pid, q.prId, 'Purchase request');
  if (num(pr.orderedQty) > 0 && q.selected) throw new AppError('A purchase order was already created from this quotation. It can no longer be changed.');
  const d = cleanQuotation({ ...q, ...input });
  await runTx(pid, (tx) => tx.patch('quotations', id, { ...d, totalAmount: quotationTotal(q.qty, d) }, 'Quotation edited'));
}

export async function removeQuotation(pid, id) {
  requirePerm('quotations.delete', pid, 'remove vendor quotations');
  const q = need('quotations', pid, id, 'Quotation');
  if (q.selected) throw new AppError('The selected quotation cannot be removed. Select another vendor first.');
  await runTx(pid, (tx) => tx.patch('quotations', id, { deleted: true }, 'Quotation removed'));
}

export async function selectQuotation(pid, id, { justification }) {
  requireAny(['quotations.approve', 'quotations.updateStatus'], pid, 'select the vendor');
  const q = need('quotations', pid, id, 'Quotation');
  const pr = need('purchaseRequests', pid, q.prId, 'Purchase request');
  if (pr.status !== 'Approved') throw new AppError('The PR is not approved.');
  if (!justification?.trim()) throw new AppError('Record why this vendor is selected.');
  if (num(pr.orderedQty) > 0) throw new AppError('A purchase order already exists for this PR. The vendor selection can no longer change.');
  await runTx(pid, (tx) => {
    if (pr.selectedQuotationId && pr.selectedQuotationId !== id && store.get('quotations', pid, pr.selectedQuotationId)) tx.patch('quotations', pr.selectedQuotationId, { selected: null }, 'Vendor selection withdrawn');
    tx.patch('quotations', id, { selected: true }, `Vendor selected: ${q.vendorName}`);
    tx.patch('purchaseRequests', q.prId, { selectedQuotationId: id, selectionJustification: justification, selectedBy: me(), selectedAt: Date.now() }, `Vendor selected: ${q.vendorName} — ${justification}`);
    touchStage(tx, pr.itemId, branchOf(pr.procurementType), 'quotation', 'complete');
    tx.notify(recipients('po.create', pid), { title: `Vendor selected for ${q.prId}: ${q.vendorName}`, body: `${pr.itemCode} × ${pr.qty}. A purchase order can be created.`, link: recordLink('purchaseRequests', pid, q.prId), module: 'quotations' });
  });
}

/* ------------------------------------------------------------------ Stage 4: purchase order */
export const poTotal = (d) => money(num(d.quantity) * num(d.unitPrice) * (1 + num(d.taxPercent) / 100) + num(d.otherCharges));

export async function createPO(pid, prId, input) {
  requirePerm('po.create', pid, 'create purchase orders');
  assertProjectOpen(pid);
  const pr = need('purchaseRequests', pid, prId, 'Purchase request');
  if (pr.status !== 'Approved') throw new AppError('A purchase order needs an approved PR.');
  const q = pr.selectedQuotationId ? store.get('quotations', pid, pr.selectedQuotationId) : null;
  if (!q) throw new AppError('Select a vendor quotation before creating the purchase order.');
  const quantity = num(input.quantity);
  const remaining = round(num(pr.qty) - num(pr.orderedQty));
  if (!(quantity > 0)) throw new AppError('Enter the order quantity.');
  if (quantity > remaining + EPS) throw new AppError(`Only ${remaining} unit(s) of this PR remain to be ordered. Ordering more would procure the same quantity twice.`);
  if (!input.poDate) throw new AppError('Enter the PO date.');
  if (!(num(input.unitPrice) > 0)) throw new AppError('Enter the unit price.');
  const d = { quantity, unitPrice: num(input.unitPrice), taxPercent: num(input.taxPercent), otherCharges: num(input.otherCharges) };
  return runTx(pid, async (tx) => {
    const id = await tx.nextId('purchaseOrders');
    tx.create('purchaseOrders', id, {
      prId, quotationId: q.id, ...itemOf(pr), procurementType: pr.procurementType, sourceDeptId: pr.sourceDeptId, vendorName: q.vendorName,
      poDate: input.poDate, ...d, totalValue: poTotal(d), deliveryAddress: input.deliveryAddress, deliveryDate: input.deliveryDate, paymentTerms: input.paymentTerms, remarks: input.remarks, status: 'Issued',
    }, `PO issued to ${q.vendorName}: ${quantity} × ${d.unitPrice}`);
    const ordered = round(num(pr.orderedQty) + quantity);
    tx.patch('purchaseRequests', prId, { orderedQty: ordered }, `Ordered quantity: ${ordered} of ${pr.qty} (PO ${id})`);
    touchStage(tx, pr.itemId, branchOf(pr.procurementType), 'po', ordered >= num(pr.qty) - EPS ? 'complete' : 'start');
    tx.notify(recipients('payments.create', pid), { title: `PO created: ${id} — payment pending`, body: `${q.vendorName}, ${pr.itemCode} × ${quantity}.`, link: recordLink('purchaseOrders', pid, id), module: 'po' });
    tx.notify([pr.requestedBy], { title: `PO created for your PR ${prId}`, body: `${id}, ${q.vendorName}.`, link: recordLink('purchaseOrders', pid, id), module: 'po' });
    return id;
  });
}

export async function updatePO(pid, id, input) {
  requirePerm('po.edit', pid, 'edit purchase orders');
  const po = need('purchaseOrders', pid, id, 'Purchase order');
  if (po.status !== 'Issued') throw new AppError(`A PO that is ${po.status.toLowerCase()} cannot be edited.`);
  const d = { deliveryAddress: input.deliveryAddress, deliveryDate: input.deliveryDate, paymentTerms: input.paymentTerms, remarks: input.remarks, poDate: input.poDate || po.poDate };
  await runTx(pid, (tx) => tx.patch('purchaseOrders', id, d, 'PO delivery / terms edited'));
}

export async function cancelPO(pid, id, { reason }) {
  requirePerm('po.edit', pid, 'cancel purchase orders');
  const po = need('purchaseOrders', pid, id, 'Purchase order');
  if (po.status === 'Cancelled') throw new AppError('This PO is already cancelled.');
  if (!reason?.trim()) throw new AppError('Give the reason for cancelling the PO.');
  if (num(po.dispatchedQty) > 0) throw new AppError('The vendor has already dispatched material against this PO. It cannot be cancelled.');
  if (num(po.paidTotal) > 0) throw new AppError('Payments were recorded against this PO. Reverse them (Accounts) before cancelling it.');
  const pr = need('purchaseRequests', pid, po.prId, 'Purchase request');
  await runTx(pid, (tx) => {
    tx.patch('purchaseOrders', id, { status: 'Cancelled', remarks: `${po.remarks ? `${po.remarks}\n` : ''}Cancelled: ${reason}` }, `PO cancelled: ${reason}`);
    tx.patch('purchaseRequests', po.prId, { orderedQty: round(Math.max(0, num(pr.orderedQty) - num(po.quantity))) }, `PO ${id} cancelled — ordered quantity reduced`);
    touchStage(tx, po.itemId, branchOf(po.procurementType), 'po', 'reopen');
  });
}

export async function closePO(pid, id) {
  requireAny(['po.updateStatus', 'po.edit'], pid, 'close purchase orders');
  const po = need('purchaseOrders', pid, id, 'Purchase order');
  if (po.status !== 'Issued') throw new AppError('Only an issued PO can be closed.');
  await runTx(pid, (tx) => tx.patch('purchaseOrders', id, { status: 'Closed' }, 'PO closed'));
}

/* ------------------------------------------------------------------ Stage 5: proforma invoice */
export async function addPI(pid, poId, input) {
  requirePerm('pi.create', pid, 'record proforma invoices');
  const po = need('purchaseOrders', pid, poId, 'Purchase order');
  if (po.status === 'Cancelled') throw new AppError('This PO is cancelled.');
  if (!input.piNumber?.trim() || !input.piDate) throw new AppError('Enter the PI number and date.');
  if (!(num(input.amount) > 0)) throw new AppError('Enter the PI amount.');
  if (num(input.tax) < 0) throw new AppError('Tax cannot be negative.');
  return runTx(pid, async (tx) => {
    const id = await tx.nextId('proformaInvoices');
    tx.create('proformaInvoices', id, { poId, vendorName: po.vendorName, piNumber: input.piNumber.trim(), piDate: input.piDate, amount: num(input.amount), tax: num(input.tax), totalAmount: money(num(input.amount) + num(input.tax)), remarks: input.remarks },
      `Proforma invoice ${input.piNumber} recorded`);
    touchStage(tx, po.itemId, branchOf(po.procurementType), 'pi', 'start');
    tx.notify(recipients('payments.create', pid), { title: `Proforma invoice received for ${poId}`, body: `${po.vendorName}, PI ${input.piNumber}.`, link: recordLink('purchaseOrders', pid, poId), module: 'pi' });
    return id;
  });
}

/* ------------------------------------------------------------------ Stage 6: payments */
/** Authorised payable = PO value + authorised adjustments. Outstanding = payable − successful payments. */
export function poFinance(po) {
  const payable = money(num(po.totalValue) + num(po.adjTotal));
  const paid = money(num(po.paidTotal));
  return { payable, paid, outstanding: money(Math.max(0, payable - paid)) };
}

export async function addPayment(pid, poId, input) {
  requirePerm('payments.create', pid, 'record payments');
  const po = need('purchaseOrders', pid, poId, 'Purchase order');
  if (po.status === 'Cancelled') throw new AppError('This PO is cancelled.');
  const amount = money(num(input.amount));
  if (!(amount > 0)) throw new AppError('Enter the payment amount.');
  if (!input.paymentDate) throw new AppError('Enter the payment date.');
  if (!input.mode) throw new AppError('Choose the payment mode.');
  const status = input.status || 'Pending';
  if (!['Pending', 'Successful', 'Failed'].includes(status)) throw new AppError('Choose the payment status.');
  const fin = poFinance(po);
  if (status === 'Successful' && amount > fin.outstanding + EPS) throw new AppError(`This payment would exceed the authorised payable amount. Outstanding on ${poId}: ${fin.outstanding}. If more is genuinely payable, an authorised adjustment has to be recorded first.`);
  return runTx(pid, async (tx) => {
    const id = await tx.nextId('payments');
    tx.create('payments', id, { poId, vendorName: po.vendorName, piId: input.piId, paymentDate: input.paymentDate, amount, mode: input.mode, transactionRef: input.transactionRef, remarks: input.remarks, status }, `Payment recorded: ${amount} (${status})`);
    if (status === 'Successful') tx.patch('purchaseOrders', poId, { paidTotal: money(num(po.paidTotal) + amount) }, `Payment ${id}: ${amount} paid`);
    touchStage(tx, po.itemId, branchOf(po.procurementType), 'payment', 'start');
    return id;
  });
}

export async function setPaymentStatus(pid, id, { status, remarks }) {
  requireAny(['payments.updateStatus', 'payments.edit'], pid, 'update payments');
  const pay = need('payments', pid, id, 'Payment');
  const po = need('purchaseOrders', pid, pay.poId, 'Purchase order');
  if (!['Pending', 'Successful', 'Failed', 'Reversed'].includes(status)) throw new AppError('Choose the payment status.');
  if (status === pay.status) throw new AppError('The payment already has this status.');
  const was = pay.status === 'Successful' ? num(pay.amount) : 0;
  const now = status === 'Successful' ? num(pay.amount) : 0;
  const fin = poFinance(po);
  if (now > was && now - was > fin.outstanding + EPS) throw new AppError(`This would exceed the authorised payable amount. Outstanding on ${pay.poId}: ${fin.outstanding}.`);
  await runTx(pid, (tx) => {
    tx.patch('payments', id, { status, ...(remarks ? { remarks } : {}) }, `Payment status: ${pay.status} → ${status}`);
    if (now !== was) tx.patch('purchaseOrders', pay.poId, { paidTotal: money(num(po.paidTotal) + now - was) }, `Payment ${id} ${status.toLowerCase()}`);
  });
}

/** Authorised change of the payable amount of a PO (for example agreed extra freight). */
export async function addPaymentAdjustment(pid, poId, { amount, reason }) {
  requirePerm('payments.approve', pid, 'authorise payment adjustments');
  const po = need('purchaseOrders', pid, poId, 'Purchase order');
  const a = money(num(amount));
  if (!a) throw new AppError('Enter the adjustment amount (positive to increase the payable amount, negative to reduce it).');
  if (!reason || reason.trim().length < 5) throw new AppError('Explain the reason for the adjustment.');
  const adj = money(num(po.adjTotal) + a);
  if (num(po.paidTotal) > num(po.totalValue) + adj + EPS) throw new AppError('The payable amount cannot be reduced below what has already been paid.');
  return runTx(pid, async (tx) => {
    const id = await tx.nextId('paymentAdjustments');
    tx.create('paymentAdjustments', id, { poId, amount: a, reason: reason.trim(), approvedBy: me() }, `Payable amount adjusted by ${a}: ${reason}`);
    tx.patch('purchaseOrders', poId, { adjTotal: adj }, `Authorised adjustment ${id}: ${a}`);
    return id;
  });
}

/* ------------------------------------------------------------------ Stage 7: vendor dispatch */
export async function addDispatch(pid, poId, input) {
  requirePerm('dispatch.create', pid, 'record vendor dispatches');
  const po = need('purchaseOrders', pid, poId, 'Purchase order');
  if (po.status !== 'Issued') throw new AppError(`Dispatches can only be recorded against an issued PO (${poId} is ${po.status.toLowerCase()}).`);
  const qty = num(input.qty);
  const remaining = round(num(po.quantity) - num(po.dispatchedQty));
  if (!(qty > 0)) throw new AppError('Enter the dispatch quantity.');
  if (qty > remaining + EPS) throw new AppError(`Only ${remaining} unit(s) remain to be dispatched on ${poId}.`);
  if (!input.dispatchDate) throw new AppError('Enter the dispatch date.');
  if (input.trackingLink && !/^https?:\/\//i.test(input.trackingLink)) throw new AppError('The tracking link must start with http:// or https://');
  const branch = branchOf(po.procurementType);
  return runTx(pid, async (tx) => {
    const id = await tx.nextId('dispatches');
    tx.create('dispatches', id, {
      poId, vendorName: po.vendorName, ...itemOf(po), procurementType: po.procurementType, dispatchDate: input.dispatchDate, qty, courier: input.courier,
      trackingNumber: input.trackingNumber, lrNumber: input.lrNumber, challanNumber: input.challanNumber, expectedDelivery: input.expectedDelivery, trackingLink: input.trackingLink, remarks: input.remarks,
    }, `Vendor dispatched ${qty}`);
    tx.patch('purchaseOrders', poId, { dispatchedQty: round(num(po.dispatchedQty) + qty) }, `Dispatch ${id}: ${qty}`);
    touchStage(tx, po.itemId, branch, 'dispatch', 'start');
    tx.notify(recipients('receipts.create', pid), { title: `Material dispatched by vendor: ${po.itemCode} × ${qty}`, body: `${po.vendorName}, PO ${poId}. Expected ${input.expectedDelivery || 'date not given'}.`, link: recordLink('dispatches', pid, id), module: 'dispatch' });
    return id;
  });
}

/* ------------------------------------------------------------------ Material receipt (GRN) — section 9 */
/**
 * Physical receipt, confirmed by authorised Stores users only. Never created by a date.
 * Project procurement is received at SPIF; replenishment is received by the source department
 * and goes back into that department's stock.
 */
export async function receiveMaterial(pid, dispatchId, input) {
  requirePerm('receipts.create', pid, 'confirm material receipts');
  const dsp = need('dispatches', pid, dispatchId, 'Dispatch');
  const po = need('purchaseOrders', pid, dsp.poId, 'Purchase order');
  const rec = num(input.receivedQty); const acc = num(input.acceptedQty); const rej = num(input.rejectedQty);
  const pendingQty = round(num(dsp.qty) - num(dsp.receivedQty));
  if (!(rec > 0)) throw new AppError('Enter the quantity received.');
  if (rec > pendingQty + EPS) throw new AppError(`Only ${pendingQty} unit(s) of this dispatch are waiting to be received.`);
  if (acc < 0 || rej < 0 || Math.abs(acc + rej - rec) > EPS) throw new AppError('Accepted plus rejected must equal the received quantity.');
  if (!input.receiptDate) throw new AppError('Enter the receipt date.');
  const repl = po.procurementType === REPL;
  const branch = branchOf(po.procurementType);
  return runTx(pid, async (tx) => {
    const id = await tx.nextId('materialReceipts');
    tx.create('materialReceipts', id, {
      poId: po.id, dispatchId, vendorName: po.vendorName, ...itemOf(po), procurementType: po.procurementType,
      receiptLocation: repl ? `Source department: ${store.deptName(po.sourceDeptId)}` : 'SPIF',
      receiptDate: input.receiptDate, receivedQty: rec, acceptedQty: acc, rejectedQty: rej,
      inspectionStatus: input.inspectionStatus || (rej === 0 ? 'Accepted' : (acc === 0 ? 'Rejected' : 'Partially Accepted')),
      challanNumber: input.challanNumber, damageDetails: input.damageDetails, shortageDetails: input.shortageDetails, inspectionRemarks: input.inspectionRemarks,
    }, `GRN: received ${rec} (accepted ${acc}, rejected ${rej})`);
    tx.patch('dispatches', dispatchId, { receivedQty: round(num(dsp.receivedQty) + rec) }, `GRN ${id}: ${rec} received`);
    tx.patch('purchaseOrders', po.id, { receivedQty: round(num(po.receivedQty) + rec), acceptedQty: round(num(po.acceptedQty) + acc), rejectedQty: round(num(po.rejectedQty) + rej) }, `GRN ${id}: ${rec} received`);
    if (repl && acc > 0) {
      // Replenishment goes back into the source department's stock — never to the project.
      const reqRec = store.where('procurement', pid, (r) => r.prId === po.prId)[0];
      const trf = reqRec?.transferId ? store.get('stockTransfers', pid, reqRec.transferId) : null;
      const stock = trf?.stockId ? store.stockRecord(trf.stockId) : null;
      if (stock) tx.patch('inventory', stock.id, { onHand: round(num(stock.onHand) + acc) }, `Replenished ${acc} (GRN ${id}, project ${pid})`);
    }
    touchStage(tx, po.itemId, branch, 'spifReceipt', 'start');
    tx.notify(recipients('items.view', pid, { depts: repl ? [po.sourceDeptId, 'planning'] : ['project_management', 'planning', 'development'] }),
      { title: `Material received${repl ? ' (replenishment)' : ' at SPIF'}: ${po.itemCode} × ${acc} accepted`, body: `GRN ${id}, PO ${po.id}.${rej > 0 ? ` ${rej} rejected.` : ''}`, link: recordLink('materialReceipts', pid, id), module: 'receipts' });
    return id;
  });
}

/** Totals used by the PO page and the reports. */
export function poReceiptSummary(pid, poId) {
  const receipts = store.where('materialReceipts', pid, (r) => r.poId === poId);
  return { grns: receipts.length, received: sum(receipts, 'receivedQty'), accepted: sum(receipts, 'acceptedQty'), rejected: sum(receipts, 'rejectedQty') };
}
