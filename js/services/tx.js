/**
 * Unit of work: collects every change of one business operation and commits it
 * as ONE atomic multi-path update (all or nothing).
 *
 * For every record it writes, the Tx also:
 *   • stamps who/when (server time) and increases the record version by one —
 *     the rules reject the write if someone else changed the record meanwhile,
 *     which is how quantity- and money-sensitive operations stay consistent
 *     without Cloud Functions;
 *   • writes an append-only activity log entry with the old and new values —
 *     the rules reject a record write that has no matching log entry.
 */
import { be } from './backend.js';
import { session } from './session.js';
import { store } from './store.js';
import { ENTITIES, nest, fieldPath } from '../config/entities.js';
import { AppError } from '../utils/format.js';

const blank = (v) => v === undefined || v === null || v === '';
const same = (a, b) => (blank(a) && blank(b)) || JSON.stringify(a) === JSON.stringify(b);
const pad = (n) => String(n).padStart(4, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Tx {
  constructor(pid) {
    this.pid = pid || null;
    this.recs = new Map();
    this.raw = {};
    this.counters = {};
  }
  _key(coll, id, pid) { return `${coll}|${ENTITIES[coll].global ? '' : (pid || this.pid)}|${id}`; }

  /** Current value of a record, including changes already queued in this Tx. */
  get(coll, id, pid) {
    const r = this.recs.get(this._key(coll, id, pid));
    if (r) return r.create ? { ...r.data, id, pid: r.pid } : { ...r.base, ...r.changes };
    return store.get(coll, pid || this.pid, id);
  }

  create(coll, id, data, action, pid) {
    const e = ENTITIES[coll];
    const key = this._key(coll, id, pid);
    if (this.recs.has(key) || store.get(coll, pid || this.pid, id)) throw new AppError(`${e.one} ${id} already exists.`);
    const full = {};
    // protected counters start at exactly 0 (the rules require it)
    for (const fd of e.fields) if ((fd.type === 'number' || fd.type === 'money') && fd.g !== 'core') full[fd.name] = 0;
    for (const [k, v] of Object.entries(data)) if (!blank(v)) full[k] = v;
    this.recs.set(key, { coll, id, pid: e.global ? null : (pid || this.pid), create: true, data: full, actions: [action || `${e.one} created`] });
    return id;
  }

  patch(coll, id, changes, action, pid) {
    const e = ENTITIES[coll];
    const key = this._key(coll, id, pid);
    const r = this.recs.get(key);
    if (r) {
      if (r.create) { for (const [k, v] of Object.entries(changes)) { if (blank(v)) delete r.data[k]; else r.data[k] = v; } } else Object.assign(r.changes, changes);
      if (action) r.actions.push(action);
      return;
    }
    const base = store.get(coll, pid || this.pid, id);
    if (!base) throw new AppError(`${e.one} ${id} was not found. It may have been removed or you may not have access.`);
    this.recs.set(key, { coll, id, pid: e.global ? null : (pid || this.pid), create: false, base, changes: { ...changes }, actions: [action || `${e.one} updated`] });
  }

  /** Next sequential, collision-safe number for a record type (e.g. PR-DRN01-0007). */
  async nextId(coll) {
    const e = ENTITIES[coll];
    const cpid = e.global ? '_global' : this.pid;
    const key = `${cpid}/${coll}`;
    if (!(key in this.counters)) this.counters[key] = (await be().get(`/counters/${key}`).catch(() => 0)) || 0;
    let n; let id;
    do {
      n = ++this.counters[key];
      id = e.global ? `${e.prefix}-${pad(n)}` : `${e.prefix}-${this.pid}-${pad(n)}`;
    } while (store.get(coll, this.pid, id) || this.recs.has(this._key(coll, id)));
    this.raw[`/counters/${key}`] = n;
    return id;
  }

  /** In-app notification for other users (never for the actor). */
  notify(userIds, { title, body, link, module }) {
    const b = be();
    for (const uid of new Set(userIds || [])) {
      if (!uid || uid === session.userId) continue;
      this.raw[`/notifications/${uid}/${b.newId()}`] = {
        title: String(title).slice(0, 290), body: String(body || '').slice(0, 900), link: link || '', at: b.serverTimestamp(),
        fromId: session.userId, fromName: session.user?.displayName || '', read: false, pid: this.pid || '', module: module || '',
      };
    }
  }

  set(path, value) { this.raw[path] = value; }
  isEmpty() { return this.recs.size === 0 && Object.keys(this.raw).length === 0; }

  async commit() {
    const b = be();
    const ts = b.serverTimestamp();
    const updates = { ...this.raw };
    const meId = session.userId;
    let wrote = false;
    for (const r of this.recs.values()) {
      const e = ENTITIES[r.coll];
      const logPid = e.global ? (r.coll === 'projects' ? r.id : '_global') : r.pid;
      const path = e.global ? `/${r.coll}/${r.id}` : `/${r.coll}/${r.pid}/${r.id}`;
      const logId = b.newId();
      const log = { at: ts, uid: meId, name: session.user?.displayName || '', dept: session.user?.departmentId || '', action: r.actions.join('; ').slice(0, 290), rtype: r.coll, rid: r.id, pid: logPid };
      if (r.create) {
        updates[path] = nest(r.coll, { ...r.data, createdAt: ts, createdBy: meId, updatedAt: ts, updatedBy: meId, _v: 1, _log: logId });
        log.new = JSON.stringify(r.data).slice(0, 19000);
      } else {
        const oldV = {}; const newV = {};
        for (const [k, v] of Object.entries(r.changes)) {
          if (same(r.base[k], v)) continue;
          updates[`${path}/${fieldPath(r.coll, k)}`] = blank(v) ? null : v;
          oldV[k] = blank(r.base[k]) ? null : r.base[k];
          newV[k] = blank(v) ? null : v;
        }
        if (!Object.keys(newV).length) continue; // nothing actually changed
        updates[`${path}/meta/updatedAt`] = ts;
        updates[`${path}/meta/updatedBy`] = meId;
        updates[`${path}/meta/_v`] = (r.base._v || 0) + 1;
        updates[`${path}/meta/_log`] = logId;
        log.old = JSON.stringify(oldV).slice(0, 19000);
        log.new = JSON.stringify(newV).slice(0, 19000);
      }
      updates[`/activityLogs/${logPid}/${logId}`] = log;
      wrote = true;
    }
    if (!wrote && !Object.keys(this.raw).length) return false;
    await b.update(updates);
    return true;
  }
}

/**
 * Run a business operation atomically. If the server rejects it because a record
 * changed in the meantime, the operation is re-run on fresh data (up to 3 tries).
 */
export async function runTx(pid, fn) {
  for (let attempt = 0; ; attempt++) {
    const tx = new Tx(pid);
    try {
      const result = await fn(tx);
      await tx.commit();
      return result;
    } catch (e) {
      if (e?.code !== 'PERMISSION_DENIED' || attempt >= 2) throw e;
      await sleep(150 * (attempt + 1));
    }
  }
}
