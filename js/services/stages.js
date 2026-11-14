/**
 * Workflow stages of an item.
 *
 * Status rules (section 17 of the specification):
 *   • A stage is NEVER completed because of a date. Dates only drive "due / overdue".
 *   • Recording a transaction (a PR, a dispatch, a receipt…) may move its own stage
 *     from "Not Started" to "In Progress" — that is the person's action, not a timer.
 *   • "Completed" is set only by an explicit decision of an authorised person:
 *     either the "Mark completed" action on the stage, or the decision that IS the
 *     stage (verifying availability, approving a PR, selecting the vendor, declaring
 *     development complete, approving a test).
 */
import { STAGE_TEMPLATES, STAGE_STATUSES, stageId, stageTemplate } from '../config/app-config.js';
import { store } from './store.js';
import { can, canAny, requireAny, me } from './session.js';
import { runTx } from './tx.js';
import { moduleOwners } from './permissions.js';
import { AppError, today } from '../utils/format.js';

export const branchOf = (procurementType) => (procurementType === 'Source Stock Replenishment' ? 'B' : 'A');

/** Stages of one item, in workflow order. */
export function itemStages(pid, itemId, branch) {
  return store.where('stages', pid, (s) => s.itemId === itemId && (!branch || s.branch === branch)).sort((a, b) => a.seq - b.seq);
}

/** Create the stages an item needs for the given paths (idempotent). */
export function ensureStages(tx, pid, itemId, { transfer = false, proc = false } = {}) {
  STAGE_TEMPLATES.forEach((t, i) => {
    const wanted = t.path === 'always' ? t.branch === 'A' : (t.path === 'transfer' ? transfer : proc);
    if (!wanted) return;
    const id = stageId(itemId, t.branch, t.key);
    if (tx.get('stages', id)) return;
    const owners = moduleOwners(t.module, store.settings());
    tx.create('stages', id, { itemId, branch: t.branch, key: t.key, name: t.name, module: t.module, seq: i, deptId: owners[0] || t.dept, status: 'Not Started' }, `Stage "${t.name}" added to the workflow`);
  });
}

/**
 * Move a stage as a consequence of a user's transaction.
 * mode: 'start' (Not Started → In Progress), 'wait' (→ Waiting for Approval),
 *       'complete' (explicit decision), 'reopen' (Completed → In Progress), 'reset' (→ Not Started)
 */
export function touchStage(tx, itemId, branch, key, mode = 'start') {
  const id = stageId(itemId, branch, key);
  const s = tx.get('stages', id);
  if (!s || s.status === 'Cancelled') return;
  const mod = s.module;
  const patch = {};
  if (mode === 'complete') {
    if (s.status === 'Completed') return;
    if (!canAny([`${mod}.updateStatus`, `${mod}.approve`])) { if (s.status === 'Not Started') Object.assign(patch, { status: 'In Progress', actStart: s.actStart || today() }); } else Object.assign(patch, { status: 'Completed', actStart: s.actStart || today(), actEnd: today() });
  } else if (mode === 'wait') {
    if (['Not Started', 'In Progress'].includes(s.status)) Object.assign(patch, { status: 'Waiting for Approval', actStart: s.actStart || today() });
  } else if (mode === 'reopen') {
    if (s.status !== 'In Progress') Object.assign(patch, { status: 'In Progress', actEnd: null, actStart: s.actStart || today() });
  } else if (mode === 'reset') {
    if (s.status !== 'Not Started') Object.assign(patch, { status: 'Not Started', actEnd: null });
  } else if (['Not Started', 'Waiting for Approval'].includes(s.status)) {
    Object.assign(patch, { status: 'In Progress', actStart: s.actStart || today() });
  }
  if (Object.keys(patch).length) tx.patch('stages', id, patch, `Stage "${s.name}": ${patch.status}`);
}

export const canPlanStage = (s, pid) => canAny([`${s.module}.updateStatus`, `${s.module}.edit`, `${s.module}.approve`, 'items.edit', 'projects.edit'], pid);
export const canUpdateStage = (s, pid) => canAny([`${s.module}.updateStatus`, `${s.module}.approve`], pid);

/** Manual update of a stage by an authorised person (planning fields and / or status). */
export async function updateStage(pid, id, changes) {
  const s = store.get('stages', pid, id);
  if (!s) throw new AppError('Stage not found.');
  const plan = {}; const status = {};
  for (const k of ['deptId', 'personId', 'expStart', 'expEnd', 'remarks']) if (k in changes) plan[k] = changes[k];
  for (const k of ['status', 'actStart', 'actEnd']) if (k in changes) status[k] = changes[k];
  if (plan.expStart && plan.expEnd && plan.expEnd < plan.expStart) throw new AppError('Expected completion cannot be before the expected start.');
  if (status.status && !STAGE_STATUSES.includes(status.status)) throw new AppError('Unknown stage status.');
  const planChanged = Object.keys(plan).some((k) => (plan[k] || '') !== (s[k] || ''));
  const statusChanged = Object.keys(status).some((k) => (status[k] || '') !== (s[k] || ''));
  if (planChanged && !canPlanStage(s, pid)) throw new AppError('You do not have permission to plan this stage.');
  if (statusChanged) {
    requireAny([`${s.module}.updateStatus`, `${s.module}.approve`], pid, 'update the status of this stage');
    if (status.status === 'Completed' && s.status !== 'Completed') status.actEnd = status.actEnd || today();
    if (status.status && status.status !== 'Not Started' && !s.actStart && !status.actStart) status.actStart = today();
    if (status.status && status.status !== 'Completed' && s.status === 'Completed') status.actEnd = null;
  }
  await runTx(pid, (tx) => {
    tx.patch('stages', id, { ...(planChanged ? plan : {}), ...(statusChanged ? status : {}) },
      statusChanged && status.status && status.status !== s.status ? `Stage "${s.name}": ${s.status} → ${status.status}` : `Stage "${s.name}" planning updated`);
  });
}

/** Add the optional SPIF → GVT movement stages to an item that was fulfilled from stock. */
export async function addMovementStages(pid, itemId) {
  requireAny(['items.edit', 'procurement.create', 'inventory.create'], pid, 'change the workflow of this item');
  await runTx(pid, (tx) => {
    STAGE_TEMPLATES.forEach((t, i) => {
      if (t.branch !== 'A' || !['mr', 'logistics', 'gvtReceipt'].includes(t.key)) return;
      const id = stageId(itemId, 'A', t.key);
      if (tx.get('stages', id)) return;
      tx.create('stages', id, { itemId, branch: 'A', key: t.key, name: t.name, module: t.module, seq: i, deptId: t.dept, status: 'Not Started' }, `Stage "${t.name}" added to the workflow`);
    });
  });
}

export { stageTemplate, me };
