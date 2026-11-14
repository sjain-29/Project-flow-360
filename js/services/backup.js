/**
 * Backup and restore (section 30) — Super Admin only.
 *
 * Export: the Super Admin may read the whole database (root-level read rule), so
 * a full JSON backup can be downloaded at any time.
 * Restore: a backup is always validated first. In demo mode it is then applied in
 * the browser. In Firebase mode the app deliberately does NOT write it: the
 * security rules give no account — not even the Super Admin — the power to
 * overwrite history or audit logs. The validated file is imported by the project
 * owner in the Firebase console (README → "Restore a backup").
 */
import { be, isDemo } from './backend.js';
import { isSuperAdmin, audit } from './session.js';
import { ENTITIES, SCOPED } from '../config/entities.js';
import { AppError } from '../utils/format.js';

const TOP = ['system', 'acl', 'users', 'loginIndex', 'roles', 'departments', 'settings', 'projectIndex', 'counters', 'activityLogs', 'auditLogs', 'notifications', 'comments', 'documents', 'documentBlobs', 'projects', 'inventory', ...SCOPED];

export const PARTIAL_EXPORTS = [
  ['projects', 'Project records', ['projects', 'closures', 'stages']],
  ['bom', 'BOM data', ['projectItems']],
  ['procurement', 'Procurement records', ['procurement', 'purchaseRequests', 'quotations', 'purchaseOrders', 'proformaInvoices', 'dispatches']],
  ['payments', 'Payment records', ['payments', 'paymentAdjustments']],
  ['material', 'Material movement records', ['inventory', 'inventoryChecks', 'stockTransfers', 'materialReceipts', 'materialRequests', 'gvtReceipts', 'logistics', 'gatePasses', 'gatePassReturns']],
  ['audit', 'Audit logs', ['auditLogs', 'activityLogs']],
];

export async function exportAll() {
  if (!isSuperAdmin()) throw new AppError('Only the Super Admin can export a backup.');
  const data = isDemo() ? be().exportAll() : (await be().get('/')) || {};
  await audit('Backup exported').catch(() => {});
  return { format: 'projectflow360-backup', version: 1, exportedAt: new Date().toISOString(), mode: be().mode, data };
}
export const pickPartial = (backup, keys) => ({ ...backup, partial: keys, data: Object.fromEntries(keys.filter((k) => backup.data[k]).map((k) => [k, backup.data[k]])) });

/** Structural validation of a backup file. Returns { ok, errors, summary } and never writes anything. */
export function validateBackup(file) {
  const errors = [];
  const summary = {};
  if (!file || file.format !== 'projectflow360-backup' || typeof file.data !== 'object' || !file.data) return { ok: false, errors: ['This is not a ProjectFlow 360 backup file.'], summary };
  if (file.partial) errors.push('This is a partial export (selected records only). Only a full backup can be restored.');
  const d = file.data;
  for (const k of Object.keys(d)) if (!TOP.includes(k)) errors.push(`Unknown section "${k}".`);
  for (const k of ['system', 'users', 'roles', 'departments', 'settings', 'acl']) if (!d[k] || typeof d[k] !== 'object') errors.push(`Missing section "${k}".`);
  if (d.system && d.system.initialized !== true) errors.push('The backup is from a system that was never initialised.');
  if (d.roles && !d.roles.super_admin) errors.push('The Super Admin role is missing.');
  const admins = Object.values(d.users || {}).filter((u) => u.roleId === 'super_admin' && u.active !== false);
  if (d.users && !admins.length) errors.push('The backup contains no active Super Admin — restoring it would lock everyone out.');
  for (const [id, u] of Object.entries(d.users || {})) if (!u.username || !u.displayName || !u.roleId) errors.push(`User "${id}" is incomplete.`);
  for (const [pid, p] of Object.entries(d.projects || {})) if (!p?.core?.name || !p?.meta?._v) errors.push(`Project "${pid}" is incomplete.`);
  summary.Users = Object.keys(d.users || {}).length;
  summary.Projects = Object.keys(d.projects || {}).length;
  for (const coll of SCOPED) {
    let n = 0;
    for (const [pid, recs] of Object.entries(d[coll] || {})) {
      if (!d.projects?.[pid]) errors.push(`${ENTITIES[coll].label}: records exist for unknown project "${pid}".`);
      for (const [id, r] of Object.entries(recs || {})) { n++; if (!r?.meta?._v || !r?.meta?.createdBy) errors.push(`${ENTITIES[coll].label} "${pid}/${id}" has no valid metadata.`); }
    }
    if (n) summary[ENTITIES[coll].label] = n;
  }
  summary['Audit entries'] = Object.keys(d.auditLogs || {}).length + Object.values(d.activityLogs || {}).reduce((a, x) => a + Object.keys(x).length, 0);
  return { ok: errors.length === 0, errors: errors.slice(0, 40), summary };
}

/** Demo mode only: replace the browser's demo database with a validated backup. */
export async function restoreDemo(file) {
  if (!isSuperAdmin()) throw new AppError('Only the Super Admin can restore a backup.');
  if (!isDemo()) throw new AppError('In Firebase mode a backup is restored through the Firebase console (see README → "Restore a backup").');
  const v = validateBackup(file);
  if (!v.ok) throw new AppError(`The backup failed validation: ${v.errors[0]}`);
  be().importAll(file.data);
}
