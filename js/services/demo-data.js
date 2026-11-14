/**
 * DEMO MODE ONLY — loads a sample project by running the REAL workflow with the
 * demo accounts (Stores verifies stock, Planning raises PRs, the Planning head
 * approves, Sourcing collects quotations, Accounts pays, …). Nothing is written
 * behind the application's back, so the sample data obeys every rule and has a
 * genuine audit trail. It is never available when Firebase is configured.
 */
import { be, isDemo } from './backend.js';
import { store } from './store.js';
import { establish, authEmail } from './session.js';
import { DEMO_PASSWORD } from './seed.js';
import { stageId } from '../config/app-config.js';
import { AppError, today, addDays } from '../utils/format.js';
import * as P from './projects.js';
import * as I from './inventory.js';
import * as PR from './procurement.js';
import * as M from './material.js';
import * as D from './devtest.js';
import * as A from './admin.js';
import { updateStage } from './stages.js';
import { addComment } from './records.js';

const settle = () => new Promise((r) => setTimeout(r, 90));

export async function loadSampleData(onStep = () => {}) {
  if (!isDemo()) throw new AppError('Sample data can only be loaded in demo mode.');
  const pid = 'DRN-A1';
  if (store.project(pid)) throw new AppError(`The sample project ${pid} already exists. Reset the demo data first if you want a fresh copy.`);
  const t0 = today();
  const d = (n) => addDays(t0, n);
  const as = async (username, label) => {
    onStep(label);
    store.stop();
    await be().auth.signOut();
    try { await be().auth.signIn(authEmail(username), DEMO_PASSWORD, false); } catch { throw new AppError(`The demo account "${username}" no longer uses the demo password, so the sample workflow cannot run. Reset the demo data first.`); }
    await establish();
    await store.start({ onAccessRevoked: () => {} });
  };
  const item = (code) => store.where('projectItems', pid, (i) => i.itemCode === code)[0];
  const req = (itemId, type) => store.where('procurement', pid, (r) => r.itemId === itemId && r.type === type)[0];
  const REPL = 'Source Stock Replenishment'; const PROJ = 'Project Requirement';

  await as('admin', 'Admin creates the project and its bill of material');
  await P.createProject({ id: pid, name: 'Survey drone prototype A1', description: 'Eight-rotor survey platform: airframe, propulsion and flight-control integration.', category: 'Drone platform', managerId: 'u_pm', departmentId: 'development', startDate: d(-30), targetDate: d(75), priority: 'High', budget: 2500000, status: 'Active' });
  await settle();
  for (const it of [
    { itemCode: 'BLDC-2212', name: 'Brushless motor 2212', requiredQty: 8, uom: 'Nos', priority: 'High', estUnitCost: 3200, requiredBy: d(10), specs: '920 KV, 3–4S' },
    { itemCode: 'FC-H743', name: 'Flight controller H743', requiredQty: 4, uom: 'Nos', priority: 'Critical', estUnitCost: 18500, requiredBy: d(14), preferredVendor: 'Aerotron Systems' },
    { itemCode: 'CF-FRAME-X8', name: 'Carbon-fibre X8 frame kit', requiredQty: 2, uom: 'Set', priority: 'High', estUnitCost: 42000, requiredBy: d(20) },
    { itemCode: 'LIPO-6S-10K', name: 'LiPo battery 6S 10 Ah', requiredQty: 6, uom: 'Nos', priority: 'Medium', estUnitCost: 9500, requiredBy: d(25) },
  ]) await P.addItem(pid, it);
  await A.updateUser('u_viewer', { ...store.user('u_viewer'), departmentIds: ['administration'], projectIds: [pid] });
  await settle();
  const [m, fc, fr] = ['BLDC-2212', 'FC-H743', 'CF-FRAME-X8'].map((c) => item(c).id);

  await as('stores', 'Stores records stock and verifies in-house availability');
  await I.saveStockRecord(null, { itemCode: 'BLDC-2212', itemName: 'Brushless motor 2212', deptId: 'stores', location: 'Rack B-04', uom: 'Nos', onHand: 12 });
  await I.saveStockRecord(null, { itemCode: 'FC-H743', itemName: 'Flight controller H743', deptId: 'stores', location: 'ESD cabinet 2', uom: 'Nos', onHand: 2 });
  await settle();
  await I.verifyAvailability(pid, m, { availableQty: 12, sourceDeptId: 'stores', stockLocation: 'Rack B-04', verifiedAt: d(-26) });
  await I.verifyAvailability(pid, fc, { availableQty: 2, sourceDeptId: 'stores', stockLocation: 'ESD cabinet 2', verifiedAt: d(-26) });
  await I.verifyAvailability(pid, fr, { availableQty: 0, verifiedAt: d(-26), remarks: 'No frame kits in any department store.' });
  await settle();
  const trf = (itemId) => store.where('stockTransfers', pid, (t) => t.itemId === itemId)[0];

  await as('stores_head', 'Stores head approves the stock transfers');
  await I.decideTransfer(pid, trf(m).id, { decision: 'Approved', remarks: 'Stock verified.' });
  await I.decideTransfer(pid, trf(fc).id, { decision: 'Approved' });
  await settle();

  await as('stores', 'Stores dispatches and receives the transferred stock');
  await I.dispatchTransfer(pid, trf(m).id, { qty: 8, date: d(-24) });
  await I.dispatchTransfer(pid, trf(fc).id, { qty: 2, date: d(-24) });
  await settle();
  await I.receiveTransfer(pid, trf(m).id, { receivedQty: 8, acceptedQty: 8, rejectedQty: 0, date: d(-23) });
  await I.receiveTransfer(pid, trf(fc).id, { receivedQty: 2, acceptedQty: 2, rejectedQty: 0, date: d(-23) });
  await settle();

  await as('planning', 'Planning raises purchase requests (project and replenishment)');
  const prOf = {};
  for (const [key, r] of [['mRepl', req(m, REPL)], ['fcRepl', req(fc, REPL)], ['fcProj', req(fc, PROJ)], ['frProj', req(fr, PROJ)]]) {
    prOf[key] = await PR.createPR(pid, r.id, { purpose: r.type === REPL ? `Replenish Stores stock issued to ${pid}` : `Material for ${pid}`, requestingDeptId: 'planning', requestDate: d(-22), requiredBy: d(12) });
    await settle();
  }

  await as('planning_head', 'Planning head approves three PRs (one stays pending)');
  for (const k of ['fcRepl', 'fcProj', 'frProj']) { await PR.decidePR(pid, prOf[k], { decision: 'Approved', comments: 'Within plan.' }); await settle(); }

  await as('sourcing', 'Sourcing collects quotations, selects vendors and issues POs');
  const quote = async (prId, vendor, price, gst, ship, days) => PR.addQuotation(pid, prId, { vendorName: vendor, quotationNumber: `Q-${Math.round(price)}`, quotationDate: d(-18), unitPrice: price, gstPercent: gst, shippingCharges: ship, deliveryTime: `${days} days`, validity: d(20), paymentTerms: '50% advance, balance on delivery' });
  const q1 = await quote(prOf.fcProj, 'Aerotron Systems', 18200, 18, 450, 10); await settle();
  await quote(prOf.fcProj, 'SkyLink Avionics', 17900, 18, 1200, 21); await settle();
  await quote(prOf.fcProj, 'Nimbus Robotics', 19400, 18, 0, 7); await settle();
  const q2 = await quote(prOf.frProj, 'Carbonworks Composites', 40500, 18, 2500, 15); await settle();
  await quote(prOf.frProj, 'Vayu Structures', 43800, 18, 1800, 9); await settle();
  await PR.selectQuotation(pid, q1, { justification: 'Lowest landed cost with a 10-day delivery; preferred vendor.' }); await settle();
  await PR.selectQuotation(pid, q2, { justification: 'Lowest price; delivery acceptable for the frame schedule.' }); await settle();
  const po1 = await PR.createPO(pid, prOf.fcProj, { poDate: d(-15), quantity: 2, unitPrice: 18200, taxPercent: 18, otherCharges: 450, deliveryAddress: 'SPIF Stores, Gate 2', deliveryDate: d(-5), paymentTerms: '50% advance, balance on delivery' }); await settle();
  const po2 = await PR.createPO(pid, prOf.frProj, { poDate: d(-14), quantity: 2, unitPrice: 40500, taxPercent: 18, otherCharges: 2500, deliveryAddress: 'SPIF Stores, Gate 2', deliveryDate: d(6), paymentTerms: '30 days credit' }); await settle();
  await PR.addPI(pid, po1, { piNumber: 'ATS/PI/2291', piDate: d(-14), amount: 36850, tax: 6633 }); await settle();
  const dsp = await PR.addDispatch(pid, po1, { dispatchDate: d(-8), qty: 2, courier: 'BlueDart', trackingNumber: 'BD784512339', challanNumber: 'DC-5531', expectedDelivery: d(-5) }); await settle();

  await as('accounts', 'Accounts records an advance payment');
  await PR.addPayment(pid, po1, { paymentDate: d(-13), amount: 21700, mode: 'NEFT', transactionRef: 'NEFT-AX-118822', status: 'Successful', remarks: '50% advance' }); await settle();

  await as('stores', 'Stores confirms receipt at SPIF and raises a material request');
  await PR.receiveMaterial(pid, dsp, { receiptDate: d(-5), receivedQty: 2, acceptedQty: 2, rejectedQty: 0, challanNumber: 'DC-5531', inspectionRemarks: 'Seals intact, serials recorded.' }); await settle();
  const mr = await M.createMR(pid, fc, { qtyRequested: 4, requestDate: d(-4), remarks: 'All four controllers to GVT for integration.' }); await settle();

  await as('stores_head', 'Stores head approves the material request');
  await M.decideMR(pid, mr, { decision: 'Approved', approvedQty: 4 }); await settle();

  await as('stores', 'Stores dispatches to GVT and confirms the GVT receipt');
  await M.dispatchMR(pid, mr, { qty: 4, date: d(-3) }); await settle();
  await M.receiveAtGVT(pid, mr, { receiptDate: d(-2), receivedQty: 4, acceptedQty: 4, rejectedQty: 0, receivingPerson: 'GVT stores counter' }); await settle();

  await as('developer', 'Development starts work');
  await D.startDevelopment(pid, m, { team: 'Propulsion', engineerId: 'u_developer', startDate: d(-20), expectedCompletion: d(2), workDescription: 'Motor mounts, ESC pairing and thrust-stand characterisation.' }); await settle();
  await D.startDevelopment(pid, fc, { team: 'Avionics', engineerId: 'u_developer', startDate: d(-2), expectedCompletion: d(8), workDescription: 'Firmware bring-up, sensor calibration and failsafe configuration.' }); await settle();
  await D.setDevStatus(pid, fc, { status: 'Completed', note: 'Firmware 1.0 flashed, IMU and compass calibrated.', date: d(-1) }); await settle();

  await as('tester', 'Testing fails cycle 1 — development is reopened');
  const tc1 = await D.createTestCycle(pid, fc, { testPlan: 'Bench test: sensor health, failsafe triggers, 30-minute soak.', testDate: d(-1), engineerId: 'u_tester', environment: 'Avionics bench 1' }); await settle();
  await D.recordTestResult(pid, tc1, { status: 'Failed', result: 'Failsafe did not trigger on RC loss.', observations: 'RC-loss failsafe stayed inactive in 3 of 3 attempts; parameter FS_THR_ENABLE not persisted after reboot.', testDate: d(-1) }); await settle();

  await as('developer', 'Development fixes the issue (revision 2)');
  await D.setDevStatus(pid, fc, { status: 'In Progress', note: 'Investigating failsafe parameter persistence.', date: d(-1) }); await settle();
  await D.setDevStatus(pid, fc, { status: 'Completed', note: 'Parameter storage fixed in firmware 1.0.1; failsafe verified on the bench.', date: t0 }); await settle();

  await as('tester', 'Testing passes cycle 2');
  const tc2 = await D.createTestCycle(pid, fc, { testPlan: 'Regression of failsafe behaviour plus full bench test.', testDate: t0, engineerId: 'u_tester', environment: 'Avionics bench 1' }); await settle();
  await D.recordTestResult(pid, tc2, { status: 'Passed', result: 'All checks passed.', observations: 'Failsafe triggered in 5 of 5 attempts.', testDate: t0 }); await settle();

  await as('test_head', 'Testing head approves the result');
  await D.approveTest(pid, tc2); await settle();

  await as('planning', 'Planning generates a returnable gate pass');
  const gp = await M.createGatePass(pid, { type: 'RGP', itemId: m, qty: 1, destination: 'Thrust-stand lab, Hangar 3', purpose: 'Thrust characterisation at the external lab', issueDate: d(-6), expectedReturn: d(-1), serialNumbers: 'BLDC-2212-0007' }); await settle();
  await as('planning_head', 'Planning head approves the gate pass');
  await M.decideGatePass(pid, gp, { decision: 'Approved' }); await settle();
  await as('planning', 'Planning issues the gate pass');
  await M.issueGatePass(pid, gp); await settle();

  await as('logistics', 'Logistics schedules the frame delivery');
  await M.saveLogistics(pid, null, { materialRef: po2, itemId: fr, pickupLocation: 'Carbonworks Composites, Pune', destination: 'SPIF Stores, Gate 2', transportMode: 'Road', transporter: 'Safexpress', assignedPersonId: 'u_logistics', pickupDate: d(3), expectedDelivery: d(6), status: 'Scheduled' }); await settle();
  await as('travel', 'Travel Desk records a site visit');
  await M.saveTravel(pid, null, { employeeId: 'u_developer', purpose: 'Frame fit-check at the vendor before dispatch', origin: 'Bengaluru', destination: 'Pune', travelDate: d(2), returnDate: d(3), transportArrangement: 'Flight', accommodation: 'One night' }); await settle();

  await as('pm', 'The project manager plans stage dates');
  const plan = [[m, 'A', 'development', d(-20), d(2)], [fr, 'A', 'quotation', d(-20), d(-16)], [fr, 'A', 'po', d(-16), d(-14)], [fr, 'A', 'dispatch', d(-10), d(-3)], [fr, 'A', 'spifReceipt', d(-3), d(6)],
    [m, 'B', 'prApproval', d(-22), d(-4)], [fc, 'B', 'quotation', d(-18), d(1)], [fc, 'A', 'payment', d(-14), d(5)], [fr, 'A', 'development', d(8), d(30)], [fr, 'A', 'testing', d(30), d(40)]];
  for (const [itemId, branch, key, s, e] of plan) { if (store.get('stages', pid, stageId(itemId, branch, key))) { await updateStage(pid, stageId(itemId, branch, key), { expStart: s, expEnd: e }); await settle(); } }
  await addComment('projects', pid, pid, 'Kick-off done. Frame kit is on the critical path — Sourcing, please confirm the dispatch date with the vendor.');

  onStep('Finishing');
  store.stop();
  await be().auth.signOut();
  return pid;
}
