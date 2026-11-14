/**
 * Comments, attachments and activity history (sections 24–25). These are loaded
 * on demand, per project and per module, because the security rules scope them
 * that way: a comment or document on a payment is only readable by people who
 * may view payments.
 */
import { be } from './backend.js';
import { store } from './store.js';
import { session, can, me, isSuperAdmin } from './session.js';
import { ENTITIES } from '../config/entities.js';
import { FILE_TYPES } from '../config/app-config.js';
import { AppError } from '../utils/format.js';

export const moduleOf = (coll) => (coll === 'stages' ? 'items' : ENTITIES[coll]?.module || coll);
const asList = (obj) => Object.entries(obj || {}).map(([id, v]) => ({ id, ...v }));

/* ------------------------------------------------------------------ comments */
/** Live comments of one record. Returns an unsubscribe function. */
export function watchComments(coll, pid, rid, cb) {
  const mod = moduleOf(coll);
  if (!can('comments.view', pid) || !can(`${mod}.view`, pid)) { cb([]); return () => {}; }
  const merged = {};
  const emit = () => cb(Object.values(merged).flat().filter((c) => c.rid === rid && c.rtype === coll).sort((a, b) => a.at - b.at));
  if (can('comments.viewAll')) {
    return be().subscribe(`/comments/${pid}/${mod}`, (v) => { merged.all = Object.entries(v || {}).flatMap(([dept, list]) => asList(list).map((c) => ({ ...c, deptKey: dept }))); emit(); }, () => cb([]));
  }
  // Without "view all departments" the rules only allow reading the user's own departments' comments.
  const uns = Object.keys(session.acl.d || {}).map((d) => be().subscribe(`/comments/${pid}/${mod}/${d}`, (v) => { merged[d] = asList(v).map((c) => ({ ...c, deptKey: d })); emit(); }, () => {}));
  return () => uns.forEach((u) => u());
}
export const canComment = (coll, pid) => can('comments.create', pid) && can(`${moduleOf(coll)}.comment`, pid);

export async function addComment(coll, pid, rid, text) {
  if (!canComment(coll, pid)) throw new AppError('You do not have permission to comment here.');
  if (!text?.trim()) throw new AppError('Write a comment first.');
  const dept = session.user.departmentId;
  const b = be();
  await b.update({ [`/comments/${pid}/${moduleOf(coll)}/${dept}/${b.newId()}`]: { rtype: coll, rid, text: text.trim().slice(0, 4900), userId: me(), userName: session.user.displayName, dept: store.deptName(dept), at: b.serverTimestamp() } });
}
export async function editComment(coll, pid, c, text) {
  if (c.userId !== me() || !can('comments.edit')) throw new AppError('You can only edit your own comments.');
  if (!text?.trim()) throw new AppError('A comment cannot be empty.');
  const b = be(); const base = `/comments/${pid}/${moduleOf(coll)}/${c.deptKey}/${c.id}`;
  await b.update({ [`${base}/text`]: text.trim().slice(0, 4900), [`${base}/editedAt`]: b.serverTimestamp() });
}
export async function deleteComment(coll, pid, c) {
  if (c.userId !== me() || !can('comments.delete')) throw new AppError('You can only delete your own comments.');
  const base = `/comments/${pid}/${moduleOf(coll)}/${c.deptKey}/${c.id}`;
  await be().update({ [`${base}/deleted`]: true, [`${base}/text`]: null });
}

/* ------------------------------------------------------------------ documents */
export function watchDocuments(coll, pid, rid, cb) {
  const mod = moduleOf(coll);
  if (!can(`${mod}.view`, pid)) { cb([]); return () => {}; }
  return be().subscribe(`/documents/${pid}/${mod}`, (v) => cb(asList(v).filter((d) => !d.deleted && (!rid || (d.rid === rid && d.rtype === coll))).map((d) => ({ ...d, module: mod })).sort((a, b) => b.at - a.at)), () => cb([]));
}
/** All documents of a project that this user may see (one read per viewable module). */
export async function projectDocuments(pid) {
  const mods = [...new Set(Object.values(ENTITIES).map((e) => e.module))].filter((m) => m !== 'stages' && can(`${m}.view`, pid));
  const lists = await Promise.all(mods.map((m) => be().get(`/documents/${pid}/${m}`).then((v) => asList(v).filter((d) => !d.deleted).map((d) => ({ ...d, module: m }))).catch(() => [])));
  return lists.flat().sort((a, b) => b.at - a.at);
}
export const canUpload = (coll, pid) => can(`${moduleOf(coll)}.upload`, pid);

const docMeta = (coll, rid, name, category) => ({ rtype: coll, rid, name: String(name).slice(0, 190), category: category || 'Other', uploadedBy: me(), uploadedByName: session.user.displayName, at: be().serverTimestamp() });

export async function addLink(coll, pid, rid, { name, url, category }) {
  if (!canUpload(coll, pid)) throw new AppError('You do not have permission to attach documents here.');
  if (!name?.trim()) throw new AppError('Give the document a name.');
  if (!/^https?:\/\/\S+$/i.test(url || '')) throw new AppError('Enter a web address that starts with https:// (for example a shared-drive link).');
  await be().update({ [`/documents/${pid}/${moduleOf(coll)}/${be().newId()}`]: { ...docMeta(coll, rid, name.trim(), category), kind: 'link', url: url.trim() } });
}

/** Small files are stored inside the database (no Firebase Storage on the free plan). */
export async function addFile(coll, pid, rid, file, category) {
  if (!canUpload(coll, pid)) throw new AppError('You do not have permission to attach documents here.');
  const maxKb = store.settings().maxInlineFileKb || 500;
  if (!FILE_TYPES[file.type]) throw new AppError(`This file type is not allowed (${file.type || 'unknown'}). Allowed: PDF, Excel, CSV, Word, text and images.`);
  if (file.size > maxKb * 1024) throw new AppError(`This file is ${(file.size / 1024).toFixed(0)} KB. Files up to ${maxKb} KB can be stored here; for larger files attach a link to your shared drive instead.`);
  const data = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new AppError('The file could not be read.')); r.readAsDataURL(file); });
  const id = be().newId(); const mod = moduleOf(coll);
  await be().update({ [`/documents/${pid}/${mod}/${id}`]: { ...docMeta(coll, rid, file.name, category), kind: 'file', mime: file.type, size: file.size }, [`/documentBlobs/${pid}/${mod}/${id}`]: data });
}
export const fileData = (pid, doc) => be().get(`/documentBlobs/${pid}/${doc.module}/${doc.id}`);
export async function removeDocument(pid, doc) {
  if (doc.uploadedBy !== me() && !can(`${doc.module}.delete`, pid)) throw new AppError('You can only remove documents you attached.');
  await be().update({ [`/documents/${pid}/${doc.module}/${doc.id}/deleted`]: true });
}

/* ------------------------------------------------------------------ activity history / audit trail */
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const logRow = (id, l) => ({ id, ...l, old: parse(l.old), new: parse(l.new) });

/** Activity history of one project (needs "Project activity history → View"). */
export async function projectActivity(pid) {
  if (!can('activity.view', pid)) return [];
  const v = await be().get(`/activityLogs/${pid}`).catch(() => null);
  return Object.entries(v || {}).map(([id, l]) => logRow(id, l)).sort((a, b) => b.at - a.at);
}
export const recordHistory = async (coll, pid, rid) => (await projectActivity(coll === 'projects' ? rid : pid)).filter((l) => l.rid === rid && l.rtype === coll);

/** The complete organisation-wide audit trail — Super Admin only (the rules refuse everyone else). */
export async function fullAuditTrail() {
  if (!isSuperAdmin()) throw new AppError('Only the Super Admin can view the organisation-wide audit log.');
  const [sys, act] = await Promise.all([be().get('/auditLogs'), be().get('/activityLogs')]);
  const rows = Object.entries(sys || {}).map(([id, l]) => ({ id, ...l, rtype: l.rtype || 'system', pid: l.pid || '', old: parse(l.old), new: parse(l.new) }));
  for (const [pid, logs] of Object.entries(act || {})) for (const [id, l] of Object.entries(logs)) rows.push({ ...logRow(id, l), pid: pid === '_global' ? '' : pid });
  return rows.sort((a, b) => b.at - a.at);
}
