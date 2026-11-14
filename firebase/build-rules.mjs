/**
 * PROJECTFLOW 360 — Firebase Realtime Database Security Rules generator.
 *
 * Run:  node firebase/build-rules.mjs
 * Writes:
 *   firebase/database.rules.json     → paste / deploy this to Firebase
 *   js/config/rules.generated.js     → the same rules, used by demo mode and tests
 *
 * The rules are generated from the record definitions in js/config/entities.js so
 * that the forms, the data layer and the backend rules can never drift apart.
 *
 * SECURITY MODEL (no Cloud Functions — the rules ARE the trusted backend)
 *   /acl/{authUid}   effective permissions of a signed-in account. Written only by the
 *                    Super Admin. Exists only for ACTIVE users, so deactivating a user
 *                    removes every permission immediately, even for open sessions.
 *   Project records live under /{collection}/{projectId}/{recordId}; access to the
 *   project is checked on every read and every write (no access by guessing an ID).
 *   Inside a record, fields are grouped by the permission needed to change them
 *   (core / status / approval / …); each group has its own write rule.
 *   Every record write must carry the writer's user ID and the server time, increase the
 *   record version by exactly 1 (no lost updates, no duplicates) and point to an
 *   append-only activity log entry created in the same atomic write.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ENTITIES, fieldPath } from '../js/config/entities.js';

const here = dirname(fileURLToPath(import.meta.url));
const EPS = 0.001;

/* ---------------------------------------------------------------- expression helpers */
// Paths are written as 'acl/' + auth.uid + '/…' to keep the file well under Firebase's 256 KiB limit.
const acl = (sub) => `root.child('acl/' + auth.uid + '/${sub}')`;
const ACLD = (deptExpr) => `root.child('acl/' + auth.uid + '/d/' + ${deptExpr}).val() === true`;
const ME = `${acl('userId')}.val()`;
const ACTIVE = `${acl('userId')}.isString()`;
const SA = `${acl('sa')}.val() === true`;
const BOOT = "(!root.child('system/initialized').exists() && root.child('system/bootstrapUid').val() === auth.uid)";
const SA_OR_BOOT = `(${SA} || ${BOOT})`;
const P = (perm) => `${acl('p/' + perm.replace('.', '/'))}.val() === true`;
const PDYN = (modExpr, a) => `root.child('acl/' + auth.uid + '/p/' + ${modExpr} + '/${a}').val() === true`;
const ANY = (perms) => (perms && perms.length ? (perms.length === 1 ? P(perms[0]) : `(${perms.map(P).join(' || ')})`) : 'false');
const SCOPE_ALL = `${acl('scope')}.val() === 'all'`;
/** Project-level access (pre-write state). `creating` also admits the creator of a brand-new project. */
const ACCESS = (pid = '$pid', creating = false) => `(${SCOPE_ALL} || root.child('acl/' + auth.uid + '/prj/' + ${pid}).val() === true`
  + (creating ? ` || (!root.child('projects/' + ${pid}).exists() && ${P('projects.create')})` : '')
  + ` || root.child('projects/' + ${pid} + '/core/managerId').val() === ${ME}`
  + ` || (${acl('scope')}.val() === 'dept' && ${ACLD(`root.child('projects/' + ${pid} + '/core/departmentId').val()`)}))`;

const and = (...xs) => xs.filter(Boolean).map((x) => `(${x})`).join(' && ');
const or = (...xs) => `(${xs.filter(Boolean).map((x) => `(${x})`).join(' || ')})`;
const isIn = (expr, values) => `(${values.map((v) => `${expr} === '${v}'`).join(' || ')})`;
const near0 = (expr) => `((${expr}) < ${EPS} && (${expr}) > -${EPS})`;
const ROOT_AFTER = (depth) => 'newData' + '.parent()'.repeat(depth);
/** Value of a field of another record of the same project, before / after this write. */
const BEFORE = (coll, idExpr, field) => `root.child('${coll}/' + $pid + '/' + ${idExpr} + '/${fieldPath(coll, field)}').val()`;
const AFTER = (coll, idExpr, field) => `${ROOT_AFTER(3)}.child('${coll}/' + $pid + '/' + ${idExpr} + '/${fieldPath(coll, field)}').val()`;
/** parent.field must change by exactly `expected` in the same atomic write. */
const delta = (coll, idExpr, field, expected) => near0(`${AFTER(coll, idExpr, field)} - ${BEFORE(coll, idExpr, field)} - (${expected})`);
const onCreate = (expr) => `(data.exists() ? 0 : ${expr})`;

/** Field accessors bound to one collection. */
function accessors(coll) {
  const nd = (f) => `newData.child('${fieldPath(coll, f)}')`;
  const od = (f) => `data.child('${fieldPath(coll, f)}')`;
  const nv = (f) => `${nd(f)}.val()`;
  const ov = (f) => `${od(f)}.val()`;
  const same = (f) => `(${nv(f)} === ${ov(f)})`;
  const st = (v) => `(${nv('status')} === '${v}')`;
  const wasSt = (v) => `(${ov('status')} === '${v}')`;
  /** status may only move to one of `values` with one of `perms` */
  const statusGuard = (values, perms) => or(same('status'), `!${isIn(nv('status'), values)}`, ANY(perms));
  return { nd, od, nv, ov, same, st, wasSt, statusGuard };
}

/* ---------------------------------------------------------------- field type checks */
function typeRule(fd) {
  switch (fd.type) {
    case 'number': case 'money':
      return `newData.isNumber()${fd.neg ? '' : (fd.positive ? ' && newData.val() > 0' : ' && newData.val() >= 0')}`;
    case 'ts': return 'newData.isNumber()';
    case 'bool': return 'newData.isBoolean()';
    case 'date': return 'newData.isString() && newData.val().length === 10';
    case 'textarea': return 'newData.isString() && newData.val().length < 5001';
    case 'url': return 'newData.isString() && newData.val().length < 1001';
    case 'text': return fd.sys ? 'newData.isString()' : `newData.isString() && newData.val().length < ${(fd.max || 300) + 1}`;
    default: return 'newData.isString()';
  }
}
const META_NODE = {
  '.write': 'auth != null', // values are fixed by the record-level validation below
  createdAt: { '.validate': 'newData.isNumber()' }, updatedAt: { '.validate': 'newData.isNumber()' },
  createdBy: { '.validate': 'newData.isString()' }, updatedBy: { '.validate': 'newData.isString()' },
  _v: { '.validate': 'newData.isNumber()' }, _log: { '.validate': 'newData.isString()' },
  $other: { '.validate': false },
};

/* ---------------------------------------------------------------- per-collection business rules */
const EXTRA = {
  inventoryChecks: ({ nv }) => [
    `${nv('transferQty')} <= ${nv('availableQty')} + ${EPS}`,
    near0(`${nv('transferQty')} + ${nv('shortageQty')} - ${nv('requiredQty')}`),
  ],

  stockTransfers: ({ nv, ov, same, st, wasSt, statusGuard }) => [
    // Business rule 7: a stock transfer cannot exist without its linked replenishment requirement.
    or('data.exists()', and(
      `${AFTER('procurement', nv('requirementId'), 'transferId')} === $id`,
      `${AFTER('procurement', nv('requirementId'), 'type')} === 'Source Stock Replenishment'`,
      near0(`${AFTER('procurement', nv('requirementId'), 'qty')} - ${nv('qty')}`),
      `${nv('qty')} > 0`,
    )),
    // Cancelling or adjusting a transfer never silently removes the requirement: it must go to review.
    or('!data.exists()', and(same('qty'), or(`!${st('Cancelled')}`, wasSt('Cancelled'))),
      isIn(AFTER('procurement', ov('requirementId'), 'status'), ['Under Review', 'Cancelled'])),
    or('!data.exists()', same('requirementId')),
    statusGuard(['Approved', 'Rejected'], ['transfers.approve']),
    `${nv('dispatchedQty')} <= ${nv('qty')} + ${EPS}`,
    `${nv('receivedQty')} <= ${nv('dispatchedQty')} + ${EPS}`,
    near0(`${nv('acceptedQty')} + ${nv('rejectedQty')} - ${nv('receivedQty')}`),
  ],

  procurement: ({ nv, same, st, wasSt }) => [
    or('data.exists()', and(
      isIn(nv('type'), ['Project Requirement', 'Source Stock Replenishment']),
      `${nv('qty')} > 0`,
      or(st('Open'), st('Pending Approval')),
      or(`${nv('origin')} !== 'Additional Material'`, st('Pending Approval'), P('procurement.approve')),
      or(`${nv('type')} !== 'Source Stock Replenishment'`, `${AFTER('stockTransfers', nv('transferId'), 'requirementId')} === $id`),
    )),
    or('!data.exists()', and(same('type'), same('transferId'), same('itemId'))),
    // Leaving review / approval states, or cancelling, needs the procurement approver.
    or('!data.exists()', same('status'), and(`!${wasSt('Under Review')}`, `!${wasSt('Pending Approval')}`, `!${st('Cancelled')}`, `!${st('Rejected')}`), P('procurement.approve')),
  ],

  purchaseRequests: ({ nv, same, st, wasSt, statusGuard }) => [
    or('data.exists()', and(
      `${BEFORE('procurement', nv('requirementId'), 'status')} === 'Open'`,
      `${AFTER('procurement', nv('requirementId'), 'prId')} === $id`,
      `${nv('qty')} > 0 && ${nv('qty')} <= ${BEFORE('procurement', nv('requirementId'), 'qty')} + ${EPS}`,
      st('Pending Approval'),
    )),
    // Business rule 2: only an authorised approver can approve, reject or request changes.
    statusGuard(['Approved', 'Rejected', 'Changes Requested'], ['pr.approve']),
    or('!data.exists()', `!${wasSt('Approved')}`, same('status'), P('pr.approve')),
    `${nv('orderedQty')} <= ${nv('qty')} + ${EPS}`,
  ],

  quotations: ({ nv, same }) => [
    // Business rule 1: no quotation before PR approval.
    or('data.exists()', `${BEFORE('purchaseRequests', nv('prId'), 'status')} === 'Approved'`),
    or('!data.exists()', same('prId')),
    or(`${nv('selected')} !== true`, `${AFTER('purchaseRequests', nv('prId'), 'selectedQuotationId')} === $id`),
  ],

  purchaseOrders: ({ nv, ov, same, st }) => {
    const counted = (v) => `(${v('status')} !== 'Cancelled' ? ${v('quantity')} : 0)`;
    return [
      or('data.exists()', and(
        `${BEFORE('purchaseRequests', nv('prId'), 'status')} === 'Approved'`,
        `${BEFORE('purchaseRequests', nv('prId'), 'selectedQuotationId')} === ${nv('quotationId')}`,
        st('Issued'),
      )),
      or('!data.exists()', and(same('prId'), same('quotationId'))),
      delta('purchaseRequests', nv('prId'), 'orderedQty', `${counted(nv)} - (data.exists() ? ${counted(ov)} : 0)`),
      // Payments can never exceed the authorised payable amount (PO value + recorded adjustments).
      `${nv('paidTotal')} <= ${nv('totalValue')} + ${nv('adjTotal')} + ${EPS}`,
      `${nv('dispatchedQty')} <= ${nv('quantity')} + ${EPS}`,
      `${nv('receivedQty')} <= ${nv('dispatchedQty')} + ${EPS}`,
      near0(`${nv('acceptedQty')} + ${nv('rejectedQty')} - ${nv('receivedQty')}`),
    ];
  },

  proformaInvoices: ({ nv, same }) => [
    or('data.exists()', `${BEFORE('purchaseOrders', nv('poId'), 'status')} !== null`),
    or('!data.exists()', same('poId')),
  ],

  payments: ({ nv, ov, same }) => {
    const counted = (v) => `(${v('status')} === 'Successful' ? ${v('amount')} : 0)`;
    return [
      or('!data.exists()', same('poId')),
      delta('purchaseOrders', nv('poId'), 'paidTotal', `${counted(nv)} - (data.exists() ? ${counted(ov)} : 0)`),
    ];
  },

  paymentAdjustments: ({ nv }) => [
    or('data.exists()', `${nv('reason')}.length >= 5`),
    delta('purchaseOrders', nv('poId'), 'adjTotal', onCreate(nv('amount'))),
  ],

  dispatches: ({ nv, same }) => [
    or('data.exists()', `${BEFORE('purchaseOrders', nv('poId'), 'status')} === 'Issued'`),
    or('!data.exists()', same('poId')),
    delta('purchaseOrders', nv('poId'), 'dispatchedQty', onCreate(nv('qty'))),
    `${nv('receivedQty')} <= ${nv('qty')} + ${EPS}`,
  ],

  materialReceipts: ({ nv, same }) => [
    or('!data.exists()', and(same('poId'), same('dispatchId'))),
    near0(`${nv('acceptedQty')} + ${nv('rejectedQty')} - ${nv('receivedQty')}`),
    delta('dispatches', nv('dispatchId'), 'receivedQty', onCreate(nv('receivedQty'))),
    delta('purchaseOrders', nv('poId'), 'receivedQty', onCreate(nv('receivedQty'))),
    delta('purchaseOrders', nv('poId'), 'acceptedQty', onCreate(nv('acceptedQty'))),
    delta('purchaseOrders', nv('poId'), 'rejectedQty', onCreate(nv('rejectedQty'))),
  ],

  materialRequests: ({ nv, statusGuard }) => [
    statusGuard(['Approved', 'Rejected'], ['mr.approve']),
    or(`${nv('dispatchedQty')} === 0`, `${nv('dispatchedQty')} <= ${nv('approvedQty')} + ${EPS}`),
    `${nv('receivedQty')} <= ${nv('dispatchedQty')} + ${EPS}`,
    near0(`${nv('acceptedQty')} + ${nv('rejectedQty')} - ${nv('receivedQty')}`),
  ],

  gvtReceipts: ({ nv, same }) => [
    or('!data.exists()', same('mrId')),
    near0(`${nv('acceptedQty')} + ${nv('rejectedQty')} - ${nv('receivedQty')}`),
    delta('materialRequests', nv('mrId'), 'receivedQty', onCreate(nv('receivedQty'))),
    delta('materialRequests', nv('mrId'), 'acceptedQty', onCreate(nv('acceptedQty'))),
    delta('materialRequests', nv('mrId'), 'rejectedQty', onCreate(nv('rejectedQty'))),
  ],

  gatePasses: ({ nv, same, st, wasSt, statusGuard }) => [
    or('data.exists()', st('Pending Approval')),
    statusGuard(['Approved', 'Rejected', 'Closed'], ['gatepass.approve']),
    // A pass can only be issued after approval; an RGP is only closed by an authorised person.
    or(same('status'), `!${st('Issued')}`, wasSt('Approved')),
    `${nv('returnedQty')} <= ${nv('qty')} + ${EPS}`,
    or('!data.exists()', same('type')),
  ],

  gatePassReturns: ({ nv }) => [
    or('data.exists()', and(
      `${BEFORE('gatePasses', nv('gatePassId'), 'type')} === 'RGP'`,
      isIn(BEFORE('gatePasses', nv('gatePassId'), 'status'), ['Issued', 'Partially Returned']),
    )),
    delta('gatePasses', nv('gatePassId'), 'returnedQty', onCreate(nv('qty'))),
  ],

  // Testing staff may only reopen development; every other status change is Development's.
  development: ({ same, st }) => [
    or('!data.exists()', same('status'), ANY(['development.updateStatus', 'development.edit', 'development.create']), st('Reopened')),
  ],

  testing: ({ nv, same, st, wasSt, statusGuard }) => [
    // A new test cycle can only start when development is ready.
    or('data.exists()', `${BEFORE('development', nv('itemId'), 'status')} === 'Completed'`),
    statusGuard(['Approved'], ['testing.approve']),
    or(same('status'), `!${st('Approved')}`, wasSt('Passed')),
  ],

  closures: ({ nv }) => [
    // Business rule 24: completion with unresolved checks needs a recorded override reason.
    or(`${nv('kind')} !== 'completion'`,
      ['c_development', 'c_testing', 'c_material', 'c_procurement', 'c_payments', 'c_rgp', 'c_nrgp', 'c_documents', 'c_approval'].map((k) => `${nv(k)} === true`).join(' && '),
      `${nv('override')} === true && ${nv('overrideReason')}.length >= 5`),
    `${nv('kind')} === $id`,
  ],
};

/** Extra conditions on a group's write rule (evaluated at the group node: data.parent() is the record). */
const FINAL_TEST = isIn("data.parent().child('status/status').val()", ['Failed', 'Retest Required', 'Approved']);
const GROUP_GUARD = {
  // An approved PR is frozen.
  purchaseRequests: { core: "data.parent().child('status/status').val() !== 'Approved'" },
  // Business rule 14: finished test cycles are never overwritten.
  testing: { core: `!${FINAL_TEST}`, status: `!${FINAL_TEST}`, approval: `!${FINAL_TEST}` },
};

/* ---------------------------------------------------------------- generic record rule */
function metaRule(depth, logPid) {
  const log = `${ROOT_AFTER(depth)}.child('activityLogs/' + ${logPid} + '/' + newData.child('meta/_log').val())`;
  const n = (f) => `newData.child('meta/${f}').val()`;
  const o = (f) => `data.child('meta/${f}').val()`;
  return and(
    `${n('updatedAt')} === now && ${n('updatedBy')} === ${ME}`,
    `${n('_v')} === (data.exists() ? ${o('_v')} + 1 : 1)`,
    `data.exists() ? (${n('createdAt')} === ${o('createdAt')} && ${n('createdBy')} === ${o('createdBy')}) : (${n('createdAt')} === now && ${n('createdBy')} === ${ME})`,
    `${log}.child('at').val() === now && ${log}.child('rid').val() === $id`,
  );
}

function groupsOf(e) {
  const groups = {};
  for (const fd of e.fields) (groups[fd.g] ||= []).push(fd);
  return groups;
}

function recordRule(coll, e, { depth, logPid, access, groupWrite }) {
  const x = accessors(coll);
  const groups = groupsOf(e);
  const createParts = [ANY(e.perms.create)];
  const reqParts = [];
  const node = {};
  for (const [g, fds] of Object.entries(groups)) {
    const perms = e.perms.groups[g] || [];
    if (g !== 'core') {
      // On creation, protected fields must be empty / zero unless the creator holds that permission too.
      // (numbers start at exactly 0, a status starts at its defined first value, everything else is absent)
      const initOk = (fd) => (e.init?.[fd.name] ? isIn(x.nv(fd.name), e.init[fd.name])
        : (fd.type === 'number' || fd.type === 'money') ? `${x.nv(fd.name)} === 0` : `!${x.nd(fd.name)}.exists()`);
      if (!(e.openCreate || []).includes(g)) createParts.push(or(fds.map(initOk).join(' && '), ANY(perms)));
    }
    const req = fds.filter((fd) => fd.req && !fd.sys).map((fd) => `'${fd.name}'`);
    if (req.length) reqParts.push(`newData.child('${g}').hasChildren([${req.join(', ')}])`);
    const gnode = {};
    const write = groupWrite ? groupWrite(g) : (perms.length ? and(ANY(perms), GROUP_GUARD[coll]?.[g]) : null);
    if (write) gnode['.write'] = write;
    for (const fd of fds) {
      // application-set text needs no type rule (the key just has to be on the allow-list)
      const plainSys = fd.sys && !['number', 'money', 'bool', 'ts'].includes(fd.type);
      gnode[fd.name] = plainSys ? {} : { '.validate': typeRule(fd) + (fd.frozen ? ' && (!data.exists() || newData.val() === data.val())' : '') };
    }
    gnode.$other = { '.validate': false };
    node[g] = gnode;
  }
  node.meta = META_NODE;
  if (e.softDelete) {
    node.del = { '.write': P(`${e.module}.delete`), deleted: { '.validate': 'newData.isBoolean()' }, $other: { '.validate': false } };
    createParts.push("!newData.child('del').exists()");
  }
  node.$other = { '.validate': false };
  node['.validate'] = and(
    access,
    metaRule(depth, logPid),
    ...reqParts,
    or('data.exists()', and(...createParts)),
    ...(EXTRA[coll] ? EXTRA[coll](x) : []),
  );
  return node;
}

/* ---------------------------------------------------------------- assemble the tree */
const str = (max) => ({ '.validate': `newData.isString() && newData.val().length < ${max + 1}` });
const rules = {
  '.read': SA, // full export for backups

  system: {
    '.read': 'auth != null',
    initialized: { '.write': `auth != null && !data.exists() && ${BOOT}`, '.validate': 'newData.val() === true' },
  },

  acl: {
    $uid: {
      '.read': `auth != null && (auth.uid === $uid || ${SA})`,
      '.write': `auth != null && (${SA} || (${BOOT} && $uid === auth.uid))`,
      '.validate': "newData.child('userId').isString() && newData.child('scope').isString()",
    },
  },

  users: {
    '.read': ACTIVE,
    $userId: {
      '.write': SA_OR_BOOT,
      '.validate': "newData.hasChildren(['username', 'displayName', 'roleId'])",
      lastLoginAt: { '.write': `${ME} === $userId`, '.validate': 'newData.val() === now' },
      lastLogoutAt: { '.write': `${ME} === $userId`, '.validate': 'newData.val() === now' },
      mustChangePassword: { '.write': `${ME} === $userId && newData.val() === false` },
      passwordChangedAt: { '.write': `${ME} === $userId`, '.validate': 'newData.val() === now' },
      prefs: { '.write': `${ME} === $userId` },
    },
  },

  loginIndex: {
    '.read': SA,
    $username: {
      '.read': true, // lets the login page turn a username into its sign-in address; cannot be listed
      '.write': SA_OR_BOOT,
      '.validate': "newData.child('v').isNumber() && newData.child('userId').isString()",
      failed: {
        '.write': "data.parent().child('v').exists()",
        '.validate': `newData.isNumber() && (newData.val() === (data.exists() ? data.val() : 0) + 1 || (newData.val() === 0 && ${ME} === data.parent().child('userId').val()))`,
      },
      lastFailedAt: { '.write': "data.parent().child('v').exists()", '.validate': 'newData.val() === now' },
      resetRequestedAt: { '.write': "data.parent().child('v').exists() && newData.exists()", '.validate': 'newData.val() === now' },
    },
  },

  roles: { '.read': ACTIVE, '.write': SA_OR_BOOT },
  departments: { '.read': ACTIVE, '.write': SA_OR_BOOT },
  settings: { '.read': ACTIVE, '.write': SA_OR_BOOT },

  // Discovery hints only ("which projects might I be able to open?"). Access itself is always
  // decided by the rules on the data, so a wrong entry here gives nobody any access.
  projectIndex: {
    byManager: { $userId: { '.read': `${ME} === $userId`, $pid: { '.write': `${P('projects.create')} || ${P('projects.edit')}`, '.validate': 'newData.isBoolean()' } } },
    byDept: { $deptId: { '.read': ACLD('$deptId'), $pid: { '.write': `${P('projects.create')} || ${P('projects.edit')}`, '.validate': 'newData.isBoolean()' } } },
  },

  counters: {
    $pid: {
      '.read': `${ACTIVE} && ($pid === '_global' || ${ACCESS('$pid')})`,
      $key: {
        '.write': `${ACTIVE} && ($pid === '_global' || ${ACCESS('$pid', true)})`,
        '.validate': 'newData.isNumber() && newData.val() > (data.exists() ? data.val() : 0)', // only ever counts up
      },
    },
  },

  activityLogs: {
    $pid: {
      '.read': `$pid === '_global' ? ${P('inventory.view')} : (${P('activity.view')} && ${ACCESS('$pid')})`,
      $logId: {
        // append-only: never updated, never deleted — not even by the Super Admin
        '.write': `!data.exists() && newData.exists() && ${ACTIVE} && ($pid === '_global' || ${ACCESS('$pid', true)})`,
        '.validate': `newData.child('at').val() === now && newData.child('uid').val() === ${ME} && newData.hasChildren(['at', 'uid', 'name', 'action', 'rtype', 'rid'])`,
        at: { '.validate': 'newData.isNumber()' },
        uid: { '.validate': 'newData.isString()' },
        name: str(200), dept: str(200), action: str(300), rtype: str(60), rid: str(120), pid: str(60), old: str(20000), new: str(20000),
        $other: { '.validate': false },
      },
    },
  },

  auditLogs: {
    $logId: {
      '.write': `!data.exists() && newData.exists() && ${ACTIVE}`,
      '.validate': `newData.child('at').val() === now && newData.child('uid').val() === ${ME} && newData.hasChildren(['at', 'uid', 'name', 'action'])`,
      at: { '.validate': 'newData.isNumber()' },
      $field: str(20000),
    },
  },

  notifications: {
    $userId: {
      '.read': `${ME} === $userId`,
      $id: {
        '.write': `${ACTIVE} && (${ME} === $userId || (!data.exists() && newData.exists() && newData.child('fromId').val() === ${ME} && newData.child('at').val() === now))`,
        '.validate': "newData.hasChildren(['title', 'at']) && newData.child('title').isString() && newData.child('title').val().length < 301",
        body: str(1000), link: str(400),
      },
    },
  },

  comments: {
    $pid: {
      $module: {
        '.read': `${P('comments.view')} && ${P('comments.viewAll')} && ${PDYN('$module', 'view')} && ${ACCESS('$pid')}`,
        $dept: {
          '.read': `${P('comments.view')} && ${PDYN('$module', 'view')} && ${ACLD('$dept')} && ${ACCESS('$pid')}`,
          $id: {
            '.write': `newData.exists() && ${ACCESS('$pid')} && ${PDYN('$module', 'view')} && (data.exists()`
              + ` ? (data.child('userId').val() === ${ME} && (${P('comments.edit')} || ${P('comments.delete')}))`
              + ` : (${P('comments.create')} && ${PDYN('$module', 'comment')} && ${ACLD('$dept')}))`,
            '.validate': `newData.child('userId').val() === ${ME} && newData.hasChildren(['rtype', 'rid', 'userId', 'userName', 'at'])`
              + " && (data.exists() ? (newData.child('at').val() === data.child('at').val() && newData.child('rid').val() === data.child('rid').val()) : newData.child('at').val() === now)"
              + ` && (newData.child('deleted').val() === data.child('deleted').val() || ${P('comments.delete')})`
              + ` && (newData.child('text').val() === data.child('text').val() || !data.exists() || ${P('comments.edit')} || newData.child('deleted').val() === true)`,
            text: str(5000), rtype: str(60), rid: str(120), userName: str(200), dept: str(200),
            userId: { '.validate': 'newData.isString()' },
            at: { '.validate': 'newData.isNumber()' },
            editedAt: { '.validate': 'newData.val() === now' },
            deleted: { '.validate': 'newData.isBoolean()' },
            $other: { '.validate': false },
          },
        },
      },
    },
  },

  documents: {
    $pid: {
      $module: {
        '.read': `${PDYN('$module', 'view')} && ${ACCESS('$pid')}`,
        $id: {
          '.write': `newData.exists() && ${ACCESS('$pid')} && (data.exists()`
            + ` ? (data.child('uploadedBy').val() === ${ME} || ${PDYN('$module', 'delete')})`
            + ` : ${PDYN('$module', 'upload')})`,
          '.validate': "newData.hasChildren(['rtype', 'rid', 'name', 'kind', 'uploadedBy', 'at'])"
            + ` && (data.exists() ? (newData.child('at').val() === data.child('at').val() && newData.child('uploadedBy').val() === data.child('uploadedBy').val() && newData.child('name').val() === data.child('name').val() && newData.child('url').val() === data.child('url').val() && newData.child('rid').val() === data.child('rid').val())`
            + ` : (newData.child('at').val() === now && newData.child('uploadedBy').val() === ${ME}))`
            + " && (newData.child('kind').val() === 'link' || newData.child('kind').val() === 'file')",
          name: str(200), mime: str(150), category: str(100), rtype: str(60), rid: str(120), uploadedByName: str(200),
          kind: { '.validate': 'newData.isString()' },
          url: { '.validate': "newData.isString() && newData.val().length < 2001 && (newData.val().beginsWith('https://') || newData.val().beginsWith('http://'))" },
          size: { '.validate': 'newData.isNumber() && newData.val() <= 800000' },
          uploadedBy: { '.validate': 'newData.isString()' },
          at: { '.validate': 'newData.isNumber()' },
          deleted: { '.validate': 'newData.isBoolean()' },
          $other: { '.validate': false },
        },
      },
    },
  },

  documentBlobs: {
    $pid: {
      $module: {
        $id: {
          '.read': `${PDYN('$module', 'view')} && ${ACCESS('$pid')}`,
          '.write': `!data.exists() && newData.exists() && ${PDYN('$module', 'upload')} && ${ACCESS('$pid')}`,
          '.validate': "newData.isString() && newData.val().length < 1100001 && newData.parent().parent().parent().parent().child('documents/' + $pid + '/' + $module + '/' + $id + '/kind').val() === 'file'",
        },
      },
    },
  },
};

/* projects (global, keyed by project ID) */
{
  const e = ENTITIES.projects;
  const { nv, ov, same, st } = accessors('projects');
  const node = recordRule('projects', e, { depth: 2, logPid: '$id', access: ACCESS('$id', true) });
  const closureAfter = (kind) => `${ROOT_AFTER(2)}.child('closures/' + $id + '/${kind}/meta/updatedAt').val() === now`;
  const closed = (v) => isIn(v('status'), ['Completed', 'Cancelled']);
  node['.validate'] = and(
    node['.validate'],
    '$id.matches(/^[A-Z0-9][A-Z0-9-]{1,23}$/)',
    // Business rule 24: Completed / Cancelled only together with an authorised closure record.
    or(same('status'), and(
      or(`!${st('Completed')}`, and(P('closure.approve'), closureAfter('completion'))),
      or(`!${st('Cancelled')}`, and(P('closure.approve'), closureAfter('cancellation'))),
      or('!data.exists()', `!${closed(ov)}`, and(P('closure.approve'), closureAfter('reopen'))),
      or(closed(nv), '!data.exists()', closed(ov), P('projects.updateStatus')),
    )),
  );
  rules.projects = {
    '.read': `${SCOPE_ALL} && ${P('projects.view')}`,
    $id: { '.read': `${P('projects.view')} && ${ACCESS('$id')}`, '.write': 'auth != null && !data.exists() && newData.exists()', ...node },
  };
}

/* inventory (global stock register) */
{
  const e = ENTITIES.inventory;
  const { nv } = accessors('inventory');
  const node = recordRule('inventory', e, { depth: 2, logPid: "'_global'", access: ACTIVE });
  node['.validate'] = and(node['.validate'], `${nv('reserved')} <= ${nv('onHand')} + ${EPS}`);
  rules.inventory = {
    '.read': P('inventory.view'),
    $id: { '.write': 'auth != null && !data.exists() && newData.exists()', ...node },
  };
}

/* project-scoped collections */
for (const [coll, e] of Object.entries(ENTITIES)) {
  if (e.global) continue;
  const opts = { depth: 3, logPid: '$pid', access: ACCESS('$pid') };
  let viewPerm = P(`${e.module}.view`);
  if (e.special === 'stage') {
    // A stage belongs to a module (PR, payments, testing…); the right to change it comes from that module.
    const dyn = (modExpr, acts) => acts.map((a) => PDYN(modExpr, a)).join(' || ');
    const MOD = "data.parent().child('core/module').val()";
    opts.groupWrite = (g) => ({
      core: null,
      plan: `${dyn(MOD, ['updateStatus', 'edit', 'approve'])} || ${P('items.edit')} || ${P('projects.edit')}`,
      status: `${dyn(MOD, ['updateStatus', 'create', 'edit', 'approve'])} || (data.parent().child('core/key').val() === 'development' && ${ANY(['testing.create', 'testing.edit', 'testing.updateStatus'])})`,
    }[g]);
    viewPerm = ACTIVE;
  }
  const node = recordRule(coll, e, opts);
  if (e.special === 'stage') {
    const { same, st } = accessors(coll);
    // Completing a stage is always an explicit act of someone allowed to update that stage.
    node['.validate'] = and(node['.validate'], or('!data.exists()', same('status'), `!${st('Completed')}`,
      ['updateStatus', 'approve'].map((a) => PDYN("data.child('core/module').val()", a)).join(' || ')));
  }
  rules[coll] = {
    '.read': `${SCOPE_ALL} && ${viewPerm}`,
    $pid: {
      '.read': `${viewPerm} && ${ACCESS('$pid')}`,
      $id: { '.write': 'auth != null && !data.exists() && newData.exists()', ...node },
    },
  };
}

const out = { rules };
const json = JSON.stringify(out, null, 1);
writeFileSync(join(here, 'database.rules.json'), json + '\n');
writeFileSync(join(here, '..', 'js', 'config', 'rules.generated.js'),
  '// GENERATED by firebase/build-rules.mjs — do not edit by hand.\n// Demo mode enforces exactly these rules in the browser; production uses firebase/database.rules.json.\nexport default '
  + JSON.stringify(out) + ';\n');
console.log(`rules written: ${(json.length / 1024).toFixed(1)} KB (file), ${(JSON.stringify(out).length / 1024).toFixed(1)} KB compact, ${Object.keys(rules).length} top-level nodes`);
