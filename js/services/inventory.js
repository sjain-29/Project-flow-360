/**
 * In-house availability, stock transfers and the MANDATORY source-stock
 * replenishment (section 7 of the specification).
 *
 * Rule implemented here and enforced again by the security rules:
 *   every unit transferred from a source department's stock creates a linked
 *   procurement requirement to replenish that department — even when the item
 *   is fully available in-house. That replenishment is tracked separately
 *   (Branch B) and is never counted as project fulfilment.
 */
import { store } from './store.js';
import { requirePerm, requireAny, me, session } from './session.js';
import { runTx } from './tx.js';
import { recipients, recordLink } from './notify.js';
import { ensureStages, touchStage } from './stages.js';
import { itemQuantities } from './quantities.js';
import { assertProjectOpen } from './projects.js';
import { APP } from '../config/app-config.js';
import { AppError, num, round, today } from '../utils/format.js';

const EPS = APP.eps;
const REPL = 'Source Stock Replenishment';
const itemRef = (item) => ({ itemId: item.id, itemCode: item.itemCode, itemName: item.name });

/* ------------------------------------------------------------------ stock register */
export async function saveStockRecord(id, input) {
  const d = { itemCode: input.itemCode?.trim(), itemName: input.itemName?.trim(), deptId: input.deptId, location: input.location, uom: input.uom, remarks: input.remarks };
  if (!d.itemCode || !d.itemName || !d.deptId) throw new AppError('Enter the item code, item name and department.');
  const onHand = num(input.onHand);
  if (onHand < 0) throw new AppError('Stock cannot be negative.');
  return runTx(null, async (tx) => {
    if (id) {
      requirePerm('inventory.edit', undefined, 'edit stock records');
      const cur = store.stockRecord(id);
      if (onHand < num(cur.reserved) - EPS) throw new AppError(`${cur.reserved} unit(s) are reserved for transfers. The quantity on hand cannot go below that.`);
      tx.patch('inventory', id, { ...d, onHand }, onHand !== cur.onHand ? `Stock corrected: ${cur.onHand} → ${onHand}` : 'Stock record edited');
      return id;
    }
    requirePerm('inventory.create', undefined, 'add stock records');
    const dup = store.stock().find((s) => s.deptId === d.deptId && s.itemCode.toLowerCase() === d.itemCode.toLowerCase());
    if (dup) throw new AppError(`${store.deptName(d.deptId)} already has a stock record for ${d.itemCode} (${dup.id}). Edit that record instead.`);
    const newId = await tx.nextId('inventory');
    tx.create('inventory', newId, { ...d, onHand, reserved: 0 }, 'Stock record created');
    return newId;
  });
}
export const findStock = (deptId, itemCode) => store.stock().find((s) => s.deptId === deptId && s.itemCode?.toLowerCase() === String(itemCode || '').toLowerCase()) || null;

/* ------------------------------------------------------------------ availability check */
/**
 * Step 1 for every item. Creates, in one atomic write:
 *   Branch A  stock transfer for the in-house quantity (if any)
 *             + project procurement requirement for the shortage (if any)
 *   Branch B  replenishment requirement for exactly the transferred quantity (if any)
 */
export async function verifyAvailability(pid, itemId, input) {
  requirePerm('inventory.create', pid, 'verify in-house availability');
  const project = assertProjectOpen(pid);
  const item = store.get('projectItems', pid, itemId);
  if (!item || item.deleted) throw new AppError('Item not found.');
  if (store.get('inventoryChecks', pid, itemId)) throw new AppError('Availability has already been verified for this item. To change quantities, adjust or cancel the stock transfer.');
  const required = num(item.requiredQty);
  const available = num(input.availableQty);
  if (available < 0) throw new AppError('The available quantity cannot be negative.');
  if (!input.verifiedAt) throw new AppError('Enter the verification date.');
  const transferQty = round(Math.min(required, available));
  const shortage = round(required - transferQty);
  if (transferQty > 0 && !input.sourceDeptId) throw new AppError('Choose the source department that holds the stock.');
  const availability = transferQty >= required - EPS ? 'Fully Available' : (transferQty > 0 ? 'Partially Available' : 'Not Available');

  return runTx(pid, async (tx) => {
    let stockId = null;
    if (transferQty > 0) {
      const stock = findStock(input.sourceDeptId, item.itemCode);
      if (stock) {
        const free = round(num(stock.onHand) - num(stock.reserved));
        if (available > free + EPS) throw new AppError(`The stock register shows only ${free} free unit(s) of ${item.itemCode} in ${store.deptName(input.sourceDeptId)} (${stock.onHand} on hand, ${stock.reserved || 0} reserved). Correct the stock record first or enter a lower quantity.`);
        stockId = stock.id;
        tx.patch('inventory', stockId, { reserved: round(num(stock.reserved) + transferQty) }, `Reserved ${transferQty} for ${pid} / ${item.itemCode}`);
      } else {
        stockId = await tx.nextId('inventory');
        tx.create('inventory', stockId, { itemCode: item.itemCode, itemName: item.name, deptId: input.sourceDeptId, location: input.stockLocation, uom: item.uom, onHand: available, reserved: transferQty },
          `Stock record created from the availability check of ${pid} / ${item.itemCode}`);
      }
    }
    tx.create('inventoryChecks', itemId, {
      ...itemRef(item), availability, requiredQty: required, availableQty: available, transferQty, shortageQty: shortage,
      sourceDeptId: transferQty > 0 ? input.sourceDeptId : null, stockLocation: input.stockLocation, stockRef: input.stockRef, stockId,
      verifiedAt: input.verifiedAt, verifiedBy: me(), remarks: input.remarks,
    }, `Availability verified: ${availability} (${available} available of ${required} required)`);

    let trfId = null;
    if (transferQty > 0) {
      trfId = await tx.nextId('stockTransfers');
      const reqId = await tx.nextId('procurement');
      tx.create('stockTransfers', trfId, { ...itemRef(item), qty: transferQty, sourceDeptId: input.sourceDeptId, destDeptId: project.departmentId, stockId, requirementId: reqId, status: 'Requested' },
        `Stock transfer requested: ${transferQty} from ${store.deptName(input.sourceDeptId)}`);
      tx.create('procurement', reqId, { type: REPL, ...itemRef(item), qty: transferQty, sourceDeptId: input.sourceDeptId, transferId: trfId, origin: 'Availability Check', status: 'Open',
        reason: `Replenish ${store.deptName(input.sourceDeptId)} stock transferred to project ${pid} (${trfId}).` },
      `Replenishment requirement created for ${transferQty} (linked to ${trfId})`);
    }
    if (shortage > 0) {
      const reqId = await tx.nextId('procurement');
      tx.create('procurement', reqId, { type: 'Project Requirement', ...itemRef(item), qty: shortage, origin: 'Availability Check', status: 'Open', reason: `Shortage of ${shortage} for project ${pid}.` },
        `Project procurement requirement created for ${shortage}`);
    }
    ensureStages(tx, pid, itemId, { transfer: transferQty > 0, proc: shortage > 0 });
    touchStage(tx, itemId, 'A', 'availability', 'complete');
    if (trfId) tx.notify(recipients('transfers.view', pid, { depts: ['stores'] }), { title: `Stock transfer pending: ${item.itemCode} × ${transferQty}`, body: `Project ${pid}. Transfer ${trfId} from ${store.deptName(input.sourceDeptId)}.`, link: recordLink('stockTransfers', pid, trfId), module: 'transfers' });
    tx.notify(recipients('pr.create', pid), { title: `Purchase request needed: ${item.itemCode}`, body: `Project ${pid}: ${transferQty > 0 ? `${transferQty} to replenish source stock` : ''}${transferQty > 0 && shortage > 0 ? ' and ' : ''}${shortage > 0 ? `${shortage} for the project` : ''}.`, link: `#/items/${pid}/${itemId}`, module: 'procurement' });
    return { availability, transferQty, shortage, transferId: trfId };
  });
}

/* ------------------------------------------------------------------ stock transfers */
/** Movement status of a transfer from its quantities (approval states are kept until something moves). */
const movementStatus = (t, qty, dispatched, received) => (received >= qty - EPS ? 'Received' : received > 0 ? 'Partially Received' : dispatched >= qty - EPS ? 'Dispatched' : dispatched > 0 ? 'Partially Dispatched' : t.status);
const getTransfer = (pid, id) => { const t = store.get('stockTransfers', pid, id); if (!t) throw new AppError('Stock transfer not found.'); return t; };
const flagReview = (tx, t, reason) => {
  const req = tx.get('procurement', t.requirementId);
  if (req && req.status !== 'Cancelled') {
    tx.patch('procurement', t.requirementId, { status: 'Under Review', reviewReason: reason, reviewDecision: null, reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewRemarks: null },
      `Replenishment requirement sent for review: ${reason}`);
  }
};

export async function decideTransfer(pid, id, { decision, remarks }) {
  requirePerm('transfers.approve', pid, 'approve stock transfers');
  const t = getTransfer(pid, id);
  if (t.status !== 'Requested') throw new AppError('Only a requested transfer can be approved or rejected.');
  if (!['Approved', 'Rejected'].includes(decision)) throw new AppError('Choose approve or reject.');
  if (decision === 'Rejected' && !remarks?.trim()) throw new AppError('Give the reason for rejecting the transfer.');
  await runTx(pid, (tx) => {
    tx.patch('stockTransfers', id, { status: decision, decision, approverId: me(), approverName: session.user.displayName, decisionAt: Date.now(), approvalRemarks: remarks }, `Stock transfer ${decision.toLowerCase()}`);
    if (decision === 'Rejected') {
      const stock = store.stockRecord(t.stockId);
      if (stock) tx.patch('inventory', t.stockId, { reserved: round(Math.max(0, num(stock.reserved) - num(t.qty))) }, `Reservation released (${id} rejected)`);
      flagReview(tx, t, `Stock transfer ${id} was rejected: ${remarks}`);
    } else touchStage(tx, t.itemId, 'A', 'transfer', 'start');
  });
}

export async function dispatchTransfer(pid, id, { qty, date, remarks }) {
  requireAny(['transfers.updateStatus', 'transfers.edit'], pid, 'record transfer dispatches');
  const t = getTransfer(pid, id);
  const needApproval = store.settings().transferApprovalRequired !== false;
  const ok = needApproval ? ['Approved', 'Partially Dispatched', 'Partially Received'] : ['Requested', 'Approved', 'Partially Dispatched', 'Partially Received'];
  if (!ok.includes(t.status)) throw new AppError(needApproval && t.status === 'Requested' ? 'This transfer must be approved before it can be dispatched.' : `A transfer that is ${t.status.toLowerCase()} cannot be dispatched.`);
  const q = num(qty);
  const remaining = round(num(t.qty) - num(t.dispatchedQty));
  if (!(q > 0)) throw new AppError('Enter the quantity dispatched.');
  if (q > remaining + EPS) throw new AppError(`Only ${remaining} unit(s) remain to be dispatched on this transfer.`);
  if (!date) throw new AppError('Enter the dispatch date.');
  await runTx(pid, (tx) => {
    const stock = store.stockRecord(t.stockId);
    if (stock) {
      if (num(stock.onHand) < q - EPS) throw new AppError(`The stock register shows only ${stock.onHand} unit(s) on hand. Stock can never go negative — correct the stock record first.`);
      tx.patch('inventory', t.stockId, { onHand: round(num(stock.onHand) - q), reserved: round(Math.max(0, num(stock.reserved) - q)) }, `Issued ${q} for transfer ${id}`);
    }
    const dispatched = round(num(t.dispatchedQty) + q);
    tx.patch('stockTransfers', id, { dispatchedQty: dispatched, dispatchDate: date, status: movementStatus(t, num(t.qty), dispatched, num(t.receivedQty)), ...(remarks ? { remarks } : {}) },
      `Dispatched ${q} from ${store.deptName(t.sourceDeptId)} (${dispatched} of ${t.qty})`);
    touchStage(tx, t.itemId, 'A', 'transfer', 'start');
    tx.notify(recipients('transfers.view', pid, { depts: [t.destDeptId, 'stores'].filter(Boolean) }), { title: `Material dispatched: ${t.itemCode} × ${q}`, body: `Transfer ${id}, project ${pid}.`, link: recordLink('stockTransfers', pid, id), module: 'transfers' });
  });
}

export async function receiveTransfer(pid, id, { receivedQty, acceptedQty, rejectedQty, date, remarks }) {
  requireAny(['transfers.updateStatus', 'transfers.edit'], pid, 'confirm transfer receipts');
  const t = getTransfer(pid, id);
  const rec = num(receivedQty); const acc = num(acceptedQty); const rej = num(rejectedQty);
  const pendingQty = round(num(t.dispatchedQty) - num(t.receivedQty));
  if (!(rec > 0)) throw new AppError('Enter the quantity received.');
  if (rec > pendingQty + EPS) throw new AppError(`Only ${pendingQty} dispatched unit(s) are waiting to be received.`);
  if (acc < 0 || rej < 0 || Math.abs(acc + rej - rec) > EPS) throw new AppError('Accepted plus rejected must equal the received quantity.');
  if (!date) throw new AppError('Enter the receipt date.');
  await runTx(pid, (tx) => {
    const received = round(num(t.receivedQty) + rec);
    tx.patch('stockTransfers', id, {
      receivedQty: received, acceptedQty: round(num(t.acceptedQty) + acc), rejectedQty: round(num(t.rejectedQty) + rej), receiptDate: date, receivedBy: me(),
      status: movementStatus(t, num(t.qty), num(t.dispatchedQty), received), ...(remarks ? { remarks } : {}),
    }, `Received ${rec} at the requesting department (accepted ${acc}, rejected ${rej})`);
    touchStage(tx, t.itemId, 'A', 'projReceipt', 'start');
    tx.notify(recipients('items.view', pid, { depts: ['project_management', 'development'] }), { title: `Material received: ${t.itemCode} × ${acc} accepted`, body: `Transfer ${id}, project ${pid}.${rej > 0 ? ` ${rej} rejected.` : ''}`, link: `#/items/${pid}/${t.itemId}`, module: 'transfers' });
  });
}

/** Cancel a transfer that has not been dispatched. The linked replenishment requirement goes to review — it is never silently removed. */
export async function cancelTransfer(pid, id, { reason }) {
  requireAny(['transfers.updateStatus', 'transfers.edit'], pid, 'cancel stock transfers');
  const t = getTransfer(pid, id);
  if (!reason?.trim()) throw new AppError('Give the reason for cancelling the transfer.');
  if (['Cancelled', 'Rejected'].includes(t.status)) throw new AppError('This transfer is already closed.');
  if (num(t.dispatchedQty) > 0) throw new AppError(`${t.dispatchedQty} unit(s) were already dispatched. Reduce the transfer quantity instead of cancelling it.`);
  await runTx(pid, (tx) => {
    const stock = store.stockRecord(t.stockId);
    if (stock) tx.patch('inventory', t.stockId, { reserved: round(Math.max(0, num(stock.reserved) - num(t.qty))) }, `Reservation released (${id} cancelled)`);
    tx.patch('stockTransfers', id, { status: 'Cancelled', cancelReason: reason }, `Stock transfer cancelled: ${reason}`);
    flagReview(tx, t, `Stock transfer ${id} was cancelled: ${reason}`);
    tx.notify(recipients('procurement.approve', pid), { title: `Review needed: replenishment for ${t.itemCode}`, body: `Transfer ${id} was cancelled. Decide what happens to requirement ${t.requirementId}.`, link: recordLink('procurement', pid, t.requirementId), module: 'procurement' });
  });
}

/** Change the quantity of a transfer. The replenishment requirement is flagged for authorised review. */
export async function adjustTransferQty(pid, id, { newQty, reason }) {
  requirePerm('transfers.edit', pid, 'adjust stock transfers');
  const t = getTransfer(pid, id);
  const q = num(newQty);
  if (!reason?.trim()) throw new AppError('Give the reason for the adjustment.');
  if (['Cancelled', 'Rejected'].includes(t.status)) throw new AppError('This transfer is closed.');
  if (!(q > 0)) throw new AppError('The quantity must be greater than zero. Cancel the transfer if nothing will be transferred.');
  if (q < num(t.dispatchedQty) - EPS) throw new AppError(`${t.dispatchedQty} unit(s) were already dispatched; the quantity cannot go below that.`);
  if (Math.abs(q - num(t.qty)) < EPS) throw new AppError('Enter a quantity different from the current one.');
  await runTx(pid, (tx) => {
    const stock = store.stockRecord(t.stockId);
    if (stock) {
      const reserved = round(num(stock.reserved) + (q - num(t.qty)));
      if (reserved > num(stock.onHand) + EPS) throw new AppError(`Not enough free stock: ${store.deptName(t.sourceDeptId)} has ${stock.onHand} on hand.`);
      tx.patch('inventory', t.stockId, { reserved: Math.max(0, reserved) }, `Reservation changed for ${id}: ${t.qty} → ${q}`);
    }
    const status = movementStatus(t, q, num(t.dispatchedQty), num(t.receivedQty));
    tx.patch('stockTransfers', id, { qty: q, adjustReason: `${today()}: ${t.qty} → ${q}. ${reason}`, status }, `Transfer quantity adjusted: ${t.qty} → ${q} (${reason})`);
    flagReview(tx, t, `Stock transfer ${id} quantity changed from ${t.qty} to ${q}: ${reason}`);
    tx.notify(recipients('procurement.approve', pid), { title: `Review needed: replenishment for ${t.itemCode}`, body: `Transfer ${id} changed from ${t.qty} to ${q}. Requirement ${t.requirementId} needs a decision.`, link: recordLink('procurement', pid, t.requirementId), module: 'procurement' });
  });
}

/* ------------------------------------------------------------------ procurement requirements */
const getReq = (pid, id) => { const r = store.get('procurement', pid, id); if (!r) throw new AppError('Procurement requirement not found.'); return r; };
const activePr = (pid, req) => { const pr = req.prId ? store.get('purchaseRequests', pid, req.prId) : null; return pr && !['Rejected', 'Cancelled'].includes(pr.status) ? pr : null; };

/** Authorised review of a replenishment requirement after its transfer was cancelled or adjusted. */
export async function reviewRequirement(pid, id, { decision, newQty, remarks }) {
  requirePerm('procurement.approve', pid, 'review procurement requirements');
  const r = getReq(pid, id);
  if (r.status !== 'Under Review') throw new AppError('This requirement is not waiting for review.');
  if (!remarks?.trim()) throw new AppError('Record the reasoning for this decision.');
  const pr = activePr(pid, r);
  const next = pr ? 'PR Raised' : 'Open';
  const patch = { reviewedBy: me(), reviewedByName: session.user.displayName, reviewedAt: Date.now(), reviewRemarks: remarks };
  let action;
  if (decision === 'keep') { Object.assign(patch, { status: next, reviewDecision: 'Quantity kept' }); action = `Review: quantity kept at ${r.qty}`; }
  else if (decision === 'adjust') {
    const q = num(newQty);
    if (!(q > 0)) throw new AppError('Enter the new quantity, or choose "Cancel requirement".');
    if (pr) throw new AppError(`Purchase request ${pr.id} already exists for this requirement. Cancel or reject that PR first, or keep the quantity.`);
    Object.assign(patch, { status: next, qty: q, reviewDecision: `Quantity changed ${r.qty} → ${q}` }); action = `Review: quantity changed ${r.qty} → ${q}`;
  } else if (decision === 'cancel') {
    if (pr) throw new AppError(`Purchase request ${pr.id} already exists for this requirement. Cancel or reject that PR first.`);
    Object.assign(patch, { status: 'Cancelled', reviewDecision: 'Requirement cancelled' }); action = 'Review: requirement cancelled';
  } else throw new AppError('Choose a decision.');
  await runTx(pid, (tx) => tx.patch('procurement', id, patch, `${action} — ${remarks}`));
}

/** Project procurement for a quantity that is covered neither by a transfer nor by an existing requirement. */
export async function createCoverageRequirement(pid, itemId, { qty, reason }) {
  requirePerm('procurement.create', pid, 'create procurement requirements');
  assertProjectOpen(pid);
  const item = store.get('projectItems', pid, itemId);
  const q = num(qty);
  const led = itemQuantities(pid, itemId);
  if (!led.verified) throw new AppError('Verify in-house availability first.');
  if (!(q > 0)) throw new AppError('Enter the quantity.');
  if (q > led.uncovered + EPS) throw new AppError(`Only ${led.uncovered} unit(s) of this item are not yet covered. Creating more would procure the same quantity twice.`);
  return runTx(pid, async (tx) => {
    const id = await tx.nextId('procurement');
    tx.create('procurement', id, { type: 'Project Requirement', ...itemRef(item), qty: q, origin: 'Coverage Gap', status: 'Open', reason: reason || 'Quantity not covered by stock transfer or existing procurement.' },
      `Project procurement requirement created for ${q} (uncovered quantity)`);
    ensureStages(tx, pid, itemId, { proc: true });
    tx.notify(recipients('pr.create', pid), { title: `Purchase request needed: ${item.itemCode}`, body: `Project ${pid}: ${q} for the project.`, link: recordLink('procurement', pid, id), module: 'procurement' });
    return id;
  });
}

/** Development asks for more material; needs approval before it becomes an open requirement. */
export async function requestAdditionalMaterial(pid, itemId, { qty, reason }) {
  requireAny(['development.create', 'development.edit'], pid, 'request additional material');
  assertProjectOpen(pid);
  const item = store.get('projectItems', pid, itemId);
  const q = num(qty);
  if (!(q > 0)) throw new AppError('Enter the additional quantity.');
  if (!reason?.trim()) throw new AppError('Explain why additional material is needed.');
  return runTx(pid, async (tx) => {
    const id = await tx.nextId('procurement');
    tx.create('procurement', id, { type: 'Project Requirement', ...itemRef(item), qty: q, origin: 'Additional Material', status: 'Pending Approval', reason }, `Additional material requested by Development: ${q}`);
    tx.notify(recipients('procurement.approve', pid), { title: `Approval needed: additional material for ${item.itemCode}`, body: `Project ${pid}: ${q} more requested. ${reason}`, link: recordLink('procurement', pid, id), module: 'procurement' });
    return id;
  });
}

export async function decideAdditionalMaterial(pid, id, { decision, remarks }) {
  requirePerm('procurement.approve', pid, 'approve additional material');
  const r = getReq(pid, id);
  if (r.status !== 'Pending Approval') throw new AppError('This request is not waiting for approval.');
  if (!['Approved', 'Rejected'].includes(decision)) throw new AppError('Choose approve or reject.');
  if (decision === 'Rejected' && !remarks?.trim()) throw new AppError('Give the reason for rejecting the request.');
  await runTx(pid, (tx) => {
    tx.patch('procurement', id, { status: decision === 'Approved' ? 'Open' : 'Rejected', reviewDecision: decision, reviewedBy: me(), reviewedByName: session.user.displayName, reviewedAt: Date.now(), reviewRemarks: remarks },
      `Additional material ${decision.toLowerCase()}${remarks ? ` — ${remarks}` : ''}`);
    if (decision === 'Approved') {
      ensureStages(tx, pid, r.itemId, { proc: true });
      tx.notify(recipients('pr.create', pid), { title: `Purchase request needed: ${r.itemCode}`, body: `Project ${pid}: ${r.qty} additional for the project.`, link: recordLink('procurement', pid, id), module: 'procurement' });
    }
    tx.notify([r.createdBy], { title: `Additional material ${decision.toLowerCase()}: ${r.itemCode}`, body: remarks || '', link: recordLink('procurement', pid, id), module: 'procurement' });
  });
}

export async function closeRequirement(pid, id) {
  requireAny(['procurement.updateStatus', 'procurement.approve'], pid, 'close procurement requirements');
  const r = getReq(pid, id);
  if (!['PR Raised', 'Open'].includes(r.status)) throw new AppError('Only an open requirement can be closed.');
  await runTx(pid, (tx) => tx.patch('procurement', id, { status: 'Closed' }, 'Procurement requirement closed'));
}
