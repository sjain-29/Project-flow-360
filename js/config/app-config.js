/**
 * PROJECTFLOW 360 — application constants.
 *
 * Everything here is configuration, not operational data: module list, actions,
 * default departments, default roles, workflow stage templates and default
 * settings. The Super Admin can change roles, departments and settings at run
 * time; these values are only the starting point written when the system is
 * first initialised.
 */

export const APP = {
  name: 'ProjectFlow 360',
  tagline: 'Project material and development tracker',
  version: '1.0.0',
  /** Firebase JS SDK version loaded from Google's CDN in Firebase mode. */
  firebaseSdkVersion: '13.3.0',
  /** Epsilon used when comparing quantities / money. */
  eps: 0.001,
};

/** Standard permission actions (columns of the permission matrix). */
export const ACTIONS = [
  ['view', 'View'],
  ['create', 'Create'],
  ['edit', 'Edit'],
  ['delete', 'Delete'],
  ['comment', 'Comment'],
  ['updateStatus', 'Update status'],
  ['upload', 'Upload attachments'],
  ['approve', 'Approve'],
  ['export', 'Export'],
];
export const ACTION_IDS = ACTIONS.map((a) => a[0]);

/**
 * Application modules (rows of the permission matrix).
 *  depts        — default owning departments (used for department-restricted roles)
 *  restrictView — financial module: even "view" needs the owning department
 *  actions      — if present, the only actions that make sense for this module
 */
export const MODULES = [
  { id: 'projects', label: 'Projects', depts: ['project_management'] },
  { id: 'items', label: 'Project items (BOM)', depts: ['project_management', 'planning'] },
  { id: 'inventory', label: 'Inventory and availability', depts: ['stores'] },
  { id: 'transfers', label: 'Stock transfers', depts: ['stores'] },
  { id: 'procurement', label: 'Procurement requirements', depts: ['planning'] },
  { id: 'pr', label: 'Purchase requests', depts: ['planning'] },
  { id: 'quotations', label: 'Vendor quotations', depts: ['sourcing'] },
  { id: 'po', label: 'Purchase orders', depts: ['sourcing'] },
  { id: 'pi', label: 'Proforma invoices', depts: ['sourcing'] },
  { id: 'payments', label: 'Payments', depts: ['accounts'], restrictView: true },
  { id: 'dispatch', label: 'Vendor dispatch', depts: ['sourcing'] },
  { id: 'receipts', label: 'SPIF receipts (GRN)', depts: ['stores'] },
  { id: 'mr', label: 'Material requests', depts: ['stores'] },
  { id: 'gvt', label: 'GVT receipts', depts: ['stores'] },
  { id: 'logistics', label: 'Logistics', depts: ['logistics'] },
  { id: 'travel', label: 'Travel desk', depts: ['travel_desk'] },
  { id: 'gatepass', label: 'Gate passes (RGP/NRGP)', depts: ['planning'] },
  { id: 'development', label: 'Development', depts: ['development'] },
  { id: 'testing', label: 'Testing', depts: ['testing'] },
  { id: 'closure', label: 'Project closure', depts: ['project_management'] },
  { id: 'expenditure', label: 'Project expenditure', depts: ['accounts', 'project_management'], restrictView: true, actions: ['view', 'export'] },
  { id: 'reports', label: 'Reports', depts: [], actions: ['view', 'export'] },
  { id: 'activity', label: 'Project activity history', depts: [], actions: ['view', 'export'] },
  {
    id: 'comments', label: 'Comments', depts: [],
    actions: ['view', 'create', 'edit', 'delete', 'viewAll'],
    actionLabels: { view: 'View comments', create: 'Add comments', edit: 'Edit own', delete: 'Delete own', viewAll: 'View all departments' },
  },
];
export const MODULE_BY_ID = Object.fromEntries(MODULES.map((m) => [m.id, m]));
export const moduleActions = (m) => m.actions || ACTION_IDS;

/** Default departments (the Super Admin can add, rename and deactivate). */
export const DEFAULT_DEPARTMENTS = [
  ['project_management', 'Project Management'],
  ['planning', 'Planning'],
  ['sourcing', 'Sourcing'],
  ['accounts', 'Accounts'],
  ['stores', 'Stores'],
  ['logistics', 'Logistics'],
  ['travel_desk', 'Travel Desk'],
  ['development', 'Development'],
  ['testing', 'Testing'],
  ['administration', 'Administration'],
];

const FINANCIAL = ['quotations', 'po', 'pi', 'payments', 'expenditure'];
const grant = (filter, acts) => {
  const out = {};
  for (const m of MODULES) {
    if (filter && !filter(m)) continue;
    const allowed = moduleActions(m).filter((a) => acts.includes(a));
    if (allowed.length) out[m.id] = Object.fromEntries(allowed.map((a) => [a, true]));
  }
  return out;
};
const merge = (...objs) => {
  const out = {};
  for (const o of objs) for (const [m, acts] of Object.entries(o)) out[m] = { ...(out[m] || {}), ...acts };
  return out;
};
const only = (ids) => (m) => ids.includes(m.id);

/**
 * Default roles. `deptRestricted` roles can only create / edit / approve in
 * modules owned by one of the user's departments (view is not restricted,
 * except for financial modules).
 */
export function defaultRoles() {
  return {
    super_admin: {
      name: 'Super Admin', system: true, deptRestricted: false, dashboard: 'org',
      description: 'Complete access, including user management and administration.',
      permissions: grant(null, [...ACTION_IDS, 'viewAll']),
    },
    project_manager: {
      name: 'Project Manager', system: true, deptRestricted: false, dashboard: 'pm',
      description: 'Oversees assigned projects: creates projects and items, approves requests, closes projects.',
      permissions: merge(
        grant((m) => m.id !== 'comments', ['view', 'comment', 'export']),
        grant(only(['projects', 'items', 'closure']), ['create', 'edit', 'updateStatus', 'upload']),
        grant(only(['procurement', 'pr', 'transfers', 'mr', 'travel', 'gatepass', 'closure']), ['approve']),
        grant(only(['comments']), ['view', 'create', 'edit', 'delete', 'viewAll']),
      ),
    },
    department_head: {
      name: 'Department Head', system: true, deptRestricted: true, dashboard: 'dept',
      description: 'Full control of the modules owned by their department, including approvals.',
      permissions: merge(
        grant((m) => m.id !== 'comments', ['view', 'create', 'edit', 'comment', 'updateStatus', 'upload', 'approve', 'export']),
        grant(only(['comments']), ['view', 'create', 'edit', 'delete', 'viewAll']),
      ),
    },
    department_user: {
      name: 'Department User', system: true, deptRestricted: true, dashboard: 'user',
      description: 'Creates and updates records in the modules owned by their department. Cannot approve or delete.',
      permissions: merge(
        grant((m) => m.id !== 'comments', ['view', 'create', 'edit', 'comment', 'updateStatus', 'upload', 'export']),
        grant(only(['comments']), ['view', 'create', 'edit', 'delete']),
      ),
    },
    viewer: {
      name: 'Viewer', system: true, deptRestricted: false, dashboard: 'viewer',
      description: 'Read-only access to non-financial information of assigned projects.',
      permissions: merge(
        grant((m) => !FINANCIAL.includes(m.id) && m.id !== 'comments', ['view']),
        grant(only(['comments']), ['view']),
      ),
    },
  };
}

/** Workflow stage statuses (always changed by a person, never by a date). */
export const STAGE_STATUSES = ['Not Started', 'In Progress', 'Waiting for Approval', 'On Hold', 'Blocked', 'Completed', 'Cancelled'];

/**
 * Workflow stage templates.
 *  branch A = project material fulfilment, branch B = source stock replenishment.
 *  path: always | transfer (in-house stock used) | proc (project procurement needed)
 *  group: used for the "procurement / material / development / testing" progress bars
 *  w: default weight in the progress calculation (editable in Settings)
 */
export const STAGE_TEMPLATES = [
  { key: 'availability', branch: 'A', name: 'In-house availability check', module: 'inventory', dept: 'stores', path: 'always', group: 'material', w: 5 },
  { key: 'transfer', branch: 'A', name: 'Stock transfer', module: 'transfers', dept: 'stores', path: 'transfer', group: 'material', w: 8 },
  { key: 'projReceipt', branch: 'A', name: 'Project receipt of transferred stock', module: 'transfers', dept: 'stores', path: 'transfer', group: 'material', w: 7 },
  { key: 'pr', branch: 'A', name: 'Purchase request', module: 'pr', dept: 'planning', path: 'proc', group: 'procurement', w: 4 },
  { key: 'prApproval', branch: 'A', name: 'PR approval', module: 'pr', dept: 'planning', path: 'proc', group: 'procurement', w: 4 },
  { key: 'quotation', branch: 'A', name: 'Vendor quotations', module: 'quotations', dept: 'sourcing', path: 'proc', group: 'procurement', w: 5 },
  { key: 'po', branch: 'A', name: 'Purchase order', module: 'po', dept: 'sourcing', path: 'proc', group: 'procurement', w: 5 },
  { key: 'pi', branch: 'A', name: 'Proforma invoice', module: 'pi', dept: 'sourcing', path: 'proc', group: 'procurement', w: 3 },
  { key: 'payment', branch: 'A', name: 'Payment', module: 'payments', dept: 'accounts', path: 'proc', group: 'procurement', w: 4 },
  { key: 'dispatch', branch: 'A', name: 'Vendor dispatch', module: 'dispatch', dept: 'sourcing', path: 'proc', group: 'procurement', w: 5 },
  { key: 'spifReceipt', branch: 'A', name: 'Material receipt at SPIF', module: 'receipts', dept: 'stores', path: 'proc', group: 'material', w: 7 },
  { key: 'mr', branch: 'A', name: 'Material request SPIF to GVT', module: 'mr', dept: 'stores', path: 'proc', group: 'material', w: 4 },
  { key: 'logistics', branch: 'A', name: 'Logistics', module: 'logistics', dept: 'logistics', path: 'proc', group: 'material', w: 4 },
  { key: 'gvtReceipt', branch: 'A', name: 'Material receipt at GVT', module: 'gvt', dept: 'stores', path: 'proc', group: 'material', w: 5 },
  { key: 'development', branch: 'A', name: 'Development', module: 'development', dept: 'development', path: 'always', group: 'development', w: 15 },
  { key: 'testing', branch: 'A', name: 'Testing', module: 'testing', dept: 'testing', path: 'always', group: 'testing', w: 12 },
  { key: 'closure', branch: 'A', name: 'Item closure', module: 'closure', dept: 'project_management', path: 'always', group: 'closure', w: 3 },
  { key: 'pr', branch: 'B', name: 'Replenishment PR', module: 'pr', dept: 'planning', path: 'transfer', group: 'replenishment', w: 1 },
  { key: 'prApproval', branch: 'B', name: 'PR approval', module: 'pr', dept: 'planning', path: 'transfer', group: 'replenishment', w: 1 },
  { key: 'quotation', branch: 'B', name: 'Vendor quotations', module: 'quotations', dept: 'sourcing', path: 'transfer', group: 'replenishment', w: 1 },
  { key: 'po', branch: 'B', name: 'Purchase order', module: 'po', dept: 'sourcing', path: 'transfer', group: 'replenishment', w: 1 },
  { key: 'pi', branch: 'B', name: 'Proforma invoice', module: 'pi', dept: 'sourcing', path: 'transfer', group: 'replenishment', w: 1 },
  { key: 'payment', branch: 'B', name: 'Payment', module: 'payments', dept: 'accounts', path: 'transfer', group: 'replenishment', w: 1 },
  { key: 'dispatch', branch: 'B', name: 'Vendor dispatch', module: 'dispatch', dept: 'sourcing', path: 'transfer', group: 'replenishment', w: 1 },
  { key: 'spifReceipt', branch: 'B', name: 'Source department receipt', module: 'receipts', dept: 'stores', path: 'transfer', group: 'replenishment', w: 1 },
];
export const stageId = (itemId, branch, key) => `${itemId}__${branch}_${key}`;
export const stageTemplate = (branch, key) => STAGE_TEMPLATES.find((t) => t.branch === branch && t.key === key);

/** Default settings written at initialisation (editable by the Super Admin). */
export function defaultSettings() {
  return {
    orgName: 'My Organisation',
    currency: 'INR',
    sessionIdleMinutes: 30,
    sessionMaxHours: 12,
    transferApprovalRequired: true,
    allowSelfApproval: false,
    dueSoonDays: 3,
    upcomingDays: 7,
    rgpReminderDays: 3,
    maxInlineFileKb: 500,
    projectCategories: ['Drone platform', 'Payload', 'Avionics', 'Propulsion', 'Ground systems', 'Software', 'R&D study', 'Other'],
    units: ['Nos', 'Set', 'Kg', 'g', 'm', 'mm', 'L', 'Pair', 'Box', 'Roll'],
    paymentModes: ['NEFT', 'RTGS', 'IMPS', 'UPI', 'Cheque', 'Card', 'Cash', 'Other'],
    /** Project health rules: thresholds are compared against live counts. */
    health: {
      redOverdueCritical: 1,      // overdue activities on Critical/High priority items
      redOverdueDays: 14,         // any activity overdue by this many days
      redTestFailures: 2,         // items with an unresolved failed test
      amberOverdue: 1,            // any overdue activity
      amberPendingApprovalDays: 3,// approvals waiting longer than this
      amberUncoveredItems: 1,     // items with uncovered material shortage
      amberRgpOverdue: 1,         // overdue returnable gate passes
    },
    /** Progress score of a stage by status (0–1). */
    stageScores: { 'Not Started': 0, 'In Progress': 0.5, 'Waiting for Approval': 0.5, 'On Hold': 0.25, Blocked: 0.25, Completed: 1 },
    /** Stage weights by key; missing keys fall back to the template weight. */
    stageWeights: {},
    /** Module → owning departments override; missing modules use the defaults. */
    moduleDepartments: {},
  };
}

/** Username rules (usernames become Firebase Auth e-mail addresses internally). */
export const USERNAME_RE = /^[a-z][a-z0-9_-]{1,31}$/;
export const PASSWORD_MIN = 8;

/** Allowed attachment types. */
export const FILE_TYPES = {
  'application/pdf': 'PDF',
  'application/vnd.ms-excel': 'Excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
  'text/csv': 'CSV',
  'image/png': 'Image',
  'image/jpeg': 'Image',
  'image/webp': 'Image',
  'application/msword': 'Word',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'text/plain': 'Text',
};
export const DOC_CATEGORIES = ['Technical document', 'Quotation', 'Invoice', 'Purchase order', 'Challan', 'GRN', 'Test report', 'Payment proof', 'Gate pass', 'Completion report', 'Other'];
