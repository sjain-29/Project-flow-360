/**
 * Reports (section 23) and global search (section 22).
 *
 * Every report is built from the store, which only ever contains records the
 * signed-in user may read — so reports, exports and search results respect
 * permissions by construction. A report additionally needs "Reports → View"
 * and the view permission of the module it is about.
 */
import { store } from './store.js';
import { can } from './session.js';
import { itemQuantities } from './quantities.js';
import { activities, projectProgress, projectHealth, projectExpenditure, procurementStage, liveItems } from './insights.js';
import { poFinance } from './procurement.js';
import { rgpDue } from './material.js';
import { latestTest } from './devtest.js';
import { STAGE_STATUSES } from '../config/app-config.js';
import { num, round, sum, groupBy, today } from '../utils/format.js';

const U = (id) => (id ? store.userName(id) : '');
const D = (id) => (id ? store.deptName(id) : '');
const PN = (pid) => store.project(pid)?.name || '';
const REPL = 'Source Stock Replenishment';
const c = (key, label, type = 'text') => ({ key, label, type });
const P_COLS = [c('pid', 'Project ID'), c('project', 'Project name')];
const I_COLS = [c('itemCode', 'Item code'), c('itemName', 'Item name')];
const base = (r, extra = {}) => ({ pid: r.pid, project: PN(r.pid), itemCode: r.itemCode, itemName: r.itemName || r.name, _item: `${r.itemCode || ''} ${r.itemName || r.name || ''}`, _link: null, ...extra });
const link = (coll, r) => `#/r/${coll}/${r.pid}/${encodeURIComponent(r.id)}`;

/** id, title, permission needed for the underlying data, columns, row builder */
export const REPORTS = [
  { id: 'projects', title: 'Project-wise report', perm: 'projects.view',
    cols: [...P_COLS, c('manager', 'Project manager'), c('dept', 'Department'), c('status', 'Status'), c('priority', 'Priority'), c('startDate', 'Start', 'date'), c('targetDate', 'Target completion', 'date'), c('items', 'Items', 'number'), c('progress', 'Progress %', 'number'), c('health', 'Health'), c('overdue', 'Overdue activities', 'number')],
    rows: () => store.projects({ archived: true }).map((p) => ({ pid: p.id, project: p.name, manager: U(p.managerId), dept: D(p.departmentId), status: p.status, priority: p.priority, startDate: p.startDate, targetDate: p.targetDate,
      items: liveItems(p.id).length, progress: Math.round(projectProgress(p.id).overall * 100), health: projectHealth(p.id).label, overdue: activities(p.id).filter((a) => a.cat === 'overdue').length,
      _date: p.startDate, _dept: p.departmentId, _status: p.status, _link: `#/projects/${p.id}` })) },

  { id: 'items', title: 'Item-wise report', perm: 'items.view',
    cols: [...P_COLS, ...I_COLS, c('required', 'Required', 'number'), c('uom', 'Unit'), c('accepted', 'Accepted', 'number'), c('outstanding', 'Outstanding', 'number'), c('availability', 'In-house availability'), c('development', 'Development'), c('testing', 'Testing'), c('status', 'Item status')],
    rows: () => store.list('projectItems').map((i) => { const q = itemQuantities(i.pid, i.id); return { ...base(i), required: q.required, uom: i.uom, accepted: q.accepted, outstanding: q.outstanding,
      availability: store.get('inventoryChecks', i.pid, i.id)?.availability || 'Not verified', development: store.get('development', i.pid, i.id)?.status || 'Not started', testing: latestTest(i.pid, i.id)?.status || 'Not started', status: i.itemStatus || 'Open',
      _date: i.requiredBy, _status: i.itemStatus || 'Open', _link: `#/items/${i.pid}/${i.id}` }; }) },

  { id: 'bom', title: 'BOM report', perm: 'items.view',
    cols: [...P_COLS, ...I_COLS, c('description', 'Description'), c('requiredQty', 'Required qty', 'number'), c('uom', 'Unit'), c('specs', 'Technical specifications'), c('priority', 'Priority'), c('preferredVendor', 'Preferred vendor'), c('estUnitCost', 'Est. unit cost', 'money'), c('estTotal', 'Est. total', 'money'), c('requiredBy', 'Required by', 'date')],
    rows: () => store.list('projectItems').map((i) => ({ ...base(i), description: i.description, requiredQty: i.requiredQty, uom: i.uom, specs: i.specs, priority: i.priority, preferredVendor: i.preferredVendor, estUnitCost: i.estUnitCost, estTotal: round(num(i.requiredQty) * num(i.estUnitCost), 2),
      _date: i.requiredBy, _vendor: i.preferredVendor, _status: i.priority, _link: `#/items/${i.pid}/${i.id}` })) },

  { id: 'procurement', title: 'Procurement report', perm: 'procurement.view',
    cols: [...P_COLS, c('id', 'Requirement'), c('type', 'Procurement type'), ...I_COLS, c('qty', 'Quantity', 'number'), c('origin', 'Origin'), c('status', 'Requirement status'), c('prId', 'PR number'), c('stage', 'Current stage')],
    rows: () => store.list('procurement').map((r) => ({ ...base(r), id: r.id, type: r.type, qty: r.qty, origin: r.origin, status: r.status, prId: r.prId, stage: procurementStage(r), _date: r.createdAt, _dept: r.sourceDeptId, _status: r.status, _link: link('procurement', r) })) },

  { id: 'pr', title: 'PR status report', perm: 'pr.view',
    cols: [c('id', 'PR number'), ...P_COLS, ...I_COLS, c('qty', 'Quantity', 'number'), c('type', 'Procurement type'), c('dept', 'Requesting department'), c('requestDate', 'Request date', 'date'), c('requiredBy', 'Required by', 'date'), c('requestedBy', 'Requested by'), c('status', 'Status'), c('approver', 'Approver'), c('decisionAt', 'Decision date', 'ts'), c('orderedQty', 'Ordered qty', 'number')],
    rows: () => store.list('purchaseRequests').map((r) => ({ ...base(r), id: r.id, qty: r.qty, type: r.procurementType, dept: D(r.requestingDeptId), requestDate: r.requestDate, requiredBy: r.requiredBy, requestedBy: U(r.requestedBy), status: r.status, approver: r.approverName, decisionAt: r.decisionAt, orderedQty: r.orderedQty,
      _date: r.requestDate, _dept: r.requestingDeptId, _status: r.status, _link: link('purchaseRequests', r) })) },

  { id: 'quotations', title: 'Vendor quotation comparison', perm: 'quotations.view',
    cols: [c('prId', 'PR number'), ...P_COLS, ...I_COLS, c('vendor', 'Vendor'), c('quotationNumber', 'Quotation no.'), c('quotationDate', 'Date', 'date'), c('unitPrice', 'Unit price', 'money'), c('gstPercent', 'GST %', 'number'), c('shippingCharges', 'Shipping', 'money'), c('otherCharges', 'Other', 'money'), c('totalAmount', 'Total', 'money'), c('deliveryTime', 'Delivery time'), c('validity', 'Valid until', 'date'), c('paymentTerms', 'Payment terms'), c('selected', 'Selected'), c('justification', 'Selection justification')],
    rows: () => store.list('quotations').map((q) => ({ ...base(q), prId: q.prId, vendor: q.vendorName, quotationNumber: q.quotationNumber, quotationDate: q.quotationDate, unitPrice: q.unitPrice, gstPercent: q.gstPercent, shippingCharges: q.shippingCharges, otherCharges: q.otherCharges, totalAmount: q.totalAmount, deliveryTime: q.deliveryTime, validity: q.validity, paymentTerms: q.paymentTerms,
      selected: q.selected ? 'Yes' : '', justification: q.selected ? store.get('purchaseRequests', q.pid, q.prId)?.selectionJustification : '', _date: q.quotationDate, _vendor: q.vendorName, _status: q.selected ? 'Selected' : 'Not selected', _link: link('purchaseRequests', { pid: q.pid, id: q.prId }) })).sort((a, b) => (a.prId + a.totalAmount > b.prId + b.totalAmount ? 1 : -1)) },

  { id: 'po', title: 'PO report', perm: 'po.view',
    cols: [c('id', 'PO number'), ...P_COLS, c('vendor', 'Vendor'), c('prId', 'PR reference'), ...I_COLS, c('type', 'Procurement type'), c('poDate', 'PO date', 'date'), c('quantity', 'Quantity', 'number'), c('unitPrice', 'Unit price', 'money'), c('taxPercent', 'Tax %', 'number'), c('totalValue', 'Total value', 'money'), c('deliveryDate', 'Delivery date', 'date'), c('dispatchedQty', 'Dispatched', 'number'), c('acceptedQty', 'Accepted', 'number'), c('status', 'Status')],
    rows: () => store.list('purchaseOrders').map((p) => ({ ...base(p), id: p.id, vendor: p.vendorName, prId: p.prId, type: p.procurementType, poDate: p.poDate, quantity: p.quantity, unitPrice: p.unitPrice, taxPercent: p.taxPercent, totalValue: p.totalValue, deliveryDate: p.deliveryDate, dispatchedQty: p.dispatchedQty, acceptedQty: p.acceptedQty, status: p.status,
      _date: p.poDate, _vendor: p.vendorName, _status: p.status, _dept: p.sourceDeptId, _link: link('purchaseOrders', p) })) },

  { id: 'pi', title: 'PI report', perm: 'pi.view',
    cols: [c('id', 'PI ref'), c('piNumber', 'PI number'), ...P_COLS, c('poId', 'PO reference'), c('vendor', 'Vendor'), c('piDate', 'PI date', 'date'), c('amount', 'Amount', 'money'), c('tax', 'Tax', 'money'), c('totalAmount', 'Total amount', 'money')],
    rows: () => store.list('proformaInvoices').map((p) => ({ pid: p.pid, project: PN(p.pid), id: p.id, piNumber: p.piNumber, poId: p.poId, vendor: p.vendorName, piDate: p.piDate, amount: p.amount, tax: p.tax, totalAmount: p.totalAmount, _date: p.piDate, _vendor: p.vendorName, _item: store.get('purchaseOrders', p.pid, p.poId)?.itemCode || '', _link: link('purchaseOrders', { pid: p.pid, id: p.poId }) })) },

  { id: 'payments', title: 'Payment and outstanding report', perm: 'payments.view',
    cols: [c('poId', 'PO number'), ...P_COLS, c('vendor', 'Vendor'), c('type', 'Procurement type'), c('totalValue', 'PO value', 'money'), c('adjustments', 'Authorised adjustments', 'money'), c('payable', 'Payable', 'money'), c('paid', 'Successful payments', 'money'), c('outstanding', 'Outstanding', 'money'), c('payments', 'Payment entries', 'number'), c('lastPayment', 'Last payment', 'date')],
    rows: () => store.list('purchaseOrders').filter((p) => p.status !== 'Cancelled').map((p) => { const f = poFinance(p); const pays = store.where('payments', p.pid, (x) => x.poId === p.id);
      return { pid: p.pid, project: PN(p.pid), poId: p.id, vendor: p.vendorName, type: p.procurementType, totalValue: p.totalValue, adjustments: p.adjTotal, payable: f.payable, paid: f.paid, outstanding: f.outstanding, payments: pays.length, lastPayment: pays.map((x) => x.paymentDate).sort().slice(-1)[0],
        _date: p.poDate, _vendor: p.vendorName, _status: f.outstanding > 0.005 ? 'Outstanding' : 'Settled', _item: p.itemCode, _link: link('purchaseOrders', p) }; }) },

  { id: 'vendors', title: 'Vendor-wise expenditure', perm: 'expenditure.view',
    cols: [c('vendor', 'Vendor'), c('projects', 'Projects', 'number'), c('pos', 'Purchase orders', 'number'), c('ordered', 'Ordered', 'money'), c('paid', 'Paid', 'money'), c('outstanding', 'Outstanding', 'money')],
    rows: (f) => Object.entries(groupBy(store.list('purchaseOrders').filter((p) => p.status !== 'Cancelled' && (!f?.project || p.pid === f.project)), 'vendorName')).map(([vendor, po]) => ({ vendor, projects: new Set(po.map((x) => x.pid)).size, pos: po.length, ordered: round(sum(po, 'totalValue'), 2), paid: round(sum(po, 'paidTotal'), 2), outstanding: round(sum(po, (x) => poFinance(x).outstanding), 2), _vendor: vendor })) },

  { id: 'availability', title: 'Material availability report', perm: 'inventory.view',
    cols: [...P_COLS, ...I_COLS, c('requiredQty', 'Required', 'number'), c('availableQty', 'Available in-house', 'number'), c('availability', 'Availability'), c('transferQty', 'To transfer', 'number'), c('shortageQty', 'Shortage', 'number'), c('source', 'Source department'), c('location', 'Stock location'), c('verifiedBy', 'Verified by'), c('verifiedAt', 'Verified on', 'date')],
    rows: () => store.list('inventoryChecks').map((k) => ({ ...base(k), requiredQty: k.requiredQty, availableQty: k.availableQty, availability: k.availability, transferQty: k.transferQty, shortageQty: k.shortageQty, source: D(k.sourceDeptId), location: k.stockLocation, verifiedBy: U(k.verifiedBy), verifiedAt: k.verifiedAt,
      _date: k.verifiedAt, _dept: k.sourceDeptId, _status: k.availability, _link: `#/items/${k.pid}/${k.id}` })) },

  { id: 'transfers', title: 'Stock transfer report', perm: 'transfers.view',
    cols: [c('id', 'Transfer ID'), ...P_COLS, ...I_COLS, c('qty', 'Quantity', 'number'), c('source', 'Source department'), c('dest', 'Requesting department'), c('status', 'Status'), c('dispatchedQty', 'Dispatched', 'number'), c('receivedQty', 'Received', 'number'), c('acceptedQty', 'Accepted', 'number'), c('rejectedQty', 'Rejected', 'number'), c('requirementId', 'Replenishment requirement')],
    rows: () => store.list('stockTransfers').map((t) => ({ ...base(t), id: t.id, qty: t.qty, source: D(t.sourceDeptId), dest: D(t.destDeptId), status: t.status, dispatchedQty: t.dispatchedQty, receivedQty: t.receivedQty, acceptedQty: t.acceptedQty, rejectedQty: t.rejectedQty, requirementId: t.requirementId,
      _date: t.dispatchDate || t.createdAt, _dept: t.sourceDeptId, _status: t.status, _link: link('stockTransfers', t) })) },

  { id: 'replenishment', title: 'Source stock replenishment report', perm: 'procurement.view',
    cols: [c('id', 'Requirement'), ...P_COLS, ...I_COLS, c('source', 'Source department'), c('qty', 'Quantity to replenish', 'number'), c('transferId', 'Linked transfer'), c('transferStatus', 'Transfer status'), c('status', 'Requirement status'), c('prId', 'PR number'), c('stage', 'Procurement stage'), c('ordered', 'Ordered', 'number'), c('received', 'Received by source dept', 'number')],
    rows: () => store.list('procurement').filter((r) => r.type === REPL).map((r) => { const pos = store.where('purchaseOrders', r.pid, (p) => p.prId && p.prId === r.prId && p.status !== 'Cancelled');
      return { ...base(r), id: r.id, source: D(r.sourceDeptId), qty: r.qty, transferId: r.transferId, transferStatus: store.get('stockTransfers', r.pid, r.transferId)?.status || '', status: r.status, prId: r.prId, stage: procurementStage(r), ordered: sum(pos, 'quantity'), received: sum(pos, 'acceptedQty'),
        _date: r.createdAt, _dept: r.sourceDeptId, _status: r.status, _link: link('procurement', r) }; }) },

  { id: 'spif', title: 'SPIF receipt report', perm: 'receipts.view',
    cols: [c('id', 'GRN number'), ...P_COLS, c('poId', 'PO number'), c('dispatchId', 'Dispatch ref'), c('vendor', 'Vendor'), ...I_COLS, c('location', 'Received at'), c('receiptDate', 'Receipt date', 'date'), c('receivedQty', 'Received', 'number'), c('acceptedQty', 'Accepted', 'number'), c('rejectedQty', 'Rejected', 'number'), c('inspectionStatus', 'Inspection'), c('challanNumber', 'Challan no.')],
    rows: () => store.list('materialReceipts').map((g) => ({ ...base(g), id: g.id, poId: g.poId, dispatchId: g.dispatchId, vendor: g.vendorName, location: g.receiptLocation, receiptDate: g.receiptDate, receivedQty: g.receivedQty, acceptedQty: g.acceptedQty, rejectedQty: g.rejectedQty, inspectionStatus: g.inspectionStatus, challanNumber: g.challanNumber,
      _date: g.receiptDate, _vendor: g.vendorName, _status: g.inspectionStatus, _link: link('materialReceipts', g) })) },

  { id: 'gvt', title: 'GVT receipt report', perm: 'gvt.view',
    cols: [c('id', 'GVT receipt'), ...P_COLS, c('mrId', 'MR number'), ...I_COLS, c('receiptDate', 'Receipt date', 'date'), c('dispatchedQty', 'Dispatched', 'number'), c('receivedQty', 'Received', 'number'), c('acceptedQty', 'Accepted', 'number'), c('rejectedQty', 'Rejected', 'number'), c('receivingPerson', 'Receiving person'), c('discrepancy', 'Discrepancy')],
    rows: () => store.list('gvtReceipts').map((g) => ({ ...base(g), id: g.id, mrId: g.mrId, receiptDate: g.receiptDate, dispatchedQty: g.dispatchedQty, receivedQty: g.receivedQty, acceptedQty: g.acceptedQty, rejectedQty: g.rejectedQty, receivingPerson: g.receivingPerson, discrepancy: g.discrepancy, _date: g.receiptDate, _status: g.discrepancy ? 'Discrepancy' : 'OK', _link: link('gvtReceipts', g) })) },

  { id: 'movement', title: 'Material movement report', perm: 'items.view',
    cols: [...P_COLS, ...I_COLS, c('required', 'Required', 'number'), c('transferred', 'Transferred from stock', 'number'), c('procured', 'Procured for project', 'number'), c('replenishment', 'Procured for replenishment', 'number'), c('dispatched', 'Dispatched', 'number'), c('received', 'Received', 'number'), c('accepted', 'Accepted', 'number'), c('rejected', 'Rejected', 'number'), c('toGvt', 'Dispatched to GVT', 'number'), c('atGvt', 'Accepted at GVT', 'number'), c('outstanding', 'Outstanding', 'number')],
    rows: () => store.list('projectItems').map((i) => { const q = itemQuantities(i.pid, i.id); const mrs = store.where('materialRequests', i.pid, (m) => m.itemId === i.id && m.status !== 'Cancelled');
      return { ...base(i), required: q.required, transferred: q.transferred, procured: q.procuredProject, replenishment: q.procuredReplenishment, dispatched: q.dispatched, received: q.received, accepted: q.accepted, rejected: q.rejected, toGvt: sum(mrs, 'dispatchedQty'), atGvt: sum(mrs, 'acceptedQty'), outstanding: q.outstanding,
        _date: i.requiredBy, _status: q.outstanding > 0 ? 'Outstanding' : 'Fulfilled', _link: `#/items/${i.pid}/${i.id}` }; }) },

  { id: 'gatepass', title: 'RGP / NRGP report', perm: 'gatepass.view',
    cols: [c('id', 'Gate pass no.'), c('type', 'Type'), ...P_COLS, ...I_COLS, c('qty', 'Quantity', 'number'), c('destination', 'Destination'), c('issueDate', 'Issue date', 'date'), c('expectedReturn', 'Expected return', 'date'), c('returnedQty', 'Returned', 'number'), c('remaining', 'Still out', 'number'), c('status', 'Status'), c('overdueDays', 'Overdue days', 'number'), c('approver', 'Approved by')],
    rows: () => store.list('gatePasses').map((g) => { const due = rgpDue(g); return { ...base(g), id: g.id, type: g.type, qty: g.qty, destination: g.destination, issueDate: g.issueDate, expectedReturn: g.expectedReturn, returnedQty: g.type === 'RGP' ? g.returnedQty : '', remaining: g.type === 'RGP' ? round(num(g.qty) - num(g.returnedQty)) : '', status: g.status, overdueDays: due !== null && due < 0 ? -due : '', approver: g.approverName,
      _date: g.issueDate, _status: g.status, _link: link('gatePasses', g) }; }) },

  { id: 'logistics', title: 'Logistics report', perm: 'logistics.view',
    cols: [c('id', 'Request ID'), ...P_COLS, c('materialRef', 'Material reference'), c('pickupLocation', 'Pickup'), c('destination', 'Destination'), c('transportMode', 'Mode'), c('transporter', 'Transporter'), c('assigned', 'Assigned person'), c('pickupDate', 'Pickup date', 'date'), c('expectedDelivery', 'Expected delivery', 'date'), c('actualDelivery', 'Actual delivery', 'date'), c('status', 'Status')],
    rows: () => store.list('logistics').map((l) => ({ pid: l.pid, project: PN(l.pid), id: l.id, materialRef: l.materialRef, pickupLocation: l.pickupLocation, destination: l.destination, transportMode: l.transportMode, transporter: l.transporter, assigned: U(l.assignedPersonId), pickupDate: l.pickupDate, expectedDelivery: l.expectedDelivery, actualDelivery: l.actualDelivery, status: l.status,
      _date: l.pickupDate || l.expectedDelivery, _dept: 'logistics', _status: l.status, _vendor: l.transporter, _item: l.materialRef, _link: link('logistics', l) })) },

  { id: 'travel', title: 'Travel Desk report', perm: 'travel.view',
    cols: [c('id', 'Request ID'), ...P_COLS, c('employee', 'Employee'), c('purpose', 'Purpose'), c('origin', 'Origin'), c('destination', 'Destination'), c('travelDate', 'Travel date', 'date'), c('returnDate', 'Return date', 'date'), c('approval', 'Approval'), c('status', 'Status'), c('bookingRefs', 'Booking references')],
    rows: () => store.list('travelDesk').map((t) => ({ pid: t.pid, project: PN(t.pid), id: t.id, employee: U(t.employeeId), purpose: t.purpose, origin: t.origin, destination: t.destination, travelDate: t.travelDate, returnDate: t.returnDate, approval: t.approvalStatus, status: t.status, bookingRefs: t.bookingRefs,
      _date: t.travelDate, _dept: 'travel_desk', _status: t.status, _item: '', _link: link('travelDesk', t) })) },

  { id: 'development', title: 'Development report', perm: 'development.view',
    cols: [...P_COLS, ...I_COLS, c('team', 'Team'), c('engineer', 'Engineer'), c('startDate', 'Start', 'date'), c('expectedCompletion', 'Expected completion', 'date'), c('actualCompletion', 'Actual completion', 'date'), c('status', 'Status'), c('revision', 'Revision', 'number'), c('reopenCount', 'Times reopened', 'number'), c('issues', 'Issues')],
    rows: () => store.list('development').map((d) => ({ ...base(d), team: d.team, engineer: U(d.engineerId), startDate: d.startDate, expectedCompletion: d.expectedCompletion, actualCompletion: d.actualCompletion, status: d.status, revision: d.revision, reopenCount: d.reopenCount, issues: d.issues,
      _date: d.startDate, _dept: 'development', _status: d.status, _link: `#/items/${d.pid}/${d.id}` })) },

  { id: 'testing', title: 'Testing report', perm: 'testing.view',
    cols: [c('id', 'Test cycle'), ...P_COLS, ...I_COLS, c('cycle', 'Cycle no.', 'number'), c('testDate', 'Test date', 'date'), c('engineer', 'Test engineer'), c('environment', 'Environment'), c('status', 'Status'), c('result', 'Result'), c('observations', 'Observations'), c('approver', 'Approved by')],
    rows: () => store.list('testing').map((t) => ({ ...base(t), id: t.id, cycle: t.cycle, testDate: t.testDate, engineer: U(t.engineerId), environment: t.environment, status: t.status, result: t.result, observations: t.observations, approver: t.approverName,
      _date: t.testDate, _dept: 'testing', _status: t.status, _link: `#/items/${t.pid}/${t.itemId}` })) },

  { id: 'deptPending', title: 'Department-wise pending activity report', perm: 'reports.view',
    cols: [c('dept', 'Department'), c('notStarted', 'Not started', 'number'), c('inProgress', 'In progress', 'number'), c('waiting', 'Waiting for approval', 'number'), c('held', 'On hold / blocked', 'number'), c('overdue', 'Overdue', 'number'), c('total', 'Total open', 'number')],
    rows: (f) => { const open = new Set(store.projects().filter((p) => !['Completed', 'Cancelled'].includes(p.status)).map((p) => p.id));
      const st = store.list('stages', f?.project || undefined).filter((s) => open.has(s.pid) && !['Completed', 'Cancelled'].includes(s.status));
      const od = groupBy(activities(f?.project || undefined).filter((a) => a.cat === 'overdue'), (a) => a.deptId || '');
      return Object.entries(groupBy(st, (s) => s.deptId || '')).map(([d, list]) => ({ dept: D(d) || 'Unassigned', notStarted: list.filter((s) => s.status === 'Not Started').length, inProgress: list.filter((s) => s.status === 'In Progress').length, waiting: list.filter((s) => s.status === 'Waiting for Approval').length, held: list.filter((s) => ['On Hold', 'Blocked'].includes(s.status)).length, overdue: (od[d] || []).length, total: list.length, _dept: d })); } },

  { id: 'overdue', title: 'Overdue activity report', perm: 'reports.view',
    cols: [...P_COLS, c('itemCode', 'Item code'), c('activity', 'Activity'), c('dept', 'Department'), c('person', 'Responsible person'), c('due', 'Expected date', 'date'), c('status', 'Status'), c('overdueDays', 'Overdue days', 'number')],
    rows: () => activities().filter((a) => a.cat === 'overdue').map((a) => ({ pid: a.pid, project: a.projectName, itemCode: a.itemCode, activity: a.label, dept: D(a.deptId), person: U(a.personId), due: a.due, status: a.status, overdueDays: a.overdueDays, _date: a.due, _dept: a.deptId, _status: a.status, _item: a.itemCode, _link: a.link })) },

  { id: 'expenditure', title: 'Project expenditure report', perm: 'expenditure.view',
    cols: [...P_COLS, c('budget', 'Estimated budget', 'money'), c('estimated', 'Estimated cost (BOM)', 'money'), c('pr', 'PR value', 'money'), c('ordered', 'Ordered — project', 'money'), c('orderedRepl', 'Ordered — replenishment', 'money'), c('invoiced', 'Invoiced (all)', 'money'), c('paid', 'Paid (all)', 'money'), c('outstanding', 'Outstanding (all)', 'money')],
    rows: () => store.projects({ archived: true }).map((p) => { const e = projectExpenditure(p.id); return { pid: p.id, project: p.name, budget: e.budget, estimated: e.estimated, pr: e.total.pr, ordered: e.project.ordered, orderedRepl: e.replenishment.ordered, invoiced: e.total.invoiced, paid: e.total.paid, outstanding: e.total.outstanding, _date: p.startDate, _dept: p.departmentId, _status: p.status, _link: `#/projects/${p.id}` }; }) },

  { id: 'closure', title: 'Project closure report', perm: 'closure.view',
    cols: [...P_COLS, c('status', 'Project status'), c('kind', 'Closure type'), c('date', 'Completion / cancellation date', 'date'), c('approvedBy', 'Approved by'), c('override', 'Override used'), c('reason', 'Reason / override reason'), c('unresolved', 'Unresolved checks'), c('remarks', 'Final remarks')],
    rows: () => store.list('closures').filter((x) => x.kind !== 'reopen').map((x) => ({ pid: x.pid, project: PN(x.pid), status: store.project(x.pid)?.status, kind: x.kind === 'completion' ? 'Completion' : 'Cancellation', date: x.completionDate || x.cancellationDate, approvedBy: x.approvedByName, override: x.override ? 'Yes' : 'No', reason: x.reason || x.overrideReason, unresolved: x.unresolved, remarks: x.finalRemarks,
      _date: x.completionDate || x.cancellationDate, _status: x.kind, _link: `#/projects/${x.pid}` })) },
];

export const availableReports = () => (can('reports.view') ? REPORTS.filter((r) => can(r.perm)) : []);

/** Build a report and apply the common filters (date range, project, item, department, vendor, status). */
export function runReport(id, f = {}) {
  const def = REPORTS.find((r) => r.id === id);
  if (!def || !can('reports.view') || !can(def.perm)) return { def, rows: [] };
  const toDay = (v) => (typeof v === 'number' ? new Date(v).toISOString().slice(0, 10) : v);
  const text = (s) => String(s || '').toLowerCase();
  const rows = def.rows(f).filter((r) => {
    if (f.project && r.pid !== undefined && r.pid !== f.project) return false;
    if (f.from && (!r._date || toDay(r._date) < f.from)) return false;
    if (f.to && (!r._date || toDay(r._date) > f.to)) return false;
    if (f.dept && r._dept !== f.dept) return false;
    if (f.status && text(r._status) !== text(f.status)) return false;
    if (f.vendor && !text(r._vendor ?? r.vendor).includes(text(f.vendor))) return false;
    if (f.item && !text(r._item ?? `${r.itemCode || ''} ${r.itemName || ''}`).includes(text(f.item))) return false;
    return true;
  });
  return { def, rows, statuses: [...new Set(def.rows(f).map((r) => r._status).filter(Boolean))].sort() };
}

/** Rows as arrays for CSV / Excel (first row = headings). Dates and timestamps become ISO text. */
export function reportTable({ def, rows }) {
  const fmt = (v, t) => (v === undefined || v === null ? '' : t === 'ts' ? new Date(v).toISOString().slice(0, 16).replace('T', ' ') : v);
  return [def.cols.map((x) => x.label), ...rows.map((r) => def.cols.map((x) => fmt(r[x.key], x.type)))];
}

/* ------------------------------------------------------------------ global search */
/** Search everything the user is allowed to see. Returns [{ type, title, sub, link }]. */
export function globalSearch(query, limit = 60) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const out = [];
  const hit = (...vals) => vals.some((v) => v && String(v).toLowerCase().includes(q));
  const push = (type, title, sub, lnk) => { if (out.length < limit) out.push({ type, title, sub, link: lnk }); };
  for (const p of store.projects({ archived: true })) if (hit(p.id, p.name)) push('Project', `${p.id} — ${p.name}`, p.status, `#/projects/${p.id}`);
  for (const i of store.list('projectItems')) if (hit(i.itemCode, i.name, i.id)) push('Item', `${i.itemCode} — ${i.name}`, `Project ${i.pid}`, `#/items/${i.pid}/${i.id}`);
  const recs = [
    ['purchaseRequests', 'PR', (r) => [r.id, r.itemCode], (r) => `${r.itemCode} × ${r.qty} · ${r.status}`],
    ['purchaseOrders', 'PO', (r) => [r.id, r.vendorName, r.itemCode], (r) => `${r.vendorName} · ${r.itemCode} · ${r.status}`],
    ['proformaInvoices', 'PI', (r) => [r.id, r.piNumber, r.vendorName], (r) => `${r.vendorName} · PO ${r.poId}`],
    ['materialRequests', 'MR', (r) => [r.id, r.itemCode], (r) => `${r.itemCode} · ${r.status}`],
    ['materialReceipts', 'GRN', (r) => [r.id, r.vendorName, r.challanNumber], (r) => `${r.vendorName} · PO ${r.poId}`],
    ['quotations', 'Quotation', (r) => [r.id, r.vendorName, r.quotationNumber], (r) => `${r.vendorName} · PR ${r.prId}`],
    ['gatePasses', 'Gate pass', (r) => [r.id, r.destination, r.itemCode], (r) => `${r.type} · ${r.destination} · ${r.status}`],
    ['payments', 'Payment', (r) => [r.id, r.transactionRef, r.vendorName], (r) => `${r.vendorName} · PO ${r.poId} · ${r.status}`],
    ['stockTransfers', 'Stock transfer', (r) => [r.id, r.itemCode], (r) => `${r.itemCode} × ${r.qty} · ${r.status}`],
    ['dispatches', 'Dispatch', (r) => [r.id, r.trackingNumber, r.lrNumber, r.challanNumber, r.vendorName], (r) => `${r.vendorName} · PO ${r.poId}`],
    ['procurement', 'Requirement', (r) => [r.id], (r) => `${r.type} · ${r.itemCode} · ${r.status}`],
    ['logistics', 'Logistics', (r) => [r.id, r.materialRef, r.transporter], (r) => `${r.pickupLocation} → ${r.destination}`],
    ['travelDesk', 'Travel', (r) => [r.id, r.bookingRefs, store.userName(r.employeeId)], (r) => `${store.userName(r.employeeId)} · ${r.destination}`],
  ];
  for (const [coll, type, keys, sub] of recs) for (const r of store.list(coll)) if (hit(...keys(r))) push(type, r.id, `${sub(r)} · ${r.pid}`, link(coll, r));
  for (const u of store.users()) if (hit(u.displayName, u.username)) push('Employee', u.displayName, `${store.deptName(u.departmentId)} · ${store.role(u.roleId)?.name || ''}`, `#/people/${u.id}`);
  return out;
}

export { STAGE_STATUSES, today };
