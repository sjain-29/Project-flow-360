/**
 * Independent check of the security rules.
 *
 * The demo backend evaluates the rules with the app's own small rules engine.
 * To make sure that engine behaves like Firebase, this test records every read
 * and write of a complete multi-user workflow (plus a batch of attacks) and
 * replays each one through "targaryen", an independent open-source simulator of
 * Firebase Realtime Database rules. Both must agree on allow / deny every time.
 */
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { makeWorld, refuses, assert, store } from './harness.mjs';
import { loadSampleData } from '../js/services/demo-data.js';
import rules from '../js/config/rules.generated.js';
import { lintRules } from '../js/services/rules-engine.js';

const require = createRequire(import.meta.url);
let targaryen = null;
try { targaryen = require('targaryen'); } catch { /* optional dev dependency */ }

test('rules file: every expression parses, size is within Firebase limits', async () => {
  const n = lintRules(rules.rules);
  assert.ok(n > 500, `${n} expressions`);
  const { readFileSync } = await import('node:fs');
  const size = readFileSync(new URL('../firebase/database.rules.json', import.meta.url)).length;
  assert.ok(size < 200 * 1024, `rules file is ${(size / 1024).toFixed(0)} KB (Firebase limit: 256 KB)`);
  assert.deepEqual(JSON.parse(readFileSync(new URL('../firebase/database.rules.json', import.meta.url), 'utf8')), rules, 'deployed rules and demo rules are identical');
});

test('positive controls: the hand-crafted writes used in the attack tests succeed for an authorised user', async () => {
  const w = await makeWorld();
  await w.as('admin');
  const b = w.backend; const ts = b.serverTimestamp(); const pid = 'CTRL-1'; let logId = b.newId();
  await b.update({
    [`/projects/${pid}`]: { core: { name: 'Control', managerId: 'u_pm', departmentId: 'development', startDate: '2026-01-01', targetDate: '2026-02-01', priority: 'Low' }, status: { status: 'Planning' }, meta: { createdAt: ts, createdBy: 'u_admin', updatedAt: ts, updatedBy: 'u_admin', _v: 1, _log: logId } },
    [`/activityLogs/${pid}/${logId}`]: { at: ts, uid: 'u_admin', name: 'x', action: 'created', rtype: 'projects', rid: pid },
  });
  logId = b.newId();
  await b.update({
    [`/projectItems/${pid}/IT-1`]: { core: { itemCode: 'A', name: 'A', requiredQty: 2, uom: 'Nos' }, status: { itemStatus: 'Open' }, meta: { createdAt: ts, createdBy: 'u_admin', updatedAt: ts, updatedBy: 'u_admin', _v: 1, _log: logId } },
    [`/activityLogs/${pid}/${logId}`]: { at: ts, uid: 'u_admin', name: 'x', action: 'created', rtype: 'projectItems', rid: 'IT-1' },
  });
  logId = b.newId();
  const base = `/projectItems/${pid}/IT-1`;
  await b.update({ [`${base}/core/requiredQty`]: 3, [`${base}/meta/updatedAt`]: ts, [`${base}/meta/updatedBy`]: 'u_admin', [`${base}/meta/_v`]: 2, [`${base}/meta/_log`]: logId,
    [`/activityLogs/${pid}/${logId}`]: { at: ts, uid: 'u_admin', name: 'x', action: 'edited', rtype: 'projectItems', rid: 'IT-1' } });
  assert.equal(w.raw(`${base}/core/requiredQty`), 3);
  // unknown fields and wrong types are refused even for the Super Admin
  logId = b.newId();
  const meta = { [`${base}/meta/updatedAt`]: ts, [`${base}/meta/updatedBy`]: 'u_admin', [`${base}/meta/_v`]: 3, [`${base}/meta/_log`]: logId, [`/activityLogs/${pid}/${logId}`]: { at: ts, uid: 'u_admin', name: 'x', action: 'edited', rtype: 'projectItems', rid: 'IT-1' } };
  await refuses(b.update({ ...meta, [`${base}/core/hacked`]: 'yes' }));
  await refuses(b.update({ ...meta, [`${base}/core/requiredQty`]: -4 }));
  await refuses(b.update({ ...meta, [`${base}/core/requiredQty`]: 'many' }));
  await refuses(b.update({ ...meta, [`${base}/meta/updatedAt`]: 12345 }), /./); // must be the server time
});

test('the app\'s rules engine and the independent simulator agree on every operation of a full workflow', { skip: !targaryen && 'targaryen is not installed (npm install)' }, async () => {
  const ops = [];
  const w = await makeWorld({ observer: (op) => ops.push(op) });
  await w.as('admin');
  await loadSampleData();
  // a batch of hostile requests from different accounts, to get plenty of denials into the comparison
  const attacks = async (user) => {
    await w.as(user);
    const b = w.backend; const uid = w.session.authUid;
    const tries = [
      () => b.get('/'), () => b.get('/auditLogs'), () => b.get('/payments/DRN-A1'), () => b.get('/purchaseOrders'), () => b.get('/acl/demo_admin'), () => b.get('/projects/NOPE'), () => b.get('/comments/DRN-A1/payments'),
      () => b.update({ [`/acl/${uid}/sa`]: true }), () => b.update({ '/users/u_admin/active': false }), () => b.update({ '/projects/DRN-A1/status/status': 'Completed' }),
      () => b.update({ '/purchaseRequests/DRN-A1/PR-DRN-A1-0001/status/status': 'Approved' }), () => b.update({ '/purchaseOrders/DRN-A1/PO-DRN-A1-0001/pay/paidTotal': 999999 }),
      () => b.update({ '/activityLogs/DRN-A1': null }), () => b.update({ '/inventory/STK-0001/qty/onHand': -1 }), () => b.update({ '/stages/DRN-A1/x/status/status': 'Completed' }),
      () => b.update({ '/testing/DRN-A1/TC-DRN-A1-0001/core/result': 'fine' }), () => b.update({ '/settings/orgName': 'pwned' }), () => b.update({ '/counters/DRN-A1/purchaseOrders': 0 }),
    ];
    for (const t of tries) await t().catch(() => {});
  };
  for (const u of ['viewer', 'sourcing', 'accounts', 'pm', 'tester', 'admin']) await attacks(u);
  await w.out();
  await w.backend.get('/users').catch(() => {});
  await w.backend.update({ '/loginIndex/admin/failed': 1 }).catch(() => {});

  const reads = ops.filter((o) => o.op === 'read'); const updates = ops.filter((o) => o.op === 'update');
  assert.ok(updates.length > 150 && reads.length > 100, `${updates.length} writes, ${reads.length} reads recorded`);
  let denied = 0; const mismatches = [];
  for (const o of ops) {
    const db = targaryen.database(rules, o.root, o.now || 1).as(o.auth);
    let allowed;
    if (o.op === 'read') allowed = db.read(o.path).allowed;
    else allowed = db.update('/', Object.fromEntries(Object.entries(o.updates).map(([p, v]) => [p.replace(/^\//, ''), v])), { now: o.now }).allowed;
    if (!o.allowed) denied++;
    if (allowed !== o.allowed) mismatches.push({ op: o.op, path: o.path || Object.keys(o.updates).slice(0, 3), uid: o.auth?.uid, engine: o.allowed, simulator: allowed, reason: o.res?.reason, at: o.res?.path });
  }
  assert.ok(denied > 60, `${denied} denials compared`);
  assert.deepEqual(mismatches.slice(0, 5), [], `${mismatches.length} disagreement(s) between the engines`);
  console.log(`    compared ${ops.length} operations (${updates.length} writes, ${reads.length} reads, ${denied} denials): no disagreement`);
});
