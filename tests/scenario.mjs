/** Shared scenario builders for the tests (each step is done by the right demo account). */
import { store } from './harness.mjs';
import * as P from '../js/services/projects.js';
import * as I from '../js/services/inventory.js';
import * as PR from '../js/services/procurement.js';
import * as D from '../js/services/devtest.js';

export const REPL = 'Source Stock Replenishment';
export const PROJ = 'Project Requirement';

export async function newProject(w, pid = 'TST-1', extra = {}) {
  await w.as('admin');
  await P.createProject({ id: pid, name: `Test project ${pid}`, managerId: 'u_pm', departmentId: 'development', startDate: '2026-11-01', targetDate: '2027-03-01', priority: 'High', status: 'Active', ...extra });
  await w.settle();
  return pid;
}
export async function newItem(w, pid, code = 'ITM-1', qty = 10, extra = {}) {
  await w.as('admin');
  const id = await P.addItem(pid, { itemCode: code, name: `Item ${code}`, requiredQty: qty, uom: 'Nos', estUnitCost: 100, priority: 'High', ...extra });
  await w.settle();
  return id;
}
export async function verify(w, pid, itemId, availableQty) {
  await w.as('stores');
  const r = await I.verifyAvailability(pid, itemId, { availableQty, sourceDeptId: availableQty > 0 ? 'stores' : undefined, verifiedAt: '2026-11-02' });
  await w.settle();
  return r;
}
export const reqOf = (pid, itemId, type) => store.where('procurement', pid, (r) => r.itemId === itemId && r.type === type)[0];
export const transferOf = (pid, itemId) => store.where('stockTransfers', pid, (t) => t.itemId === itemId)[0];

export async function raisePR(w, pid, reqId) {
  await w.as('planning');
  const id = await PR.createPR(pid, reqId, { purpose: 'Test', requestingDeptId: 'planning', requestDate: '2026-11-03', requiredBy: '2026-12-01' });
  await w.settle();
  return id;
}
export async function approvePR(w, pid, prId) {
  await w.as('planning_head');
  await PR.decidePR(pid, prId, { decision: 'Approved', comments: 'ok' });
  await w.settle();
}
/** PR approved → one quotation selected → PO for the full quantity. Returns { prId, qId, poId }. */
export async function toPO(w, pid, reqId, { unitPrice = 100, quantity } = {}) {
  const prId = await raisePR(w, pid, reqId);
  await approvePR(w, pid, prId);
  await w.as('sourcing');
  const qId = await PR.addQuotation(pid, prId, { vendorName: 'Vendor A', unitPrice, gstPercent: 0 });
  await w.settle();
  await PR.selectQuotation(pid, qId, { justification: 'Only quotation' });
  await w.settle();
  const pr = store.get('purchaseRequests', pid, prId);
  const poId = await PR.createPO(pid, prId, { poDate: '2026-11-05', quantity: quantity ?? pr.qty, unitPrice, taxPercent: 0 });
  await w.settle();
  return { prId, qId, poId };
}
export async function devCompleted(w, pid, itemId) {
  await w.as('developer');
  await D.startDevelopment(pid, itemId, { team: 'T', engineerId: 'u_developer', startDate: '2026-11-10', expectedCompletion: '2026-11-20' });
  await w.settle();
  await D.setDevStatus(pid, itemId, { status: 'Completed', note: 'done', date: '2026-11-18' });
  await w.settle();
}
