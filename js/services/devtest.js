/**
 * Development (section 14) and Testing (section 15).
 *
 * An item is not complete because its material arrived: development and
 * testing are separate stages. A failed test never overwrites anything — the
 * cycle is frozen, development is reopened, and a new cycle is created later.
 */
import { store } from './store.js';
import { requirePerm, requireAny, me, session } from './session.js';
import { runTx } from './tx.js';
import { recipients, ifAllowed } from './notify.js';
import { touchStage, ensureStages } from './stages.js';
import { assertProjectOpen } from './projects.js';
import { AppError, num, today } from '../utils/format.js';

const need = (coll, pid, id, label) => { const r = store.get(coll, pid, id); if (!r) throw new AppError(`${label} not found.`); return r; };
const itemOf = (pid, itemId) => { const it = need('projectItems', pid, itemId, 'Item'); return { itemId, itemCode: it.itemCode, itemName: it.name }; };
export const DEV_STATUSES = ['Not Started', 'In Progress', 'Blocked', 'Under Review', 'Completed', 'Reopened'];

/* ------------------------------------------------------------------ development */
export async function startDevelopment(pid, itemId, input) {
  requirePerm('development.create', pid, 'start development records');
  assertProjectOpen(pid);
  if (store.get('development', pid, itemId)) throw new AppError('Development has already been started for this item.');
  const ref = itemOf(pid, itemId);
  if (input.startDate && input.expectedCompletion && input.expectedCompletion < input.startDate) throw new AppError('The expected completion cannot be before the start date.');
  const status = input.startDate ? 'In Progress' : 'Not Started';
  await runTx(pid, (tx) => {
    tx.create('development', itemId, { ...ref, team: input.team, engineerId: input.engineerId, startDate: input.startDate, expectedCompletion: input.expectedCompletion, workDescription: input.workDescription,
      technicalRemarks: input.technicalRemarks, revision: num(input.revision) || 1, status }, `Development record opened (${status})`);
    ensureStages(tx, pid, itemId, {});
    if (status === 'In Progress') touchStage(tx, itemId, 'A', 'development', 'start');
    tx.notify(ifAllowed(input.engineerId, 'development.view', pid), { title: `Development assigned: ${ref.itemCode}`, body: `Project ${pid}.`, link: `#/items/${pid}/${itemId}`, module: 'development' });
  });
}

export async function updateDevelopment(pid, itemId, input) {
  requirePerm('development.edit', pid, 'edit development records');
  const dev = need('development', pid, itemId, 'Development record');
  const d = {};
  for (const k of ['team', 'engineerId', 'startDate', 'expectedCompletion', 'workDescription', 'technicalRemarks', 'issues']) if (k in input) d[k] = input[k];
  if ('revision' in input && input.revision !== '') d.revision = num(input.revision);
  const start = d.startDate ?? dev.startDate; const exp = d.expectedCompletion ?? dev.expectedCompletion;
  if (start && exp && exp < start) throw new AppError('The expected completion cannot be before the start date.');
  await runTx(pid, (tx) => tx.patch('development', itemId, d, 'Development details edited'));
}

/** Every status change is stored as a timestamped development update. */
export async function setDevStatus(pid, itemId, { status, note, issues, date }) {
  requireAny(['development.updateStatus'], pid, 'update development status');
  const dev = need('development', pid, itemId, 'Development record');
  if (!DEV_STATUSES.includes(status) || status === 'Reopened') throw new AppError('Choose a development status. ("Reopened" is set when a test fails.)');
  if (status === dev.status) throw new AppError('Development already has this status. Use "Add update" to record progress.');
  if (!note?.trim()) throw new AppError('Describe the work done or the reason for the status change.');
  const day = date || today();
  await runTx(pid, async (tx) => {
    const patch = { status };
    let revision = num(dev.revision) || 1;
    if (dev.status === 'Reopened' && status !== 'Not Started') { revision += 1; patch.revision = revision; patch.actualCompletion = null; }
    if (status === 'Completed') patch.actualCompletion = day;
    if (status !== 'Not Started' && !dev.startDate) patch.startDate = day;
    if (issues !== undefined) patch.issues = issues;
    tx.patch('development', itemId, patch, `Development status: ${dev.status} → ${status}`);
    tx.create('developmentUpdates', await tx.nextId('developmentUpdates'), { itemId, itemCode: dev.itemCode, itemName: dev.itemName, date: day, status, revision, note, issues }, `Development update: ${status}`);
    if (status === 'Completed') {
      touchStage(tx, itemId, 'A', 'development', 'complete');
      tx.notify(recipients('testing.create', pid), { title: `Development completed: ${dev.itemCode} — ready for testing`, body: `Project ${pid}, revision ${revision}.`, link: `#/items/${pid}/${itemId}`, module: 'development' });
    } else touchStage(tx, itemId, 'A', 'development', dev.status === 'Completed' ? 'reopen' : 'start');
  });
}

export async function addDevUpdate(pid, itemId, { date, note, issues }) {
  requireAny(['development.create', 'development.edit', 'development.updateStatus'], pid, 'add development updates');
  const dev = need('development', pid, itemId, 'Development record');
  if (!note?.trim()) throw new AppError('Describe the work done.');
  await runTx(pid, async (tx) => {
    tx.create('developmentUpdates', await tx.nextId('developmentUpdates'), { itemId, itemCode: dev.itemCode, itemName: dev.itemName, date: date || today(), status: dev.status, revision: num(dev.revision) || 1, note, issues }, 'Development update added');
  });
}

/* ------------------------------------------------------------------ testing */
export const itemTests = (pid, itemId) => store.where('testing', pid, (t) => t.itemId === itemId).sort((a, b) => a.cycle - b.cycle);
export const latestTest = (pid, itemId) => itemTests(pid, itemId).slice(-1)[0] || null;
const OPEN_TEST = ['Not Started', 'In Progress', 'Passed'];

export async function createTestCycle(pid, itemId, input) {
  requirePerm('testing.create', pid, 'create test cycles');
  assertProjectOpen(pid);
  const ref = itemOf(pid, itemId);
  const dev = store.get('development', pid, itemId);
  if (!dev || dev.status !== 'Completed') throw new AppError(`A test cycle can only be created when development is completed. Development of ${ref.itemCode} is "${dev?.status || 'not started'}".`);
  const tests = itemTests(pid, itemId);
  const open = tests.find((t) => OPEN_TEST.includes(t.status));
  if (open) throw new AppError(`Test cycle ${open.cycle} (${open.id}) is still open. Finish it before starting another cycle.`);
  if (tests.some((t) => t.status === 'Approved') && tests.slice(-1)[0].status === 'Approved') throw new AppError('Testing of this item is already approved.');
  if (!input.testPlan?.trim()) throw new AppError('Enter the test plan.');
  return runTx(pid, async (tx) => {
    const id = await tx.nextId('testing');
    const cycle = (tests.slice(-1)[0]?.cycle || 0) + 1;
    tx.create('testing', id, { ...ref, cycle, testPlan: input.testPlan, testDate: input.testDate, engineerId: input.engineerId, environment: input.environment, status: 'Not Started' }, `Test cycle ${cycle} created`);
    ensureStages(tx, pid, itemId, {});
    touchStage(tx, itemId, 'A', 'testing', 'start');
    tx.notify(ifAllowed(input.engineerId, 'testing.view', pid), { title: `Test cycle assigned: ${ref.itemCode} (cycle ${cycle})`, body: `Project ${pid}.`, link: `#/items/${pid}/${itemId}`, module: 'testing' });
    return id;
  });
}

export async function recordTestResult(pid, id, { status, result, observations, issues, testDate }) {
  requireAny(['testing.updateStatus'], pid, 'record test results');
  const t = need('testing', pid, id, 'Test cycle');
  if (!['Not Started', 'In Progress'].includes(t.status)) throw new AppError(`Test cycle ${t.cycle} is "${t.status}". Recorded results are never overwritten — create a new cycle instead.`);
  if (!['In Progress', 'Passed', 'Failed', 'Retest Required'].includes(status)) throw new AppError('Choose the test status.');
  if (['Failed', 'Retest Required'].includes(status) && !observations?.trim()) throw new AppError('Record the observations for a failed or inconclusive test.');
  if (status !== 'In Progress' && !result?.trim()) throw new AppError('Record the test result.');
  await runTx(pid, (tx) => {
    tx.patch('testing', id, { status, result, observations, issues, testDate: testDate || t.testDate || today() }, `Test cycle ${t.cycle}: ${status}`);
    if (status === 'Failed') {
      // Failed testing reopens development; this cycle stays as it is, for ever.
      const dev = store.get('development', pid, t.itemId);
      if (dev) tx.patch('development', t.itemId, { status: 'Reopened', reopenCount: num(dev.reopenCount) + 1, lastFailedTestId: id }, `Development reopened: test cycle ${t.cycle} failed`);
      touchStage(tx, t.itemId, 'A', 'development', 'reopen');
      tx.notify([...recipients('development.updateStatus', pid, { depts: ['development'] }), ...ifAllowed(dev?.engineerId, 'development.view', pid)],
        { title: `Testing failed: ${t.itemCode} (cycle ${t.cycle}) — development reopened`, body: observations || '', link: `#/items/${pid}/${t.itemId}`, module: 'testing' });
    } else if (status === 'Passed') {
      tx.notify(recipients('testing.approve', pid), { title: `Test passed — approval needed: ${t.itemCode} (cycle ${t.cycle})`, body: `Project ${pid}.`, link: `#/items/${pid}/${t.itemId}`, module: 'testing' });
    }
  });
}

export async function approveTest(pid, id) {
  requirePerm('testing.approve', pid, 'approve test results');
  const t = need('testing', pid, id, 'Test cycle');
  if (t.status !== 'Passed') throw new AppError('Only a passed test cycle can be approved.');
  await runTx(pid, (tx) => {
    tx.patch('testing', id, { status: 'Approved', approverId: me(), approverName: session.user.displayName, decisionAt: Date.now() }, `Test cycle ${t.cycle} approved`);
    touchStage(tx, t.itemId, 'A', 'testing', 'complete');
    tx.notify(recipients('closure.approve', pid), { title: `Testing approved: ${t.itemCode}`, body: `Project ${pid}, cycle ${t.cycle}.`, link: `#/items/${pid}/${t.itemId}`, module: 'testing' });
  });
}
