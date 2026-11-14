/**
 * Material movement after receipt: Material Requests SPIF → GVT (section 10),
 * GVT receipts (12), Logistics and Travel Desk (11), RGP / NRGP gate passes (13).
 */
import { store } from './store.js';
import { requirePerm, requireAny, me, session } from './session.js';
import { runTx } from './tx.js';
import { recipients, recordLink, ifAllowed } from './notify.js';
import { touchStage } from './stages.js';
import { itemQuantities } from './quantities.js';
import { assertProjectOpen } from './projects.js';
import { APP } from '../config/app-config.js';
import { ENTITIES } from '../config/entities.js';
import { AppError, num, round, today } from '../utils/format.js';

const EPS = APP.eps;
const need = (coll, pid, id, label) => { const r = store.get(coll, pid, id); if (!r) throw new AppError(`${label} not found.`); return r; };
const itemRef = (pid, itemId) => { const it = store.get('projectItems', pid, itemId); if (!it) throw new AppError('Choose the item.'); return { itemId, itemCode: it.itemCode, itemName: it.name }; };
const decisionPatch = (decision, remarks) => ({ decision, approverId: me(), approverName: session.user.displayName, decisionAt: Date.now(), approvalRemarks: remarks });

/* ------------------------------------------------------------------ Material Request SPIF → GVT */
export async function createMR(pid, itemId, input) {
  requirePerm('mr.create', pid, 'create material requests');
  assertProjectOpen(pid);
  const ref = itemRef(pid, itemId);
  const qty = num(input.qtyRequested);
  if (!(qty > 0)) throw new AppError('Enter the quantity requested.');
  if (!input.requestDate) throw new AppError('Enter the request date.');
  const available = itemQuantities(pid, itemId).spifAvailable;
  return runTx(pid, async (tx) => {
    const id = await tx.nextId('materialRequests');
    tx.create('materialRequests', id, { ...ref, qtyRequested: qty, availableSpifQty: available, requestDate: input.requestDate, requestedBy: me(), remarks: input.remarks, status: 'Created' }, `MR created for ${qty} (SPIF has ${available})`);
    touchStage(tx, itemId, 'A', 'mr', 'start');
    tx.notify(recipients('mr.approve', pid), { title: `MR needs approval: ${id}`, body: `${ref.itemCode} × ${qty}, project ${pid}.`, link: recordLink('materialRequests', pid, id), module: 'mr' });
    return id;
  });
}

export async function decideMR(pid, id, { decision, approvedQty, remarks }) {
  requirePerm('mr.approve', pid, 'approve material requests');
  const mr = need('materialRequests', pid, id, 'Material request');
  if (mr.status !== 'Created') throw new AppError('Only a newly created MR can be approved or rejected.');
  if (!['Approved', 'Rejected'].includes(decision)) throw new AppError('Choose approve or reject.');
  const patch = { status: decision, ...decisionPatch(decision, remarks) };
  if (decision === 'Approved') {
    const q = num(approvedQty);
    const available = itemQuantities(pid, mr.itemId).spifAvailable;
    if (!(q > 0)) throw new AppError('Enter the approved quantity.');
    if (q > num(mr.qtyRequested) + EPS) throw new AppError('The approved quantity cannot be more than the requested quantity.');
    if (q > available + EPS) throw new AppError(`Only ${available} accepted unit(s) are available at SPIF for this item.`);
    patch.approvedQty = q;
  } else if (!remarks?.trim()) throw new AppError('Give the reason for rejecting the MR.');
  await runTx(pid, (tx) => {
    tx.patch('materialRequests', id, patch, `MR ${decision.toLowerCase()}${decision === 'Approved' ? ` for ${patch.approvedQty}` : ''}`);
    tx.notify([mr.requestedBy], { title: `MR ${decision.toLowerCase()}: ${id}`, body: remarks || '', link: recordLink('materialRequests', pid, id), module: 'mr' });
  });
}

export async function prepareMR(pid, id, { date }) {
  requireAny(['mr.updateStatus', 'mr.edit'], pid, 'update material requests');
  const mr = need('materialRequests', pid, id, 'Material request');
  if (mr.status !== 'Approved') throw new AppError('Only an approved MR can be marked as prepared.');
  await runTx(pid, (tx) => tx.patch('materialRequests', id, { status: 'Material Prepared', preparedAt: date || today() }, 'Material prepared for dispatch'));
}

export async function dispatchMR(pid, id, { qty, date }) {
  requireAny(['mr.updateStatus', 'mr.edit'], pid, 'record MR dispatches');
  const mr = need('materialRequests', pid, id, 'Material request');
  if (!['Approved', 'Material Prepared', 'Partially Dispatched', 'Partially Received'].includes(mr.status)) throw new AppError(`An MR that is "${mr.status}" cannot be dispatched.`);
  const q = num(qty);
  const remaining = round(num(mr.approvedQty) - num(mr.dispatchedQty));
  if (!(q > 0)) throw new AppError('Enter the quantity dispatched.');
  if (q > remaining + EPS) throw new AppError(`Only ${remaining} approved unit(s) remain to be dispatched.`);
  if (!date) throw new AppError('Enter the dispatch date.');
  await runTx(pid, (tx) => {
    const dispatched = round(num(mr.dispatchedQty) + q);
    tx.patch('materialRequests', id, { dispatchedQty: dispatched, dispatchDate: date, status: dispatched >= num(mr.approvedQty) - EPS ? 'Dispatched' : 'Partially Dispatched' }, `Dispatched ${q} to GVT (${dispatched} of ${mr.approvedQty})`);
    tx.notify(recipients('gvt.create', pid), { title: `Material dispatched to GVT: ${mr.itemCode} × ${q}`, body: `MR ${id}, project ${pid}.`, link: recordLink('materialRequests', pid, id), module: 'mr' });
  });
}

export async function cancelMR(pid, id, { reason }) {
  requireAny(['mr.updateStatus', 'mr.edit'], pid, 'cancel material requests');
  const mr = need('materialRequests', pid, id, 'Material request');
  if (num(mr.dispatchedQty) > 0) throw new AppError('Material was already dispatched against this MR; it cannot be cancelled.');
  if (!reason?.trim()) throw new AppError('Give the reason for cancelling.');
  await runTx(pid, (tx) => tx.patch('materialRequests', id, { status: 'Cancelled' }, `MR cancelled: ${reason}`));
}

/* ------------------------------------------------------------------ Receipt at GVT */
export async function receiveAtGVT(pid, mrId, input) {
  requirePerm('gvt.create', pid, 'confirm receipts at GVT');
  const mr = need('materialRequests', pid, mrId, 'Material request');
  const rec = num(input.receivedQty); const acc = num(input.acceptedQty); const rej = num(input.rejectedQty);
  const pendingQty = round(num(mr.dispatchedQty) - num(mr.receivedQty));
  if (!(rec > 0)) throw new AppError('Enter the quantity received.');
  if (rec > pendingQty + EPS) throw new AppError(`Only ${pendingQty} dispatched unit(s) are waiting to be received at GVT.`);
  if (acc < 0 || rej < 0 || Math.abs(acc + rej - rec) > EPS) throw new AppError('Accepted plus rejected must equal the received quantity.');
  if (!input.receiptDate) throw new AppError('Enter the receipt date.');
  return runTx(pid, async (tx) => {
    const id = await tx.nextId('gvtReceipts');
    tx.create('gvtReceipts', id, { mrId, itemId: mr.itemId, itemCode: mr.itemCode, itemName: mr.itemName, dispatchedQty: num(mr.dispatchedQty), receiptDate: input.receiptDate, receivedQty: rec, acceptedQty: acc, rejectedQty: rej,
      receivingPerson: input.receivingPerson, discrepancy: input.discrepancy, inspectionRemarks: input.inspectionRemarks }, `Received ${rec} at GVT (accepted ${acc}, rejected ${rej})`);
    const received = round(num(mr.receivedQty) + rec);
    tx.patch('materialRequests', mrId, { receivedQty: received, acceptedQty: round(num(mr.acceptedQty) + acc), rejectedQty: round(num(mr.rejectedQty) + rej), status: received >= num(mr.approvedQty) - EPS ? 'Received at GVT' : 'Partially Received' }, `GVT receipt ${id}: ${rec}`);
    touchStage(tx, mr.itemId, 'A', 'gvtReceipt', 'start');
    tx.notify(recipients('development.view', pid, { depts: ['development', 'project_management'] }), { title: `Material received at GVT: ${mr.itemCode} × ${acc}`, body: `MR ${mrId}, project ${pid}.${input.discrepancy ? ` Discrepancy reported.` : ''}`, link: `#/items/${pid}/${mr.itemId}`, module: 'gvt' });
    return id;
  });
}

/* ------------------------------------------------------------------ generic create / edit for simple request records */
const pickForm = (coll, input) => {
  const out = {};
  for (const fd of ENTITIES[coll].fields) {
    if (fd.sys || !(fd.name in input)) continue;
    const v = input[fd.name];
    out[fd.name] = (fd.type === 'number' || fd.type === 'money') && v !== '' && v !== null && v !== undefined ? num(v) : v;
  }
  return out;
};
function checkRequired(coll, d) {
  for (const fd of ENTITIES[coll].fields) if (fd.req && !fd.sys && (d[fd.name] === undefined || d[fd.name] === null || d[fd.name] === '')) throw new AppError(`Enter: ${fd.label}.`);
}

/* ------------------------------------------------------------------ Logistics */
export async function saveLogistics(pid, id, input) {
  requirePerm(id ? 'logistics.edit' : 'logistics.create', pid, id ? 'edit logistics requests' : 'create logistics requests');
  assertProjectOpen(pid);
  const cur = id ? need('logistics', pid, id, 'Logistics request') : null;
  const d = pickForm('logistics', { status: 'Requested', ...(cur || {}), ...input });
  checkRequired('logistics', d);
  if (d.pickupDate && d.expectedDelivery && d.expectedDelivery < d.pickupDate) throw new AppError('The expected delivery date cannot be before the pickup date.');
  if (d.status === 'Delivered' && !d.actualDelivery) d.actualDelivery = today();
  return runTx(pid, async (tx) => {
    if (cur) { tx.patch('logistics', id, d, d.status !== cur.status ? `Logistics status: ${cur.status} → ${d.status}` : 'Logistics request edited'); return id; }
    const newId = await tx.nextId('logistics');
    tx.create('logistics', newId, d, 'Logistics request created');
    if (d.itemId) touchStage(tx, d.itemId, 'A', 'logistics', 'start');
    tx.notify(ifAllowed(d.assignedPersonId, 'logistics.view', pid), { title: `Logistics request assigned: ${newId}`, body: `${d.pickupLocation} → ${d.destination}, project ${pid}.`, link: recordLink('logistics', pid, newId), module: 'logistics' });
    return newId;
  });
}
export async function setLogisticsStatus(pid, id, { status, actualDelivery, trackingDetails }) {
  requireAny(['logistics.updateStatus', 'logistics.edit'], pid, 'update logistics requests');
  const cur = need('logistics', pid, id, 'Logistics request');
  if (status === 'Delivered' && !actualDelivery) throw new AppError('Enter the actual delivery date. A request is never marked delivered just because the expected date has passed.');
  await runTx(pid, (tx) => tx.patch('logistics', id, { status, ...(status === 'Delivered' ? { actualDelivery } : {}), ...(trackingDetails ? { trackingDetails } : {}) }, `Logistics status: ${cur.status} → ${status}`));
}

/* ------------------------------------------------------------------ Travel Desk (independent of Logistics) */
export async function saveTravel(pid, id, input) {
  requirePerm(id ? 'travel.edit' : 'travel.create', pid, id ? 'edit travel requests' : 'create travel requests');
  assertProjectOpen(pid);
  const cur = id ? need('travelDesk', pid, id, 'Travel request') : null;
  const d = pickForm('travelDesk', { status: 'Requested', ...(cur || {}), ...input });
  checkRequired('travelDesk', d);
  if (d.returnDate && d.returnDate < d.travelDate) throw new AppError('The return date cannot be before the travel date.');
  return runTx(pid, async (tx) => {
    if (cur) { tx.patch('travelDesk', id, d, d.status !== cur.status ? `Travel status: ${cur.status} → ${d.status}` : 'Travel request edited'); return id; }
    const newId = await tx.nextId('travelDesk');
    tx.create('travelDesk', newId, { ...d, approvalStatus: 'Pending' }, 'Travel request created');
    tx.notify(recipients('travel.approve', pid), { title: `Travel request needs approval: ${newId}`, body: `${store.userName(d.employeeId)}: ${d.origin} → ${d.destination} on ${d.travelDate}.`, link: recordLink('travelDesk', pid, newId), module: 'travel' });
    return newId;
  });
}
export async function decideTravel(pid, id, { decision, remarks }) {
  requirePerm('travel.approve', pid, 'approve travel requests');
  const cur = need('travelDesk', pid, id, 'Travel request');
  if (cur.approvalStatus !== 'Pending') throw new AppError('This travel request was already decided.');
  if (!['Approved', 'Rejected'].includes(decision)) throw new AppError('Choose approve or reject.');
  await runTx(pid, (tx) => {
    tx.patch('travelDesk', id, { approvalStatus: decision, approverId: me(), approverName: session.user.displayName, decisionAt: Date.now(), approvalRemarks: remarks }, `Travel request ${decision.toLowerCase()}`);
    tx.notify([cur.createdBy, ...ifAllowed(cur.employeeId, 'travel.view', pid)], { title: `Travel request ${decision.toLowerCase()}: ${id}`, body: remarks || '', link: recordLink('travelDesk', pid, id), module: 'travel' });
  });
}
export async function setTravelStatus(pid, id, { status, bookingRefs }) {
  requireAny(['travel.updateStatus', 'travel.edit'], pid, 'update travel requests');
  const cur = need('travelDesk', pid, id, 'Travel request');
  if (['Booked', 'In Progress', 'Completed'].includes(status) && cur.approvalStatus !== 'Approved') throw new AppError('The travel request has to be approved first.');
  await runTx(pid, (tx) => tx.patch('travelDesk', id, { status, ...(bookingRefs ? { bookingRefs } : {}) }, `Travel status: ${cur.status} → ${status}`));
}

/* ------------------------------------------------------------------ RGP / NRGP gate passes */
export async function createGatePass(pid, input) {
  requirePerm('gatepass.create', pid, 'generate gate passes');
  assertProjectOpen(pid);
  const d = pickForm('gatePasses', input);
  checkRequired('gatePasses', d);
  if (!['RGP', 'NRGP'].includes(d.type)) throw new AppError('Choose RGP or NRGP.');
  if (d.type === 'RGP' && !d.expectedReturn) throw new AppError('A returnable gate pass needs an expected return date.');
  if (d.type === 'RGP' && d.expectedReturn < d.issueDate) throw new AppError('The expected return date cannot be before the issue date.');
  if (d.type === 'NRGP') delete d.expectedReturn;
  const ref = d.itemId ? itemRef(pid, d.itemId) : {};
  return runTx(pid, async (tx) => {
    const id = await tx.nextId('gatePasses');
    tx.create('gatePasses', id, { ...d, ...ref, generatedBy: me(), status: 'Pending Approval' }, `${d.type} generated for ${d.qty} → ${d.destination}`);
    tx.notify(recipients('gatepass.approve', pid), { title: `Gate pass needs approval: ${id}`, body: `${d.type}, ${ref.itemCode || 'material'} × ${d.qty} → ${d.destination}.`, link: recordLink('gatePasses', pid, id), module: 'gatepass' });
    return id;
  });
}

export async function decideGatePass(pid, id, { decision, remarks }) {
  requirePerm('gatepass.approve', pid, 'approve gate passes');
  const gp = need('gatePasses', pid, id, 'Gate pass');
  if (gp.status !== 'Pending Approval') throw new AppError('This gate pass is not waiting for approval.');
  if (!['Approved', 'Rejected'].includes(decision)) throw new AppError('Choose approve or reject.');
  if (decision === 'Rejected' && !remarks?.trim()) throw new AppError('Give the reason for rejecting.');
  await runTx(pid, (tx) => {
    tx.patch('gatePasses', id, { status: decision, ...decisionPatch(decision, remarks) }, `Gate pass ${decision.toLowerCase()}`);
    tx.notify([gp.generatedBy], { title: `Gate pass ${decision.toLowerCase()}: ${id}`, body: remarks || '', link: recordLink('gatePasses', pid, id), module: 'gatepass' });
  });
}

export async function issueGatePass(pid, id) {
  requireAny(['gatepass.updateStatus', 'gatepass.edit', 'gatepass.create'], pid, 'issue gate passes');
  const gp = need('gatePasses', pid, id, 'Gate pass');
  if (gp.status !== 'Approved') throw new AppError('A gate pass can only be issued after approval.');
  await runTx(pid, (tx) => tx.patch('gatePasses', id, { status: 'Issued' }, `${gp.type} issued — material moved out`));
}

export async function recordGatePassReturn(pid, id, { returnDate, qty, condition, remarks }) {
  requireAny(['gatepass.updateStatus', 'gatepass.edit', 'gatepass.create'], pid, 'record gate pass returns');
  const gp = need('gatePasses', pid, id, 'Gate pass');
  if (gp.type !== 'RGP') throw new AppError('Only returnable gate passes (RGP) have returns.');
  if (!['Issued', 'Partially Returned'].includes(gp.status)) throw new AppError(`Returns cannot be recorded on a pass that is "${gp.status}".`);
  const q = num(qty);
  const remaining = round(num(gp.qty) - num(gp.returnedQty));
  if (!(q > 0)) throw new AppError('Enter the returned quantity.');
  if (q > remaining + EPS) throw new AppError(`Only ${remaining} unit(s) are still out on this pass.`);
  if (!returnDate) throw new AppError('Enter the return date.');
  return runTx(pid, async (tx) => {
    const rid = await tx.nextId('gatePassReturns');
    tx.create('gatePassReturns', rid, { gatePassId: id, returnDate, qty: q, condition, remarks }, `Returned ${q} against ${id}`);
    const returned = round(num(gp.returnedQty) + q);
    const full = returned >= num(gp.qty) - EPS;
    tx.patch('gatePasses', id, { returnedQty: returned, ...(full ? { actualReturn: returnDate } : {}), status: full ? 'Returned – Pending Closure' : 'Partially Returned' }, `Return recorded: ${returned} of ${gp.qty}`);
    if (full) tx.notify(recipients('gatepass.approve', pid), { title: `RGP fully returned — closure needed: ${id}`, body: 'Inspect the returned material and close the pass.', link: recordLink('gatePasses', pid, id), module: 'gatepass' });
    return rid;
  });
}

/** Closure is always an authorised confirmation; a shortfall needs a written resolution. */
export async function closeGatePass(pid, id, { inspectionRemarks }) {
  requirePerm('gatepass.approve', pid, 'close gate passes');
  const gp = need('gatePasses', pid, id, 'Gate pass');
  if (gp.type === 'RGP') {
    if (!['Returned – Pending Closure', 'Partially Returned', 'Issued'].includes(gp.status)) throw new AppError(`A pass that is "${gp.status}" cannot be closed.`);
    const short = round(num(gp.qty) - num(gp.returnedQty));
    if (short > EPS && (!inspectionRemarks || inspectionRemarks.trim().length < 10)) throw new AppError(`${short} unit(s) have not been returned. To close the pass anyway, record how this was formally resolved (at least 10 characters).`);
  } else if (gp.status !== 'Issued') throw new AppError('An NRGP can be closed after it has been issued.');
  await runTx(pid, (tx) => tx.patch('gatePasses', id, { status: 'Closed', inspectionRemarks, closedBy: me(), closedAt: Date.now() }, `${gp.type} closed${inspectionRemarks ? `: ${inspectionRemarks}` : ''}`));
}

export async function cancelGatePass(pid, id, { reason }) {
  requireAny(['gatepass.updateStatus', 'gatepass.edit'], pid, 'cancel gate passes');
  const gp = need('gatePasses', pid, id, 'Gate pass');
  if (!['Pending Approval', 'Approved', 'Rejected'].includes(gp.status)) throw new AppError('A pass that was already issued cannot be cancelled — its movement history is permanent.');
  if (!reason?.trim()) throw new AppError('Give the reason for cancelling.');
  await runTx(pid, (tx) => tx.patch('gatePasses', id, { status: 'Cancelled' }, `Gate pass cancelled: ${reason}`));
}

/** Days until / since the expected return of an open RGP (negative = overdue). */
export function rgpDue(gp, todayIso = today()) {
  if (gp.type !== 'RGP' || !gp.expectedReturn || !['Issued', 'Partially Returned'].includes(gp.status)) return null;
  return Math.round((new Date(gp.expectedReturn) - new Date(todayIso)) / 86400000);
}
