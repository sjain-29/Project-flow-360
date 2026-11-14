/**
 * Quantity ledger of an item — the eleven separate quantities of section 7.
 *
 * Everything is DERIVED from the transaction records; nothing is stored twice,
 * so a transferred unit and a procured unit can never be counted twice, and
 * replenishment receipts (for the source department) never count as project
 * fulfilment.
 */
import { store } from './store.js';
import { sum, round, num } from '../utils/format.js';
import { APP } from '../config/app-config.js';

const REPL = 'Source Stock Replenishment';
const liveReq = (r) => !['Cancelled', 'Rejected', 'Pending Approval'].includes(r.status);

/** Pure calculation — pass the records, get the ledger. */
export function computeItemQuantities({ item, check, transfers = [], reqs = [], pos = [], dispatches = [], receipts = [], mrs = [] }) {
  const projReqs = reqs.filter((r) => r.type !== REPL);
  const replReqs = reqs.filter((r) => r.type === REPL);
  const extra = sum(projReqs.filter((r) => r.origin === 'Additional Material' && liveReq(r)), 'qty');
  const required = round(num(item?.requiredQty) + extra);

  const liveTransfers = transfers.filter((t) => !['Cancelled', 'Rejected'].includes(t.status));
  const transferPlanned = sum(liveTransfers, 'qty') + sum(transfers.filter((t) => t.status === 'Cancelled'), 'dispatchedQty');
  const transferred = sum(transfers, 'dispatchedQty');
  const reserved = round(Math.max(0, sum(liveTransfers, (t) => num(t.qty) - num(t.dispatchedQty))));
  const transferReceived = sum(transfers, 'receivedQty');
  const transferAccepted = sum(transfers, 'acceptedQty');
  const transferRejected = sum(transfers, 'rejectedQty');

  const livePos = pos.filter((p) => p.status !== 'Cancelled');
  const projPos = livePos.filter((p) => p.procurementType !== REPL);
  const replPos = livePos.filter((p) => p.procurementType === REPL);
  const procuredProject = sum(projPos, 'quantity');
  const procuredReplenishment = sum(replPos, 'quantity');
  // receipts are counted from the GRNs themselves (the source of truth), split by procurement type
  const vendorDispatched = sum(dispatches.filter((d) => d.procurementType !== REPL), 'qty');
  const projReceipts = receipts.filter((r) => r.procurementType !== REPL);
  const procReceived = sum(projReceipts, 'receivedQty');
  const procAccepted = sum(projReceipts, 'acceptedQty');
  const procRejected = sum(projReceipts, 'rejectedQty');

  const projectReqQty = sum(projReqs.filter(liveReq), 'qty');
  const pendingExtra = sum(projReqs.filter((r) => r.status === 'Pending Approval'), 'qty');
  // coverage: every required unit must be planned either as a transfer or as project procurement
  const transferEffective = round(Math.max(0, transferPlanned - transferRejected));
  const uncovered = check ? round(Math.max(0, required - transferEffective - projectReqQty)) : 0;

  const accepted = round(transferAccepted + procAccepted);
  const mrDispatched = sum(mrs.filter((m) => m.status !== 'Cancelled'), 'dispatchedQty');
  return {
    required,                                       // 1 original project requirement (+ approved additional material)
    available: num(check?.availableQty),            // 2 in-house available quantity
    reserved,                                       // 3 quantity reserved
    transferred: round(transferred),                // 4 quantity transferred
    procuredProject: round(procuredProject),        // 5 quantity procured for project
    procuredReplenishment: round(procuredReplenishment), // 6 quantity procured for source replenishment
    dispatched: round(transferred + vendorDispatched),   // 7 quantity dispatched (stock + vendor, project only)
    received: round(transferReceived + procReceived),    // 8 quantity received
    accepted,                                       // 9 quantity accepted
    rejected: round(transferRejected + procRejected),    // 10 quantity rejected
    outstanding: round(Math.max(0, required - accepted)), // 11 outstanding quantity
    // supporting figures
    transferPlanned: round(transferPlanned), transferAccepted: round(transferAccepted), procAccepted: round(procAccepted),
    projectReqQty: round(projectReqQty), replenishmentReqQty: round(sum(replReqs.filter(liveReq), 'qty')),
    replenishmentReceived: round(sum(receipts.filter((r) => r.procurementType === REPL), 'acceptedQty')),
    uncovered, pendingExtra: round(pendingExtra),
    spifAvailable: round(Math.max(0, accepted - mrDispatched)),
    verified: !!check,
    fulfilled: !!check && required - accepted < APP.eps,
  };
}

/** Ledger of one item from the live store. */
export function itemQuantities(pid, itemId) {
  const by = (coll) => store.where(coll, pid, (r) => r.itemId === itemId);
  return computeItemQuantities({
    item: store.get('projectItems', pid, itemId),
    check: store.get('inventoryChecks', pid, itemId),
    transfers: by('stockTransfers'), reqs: by('procurement'), pos: by('purchaseOrders'), dispatches: by('dispatches'), receipts: by('materialReceipts'), mrs: by('materialRequests'),
  });
}
