/**
 * PROJECTFLOW 360 — record definitions (the data dictionary).
 *
 * One definition per record type. The same definitions drive:
 *   • the forms and tables in the interface,
 *   • the Firebase Security Rules generator (firebase/build-rules.mjs),
 *   • validation in the data layer.
 *
 * Field options:
 *   req   required            sys   set by the application, never typed by a user
 *   g     permission group    list  shown as a column in list tables
 *   opts  choices             neg   number may be negative
 *
 * Permission groups ("g") decide which permission is needed to CHANGE a field
 * after the record exists. `perms.create` decides who may create the record.
 * A permission is written "module.action"; any one of the listed ones suffices.
 */

const f = (name, label, type = 'text', o = {}) => ({ name, label, type, g: 'core', ...o });
const sys = (name, label, type = 'text', o = {}) => f(name, label, type, { sys: true, ...o });
const any = (module, ...acts) => acts.map((a) => `${module}.${a}`);

export const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
export const PROJECT_STATUSES = ['Planning', 'Active', 'On Hold', 'Completed', 'Cancelled'];
export const PROCUREMENT_TYPES = ['Project Requirement', 'Source Stock Replenishment'];

const approvalFields = (g = 'approval') => [
  sys('decision', 'Decision', 'text', { g }),
  sys('approverId', 'Approver', 'user', { g }),
  sys('approverName', 'Approver name', 'text', { g }),
  sys('decisionAt', 'Decision date', 'ts', { g }),
  sys('approvalRemarks', 'Approval remarks', 'textarea', { g }),
];
const itemRef = () => [sys('itemId', 'Item', 'text'), sys('itemCode', 'Item code', 'text', { list: true }), sys('itemName', 'Item name', 'text', { list: true })];

export const ENTITIES = {
  /* ------------------------------------------------------------------ projects (global) */
  projects: {
    label: 'Projects', one: 'Project', module: 'projects', global: true, idLabel: 'Project ID',
    fields: [
      f('name', 'Project name', 'text', { req: true, list: true }),
      f('description', 'Project description', 'textarea'),
      f('category', 'Project category', 'select', { optsFrom: 'projectCategories' }),
      f('managerId', 'Project manager', 'user', { req: true, list: true }),
      f('departmentId', 'Department', 'dept', { req: true }),
      f('startDate', 'Start date', 'date', { req: true }),
      f('targetDate', 'Target completion date', 'date', { req: true, list: true }),
      f('priority', 'Priority', 'select', { opts: PRIORITIES, req: true, list: true }),
      f('budget', 'Estimated budget', 'money'),
      f('remarks', 'Remarks', 'textarea'),
      sys('archived', 'Archived', 'bool'),
      sys('clonedFrom', 'Cloned from', 'text'),
      f('status', 'Project status', 'select', { opts: PROJECT_STATUSES, req: true, g: 'status', list: true }),
    ],
    perms: { create: any('projects', 'create'), groups: { core: any('projects', 'edit'), status: [...any('projects', 'updateStatus'), ...any('closure', 'approve')] } },
    init: { status: ['Planning', 'Active', 'On Hold'] },
  },

  /* ------------------------------------------------------------------ BOM */
  projectItems: {
    label: 'Project items', one: 'Item', module: 'items', prefix: 'IT', idLabel: 'Item ID',
    fields: [
      f('itemCode', 'Item code', 'text', { req: true, list: true, max: 60 }),
      f('name', 'Item name', 'text', { req: true, list: true }),
      f('description', 'Item description', 'textarea'),
      f('requiredQty', 'Required quantity', 'number', { req: true, list: true, positive: true }),
      f('uom', 'Unit of measurement', 'select', { optsFrom: 'units', req: true }),
      f('specs', 'Technical specifications', 'textarea'),
      f('priority', 'Priority', 'select', { opts: PRIORITIES, list: true }),
      f('preferredVendor', 'Preferred vendor'),
      f('estUnitCost', 'Estimated unit cost', 'money'),
      f('requiredBy', 'Required by date', 'date', { list: true, main: true }),
      f('remarks', 'Remarks', 'textarea'),
      sys('itemStatus', 'Item status', 'select', { opts: ['Open', 'Closed', 'Cancelled'], g: 'status', list: true }),
      sys('closedAt', 'Closed on', 'ts', { g: 'status' }),
      sys('closedBy', 'Closed by', 'user', { g: 'status' }),
    ],
    perms: { create: any('items', 'create'), groups: { core: any('items', 'edit'), status: [...any('items', 'updateStatus'), ...any('closure', 'approve', 'updateStatus')] } },
    init: { itemStatus: ['Open'] },
    softDelete: true,
  },

  /* ------------------------------------------------------------------ inventory */
  inventory: {
    label: 'Stock register', one: 'Stock record', module: 'inventory', global: true, prefix: 'STK', idLabel: 'Stock ref',
    fields: [
      f('itemCode', 'Item code', 'text', { req: true, list: true, max: 60 }),
      f('itemName', 'Item name', 'text', { req: true, list: true }),
      f('deptId', 'Department holding the stock', 'dept', { req: true, list: true }),
      f('location', 'Stock location', 'text', { list: true }),
      f('uom', 'Unit', 'select', { optsFrom: 'units' }),
      f('onHand', 'Quantity on hand', 'number', { req: true, g: 'qty', list: true }),
      sys('reserved', 'Reserved for transfers', 'number', { g: 'qty', list: true }),
      f('remarks', 'Remarks', 'textarea'),
    ],
    perms: {
      create: any('inventory', 'create'),
      groups: {
        core: any('inventory', 'edit'),
        qty: [...any('inventory', 'create', 'edit'), ...any('transfers', 'create', 'edit', 'updateStatus'), ...any('receipts', 'create')],
      },
    },
  },

  inventoryChecks: {
    label: 'Availability checks', one: 'Availability check', module: 'inventory', keyIsItem: true,
    fields: [
      ...itemRef(),
      sys('availability', 'Availability', 'select', { opts: ['Fully Available', 'Partially Available', 'Not Available'], list: true }),
      sys('requiredQty', 'Required quantity', 'number', { list: true }),
      f('availableQty', 'Available quantity', 'number', { req: true, list: true }),
      sys('transferQty', 'Quantity to transfer', 'number', { list: true }),
      sys('shortageQty', 'Shortage quantity', 'number', { list: true }),
      f('sourceDeptId', 'Source department', 'dept'),
      f('stockLocation', 'Source stock location'),
      f('stockRef', 'Stock reference'),
      sys('stockId', 'Stock record', 'text'),
      f('verifiedAt', 'Verification date', 'date', { req: true }),
      sys('verifiedBy', 'Verified by', 'user', { list: true }),
      f('remarks', 'Remarks', 'textarea'),
    ],
    perms: { create: any('inventory', 'create'), groups: { core: any('inventory', 'edit') } },
  },

  stockTransfers: {
    label: 'Stock transfers', one: 'Stock transfer', module: 'transfers', prefix: 'TRF', idLabel: 'Transfer ID',
    statuses: ['Requested', 'Approved', 'Rejected', 'Partially Dispatched', 'Dispatched', 'Partially Received', 'Received', 'Cancelled'],
    fields: [
      ...itemRef(),
      sys('qty', 'Transfer quantity', 'number', { list: true }),
      sys('sourceDeptId', 'Source department', 'dept', { list: true }),
      sys('destDeptId', 'Requesting department', 'dept'),
      sys('stockId', 'Stock record', 'text'),
      sys('requirementId', 'Linked replenishment requirement', 'text'),
      sys('adjustReason', 'Adjustment reason', 'textarea'),
      f('remarks', 'Remarks', 'textarea'),
      sys('status', 'Status', 'text', { g: 'status', list: true }),
      sys('cancelReason', 'Cancellation reason', 'textarea', { g: 'status' }),
      ...approvalFields(),
      sys('dispatchedQty', 'Dispatched quantity', 'number', { g: 'move', list: true }),
      sys('dispatchDate', 'Last dispatch date', 'date', { g: 'move' }),
      sys('receivedQty', 'Received quantity', 'number', { g: 'move' }),
      sys('acceptedQty', 'Accepted quantity', 'number', { g: 'move', list: true }),
      sys('rejectedQty', 'Rejected quantity', 'number', { g: 'move' }),
      sys('receiptDate', 'Last receipt date', 'date', { g: 'move' }),
      sys('receivedBy', 'Received by', 'user', { g: 'move' }),
    ],
    perms: {
      create: [...any('inventory', 'create', 'edit'), ...any('transfers', 'create')],
      groups: {
        core: any('transfers', 'edit'),
        status: any('transfers', 'updateStatus', 'edit', 'approve'),
        approval: any('transfers', 'approve'),
        move: any('transfers', 'updateStatus', 'edit'),
      },
    },
    init: { status: ['Requested'] },
  },

  /* ------------------------------------------------------------------ procurement */
  procurement: {
    label: 'Procurement requirements', one: 'Procurement requirement', module: 'procurement', prefix: 'REQ', idLabel: 'Requirement ID',
    statuses: ['Pending Approval', 'Open', 'PR Raised', 'Under Review', 'Closed', 'Rejected', 'Cancelled'],
    fields: [
      sys('type', 'Procurement type', 'select', { opts: PROCUREMENT_TYPES, list: true }),
      ...itemRef(),
      sys('qty', 'Quantity', 'number', { list: true }),
      sys('sourceDeptId', 'Source department to replenish', 'dept'),
      sys('transferId', 'Linked stock transfer', 'text'),
      sys('origin', 'Origin', 'text'),
      sys('reason', 'Reason', 'textarea'),
      sys('status', 'Status', 'text', { g: 'flow', list: true }),
      sys('prId', 'Purchase request', 'text', { g: 'flow', list: true }),
      sys('reviewReason', 'Review reason', 'textarea', { g: 'flow' }),
      sys('reviewDecision', 'Review decision', 'text', { g: 'flow' }),
      sys('reviewedBy', 'Reviewed by', 'user', { g: 'flow' }),
      sys('reviewedByName', 'Reviewed by', 'text', { g: 'flow' }),
      sys('reviewedAt', 'Reviewed on', 'ts', { g: 'flow' }),
      sys('reviewRemarks', 'Review remarks', 'textarea', { g: 'flow' }),
    ],
    perms: {
      create: [...any('inventory', 'create', 'edit'), ...any('procurement', 'create'), ...any('development', 'create', 'edit')],
      groups: {
        core: any('procurement', 'approve'),
        flow: [...any('pr', 'create', 'approve'), ...any('procurement', 'updateStatus', 'approve', 'edit'), ...any('transfers', 'edit', 'updateStatus')],
      },
    },
    init: { status: ['Open', 'Pending Approval'] },
  },

  purchaseRequests: {
    label: 'Purchase requests', one: 'Purchase request', module: 'pr', prefix: 'PR', idLabel: 'PR number',
    statuses: ['Pending Approval', 'Approved', 'Rejected', 'Changes Requested', 'Cancelled'],
    fields: [
      sys('requirementId', 'Procurement requirement', 'text'),
      ...itemRef(),
      sys('qty', 'Quantity', 'number', { list: true }),
      sys('procurementType', 'Procurement type', 'text', { list: true }),
      sys('sourceDeptId', 'Source department', 'dept'),
      f('purpose', 'Purpose', 'textarea', { req: true }),
      f('requestingDeptId', 'Requesting department', 'dept', { req: true }),
      f('requestDate', 'Request date', 'date', { req: true }),
      f('requiredBy', 'Required by date', 'date', { list: true, main: true }),
      sys('requestedBy', 'Requested by', 'user', { list: true }),
      f('remarks', 'Remarks', 'textarea'),
      sys('status', 'Status', 'text', { g: 'status', list: true }),
      sys('decision', 'Decision', 'text', { g: 'approval' }),
      sys('approverId', 'Approver', 'user', { g: 'approval' }),
      sys('approverName', 'Approver name', 'text', { g: 'approval' }),
      sys('decisionAt', 'Approval date', 'ts', { g: 'approval' }),
      sys('rejectionReason', 'Rejection reason', 'textarea', { g: 'approval' }),
      sys('approvalComments', 'Approval comments', 'textarea', { g: 'approval' }),
      sys('selectedQuotationId', 'Selected quotation', 'text', { g: 'selection' }),
      sys('selectionJustification', 'Selection justification', 'textarea', { g: 'selection' }),
      sys('selectedBy', 'Selected by', 'user', { g: 'selection' }),
      sys('selectedAt', 'Selected on', 'ts', { g: 'selection' }),
      sys('orderedQty', 'Ordered quantity', 'number', { g: 'agg' }),
    ],
    perms: {
      create: any('pr', 'create'),
      groups: {
        core: any('pr', 'edit'),
        status: any('pr', 'create', 'edit', 'approve'),
        approval: any('pr', 'approve'),
        selection: any('quotations', 'approve', 'updateStatus'),
        agg: any('po', 'create', 'edit'),
      },
    },
  },

  quotations: {
    label: 'Vendor quotations', one: 'Quotation', module: 'quotations', prefix: 'QTN', idLabel: 'Quotation ref',
    fields: [
      sys('prId', 'PR number', 'text', { list: true }),
      ...itemRef(),
      sys('qty', 'Quantity', 'number'),
      f('vendorName', 'Vendor name', 'text', { req: true, list: true }),
      f('vendorContact', 'Vendor contact'),
      f('quotationNumber', 'Quotation number', 'text', { list: true }),
      f('quotationDate', 'Quotation date', 'date'),
      f('unitPrice', 'Unit price', 'money', { req: true, list: true }),
      f('gstPercent', 'GST %', 'number', { main: true }),
      f('shippingCharges', 'Shipping charges', 'money', { main: true }),
      f('otherCharges', 'Other charges', 'money'),
      f('deliveryTime', 'Delivery time'),
      f('validity', 'Valid until', 'date'),
      f('paymentTerms', 'Payment terms'),
      f('remarks', 'Remarks', 'textarea'),
      sys('totalAmount', 'Total amount', 'money', { list: true }),
      sys('selected', 'Selected', 'bool', { g: 'selection', list: true }),
    ],
    perms: { create: any('quotations', 'create'), groups: { core: any('quotations', 'edit'), selection: any('quotations', 'approve', 'updateStatus') } },
    softDelete: true,
  },

  purchaseOrders: {
    label: 'Purchase orders', one: 'Purchase order', module: 'po', prefix: 'PO', idLabel: 'PO number',
    statuses: ['Issued', 'Closed', 'Cancelled'],
    fields: [
      sys('prId', 'PR reference', 'text', { list: true }),
      sys('quotationId', 'Selected quotation', 'text'),
      ...itemRef(),
      sys('procurementType', 'Procurement type', 'text'),
      sys('sourceDeptId', 'Source department', 'dept'),
      sys('vendorName', 'Vendor', 'text', { list: true }),
      f('poDate', 'PO date', 'date', { req: true }),
      f('quantity', 'Quantity', 'number', { req: true, list: true, positive: true }),
      f('unitPrice', 'Unit price', 'money', { req: true }),
      f('taxPercent', 'Tax %', 'number', { main: true }),
      f('otherCharges', 'Shipping and other charges', 'money', { main: true }),
      sys('totalValue', 'Total value', 'money', { list: true }),
      f('deliveryAddress', 'Delivery address', 'textarea'),
      f('deliveryDate', 'Delivery date', 'date', { list: true, main: true }),
      f('paymentTerms', 'Payment terms'),
      f('remarks', 'Remarks', 'textarea'),
      sys('status', 'Status', 'text', { g: 'status', list: true }),
      sys('paidTotal', 'Paid', 'money', { g: 'pay' }),
      sys('adjTotal', 'Authorised adjustments', 'money', { g: 'pay', neg: true }),
      sys('dispatchedQty', 'Dispatched quantity', 'number', { g: 'disp' }),
      sys('receivedQty', 'Received quantity', 'number', { g: 'rcpt' }),
      sys('acceptedQty', 'Accepted quantity', 'number', { g: 'rcpt' }),
      sys('rejectedQty', 'Rejected quantity', 'number', { g: 'rcpt' }),
    ],
    perms: {
      create: any('po', 'create'),
      groups: {
        core: any('po', 'edit'),
        status: any('po', 'updateStatus', 'edit'),
        pay: any('payments', 'create', 'edit', 'updateStatus', 'approve'),
        disp: any('dispatch', 'create', 'edit'),
        rcpt: any('receipts', 'create', 'edit'),
      },
    },
    init: { status: ['Issued'] },
  },

  proformaInvoices: {
    label: 'Proforma invoices', one: 'Proforma invoice', module: 'pi', prefix: 'PI', idLabel: 'PI ref',
    fields: [
      sys('poId', 'PO reference', 'text', { list: true }),
      sys('vendorName', 'Vendor', 'text', { list: true }),
      f('piNumber', 'PI number', 'text', { req: true, list: true }),
      f('piDate', 'PI date', 'date', { req: true, list: true }),
      f('amount', 'Amount', 'money', { req: true }),
      f('tax', 'Tax', 'money'),
      sys('totalAmount', 'Total amount', 'money', { list: true }),
      f('remarks', 'Remarks', 'textarea'),
    ],
    perms: { create: any('pi', 'create'), groups: { core: any('pi', 'edit') } },
    softDelete: true,
  },

  payments: {
    label: 'Payments', one: 'Payment', module: 'payments', prefix: 'PAY', idLabel: 'Payment reference',
    statuses: ['Pending', 'Successful', 'Failed', 'Reversed'],
    fields: [
      sys('poId', 'PO reference', 'text', { list: true }),
      sys('vendorName', 'Vendor', 'text', { list: true }),
      f('piId', 'PI reference', 'ref'),
      f('paymentDate', 'Payment date', 'date', { req: true, list: true }),
      f('amount', 'Payment amount', 'money', { req: true, list: true, positive: true, frozen: true }),
      f('mode', 'Payment mode', 'select', { optsFrom: 'paymentModes', req: true }),
      f('transactionRef', 'Transaction reference', 'text', { list: true, main: true }),
      f('remarks', 'Remarks', 'textarea'),
      f('status', 'Payment status', 'select', { opts: ['Pending', 'Successful', 'Failed', 'Reversed'], req: true, g: 'status', list: true }),
    ],
    perms: { create: any('payments', 'create'), groups: { core: any('payments', 'edit'), status: any('payments', 'updateStatus', 'edit', 'create') } },
  },

  paymentAdjustments: {
    label: 'Payment adjustments', one: 'Payment adjustment', module: 'payments', prefix: 'ADJ', idLabel: 'Adjustment ref',
    fields: [
      sys('poId', 'PO reference', 'text', { list: true }),
      f('amount', 'Adjustment to payable amount (+/−)', 'money', { req: true, neg: true, list: true, frozen: true }),
      f('reason', 'Reason', 'textarea', { req: true, list: true }),
      sys('approvedBy', 'Authorised by', 'user', { list: true }),
    ],
    perms: { create: any('payments', 'approve'), groups: { core: [] } },
  },

  dispatches: {
    label: 'Vendor dispatches', one: 'Dispatch', module: 'dispatch', prefix: 'DSP', idLabel: 'Dispatch ref',
    fields: [
      sys('poId', 'PO reference', 'text', { list: true }),
      sys('vendorName', 'Vendor', 'text', { list: true }),
      ...itemRef(),
      sys('procurementType', 'Procurement type', 'text'),
      f('dispatchDate', 'Dispatch date', 'date', { req: true, list: true }),
      f('qty', 'Dispatch quantity', 'number', { req: true, list: true, positive: true, frozen: true }),
      f('courier', 'Courier / transporter'),
      f('trackingNumber', 'Tracking number'),
      f('lrNumber', 'LR number'),
      f('challanNumber', 'Challan number'),
      f('expectedDelivery', 'Expected delivery date', 'date', { list: true, main: true }),
      f('trackingLink', 'Tracking link', 'url'),
      f('remarks', 'Remarks', 'textarea'),
      sys('receivedQty', 'Received quantity', 'number', { g: 'rcpt', list: true }),
    ],
    perms: { create: any('dispatch', 'create'), groups: { core: any('dispatch', 'edit'), rcpt: any('receipts', 'create', 'edit') } },
  },

  /* ------------------------------------------------------------------ material */
  materialReceipts: {
    label: 'SPIF receipts (GRN)', one: 'Material receipt', module: 'receipts', prefix: 'GRN', idLabel: 'GRN number',
    fields: [
      sys('poId', 'PO number', 'text', { list: true }),
      sys('dispatchId', 'Dispatch reference', 'text', { list: true }),
      sys('vendorName', 'Vendor', 'text', { list: true }),
      ...itemRef(),
      sys('procurementType', 'Procurement type', 'text'),
      sys('receiptLocation', 'Received at', 'text', { list: true }),
      f('receiptDate', 'Receipt date', 'date', { req: true, list: true }),
      f('receivedQty', 'Received quantity', 'number', { req: true, list: true, positive: true, frozen: true }),
      f('acceptedQty', 'Accepted quantity', 'number', { req: true, list: true, frozen: true }),
      f('rejectedQty', 'Rejected quantity', 'number', { req: true, frozen: true }),
      f('inspectionStatus', 'Inspection status', 'select', { opts: ['Pending', 'Accepted', 'Partially Accepted', 'Rejected'], list: true }),
      f('challanNumber', 'Delivery challan number'),
      f('damageDetails', 'Damage details', 'textarea'),
      f('shortageDetails', 'Shortage details', 'textarea'),
      f('inspectionRemarks', 'Inspection remarks', 'textarea'),
    ],
    perms: { create: any('receipts', 'create'), groups: { core: any('receipts', 'edit') } },
  },

  materialRequests: {
    label: 'Material requests', one: 'Material request', module: 'mr', prefix: 'MR', idLabel: 'MR number',
    statuses: ['Created', 'Approved', 'Rejected', 'Material Prepared', 'Partially Dispatched', 'Dispatched', 'Partially Received', 'Received at GVT', 'Cancelled'],
    fields: [
      ...itemRef(),
      f('qtyRequested', 'Quantity requested', 'number', { req: true, list: true, positive: true }),
      sys('availableSpifQty', 'Available SPIF quantity', 'number', { list: true }),
      f('requestDate', 'Request date', 'date', { req: true }),
      sys('requestedBy', 'Requested by', 'user', { list: true }),
      f('remarks', 'Remarks', 'textarea'),
      sys('status', 'Status', 'text', { g: 'status', list: true }),
      ...approvalFields(),
      sys('approvedQty', 'Approved quantity', 'number', { g: 'approval', list: true }),
      sys('preparedAt', 'Material prepared on', 'date', { g: 'move' }),
      sys('dispatchedQty', 'Dispatched quantity', 'number', { g: 'move', list: true }),
      sys('dispatchDate', 'Last dispatch date', 'date', { g: 'move' }),
      sys('receivedQty', 'Received at GVT', 'number', { g: 'rcpt', list: true }),
      sys('acceptedQty', 'Accepted at GVT', 'number', { g: 'rcpt' }),
      sys('rejectedQty', 'Rejected at GVT', 'number', { g: 'rcpt' }),
    ],
    perms: {
      create: any('mr', 'create'),
      groups: {
        core: any('mr', 'edit'),
        status: [...any('mr', 'updateStatus', 'edit', 'approve'), ...any('gvt', 'create')],
        approval: any('mr', 'approve'),
        move: any('mr', 'updateStatus', 'edit'),
        rcpt: any('gvt', 'create', 'edit'),
      },
    },
    init: { status: ['Created'] },
  },

  gvtReceipts: {
    label: 'GVT receipts', one: 'GVT receipt', module: 'gvt', prefix: 'GVR', idLabel: 'GVT receipt ref',
    fields: [
      sys('mrId', 'MR number', 'text', { list: true }),
      ...itemRef(),
      sys('dispatchedQty', 'Dispatched quantity', 'number', { list: true }),
      f('receiptDate', 'Receipt date', 'date', { req: true, list: true }),
      f('receivedQty', 'Received quantity', 'number', { req: true, list: true, positive: true, frozen: true }),
      f('acceptedQty', 'Accepted quantity', 'number', { req: true, list: true, frozen: true }),
      f('rejectedQty', 'Rejected quantity', 'number', { req: true, frozen: true }),
      f('receivingPerson', 'Receiving person', 'text', { list: true }),
      f('discrepancy', 'Discrepancy report', 'textarea'),
      f('inspectionRemarks', 'Inspection remarks', 'textarea'),
    ],
    perms: { create: any('gvt', 'create'), groups: { core: any('gvt', 'edit') } },
  },

  logistics: {
    label: 'Logistics requests', one: 'Logistics request', module: 'logistics', prefix: 'LOG', idLabel: 'Logistics request ID',
    statuses: ['Requested', 'Scheduled', 'In Transit', 'Delivered', 'Cancelled'],
    fields: [
      f('materialRef', 'Material reference (MR / PO / transfer)', 'text', { req: true, list: true }),
      f('itemId', 'Item', 'ref', { main: true }),
      f('pickupLocation', 'Pickup location', 'text', { req: true, list: true }),
      f('destination', 'Destination', 'text', { req: true, list: true }),
      f('transportMode', 'Transport mode', 'select', { opts: ['Road', 'Rail', 'Air', 'Courier', 'Hand carry'] }),
      f('transporter', 'Transporter'),
      f('vehicleDetails', 'Vehicle details'),
      f('assignedPersonId', 'Assigned person', 'user', { list: true }),
      f('pickupDate', 'Pickup date', 'date'),
      f('expectedDelivery', 'Expected delivery date', 'date', { list: true, main: true }),
      f('actualDelivery', 'Actual delivery date', 'date'),
      f('trackingDetails', 'Tracking details'),
      f('remarks', 'Remarks', 'textarea'),
      f('status', 'Status', 'select', { opts: ['Requested', 'Scheduled', 'In Transit', 'Delivered', 'Cancelled'], req: true, g: 'status', list: true }),
    ],
    perms: { create: any('logistics', 'create'), groups: { core: any('logistics', 'edit'), status: any('logistics', 'updateStatus', 'edit', 'create') } },
    softDelete: true,
  },

  travelDesk: {
    label: 'Travel requests', one: 'Travel request', module: 'travel', prefix: 'TRV', idLabel: 'Travel request ID',
    statuses: ['Requested', 'Booked', 'In Progress', 'Completed', 'Cancelled'],
    fields: [
      f('employeeId', 'Assigned employee', 'user', { req: true, list: true }),
      f('purpose', 'Travel purpose', 'textarea', { req: true, list: true }),
      f('origin', 'Origin', 'text', { req: true, list: true }),
      f('destination', 'Destination', 'text', { req: true, list: true }),
      f('travelDate', 'Travel date', 'date', { req: true, list: true }),
      f('returnDate', 'Return date', 'date'),
      f('transportArrangement', 'Transport arrangement'),
      f('accommodation', 'Accommodation'),
      f('bookingRefs', 'Booking references'),
      f('logisticsId', 'Linked logistics request', 'ref'),
      f('remarks', 'Remarks', 'textarea'),
      sys('approvalStatus', 'Approval status', 'text', { g: 'approval', list: true }),
      sys('approverId', 'Approver', 'user', { g: 'approval' }),
      sys('approverName', 'Approver name', 'text', { g: 'approval' }),
      sys('decisionAt', 'Decision date', 'ts', { g: 'approval' }),
      sys('approvalRemarks', 'Approval remarks', 'textarea', { g: 'approval' }),
      f('status', 'Status', 'select', { opts: ['Requested', 'Booked', 'In Progress', 'Completed', 'Cancelled'], req: true, g: 'status', list: true }),
    ],
    perms: {
      create: any('travel', 'create'),
      groups: { core: any('travel', 'edit'), approval: any('travel', 'approve'), status: any('travel', 'updateStatus', 'edit', 'create') },
    },
    init: { approvalStatus: ['Pending'] },
    softDelete: true,
  },

  /* ------------------------------------------------------------------ gate passes */
  gatePasses: {
    label: 'Gate passes', one: 'Gate pass', module: 'gatepass', prefix: 'GP', idLabel: 'Gate pass number',
    statuses: ['Pending Approval', 'Approved', 'Rejected', 'Issued', 'Partially Returned', 'Returned – Pending Closure', 'Closed', 'Cancelled'],
    fields: [
      f('type', 'Type', 'select', { opts: ['RGP', 'NRGP'], req: true, list: true }),
      f('itemId', 'Item', 'ref', { main: true }),
      sys('itemCode', 'Item code', 'text', { list: true }),
      sys('itemName', 'Item name', 'text', { list: true }),
      f('qty', 'Quantity', 'number', { req: true, list: true, positive: true }),
      f('serialNumbers', 'Serial numbers', 'textarea'),
      f('destination', 'Destination', 'text', { req: true, list: true }),
      f('purpose', 'Purpose', 'textarea', { req: true }),
      f('issueDate', 'Issue date', 'date', { req: true, list: true }),
      f('expectedReturn', 'Expected return date (RGP)', 'date', { list: true, main: true }),
      sys('generatedBy', 'Generated by', 'user'),
      f('remarks', 'Remarks', 'textarea'),
      sys('status', 'Status', 'text', { g: 'status', list: true }),
      ...approvalFields(),
      sys('returnedQty', 'Returned quantity', 'number', { g: 'ret', list: true }),
      sys('actualReturn', 'Actual return date', 'date', { g: 'ret' }),
      sys('inspectionRemarks', 'Inspection remarks', 'textarea', { g: 'close' }),
      sys('closedBy', 'Closed by', 'user', { g: 'close' }),
      sys('closedAt', 'Closed on', 'ts', { g: 'close' }),
    ],
    perms: {
      create: any('gatepass', 'create'),
      groups: {
        core: any('gatepass', 'edit'),
        status: any('gatepass', 'updateStatus', 'edit', 'approve', 'create'),
        approval: any('gatepass', 'approve'),
        ret: any('gatepass', 'updateStatus', 'edit', 'create'),
        close: any('gatepass', 'approve'),
      },
    },
  },

  gatePassReturns: {
    label: 'Gate pass returns', one: 'Return entry', module: 'gatepass', prefix: 'RET', idLabel: 'Return ref',
    fields: [
      sys('gatePassId', 'Gate pass number', 'text', { list: true }),
      f('returnDate', 'Return date', 'date', { req: true, list: true }),
      f('qty', 'Returned quantity', 'number', { req: true, list: true, positive: true, frozen: true }),
      f('condition', 'Condition on return', 'text', { list: true }),
      f('remarks', 'Remarks', 'textarea'),
    ],
    perms: { create: any('gatepass', 'updateStatus', 'edit', 'create'), groups: { core: [] } },
  },

  /* ------------------------------------------------------------------ development & testing */
  development: {
    label: 'Development', one: 'Development record', module: 'development', keyIsItem: true,
    statuses: ['Not Started', 'In Progress', 'Blocked', 'Under Review', 'Completed', 'Reopened'],
    fields: [
      ...itemRef(),
      f('team', 'Assigned development team', 'text', { list: true }),
      f('engineerId', 'Assigned engineer', 'user', { list: true }),
      f('startDate', 'Development start date', 'date'),
      f('expectedCompletion', 'Expected completion date', 'date', { list: true }),
      f('actualCompletion', 'Actual completion date', 'date'),
      f('workDescription', 'Work description', 'textarea'),
      f('technicalRemarks', 'Technical remarks', 'textarea'),
      f('issues', 'Issues', 'textarea'),
      f('revision', 'Revision number', 'number'),
      sys('status', 'Development status', 'text', { g: 'status', list: true }),
      sys('reopenCount', 'Times reopened', 'number', { g: 'reopen' }),
      sys('lastFailedTestId', 'Reopened by test cycle', 'text', { g: 'reopen' }),
    ],
    perms: {
      create: any('development', 'create'),
      groups: {
        core: any('development', 'edit'),
        status: [...any('development', 'updateStatus', 'edit', 'create'), ...any('testing', 'create', 'edit', 'updateStatus')],
        reopen: [...any('testing', 'create', 'edit', 'updateStatus'), ...any('development', 'edit')],
      },
    },
  },

  developmentUpdates: {
    label: 'Development updates', one: 'Development update', module: 'development', prefix: 'UPD', idLabel: 'Update ref',
    fields: [
      ...itemRef(),
      f('date', 'Date', 'date', { req: true, list: true }),
      sys('status', 'Status at update', 'text', { list: true }),
      sys('revision', 'Revision', 'number', { list: true }),
      f('note', 'Work done', 'textarea', { req: true, list: true }),
      f('issues', 'Issues', 'textarea'),
    ],
    perms: { create: any('development', 'create', 'edit', 'updateStatus'), groups: { core: [] } },
  },

  testing: {
    label: 'Test cycles', one: 'Test cycle', module: 'testing', prefix: 'TC', idLabel: 'Test cycle ref',
    statuses: ['Not Started', 'In Progress', 'Passed', 'Failed', 'Retest Required', 'Approved'],
    fields: [
      ...itemRef(),
      sys('cycle', 'Test cycle number', 'number', { list: true }),
      f('testPlan', 'Test plan', 'textarea', { req: true }),
      f('testDate', 'Test date', 'date', { list: true }),
      f('engineerId', 'Test engineer', 'user', { list: true }),
      f('environment', 'Test environment'),
      sys('result', 'Test result', 'textarea'),
      sys('observations', 'Observations', 'textarea'),
      sys('issues', 'Issues', 'textarea'),
      sys('status', 'Test status', 'text', { g: 'status', list: true }),
      sys('approverId', 'Approved by', 'user', { g: 'approval' }),
      sys('approverName', 'Approved by', 'text', { g: 'approval' }),
      sys('decisionAt', 'Approved on', 'ts', { g: 'approval' }),
    ],
    perms: {
      create: any('testing', 'create'),
      groups: { core: any('testing', 'edit', 'updateStatus'), status: any('testing', 'updateStatus', 'edit', 'create', 'approve'), approval: any('testing', 'approve') },
    },
  },

  /* ------------------------------------------------------------------ closure */
  closures: {
    label: 'Project closure records', one: 'Closure record', module: 'closure', fixedIds: ['completion', 'cancellation', 'reopen'],
    fields: [
      sys('kind', 'Kind', 'text'),
      ...['c_development', 'c_testing', 'c_material', 'c_procurement', 'c_payments', 'c_rgp', 'c_nrgp', 'c_documents', 'c_approval'].map((k) => sys(k, k, 'bool')),
      sys('unresolved', 'Unresolved checks', 'textarea'),
      sys('override', 'Override used', 'bool'),
      f('overrideReason', 'Override reason', 'textarea'),
      f('completionDate', 'Final completion date', 'date'),
      sys('approvedBy', 'Final approval by', 'user'),
      sys('approvedByName', 'Final approval by', 'text'),
      f('finalRemarks', 'Final remarks', 'textarea'),
      f('reason', 'Cancellation reason', 'textarea'),
      f('cancellationDate', 'Cancellation date', 'date'),
      f('materialStatus', 'Material status', 'textarea'),
      f('stockReturnStatus', 'Stock return / disposal status', 'textarea'),
      f('procurementCancellationStatus', 'Procurement cancellation status', 'textarea'),
      f('vendorCommitments', 'Vendor commitments', 'textarea'),
      f('paymentSettlementStatus', 'Payment settlement status', 'textarea'),
      f('outstandingLiabilities', 'Outstanding financial liabilities', 'money'),
      f('gatePassStatus', 'RGP / NRGP status', 'textarea'),
      sys('previousStatus', 'Previous project status', 'text'),
    ],
    perms: { create: any('closure', 'approve'), groups: { core: any('closure', 'approve') } },
  },

  /* ------------------------------------------------------------------ workflow stages */
  stages: {
    label: 'Workflow stages', one: 'Workflow stage', module: 'stages', special: 'stage',
    fields: [
      sys('itemId', 'Item', 'text'),
      sys('branch', 'Branch', 'text'),
      sys('key', 'Stage key', 'text'),
      sys('name', 'Stage name', 'text'),
      sys('module', 'Module', 'text'),
      sys('seq', 'Sequence', 'number'),
      f('deptId', 'Responsible department', 'dept', { g: 'plan' }),
      f('personId', 'Responsible person', 'user', { g: 'plan' }),
      f('expStart', 'Expected start date', 'date', { g: 'plan' }),
      f('expEnd', 'Expected completion date', 'date', { g: 'plan' }),
      f('remarks', 'Remarks', 'textarea', { g: 'plan' }),
      f('status', 'Status', 'select', { g: 'status' }),
      f('actStart', 'Actual start date', 'date', { g: 'status' }),
      f('actEnd', 'Actual completion date', 'date', { g: 'status' }),
    ],
    perms: {
      create: [...any('inventory', 'create', 'edit'), ...any('procurement', 'create', 'approve'), ...any('items', 'create', 'edit')],
      groups: { core: [], plan: [], status: [] }, // update rights are resolved from the stage's own module (see rules generator)
    },
    openCreate: ['plan', 'status'], // planning and status fields may be filled when the stage is created
  },
};

/** Project-scoped collections (stored as /{collection}/{projectId}/{recordId}). */
export const SCOPED = Object.keys(ENTITIES).filter((k) => !ENTITIES[k].global);
/** Fields the data layer adds to every record. */
export const META_FIELDS = ['createdAt', 'createdBy', 'updatedAt', 'updatedBy', '_v', '_log', 'deleted'];

export const fieldsOf = (coll) => ENTITIES[coll].fields;
export const fieldOf = (coll, name) => ENTITIES[coll].fields.find((x) => x.name === name);
export const formFields = (coll, names) => {
  const all = ENTITIES[coll].fields;
  return names ? names.map((n) => all.find((x) => x.name === n)).filter(Boolean) : all.filter((x) => !x.sys);
};

/* ---------------------------------------------------------------------------------------
 * Storage shape. Records are stored with their fields grouped by permission group:
 *   /purchaseRequests/{projectId}/{prNumber} = { core:{…}, status:{…}, approval:{…}, meta:{…} }
 * so the security rules can say "only an approver may write the approval group" without
 * comparing every field. The application always works with flat records; these two
 * helpers convert between the shapes.
 * ------------------------------------------------------------------------------------- */
export const groupOf = (coll, field) => {
  if (META_FIELDS.includes(field)) return field === 'deleted' ? 'del' : 'meta';
  const fd = ENTITIES[coll].fields.find((x) => x.name === field);
  if (!fd) throw new Error(`Unknown field ${coll}.${field}`);
  return fd.g;
};
export const fieldPath = (coll, field) => `${groupOf(coll, field)}/${field}`;
export function nest(coll, flat) {
  const out = {};
  for (const [k, v] of Object.entries(flat)) {
    if (v === undefined || v === null || v === '') continue;
    (out[groupOf(coll, k)] ||= {})[k] = v;
  }
  return out;
}
export function flatten(nested) {
  const out = {};
  if (nested && typeof nested === 'object') for (const g of Object.values(nested)) if (g && typeof g === 'object') Object.assign(out, g);
  return out;
}
