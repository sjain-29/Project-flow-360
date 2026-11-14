/**
 * Time-based notifications without a server: when a signed-in user's browser
 * sees something newly overdue (or an RGP return coming up) that concerns THEM,
 * it writes the reminder into that user's own notification list — once.
 * Statuses are never touched here.
 */
import { be } from './backend.js';
import { store } from './store.js';
import { session, can } from './session.js';
import { activities, dueInfo } from './insights.js';
import { closureChecklist } from './closure.js';
import { fmtDate } from '../utils/format.js';

const keyOf = (s) => String(s).replace(/[.#$[\]/]/g, '_').slice(0, 110);

export async function syncReminders() {
  if (!session.userId) return 0;
  const mine = new Set(store.notifications().map((n) => n.id));
  const myDepts = session.acl?.d || {};
  const updates = {};
  const add = (id, title, body, link, module) => {
    const k = keyOf(id);
    if (mine.has(k) || updates[`/notifications/${session.userId}/${k}`]) return;
    updates[`/notifications/${session.userId}/${k}`] = { title: title.slice(0, 290), body: body.slice(0, 900), link, at: be().serverTimestamp(), fromId: session.userId, fromName: 'Deadline reminder', read: false, module };
  };
  const concerns = (a) => a.personId === session.userId || (!a.personId && myDepts[a.deptId]) || store.project(a.pid)?.managerId === session.userId;
  for (const a of activities()) {
    if (!concerns(a)) continue;
    if (a.cat === 'overdue') add(`od_${a.key}_${a.due}`, `Overdue: ${a.label} — ${a.itemCode}`, `Project ${a.pid}. Expected ${fmtDate(a.due)}, now ${a.overdueDays} day(s) late.`, a.link, a.module);
    else if (a.kind === 'rgp' && a.days !== null && a.days <= (store.settings().rgpReminderDays || 3)) add(`rgp_${a.key}_${a.due}`, `RGP return approaching: ${a.label}`, `Project ${a.pid}. Due back on ${fmtDate(a.due)}.`, a.link, 'gatepass');
  }
  if (can('closure.approve')) {
    for (const p of store.projects()) {
      if (['Completed', 'Cancelled'].includes(p.status) || p.managerId !== session.userId) continue;
      if (!store.list('projectItems', p.id).length) continue;
      if (closureChecklist(p.id).every((c) => c.auto !== false)) add(`closure_${p.id}`, `Project ready for closure: ${p.id}`, `${p.name}: every automatic closure check is satisfied.`, `#/projects/${p.id}?tab=closure`, 'closure');
    }
  }
  if (Object.keys(updates).length) await be().update(updates).catch(() => {});
  return Object.keys(updates).length;
}
export { dueInfo };
