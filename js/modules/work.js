/** Deadlines, department dashboards, notifications, search, people, my account, help. */
import { store } from '../services/store.js';
import { session, can, isSuperAdmin, changePassword } from '../services/session.js';
import { be } from '../services/backend.js';
import { activities, pendingApprovals, DUE_LABEL } from '../services/insights.js';
import { globalSearch } from '../services/reports.js';
import { fullAuditTrail } from '../services/records.js';
import { openStage } from '../components/workflow.js';
import { logRowsHtml } from '../components/panels.js';
import { MODULES, moduleActions, ACTIONS, PASSWORD_MIN } from '../config/app-config.js';
import { PRIORITIES } from '../config/entities.js';
import { esc, icon, badge, table, pageHead, btn, toast, showError, fieldHtml, readForm, dl, withBusy } from '../components/ui.js';
import { fmtDateTime, timeAgo, AppError } from '../utils/format.js';

const sel = (id, label, value, opts, bind) => `<div class="field"><label for="${id}">${esc(label)}</label><select id="${id}" data-bind="${bind}"><option value="">All</option>${opts.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(value || '') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
const ACT_COLS = [{ key: 'pid', label: 'Project', cls: 'id' }, { key: 'itemCode', label: 'Item' }, { key: 'label', label: 'Activity / stage' }, { key: 'deptId', label: 'Department', type: 'dept' }, { key: 'personId', label: 'Responsible', type: 'user' }, { key: 'priority', label: 'Priority', html: (r) => (r.priority ? badge(r.priority) : '') }, { key: 'due', label: 'Expected date', type: 'date' },
  { key: 'cat', label: 'Due status', html: (r) => badge(DUE_LABEL[r.cat], r.cat === 'overdue' ? 'crit' : r.cat === 'ontrack' ? 'good' : r.cat === 'upcoming' ? 'info' : 'warn') }, { key: 'status', label: 'Stage status', html: (r) => badge(r.status) }, { key: 'overdueDays', label: 'Overdue days', num: true, html: (r) => (r.overdueDays ? `<b style="color:var(--crit-ink)">${r.overdueDays}</b>` : '') }];

/* ------------------------------------------------------------------ deadlines */
export function deadlinesView(ctx) {
  const s = ctx.state;
  const all = activities();
  const rows = all.filter((a) => (!s.project || a.pid === s.project) && (!s.dept || a.deptId === s.dept) && (!s.person || a.personId === s.person) && (!s.cat || a.cat === s.cat) && (!s.priority || a.priority === s.priority)
    && (!s.minDays || a.overdueDays >= Number(s.minDays)) && (!s.from || a.due >= s.from) && (!s.to || a.due <= s.to) && (!s.q || `${a.label} ${a.itemCode}`.toLowerCase().includes(s.q.toLowerCase())));
  const n = (c) => all.filter((a) => a.cat === c).length;
  return {
    title: 'Deadlines',
    html: `${pageHead({ title: 'Deadlines and overdue activities', sub: 'Calculated from expected completion dates. Being overdue never changes a status — only an authorised person does that.' })}
      <div class="kpis" style="margin-bottom:16px">${[['overdue', 'alert'], ['today', 'warn'], ['soon', 'warn'], ['upcoming', ''], ['ontrack', '']].map(([c, cls]) => `<a class="kpi ${n(c) ? cls : ''}" href="#/deadlines" data-act="cat" data-cat="${c}"><b>${n(c)}</b><span>${esc(DUE_LABEL[c])}${c === 'soon' ? ' (within 3 days)' : c === 'upcoming' ? ' (within 7 days)' : c === 'ontrack' ? ' (more than 7 days)' : ''}</span></a>`).join('')}</div>
      <div class="filters">
        <div class="field grow"><label for="dq">Stage or item</label><input id="dq" data-bind="q" value="${esc(s.q || '')}" placeholder="e.g. Purchase order, MTR-01"></div>
        ${sel('dp', 'Project', s.project, store.projects().map((p) => [p.id, p.id]), 'project')}${sel('dd', 'Department', s.dept, store.departments().map((d) => [d.id, d.name]), 'dept')}${sel('de', 'Employee', s.person, store.users().map((u) => [u.id, u.displayName]), 'person')}
        ${sel('dc', 'Due status', s.cat, Object.entries(DUE_LABEL).filter(([k]) => k !== 'none'), 'cat')}${sel('dr', 'Priority', s.priority, PRIORITIES.map((p) => [p, p]), 'priority')}
        <div class="field"><label for="df">Due from</label><input id="df" type="date" data-bind="from" value="${esc(s.from || '')}"></div><div class="field"><label for="dt">Due to</label><input id="dt" type="date" data-bind="to" value="${esc(s.to || '')}"></div>
        <div class="field"><label for="dm">Overdue at least (days)</label><input id="dm" type="number" min="0" data-bind="minDays" value="${esc(s.minDays || '')}"></div>
      </div>
      <section class="panel">${table({ cols: ACT_COLS, rows, href: (r) => r.link, flag: (r) => r.cat === 'overdue', empty: '<b>No dated activities match.</b>Give workflow stages an expected completion date on the item page to track them here.' })}<div class="tablefoot">${rows.length} of ${all.length} activities</div></section>`,
    actions: { cat: (d) => { s.cat = s.cat === d.cat ? '' : d.cat; ctx.rerender(); } },
  };
}

/* ------------------------------------------------------------------ department dashboards */
export function departmentsView(ctx) {
  const depts = store.departments().filter((d) => d.active !== false);
  const mine = Object.keys(session.acl.d || {});
  const deptId = ctx.params[0] || mine[0] || depts[0]?.id;
  const open = new Set(store.projects().filter((p) => !['Completed', 'Cancelled'].includes(p.status)).map((p) => p.id));
  const stages = store.list('stages').filter((x) => open.has(x.pid) && x.deptId === deptId && x.status !== 'Cancelled');
  const item = (x) => store.get('projectItems', x.pid, x.itemId);
  const due = Object.fromEntries(activities().filter((a) => a.kind === 'stage').map((a) => [a.key, a]));
  const row = (x) => { const a = due[`stage:${x.pid}:${x.id}`]; return { ...x, itemCode: item(x)?.itemCode, cat: a?.cat || 'none', overdueDays: a?.overdueDays || 0, link: `#/items/${x.pid}/${x.itemId}?stage=${encodeURIComponent(x.id)}` }; };
  const by = (f) => stages.filter(f).map(row);
  const pending = by((x) => x.status === 'Not Started' && (store.where('stages', x.pid, (y) => y.itemId === x.itemId && y.branch === x.branch && y.seq < x.seq).every((y) => ['Completed', 'Cancelled'].includes(y.status))));
  const inHand = by((x) => ['In Progress', 'Waiting for Approval', 'On Hold', 'Blocked'].includes(x.status));
  const late = stages.map(row).filter((x) => x.cat === 'overdue' && x.status !== 'Completed');
  const done = by((x) => x.status === 'Completed').sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 8);
  const approvals = pendingApprovals().filter((a) => can(a.perm, a.pid) && (mine.includes(deptId)));
  const cols = [{ key: 'pid', label: 'Project', cls: 'id' }, { key: 'itemCode', label: 'Item' }, { key: 'name', label: 'Stage', html: (r) => `${esc(r.name)}${r.branch === 'B' ? ' <span class="muted">(replenishment)</span>' : ''}` }, { key: 'personId', label: 'Responsible', type: 'user' }, { key: 'expEnd', label: 'Expected', type: 'date' }, { key: 'status', label: 'Status', html: (r) => `${badge(r.status)}${r.overdueDays ? ` ${badge(`${r.overdueDays} d overdue`, 'crit')}` : ''}` }, { key: 'x', label: '', html: (r) => `<button class="btn sm" data-act="stage" data-pid="${esc(r.pid)}" data-id="${esc(r.id)}">Update</button>` }];
  const projects = [...new Set(stages.map((x) => x.pid))];
  const sect = (title, rows, empty) => `<section class="panel"><header><h2>${title}</h2><span class="muted small">${rows.length}</span></header>${table({ cols, rows, href: (r) => r.link, flag: (r) => r.overdueDays > 0, empty })}</section>`;
  return {
    title: 'Department work',
    html: `${pageHead({ title: `Department work — ${esc(store.deptName(deptId))}`, sub: 'What this department has to do now, across the projects you can see.', actions: `<div class="field" style="min-width:220px"><label class="sr" for="deptPick">Department</label><select id="deptPick" data-act-change="dept">${depts.map((d) => `<option value="${d.id}"${d.id === deptId ? ' selected' : ''}>${esc(d.name)}${mine.includes(d.id) ? ' (mine)' : ''}</option>`).join('')}</select></div>` })}
      <div class="kpis" style="margin-bottom:16px"><div class="kpi"><b>${pending.length}</b><span>Pending — ready to start</span></div><div class="kpi"><b>${inHand.length}</b><span>In progress or waiting</span></div><div class="kpi ${late.length ? 'alert' : ''}"><b>${late.length}</b><span>Overdue</span></div><div class="kpi"><b>${projects.length}</b><span>Assigned projects</span></div><div class="kpi"><b>${new Set(stages.map((x) => `${x.pid}/${x.itemId}`)).size}</b><span>Assigned items</span></div><div class="kpi ${approvals.length ? 'warn' : ''}"><b>${approvals.length}</b><span>Approvals you can give</span></div></div>
      <div class="stack">${sect('Overdue activities', late, '<b>Nothing is overdue.</b>')}${sect('In-progress activities', inHand, '<b>Nothing in progress.</b>')}${sect('Pending activities', pending, '<b>No stage is waiting to be started.</b>A stage is listed here when everything before it in the workflow is complete.')}
      ${approvals.length ? `<section class="panel"><header><h2>Pending approvals</h2></header>${table({ cols: [{ key: 'label', label: 'Request' }, { key: 'pid', label: 'Project' }, { key: 'itemCode', label: 'Item' }, { key: 'since', label: 'Waiting since', html: (r) => esc(timeAgo(r.since)) }], rows: approvals, href: (r) => r.link })}</section>` : ''}
      ${sect('Recently completed', done, '<b>No completed stages yet.</b>')}
      <section class="panel"><header><h2>Assigned projects</h2></header><div class="body">${projects.map((p) => `<a class="btn sm" href="#/projects/${esc(p)}">${esc(p)} — ${esc(store.project(p)?.name || '')}</a>`).join(' ') || '<span class="muted">No open project has work for this department.</span>'}</div></section></div>`,
    actions: { stage: (d) => openStage(d.pid, d.id) },
    mount(root) { root.querySelector('#deptPick')?.addEventListener('change', (e) => { location.hash = `#/departments/${e.target.value}`; }); },
  };
}

/* ------------------------------------------------------------------ notifications */
export function notificationsView(ctx) {
  const list = store.notifications().filter((n) => !ctx.state.unread || !n.read);
  const base = `/notifications/${session.userId}`;
  return {
    title: 'Notifications',
    html: `${pageHead({ title: 'Notifications', sub: 'You are only notified about records you are allowed to open.', actions: `${btn('readAll', 'Mark all as read', { ic: 'check' })}${btn('clear', 'Remove read', { ic: 'trash', cls: 'ghost' })}` })}
      <div class="filters"><label class="check"><input type="checkbox" data-bind="unread"${ctx.state.unread ? ' checked' : ''}><span>Unread only</span></label></div>
      <section class="panel">${table({ cols: [{ key: 'title', label: 'Notification', html: (n) => `${n.read ? '' : '<span class="badge info">New</span> '}<b>${esc(n.title)}</b>${n.body ? `<div class="soft small">${esc(n.body)}</div>` : ''}` }, { key: 'fromName', label: 'From' }, { key: 'at', label: 'When', html: (n) => `<span title="${esc(fmtDateTime(n.at))}">${esc(timeAgo(n.at))}</span>` }], rows: list, href: (n) => `#/notifications?open=${encodeURIComponent(n.id)}`, empty: '<b>No notifications.</b>' })}</section>`,
    actions: {
      readAll: async () => { const u = {}; store.notifications().forEach((n) => { if (!n.read) u[`${base}/${n.id}/read`] = true; }); if (Object.keys(u).length) await be().update(u); toast('All marked as read.'); },
      clear: async () => { const u = {}; store.notifications().forEach((n) => { if (n.read) u[`${base}/${n.id}`] = null; }); if (Object.keys(u).length) await be().update(u); toast('Read notifications removed.'); },
    },
    mount() {
      const id = ctx.query.get('open');
      const n = id && store.notifications().find((x) => x.id === id);
      if (n) { if (!n.read) be().update({ [`${base}/${n.id}/read`]: true }).catch(() => {}); location.replace(n.link || '#/notifications'); }
    },
  };
}

/* ------------------------------------------------------------------ search */
export function searchView(ctx) {
  const q = ctx.query.get('q') || '';
  const res = globalSearch(q, 200);
  return { title: 'Search', html: `${pageHead({ title: `Search results for “${esc(q)}”`, sub: `${res.length} result${res.length === 1 ? '' : 's'} in the records you are allowed to see.` })}
    <section class="panel">${table({ cols: [{ key: 'type', label: 'Type', html: (r) => badge(r.type, 'plain') }, { key: 'title', label: 'Record', cls: 'id' }, { key: 'sub', label: 'Details' }], rows: res, href: (r) => r.link, empty: q.length < 2 ? '<b>Type at least two characters.</b>' : '<b>Nothing found.</b>Search covers project ID and name, item code and name, PR, PO, PI, MR, GRN and gate pass numbers, vendors, employees and transaction references.' })}</section>` };
}

/* ------------------------------------------------------------------ people */
export function personView(ctx) {
  const u = store.user(ctx.params[0]);
  if (!u) return { title: 'Person', html: '<div class="panel"><div class="empty"><b>User not found.</b></div></div>' };
  return {
    title: u.displayName,
    html: `${pageHead({ title: esc(u.displayName), sub: `${esc(store.role(u.roleId)?.name || '')} · ${esc(store.deptName(u.departmentId))}`, actions: isSuperAdmin() ? '<a class="btn" href="#/admin/users">Manage users</a>' : '' })}
      <section class="panel"><div class="body">${dl([['Username', esc(u.username)], ['Status', badge(u.active === false ? 'Deactivated' : 'Active')], ['Departments', esc(Object.keys(u.departments || {}).map((d) => store.deptName(d)).join(', '))], ['Project access', esc({ all: 'All projects', dept: 'Department-assigned projects', selected: 'Selected projects' }[u.scope] || '')], ['Last sign-in', isSuperAdmin() || u.id === session.userId ? esc(u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : 'Never') : null]])}</div></section>
      ${isSuperAdmin() ? '<section class="panel"><header><h2>Recent activity</h2></header><div class="body" id="userLog"><span class="muted">Loading…</span></div></section>' : ''}`,
    mount(root) { if (isSuperAdmin()) fullAuditTrail().then((rows) => { const el = root.querySelector('#userLog'); if (el) el.innerHTML = logRowsHtml(rows.filter((r) => r.uid === u.id).slice(0, 60), { withRecord: true }); }).catch(() => {}); },
  };
}

/* ------------------------------------------------------------------ my account */
export function accountView() {
  const u = session.user; const p = session.acl.p || {};
  const fields = [{ name: 'p1', label: 'New password', type: 'password', req: true, hint: `At least ${PASSWORD_MIN} characters with a letter and a number.` }, { name: 'p2', label: 'Repeat the new password', type: 'password', req: true }];
  const rows = MODULES.filter((m) => p[m.id]).map((m) => ({ module: m.label, acts: moduleActions(m).filter((a) => p[m.id][a]).map((a) => m.actionLabels?.[a] || ACTIONS.find((x) => x[0] === a)?.[1] || a).join(', ') }));
  return {
    title: 'My account',
    html: `${pageHead({ title: 'My account', sub: `${esc(u.displayName)} · ${esc(u.username)}` })}
      <div class="grid c2"><section class="panel"><header><h2>Change password</h2></header><div class="body"><form id="pwForm"><div class="formgrid">${fields.map((f) => fieldHtml({ ...f, wide: true })).join('')}</div><div style="margin-top:14px">${btn('savePw', 'Change password', { cls: 'primary', ic: 'key' })}</div></form></div></section>
      <section class="panel"><header><h2>Profile</h2></header><div class="body">${dl([['Role', esc(store.role(u.roleId)?.name)], ['Departments', esc(Object.keys(u.departments || {}).map((d) => store.deptName(d)).join(', '))], ['Project access', esc({ all: 'All projects', dept: 'Projects of my departments', selected: 'Projects assigned to me' }[session.acl.scope])], ['Last sign-in', esc(u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : '—')]])}</div></section></div>
      <section class="panel" style="margin-top:16px"><header><h2>What I am allowed to do</h2></header>${table({ cols: [{ key: 'module', label: 'Module' }, { key: 'acts', label: 'Permissions' }], rows })}</section>`,
    actions: { savePw: (d, el) => withBusy(el, async () => { const v = readForm(document.getElementById('pwForm'), fields); if (v.p1 !== v.p2) throw new AppError('The two passwords are not the same.'); await changePassword(v.p1); document.getElementById('pwForm').reset(); }, 'Password changed.') },
  };
}

/* ------------------------------------------------------------------ help */
export function helpView() {
  const sc = store.settings().stageScores || {};
  return { title: 'Help', html: `${pageHead({ title: 'How ProjectFlow 360 works' })}<div class="stack">
    <section class="panel"><header><h2>The life of an item</h2></header><div class="body">
      <p><b>1. Availability check.</b> Stores verifies how many units exist in-house. The system then creates the paths the item needs.</p>
      <p><b>2. Branch A — project fulfilment.</b> In-house units are transferred to the project; any shortage is procured for the project (PR → approval → quotations → PO → PI → payment → dispatch → receipt at SPIF → material request → GVT).</p>
      <p><b>3. Branch B — source stock replenishment.</b> Whenever stock is transferred, a separate procurement is always raised to refill the department that gave the stock. It is tracked on its own and never counts as project material.</p>
      <p><b>4. Development and testing.</b> Receiving material does not finish an item. Development and testing are separate stages; a failed test reopens development and the next attempt is a new, separate test cycle.</p>
      <p><b>5. Closure.</b> A project is completed or cancelled only through the closure checklist, with a recorded approval.</p></div></section>
    <section class="panel"><header><h2>How progress and health are calculated</h2></header><div class="body">
      <p><b>Item progress</b> is the weighted average of its Branch A stages. Each stage counts by its status: ${Object.entries(sc).map(([k, v]) => `${esc(k)} ${Math.round(v * 100)}%`).join(', ') || 'Completed 100%, In Progress 50%'}. <b>Project progress</b> is the average of its items. Weights and scores are set in Administration → Settings.</p>
      <p><b>Health</b> is green, amber or red according to rules about overdue activities, waiting approvals, uncovered shortages, test failures and overdue gate passes. The thresholds are in Settings, and every project page lists the reasons for its current health.</p>
      <p><b>Dates never complete anything.</b> An expected date only marks a stage as due or overdue. Statuses change when an authorised person records the work or the decision.</p></div></section>
    <section class="panel"><header><h2>Who can do what</h2></header><div class="body"><p>Your menu shows the modules you may open. Permissions are enforced on the server for every read and write, so a link or a typed address cannot show you a project or a record you have no access to. See <a href="#/account">My account</a> for your own permissions.</p></div></section></div>` };
}
export { icon, showError };
