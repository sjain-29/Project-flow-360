/**
 * DEMO-MODE backend: the whole database lives in this browser's localStorage.
 *
 * It mimics the parts of Firebase the app uses (auth, read, live listeners,
 * atomic multi-path updates, server timestamps) and — importantly — enforces the
 * same Security Rules as production through the built-in rules engine. Nothing
 * here is used when Firebase is configured.
 */
import rulesJson from '../config/rules.generated.js';
import { RulesEngine, getIn, setIn, splitPath, clean } from './rules-engine.js';
import { baseSeed, newUserRecord, DEMO_USERS, DEMO_PASSWORD } from './seed.js';
import { computeAcl } from './permissions.js';
import { USERNAME_DOMAIN } from '../config/firebase-config.js';
import { AppError } from '../utils/format.js';

const DB_KEY = 'pf360.demo.db';
const AUTH_KEY = 'pf360.demo.auth';
const SESSION_KEY = 'pf360.demo.session';
const TS = { '.sv': 'timestamp' };

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const pick = (name) => { try { const s = globalThis[name]; s.getItem('x'); return s; } catch { return memoryStorage(); } };

async function sha256(text) {
  if (globalThis.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 5381; // non-secure fallback for plain-http demo pages
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return `weak${h.toString(16)}`;
}
const rid = (n = 20) => { const c = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; let s = ''; for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)]; return s; };

let lastPush = 0;
/** Time-ordered unique ids, like Firebase push ids. */
export function pushId() {
  const now = Math.max(Date.now(), lastPush + 1); lastPush = now;
  return `-${now.toString(36).padStart(9, '0')}${rid(8)}`;
}

export function createLocalBackend(opts = {}) {
  const storage = opts.storage || pick('localStorage');
  const sessionStore = opts.sessionStorage || pick('sessionStorage');
  const engine = new RulesEngine(rulesJson);
  let root = JSON.parse(storage.getItem(DB_KEY) || 'null') || {};
  let accounts = JSON.parse(storage.getItem(AUTH_KEY) || 'null') || {};
  let user = JSON.parse(sessionStore.getItem(SESSION_KEY) || storage.getItem(SESSION_KEY) || 'null');
  const subs = new Set();
  const authSubs = new Set();
  /** Optional hook for tests: called with every attempted read / update. */
  let observer = opts.observer || null;

  const authCtx = () => (user ? { uid: user.uid, token: { email: user.email } } : null);
  const persist = () => {
    try { storage.setItem(DB_KEY, JSON.stringify(root)); } catch { throw new AppError('Demo storage is full. Remove some attachments or reset the demo data.'); }
  };
  const persistAccounts = () => storage.setItem(AUTH_KEY, JSON.stringify(accounts));
  const denied = (what, info) => { const e = new AppError('You do not have permission to do this, or the record was changed by someone else. Refresh and try again.', { code: 'PERMISSION_DENIED', what, ...info }); e.code = 'PERMISSION_DENIED'; return e; };

  function notify(all = false) {
    for (const s of [...subs]) {
      if (!engine.canRead(root, authCtx(), s.path)) { subs.delete(s); s.onError?.(denied('listen', { path: s.path })); continue; }
      const v = getIn(root, s.parts);
      if (all || v !== s.last) { s.last = v; s.cb(v); }
    }
  }
  const resolveSv = (v, now) => {
    if (v && typeof v === 'object') {
      if (v['.sv'] === 'timestamp') return now;
      const o = {}; for (const [k, c] of Object.entries(v)) o[k] = resolveSv(c, now); return o;
    }
    return v;
  };

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('storage', (e) => {
      if (e.key === DB_KEY) { root = JSON.parse(e.newValue || 'null') || {}; notify(true); }
      if (e.key === AUTH_KEY) accounts = JSON.parse(e.newValue || 'null') || {};
    });
  }

  const backend = {
    mode: 'demo',
    serverTimestamp: () => TS,
    newId: pushId,
    async init() { if (!root.system?.initialized && !opts.noSeed) await backend.seedDemo(); },

    auth: {
      ready: async () => user,
      current: () => user,
      onChange(cb) { authSubs.add(cb); return () => authSubs.delete(cb); },
      async signIn(email, password, remember) {
        const acc = accounts[email];
        if (!acc || acc.hash !== await sha256(acc.salt + password)) { const e = new AppError('Incorrect username or password.'); e.code = 'auth/invalid-credential'; throw e; }
        user = { uid: acc.uid, email };
        sessionStore.setItem(SESSION_KEY, JSON.stringify(user));
        if (remember) storage.setItem(SESSION_KEY, JSON.stringify(user)); else storage.removeItem(SESSION_KEY);
        authSubs.forEach((cb) => cb(user));
        return user;
      },
      async signOut() {
        user = null; sessionStore.removeItem(SESSION_KEY); storage.removeItem(SESSION_KEY);
        subs.clear(); authSubs.forEach((cb) => cb(null));
      },
      async updatePassword(newPassword) {
        if (!user) throw new AppError('Not signed in.');
        const salt = rid(12);
        accounts[user.email] = { ...accounts[user.email], salt, hash: await sha256(salt + newPassword) };
        persistAccounts();
      },
      /** Creates a sign-in account without touching the current session (Firebase mode uses a secondary app). */
      async adminCreateUser(email, password) {
        if (accounts[email]) { const e = new AppError('That username is already in use.'); e.code = 'auth/email-already-in-use'; throw e; }
        const salt = rid(12);
        accounts[email] = { uid: `demo_${rid(16)}`, salt, hash: await sha256(salt + password) };
        persistAccounts();
        return accounts[email].uid;
      },
    },

    async get(path) {
      const ok = engine.canRead(root, authCtx(), path);
      observer?.({ op: 'read', path, auth: authCtx(), root, allowed: ok });
      if (!ok) throw denied('read', { path });
      return getIn(root, splitPath(path));
    },

    subscribe(path, cb, onError) {
      const s = { path, parts: splitPath(path), cb, onError, last: undefined };
      Promise.resolve().then(() => {
        const ok = engine.canRead(root, authCtx(), path);
        observer?.({ op: 'read', path, auth: authCtx(), root, allowed: ok });
        if (!ok) { onError?.(denied('listen', { path })); return; }
        subs.add(s); s.last = getIn(root, s.parts); cb(s.last);
      });
      return () => subs.delete(s);
    },

    /** Atomic multi-path update, validated against the security rules. */
    async update(updates) {
      const now = Date.now();
      const resolved = {};
      for (const [p, v] of Object.entries(updates)) resolved[p] = resolveSv(v, now);
      const res = engine.checkUpdate(root, authCtx(), resolved, now);
      observer?.({ op: 'update', updates: resolved, auth: authCtx(), root, now, allowed: res.ok, res });
      if (!res.ok) throw denied('write', { path: res.path, reason: res.reason, rule: res.rule });
      root = res.root || {};
      persist();
      notify();
    },

    /* ---------------- demo-only helpers (stand in for the Firebase console) ---------------- */
    setObserver(fn) { observer = fn; },
    /** Raw tree access, bypassing the rules — what a project owner can do in the Firebase console. */
    adminGet: (path) => getIn(root, splitPath(path)),
    adminSet(path, value) { root = setIn(root, splitPath(path), clean(value)) || {}; persist(); notify(); },
    exportAll: () => JSON.parse(JSON.stringify(root)),
    importAll(tree) { root = clean(tree) || {}; persist(); notify(true); },
    async resetDemo() { root = {}; accounts = {}; persistAccounts(); persist(); await backend.auth.signOut(); await backend.seedDemo(); },

    /** Creates the initialised system with one demo account per role. */
    async seedDemo() {
      const seed = baseSeed();
      const now = Date.now();
      const tree = { system: { initialized: true, demo: true }, ...seed, users: {}, acl: {}, loginIndex: {} };
      accounts = {};
      for (const [username, displayName, roleId, departmentId, scope] of DEMO_USERS) {
        const email = `${username}@${USERNAME_DOMAIN}`;
        const salt = rid(12);
        const uid = `demo_${username}`;
        accounts[email] = { uid, salt, hash: await sha256(salt + DEMO_PASSWORD) };
        const userId = `u_${username}`;
        const rec = newUserRecord({ username, displayName, roleId, departmentId, scope, authUid: uid, mustChangePassword: false, now });
        tree.users[userId] = rec;
        tree.acl[uid] = computeAcl(userId, rec, seed.roles, seed.settings);
        tree.loginIndex[username] = { v: 1, userId };
      }
      persistAccounts();
      root = clean(tree);
      persist();
      notify(true);
    },
  };
  return backend;
}
