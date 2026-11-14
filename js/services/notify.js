/**
 * Who should hear about an event? Only people who are allowed to open the
 * record: active users with the permission AND access to the project.
 */
import { store } from './store.js';
import { computeAcl, aclCan, aclHasProject } from './permissions.js';

let cache = { key: null, acls: [] };
function allAcls() {
  const users = store.users();
  const key = JSON.stringify([users.map((u) => [u.id, u.roleId, u.active, u.departments, u.scope, u.projects, u.overrides]), store.roles(), store.settings().moduleDepartments]);
  if (cache.key !== key) cache = { key, acls: users.filter((u) => u.active !== false).map((u) => computeAcl(u.id, u, store.roles(), store.settings())) };
  return cache.acls;
}

/** User IDs holding `perm` on project `pid` (optionally limited to departments). */
export function recipients(perm, pid, { depts } = {}) {
  const project = pid ? store.project(pid) : null;
  return allAcls()
    .filter((a) => aclCan(a, perm) && (!pid || aclHasProject(a, project, pid)) && (!depts || depts.some((d) => a.d?.[d])))
    .map((a) => a.userId);
}
/** A specific person, but only if they may view the module in that project. */
export function ifAllowed(userId, perm, pid) {
  return recipients(perm, pid).includes(userId) ? [userId] : [];
}
export const recordLink = (coll, pid, id) => `#/r/${coll}/${pid}/${encodeURIComponent(id)}`;
