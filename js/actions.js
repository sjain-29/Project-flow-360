/**
 * What can be done with a record, by whom, and the form for it.
 * Every action is offered only when the user holds the permission AND the record
 * is in the right state; the service re-checks, and the security rules re-check.
 */
import { store } from './services/store.js';
import { can, canAny } from './services/session.js';
import * as I from './services/inventory.js';
import * as PR from './services/procurement.js';
import * as M from './services/material.js';
import * as D from './services/devtest.js';
import { itemQuantities } from './services/quantities.js';
import { formFields } from './config/entities.js';
import { formModal, confirmDialog, toast, showError } from './components/ui.js';
import { num, round, today, fmtMoney, fmtQty } from './utils/format.js';

const f = (name, label, type = 'text', o = {}) => ({ name, label, type, ...o });
const A = (label, ic, run, cls = '') => ({ label, ic, run, cls });
const items = (pid) => store.list('projectItems', pid).map((i) => [i.id, `${i.itemCode} — ${i.name}`]);
const RECEIPT_FIELDS = (max) => [f('receivedQty', `Received quantity (up to ${fmtQty(max)})`, 'number', { req: true, value: max }), f('acceptedQty', 'Accepted quantity', 'number', { req: true, value: max }), f('rejectedQty', 'Rejected quantity', 'number', { req: true, value: 0 })];
const DECISION = (reasonLabel = 'Remarks') => [f('decision', 'Decision', 'select', { req: true, opts: ['Approved', 'Rejected'] }), f('remarks', reasonLabel, 'textarea', { hint: 'Required when rejecting.', main: true })];

/* ------------------------------------------------------------------ forms used from item pages */
export const verifyAvailabilityForm = (pid, item) => {
  const depts = store.departments().filter((d) => d.active !== false);
  const stocks = store.stock().filter((s) => s.itemCode?.toLowerCase() === item.itemCode.toLowerCase());
  const hint = stocks.length ? `Stock register: ${stocks.map((s) => `${store.deptName(s.deptId)} has ${fmtQty(num(s.onHand) - num(s.reserved))} free`).join('; ')}.` : 'No stock record exists for this item code; one is created from what you enter here.';
  return formModal({
    title: `Verify in-house availability — ${item.itemCode}`, submitLabel: 'Confirm verification', successMessage: 'Availability verified.',
    intro: `Required: <b>${fmtQty(item.requiredQty)} ${item.uom}</b>. In-house stock is transferred to the project and a replenishment purchase is always raised for the source department. Any shortage is procured for the project. ${hint}`,
    fields: [f('availableQty', 'Available quantity in-house', 'number', { req: true, value: stocks[0] ? Math.max(0, num(stocks[0].onHand) - num(stocks[0].reserved)) : 0 }), f('sourceDeptId', 'Source department', 'select', { opts: depts.map((d) => [d.id, d.name]), value: stocks[0]?.deptId, hint: 'Needed when any quantity is available.', main: true }),
      f('stockLocation', 'Source stock location', 'text', { value: stocks[0]?.location }), f('stockRef', 'Stock reference'), f('verifiedAt', 'Verification date', 'date', { req: true, value: today() }), f('remarks', 'Remarks', 'textarea')],
    onSubmit: (v) => I.verifyAvailability(pid, item.id, v),
  });
};
export const coverageForm = (pid, item) => { const q = itemQuantities(pid, item.id); return formModal({ title: `Procure uncovered quantity — ${item.itemCode}`, intro: `${fmtQty(q.uncovered)} unit(s) are covered neither by a stock transfer nor by procurement.`, fields: [f('qty', 'Quantity to procure for the project', 'number', { req: true, value: q.uncovered }), f('reason', 'Reason', 'textarea')], submitLabel: 'Create requirement', onSubmit: (v) => I.createCoverageRequirement(pid, item.id, v) }); };
export const additionalMaterialForm = (pid, item) => formModal({ title: `Request additional material — ${item.itemCode}`, intro: 'The request goes to Planning / the project manager for approval before it is procured.', fields: [f('qty', 'Additional quantity', 'number', { req: true }), f('reason', 'Why is it needed?', 'textarea', { req: true })], submitLabel: 'Send request', onSubmit: (v) => I.requestAdditionalMaterial(pid, item.id, v) });
export const startDevForm = (pid, item) => formModal({ title: `Start development — ${item.itemCode}`, fields: [f('team', 'Assigned development team'), f('engineerId', 'Assigned engineer', 'user', { main: true }), f('startDate', 'Development start date', 'date', { value: today() }), f('expectedCompletion', 'Expected completion date', 'date', { main: true }), f('workDescription', 'Work description', 'textarea'), f('technicalRemarks', 'Technical remarks', 'textarea')], submitLabel: 'Open development record', onSubmit: (v) => D.startDevelopment(pid, item.id, v) });
export const testCycleForm = (pid, item) => formModal({ title: `New test cycle — ${item.itemCode}`, fields: [f('testPlan', 'Test plan', 'textarea', { req: true }), f('testDate', 'Test date', 'date', { value: today() }), f('engineerId', 'Test engineer', 'user'), f('environment', 'Test environment')], submitLabel: 'Create test cycle', onSubmit: (v) => D.createTestCycle(pid, item.id, v) });
export const mrForm = (pid, item) => { const q = itemQuantities(pid, item.id); return formModal({ title: `Material request SPIF → GVT — ${item.itemCode}`, intro: `Accepted material available at SPIF for this item: <b>${fmtQty(q.spifAvailable)}</b>.`, fields: [f('qtyRequested', 'Quantity requested', 'number', { req: true, value: q.spifAvailable || '' }), f('requestDate', 'Request date', 'date', { req: true, value: today() }), f('remarks', 'Remarks', 'textarea')], submitLabel: 'Create MR', onSubmit: (v) => M.createMR(pid, item.id, v) }); };
export const prForm = (pid, req) => formModal({ title: `Raise purchase request — ${req.itemCode}`, intro: `${req.type}: <b>${fmtQty(req.qty)}</b> unit(s). ${req.type === 'Source Stock Replenishment' ? `This PR replenishes ${store.deptName(req.sourceDeptId)}; it is tracked separately from the project's own material.` : ''}`,
  fields: [f('purpose', 'Purpose', 'textarea', { req: true, value: req.reason }), f('requestingDeptId', 'Requesting department', 'dept', { req: true, value: 'planning' }), f('requestDate', 'Request date', 'date', { req: true, value: today() }), f('requiredBy', 'Required by date', 'date'), f('remarks', 'Remarks', 'textarea')], submitLabel: 'Submit for approval', onSubmit: (v) => PR.createPR(pid, req.id, v) });

/** Create forms for records that are not born from another record. */
export function newRecordForm(coll, pid, preset = {}) {
  if (coll === 'logistics') return formModal({ title: 'New logistics request', wide: true, fields: formFields('logistics').map((x) => (x.name === 'itemId' ? { ...x, opts: items(pid) } : x)), values: { status: 'Requested', ...preset }, submitLabel: 'Create request', onSubmit: (v) => M.saveLogistics(pid, null, v) });
  if (coll === 'travelDesk') return formModal({ title: 'New travel request', wide: true, fields: formFields('travelDesk').filter((x) => x.name !== 'status').map((x) => (x.name === 'logisticsId' ? { ...x, opts: store.list('logistics', pid).map((l) => [l.id, `${l.id} — ${l.destination}`]) } : x)), values: preset, submitLabel: 'Create request', onSubmit: (v) => M.saveTravel(pid, null, v) });
  if (coll === 'gatePasses') return formModal({ title: 'Generate gate pass', wide: true, fields: formFields('gatePasses').map((x) => (x.name === 'itemId' ? { ...x, opts: items(pid) } : x)), values: { issueDate: today(), type: 'RGP', ...preset }, submitLabel: 'Submit for approval', onSubmit: (v) => M.createGatePass(pid, v) });
  return null;
}
export const CREATABLE = { logistics: 'logistics.create', travelDesk: 'travel.create', gatePasses: 'gatepass.create' };

/* ------------------------------------------------------------------ record actions */
export function recordActions(coll, r) {
  const pid = r.pid; const out = [];
  const add = (cond, a) => { if (cond) out.push(a); };
  switch (coll) {
    case 'inventory':
      add(can('inventory.edit'), A('Edit stock record', 'edit', () => formModal({ title: `Edit stock — ${r.itemCode}`, intro: `${fmtQty(r.reserved)} unit(s) are reserved for transfers. Corrections are logged.`, fields: formFields('inventory'), values: r, onSubmit: (v) => I.saveStockRecord(r.id, v) })));
      break;
    case 'stockTransfers': {
      const open = !['Cancelled', 'Rejected'].includes(r.status);
      const toDispatch = round(num(r.qty) - num(r.dispatchedQty)); const toReceive = round(num(r.dispatchedQty) - num(r.receivedQty));
      add(r.status === 'Requested' && can('transfers.approve', pid), A('Approve or reject', 'check', () => formModal({ title: `Decide transfer ${r.id}`, fields: DECISION(), submitLabel: 'Record decision', onSubmit: (v) => I.decideTransfer(pid, r.id, v) }), 'primary'));
      add(open && toDispatch > 0 && r.status !== 'Requested' && canAny(['transfers.updateStatus', 'transfers.edit'], pid), A('Record dispatch', 'send', () => formModal({ title: `Dispatch from ${store.deptName(r.sourceDeptId)}`, fields: [f('qty', `Quantity dispatched (up to ${fmtQty(toDispatch)})`, 'number', { req: true, value: toDispatch }), f('date', 'Dispatch date', 'date', { req: true, value: today() }), f('remarks', 'Remarks', 'textarea')], onSubmit: (v) => I.dispatchTransfer(pid, r.id, v) }), 'primary'));
      add(open && toReceive > 0 && canAny(['transfers.updateStatus', 'transfers.edit'], pid), A('Confirm receipt', 'packageCheck', () => formModal({ title: 'Receipt at the requesting department', fields: [...RECEIPT_FIELDS(toReceive), f('date', 'Receipt date', 'date', { req: true, value: today() }), f('remarks', 'Remarks', 'textarea')], onSubmit: (v) => I.receiveTransfer(pid, r.id, v) }), 'primary'));
      add(open && r.status !== 'Received' && can('transfers.edit', pid), A('Adjust quantity', 'edit', () => formModal({ title: `Adjust transfer ${r.id}`, intro: 'The linked replenishment requirement is not changed silently: it is sent for authorised review.', fields: [f('newQty', 'New transfer quantity', 'number', { req: true, value: r.qty }), f('reason', 'Reason', 'textarea', { req: true })], onSubmit: (v) => I.adjustTransferQty(pid, r.id, v) })));
      add(open && num(r.dispatchedQty) === 0 && canAny(['transfers.updateStatus', 'transfers.edit'], pid), A('Cancel transfer', 'x', () => formModal({ title: `Cancel transfer ${r.id}`, danger: true, intro: 'The replenishment requirement is kept and sent for authorised review.', fields: [f('reason', 'Reason', 'textarea', { req: true })], submitLabel: 'Cancel transfer', onSubmit: (v) => I.cancelTransfer(pid, r.id, v) }), 'danger'));
      break;
    }
    case 'procurement':
      add(r.status === 'Open' && can('pr.create', pid), A('Raise purchase request', 'doc', () => prForm(pid, r), 'primary'));
      add(r.status === 'Under Review' && can('procurement.approve', pid), A('Review requirement', 'checks', () => formModal({ title: `Review ${r.id}`, intro: esc2(r.reviewReason), fields: [f('decision', 'Decision', 'select', { req: true, opts: [['keep', `Keep the quantity (${fmtQty(r.qty)})`], ['adjust', 'Change the quantity'], ['cancel', 'Cancel the requirement']] }), f('newQty', 'New quantity (when changing)', 'number'), f('remarks', 'Reasoning', 'textarea', { req: true })], submitLabel: 'Record review', onSubmit: (v) => I.reviewRequirement(pid, r.id, v) }), 'primary'));
      add(r.status === 'Pending Approval' && can('procurement.approve', pid), A('Approve or reject', 'check', () => formModal({ title: `Additional material ${r.id}`, intro: esc2(r.reason), fields: DECISION(), submitLabel: 'Record decision', onSubmit: (v) => I.decideAdditionalMaterial(pid, r.id, v) }), 'primary'));
      add(['Open', 'PR Raised'].includes(r.status) && canAny(['procurement.updateStatus', 'procurement.approve'], pid), A('Close requirement', 'check', async () => { if (await confirmDialog({ title: 'Close requirement', body: 'Mark this requirement as closed? Do this once its procurement is complete.' })) await I.closeRequirement(pid, r.id).then(() => toast('Requirement closed.')); }));
      break;
    case 'purchaseRequests': {
      const edit = () => formModal({ title: `Edit ${r.id}`, fields: formFields('purchaseRequests'), values: r, submitLabel: r.status === 'Changes Requested' ? 'Resubmit for approval' : 'Save', onSubmit: (v) => PR.updatePR(pid, r.id, v) });
      add(r.status === 'Pending Approval' && can('pr.approve', pid), A('Approve / reject / request changes', 'check', () => formModal({ title: `Decide ${r.id}`, fields: [f('decision', 'Decision', 'select', { req: true, opts: ['Approved', 'Rejected', 'Changes Requested'] }), f('rejectionReason', 'Rejection reason', 'textarea', { hint: 'Required when rejecting.' }), f('comments', 'Comments', 'textarea', { hint: 'Required when requesting changes.' })], submitLabel: 'Record decision', onSubmit: (v) => PR.decidePR(pid, r.id, v) }), 'primary'));
      add(['Pending Approval', 'Changes Requested'].includes(r.status) && can('pr.edit', pid), A(r.status === 'Changes Requested' ? 'Revise and resubmit' : 'Edit', 'edit', edit, r.status === 'Changes Requested' ? 'primary' : ''));
      add(r.status === 'Approved' && can('quotations.create', pid), A('Add vendor quotation', 'plus', () => formModal({ title: `Quotation for ${r.id}`, wide: true, intro: `${esc2(r.itemCode)} × ${fmtQty(r.qty)}`, fields: formFields('quotations'), values: { quotationDate: today() }, submitLabel: 'Add quotation', onSubmit: (v) => PR.addQuotation(pid, r.id, v) }), 'primary'));
      const q = r.selectedQuotationId ? store.get('quotations', pid, r.selectedQuotationId) : null;
      const remaining = round(num(r.qty) - num(r.orderedQty));
      add(r.status === 'Approved' && q && remaining > 0 && can('po.create', pid), A('Create purchase order', 'cart', () => formModal({ title: `Purchase order for ${r.id}`, wide: true, intro: `Vendor: <b>${esc2(q.vendorName)}</b>. Remaining to order: ${fmtQty(remaining)}.`, fields: formFields('purchaseOrders'), values: { poDate: today(), quantity: remaining, unitPrice: q.unitPrice, taxPercent: q.gstPercent, otherCharges: round(num(q.shippingCharges) + num(q.otherCharges), 2), paymentTerms: q.paymentTerms }, submitLabel: 'Issue PO', onSubmit: (v) => PR.createPO(pid, r.id, v) }), 'primary'));
      break;
    }
    case 'quotations': {
      const pr = store.get('purchaseRequests', pid, r.prId);
      add(!r.selected && pr?.status === 'Approved' && num(pr.orderedQty) === 0 && canAny(['quotations.approve', 'quotations.updateStatus'], pid), A('Select this vendor', 'check', () => formModal({ title: `Select ${r.vendorName}`, fields: [f('justification', 'Selection justification', 'textarea', { req: true })], submitLabel: 'Select vendor', onSubmit: (v) => PR.selectQuotation(pid, r.id, v) }), 'primary'));
      add(can('quotations.edit', pid), A('Edit', 'edit', () => formModal({ title: `Edit quotation — ${r.vendorName}`, wide: true, fields: formFields('quotations'), values: r, onSubmit: (v) => PR.updateQuotation(pid, r.id, v) })));
      add(!r.selected && can('quotations.delete', pid), A('Remove', 'trash', async () => { if (await confirmDialog({ title: 'Remove quotation', body: 'Remove this quotation? It stays in the history.', danger: true, confirmLabel: 'Remove' })) await PR.removeQuotation(pid, r.id).then(() => { toast('Quotation removed.'); history.back(); }); }, 'danger'));
      break;
    }
    case 'purchaseOrders': {
      const live = r.status === 'Issued'; const fin = PR.poFinance(r); const toDispatch = round(num(r.quantity) - num(r.dispatchedQty));
      const pis = store.where('proformaInvoices', pid, (x) => x.poId === r.id).map((x) => [x.id, `${x.piNumber} (${fmtMoney(x.totalAmount)})`]);
      add(live && toDispatch > 0 && can('dispatch.create', pid), A('Record vendor dispatch', 'send', () => formModal({ title: `Vendor dispatch — ${r.id}`, wide: true, fields: formFields('dispatches'), values: { dispatchDate: today(), qty: toDispatch }, submitLabel: 'Record dispatch', onSubmit: (v) => PR.addDispatch(pid, r.id, v) }), 'primary'));
      add(r.status !== 'Cancelled' && can('pi.create', pid), A('Record proforma invoice', 'receipt', () => formModal({ title: `Proforma invoice — ${r.id}`, fields: formFields('proformaInvoices'), values: { piDate: today() }, submitLabel: 'Record PI', onSubmit: (v) => PR.addPI(pid, r.id, v) })));
      add(r.status !== 'Cancelled' && can('payments.create', pid), A('Record payment', 'wallet', () => formModal({ title: `Payment — ${r.id}`, intro: `Payable ${fmtMoney(fin.payable)} · paid ${fmtMoney(fin.paid)} · outstanding <b>${fmtMoney(fin.outstanding)}</b>`, fields: formFields('payments').map((x) => (x.name === 'piId' ? { ...x, opts: pis } : x.name === 'status' ? { ...x, opts: ['Pending', 'Successful', 'Failed'] } : x)), values: { paymentDate: today(), status: 'Successful' }, submitLabel: 'Record payment', onSubmit: (v) => PR.addPayment(pid, r.id, v) }), 'primary'));
      add(r.status !== 'Cancelled' && can('payments.approve', pid), A('Authorise payable adjustment', 'money', () => formModal({ title: `Adjust payable amount — ${r.id}`, intro: 'Use this only for an agreed change of the amount payable (for example extra freight). It is recorded with your name.', fields: [f('amount', 'Adjustment (+ increases, − reduces)', 'money', { req: true, neg: true }), f('reason', 'Reason', 'textarea', { req: true })], submitLabel: 'Authorise', onSubmit: (v) => PR.addPaymentAdjustment(pid, r.id, v) })));
      add(live && can('po.edit', pid), A('Edit delivery and terms', 'edit', () => formModal({ title: `Edit ${r.id}`, fields: formFields('purchaseOrders', ['poDate', 'deliveryAddress', 'deliveryDate', 'paymentTerms', 'remarks']), values: r, onSubmit: (v) => PR.updatePO(pid, r.id, v) })));
      add(live && canAny(['po.updateStatus', 'po.edit'], pid), A('Close PO', 'check', async () => { if (await confirmDialog({ title: 'Close purchase order', body: 'Close this PO? No further dispatches can be recorded against a closed PO.' })) await PR.closePO(pid, r.id).then(() => toast('PO closed.')); }));
      add(live && can('po.edit', pid), A('Cancel PO', 'x', () => formModal({ title: `Cancel ${r.id}`, danger: true, fields: [f('reason', 'Reason', 'textarea', { req: true })], submitLabel: 'Cancel PO', onSubmit: (v) => PR.cancelPO(pid, r.id, v) }), 'danger'));
      break;
    }
    case 'payments':
      add(canAny(['payments.updateStatus', 'payments.edit'], pid), A('Update payment status', 'edit', () => formModal({ title: `Payment ${r.id}`, fields: [f('status', 'Payment status', 'select', { req: true, opts: ['Pending', 'Successful', 'Failed', 'Reversed'], value: r.status }), f('remarks', 'Remarks', 'textarea', { value: r.remarks })], onSubmit: (v) => PR.setPaymentStatus(pid, r.id, v) }), 'primary'));
      break;
    case 'dispatches': {
      const pend = round(num(r.qty) - num(r.receivedQty));
      add(pend > 0 && can('receipts.create', pid), A('Confirm material receipt (GRN)', 'packageCheck', () => formModal({ title: `Material receipt — ${r.id}`, wide: true, intro: 'Confirm only what has physically arrived and been counted.', fields: [...RECEIPT_FIELDS(pend), f('receiptDate', 'Receipt date', 'date', { req: true, value: today() }), f('challanNumber', 'Delivery challan number', 'text', { value: r.challanNumber }), f('inspectionStatus', 'Inspection status', 'select', { opts: ['Pending', 'Accepted', 'Partially Accepted', 'Rejected'] }), f('damageDetails', 'Damage details', 'textarea'), f('shortageDetails', 'Shortage details', 'textarea'), f('inspectionRemarks', 'Inspection remarks', 'textarea')], submitLabel: 'Create GRN', onSubmit: (v) => PR.receiveMaterial(pid, r.id, v) }), 'primary'));
      break;
    }
    case 'materialRequests': {
      const toDispatch = round(num(r.approvedQty) - num(r.dispatchedQty)); const toReceive = round(num(r.dispatchedQty) - num(r.receivedQty));
      add(r.status === 'Created' && can('mr.approve', pid), A('Approve or reject', 'check', () => formModal({ title: `Decide ${r.id}`, intro: `Requested ${fmtQty(r.qtyRequested)}; available at SPIF now: ${fmtQty(itemQuantities(pid, r.itemId).spifAvailable)}.`, fields: [...DECISION(), f('approvedQty', 'Approved quantity', 'number', { value: Math.min(num(r.qtyRequested), itemQuantities(pid, r.itemId).spifAvailable) })], submitLabel: 'Record decision', onSubmit: (v) => M.decideMR(pid, r.id, v) }), 'primary'));
      add(r.status === 'Approved' && canAny(['mr.updateStatus', 'mr.edit'], pid), A('Mark material prepared', 'check', () => M.prepareMR(pid, r.id, { date: today() }).then(() => toast('Marked as prepared.'))));
      add(['Approved', 'Material Prepared', 'Partially Dispatched', 'Partially Received'].includes(r.status) && toDispatch > 0 && canAny(['mr.updateStatus', 'mr.edit'], pid), A('Record dispatch to GVT', 'send', () => formModal({ title: `Dispatch to GVT — ${r.id}`, fields: [f('qty', `Quantity dispatched (up to ${fmtQty(toDispatch)})`, 'number', { req: true, value: toDispatch }), f('date', 'Dispatch date', 'date', { req: true, value: today() })], onSubmit: (v) => M.dispatchMR(pid, r.id, v) }), 'primary'));
      add(toReceive > 0 && can('gvt.create', pid), A('Confirm receipt at GVT', 'packageCheck', () => formModal({ title: `Receipt at GVT — ${r.id}`, wide: true, fields: [...RECEIPT_FIELDS(toReceive), f('receiptDate', 'Receipt date', 'date', { req: true, value: today() }), f('receivingPerson', 'Receiving person'), f('discrepancy', 'Discrepancy report', 'textarea'), f('inspectionRemarks', 'Inspection remarks', 'textarea')], submitLabel: 'Confirm receipt', onSubmit: (v) => M.receiveAtGVT(pid, r.id, v) }), 'primary'));
      add(num(r.dispatchedQty) === 0 && !['Cancelled', 'Rejected'].includes(r.status) && canAny(['mr.updateStatus', 'mr.edit'], pid), A('Cancel MR', 'x', () => formModal({ title: `Cancel ${r.id}`, danger: true, fields: [f('reason', 'Reason', 'textarea', { req: true })], submitLabel: 'Cancel MR', onSubmit: (v) => M.cancelMR(pid, r.id, v) }), 'danger'));
      break;
    }
    case 'logistics':
      add(canAny(['logistics.updateStatus', 'logistics.edit'], pid), A('Update status', 'truck', () => formModal({ title: `Logistics ${r.id}`, fields: [f('status', 'Status', 'select', { req: true, opts: ['Requested', 'Scheduled', 'In Transit', 'Delivered', 'Cancelled'], value: r.status }), f('actualDelivery', 'Actual delivery date', 'date', { hint: 'Required for “Delivered”.' }), f('trackingDetails', 'Tracking details', 'text', { value: r.trackingDetails })], onSubmit: (v) => M.setLogisticsStatus(pid, r.id, v) }), 'primary'));
      add(can('logistics.edit', pid), A('Edit', 'edit', () => formModal({ title: `Edit ${r.id}`, wide: true, fields: formFields('logistics').map((x) => (x.name === 'itemId' ? { ...x, opts: items(pid) } : x)), values: r, onSubmit: (v) => M.saveLogistics(pid, r.id, v) })));
      break;
    case 'travelDesk':
      add(r.approvalStatus === 'Pending' && can('travel.approve', pid), A('Approve or reject', 'check', () => formModal({ title: `Decide ${r.id}`, fields: DECISION(), submitLabel: 'Record decision', onSubmit: (v) => M.decideTravel(pid, r.id, v) }), 'primary'));
      add(canAny(['travel.updateStatus', 'travel.edit'], pid), A('Update status', 'plane', () => formModal({ title: `Travel ${r.id}`, fields: [f('status', 'Status', 'select', { req: true, opts: ['Requested', 'Booked', 'In Progress', 'Completed', 'Cancelled'], value: r.status }), f('bookingRefs', 'Booking references', 'text', { value: r.bookingRefs })], onSubmit: (v) => M.setTravelStatus(pid, r.id, v) })));
      add(can('travel.edit', pid), A('Edit', 'edit', () => formModal({ title: `Edit ${r.id}`, wide: true, fields: formFields('travelDesk').filter((x) => x.name !== 'status').map((x) => (x.name === 'logisticsId' ? { ...x, opts: store.list('logistics', pid).map((l) => [l.id, `${l.id} — ${l.destination}`]) } : x)), values: r, onSubmit: (v) => M.saveTravel(pid, r.id, { ...v, status: r.status }) })));
      break;
    case 'gatePasses': {
      const out2 = round(num(r.qty) - num(r.returnedQty));
      add(r.status === 'Pending Approval' && can('gatepass.approve', pid), A('Approve or reject', 'check', () => formModal({ title: `Decide ${r.id}`, fields: DECISION(), submitLabel: 'Record decision', onSubmit: (v) => M.decideGatePass(pid, r.id, v) }), 'primary'));
      add(r.status === 'Approved' && canAny(['gatepass.updateStatus', 'gatepass.edit', 'gatepass.create'], pid), A('Issue pass (material moves out)', 'send', async () => { if (await confirmDialog({ title: `Issue ${r.id}`, body: 'Confirm that the material has left the premises against this pass. Once issued, the movement record is permanent.', confirmLabel: 'Issue' })) await M.issueGatePass(pid, r.id).then(() => toast('Gate pass issued.')); }, 'primary'));
      add(r.type === 'RGP' && ['Issued', 'Partially Returned'].includes(r.status) && canAny(['gatepass.updateStatus', 'gatepass.edit', 'gatepass.create'], pid), A('Record return', 'repeat', () => formModal({ title: `Return against ${r.id}`, fields: [f('qty', `Returned quantity (${fmtQty(out2)} still out)`, 'number', { req: true, value: out2 }), f('returnDate', 'Return date', 'date', { req: true, value: today() }), f('condition', 'Condition on return'), f('remarks', 'Remarks', 'textarea')], onSubmit: (v) => M.recordGatePassReturn(pid, r.id, v) }), 'primary'));
      add(((r.type === 'RGP' && ['Returned – Pending Closure', 'Partially Returned', 'Issued'].includes(r.status)) || (r.type === 'NRGP' && r.status === 'Issued')) && can('gatepass.approve', pid), A('Inspect and close', 'check', () => formModal({ title: `Close ${r.id}`, intro: r.type === 'RGP' && out2 > 0 ? `${fmtQty(out2)} unit(s) have not been returned. Closing needs a written resolution.` : 'Closure is an authorised confirmation and is recorded with your name.', fields: [f('inspectionRemarks', 'Inspection remarks / resolution', 'textarea', { req: r.type === 'RGP' && out2 > 0 })], submitLabel: 'Close pass', onSubmit: (v) => M.closeGatePass(pid, r.id, v) }), r.status === 'Returned – Pending Closure' ? 'primary' : ''));
      add(['Pending Approval', 'Approved'].includes(r.status) && canAny(['gatepass.updateStatus', 'gatepass.edit'], pid), A('Cancel', 'x', () => formModal({ title: `Cancel ${r.id}`, danger: true, fields: [f('reason', 'Reason', 'textarea', { req: true })], submitLabel: 'Cancel pass', onSubmit: (v) => M.cancelGatePass(pid, r.id, v) }), 'danger'));
      break;
    }
    case 'development':
      add(can('development.updateStatus', pid), A('Update status', 'wrench', () => formModal({ title: `Development status — ${r.itemCode}`, intro: `Current status: <b>${r.status}</b>. Every change is stored as a dated update.`, fields: [f('status', 'New status', 'select', { req: true, opts: D.DEV_STATUSES.filter((s) => s !== 'Reopened' && s !== r.status) }), f('date', 'Date', 'date', { value: today() }), f('note', 'Work done / reason', 'textarea', { req: true }), f('issues', 'Issues', 'textarea', { value: r.issues })], onSubmit: (v) => D.setDevStatus(pid, r.id, v) }), 'primary'));
      add(canAny(['development.create', 'development.edit', 'development.updateStatus'], pid), A('Add progress update', 'plus', () => formModal({ title: `Development update — ${r.itemCode}`, fields: [f('date', 'Date', 'date', { value: today() }), f('note', 'Work done', 'textarea', { req: true }), f('issues', 'Issues', 'textarea')], onSubmit: (v) => D.addDevUpdate(pid, r.id, v) })));
      add(can('development.edit', pid), A('Edit details', 'edit', () => formModal({ title: `Development — ${r.itemCode}`, wide: true, fields: formFields('development'), values: r, onSubmit: (v) => D.updateDevelopment(pid, r.id, v) })));
      break;
    case 'testing':
      add(['Not Started', 'In Progress'].includes(r.status) && can('testing.updateStatus', pid), A('Record test result', 'flask', () => formModal({ title: `Test cycle ${r.cycle} — ${r.itemCode}`, intro: 'A recorded result is final. A failed test reopens development; the next attempt is a new cycle.', fields: [f('status', 'Outcome', 'select', { req: true, opts: ['In Progress', 'Passed', 'Failed', 'Retest Required'] }), f('testDate', 'Test date', 'date', { value: r.testDate || today() }), f('result', 'Test result', 'textarea'), f('observations', 'Observations', 'textarea'), f('issues', 'Issues', 'textarea')], submitLabel: 'Record result', onSubmit: (v) => D.recordTestResult(pid, r.id, v) }), 'primary'));
      add(r.status === 'Passed' && can('testing.approve', pid), A('Approve test result', 'check', async () => { if (await confirmDialog({ title: `Approve cycle ${r.cycle}`, body: `Approve the passed test of ${esc2(r.itemCode)}? This completes the testing stage.`, confirmLabel: 'Approve' })) await D.approveTest(pid, r.id).then(() => toast('Test approved.')); }, 'primary'));
      break;
    default:
  }
  return out;
}
function esc2(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export const runAction = (a) => Promise.resolve().then(() => a.run()).catch(showError);
