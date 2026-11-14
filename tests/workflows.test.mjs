/**
 * Workflow tests (section 34): inventory, procurement, material, development,
 * testing, closure. They run the real services with the real security rules.
 *   node --test tests/
 */
import { test } from 'node:test';
import { makeWorld, refuses, assert, store } from './harness.mjs';
import { newProject, newItem, verify, reqOf, transferOf, raisePR, approvePR, toPO, devCompleted, REPL, PROJ } from './scenario.mjs';
import * as P from '../js/services/projects.js';
import * as I from '../js/services/inventory.js';
import * as PR from '../js/services/procurement.js';
import * as M from '../js/services/material.js';
import * as D from '../js/services/devtest.js';
import * as C from '../js/services/closure.js';
import { itemQuantities, computeItemQuantities } from '../js/services/quantities.js';
import { itemStages, updateStage } from '../js/services/stages.js';
import { activities, dueInfo, projectHealth, projectProgress, projectExpenditure, kpis } from '../js/services/insights.js';
import { runReport, globalSearch, REPORTS } from '../js/services/reports.js';
import { stageId } from '../js/config/app-config.js';
import { addDays, today } from '../js/utils/format.js';

const stage = (pid, itemId, branch, key) => store.get('stages', pid, stageId(itemId, branch, key));

/* ================================================================== INVENTORY */
test('inventory: fully available → transfer for all + replenishment for all, no project procurement', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 10);
  const r = await verify(w, pid, it, 10);
  assert.equal(r.availability, 'Fully Available');
  const t = transferOf(pid, it);
  assert.equal(t.qty, 10); assert.equal(t.status, 'Requested');
  const repl = reqOf(pid, it, REPL);
  assert.equal(repl.qty, 10); assert.equal(repl.transferId, t.id); assert.equal(t.requirementId, repl.id);
  assert.equal(reqOf(pid, it, PROJ), undefined, 'no project procurement when fully available');
  // Branch A and Branch B both exist and are separate
  assert.ok(stage(pid, it, 'A', 'transfer')); assert.ok(stage(pid, it, 'B', 'pr')); assert.equal(stage(pid, it, 'A', 'pr'), null);
  assert.equal(stage(pid, it, 'A', 'availability').status, 'Completed');
  const q = itemQuantities(pid, it);
  assert.deepEqual([q.required, q.reserved, q.outstanding, q.uncovered, q.replenishmentReqQty], [10, 10, 10, 0, 10]);
  assert.equal(q.fulfilled, false, 'not fulfilled until material is accepted');
});

test('inventory: partially available → transfer 6, procure 4 for project, replenish 6', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 10);
  const r = await verify(w, pid, it, 6);
  assert.deepEqual([r.availability, r.transferQty, r.shortage], ['Partially Available', 6, 4]);
  assert.equal(transferOf(pid, it).qty, 6);
  assert.equal(reqOf(pid, it, PROJ).qty, 4);
  assert.equal(reqOf(pid, it, REPL).qty, 6);
  assert.ok(stage(pid, it, 'A', 'pr') && stage(pid, it, 'B', 'pr'));
});

test('inventory: not available → procure 10 for project, no transfer, no replenishment', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 10);
  const r = await verify(w, pid, it, 0);
  assert.equal(r.availability, 'Not Available');
  assert.equal(transferOf(pid, it), undefined);
  assert.equal(reqOf(pid, it, REPL), undefined);
  assert.equal(reqOf(pid, it, PROJ).qty, 10);
  assert.equal(stage(pid, it, 'B', 'pr'), null, 'no Branch B without a transfer');
  await refuses(I.verifyAvailability(pid, it, { availableQty: 3, sourceDeptId: 'stores', verifiedAt: '2026-11-02' }), /already been verified/);
});

test('inventory: negative quantities and over-reservation are refused; stock never goes negative', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const a = await newItem(w, pid, 'A', 10); const b = await newItem(w, pid, 'A', 5);
  await w.as('stores');
  await refuses(I.verifyAvailability(pid, a, { availableQty: -1, sourceDeptId: 'stores', verifiedAt: '2026-11-02' }), /negative/);
  await I.saveStockRecord(null, { itemCode: 'A', itemName: 'Item A', deptId: 'stores', onHand: 12 });
  await w.settle();
  await verify(w, pid, a, 12); // reserves 10 of 12
  await refuses(I.verifyAvailability(pid, b, { availableQty: 5, sourceDeptId: 'stores', verifiedAt: '2026-11-02' }), /only 2 free/);
  const stock = store.stock()[0];
  assert.deepEqual([stock.onHand, stock.reserved], [12, 10]);
  // direct attempt to push stock below zero is rejected by the rules
  const be = w.backend;
  await refuses(be.update({ [`/inventory/${stock.id}/qty/onHand`]: -5 }));
});

test('inventory: partial stock transfer, receipt with rejection, and linked quantities', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 10);
  await verify(w, pid, it, 10);
  const t = transferOf(pid, it);
  await w.as('stores');
  await refuses(I.dispatchTransfer(pid, t.id, { qty: 4, date: '2026-11-04' }), /must be approved/);
  await w.as('stores_head'); await I.decideTransfer(pid, t.id, { decision: 'Approved' }); await w.settle();
  await w.as('stores');
  await I.dispatchTransfer(pid, t.id, { qty: 4, date: '2026-11-04' }); await w.settle();
  assert.equal(transferOf(pid, it).status, 'Partially Dispatched');
  await refuses(I.dispatchTransfer(pid, t.id, { qty: 7, date: '2026-11-05' }), /Only 6/);
  await refuses(I.receiveTransfer(pid, t.id, { receivedQty: 5, acceptedQty: 5, rejectedQty: 0, date: '2026-11-05' }), /Only 4/);
  await refuses(I.receiveTransfer(pid, t.id, { receivedQty: 4, acceptedQty: 3, rejectedQty: 0, date: '2026-11-05' }), /must equal/);
  await I.receiveTransfer(pid, t.id, { receivedQty: 4, acceptedQty: 3, rejectedQty: 1, date: '2026-11-05' }); await w.settle();
  await I.dispatchTransfer(pid, t.id, { qty: 6, date: '2026-11-06' }); await w.settle();
  await I.receiveTransfer(pid, t.id, { receivedQty: 6, acceptedQty: 6, rejectedQty: 0, date: '2026-11-07' }); await w.settle();
  const tt = transferOf(pid, it);
  assert.deepEqual([tt.status, tt.dispatchedQty, tt.receivedQty, tt.acceptedQty, tt.rejectedQty], ['Received', 10, 10, 9, 1]);
  const q = itemQuantities(pid, it);
  assert.deepEqual([q.transferred, q.accepted, q.rejected, q.outstanding, q.uncovered], [10, 9, 1, 1, 1]);
  const stock = store.stock()[0];
  assert.deepEqual([stock.onHand, stock.reserved], [0, 0]);
  // the rejected unit is uncovered → project procurement can be raised for exactly 1, not more (no duplicate procurement)
  await w.as('planning');
  await refuses(I.createCoverageRequirement(pid, it, { qty: 2 }), /Only 1/);
  await I.createCoverageRequirement(pid, it, { qty: 1 }); await w.settle();
  assert.equal(itemQuantities(pid, it).uncovered, 0);
  assert.ok(stage(pid, it, 'A', 'pr'), 'procurement stages were added for the coverage requirement');
});

test('inventory: cancelled transfer keeps the replenishment requirement and sends it to authorised review', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 10);
  await verify(w, pid, it, 10);
  const t = transferOf(pid, it);
  await w.as('stores');
  await refuses(I.cancelTransfer(pid, t.id, { reason: '' }), /reason/);
  await I.cancelTransfer(pid, t.id, { reason: 'Stock damaged' }); await w.settle();
  const req = reqOf(pid, it, REPL);
  assert.equal(transferOf(pid, it).status, 'Cancelled');
  assert.equal(req.status, 'Under Review', 'requirement is not deleted, it is under review');
  assert.equal(store.stock()[0].reserved, 0, 'reservation released');
  assert.equal(itemQuantities(pid, it).uncovered, 10);
  // no PR can be raised while under review; only an approver can review
  await w.as('planning');
  await refuses(PR.createPR(pid, req.id, { purpose: 'x', requestingDeptId: 'planning', requestDate: '2026-11-03' }), /under review/);
  await refuses(I.reviewRequirement(pid, req.id, { decision: 'cancel', remarks: 'not needed' }), /permission/);
  await w.as('planning_head');
  await refuses(I.reviewRequirement(pid, req.id, { decision: 'cancel', remarks: '' }), /reasoning/);
  await I.reviewRequirement(pid, req.id, { decision: 'cancel', remarks: 'Nothing was transferred, so nothing to replenish.' }); await w.settle();
  const after = reqOf(pid, it, REPL);
  assert.deepEqual([after.status, after.reviewDecision], ['Cancelled', 'Requirement cancelled']);
  assert.ok(after.reviewedBy, 'review is attributed');
});

test('inventory: replenishment quantity adjustment after a transfer change', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 10);
  await verify(w, pid, it, 10);
  const t = transferOf(pid, it);
  await w.as('stores_head');
  await I.adjustTransferQty(pid, t.id, { newQty: 7, reason: 'Three units reserved for another project' }); await w.settle();
  assert.equal(transferOf(pid, it).qty, 7);
  assert.equal(reqOf(pid, it, REPL).status, 'Under Review');
  assert.equal(reqOf(pid, it, REPL).qty, 10, 'quantity is not changed silently');
  assert.equal(itemQuantities(pid, it).uncovered, 3);
  await w.as('planning_head');
  await I.reviewRequirement(pid, reqOf(pid, it, REPL).id, { decision: 'adjust', newQty: 7, remarks: 'Match the adjusted transfer.' }); await w.settle();
  assert.deepEqual([reqOf(pid, it, REPL).qty, reqOf(pid, it, REPL).status], [7, 'Open']);
});

test('quantities: transferred and procured units are never double-counted; replenishment never counts for the project', () => {
  const q = computeItemQuantities({
    item: { requiredQty: 10 }, check: { availableQty: 6 },
    transfers: [{ qty: 6, dispatchedQty: 6, receivedQty: 6, acceptedQty: 6, rejectedQty: 0, status: 'Received' }],
    reqs: [{ type: PROJ, qty: 4, status: 'PR Raised' }, { type: REPL, qty: 6, status: 'PR Raised' }],
    pos: [{ procurementType: PROJ, quantity: 4, status: 'Issued' }, { procurementType: REPL, quantity: 6, status: 'Issued' }],
    dispatches: [{ procurementType: PROJ, qty: 4 }, { procurementType: REPL, qty: 6 }],
    receipts: [{ procurementType: PROJ, receivedQty: 4, acceptedQty: 4, rejectedQty: 0 }, { procurementType: REPL, receivedQty: 6, acceptedQty: 6, rejectedQty: 0 }],
  });
  assert.deepEqual([q.required, q.transferred, q.procuredProject, q.procuredReplenishment, q.dispatched, q.received, q.accepted, q.outstanding], [10, 6, 4, 6, 10, 10, 10, 0]);
  assert.equal(q.replenishmentReceived, 6);
  assert.equal(q.fulfilled, true);
});

/* ================================================================== PROCUREMENT */
test('procurement: PR creation, rejection reopens the requirement, approval, no quotation before approval', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 10);
  await verify(w, pid, it, 0);
  const req = reqOf(pid, it, PROJ);
  const pr1 = await raisePR(w, pid, req.id);
  assert.equal(store.get('purchaseRequests', pid, pr1).status, 'Pending Approval');
  assert.equal(reqOf(pid, it, PROJ).status, 'PR Raised');
  assert.equal(stage(pid, it, 'A', 'prApproval').status, 'Waiting for Approval');
  await refuses(PR.createPR(pid, req.id, { purpose: 'dup', requestingDeptId: 'planning', requestDate: '2026-11-03' }), /cannot be raised/);
  // Mandatory rule: no quotation before approval (service)…
  await w.as('sourcing');
  await refuses(PR.addQuotation(pid, pr1, { vendorName: 'V', unitPrice: 10 }), /cannot be added until the PR is approved/);
  // …and when the request is sent straight to the database, the rules refuse it too
  const b = w.backend; const ts = b.serverTimestamp(); const logId = b.newId();
  await refuses(b.update({
    [`/quotations/${pid}/QTN-${pid}-0001`]: { core: { prId: pr1, itemId: it, qty: 10, vendorName: 'V', unitPrice: 10, totalAmount: 100 }, meta: { createdAt: ts, createdBy: 'u_sourcing', updatedAt: ts, updatedBy: 'u_sourcing', _v: 1, _log: logId } },
    [`/activityLogs/${pid}/${logId}`]: { at: ts, uid: 'u_sourcing', name: 'x', action: 'x', rtype: 'quotations', rid: `QTN-${pid}-0001` },
  }));
  // rejection
  await w.as('planning_head');
  await refuses(PR.decidePR(pid, pr1, { decision: 'Rejected' }), /reason/);
  await PR.decidePR(pid, pr1, { decision: 'Rejected', rejectionReason: 'Wrong specification' }); await w.settle();
  assert.equal(store.get('purchaseRequests', pid, pr1).status, 'Rejected');
  assert.deepEqual([reqOf(pid, it, PROJ).status, reqOf(pid, it, PROJ).prId], ['Open', undefined]);
  // a new PR, then approval
  const pr2 = await raisePR(w, pid, req.id);
  await approvePR(w, pid, pr2);
  const pr = store.get('purchaseRequests', pid, pr2);
  assert.deepEqual([pr.status, pr.approverId, pr.decision], ['Approved', 'u_planning_head', 'Approved']);
  assert.equal(stage(pid, it, 'A', 'prApproval').status, 'Completed');
  await w.as('sourcing');
  await PR.addQuotation(pid, pr2, { vendorName: 'V', unitPrice: 10 }); await w.settle();
  assert.equal(store.list('quotations', pid).length, 1);
});

test('procurement: the requester cannot approve their own PR; changes requested → resubmit', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 5);
  await verify(w, pid, it, 0);
  await w.as('planning_head');
  const prId = await PR.createPR(pid, reqOf(pid, it, PROJ).id, { purpose: 'p', requestingDeptId: 'planning', requestDate: '2026-11-03' }); await w.settle();
  await refuses(PR.decidePR(pid, prId, { decision: 'Approved' }), /someone else/);
  await w.as('pm');
  await PR.decidePR(pid, prId, { decision: 'Changes Requested', comments: 'Add the required-by date' }); await w.settle();
  assert.equal(store.get('purchaseRequests', pid, prId).status, 'Changes Requested');
  await w.as('planning_head');
  await PR.updatePR(pid, prId, { purpose: 'p', requestingDeptId: 'planning', requestDate: '2026-11-03', requiredBy: '2026-12-10' }); await w.settle();
  assert.equal(store.get('purchaseRequests', pid, prId).status, 'Pending Approval');
  await w.as('pm'); await PR.decidePR(pid, prId, { decision: 'Approved' }); await w.settle();
  // an approved PR is frozen
  await w.as('planning_head');
  await refuses(PR.updatePR(pid, prId, { purpose: 'changed', requestingDeptId: 'planning', requestDate: '2026-11-03' }), /no longer be edited/);
  await refuses(w.backend.update({ [`/purchaseRequests/${pid}/${prId}/core/purpose`]: 'tampered' }));
});

test('procurement: multiple quotations, comparison, vendor selection, PO limits, PI', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 10);
  await verify(w, pid, it, 0);
  const prId = await raisePR(w, pid, reqOf(pid, it, PROJ).id); await approvePR(w, pid, prId);
  await w.as('sourcing');
  const q1 = await PR.addQuotation(pid, prId, { vendorName: 'Alpha', unitPrice: 100, gstPercent: 18, shippingCharges: 50 }); await w.settle();
  const q2 = await PR.addQuotation(pid, prId, { vendorName: 'Beta', unitPrice: 95, gstPercent: 18, shippingCharges: 300, otherCharges: 20 }); await w.settle();
  const q3 = await PR.addQuotation(pid, prId, { vendorName: 'Gamma', unitPrice: 110, gstPercent: 12 }); await w.settle();
  const total = (id) => store.get('quotations', pid, id).totalAmount;
  assert.deepEqual([total(q1), total(q2), total(q3)], [1230, 1441, 1232]);
  await refuses(PR.createPO(pid, prId, { poDate: '2026-11-05', quantity: 10, unitPrice: 100 }), /Select a vendor/);
  await refuses(PR.selectQuotation(pid, q1, { justification: '' }), /why/);
  await PR.selectQuotation(pid, q2, { justification: 'test' }); await w.settle();
  await PR.selectQuotation(pid, q1, { justification: 'Lowest landed cost' }); await w.settle();
  assert.equal(store.get('quotations', pid, q1).selected, true);
  assert.ok(!store.get('quotations', pid, q2).selected, 'only one quotation is selected');
  assert.equal(store.get('purchaseRequests', pid, prId).selectedQuotationId, q1);
  const rows = runReport('quotations', {}).rows; // sourcing may view the comparison
  assert.equal(rows.length, 3);
  // PO: cannot order more than the PR; two POs may split the quantity
  await refuses(PR.createPO(pid, prId, { poDate: '2026-11-05', quantity: 11, unitPrice: 100 }), /Only 10/);
  const po1 = await PR.createPO(pid, prId, { poDate: '2026-11-05', quantity: 6, unitPrice: 100, taxPercent: 18, otherCharges: 50 }); await w.settle();
  assert.equal(store.get('purchaseOrders', pid, po1).totalValue, 758);
  assert.equal(stage(pid, it, 'A', 'po').status, 'In Progress');
  await refuses(PR.createPO(pid, prId, { poDate: '2026-11-05', quantity: 5, unitPrice: 100 }), /Only 4/);
  await refuses(PR.selectQuotation(pid, q3, { justification: 'switch' }), /already exists/);
  const po2 = await PR.createPO(pid, prId, { poDate: '2026-11-06', quantity: 4, unitPrice: 100 }); await w.settle();
  assert.equal(store.get('purchaseRequests', pid, prId).orderedQty, 10);
  assert.equal(stage(pid, it, 'A', 'po').status, 'Completed');
  assert.equal(itemQuantities(pid, it).procuredProject, 10);
  const pi = await PR.addPI(pid, po1, { piNumber: 'PI-77', piDate: '2026-11-07', amount: 600, tax: 108 }); await w.settle();
  assert.equal(store.get('proformaInvoices', pid, pi).totalAmount, 708);
  // cancelling a PO gives the quantity back to the PR
  await PR.cancelPO(pid, po2, { reason: 'Vendor withdrew' }); await w.settle();
  assert.equal(store.get('purchaseRequests', pid, prId).orderedQty, 6);
});

test('procurement: partial payments, outstanding, overpayment blocked unless an authorised adjustment exists', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 10);
  await verify(w, pid, it, 0);
  const { poId } = await toPO(w, pid, reqOf(pid, it, PROJ).id, { unitPrice: 100 }); // PO value 1000
  await w.as('accounts');
  const pay = (amount, status = 'Successful') => PR.addPayment(pid, poId, { paymentDate: '2026-11-10', amount, mode: 'NEFT', status });
  const p1 = await pay(400); await w.settle();
  await pay(250); await w.settle();
  const pending = await pay(500, 'Pending'); await w.settle();
  let fin = PR.poFinance(store.get('purchaseOrders', pid, poId));
  assert.deepEqual([fin.payable, fin.paid, fin.outstanding], [1000, 650, 350], 'only successful payments count');
  await refuses(pay(351), /exceed the authorised payable amount/);
  await refuses(PR.setPaymentStatus(pid, pending, { status: 'Successful' }), /exceed/);
  // direct database write that would overpay is refused by the rules (paidTotal bound on the PO)
  await refuses(w.backend.update({ [`/purchaseOrders/${pid}/${poId}/pay/paidTotal`]: 5000 }));
  // an authorised adjustment needs the approve permission
  await refuses(PR.addPaymentAdjustment(pid, poId, { amount: 200, reason: 'Extra freight agreed' }), /permission/);
  await w.as('admin');
  await PR.addPaymentAdjustment(pid, poId, { amount: 200, reason: 'Extra freight agreed with vendor' }); await w.settle();
  await w.as('accounts');
  await PR.setPaymentStatus(pid, pending, { status: 'Successful' }); await w.settle();
  fin = PR.poFinance(store.get('purchaseOrders', pid, poId));
  assert.deepEqual([fin.payable, fin.paid, fin.outstanding], [1200, 1150, 50]);
  await PR.setPaymentStatus(pid, p1, { status: 'Reversed' }); await w.settle();
  assert.equal(PR.poFinance(store.get('purchaseOrders', pid, poId)).outstanding, 450);
  const exp = projectExpenditure(pid);
  assert.deepEqual([exp.project.ordered, exp.project.paid, exp.project.outstanding, exp.replenishment.ordered], [1000, 750, 450, 0]);
});

test('procurement + material: multiple dispatches, partial SPIF receipts, rejected quantity, multiple GRNs', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 10);
  await verify(w, pid, it, 0);
  const { poId } = await toPO(w, pid, reqOf(pid, it, PROJ).id);
  await w.as('sourcing');
  const d1 = await PR.addDispatch(pid, poId, { dispatchDate: '2026-11-12', qty: 6, expectedDelivery: '2026-11-15' }); await w.settle();
  await refuses(PR.addDispatch(pid, poId, { dispatchDate: '2026-11-13', qty: 5 }), /Only 4/);
  const d2 = await PR.addDispatch(pid, poId, { dispatchDate: '2026-11-13', qty: 4 }); await w.settle();
  // an expected delivery date in the past does NOT mark anything as received
  assert.equal(store.get('purchaseOrders', pid, poId).receivedQty, 0);
  assert.equal(itemQuantities(pid, it).received, 0);
  await refuses(PR.receiveMaterial(pid, d1, { receiptDate: '2026-11-15', receivedQty: 3, acceptedQty: 3, rejectedQty: 0 }), /permission/); // Sourcing cannot confirm receipt
  await w.as('stores');
  const rcv = (d, r, a, x) => PR.receiveMaterial(pid, d, { receiptDate: '2026-11-15', receivedQty: r, acceptedQty: a, rejectedQty: x });
  await rcv(d1, 4, 3, 1); await w.settle();
  await refuses(rcv(d1, 3, 3, 0), /Only 2/);
  await rcv(d1, 2, 2, 0); await w.settle();
  await rcv(d2, 4, 4, 0); await w.settle();
  const grns = store.list('materialReceipts', pid);
  assert.equal(grns.length, 3, 'multiple GRNs');
  assert.ok(grns.every((g) => g.receiptLocation === 'SPIF'));
  const po = store.get('purchaseOrders', pid, poId);
  assert.deepEqual([po.dispatchedQty, po.receivedQty, po.acceptedQty, po.rejectedQty], [10, 10, 9, 1]);
  const q = itemQuantities(pid, it);
  assert.deepEqual([q.dispatched, q.received, q.accepted, q.rejected, q.outstanding, q.spifAvailable], [10, 10, 9, 1, 1, 9]);
});

test('replenishment: full Branch B goes back to the source stock and never fulfils the project', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 10);
  await w.as('stores'); await I.saveStockRecord(null, { itemCode: 'A', itemName: 'Item A', deptId: 'stores', onHand: 10 }); await w.settle();
  await verify(w, pid, it, 10);
  const t = transferOf(pid, it);
  await w.as('stores_head'); await I.decideTransfer(pid, t.id, { decision: 'Approved' }); await w.settle();
  await w.as('stores');
  await I.dispatchTransfer(pid, t.id, { qty: 10, date: '2026-11-04' }); await w.settle();
  await I.receiveTransfer(pid, t.id, { receivedQty: 10, acceptedQty: 10, rejectedQty: 0, date: '2026-11-05' }); await w.settle();
  assert.equal(store.stock()[0].onHand, 0);
  assert.equal(itemQuantities(pid, it).fulfilled, true, 'project is fulfilled by the transfer alone');
  // Branch B
  const { poId, prId } = await toPO(w, pid, reqOf(pid, it, REPL).id);
  assert.equal(store.get('purchaseRequests', pid, prId).procurementType, REPL);
  await w.as('sourcing'); const dsp = await PR.addDispatch(pid, poId, { dispatchDate: '2026-11-12', qty: 10 }); await w.settle();
  await w.as('stores'); await PR.receiveMaterial(pid, dsp, { receiptDate: '2026-11-15', receivedQty: 10, acceptedQty: 10, rejectedQty: 0 }); await w.settle();
  assert.match(store.list('materialReceipts', pid)[0].receiptLocation, /Source department: Stores/);
  assert.equal(store.stock()[0].onHand, 10, 'source department stock is replenished');
  const q = itemQuantities(pid, it);
  assert.deepEqual([q.accepted, q.procuredProject, q.procuredReplenishment, q.replenishmentReceived, q.outstanding], [10, 0, 10, 10, 0], 'replenishment is not project fulfilment');
  assert.equal(stage(pid, it, 'B', 'spifReceipt').status, 'In Progress');
  const exp = projectExpenditure(pid);
  assert.deepEqual([exp.project.ordered, exp.replenishment.ordered, exp.total.ordered], [0, 1000, 1000], 'replenishment spend is separate and counted once');
});

/* ================================================================== MATERIAL */
test('material: MR, partial movement to GVT, partial GVT receipt with discrepancy', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 10);
  await verify(w, pid, it, 0);
  const { poId } = await toPO(w, pid, reqOf(pid, it, PROJ).id);
  await w.as('sourcing'); const dsp = await PR.addDispatch(pid, poId, { dispatchDate: '2026-11-12', qty: 10 }); await w.settle();
  await w.as('stores'); await PR.receiveMaterial(pid, dsp, { receiptDate: '2026-11-15', receivedQty: 8, acceptedQty: 8, rejectedQty: 0 }); await w.settle();
  const mr = await M.createMR(pid, it, { qtyRequested: 10, requestDate: '2026-11-16' }); await w.settle();
  assert.equal(store.get('materialRequests', pid, mr).availableSpifQty, 8);
  await refuses(M.decideMR(pid, mr, { decision: 'Approved', approvedQty: 8 }), /permission/);
  await refuses(M.dispatchMR(pid, mr, { qty: 2, date: '2026-11-17' }), /cannot be dispatched/);
  await w.as('stores_head');
  await refuses(M.decideMR(pid, mr, { decision: 'Approved', approvedQty: 9 }), /Only 8/);
  await M.decideMR(pid, mr, { decision: 'Approved', approvedQty: 8 }); await w.settle();
  await w.as('stores');
  await M.prepareMR(pid, mr, { date: '2026-11-17' }); await w.settle();
  await M.dispatchMR(pid, mr, { qty: 5, date: '2026-11-18' }); await w.settle();
  assert.equal(store.get('materialRequests', pid, mr).status, 'Partially Dispatched');
  await refuses(M.receiveAtGVT(pid, mr, { receiptDate: '2026-11-19', receivedQty: 6, acceptedQty: 6, rejectedQty: 0 }), /Only 5/);
  await M.receiveAtGVT(pid, mr, { receiptDate: '2026-11-19', receivedQty: 5, acceptedQty: 4, rejectedQty: 1, discrepancy: 'One unit damaged in transit' }); await w.settle();
  assert.equal(store.get('materialRequests', pid, mr).status, 'Partially Received');
  await M.dispatchMR(pid, mr, { qty: 3, date: '2026-11-20' }); await w.settle();
  await M.receiveAtGVT(pid, mr, { receiptDate: '2026-11-21', receivedQty: 3, acceptedQty: 3, rejectedQty: 0 }); await w.settle();
  const m = store.get('materialRequests', pid, mr);
  assert.deepEqual([m.status, m.dispatchedQty, m.receivedQty, m.acceptedQty, m.rejectedQty], ['Received at GVT', 8, 8, 7, 1]);
  assert.equal(store.list('gvtReceipts', pid).length, 2);
});

test('material: logistics and travel desk run in parallel and never complete each other', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 2);
  await w.as('logistics');
  const lg = await M.saveLogistics(pid, null, { materialRef: 'MR-1', itemId: it, pickupLocation: 'SPIF', destination: 'GVT', transportMode: 'Road', expectedDelivery: addDays(today(), -2), status: 'In Transit' }); await w.settle();
  await w.as('travel');
  const tv = await M.saveTravel(pid, null, { employeeId: 'u_developer', purpose: 'Escort material', origin: 'SPIF', destination: 'GVT', travelDate: '2026-11-20', logisticsId: lg }); await w.settle();
  await refuses(M.setTravelStatus(pid, tv, { status: 'Booked' }), /approved first/);
  await w.as('pm'); await M.decideTravel(pid, tv, { decision: 'Approved' }); await w.settle();
  await w.as('travel'); await M.setTravelStatus(pid, tv, { status: 'Completed' }); await w.settle();
  assert.equal(store.get('logistics', pid, lg).status, 'In Transit', 'travel completion does not complete logistics');
  // the delivery date has passed, but the request is only overdue — not delivered
  const act = activities(pid).find((a) => a.kind === 'logistics');
  assert.deepEqual([act.cat, act.overdueDays, act.status], ['overdue', 2, 'In Transit']);
  await w.as('logistics');
  await refuses(M.setLogisticsStatus(pid, lg, { status: 'Delivered' }), /actual delivery date/);
  await M.setLogisticsStatus(pid, lg, { status: 'Delivered', actualDelivery: today() }); await w.settle();
  assert.equal(store.get('travelDesk', pid, tv).status, 'Completed');
});

test('gate passes: RGP approval, issue, overdue tracking, partial returns, authorised closure; NRGP history', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 5);
  await w.as('planning');
  await refuses(M.createGatePass(pid, { type: 'RGP', itemId: it, qty: 3, destination: 'Lab', purpose: 'Calibration', issueDate: today() }), /expected return/);
  const gp = await M.createGatePass(pid, { type: 'RGP', itemId: it, qty: 3, destination: 'Lab', purpose: 'Calibration', issueDate: addDays(today(), -10), expectedReturn: addDays(today(), -4) }); await w.settle();
  await refuses(M.issueGatePass(pid, gp), /after approval/);
  await refuses(M.decideGatePass(pid, gp, { decision: 'Approved' }), /permission/);
  await w.as('planning_head'); await M.decideGatePass(pid, gp, { decision: 'Approved' }); await w.settle();
  await w.as('planning'); await M.issueGatePass(pid, gp); await w.settle();
  const due = activities(pid).find((a) => a.kind === 'rgp');
  assert.deepEqual([due.cat, due.overdueDays], ['overdue', 4], 'overdue RGP is highlighted');
  assert.equal(store.get('gatePasses', pid, gp).status, 'Issued', 'overdue does not change the status');
  assert.ok(projectHealth(pid).reasons.some((r) => /gate pass/.test(r)));
  await M.recordGatePassReturn(pid, gp, { returnDate: today(), qty: 2, condition: 'Good' }); await w.settle();
  assert.deepEqual([store.get('gatePasses', pid, gp).status, store.get('gatePasses', pid, gp).returnedQty], ['Partially Returned', 2]);
  await refuses(M.recordGatePassReturn(pid, gp, { returnDate: today(), qty: 2 }), /Only 1/);
  await refuses(M.closeGatePass(pid, gp, { inspectionRemarks: 'ok' }), /permission/);
  await M.recordGatePassReturn(pid, gp, { returnDate: today(), qty: 1 }); await w.settle();
  assert.equal(store.get('gatePasses', pid, gp).status, 'Returned – Pending Closure', 'not closed until authorised confirmation');
  await w.as('planning_head'); await M.closeGatePass(pid, gp, { inspectionRemarks: 'All three units inspected and accepted.' }); await w.settle();
  assert.equal(store.get('gatePasses', pid, gp).status, 'Closed');
  // NRGP
  await w.as('planning');
  const ng = await M.createGatePass(pid, { type: 'NRGP', itemId: it, qty: 1, destination: 'Customer site', purpose: 'Delivery', issueDate: today() }); await w.settle();
  await w.as('planning_head'); await M.decideGatePass(pid, ng, { decision: 'Approved' }); await w.settle();
  await w.as('planning'); await M.issueGatePass(pid, ng); await w.settle();
  await refuses(M.recordGatePassReturn(pid, ng, { returnDate: today(), qty: 1 }), /Only returnable/);
  await refuses(M.cancelGatePass(pid, ng, { reason: 'mistake' }), /permanent/);
});

/* ================================================================== DEVELOPMENT & TESTING */
test('development and testing: completion, pass, failure reopens development, retest, final approval; old cycles are frozen', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 1);
  await verify(w, pid, it, 0);
  await w.as('tester');
  await refuses(D.createTestCycle(pid, it, { testPlan: 'plan' }), /only be created when development is completed/);
  await devCompleted(w, pid, it);
  assert.equal(stage(pid, it, 'A', 'development').status, 'Completed');
  await w.as('tester');
  const tc1 = await D.createTestCycle(pid, it, { testPlan: 'Bench test', engineerId: 'u_tester' }); await w.settle();
  await refuses(D.createTestCycle(pid, it, { testPlan: 'again' }), /still open/);
  await refuses(D.recordTestResult(pid, tc1, { status: 'Failed', result: 'x' }), /observations/);
  await D.recordTestResult(pid, tc1, { status: 'Failed', result: 'Overheats', observations: 'Reached 95 °C after 10 minutes' }); await w.settle();
  const dev = store.get('development', pid, it);
  assert.deepEqual([dev.status, dev.reopenCount, dev.lastFailedTestId], ['Reopened', 1, tc1]);
  assert.equal(stage(pid, it, 'A', 'development').status, 'In Progress', 'development stage reopened');
  // the failed cycle can never be overwritten — neither through the app nor directly
  await refuses(D.recordTestResult(pid, tc1, { status: 'Passed', result: 'fine' }), /never overwritten/);
  await refuses(w.backend.update({ [`/testing/${pid}/${tc1}/status/status`]: 'Passed' }));
  await refuses(w.backend.update({ [`/testing/${pid}/${tc1}/core/observations`]: 'nothing to see' }));
  await refuses(D.createTestCycle(pid, it, { testPlan: 'retest' }), /development is completed/);
  // another development iteration
  await w.as('developer');
  await D.setDevStatus(pid, it, { status: 'In Progress', note: 'Adding heat sink' }); await w.settle();
  assert.equal(store.get('development', pid, it).revision, 2);
  await D.setDevStatus(pid, it, { status: 'Completed', note: 'Heat sink fitted' }); await w.settle();
  assert.equal(store.list('developmentUpdates', pid).length, 3, 'every status change is a timestamped update');
  await w.as('tester');
  const tc2 = await D.createTestCycle(pid, it, { testPlan: 'Retest thermal' }); await w.settle();
  assert.equal(store.get('testing', pid, tc2).cycle, 2);
  await D.recordTestResult(pid, tc2, { status: 'Passed', result: 'Stable at 61 °C' }); await w.settle();
  await refuses(D.approveTest(pid, tc2), /permission/);
  await w.as('test_head'); await D.approveTest(pid, tc2); await w.settle();
  const t1 = store.get('testing', pid, tc1); const t2 = store.get('testing', pid, tc2);
  assert.deepEqual([t1.status, t1.result, t2.status, t2.approverId], ['Failed', 'Overheats', 'Approved', 'u_test_head'], 'previous cycle preserved');
  assert.equal(stage(pid, it, 'A', 'testing').status, 'Completed');
  await w.as('tester'); await refuses(D.createTestCycle(pid, it, { testPlan: 'more' }), /already approved/);
});

test('development can request additional material; it needs approval and then becomes project procurement', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 4);
  await verify(w, pid, it, 4);
  await w.as('developer');
  const id = await I.requestAdditionalMaterial(pid, it, { qty: 2, reason: 'Two units damaged during integration' }); await w.settle();
  assert.equal(store.get('procurement', pid, id).status, 'Pending Approval');
  assert.equal(itemQuantities(pid, it).required, 4, 'not counted until approved');
  await w.as('planning'); await refuses(PR.createPR(pid, id, { purpose: 'x', requestingDeptId: 'planning', requestDate: '2026-11-03' }), /cannot be raised/);
  await w.as('planning_head'); await I.decideAdditionalMaterial(pid, id, { decision: 'Approved' }); await w.settle();
  const q = itemQuantities(pid, it);
  assert.deepEqual([q.required, q.projectReqQty, q.uncovered], [6, 2, 0]);
});

/* ================================================================== STAGES & DEADLINES */
test('stages: dates never complete a stage; only authorised people change status; overdue is calculated', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 10);
  await verify(w, pid, it, 0);
  const sid = stageId(it, 'A', 'quotation');
  await w.as('pm');
  await updateStage(pid, sid, { expStart: addDays(today(), -20), expEnd: addDays(today(), -5), personId: 'u_sourcing' }); await w.settle();
  const s = store.get('stages', pid, sid);
  assert.equal(s.status, 'Not Started', 'a past expected date changes nothing');
  const a = activities(pid).find((x) => x.key === `stage:${pid}:${sid}`);
  assert.deepEqual([a.cat, a.overdueDays, a.deptId, a.personId], ['overdue', 5, 'sourcing', 'u_sourcing']);
  assert.match(a.link, /#\/items\/TST-1\//);
  assert.equal(kpis().overdue, 1);
  // the PM may plan the stage but may not complete Sourcing's stage
  await refuses(updateStage(pid, sid, { status: 'Completed' }), /permission/);
  await refuses(w.backend.update({ [`/stages/${pid}/${sid}/status/status`]: 'Completed' }));
  await w.as('sourcing');
  await updateStage(pid, sid, { status: 'Blocked', remarks: 'Waiting for PR' }); await w.settle();
  assert.equal(store.get('stages', pid, sid).status, 'Blocked');
  // classification
  assert.equal(dueInfo(today()).cat, 'today');
  assert.equal(dueInfo(addDays(today(), 3)).cat, 'soon');
  assert.equal(dueInfo(addDays(today(), 7)).cat, 'upcoming');
  assert.equal(dueInfo(addDays(today(), 8)).cat, 'ontrack');
  assert.equal(itemStages(pid, it, 'A').length, 15);
});

test('progress and health are derived from configurable rules and explain themselves', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 10);
  assert.equal(projectHealth(pid).level, 'green');
  await verify(w, pid, it, 10);
  const p0 = projectProgress(pid).overall;
  assert.ok(p0 > 0 && p0 < 0.2, `availability completed gives a little progress (${p0})`);
  const t = transferOf(pid, it);
  await w.as('stores'); await I.cancelTransfer(pid, t.id, { reason: 'test' }); await w.settle();
  const h = projectHealth(pid);
  assert.equal(h.level, 'amber');
  assert.ok(h.reasons.some((r) => /shortage/.test(r)), h.reasons.join('|'));
});

/* ================================================================== CLOSURE */
test('closure: checklist blocks completion, override needs a reason, history is kept, reopen works', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 2);
  await verify(w, pid, it, 0);
  await w.as('pm');
  const list = C.closureChecklist(pid);
  assert.equal(list.length, 9);
  assert.equal(list.find((c) => c.key === 'c_development').auto, false);
  const all = Object.fromEntries(list.map((c) => [c.key, true]));
  await refuses(C.completeProject(pid, { confirm: all, completionDate: today() }), /checklist is not complete/);
  await refuses(C.completeProject(pid, { confirm: all, completionDate: today(), override: true, overrideReason: '' }), /written reason/);
  await refuses(P.setProjectStatus(pid, 'Completed'), /project closure/);
  // even a direct write cannot complete the project without a closure record
  await refuses(w.backend.update({ [`/projects/${pid}/status/status`]: 'Completed' }));
  await w.as('stores'); // no closure permission
  await refuses(C.completeProject(pid, { confirm: all, completionDate: today(), override: true, overrideReason: 'Customer accepted as is' }), /permission/);
  await w.as('pm');
  await C.completeProject(pid, { confirm: all, completionDate: today(), override: true, overrideReason: 'Customer accepted the prototype as is', finalRemarks: 'Closed early' }); await w.settle();
  assert.equal(store.project(pid).status, 'Completed');
  const rec = store.get('closures', pid, 'completion');
  assert.deepEqual([rec.override, rec.approvedBy, rec.c_development], [true, 'u_pm', false]);
  assert.match(rec.unresolved, /Development completed/);
  assert.equal(store.list('projectItems', pid).length, 1, 'records are retained');
  await w.as('admin'); await refuses(P.addItem(pid, { itemCode: 'B', name: 'B', requiredQty: 1, uom: 'Nos' }), /completed/);
  await w.as('pm');
  await C.reopenProject(pid, { reason: 'Customer asked for a second unit' }); await w.settle();
  assert.equal(store.project(pid).status, 'Active');
  assert.ok(store.get('closures', pid, 'completion'), 'earlier closure record kept');
});

test('closure: cancellation captures settlement details and deletes nothing', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 2);
  await verify(w, pid, it, 0);
  const { poId } = await toPO(w, pid, reqOf(pid, it, PROJ).id);
  await w.as('pm');
  await refuses(C.cancelProject(pid, { reason: 'Budget withdrawn', cancellationDate: today() }), /material status/);
  await C.cancelProject(pid, { reason: 'Budget withdrawn', cancellationDate: today(), materialStatus: 'Nothing received', procurementCancellationStatus: 'PO to be cancelled with vendor', paymentSettlementStatus: 'No payments made', vendorCommitments: 'PO issued', outstandingLiabilities: 200 }); await w.settle();
  assert.equal(store.project(pid).status, 'Cancelled');
  assert.ok(store.get('purchaseOrders', pid, poId), 'procurement history is preserved');
  assert.equal(store.get('closures', pid, 'cancellation').outstandingLiabilities, 200);
  assert.equal(kpis().cancelled, 1);
});

test('a clean project completes without override when every check is satisfied', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 2);
  await w.as('stores'); await I.saveStockRecord(null, { itemCode: 'A', itemName: 'Item A', deptId: 'stores', onHand: 2 }); await w.settle();
  await verify(w, pid, it, 2);
  const t = transferOf(pid, it);
  await w.as('stores_head'); await I.decideTransfer(pid, t.id, { decision: 'Approved' }); await w.settle();
  await w.as('stores'); await I.dispatchTransfer(pid, t.id, { qty: 2, date: today() }); await w.settle();
  await I.receiveTransfer(pid, t.id, { receivedQty: 2, acceptedQty: 2, rejectedQty: 0, date: today() }); await w.settle();
  const { poId } = await toPO(w, pid, reqOf(pid, it, REPL).id);
  await w.as('sourcing'); const dsp = await PR.addDispatch(pid, poId, { dispatchDate: today(), qty: 2 }); await w.settle();
  await w.as('stores'); await PR.receiveMaterial(pid, dsp, { receiptDate: today(), receivedQty: 2, acceptedQty: 2, rejectedQty: 0 }); await w.settle();
  await w.as('accounts'); await PR.addPayment(pid, poId, { paymentDate: today(), amount: 200, mode: 'NEFT', status: 'Successful' }); await w.settle();
  await devCompleted(w, pid, it);
  await w.as('tester'); const tc = await D.createTestCycle(pid, it, { testPlan: 'p' }); await w.settle();
  await D.recordTestResult(pid, tc, { status: 'Passed', result: 'ok' }); await w.settle();
  await w.as('test_head'); await D.approveTest(pid, tc); await w.settle();
  await w.as('pm');
  const list = C.closureChecklist(pid);
  assert.deepEqual(list.filter((c) => c.auto === false).map((c) => c.key), [], 'no automatic check fails');
  await refuses(C.completeProject(pid, { confirm: {}, completionDate: today() }), /not complete/); // confirmations are still required
  await C.completeProject(pid, { confirm: Object.fromEntries(list.map((c) => [c.key, true])), completionDate: today() }); await w.settle();
  assert.equal(store.project(pid).status, 'Completed');
  assert.ok(!store.get('closures', pid, 'completion').override);
  assert.equal(projectProgress(pid).material, 1);
});

/* ================================================================== PROJECTS, BOM, REPORTS, SEARCH */
test('projects and BOM: unique IDs, validation, duplicate warning, CSV import check, bulk update, clone, archive', async () => {
  const w = await makeWorld(); const pid = await newProject(w);
  await refuses(P.createProject({ id: pid, name: 'x', managerId: 'u_pm', departmentId: 'development', startDate: '2026-01-01', targetDate: '2026-02-01', priority: 'Low' }), /already in use/);
  await refuses(P.createProject({ id: 'bad id!', name: 'x', managerId: 'u_pm', departmentId: 'development', startDate: '2026-01-01', targetDate: '2026-02-01', priority: 'Low' }), /Project ID/);
  await refuses(P.createProject({ id: 'OK-1', name: 'x', managerId: 'u_pm', departmentId: 'development', startDate: '2026-03-01', targetDate: '2026-02-01', priority: 'Low' }), /before the start/);
  await refuses(P.addItem(pid, { itemCode: 'Z', name: 'Z', requiredQty: 0, uom: 'Nos' }), /greater than zero/);
  const a = await newItem(w, pid, 'MTR', 4);
  assert.equal(P.duplicateItems(pid, 'mtr').length, 1, 'duplicate item codes are detected for the warning');
  const dup = await P.duplicateItem(pid, a); await w.settle();
  assert.equal(store.list('projectItems', pid).length, 2);
  const csv = [['itemCode', 'name', 'requiredQty', 'uom', 'priority'], ['ESC-30', 'ESC 30A', '8', 'Nos', 'High'], ['MTR', 'Motor', '2', 'Nos', ''], ['BAD', 'Bad row', 'x', 'Nos', ''], ['', 'No code', '1', 'Nos', '']];
  const chk = P.checkBomRows(pid, csv);
  assert.equal(chk.valid.length, 2); assert.equal(chk.errors.length, 2);
  assert.equal(chk.valid.find((r) => r.itemCode === 'MTR')._duplicate, true);
  assert.equal(await P.importBom(pid, chk.valid), 2); await w.settle();
  assert.equal(await P.bulkUpdateItems(pid, [a, dup], { priority: 'Critical', requiredBy: '2026-12-31' }), 2); await w.settle();
  assert.equal(store.get('projectItems', pid, dup).priority, 'Critical');
  await P.removeItem(pid, dup); await w.settle();
  assert.equal(store.list('projectItems', pid).length, 3, 'soft-deleted item is hidden');
  const clone = await P.cloneProject(pid, { id: 'TST-2', name: 'Clone' }); await w.settle();
  assert.equal(store.list('projectItems', clone).length, 3);
  assert.equal(store.project(clone).clonedFrom, pid);
  await P.setProjectArchived(clone, true); await w.settle();
  assert.equal(store.projects().length, 1); assert.equal(store.projects({ archived: true }).length, 2);
  await verify(w, pid, a, 0);
  await w.as('admin'); await refuses(P.updateItem(pid, a, { requiredQty: 9 }), /cannot be changed after the availability check/);
  await refuses(P.removeItem(pid, a), /cannot be removed/);
});

test('reports and search are built only from data the user may see', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 10);
  await verify(w, pid, it, 0);
  const { poId, prId } = await toPO(w, pid, reqOf(pid, it, PROJ).id);
  await w.as('admin');
  assert.equal(REPORTS.length, 25);
  for (const r of REPORTS) { const res = runReport(r.id, {}); assert.ok(Array.isArray(res.rows), r.id); for (const row of res.rows) for (const col of res.def.cols) assert.ok(col.key in row || row[col.key] === undefined, `${r.id}.${col.key}`); }
  assert.equal(runReport('po', { vendor: 'vendor a' }).rows.length, 1);
  assert.equal(runReport('po', { vendor: 'nobody' }).rows.length, 0);
  assert.equal(runReport('pr', { project: 'OTHER' }).rows.length, 0);
  assert.equal(runReport('pr', { status: 'approved', from: '2026-11-01', to: '2026-11-30' }).rows.length, 1);
  assert.ok(globalSearch(poId).some((x) => x.type === 'PO'));
  assert.ok(globalSearch('vendor a').length >= 2);
  // the viewer has no access to this project → sees nothing, anywhere
  await w.as('viewer');
  assert.equal(globalSearch(poId).length, 0);
  assert.equal(globalSearch(prId).length, 0);
  assert.equal(runReport('items', {}).rows.length, 0);
  assert.equal(kpis().totalProjects, 0);
});
