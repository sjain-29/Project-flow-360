/**
 * Live, in-memory copy of everything the signed-in user is ALLOWED to read.
 *
 * The store subscribes only to paths the security rules permit for this user
 * (per project and per module), so dashboards, search, reports and exports can
 * simply work on "what is in the store" without ever leaking restricted data.
 */
import { be } from './backend.js';
import { session, setProjectLookup, can } from './session.js';
import { ENTITIES, SCOPED, flatten } from '../config/entities.js';
import { setCurrency } from '../utils/format.js';

const state = { users: {}, roles: {}, departments: {}, settings: {}, projects: {}, inventory: {}, notifications: {}, loginIndex: {}, coll: {} };
let unsubs = [];
let projectSubs = new Map(); // pid -> [unsub]
const listeners = new Set();
let timer = null;
let pending = 0;
let readyResolve = null;
let onRevoked = null;
let started = false;

/** The database stores lists as numbered objects; give the app real arrays back. */
const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined) : v && typeof v === 'object' ? Object.keys(v).sort((a, b) => a - b).map((k) => v[k]) : []);
function normaliseSettings(v) {
  const s = { ...(v || {}) };
  for (const k of ['projectCategories', 'units', 'paymentModes']) if (k in s) s[k] = asArray(s[k]);
  return s;
}
const emit = () => { if (timer) return; timer = setTimeout(() => { timer = null; listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }, 40); };
const flatMap = (v, pid) => {
  const out = {};
  for (const [id, rec] of Object.entries(v || {})) out[id] = { ...flatten(rec), id, ...(pid ? { pid } : {}) };
  return out;
};

function track(path, apply) {
  pending++;
  let first = true;
  const done = () => { if (first) { first = false; pending--; if (pending === 0 && readyResolve) { readyResolve(); readyResolve = null; } } };
  const un = be().subscribe(path, (v) => { apply(v); done(); emit(); }, () => { apply(null); done(); emit(); });
  return un;
}

function subscribeProject(pid) {
  if (projectSubs.has(pid)) return;
  const list = [];
  if (can('projects.view')) list.push(track(`/projects/${pid}`, (v) => { if (v) state.projects[pid] = { ...flatten(v), id: pid }; else delete state.projects[pid]; }));
  for (const coll of SCOPED) {
    const e = ENTITIES[coll];
    if (e.special !== 'stage' && !can(`${e.module}.view`)) continue;
    list.push(track(`/${coll}/${pid}`, (v) => { (state.coll[coll] ||= {})[pid] = flatMap(v, pid); }));
  }
  projectSubs.set(pid, list);
}
function unsubscribeProject(pid) {
  (projectSubs.get(pid) || []).forEach((u) => u());
  projectSubs.delete(pid);
  delete state.projects[pid];
  for (const coll of SCOPED) if (state.coll[coll]) delete state.coll[coll][pid];
}

/** For users without "all projects" scope: work out which projects to listen to. */
const hints = { manager: {}, dept: {} };
function syncLimitedProjects() {
  const acl = session.acl;
  const want = new Set([...Object.keys(acl.prj || {}), ...Object.keys(hints.manager)]);
  if (acl.scope === 'dept') for (const d of Object.keys(acl.d || {})) for (const pid of Object.keys(hints.dept[d] || {})) want.add(pid);
  for (const pid of want) subscribeProject(pid);
  for (const pid of [...projectSubs.keys()]) if (!want.has(pid)) unsubscribeProject(pid);
}

export const store = {
  /** Start listening. Resolves when the first copy of everything has arrived. */
  async start({ onAccessRevoked } = {}) {
    store.stop();
    started = true;
    onRevoked = onAccessRevoked;
    const acl = session.acl;
    const ready = new Promise((r) => { readyResolve = r; });
    pending++; // guard so "ready" cannot fire before all subscriptions are registered
    unsubs.push(track('/users', (v) => { state.users = v || {}; }));
    unsubs.push(track('/roles', (v) => { state.roles = v || {}; }));
    unsubs.push(track('/departments', (v) => { state.departments = v || {}; }));
    unsubs.push(track('/settings', (v) => { state.settings = normaliseSettings(v); setCurrency(state.settings.currency); }));
    unsubs.push(track(`/notifications/${session.userId}`, (v) => { state.notifications = v || {}; }));
    if (can('inventory.view')) unsubs.push(track('/inventory', (v) => { state.inventory = flatMap(v); }));
    if (acl.sa) unsubs.push(track('/loginIndex', (v) => { state.loginIndex = v || {}; }));
    // Own permissions: react immediately to changes and to deactivation.
    let firstAcl = true;
    unsubs.push(be().subscribe(`/acl/${session.authUid}`, (v) => {
      if (!v) { onRevoked?.('deactivated'); return; }
      const changed = JSON.stringify(v) !== JSON.stringify(session.acl);
      session.acl = v;
      if (!firstAcl && changed) store.start({ onAccessRevoked: onRevoked }); // permissions changed → re-subscribe
      firstAcl = false;
    }, () => onRevoked?.('deactivated')));

    if (acl.scope === 'all') {
      if (can('projects.view')) unsubs.push(track('/projects', (v) => { state.projects = flatMap(v); }));
      for (const coll of SCOPED) {
        const e = ENTITIES[coll];
        if (e.special !== 'stage' && !can(`${e.module}.view`)) continue;
        unsubs.push(track(`/${coll}`, (v) => {
          const byPid = {};
          for (const [pid, recs] of Object.entries(v || {})) byPid[pid] = flatMap(recs, pid);
          state.coll[coll] = byPid;
        }));
      }
    } else {
      unsubs.push(track(`/projectIndex/byManager/${session.userId}`, (v) => { hints.manager = v || {}; syncLimitedProjects(); }));
      if (acl.scope === 'dept') {
        for (const d of Object.keys(acl.d || {})) unsubs.push(track(`/projectIndex/byDept/${d}`, (v) => { hints.dept[d] = v || {}; syncLimitedProjects(); }));
      }
      syncLimitedProjects();
    }
    pending--;
    if (pending === 0 && readyResolve) { readyResolve(); readyResolve = null; }
    await ready;
  },

  stop() {
    unsubs.forEach((u) => { try { u(); } catch { /* ignore */ } });
    unsubs = [];
    for (const pid of [...projectSubs.keys()]) unsubscribeProject(pid);
    Object.assign(state, { users: {}, roles: {}, departments: {}, settings: {}, projects: {}, inventory: {}, notifications: {}, loginIndex: {}, coll: {} });
    hints.manager = {}; hints.dept = {};
    pending = 0; started = false;
  },
  isStarted: () => started,
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  /* ------------------------------------------------------------ directory */
  settings: () => state.settings || {},
  roles: () => state.roles || {},
  role: (id) => state.roles?.[id],
  departments: () => Object.entries(state.departments || {}).map(([id, d]) => ({ id, ...d })).sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name)),
  deptName: (id) => state.departments?.[id]?.name || id || '—',
  users: () => Object.entries(state.users || {}).map(([id, u]) => ({ id, ...u })).sort((a, b) => (a.displayName || '').localeCompare(b.displayName || '')),
  user: (id) => (state.users?.[id] ? { id, ...state.users[id] } : null),
  userName: (id) => state.users?.[id]?.displayName || (id ? String(id) : '—'),
  loginIndex: () => state.loginIndex || {},
  notifications: () => Object.entries(state.notifications || {}).map(([id, n]) => ({ id, ...n })).sort((a, b) => (b.at || 0) - (a.at || 0)),

  /* ------------------------------------------------------------ records */
  projects: (opts = {}) => Object.values(state.projects || {}).filter((p) => opts.archived || !p.archived).sort((a, b) => a.id.localeCompare(b.id)),
  project: (pid) => state.projects?.[pid] || null,
  stock: () => Object.values(state.inventory || {}),
  stockRecord: (id) => state.inventory?.[id] || null,
  /** All records of a collection (optionally one project). Soft-deleted records are skipped. */
  list(coll, pid, opts = {}) {
    const c = state.coll[coll] || {};
    const out = [];
    for (const p of (pid ? [pid] : Object.keys(c))) for (const r of Object.values(c[p] || {})) if (opts.deleted || !r.deleted) out.push(r);
    return out;
  },
  get(coll, pid, id) {
    if (coll === 'projects') return state.projects?.[id] || null;
    if (coll === 'inventory') return state.inventory?.[id] || null;
    return state.coll[coll]?.[pid]?.[id] || null;
  },
  where: (coll, pid, pred) => store.list(coll, pid).filter(pred),
};

setProjectLookup((pid) => store.project(pid));
