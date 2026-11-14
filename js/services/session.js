/**
 * Sign-in, session and "who am I / what may I do" for the current browser.
 *
 * The permission checks here (can()) only decide what the interface offers.
 * The real enforcement is the Security Rules on the server.
 */
import { be } from './backend.js';
import { USERNAME_DOMAIN } from '../config/firebase-config.js';
import { USERNAME_RE, PASSWORD_MIN } from '../config/app-config.js';
import { aclCan, aclHasProject, computeAcl } from './permissions.js';
import { baseSeed, newUserRecord } from './seed.js';
import { AppError } from '../utils/format.js';

export const session = { authUid: null, userId: null, acl: null, user: null };
const SESSION_KEY = 'pf360.session';
const ls = () => { try { return globalThis.localStorage; } catch { return null; } };

/** Internal sign-in address for a username (v changes when an admin re-issues the login). */
export const authEmail = (username, v = 1) => `${username}${v > 1 ? `.${v}` : ''}@${USERNAME_DOMAIN}`;
export const usernameOf = (email) => String(email || '').split('@')[0].replace(/\.\d+$/, '');

let projectLookup = () => null;
export const setProjectLookup = (fn) => { projectLookup = fn; };

/** May the current user do `module.action` (optionally: in this project)? */
export function can(perm, pid) {
  if (!aclCan(session.acl, perm)) return false;
  return pid === undefined || pid === null ? true : aclHasProject(session.acl, projectLookup(pid), pid);
}
export const canAny = (perms, pid) => perms.some((p) => can(p, pid));
export const isSuperAdmin = () => session.acl?.sa === true;
export const me = () => session.userId;
export function requirePerm(perm, pid, what) {
  if (!can(perm, pid)) throw new AppError(`You do not have permission to ${what || 'do this'}.`);
}
export const requireAny = (perms, pid, what) => { if (!canAny(perms, pid)) throw new AppError(`You do not have permission to ${what || 'do this'}.`); };

/** System-level audit entry (append-only, Super Admin can read). */
export async function audit(action, fields = {}) {
  const b = be();
  const entry = { at: b.serverTimestamp(), uid: session.userId, name: session.user?.displayName || '', dept: session.user?.departmentId || '', action };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') entry[k] = typeof v === 'string' ? v : JSON.stringify(v);
  await b.update({ [`/auditLogs/${b.newId()}`]: entry });
}

/* ------------------------------------------------------------------ sign in */
export async function login(usernameRaw, password, remember) {
  const username = String(usernameRaw || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username) || !password) throw new AppError('Enter your username and password.');
  const b = be();
  const idx = await b.get(`/loginIndex/${username}`).catch(() => null);
  try {
    await b.auth.signIn(authEmail(username, idx?.v || 1), password, remember);
  } catch (e) {
    if (idx && (e.code || '').startsWith('auth/') && e.code !== 'auth/network-request-failed') {
      // failed-login tracking: a counter anyone may increase by one, nothing else
      b.update({ [`/loginIndex/${username}/failed`]: (idx.failed || 0) + 1, [`/loginIndex/${username}/lastFailedAt`]: b.serverTimestamp() }).catch(() => {});
    }
    throw e;
  }
  const res = await establish();
  if (res.state === 'ok' || res.state === 'changePassword') await completeLogin();
  return res;
}

/**
 * Load the signed-in account's permissions and profile.
 * States: none | ok | changePassword | bootstrap | uninitialised | deactivated
 */
export async function establish() {
  const b = be();
  const au = await b.auth.ready().then(() => b.auth.current());
  Object.assign(session, { authUid: null, userId: null, acl: null, user: null });
  if (!au) return { state: 'none' };
  const acl = await b.get(`/acl/${au.uid}`).catch(() => null);
  if (!acl) {
    const sys = await b.get('/system').catch(() => null);
    if (!sys?.initialized) {
      session.authUid = au.uid;
      return { state: sys?.bootstrapUid === au.uid ? 'bootstrap' : 'uninitialised', uid: au.uid, username: usernameOf(au.email) };
    }
    await b.auth.signOut();
    return { state: 'deactivated' };
  }
  const user = await b.get(`/users/${acl.userId}`).catch(() => null);
  if (!user || user.active === false) { await b.auth.signOut(); return { state: 'deactivated' }; }
  Object.assign(session, { authUid: au.uid, userId: acl.userId, acl, user });
  startSessionClock(false);
  return { state: user.mustChangePassword ? 'changePassword' : 'ok' };
}

async function completeLogin() {
  const b = be();
  const u = session.user.username;
  const failed = (await b.get(`/loginIndex/${u}/failed`).catch(() => 0)) || 0;
  const updates = { [`/users/${session.userId}/lastLoginAt`]: b.serverTimestamp() };
  if (failed > 0) updates[`/loginIndex/${u}/failed`] = 0;
  await b.update(updates).catch(() => {});
  startSessionClock(true);
  await audit('Signed in', failed > 0 ? { note: `${failed} failed sign-in attempt(s) were recorded for this username since the last successful sign-in.` } : {}).catch(() => {});
}

export async function logout(reason) {
  const b = be();
  if (session.userId) {
    await b.update({ [`/users/${session.userId}/lastLogoutAt`]: b.serverTimestamp() }).catch(() => {});
    await audit(reason ? `Signed out (${reason})` : 'Signed out').catch(() => {});
  }
  await b.auth.signOut();
  Object.assign(session, { authUid: null, userId: null, acl: null, user: null });
  ls()?.removeItem(SESSION_KEY);
}

export function validatePassword(pw, username = '') {
  if (!pw || pw.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Use at least one letter and one number.';
  if (username && pw.toLowerCase().includes(username.toLowerCase())) return 'The password must not contain your username.';
  return null;
}

export async function changePassword(newPassword, currentPassword) {
  const err = validatePassword(newPassword, session.user?.username);
  if (err) throw new AppError(err);
  if (currentPassword !== undefined && currentPassword === newPassword) throw new AppError('Choose a password that is different from the current one.');
  const b = be();
  await b.auth.updatePassword(newPassword);
  await b.update({ [`/users/${session.userId}/mustChangePassword`]: false, [`/users/${session.userId}/passwordChangedAt`]: b.serverTimestamp() });
  session.user.mustChangePassword = false;
  await audit('Changed own password').catch(() => {});
}

/** "Forgot password": flags the username for the Super Admin (there is no e-mail in this setup). */
export async function requestPasswordReset(usernameRaw) {
  const username = String(usernameRaw || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) throw new AppError('Enter your username first.');
  const b = be();
  // Same answer whether or not the username exists, so usernames cannot be probed here.
  await b.update({ [`/loginIndex/${username}/resetRequestedAt`]: b.serverTimestamp() }).catch(() => {});
}

/**
 * One-time system initialisation by the bootstrap administrator.
 * The rules only allow this for the account whose UID the project owner placed at
 * /system/bootstrapUid in the Firebase console, and only while /system/initialized
 * does not exist. Afterwards this path is closed for good.
 */
export async function initialiseSystem({ displayName, departmentId, orgName }) {
  const b = be();
  const au = b.auth.current();
  if (!au) throw new AppError('Sign in first.');
  if (!displayName?.trim()) throw new AppError('Enter your display name.');
  const username = usernameOf(au.email);
  const userId = `u_${username}`;
  const seed = baseSeed();
  if (orgName?.trim()) seed.settings.orgName = orgName.trim();
  const rec = newUserRecord({ username, displayName: displayName.trim(), roleId: 'super_admin', departmentId: departmentId || 'project_management', scope: 'all', authUid: au.uid, mustChangePassword: true, now: b.serverTimestamp() });
  await b.update({
    '/roles': seed.roles,
    '/departments': seed.departments,
    '/settings': seed.settings,
    [`/users/${userId}`]: rec,
    [`/acl/${au.uid}`]: computeAcl(userId, rec, seed.roles, seed.settings),
    [`/loginIndex/${username}`]: { v: 1, userId },
    '/system/initialized': true,
  });
  const res = await establish();
  await audit('System initialised; bootstrap administrator created', { rtype: 'users', rid: userId }).catch(() => {});
  return res;
}

/* ------------------------------------------------------------------ session expiry */
function startSessionClock(fresh) {
  const s = ls(); if (!s) return;
  const cur = JSON.parse(s.getItem(SESSION_KEY) || 'null');
  if (fresh || !cur) s.setItem(SESSION_KEY, JSON.stringify({ start: Date.now(), last: Date.now() }));
}
export function touchActivity() {
  const s = ls(); if (!s) return;
  const cur = JSON.parse(s.getItem(SESSION_KEY) || 'null');
  if (cur) { cur.last = Date.now(); s.setItem(SESSION_KEY, JSON.stringify(cur)); }
}
/** Returns a reason string when the session must end, otherwise null. */
export function sessionExpiry(settings) {
  const s = ls(); if (!s) return null;
  const cur = JSON.parse(s.getItem(SESSION_KEY) || 'null');
  if (!cur) return null;
  const idleMs = (settings?.sessionIdleMinutes || 30) * 60000;
  const maxMs = (settings?.sessionMaxHours || 12) * 3600000;
  if (Date.now() - cur.last > idleMs) return 'inactive too long';
  if (Date.now() - cur.start > maxMs) return 'maximum session length reached';
  return null;
}
