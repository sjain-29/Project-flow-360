/**
 * Permission model.
 *
 * computeAcl() turns "role + departments + individual overrides" into the flat
 * list of effective permissions stored at /acl/{authUid}. The security rules only
 * ever read that list. The Super Admin's browser recomputes it whenever a user,
 * a role or the module→department mapping changes (see services/admin.js).
 */
import { MODULES, MODULE_BY_ID, moduleActions } from '../config/app-config.js';

export const moduleOwners = (moduleId, settings) => {
  const o = settings?.moduleDepartments?.[moduleId];
  return o ? Object.keys(o).filter((k) => o[k]) : (MODULE_BY_ID[moduleId]?.depts || []);
};

/** Does `role` (+ department restriction) grant module.action to this user? */
function roleGrants(user, role, settings, m, a) {
  if (!role?.permissions?.[m.id]?.[a]) return false;
  if (!role.deptRestricted) return true;
  const owners = moduleOwners(m.id, settings);
  if (!owners.length) return true;
  const inDept = owners.some((d) => user.departments?.[d]);
  if (['view', 'comment', 'export', 'viewAll'].includes(a)) return m.restrictView ? inDept : true;
  return inDept;
}

export function computePerms(user, roles, settings) {
  const role = roles?.[user.roleId];
  const sa = user.roleId === 'super_admin';
  const p = {};
  for (const m of MODULES) {
    for (const a of moduleActions(m)) {
      const o = user.overrides?.[m.id]?.[a];
      const ok = sa || (o === true) || (o !== false && roleGrants(user, role, settings, m, a));
      if (ok) (p[m.id] ||= {})[a] = true;
    }
  }
  return p;
}

/** The record stored at /acl/{authUid} for an ACTIVE user. */
export function computeAcl(userId, user, roles, settings) {
  const sa = user.roleId === 'super_admin';
  const acl = {
    userId,
    name: user.displayName,
    role: user.roleId,
    scope: sa ? 'all' : (user.scope || 'selected'),
    d: { ...(user.departments || {}) },
    p: computePerms(user, roles, settings),
  };
  if (sa) acl.sa = true;
  if (user.projects && Object.keys(user.projects).length) acl.prj = { ...user.projects };
  return acl;
}

export const aclCan = (acl, perm) => { const [m, a] = perm.split('.'); return acl?.p?.[m]?.[a] === true; };

/** Client-side mirror of the project access rule (the rules enforce the real thing). */
export function aclHasProject(acl, project, pid) {
  if (!acl) return false;
  if (acl.scope === 'all' || acl.prj?.[pid]) return true;
  if (!project) return false;
  if (project.managerId === acl.userId) return true;
  return acl.scope === 'dept' && !!acl.d?.[project.departmentId];
}
