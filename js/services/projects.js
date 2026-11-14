/** Projects and project items (BOM). */
import { store } from './store.js';
import { can, requirePerm, requireAny, me } from './session.js';
import { runTx } from './tx.js';
import { ifAllowed } from './notify.js';
import { ENTITIES, PRIORITIES, PROJECT_STATUSES } from '../config/entities.js';
import { AppError, num } from '../utils/format.js';

const PID_RE = /^[A-Z0-9][A-Z0-9-]{1,23}$/;
const PROJECT_FIELDS = ENTITIES.projects.fields.filter((f) => !f.sys && f.g === 'core').map((f) => f.name);
const ITEM_FIELDS = ENTITIES.projectItems.fields.filter((f) => !f.sys).map((f) => f.name);
const pickFields = (obj, names) => Object.fromEntries(names.filter((n) => n in obj).map((n) => [n, obj[n]]));

function validateProject(d) {
  if (!d.name?.trim()) throw new AppError('Enter the project name.');
  if (!d.managerId) throw new AppError('Choose the project manager.');
  if (!d.departmentId) throw new AppError('Choose the department.');
  if (!d.startDate || !d.targetDate) throw new AppError('Enter the start date and the target completion date.');
  if (d.targetDate < d.startDate) throw new AppError('The target completion date cannot be before the start date.');
  if (!PRIORITIES.includes(d.priority)) throw new AppError('Choose the priority.');
  if (d.budget !== undefined && d.budget !== '' && num(d.budget) < 0) throw new AppError('The budget cannot be negative.');
}
const indexUpdates = (tx, pid, d, old) => {
  if (old?.managerId && old.managerId !== d.managerId) tx.set(`/projectIndex/byManager/${old.managerId}/${pid}`, null);
  if (old?.departmentId && old.departmentId !== d.departmentId) tx.set(`/projectIndex/byDept/${old.departmentId}/${pid}`, null);
  if (d.managerId) tx.set(`/projectIndex/byManager/${d.managerId}/${pid}`, true);
  if (d.departmentId) tx.set(`/projectIndex/byDept/${d.departmentId}/${pid}`, true);
};

export async function createProject(input) {
  requirePerm('projects.create', undefined, 'create projects');
  const pid = String(input.id || '').trim().toUpperCase();
  if (!PID_RE.test(pid)) throw new AppError('Project ID: 2–24 characters, capital letters, digits and hyphens only (for example DRN-X1).');
  if (store.project(pid)) throw new AppError(`Project ID ${pid} is already in use.`);
  const d = pickFields(input, PROJECT_FIELDS);
  validateProject(d);
  const status = input.status || 'Planning';
  if (!['Planning', 'Active', 'On Hold'].includes(status)) throw new AppError('A new project starts as Planning, Active or On Hold. Completion and cancellation go through project closure.');
  if (d.budget !== undefined && d.budget !== '') d.budget = num(d.budget);
  await runTx(pid, (tx) => {
    tx.create('projects', pid, { ...d, status, clonedFrom: input.clonedFrom }, 'Project created');
    indexUpdates(tx, pid, d, null);
    tx.notify(ifAllowed(d.managerId, 'projects.view', undefined), { title: `New project assigned: ${pid} — ${d.name}`, body: 'You are the project manager.', link: `#/projects/${pid}`, module: 'projects' });
  });
  return pid;
}

export async function updateProject(pid, input) {
  requirePerm('projects.edit', pid, 'edit this project');
  const cur = store.project(pid);
  if (!cur) throw new AppError('Project not found.');
  const d = { ...pickFields(cur, PROJECT_FIELDS), ...pickFields(input, PROJECT_FIELDS) };
  validateProject(d);
  if (d.budget !== undefined && d.budget !== '') d.budget = num(d.budget);
  await runTx(pid, (tx) => {
    tx.patch('projects', pid, d, 'Project details edited');
    indexUpdates(tx, pid, d, cur);
    if (d.managerId !== cur.managerId) tx.notify([d.managerId], { title: `Project assigned: ${pid} — ${d.name}`, body: 'You are now the project manager.', link: `#/projects/${pid}`, module: 'projects' });
  });
}

/** Planning / Active / On Hold. Completed and Cancelled are only reachable through closure. */
export async function setProjectStatus(pid, status) {
  requirePerm('projects.updateStatus', pid, 'change the status of this project');
  const cur = store.project(pid);
  if (!PROJECT_STATUSES.includes(status) || ['Completed', 'Cancelled'].includes(status)) throw new AppError('Use project closure to complete or cancel a project.');
  if (['Completed', 'Cancelled'].includes(cur.status)) throw new AppError('This project is closed. Reopen it from the Closure tab first.');
  await runTx(pid, (tx) => tx.patch('projects', pid, { status }, `Project status: ${cur.status} → ${status}`));
}

export async function setProjectArchived(pid, archived) {
  requirePerm('projects.edit', pid, 'archive this project');
  await runTx(pid, (tx) => tx.patch('projects', pid, { archived: archived ? true : null }, archived ? 'Project archived' : 'Project restored from archive'));
}

/** Copy a project's definition (and optionally its BOM) into a new project. No transactions are copied. */
export async function cloneProject(srcPid, { id, name, includeItems = true }) {
  requirePerm('projects.create', undefined, 'create projects');
  const src = store.project(srcPid);
  if (!src) throw new AppError('Project not found.');
  const pid = await createProject({ ...pickFields(src, PROJECT_FIELDS), id, name: name || `${src.name} (copy)`, status: 'Planning', clonedFrom: srcPid });
  if (includeItems && can('items.create')) {
    const items = store.list('projectItems', srcPid);
    if (items.length) {
      await runTx(pid, async (tx) => {
        for (const it of items) tx.create('projectItems', await tx.nextId('projectItems'), { ...pickFields(it, ITEM_FIELDS), itemStatus: 'Open' }, `Item copied from ${srcPid}`);
      });
    }
  }
  return pid;
}

/* ------------------------------------------------------------------ items */
function validateItem(d) {
  if (!d.itemCode?.trim()) throw new AppError('Enter the item code.');
  if (!d.name?.trim()) throw new AppError('Enter the item name.');
  if (!(num(d.requiredQty) > 0)) throw new AppError('The required quantity must be greater than zero.');
  if (!d.uom) throw new AppError('Choose the unit of measurement.');
  if (d.estUnitCost !== undefined && d.estUnitCost !== '' && num(d.estUnitCost) < 0) throw new AppError('The estimated unit cost cannot be negative.');
}
const cleanItem = (input) => {
  const d = pickFields(input, ITEM_FIELDS);
  if ('requiredQty' in d) d.requiredQty = num(d.requiredQty);
  if (d.estUnitCost !== undefined && d.estUnitCost !== '') d.estUnitCost = num(d.estUnitCost);
  if (d.itemCode) d.itemCode = d.itemCode.trim();
  return d;
};
function assertProjectOpen(pid) {
  const p = store.project(pid);
  if (!p) throw new AppError('Project not found, or you do not have access to it.');
  if (['Completed', 'Cancelled'].includes(p.status)) throw new AppError(`Project ${pid} is ${p.status.toLowerCase()}. Its records can no longer be changed.`);
  return p;
}
export { assertProjectOpen };

/** Other active items of the project with the same item code (for the duplicate warning). */
export const duplicateItems = (pid, itemCode, exceptId) => store.where('projectItems', pid, (i) => i.id !== exceptId && i.itemCode?.toLowerCase() === String(itemCode || '').trim().toLowerCase());

export async function addItem(pid, input) {
  requirePerm('items.create', pid, 'add items to this project');
  assertProjectOpen(pid);
  const d = cleanItem(input);
  validateItem(d);
  return runTx(pid, async (tx) => {
    const id = await tx.nextId('projectItems');
    tx.create('projectItems', id, { ...d, itemStatus: 'Open' }, 'Item added to the BOM');
    return id;
  });
}

export async function updateItem(pid, itemId, input) {
  requirePerm('items.edit', pid, 'edit items of this project');
  assertProjectOpen(pid);
  const cur = store.get('projectItems', pid, itemId);
  if (!cur) throw new AppError('Item not found.');
  const d = { ...pickFields(cur, ITEM_FIELDS), ...cleanItem(input) };
  validateItem(d);
  if (d.requiredQty !== cur.requiredQty && store.get('inventoryChecks', pid, itemId)) {
    throw new AppError('The required quantity cannot be changed after the availability check. Use "Request additional material" or adjust the stock transfer instead, so every quantity stays traceable.');
  }
  await runTx(pid, (tx) => tx.patch('projectItems', itemId, d, 'Item edited'));
}

export async function removeItem(pid, itemId) {
  requirePerm('items.delete', pid, 'remove items');
  assertProjectOpen(pid);
  if (store.get('inventoryChecks', pid, itemId)) throw new AppError('This item already has an availability check and linked transactions. It cannot be removed — cancel it instead so its history is kept.');
  await runTx(pid, (tx) => tx.patch('projectItems', itemId, { deleted: true }, 'Item removed from the BOM'));
}

export async function duplicateItem(pid, itemId) {
  const cur = store.get('projectItems', pid, itemId);
  if (!cur) throw new AppError('Item not found.');
  return addItem(pid, pickFields(cur, ITEM_FIELDS));
}

/** Change priority / required-by date / preferred vendor for many items at once. */
export async function bulkUpdateItems(pid, itemIds, changes) {
  requirePerm('items.edit', pid, 'edit items of this project');
  assertProjectOpen(pid);
  const allowed = pickFields(changes, ['priority', 'requiredBy', 'preferredVendor', 'remarks']);
  if (!Object.keys(allowed).length) throw new AppError('Choose at least one field to change.');
  await runTx(pid, (tx) => { for (const id of itemIds) tx.patch('projectItems', id, allowed, 'Item edited (bulk update)'); });
  return itemIds.length;
}

export const BOM_COLUMNS = ['itemCode', 'name', 'description', 'requiredQty', 'uom', 'specs', 'priority', 'preferredVendor', 'estUnitCost', 'requiredBy', 'remarks'];

/** Validate BOM rows from a CSV file. Returns { valid: [...], errors: [{row, message}] } without writing anything. */
export function checkBomRows(pid, rows) {
  const header = (rows[0] || []).map((h) => h.trim());
  const col = (name) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const missing = ['itemCode', 'name', 'requiredQty', 'uom'].filter((c) => col(c) < 0);
  if (missing.length) return { valid: [], errors: [{ row: 1, message: `Missing column(s): ${missing.join(', ')}. Download the template to see the expected headings.` }] };
  const valid = []; const errors = [];
  const units = store.settings().units || [];
  rows.slice(1).forEach((r, i) => {
    const d = {};
    for (const c of BOM_COLUMNS) { const ix = col(c); if (ix >= 0 && r[ix] !== undefined && r[ix].trim() !== '') d[c] = r[ix].trim(); }
    try {
      if (d.requiredQty !== undefined && Number.isNaN(Number(d.requiredQty))) throw new AppError('requiredQty is not a number.');
      if (d.estUnitCost !== undefined && Number.isNaN(Number(d.estUnitCost))) throw new AppError('estUnitCost is not a number.');
      const c = cleanItem(d);
      validateItem(c);
      if (c.priority && !PRIORITIES.includes(c.priority)) throw new AppError(`priority must be one of: ${PRIORITIES.join(', ')}.`);
      if (c.requiredBy && !/^\d{4}-\d{2}-\d{2}$/.test(c.requiredBy)) throw new AppError('requiredBy must be written as YYYY-MM-DD.');
      if (units.length && !units.includes(c.uom)) throw new AppError(`uom "${c.uom}" is not in the list of units (${units.join(', ')}).`);
      valid.push({ ...c, _duplicate: duplicateItems(pid, c.itemCode).length > 0 || valid.some((v) => v.itemCode.toLowerCase() === c.itemCode.toLowerCase()) });
    } catch (e) { errors.push({ row: i + 2, message: e.message }); }
  });
  return { valid, errors };
}

export async function importBom(pid, validRows) {
  requirePerm('items.create', pid, 'add items to this project');
  assertProjectOpen(pid);
  await runTx(pid, async (tx) => {
    for (const r of validRows) {
      const { _duplicate, ...d } = r;
      tx.create('projectItems', await tx.nextId('projectItems'), { ...d, itemStatus: 'Open' }, 'Item imported from CSV');
    }
  });
  return validRows.length;
}

/** Close or cancel a single item (the "Item closure" stage). */
export async function setItemStatus(pid, itemId, status, { reason } = {}) {
  requireAny(['items.updateStatus', 'closure.approve', 'closure.updateStatus'], pid, 'close or cancel items');
  const cur = store.get('projectItems', pid, itemId);
  if (!cur) throw new AppError('Item not found.');
  if (!['Open', 'Closed', 'Cancelled'].includes(status)) throw new AppError('Unknown item status.');
  await runTx(pid, (tx) => tx.patch('projectItems', itemId, { itemStatus: status, closedAt: status === 'Open' ? null : Date.now(), closedBy: status === 'Open' ? null : me() },
    `Item status: ${cur.itemStatus || 'Open'} → ${status}${reason ? ` (${reason})` : ''}`));
}
