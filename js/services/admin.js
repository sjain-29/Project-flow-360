/**
 * Administration — Super Admin only (section 4): users, roles, departments,
 * settings. Every function re-checks on the client, and the security rules
 * re-check on the server: /users, /acl, /roles, /departments and /settings can
 * only be written by an account whose own /acl entry says "sa: true".
 *
 * Because there are no Cloud Functions, the Super Admin's browser is what
 * recomputes the effective permissions (/acl) of affected users whenever a
 * user, a role or the module→department mapping changes — always in the same
 * atomic write as the change itself.
 */
import { be } from './backend.js';
import { store } from './store.js';
import { session, isSuperAdmin, audit, authEmail, validatePassword } from './session.js';
import { computeAcl } from './permissions.js';
import { newUserRecord } from './seed.js';
import { MODULES, moduleActions, USERNAME_RE } from '../config/app-config.js';
import { AppError } from '../utils/format.js';

const sa = () => { if (!isSuperAdmin()) throw new AppError('Only the Super Admin can do this.'); };
const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
const clean = (o) => JSON.parse(JSON.stringify(o));

/** /acl updates for every active user matching `filter`, computed against the given roles / settings. */
function aclUpdates({ users = store.users(), roles = store.roles(), settings = store.settings(), filter = () => true } = {}) {
  const u = {};
  for (const user of users) {
    if (!user.authUid || !filter(user)) continue;
    u[`/acl/${user.authUid}`] = user.active === false ? null : computeAcl(user.id, user, roles, settings);
  }
  return u;
}

function normaliseUser(input) {
  const departments = {};
  for (const d of input.departmentIds || []) departments[d] = true;
  if (input.departmentId) departments[input.departmentId] = true;
  if (!Object.keys(departments).length) throw new AppError('Choose at least one department.');
  const projects = {};
  for (const p of input.projectIds || []) projects[p] = true;
  const overrides = {};
  for (const [m, acts] of Object.entries(input.overrides || {})) for (const [a, v] of Object.entries(acts)) if (v === true || v === false) (overrides[m] ||= {})[a] = v;
  return {
    displayName: String(input.displayName || '').trim(), roleId: input.roleId,
    departmentId: input.departmentId || Object.keys(departments)[0], departments,
    scope: input.roleId === 'super_admin' ? 'all' : (['all', 'dept', 'selected'].includes(input.scope) ? input.scope : 'selected'),
    projects: Object.keys(projects).length ? projects : null,
    overrides: Object.keys(overrides).length ? overrides : null,
    email: input.email?.trim() || null, phone: input.phone?.trim() || null,
  };
}

export async function createUser(input) {
  sa();
  const username = String(input.username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) throw new AppError('Username: 2–32 characters, starting with a letter; lowercase letters, digits, "_" and "-" only.');
  const userId = `u_${username}`;
  if (store.user(userId) || store.loginIndex()[username]) throw new AppError(`The username "${username}" is already in use.`);
  const d = normaliseUser(input);
  if (!d.displayName) throw new AppError('Enter the display name.');
  if (!store.role(d.roleId)) throw new AppError('Choose a role.');
  const pwErr = validatePassword(input.tempPassword, username);
  if (pwErr) throw new AppError(`Temporary password: ${pwErr}`);
  const b = be();
  const authUid = await b.auth.adminCreateUser(authEmail(username, 1), input.tempPassword);
  const rec = clean({ ...newUserRecord({ username, displayName: d.displayName, roleId: d.roleId, departmentId: d.departmentId, departments: d.departments, scope: d.scope, authUid, mustChangePassword: true, now: 0 }), ...d });
  rec.createdAt = b.serverTimestamp();
  await b.update({ [`/users/${userId}`]: rec, [`/acl/${authUid}`]: computeAcl(userId, rec, store.roles(), store.settings()), [`/loginIndex/${username}`]: { v: 1, userId } });
  await audit('User created', { rtype: 'users', rid: userId, new: { username, displayName: d.displayName, roleId: d.roleId, departments: Object.keys(d.departments), scope: d.scope } });
  return userId;
}

export async function updateUser(userId, input) {
  sa();
  const cur = store.user(userId);
  if (!cur) throw new AppError('User not found.');
  const d = normaliseUser({ ...input });
  if (!d.displayName) throw new AppError('Enter the display name.');
  if (!store.role(d.roleId)) throw new AppError('Choose a role.');
  if (userId === session.userId && d.roleId !== 'super_admin') throw new AppError('You cannot remove your own Super Admin role. Ask another Super Admin to do it.');
  const next = clean({ ...cur, ...d });
  delete next.id;
  for (const k of ['projects', 'overrides', 'email', 'phone']) if (d[k] === null) delete next[k];
  const updates = {};
  for (const k of ['displayName', 'roleId', 'departmentId', 'departments', 'scope', 'projects', 'overrides', 'email', 'phone']) updates[`/users/${userId}/${k}`] = d[k];
  if (cur.authUid && cur.active !== false) updates[`/acl/${cur.authUid}`] = computeAcl(userId, next, store.roles(), store.settings());
  await be().update(updates);
  const changed = {};
  const oldV = {};
  for (const k of ['displayName', 'roleId', 'departments', 'scope', 'projects', 'overrides']) if (JSON.stringify(cur[k] ?? null) !== JSON.stringify(d[k] ?? null)) { changed[k] = d[k]; oldV[k] = cur[k] ?? null; }
  if (Object.keys(changed).length) {
    await audit(changed.roleId ? `Role changed: ${store.role(cur.roleId)?.name || cur.roleId} → ${store.role(d.roleId)?.name}` : (changed.overrides || changed.projects || changed.scope ? 'User permissions changed' : 'User edited'), { rtype: 'users', rid: userId, old: oldV, new: changed });
  }
}

/** Deactivate (preferred over deletion) or reactivate. Deactivation removes /acl, which ends all access at once. */
export async function setUserActive(userId, active) {
  sa();
  const cur = store.user(userId);
  if (!cur) throw new AppError('User not found.');
  if (userId === session.userId && !active) throw new AppError('You cannot deactivate your own account.');
  const next = { ...cur, active };
  await be().update({ [`/users/${userId}/active`]: active, [`/acl/${cur.authUid}`]: active ? computeAcl(userId, next, store.roles(), store.settings()) : null });
  await audit(active ? 'User reactivated' : 'User deactivated', { rtype: 'users', rid: userId });
}

/**
 * Secure password reset without e-mail and without the Admin SDK: a NEW sign-in
 * account is issued for the same person (same user ID, same history) and the old
 * one loses all access. The user must change the temporary password at next login.
 */
export async function resetUserPassword(userId, tempPassword) {
  sa();
  const cur = store.user(userId);
  if (!cur) throw new AppError('User not found.');
  const pwErr = validatePassword(tempPassword, cur.username);
  if (pwErr) throw new AppError(`Temporary password: ${pwErr}`);
  const b = be();
  const idx = store.loginIndex()[cur.username] || (await b.get(`/loginIndex/${cur.username}`)) || { v: 1 };
  const v = (idx.v || 1) + 1;
  const authUid = await b.auth.adminCreateUser(authEmail(cur.username, v), tempPassword);
  const updates = {
    [`/loginIndex/${cur.username}`]: { v, userId },
    [`/users/${userId}/authUid`]: authUid,
    [`/users/${userId}/mustChangePassword`]: true,
    [`/acl/${authUid}`]: cur.active === false ? null : computeAcl(userId, { ...cur, authUid }, store.roles(), store.settings()),
  };
  if (cur.authUid) updates[`/acl/${cur.authUid}`] = null;
  await b.update(updates);
  await audit('Password reset by administrator (new sign-in issued)', { rtype: 'users', rid: userId });
  return { reissuedOwnAccount: userId === session.userId };
}

/* ------------------------------------------------------------------ roles */
function normalisePermissions(perms) {
  const out = {};
  for (const m of MODULES) for (const a of moduleActions(m)) if (perms?.[m.id]?.[a] === true) (out[m.id] ||= {})[a] = true;
  return out;
}

export async function saveRole(roleId, input) {
  sa();
  const roles = store.roles();
  const isNew = !roleId;
  const id = roleId || slug(input.name);
  if (!input.name?.trim()) throw new AppError('Enter the role name.');
  if (isNew && (!id || roles[id])) throw new AppError('A role with this name already exists.');
  if (id === 'super_admin') throw new AppError('The Super Admin role always has every permission and cannot be edited.');
  const cur = roles[id];
  const role = clean({ name: input.name.trim(), description: input.description || '', deptRestricted: !!input.deptRestricted, dashboard: input.dashboard || 'user', system: cur?.system || null, permissions: normalisePermissions(input.permissions) });
  const nextRoles = { ...roles, [id]: role };
  await be().update({ [`/roles/${id}`]: role, ...aclUpdates({ roles: nextRoles, filter: (u) => u.roleId === id }) });
  await audit(isNew ? 'Role created' : 'Role permissions changed', { rtype: 'roles', rid: id, old: cur ? { deptRestricted: cur.deptRestricted, permissions: cur.permissions } : null, new: { deptRestricted: role.deptRestricted, permissions: role.permissions } });
  return id;
}

export async function deleteRole(roleId) {
  sa();
  const role = store.role(roleId);
  if (!role) throw new AppError('Role not found.');
  if (role.system) throw new AppError('The five standard roles cannot be deleted.');
  const used = store.users().filter((u) => u.roleId === roleId);
  if (used.length) throw new AppError(`${used.length} user(s) still have this role. Give them another role first.`);
  await be().update({ [`/roles/${roleId}`]: null });
  await audit('Role deleted', { rtype: 'roles', rid: roleId, old: { name: role.name } });
}

/* ------------------------------------------------------------------ departments */
export async function saveDepartment(deptId, input) {
  sa();
  const isNew = !deptId;
  const id = deptId || slug(input.name);
  if (!input.name?.trim()) throw new AppError('Enter the department name.');
  const cur = store.departments().find((d) => d.id === id);
  if (isNew && (!id || cur)) throw new AppError('A department with this name already exists.');
  const active = input.active !== false;
  if (!active && store.users().some((u) => u.active !== false && u.departmentId === id)) throw new AppError('Active users still have this as their main department. Move them first.');
  const rec = { name: input.name.trim(), active, order: cur?.order ?? store.departments().length };
  await be().update({ [`/departments/${id}`]: rec });
  await audit(isNew ? 'Department created' : (cur.active !== false && !active ? 'Department deactivated' : 'Department edited'), { rtype: 'departments', rid: id, old: cur ? { name: cur.name, active: cur.active } : null, new: rec });
  return id;
}

/* ------------------------------------------------------------------ settings */
export async function saveSettings(patch) {
  sa();
  const cur = store.settings();
  const next = clean({ ...cur, ...patch });
  for (const k of ['sessionIdleMinutes', 'sessionMaxHours', 'dueSoonDays', 'upcomingDays', 'rgpReminderDays', 'maxInlineFileKb']) {
    if (k in patch && !(Number(patch[k]) > 0)) throw new AppError('Numbers in Settings must be greater than zero.');
    if (k in next) next[k] = Number(next[k]);
  }
  if (next.maxInlineFileKb > 750) throw new AppError('Files stored in the database are limited to 750 KB.');
  if (next.upcomingDays < next.dueSoonDays) throw new AppError('"Upcoming" must be at least as many days as "Due soon".');
  const updates = {};
  for (const k of Object.keys(patch)) updates[`/settings/${k}`] = next[k] ?? null;
  // the module → department mapping feeds every department-restricted permission
  if ('moduleDepartments' in patch) Object.assign(updates, aclUpdates({ settings: next }));
  await be().update(updates);
  await audit('Settings changed', { rtype: 'settings', rid: Object.keys(patch).join(', '), old: Object.fromEntries(Object.keys(patch).map((k) => [k, cur[k] ?? null])), new: patch });
}

/** Repair tool: recompute every user's effective permissions from roles and settings. */
export async function recomputeAllPermissions() {
  sa();
  await be().update(aclUpdates());
  await audit('Effective permissions recomputed for all users');
}
