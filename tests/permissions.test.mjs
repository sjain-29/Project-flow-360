/**
 * Permission and security tests (section 34, "Permissions"). Every test tries the
 * forbidden action twice: through the application AND as a direct database
 * request that bypasses the application completely — exactly what someone with
 * browser developer tools could send. The security rules must refuse both.
 */
import { test } from 'node:test';
import { makeWorld, refuses, assert, store } from './harness.mjs';
import { newProject, newItem, verify, reqOf, raisePR, approvePR, toPO, PROJ } from './scenario.mjs';
import * as P from '../js/services/projects.js';
import * as PR from '../js/services/procurement.js';
import * as A from '../js/services/admin.js';
import * as R from '../js/services/records.js';
import { computePerms } from '../js/services/permissions.js';
import { defaultRoles, defaultSettings } from '../js/config/app-config.js';
import { login, logout, establish, changePassword, initialiseSystem, requestPasswordReset, sessionExpiry, session, can, authEmail } from '../js/services/session.js';
import { createLocalBackend } from '../js/services/backend-local.js';
import { _setBackend } from '../js/services/backend.js';
import { DEMO_PASSWORD } from '../js/services/seed.js';
import { runReport } from '../js/services/reports.js';
import { kpis, projectExpenditure } from '../js/services/insights.js';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const perms = (roleId, dept) => computePerms({ roleId, departments: { [dept]: true } }, defaultRoles(), defaultSettings());
const has = (p, perm) => { const [m, a] = perm.split('.'); return p[m]?.[a] === true; };
/** A well-formed record write, as an attacker would craft it by hand. */
function forge(w, coll, pid, id, groups, userId) {
  const b = w.backend; const ts = b.serverTimestamp(); const logId = b.newId();
  return {
    [`/${coll}/${pid}/${id}`]: { ...groups, meta: { createdAt: ts, createdBy: userId, updatedAt: ts, updatedBy: userId, _v: 1, _log: logId } },
    [`/activityLogs/${pid}/${logId}`]: { at: ts, uid: userId, name: 'x', action: 'forged', rtype: coll, rid: id },
  };
}
function forgePatch(w, coll, pid, id, fields, userId) {
  const b = w.backend; const ts = b.serverTimestamp(); const logId = b.newId();
  const cur = store.get(coll, pid, id) || w.raw(`/${coll}/${pid}/${id}/meta`);
  const base = `/${coll}/${pid}/${id}`;
  return { ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [`${base}/${k}`, v])), [`${base}/meta/updatedAt`]: ts, [`${base}/meta/updatedBy`]: userId, [`${base}/meta/_v`]: (cur?._v || 0) + 1, [`${base}/meta/_log`]: logId,
    [`/activityLogs/${pid}/${logId}`]: { at: ts, uid: userId, name: 'x', action: 'forged', rtype: coll, rid: id } };
}

/* ================================================================== default role matrix */
test('default roles: department users are limited to their department, approvals to heads and PMs, viewers read-only', () => {
  const sourcing = perms('department_user', 'sourcing');
  for (const p of ['quotations.create', 'po.create', 'dispatch.create', 'pi.create', 'pr.view', 'items.view', 'pr.comment']) assert.ok(has(sourcing, p), `sourcing should have ${p}`);
  for (const p of ['pr.approve', 'pr.create', 'payments.create', 'payments.view', 'expenditure.view', 'receipts.create', 'quotations.approve', 'items.delete', 'closure.approve']) assert.ok(!has(sourcing, p), `sourcing must not have ${p}`);
  const accounts = perms('department_user', 'accounts');
  for (const p of ['payments.create', 'payments.view', 'pr.view', 'quotations.view', 'po.view', 'expenditure.view']) assert.ok(has(accounts, p), `accounts should have ${p}`);
  for (const p of ['quotations.edit', 'quotations.create', 'receipts.create', 'receipts.edit', 'payments.approve', 'pr.approve']) assert.ok(!has(accounts, p), `accounts must not have ${p}`);
  const planningHead = perms('department_head', 'planning');
  assert.ok(has(planningHead, 'pr.approve') && has(planningHead, 'gatepass.approve') && has(planningHead, 'procurement.approve'));
  assert.ok(!has(planningHead, 'quotations.approve') && !has(planningHead, 'payments.view'));
  const pm = perms('project_manager', 'project_management');
  assert.ok(has(pm, 'projects.create') && has(pm, 'pr.approve') && has(pm, 'closure.approve') && has(pm, 'payments.view'));
  assert.ok(!has(pm, 'payments.create') && !has(pm, 'quotations.create') && !has(pm, 'receipts.create'));
  const viewer = perms('viewer', 'administration');
  for (const [m, acts] of Object.entries(viewer)) assert.deepEqual(Object.keys(acts), ['view'], `viewer has only "view" in ${m}`);
  assert.ok(!has(viewer, 'payments.view') && !has(viewer, 'po.view') && !has(viewer, 'quotations.view') && !has(viewer, 'expenditure.view'));
  const admin = perms('super_admin', 'project_management');
  assert.ok(has(admin, 'payments.approve') && has(admin, 'comments.viewAll'));
  // an individual override beats the role, in both directions
  const over = computePerms({ roleId: 'department_user', departments: { sourcing: true }, overrides: { pr: { approve: true }, po: { create: false } } }, defaultRoles(), defaultSettings());
  assert.ok(has(over, 'pr.approve') && !has(over, 'po.create'));
});

/* ================================================================== department restrictions */
test('Sourcing can run quotations and POs but cannot approve PRs or touch payments — not even with direct requests', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 10);
  await verify(w, pid, it, 0);
  const prId = await raisePR(w, pid, reqOf(pid, it, PROJ).id);
  await w.as('sourcing');
  await refuses(PR.decidePR(pid, prId, { decision: 'Approved' }), /permission/);
  await refuses(w.backend.update(forgePatch(w, 'purchaseRequests', pid, prId, { 'status/status': 'Approved' }, 'u_sourcing')), /permission/);
  await refuses(w.backend.update(forgePatch(w, 'purchaseRequests', pid, prId, { 'approval/decision': 'Approved', 'approval/approverId': 'u_sourcing' }, 'u_sourcing')));
  assert.equal(w.raw(`/purchaseRequests/${pid}/${prId}/status/status`), 'Pending Approval');
  await approvePR(w, pid, prId);
  await w.as('sourcing');
  const q = await PR.addQuotation(pid, prId, { vendorName: 'V', unitPrice: 50 }); await w.settle();
  await PR.selectQuotation(pid, q, { justification: 'only one' }); await w.settle();
  const po = await PR.createPO(pid, prId, { poDate: '2026-11-05', quantity: 10, unitPrice: 50 }); await w.settle();
  await refuses(PR.addPayment(pid, po, { paymentDate: '2026-11-06', amount: 10, mode: 'NEFT', status: 'Successful' }), /permission/);
  await refuses(w.backend.update(forge(w, 'payments', pid, `PAY-${pid}-0001`, { core: { poId: po, paymentDate: '2026-11-06', amount: 10, mode: 'NEFT' }, status: { status: 'Pending' } }, 'u_sourcing')));
  await refuses(w.backend.update(forgePatch(w, 'purchaseOrders', pid, po, { 'pay/paidTotal': 10 }, 'u_sourcing')));
  await refuses(w.backend.get(`/payments/${pid}`), /permission/);
  assert.equal(can('payments.view', pid), false);
  assert.equal(runReport('payments', {}).rows.length, 0, 'financial report is empty for Sourcing');
});

test('Accounts can record payments and view procurement but cannot change quotations or receipt quantities', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 10);
  await verify(w, pid, it, 0);
  const { poId, qId } = await toPO(w, pid, reqOf(pid, it, PROJ).id);
  await w.as('sourcing'); const dsp = await PR.addDispatch(pid, poId, { dispatchDate: '2026-11-12', qty: 10 }); await w.settle();
  await w.as('accounts');
  assert.ok(store.get('quotations', pid, qId), 'accounts can view quotations');
  await PR.addPayment(pid, poId, { paymentDate: '2026-11-10', amount: 100, mode: 'NEFT', status: 'Successful' }); await w.settle();
  await refuses(PR.updateQuotation(pid, qId, { unitPrice: 1 }), /permission/);
  await refuses(w.backend.update(forgePatch(w, 'quotations', pid, qId, { 'core/unitPrice': 1 }, 'u_accounts')));
  await refuses(PR.receiveMaterial(pid, dsp, { receiptDate: '2026-11-15', receivedQty: 10, acceptedQty: 10, rejectedQty: 0 }), /permission/);
  await refuses(w.backend.update(forgePatch(w, 'purchaseOrders', pid, poId, { 'rcpt/receivedQty': 10, 'rcpt/acceptedQty': 10 }, 'u_accounts')));
  await refuses(w.backend.update(forgePatch(w, 'dispatches', pid, dsp, { 'rcpt/receivedQty': 10 }, 'u_accounts')));
  assert.equal(w.raw(`/purchaseOrders/${pid}/${poId}/rcpt/receivedQty`), 0);
  assert.equal(projectExpenditure(pid).total.paid, 100);
});

test('Viewer is read-only, sees no financial data, and only the projects assigned to them', async () => {
  const w = await makeWorld(); const p1 = await newProject(w, 'P-ONE'); const p2 = await newProject(w, 'P-TWO');
  const i1 = await newItem(w, p1, 'A', 3); await newItem(w, p2, 'B', 3);
  await verify(w, p1, i1, 0);
  const { poId } = await toPO(w, p1, reqOf(p1, i1, PROJ).id);
  await w.as('admin');
  await A.updateUser('u_viewer', { ...store.user('u_viewer'), departmentIds: ['administration'], projectIds: [p1] }); await w.settle();
  await w.as('viewer');
  assert.deepEqual(store.projects().map((p) => p.id), [p1]);
  assert.equal(store.list('projectItems').length, 1);
  assert.equal(store.list('purchaseOrders').length, 0, 'no PO data is even loaded');
  await refuses(w.backend.get(`/purchaseOrders/${p1}/${poId}`), /permission/);
  await refuses(w.backend.get(`/payments/${p1}`), /permission/);
  // cannot open the other project by guessing its ID
  await refuses(w.backend.get(`/projects/${p2}`), /permission/);
  await refuses(w.backend.get(`/projectItems/${p2}`), /permission/);
  await refuses(w.backend.get('/projects'), /permission/);
  // every kind of write is refused
  await refuses(P.addItem(p1, { itemCode: 'X', name: 'X', requiredQty: 1, uom: 'Nos' }), /permission/);
  await refuses(w.backend.update(forge(w, 'projectItems', p1, `IT-${p1}-0009`, { core: { itemCode: 'X', name: 'X', requiredQty: 1, uom: 'Nos' }, status: { itemStatus: 'Open' } }, 'u_viewer')));
  await refuses(w.backend.update(forgePatch(w, 'projectItems', p1, i1, { 'core/requiredQty': 99 }, 'u_viewer')));
  await refuses(R.addComment('projects', p1, p1, 'hello'), /permission/);
  assert.equal(kpis().totalProjects, 1, 'dashboard totals only count permitted projects');
  assert.equal(kpis().pendingPayments, 0);
});

/* ================================================================== project-level access */
test('project scopes: selected projects, project manager, department-assigned, all', async () => {
  const w = await makeWorld();
  const pDev = await newProject(w, 'P-DEV', { departmentId: 'development', managerId: 'u_pm' });
  const pTst = await newProject(w, 'P-TST', { departmentId: 'testing', managerId: 'u_admin' });
  await w.as('admin');
  await A.createUser({ username: 'limited', displayName: 'Limited User', roleId: 'department_user', departmentId: 'sourcing', scope: 'selected', projectIds: [pTst], tempPassword: 'Temp1234x' });
  await A.createUser({ username: 'devscope', displayName: 'Dept Scope', roleId: 'department_user', departmentId: 'development', scope: 'dept', tempPassword: 'Temp1234x' });
  await w.settle();
  await w.as('limited', 'Temp1234x');
  assert.deepEqual(store.projects().map((p) => p.id), [pTst]);
  await refuses(w.backend.get(`/projects/${pDev}`));
  await refuses(w.backend.get(`/stages/${pDev}`));
  await w.as('devscope', 'Temp1234x');
  assert.deepEqual(store.projects().map((p) => p.id), [pDev], 'department scope → projects of own department');
  await refuses(w.backend.get(`/projects/${pTst}`));
  await w.as('pm'); // scope "selected", no explicit projects → only the project they manage
  assert.deepEqual(store.projects().map((p) => p.id), [pDev]);
  await refuses(w.backend.get(`/projectItems/${pTst}`));
  await refuses(P.addItem(pTst, { itemCode: 'X', name: 'X', requiredQty: 1, uom: 'Nos' }), /permission|not found/);
  await w.as('planning'); // scope "all"
  assert.equal(store.projects().length, 2);
  // access follows the assignment immediately
  await w.as('admin'); await A.updateUser('u_pm', { ...store.user('u_pm'), departmentIds: ['project_management'], projectIds: [pTst] }); await w.settle();
  await w.as('pm'); assert.equal(store.projects().length, 2);
});

/* ================================================================== privilege escalation */
test('nobody can promote themselves, change roles, or write another user\'s permissions', async () => {
  const w = await makeWorld();
  await w.as('sourcing');
  const uid = session.authUid;
  await refuses(w.backend.update({ [`/acl/${uid}/sa`]: true }));
  await refuses(w.backend.update({ [`/acl/${uid}/p/pr/approve`]: true }));
  await refuses(w.backend.update({ [`/acl/${uid}/scope`]: 'all' }));
  await refuses(w.backend.update({ '/users/u_sourcing/roleId': 'super_admin' }));
  await refuses(w.backend.update({ '/roles/department_user/permissions/pr/approve': true }));
  await refuses(w.backend.update({ '/settings/allowSelfApproval': true }));
  await refuses(w.backend.update({ '/system/initialized': null }));
  await refuses(w.backend.update({ '/loginIndex/admin/v': 2 }));
  await refuses(A.createUser({ username: 'evil', displayName: 'E', roleId: 'super_admin', departmentId: 'sourcing', tempPassword: 'Temp1234x' }), /Only the Super Admin/);
  await refuses(A.saveRole('department_user', { name: 'x', permissions: {} }), /Only the Super Admin/);
  await refuses(w.backend.get(`/acl/demo_admin`), /permission/);
  await refuses(w.backend.get('/auditLogs'), /permission/);
  assert.equal(w.raw('/users/u_sourcing/roleId'), 'department_user');
  // self-service fields are tightly limited
  await w.backend.update({ '/users/u_sourcing/prefs': { theme: 'dark' } });
  await refuses(w.backend.update({ '/users/u_sourcing/mustChangePassword': true }));
  await refuses(w.backend.update({ '/users/u_planning/prefs': { x: 1 } }));
});

/* ================================================================== audit trail */
test('audit trail: every record write needs its log entry; logs are append-only for everyone', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 3);
  await w.as('admin');
  const logs = await R.projectActivity(pid);
  assert.ok(logs.length >= 2);
  const created = logs.find((l) => l.rtype === 'projectItems');
  assert.deepEqual([created.uid, created.name, created.rid, created.new.itemCode], ['u_admin', 'Asha Admin (demo)', it, 'A']);
  // write without a log entry → refused, even for the Super Admin
  const b = w.backend; const ts = b.serverTimestamp();
  await refuses(b.update({ [`/projectItems/${pid}/${it}/core/requiredQty`]: 5, [`/projectItems/${pid}/${it}/meta/updatedAt`]: ts, [`/projectItems/${pid}/${it}/meta/updatedBy`]: 'u_admin', [`/projectItems/${pid}/${it}/meta/_v`]: 2 }));
  // log that names somebody else → refused
  const forged = forgePatch(w, 'projectItems', pid, it, { 'core/requiredQty': 5 }, 'u_admin');
  const logPath = Object.keys(forged).find((k) => k.startsWith('/activityLogs/'));
  forged[logPath].uid = 'u_planning';
  await refuses(b.update(forged));
  // existing log entries cannot be changed or deleted — not even by the Super Admin
  await refuses(b.update({ [`/activityLogs/${pid}/${created.id}/action`]: 'nothing happened' }));
  await refuses(b.update({ [`/activityLogs/${pid}/${created.id}`]: null }));
  await refuses(b.update({ [`/activityLogs/${pid}`]: null }));
  const sys = Object.keys(w.raw('/auditLogs'))[0];
  await refuses(b.update({ [`/auditLogs/${sys}`]: null }));
  await refuses(b.update({ [`/auditLogs/${sys}/action`]: 'edited' }));
  // the old value is recorded on edits
  await P.updateItem(pid, it, { requiredQty: 7 }); await w.settle();
  const edit = (await R.projectActivity(pid)).find((l) => l.rtype === 'projectItems' && l.old);
  assert.deepEqual([edit.old.requiredQty, edit.new.requiredQty], [3, 7]);
  // only the Super Admin gets the organisation-wide trail
  const all = await R.fullAuditTrail();
  assert.ok(all.some((l) => l.action === 'Signed in') && all.some((l) => l.rtype === 'projects'));
  await w.as('pm');
  await refuses(R.fullAuditTrail(), /Only the Super Admin/);
  await refuses(w.backend.get('/activityLogs'), /permission/);
});

test('concurrent / duplicate writes: stale versions, reused IDs and counters going backwards are refused', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 3);
  await w.as('admin');
  const stale = forgePatch(w, 'projectItems', pid, it, { 'core/requiredQty': 4 }, 'u_admin'); // built against version 1
  await P.updateItem(pid, it, { requiredQty: 5 }); await w.settle();                           // someone else gets there first
  await refuses(w.backend.update(stale), /changed by someone else|permission/);
  assert.equal(store.get('projectItems', pid, it).requiredQty, 5);
  await refuses(w.backend.update(forge(w, 'projectItems', pid, it, { core: { itemCode: 'A', name: 'again', requiredQty: 1, uom: 'Nos' }, status: { itemStatus: 'Open' } }, 'u_admin')), /./);
  await refuses(w.backend.update({ [`/counters/${pid}/projectItems`]: 0 }));
  await refuses(w.backend.update({ [`/projectItems/${pid}/${it}`]: null }), /./);
  await refuses(w.backend.update({ [`/projects/${pid}`]: null }), /./);
});

/* ================================================================== accounts & sessions */
test('deactivation ends access immediately, even for a session that is already open', async () => {
  const w = await makeWorld(); const pid = await newProject(w);
  let revoked = null;
  await w.as('planning');
  store.stop(); await store.start({ onAccessRevoked: (why) => { revoked = why; } });
  assert.ok((await w.backend.get(`/projects/${pid}`)));
  // the administrator deactivates the account from "another browser" (console-level write of the same two paths)
  const planningUid = session.authUid;
  w.backend.adminSet('/users/u_planning/active', false);
  w.backend.adminSet(`/acl/${planningUid}`, null);
  await w.settle();
  assert.equal(revoked, 'deactivated', 'the open session is told immediately');
  await refuses(w.backend.get(`/projects/${pid}`), /permission/);
  await refuses(w.backend.get('/users'), /permission/);
  await refuses(P.addItem(pid, { itemCode: 'X', name: 'X', requiredQty: 1, uom: 'Nos' }));
  store.stop(); await w.backend.auth.signOut();
  const res = await login('planning', DEMO_PASSWORD, false);
  assert.equal(res.state, 'deactivated');
  assert.equal(w.backend.auth.current(), null);
});

test('user lifecycle: create, forced password change, deactivate / reactivate through the app, admin password reset', async () => {
  const w = await makeWorld();
  await w.as('admin');
  await refuses(A.createUser({ username: 'Bad Name', displayName: 'X', roleId: 'viewer', departmentId: 'stores', tempPassword: 'Temp1234x' }), /Username/);
  await refuses(A.createUser({ username: 'newbie', displayName: 'X', roleId: 'viewer', departmentId: 'stores', tempPassword: 'short' }), /Temporary password/);
  await refuses(A.createUser({ username: 'admin', displayName: 'X', roleId: 'viewer', departmentId: 'stores', tempPassword: 'Temp1234x' }), /already in use/);
  const id = await A.createUser({ username: 'newbie', displayName: 'New Person', roleId: 'department_user', departmentId: 'stores', departmentIds: ['stores', 'logistics'], scope: 'all', tempPassword: 'Temp1234x' });
  await w.settle();
  assert.equal(w.raw(`/users/${id}/password`), null, 'no password is ever stored in the database');
  assert.ok(!JSON.stringify(w.backend.exportAll()).includes('Temp1234x'));
  await w.out();
  let res = await login('newbie', 'Temp1234x', false);
  assert.equal(res.state, 'changePassword', 'first login forces a password change');
  await refuses(changePassword('short'), /at least 8/);
  await refuses(changePassword('newbie12345'), /username/);
  await changePassword('Fresh-pass-77', 'Temp1234x');
  await logout();
  await refuses(login('newbie', 'Temp1234x', false), /Incorrect username or password/);
  res = await login('newbie', 'Fresh-pass-77', false);
  assert.equal(res.state, 'ok');
  assert.ok(can('logistics.create') && can('receipts.create'), 'both departments apply');
  await logout();
  // failed logins were counted and are reported at the next successful sign-in
  await w.as('admin');
  assert.ok(store.loginIndex().newbie.failed === 0 || store.loginIndex().newbie.failed === undefined);
  await refuses(A.setUserActive('u_admin', false), /your own account/);
  await A.setUserActive(id, false); await w.settle();
  await w.out();
  assert.equal((await login('newbie', 'Fresh-pass-77', false)).state, 'deactivated');
  await w.as('admin'); await A.setUserActive(id, true); await w.settle();
  // forgotten password → request → admin issues a new temporary password
  await w.out();
  await requestPasswordReset('newbie');
  await w.as('admin');
  assert.ok(store.loginIndex().newbie.resetRequestedAt, 'the request is visible to the Super Admin');
  const oldUid = store.user(id).authUid;
  await A.resetUserPassword(id, 'Reset-4321x'); await w.settle();
  assert.equal(w.raw(`/acl/${oldUid}`), null, 'the old sign-in has no permissions any more');
  assert.equal(store.loginIndex().newbie.resetRequestedAt, undefined);
  await w.out();
  await refuses(login('newbie', 'Fresh-pass-77', false), /Incorrect/);
  assert.equal((await login('newbie', 'Reset-4321x', false)).state, 'changePassword');
  await logout();
  // audit entries exist for all of it
  await w.as('admin');
  const actions = (await R.fullAuditTrail()).map((l) => l.action);
  for (const a of ['User created', 'User deactivated', 'User reactivated', 'Password reset by administrator (new sign-in issued)', 'Changed own password']) assert.ok(actions.includes(a), `audit has "${a}"`);
  assert.ok((await R.fullAuditTrail()).some((l) => /failed sign-in/.test(l.note || '')), 'failed sign-in attempts are reported');
});

test('unauthenticated visitors can read nothing, and only nudge the failed-login counter by one', async () => {
  const w = await makeWorld();
  const b = w.backend;
  for (const p of ['/users', '/projects', '/acl', '/roles', '/settings', '/loginIndex', '/auditLogs', '/system', '/']) await refuses(b.get(p), /permission/);
  assert.deepEqual(Object.keys(await b.get('/loginIndex/admin')).sort(), ['userId', 'v'], 'a single username resolves; the index cannot be listed');
  await b.update({ '/loginIndex/admin/failed': 1, '/loginIndex/admin/lastFailedAt': b.serverTimestamp() });
  await refuses(b.update({ '/loginIndex/admin/failed': 50 }));
  await refuses(b.update({ '/loginIndex/admin/failed': 0 }));
  await refuses(b.update({ '/loginIndex/admin/v': 9 }));
  await refuses(b.update({ '/loginIndex/ghost/failed': 1 }), /./);
  await refuses(b.update({ '/loginIndex/ghost/resetRequestedAt': b.serverTimestamp() }));
  await refuses(b.update({ '/users/u_x': { username: 'x', displayName: 'x', roleId: 'super_admin' } }));
  await refuses(login('admin', 'wrong-password', false), /Incorrect username or password/);
  assert.equal(w.raw('/loginIndex/admin/failed'), 2, 'failed attempt counted');
});

test('first-run bootstrap: only the UID named by the project owner can initialise, only once', async () => {
  if (store.isStarted()) store.stop();
  const b = createLocalBackend({ storage: mem(), sessionStorage: mem(), noSeed: true });
  _setBackend(b); await b.init();
  const ownerUid = await b.auth.adminCreateUser(authEmail('suyash'), 'initial-pass-1');
  const strangerUid = await b.auth.adminCreateUser(authEmail('mallory'), 'initial-pass-2');
  // a stranger signs up first: nothing is initialised and they are not the named UID
  await b.auth.signIn(authEmail('mallory'), 'initial-pass-2', false);
  assert.equal((await establish()).state, 'uninitialised');
  await refuses(initialiseSystem({ displayName: 'Mallory' }), /permission/);
  await refuses(b.update({ [`/acl/${strangerUid}`]: { userId: 'u_mallory', scope: 'all', sa: true } }));
  await refuses(b.update({ '/system/bootstrapUid': strangerUid }));
  await b.auth.signOut();
  // the project owner names the bootstrap UID in the Firebase console (bypasses rules by design)
  b.adminSet('/system/bootstrapUid', ownerUid);
  await b.auth.signIn(authEmail('suyash'), 'initial-pass-1', false);
  const st = await establish();
  assert.deepEqual([st.state, st.username], ['bootstrap', 'suyash']);
  const res = await initialiseSystem({ displayName: 'Suyash', departmentId: 'project_management', orgName: 'Test Org' });
  assert.equal(res.state, 'changePassword', 'the bootstrap password must be changed at first login');
  assert.deepEqual([session.user.displayName, session.user.roleId, session.user.departmentId, session.acl.sa], ['Suyash', 'super_admin', 'project_management', true]);
  assert.equal(b.adminGet('/roles/department_head/name'), 'Department Head');
  assert.equal(Object.keys(b.adminGet('/departments')).length, 10);
  assert.ok(!JSON.stringify(b.exportAll()).includes('initial-pass-1'), 'the bootstrap password is not in the database');
  await changePassword('Much-better-pass-9', 'initial-pass-1');
  // the bootstrap door is now closed for good
  await refuses(b.update({ '/system/initialized': null }));
  await refuses(initialiseSystem({ displayName: 'Again' }), /permission/);
  await b.auth.signOut();
  b.adminSet('/system/bootstrapUid', strangerUid); // even if someone edits the console value afterwards
  await b.auth.signIn(authEmail('mallory'), 'initial-pass-2', false);
  assert.equal((await establish()).state, 'deactivated', 'an account without a profile gets nothing once the system is initialised');
});

/* ================================================================== admin configuration */
test('Super Admin can add roles and departments and remap modules; permissions follow at once', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 4);
  await verify(w, pid, it, 0);
  const prId = await raisePR(w, pid, reqOf(pid, it, PROJ).id);
  await w.as('admin');
  const dept = await A.saveDepartment(null, { name: 'Quality Assurance' });
  assert.equal(dept, 'quality_assurance');
  const role = await A.saveRole(null, { name: 'Procurement Auditor', deptRestricted: false, dashboard: 'viewer', permissions: { pr: { view: true, approve: true }, projects: { view: true }, items: { view: true }, procurement: { view: true } } });
  await A.createUser({ username: 'auditor', displayName: 'Audit Person', roleId: role, departmentId: dept, scope: 'all', tempPassword: 'Temp1234x' });
  await w.settle();
  await w.as('auditor', 'Temp1234x');
  await PR.decidePR(pid, prId, { decision: 'Approved' }); await w.settle();
  assert.equal(store.get('purchaseRequests', pid, prId).status, 'Approved');
  await refuses(PR.addQuotation(pid, prId, { vendorName: 'V', unitPrice: 1 }), /permission/);
  // remove the permission from the role → the user loses it immediately (acl is recomputed in the same write)
  await w.as('admin');
  await A.saveRole(role, { name: 'Procurement Auditor', deptRestricted: false, dashboard: 'viewer', permissions: { pr: { view: true }, projects: { view: true } } }); await w.settle();
  await w.as('auditor', 'Temp1234x');
  assert.equal(can('pr.approve'), false);
  // module ownership: give "Vendor quotations" to Planning as well → Planning users gain it
  await w.as('planning'); assert.equal(can('quotations.create'), false);
  await w.as('admin'); await A.saveSettings({ moduleDepartments: { quotations: { sourcing: true, planning: true } } }); await w.settle();
  await w.as('planning'); assert.equal(can('quotations.create'), true);
  // guard rails
  await w.as('admin');
  await refuses(A.saveRole('super_admin', { name: 'x', permissions: {} }), /cannot be edited/);
  await refuses(A.deleteRole('viewer'), /standard roles/);
  await refuses(A.deleteRole(role), /still have this role/);
  await refuses(A.updateUser('u_admin', { ...store.user('u_admin'), roleId: 'viewer', departmentIds: ['project_management'] }), /your own Super Admin role/);
});

/* ================================================================== notifications & comments */
test('notifications only reach people who may open the record', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 4);
  await verify(w, pid, it, 0);
  await raisePR(w, pid, reqOf(pid, it, PROJ).id);
  const notesOf = (u) => Object.values(w.raw(`/notifications/${u}`) || {}).map((n) => n.title);
  assert.ok(notesOf('u_planning_head').some((t) => /PR needs approval/.test(t)), 'the approver is notified');
  assert.ok(notesOf('u_pm').some((t) => /PR needs approval/.test(t)), 'the project manager (approver for this project) is notified');
  assert.ok(notesOf('u_pm').some((t) => /New project assigned/.test(t)));
  for (const u of ['u_viewer', 'u_sourcing', 'u_accounts', 'u_tester']) assert.ok(!notesOf(u).some((t) => /PR needs approval/.test(t)), `${u} must not be notified`);
  // read state belongs to the owner; nobody else can read or forge
  await w.as('planning_head');
  const mine = store.notifications();
  assert.ok(mine.length && mine.every((n) => n.read === false));
  await w.backend.update({ [`/notifications/u_planning_head/${mine[0].id}/read`]: true });
  await refuses(w.backend.get('/notifications/u_pm'), /permission/);
  await refuses(w.backend.update({ '/notifications/u_pm/x1': { title: 'spoof', at: w.backend.serverTimestamp(), fromId: 'u_admin' } }));
});

test('comments: need permission, carry author and time, are private to the module, own-only edit/delete', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 4);
  await verify(w, pid, it, 0);
  const { poId } = await toPO(w, pid, reqOf(pid, it, PROJ).id);
  const read = (coll, rid) => new Promise((resolve) => { const un = R.watchComments(coll, pid, rid, (list) => { setTimeout(() => { un(); resolve(list); }, 30); }); });
  await w.as('sourcing');
  await R.addComment('purchaseOrders', pid, poId, 'Vendor confirmed dispatch for Friday.'); await w.settle();
  const c = (await read('purchaseOrders', poId))[0];
  assert.deepEqual([c.userId, c.userName, c.dept, typeof c.at], ['u_sourcing', 'Sana Sourcing (demo)', 'Sourcing', 'number']);
  // another user cannot edit or delete it, not even directly
  await w.as('accounts');
  assert.equal((await read('purchaseOrders', poId)).length, 0, 'department users without "view all departments" see only their department\'s comments');
  await refuses(R.editComment('purchaseOrders', pid, c, 'changed'), /your own/);
  await refuses(w.backend.update({ [`/comments/${pid}/po/sourcing/${c.id}/text`]: 'changed' }));
  await refuses(w.backend.get(`/comments/${pid}/po/sourcing`), /permission/);
  // heads and PMs see all departments
  await w.as('pm');
  assert.equal((await read('purchaseOrders', poId)).length, 1);
  // viewer: no access to the PO module → no access to its comments
  await w.as('viewer');
  await refuses(w.backend.get(`/comments/${pid}/po`), /permission/);
  // the author edits, then deletes
  await w.as('sourcing');
  await R.editComment('purchaseOrders', pid, c, 'Vendor confirmed dispatch for Monday.'); await w.settle();
  const edited = (await read('purchaseOrders', poId))[0];
  assert.ok(edited.editedAt && /Monday/.test(edited.text));
  await R.deleteComment('purchaseOrders', pid, edited); await w.settle();
  assert.equal((await read('purchaseOrders', poId))[0].deleted, true);
  // commenting needs the module's comment permission
  await w.as('viewer'); await refuses(R.addComment('projectItems', pid, it, 'hi'), /permission/);
});

test('attachments: type and size checks, module-scoped visibility, links', async () => {
  const w = await makeWorld(); const pid = await newProject(w); const it = await newItem(w, pid, 'A', 4);
  await verify(w, pid, it, 0);
  const { poId } = await toPO(w, pid, reqOf(pid, it, PROJ).id);
  await w.as('sourcing');
  await refuses(R.addLink('purchaseOrders', pid, poId, { name: 'PO scan', url: 'javascript:alert(1)' }), /https/);
  await R.addLink('purchaseOrders', pid, poId, { name: 'PO scan', url: 'https://drive.example.com/po.pdf', category: 'Purchase order' });
  await refuses(R.addFile('purchaseOrders', pid, poId, { name: 'x.exe', type: 'application/x-msdownload', size: 10 }), /not allowed/);
  await refuses(R.addFile('purchaseOrders', pid, poId, { name: 'big.pdf', type: 'application/pdf', size: 900 * 1024 }), /KB/);
  const docs = await new Promise((resolve) => { const un = R.watchDocuments('purchaseOrders', pid, poId, (l) => setTimeout(() => { un(); resolve(l); }, 30)); });
  assert.deepEqual([docs.length, docs[0].kind, docs[0].uploadedBy], [1, 'link', 'u_sourcing']);
  // direct upload of an oversized blob is refused by the rules
  const id = w.backend.newId();
  await refuses(w.backend.update({ [`/documents/${pid}/po/${id}`]: { rtype: 'purchaseOrders', rid: poId, name: 'huge', kind: 'file', uploadedBy: 'u_sourcing', at: w.backend.serverTimestamp(), size: 5000000 }, [`/documentBlobs/${pid}/po/${id}`]: 'x'.repeat(1200000) }));
  await w.as('viewer');
  await refuses(w.backend.get(`/documents/${pid}/po`), /permission/);
  await refuses(R.addLink('projectItems', pid, it, { name: 'n', url: 'https://x.example' }), /permission/);
  assert.equal((await R.projectDocuments(pid)).length, 0);
  await w.as('pm');
  assert.equal((await R.projectDocuments(pid)).length, 1);
});

test('session expiry: idle and maximum length', () => {
  const key = 'pf360.session';
  localStorage.setItem(key, JSON.stringify({ start: Date.now(), last: Date.now() }));
  assert.equal(sessionExpiry({ sessionIdleMinutes: 30, sessionMaxHours: 12 }), null);
  localStorage.setItem(key, JSON.stringify({ start: Date.now(), last: Date.now() - 31 * 60000 }));
  assert.match(sessionExpiry({ sessionIdleMinutes: 30, sessionMaxHours: 12 }), /inactive/);
  localStorage.setItem(key, JSON.stringify({ start: Date.now() - 13 * 3600000, last: Date.now() }));
  assert.match(sessionExpiry({ sessionIdleMinutes: 30, sessionMaxHours: 12 }), /maximum/);
  localStorage.removeItem(key);
});
