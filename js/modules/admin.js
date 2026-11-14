/** Administration screens — Super Admin only (sections 4, 24, 30). The services and the security rules both re-check. */
import { store } from '../services/store.js';
import { session, isSuperAdmin } from '../services/session.js';
import { be, isDemo } from '../services/backend.js';
import * as A from '../services/admin.js';
import { fullAuditTrail } from '../services/records.js';
import { exportAll, pickPartial, validateBackup, restoreDemo, PARTIAL_EXPORTS } from '../services/backup.js';
import { loadSampleData } from '../services/demo-data.js';
import { moduleOwners } from '../services/permissions.js';
import { MODULES, ACTIONS, moduleActions, STAGE_TEMPLATES, defaultSettings } from '../config/app-config.js';
import { esc, icon, badge, table, pageHead, btn, toast, showError, formModal, confirmDialog, openModal, fieldHtml, readForm, withBusy, tabsBar, $$ } from '../components/ui.js';
import { logRowsHtml } from '../components/panels.js';
import { download, downloadCSV } from '../utils/csv.js';
import { fmtDateTime, timeAgo, today, AppError } from '../utils/format.js';

const SCOPES = [['all', 'All projects'], ['dept', 'Projects assigned to their departments'], ['selected', 'Selected projects only (plus projects they manage)']];
const COLS = [...ACTIONS, ['viewAll', 'All departments']];
const userInput = (u) => ({ displayName: u.displayName, roleId: u.roleId, departmentId: u.departmentId, departmentIds: Object.keys(u.departments || {}), scope: u.scope, projectIds: Object.keys(u.projects || {}), overrides: u.overrides, email: u.email, phone: u.phone });
const userFields = (isNew) => [...(isNew ? [{ name: 'username', label: 'Username', req: true, hint: '2–32 characters: lowercase letters, digits, “_” or “-”. It cannot be changed later.' }] : []), { name: 'displayName', label: 'Display name', req: true },
  { name: 'roleId', label: 'Role', type: 'select', req: true, opts: Object.entries(store.roles()).map(([id, r]) => [id, r.name]) }, { name: 'departmentId', label: 'Main department', type: 'dept', req: true },
  { name: 'departmentIds', label: 'Additional departments', type: 'multi', opts: store.departments().filter((d) => d.active !== false).map((d) => [d.id, d.name]), hint: 'A user may belong to more than one department. Department-restricted roles apply to all of them.' },
  { name: 'scope', label: 'Project access', type: 'select', req: true, opts: SCOPES, wide: true }, { name: 'projectIds', label: 'Specific projects', type: 'multi', opts: store.projects({ archived: true }).map((p) => [p.id, `${p.id} — ${p.name}`]), hint: 'Used with “Selected projects only”; also adds single projects to a department scope.' },
  ...(isNew ? [{ name: 'tempPassword', label: 'Temporary password', type: 'password', req: true, hint: 'At least 8 characters with a letter and a number. The user must change it at first sign-in.' }] : [])];

/* ------------------------------------------------------------------ users */
function usersSection(ctx) {
  const idx = store.loginIndex(); const s = ctx.state;
  const rows = store.users().filter((u) => !s.q || `${u.displayName} ${u.username}`.toLowerCase().includes(s.q.toLowerCase())).map((u) => ({ ...u, idx: idx[u.username] || {} }));
  return {
    html: `${pageHead({ title: 'Users', sub: 'Create, edit, deactivate and reactivate accounts; assign roles, departments and projects. Accounts are deactivated rather than deleted so that history stays intact.', actions: btn('newUser', 'New user', { ic: 'plus', cls: 'primary' }) })}
      <div class="filters"><div class="field grow"><label for="uq">Search</label><input id="uq" data-bind="q" value="${esc(s.q || '')}" placeholder="Name or username"></div></div>
      <section class="panel">${table({ cols: [{ key: 'displayName', label: 'Name', cls: 'id', html: (u) => `${esc(u.displayName)}<div class="muted small">${esc(u.username)}</div>` }, { key: 'roleId', label: 'Role', html: (u) => esc(store.role(u.roleId)?.name || u.roleId) }, { key: 'departments', label: 'Departments', html: (u) => esc(Object.keys(u.departments || {}).map((d) => store.deptName(d)).join(', ')) },
    { key: 'scope', label: 'Project access', html: (u) => `${esc({ all: 'All projects', dept: 'Department projects', selected: 'Selected' }[u.scope] || '')}${u.projects ? ` <span class="muted">+${Object.keys(u.projects).length}</span>` : ''}${u.overrides ? ' <span class="badge info plain">individual permissions</span>' : ''}` },
    { key: 'active', label: 'Status', html: (u) => `${badge(u.active === false ? 'Deactivated' : 'Active')}${u.mustChangePassword ? ' <span class="badge warn plain">must change password</span>' : ''}${u.idx.resetRequestedAt ? ` <span class="badge crit plain" title="${esc(fmtDateTime(u.idx.resetRequestedAt))}">password reset requested</span>` : ''}` },
    { key: 'lastLoginAt', label: 'Last sign-in', html: (u) => (u.lastLoginAt ? `<span title="${esc(fmtDateTime(u.lastLoginAt))}">${esc(timeAgo(u.lastLoginAt))}</span>` : '<span class="muted">never</span>') }, { key: 'failed', label: 'Failed sign-ins', num: true, html: (u) => (u.idx.failed ? `<b style="color:var(--warn-ink)">${u.idx.failed}</b>` : '0') },
    { key: 'x', label: '', html: (u) => `<div class="actions"><button class="btn sm" data-act="editUser" data-id="${esc(u.id)}">Edit</button><button class="btn sm" data-act="perms" data-id="${esc(u.id)}">Permissions</button><button class="btn sm" data-act="resetPw" data-id="${esc(u.id)}">Reset password</button><a class="btn sm ghost" href="#/people/${esc(u.id)}">Activity</a>${u.id !== session.userId ? `<button class="btn sm ${u.active === false ? '' : 'danger'}" data-act="toggleUser" data-id="${esc(u.id)}">${u.active === false ? 'Reactivate' : 'Deactivate'}</button>` : ''}</div>` }], rows })}</section>`,
    actions: {
      newUser: () => formModal({ title: 'New user', wide: true, fields: userFields(true), values: { scope: 'selected', roleId: 'department_user' }, submitLabel: 'Create user', successMessage: 'User created. Give them the username and temporary password.', onSubmit: (v) => A.createUser(v) }),
      editUser: (d) => { const u = store.user(d.id); return formModal({ title: `Edit ${u.displayName}`, wide: true, fields: userFields(false), values: userInput(u), onSubmit: (v) => A.updateUser(u.id, { ...userInput(u), ...v }) }); },
      toggleUser: async (d) => { const u = store.user(d.id); const off = u.active !== false; if (await confirmDialog({ title: off ? `Deactivate ${u.displayName}` : `Reactivate ${u.displayName}`, body: off ? 'The user loses all access immediately, including in sessions that are already open. Their records and history are kept.' : 'The user gets their role’s access back.', danger: off, confirmLabel: off ? 'Deactivate' : 'Reactivate' })) await A.setUserActive(u.id, !off).then(() => toast(off ? 'User deactivated.' : 'User reactivated.')); },
      resetPw: (d) => { const u = store.user(d.id); return formModal({ title: `Reset password — ${u.displayName}`, intro: `A new sign-in is issued for this user and the old one stops working. They must change the temporary password at the next sign-in.${u.id === session.userId ? ' <b>You are resetting your own password: you will be signed out.</b>' : ''}`, fields: [{ name: 'tempPassword', label: 'New temporary password', type: 'password', req: true, wide: true }], submitLabel: 'Reset password', successMessage: 'Password reset. Give the user the temporary password.', onSubmit: (v) => A.resetUserPassword(u.id, v.tempPassword) }); },
      perms: (d) => overridesDialog(store.user(d.id)),
    },
  };
}

function overridesDialog(u) {
  const role = store.role(u.roleId);
  const state = JSON.parse(JSON.stringify(u.overrides || {}));
  const cell = (m, a) => { const v = state[m.id]?.[a]; const base = u.roleId === 'super_admin' || role?.permissions?.[m.id]?.[a]; return `<td><button type="button" class="btn sm ${v === true ? 'primary' : v === false ? 'danger' : 'ghost'}" data-m="${m.id}" data-a="${a}" title="Role: ${base ? 'allowed' : 'not allowed'}${role?.deptRestricted ? ' (subject to department)' : ''}">${v === true ? 'Allow' : v === false ? 'Deny' : base ? '✓' : '–'}</button></td>`; };
  const body = () => `<p class="soft">Individual permissions for <b>${esc(u.displayName)}</b> (${esc(role?.name || '')}). Click a cell to cycle: role default → <b>Allow</b> → <b>Deny</b>. An individual setting always wins over the role and its department restriction.</p>
    <div class="table-wrap" style="max-height:56vh"><table class="tbl matrix"><thead><tr><th>Module</th>${COLS.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr></thead><tbody>${MODULES.map((m) => `<tr><td>${esc(m.label)}</td>${COLS.map(([a]) => (moduleActions(m).includes(a) ? cell(m, a) : '<td class="na">·</td>')).join('')}</tr>`).join('')}</tbody></table></div>`;
  const m = openModal({ title: 'Individual permissions', wide: true, body: `<div data-mx>${body()}</div>`, footer: '<button class="btn" data-x>Cancel</button><button class="btn primary" data-save>Save permissions</button>' });
  m.el.querySelector('.modal').style.width = 'min(1180px, 100%)';
  m.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]');
    if (b) { const cur = state[b.dataset.m]?.[b.dataset.a]; const next = cur === undefined ? true : cur === true ? false : undefined; (state[b.dataset.m] ||= {}); if (next === undefined) delete state[b.dataset.m][b.dataset.a]; else state[b.dataset.m][b.dataset.a] = next; m.el.querySelector('[data-mx]').innerHTML = body(); }
    if (e.target.closest('[data-x]')) m.close();
    const save = e.target.closest('[data-save]');
    if (save) withBusy(save, async () => { await A.updateUser(u.id, { ...userInput(u), overrides: state }); m.close(); }, 'Permissions saved.');
  });
}

/* ------------------------------------------------------------------ roles */
function rolesSection(ctx) {
  const roles = store.roles(); const id = ctx.state.role && roles[ctx.state.role] ? ctx.state.role : 'department_user';
  const r = roles[id]; const locked = id === 'super_admin';
  const used = (rid) => store.users().filter((u) => u.roleId === rid).length;
  return {
    html: `${pageHead({ title: 'Roles and permissions', sub: 'Each permission is set independently per module. Department-restricted roles can only create, edit, update and approve in the modules owned by the user’s departments.', actions: btn('newRole', 'New role', { ic: 'plus', cls: 'primary' }) })}
      <div class="filters"><div class="field grow"><label for="rolePick">Role</label><select id="rolePick" data-bind="role">${Object.entries(roles).map(([rid, x]) => `<option value="${rid}"${rid === id ? ' selected' : ''}>${esc(x.name)} — ${used(rid)} user${used(rid) === 1 ? '' : 's'}${x.system ? '' : ' (custom)'}</option>`).join('')}</select></div></div>
      <section class="panel"><header><h2>${esc(r.name)}</h2>${r.system ? '<span class="badge plain">Standard role</span>' : btn('delRole', 'Delete role', { cls: 'danger sm', ic: 'trash' })}</header><div class="body"><form id="roleForm">
        ${locked ? '<div class="note">The Super Admin role always has every permission and cannot be edited. It is the only role with access to Administration.</div>' : `<div class="formgrid" style="margin-bottom:14px">${fieldHtml({ name: 'name', label: 'Role name', req: true }, r.name)}${fieldHtml({ name: 'dashboard', label: 'Dashboard layout', type: 'select', req: true, opts: [['org', 'Organisation overview'], ['pm', 'Project manager'], ['dept', 'Department workload'], ['user', 'My tasks'], ['viewer', 'Read-only']] }, r.dashboard)}${fieldHtml({ name: 'description', label: 'Description', wide: true }, r.description)}${fieldHtml({ name: 'deptRestricted', label: 'Department-restricted role', type: 'bool', wide: true, hint: 'When ticked, create / edit / update status / upload / approve only work in modules owned by one of the user’s departments (see Departments → Module ownership). Viewing stays open, except for financial modules.' }, r.deptRestricted)}</div>`}
        <div class="table-wrap"><table class="tbl matrix"><thead><tr><th>Module</th>${COLS.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr></thead><tbody>${MODULES.map((m) => `<tr><td>${esc(m.label)}${m.restrictView ? ' <span class="muted small">(financial)</span>' : ''}</td>${COLS.map(([a]) => (moduleActions(m).includes(a) ? `<td><input type="checkbox" data-pm="${m.id}" data-pa="${a}"${locked || r.permissions?.[m.id]?.[a] ? ' checked' : ''}${locked ? ' disabled' : ''} aria-label="${esc(`${m.label}: ${a}`)}"></td>` : '<td class="na">·</td>')).join('')}</tr>`).join('')}</tbody></table></div>
        ${locked ? '' : `<div style="margin-top:14px">${btn('saveRole', 'Save role', { cls: 'primary', ic: 'check' })} <span class="muted small">Saving updates the effective permissions of every user with this role at once.</span></div>`}</form></div></section>`,
    actions: {
      saveRole: (d, el) => withBusy(el, async () => { const form = document.getElementById('roleForm'); const v = readForm(form, [{ name: 'name', label: 'Role name', req: true }, { name: 'dashboard' }, { name: 'description' }, { name: 'deptRestricted', type: 'bool' }]); const permissions = {}; $$('[data-pm]:checked', form).forEach((c) => { (permissions[c.dataset.pm] ||= {})[c.dataset.pa] = true; }); await A.saveRole(id, { ...v, permissions }); }, 'Role saved.'),
      newRole: () => formModal({ title: 'New role', fields: [{ name: 'name', label: 'Role name', req: true }, { name: 'copy', label: 'Start from the permissions of', type: 'select', req: true, opts: Object.entries(roles).filter(([rid]) => rid !== 'super_admin').map(([rid, x]) => [rid, x.name]), value: 'viewer' }, { name: 'description', label: 'Description', wide: true }], submitLabel: 'Create role', onSubmit: async (v) => { const src = roles[v.copy]; const rid = await A.saveRole(null, { name: v.name, description: v.description, deptRestricted: src.deptRestricted, dashboard: src.dashboard, permissions: src.permissions }); ctx.state.role = rid; } }),
      delRole: async () => { if (await confirmDialog({ title: `Delete role “${esc(r.name)}”`, body: 'A role can only be deleted when no user has it.', danger: true, confirmLabel: 'Delete role' })) await A.deleteRole(id).then(() => { ctx.state.role = 'department_user'; toast('Role deleted.'); }); },
    },
  };
}

/* ------------------------------------------------------------------ departments */
function departmentsSection() {
  const depts = store.departments(); const st = store.settings();
  return {
    html: `${pageHead({ title: 'Departments', sub: 'Add, rename and deactivate departments, and decide which department owns which module.', actions: btn('newDept', 'New department', { ic: 'plus', cls: 'primary' }) })}
      <div class="stack"><section class="panel">${table({ cols: [{ key: 'name', label: 'Department', cls: 'id' }, { key: 'users', label: 'Users', num: true, html: (d) => store.users().filter((u) => u.departments?.[d.id]).length }, { key: 'active', label: 'Status', html: (d) => badge(d.active === false ? 'Deactivated' : 'Active') }, { key: 'x', label: '', html: (d) => `<button class="btn sm" data-act="editDept" data-id="${esc(d.id)}">Edit</button>` }], rows: depts })}</section>
      <section class="panel"><header><h2>Module ownership</h2><span class="muted small">Used by department-restricted roles (Department Head, Department User)</span></header>${table({ cols: [{ key: 'label', label: 'Module', cls: 'id' }, { key: 'owners', label: 'Owning departments', html: (m) => esc(moduleOwners(m.id, st).map((d) => store.deptName(d)).join(', ') || 'Not restricted — open to all departments') }, { key: 'x', label: '', html: (m) => `<button class="btn sm" data-act="owners" data-id="${m.id}">Change</button>` }], rows: MODULES.filter((m) => m.depts.length || st.moduleDepartments?.[m.id]) })}</section></div>`,
    actions: {
      newDept: () => formModal({ title: 'New department', fields: [{ name: 'name', label: 'Department name', req: true, wide: true }], submitLabel: 'Add department', onSubmit: (v) => A.saveDepartment(null, v) }),
      editDept: (d) => { const cur = depts.find((x) => x.id === d.id); return formModal({ title: `Edit ${cur.name}`, fields: [{ name: 'name', label: 'Department name', req: true, wide: true }, { name: 'active', label: 'Active', type: 'bool', hint: 'Deactivated departments stay on existing records but cannot be chosen for new ones.' }], values: { name: cur.name, active: cur.active !== false }, onSubmit: (v) => A.saveDepartment(cur.id, v) }); },
      owners: (d) => { const m = MODULES.find((x) => x.id === d.id); return formModal({ title: `Who owns “${m.label}”?`, intro: 'Users with a department-restricted role can create, edit, update and approve in this module only if they belong to one of these departments.', fields: [{ name: 'depts', label: 'Owning departments', type: 'multi', opts: depts.filter((x) => x.active !== false).map((x) => [x.id, x.name]) }], values: { depts: moduleOwners(m.id, st) }, successMessage: 'Ownership saved; permissions recalculated.', onSubmit: (v) => A.saveSettings({ moduleDepartments: { ...(st.moduleDepartments || {}), [m.id]: Object.fromEntries(v.depts.map((x) => [x, true])) } }) }); },
    },
  };
}

/* ------------------------------------------------------------------ settings */
function settingsSection() {
  const st = { ...defaultSettings(), ...store.settings() }; const h = { ...defaultSettings().health, ...(st.health || {}) }; const sc = { ...defaultSettings().stageScores, ...(st.stageScores || {}) };
  const stageKeys = [...new Map(STAGE_TEMPLATES.filter((t) => t.branch === 'A').map((t) => [t.key, t])).values()];
  const F = [
    { name: 'orgName', label: 'Organisation name', req: true }, { name: 'currency', label: 'Currency code', req: true, hint: 'ISO code, e.g. INR, USD.' },
    { name: 'sessionIdleMinutes', label: 'Sign out after inactivity (minutes)', type: 'number', req: true }, { name: 'sessionMaxHours', label: 'Maximum session length (hours)', type: 'number', req: true },
    { name: 'dueSoonDays', label: '“Due soon” window (days)', type: 'number', req: true }, { name: 'upcomingDays', label: '“Upcoming” window (days)', type: 'number', req: true }, { name: 'rgpReminderDays', label: 'RGP return reminder (days before)', type: 'number', req: true }, { name: 'maxInlineFileKb', label: 'Largest file stored in the database (KB)', type: 'number', req: true },
    { name: 'transferApprovalRequired', label: 'Stock transfers need approval before dispatch', type: 'bool', wide: true }, { name: 'allowSelfApproval', label: 'Allow people to approve their own purchase requests', type: 'bool', wide: true, hint: 'Leave off for a proper four-eyes check.' },
    { name: 'projectCategories', label: 'Project categories (comma-separated)', type: 'textarea' }, { name: 'units', label: 'Units of measurement (comma-separated)', type: 'textarea' }, { name: 'paymentModes', label: 'Payment modes (comma-separated)', type: 'textarea' },
  ];
  const HF = [['redOverdueCritical', 'RED when overdue activities on high / critical items reach'], ['redOverdueDays', 'RED when any activity is overdue by (days)'], ['redTestFailures', 'RED when items with an unresolved test failure reach'], ['amberOverdue', 'AMBER when overdue activities reach'], ['amberPendingApprovalDays', 'AMBER when an approval has waited (days)'], ['amberUncoveredItems', 'AMBER when items with an uncovered shortage reach'], ['amberRgpOverdue', 'AMBER when overdue returnable gate passes reach']].map(([name, label]) => ({ name: `h_${name}`, label, type: 'number', hint: '0 switches the rule off.' }));
  const SF = Object.keys(sc).map((k) => ({ name: `s_${k}`, label: `Progress credit for “${k}” (%)`, type: 'number' }));
  const WF = stageKeys.map((t) => ({ name: `w_${t.key}`, label: `Weight: ${t.name}`, type: 'number' }));
  const vals = { ...st, projectCategories: (st.projectCategories || []).join(', '), units: (st.units || []).join(', '), paymentModes: (st.paymentModes || []).join(', '), ...Object.fromEntries(Object.entries(h).map(([k, v]) => [`h_${k}`, v])), ...Object.fromEntries(Object.entries(sc).map(([k, v]) => [`s_${k}`, Math.round(v * 100)])), ...Object.fromEntries(stageKeys.map((t) => [`w_${t.key}`, st.stageWeights?.[t.key] ?? t.w])) };
  const block = (title, fields, note) => `<section class="panel"><header><h2>${title}</h2></header><div class="body">${note ? `<p class="muted small">${note}</p>` : ''}<div class="formgrid">${fields.map((f) => fieldHtml(f, vals[f.name], 'st')).join('')}</div></div></section>`;
  return {
    html: `${pageHead({ title: 'Settings', actions: `${btn('save', 'Save settings', { cls: 'primary', ic: 'check' })}${btn('recompute', 'Recalculate all permissions', { ic: 'refresh' })}${isDemo() ? '' : btn('checkRules', 'Check security rules', { ic: 'shield' })}` })}
      <form id="settingsForm" class="stack">${block('General, sessions and deadlines', F)}${block('Project health rules', HF, 'Health is recalculated live from these thresholds. Each project page lists the rules that fired.')}${block('Progress calculation', [...SF, ...WF], 'Item progress = weighted average of its Branch A stages; each stage contributes its weight × the credit for its status. Project progress = average of its items.')}</form>`,
    actions: {
      save: (d, el) => withBusy(el, async () => {
        const v = readForm(document.getElementById('settingsForm'), [...F, ...HF, ...SF, ...WF]);
        const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
        const patch = Object.fromEntries(F.map((f) => [f.name, v[f.name]]));
        Object.assign(patch, { projectCategories: list(v.projectCategories), units: list(v.units), paymentModes: list(v.paymentModes), currency: String(v.currency).toUpperCase(),
          health: Object.fromEntries(HF.map((f) => [f.name.slice(2), Number(v[f.name]) || 0])), stageScores: Object.fromEntries(SF.map((f) => [f.name.slice(2), Math.max(0, Math.min(100, Number(v[f.name]) || 0)) / 100])), stageWeights: Object.fromEntries(WF.map((f) => [f.name.slice(2), Number(v[f.name]) || 0])) });
        if (!patch.units.length || !patch.paymentModes.length) throw new AppError('Keep at least one unit and one payment mode.');
        await A.saveSettings(patch);
      }, 'Settings saved.'),
      recompute: (d, el) => withBusy(el, () => A.recomputeAllPermissions(), 'Permissions recalculated for every user.'),
      checkRules: (d, el) => withBusy(el, async () => {
        // A write to a path no rule allows must be refused. If it succeeds, the database is wide open.
        let open = false;
        try { await be().update({ '/_rulesProbe': { at: Date.now() } }); open = true; await be().update({ '/_rulesProbe': null }).catch(() => {}); } catch { open = false; }
        if (open) throw new AppError('DANGER: the database accepted a write that the security rules must refuse. The rules in firebase/database.rules.json are NOT published. Publish them now (README, step 4).');
        toast('Security rules are active: a forbidden write was refused by the server.');
      }),
    },
  };
}

/* ------------------------------------------------------------------ audit log */
function auditSection(ctx) {
  const s = ctx.state;
  const sel = (key, label, opts) => `<div class="field"><label for="au_${key}">${label}</label><select id="au_${key}" data-bind="${key}"><option value="">All</option>${opts.map(([v, l]) => `<option value="${esc(v)}"${String(s[key] || '') === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
  const filter = (rows) => rows.filter((l) => (!s.user || l.uid === s.user) && (!s.project || l.pid === s.project) && (!s.from || new Date(l.at).toISOString().slice(0, 10) >= s.from) && (!s.to || new Date(l.at).toISOString().slice(0, 10) <= s.to) && (!s.q || `${l.action} ${l.rid || ''} ${l.name || ''} ${l.rtype || ''}`.toLowerCase().includes(s.q.toLowerCase())));
  return {
    html: `${pageHead({ title: 'Audit log', sub: 'The complete, organisation-wide trail. Entries are append-only: nobody — including the Super Admin — can change or delete them.', actions: btn('exportAudit', 'Export CSV', { ic: 'download' }) })}
      <div class="filters"><div class="field grow"><label for="au_q">Search</label><input id="au_q" data-bind="q" value="${esc(s.q || '')}" placeholder="Action, record ID, user"></div>${sel('user', 'User', store.users().map((u) => [u.id, u.displayName]))}${sel('project', 'Project', store.projects({ archived: true }).map((p) => [p.id, p.id]))}
        <div class="field"><label for="au_from">From</label><input id="au_from" type="date" data-bind="from" value="${esc(s.from || '')}"></div><div class="field"><label for="au_to">To</label><input id="au_to" type="date" data-bind="to" value="${esc(s.to || '')}"></div></div>
      <section class="panel"><div class="body" id="auditBody"><span class="muted">Loading the audit trail…</span></div></section>`,
    actions: { exportAudit: async () => { const rows = filter(s.rows || await fullAuditTrail()); downloadCSV(`audit-log-${today()}`, [['Date and time', 'User ID', 'User name', 'Department', 'Action', 'Record type', 'Record ID', 'Project ID', 'Old value', 'New value', 'Note'], ...rows.map((l) => [new Date(l.at).toISOString(), l.uid, l.name, store.deptName(l.dept), l.action, l.rtype, l.rid || '', l.pid || '', l.old ? JSON.stringify(l.old) : '', l.new ? JSON.stringify(l.new) : '', l.note || ''])]); toast('Audit log exported.'); } },
    mount(root) {
      const draw = (rows) => { const el = root.querySelector('#auditBody'); if (!el) return; const f = filter(rows); el.innerHTML = `${logRowsHtml(f.slice(0, 400), { withRecord: true })}<div class="tablefoot">${f.length} of ${rows.length} entries${f.length > 400 ? ' — showing the latest 400; the export contains all' : ''}</div>`; };
      if (s.rows) draw(s.rows);
      fullAuditTrail().then((rows) => { s.rows = rows; draw(rows); }).catch(showError);
    },
  };
}

/* ------------------------------------------------------------------ backup */
function backupSection() {
  const save = (name, obj) => download(`${name}-${today()}.json`, JSON.stringify(obj, null, 1), 'application/json');
  return {
    html: `${pageHead({ title: 'Backup and restore' })}<div class="stack">
      <section class="panel"><header><h2>Export</h2></header><div class="body"><p>Download everything in the database as one JSON file, or just one area. Keep backups somewhere safe — they contain all project and financial data.</p><div class="actions">${btn('full', 'Download full backup', { ic: 'database', cls: 'primary' })}${PARTIAL_EXPORTS.map(([id, label]) => btn('partial', label, { ic: 'download', data: { id } })).join('')}</div></div></section>
      <section class="panel"><header><h2>Restore</h2></header><div class="body"><p>A backup is always checked first. Nothing is overwritten without your explicit confirmation, and a fresh backup of the current data is downloaded before any restore.</p>
        ${isDemo() ? '' : '<div class="note">In Firebase mode the validated file is imported by the project owner in the Firebase console (Realtime Database → ⋮ → Import JSON). The application itself has no permission to overwrite history or audit logs — by design. See README → “Restore a backup”.</div>'}
        <input type="file" id="restoreFile" accept="application/json,.json" hidden>${btn('pick', 'Choose a backup file to check…', { ic: 'upload' })}<div id="restoreResult" style="margin-top:14px"></div></div></section>
      ${isDemo() ? `<section class="panel"><header><h2>Demo tools</h2><span class="badge warn plain">Demo mode only</span></header><div class="body"><p>These exist only while Firebase is not configured.</p><div class="actions">${btn('sample', 'Load the sample project', { ic: 'download' })}${btn('resetDemo', 'Reset all demo data', { ic: 'trash', cls: 'danger' })}</div></div></section>` : ''}</div>`,
    actions: {
      full: (d, el) => withBusy(el, async () => save('projectflow360-backup', await exportAll()), 'Backup downloaded.'),
      partial: (d, el) => withBusy(el, async () => { const [id, , keys] = PARTIAL_EXPORTS.find((x) => x[0] === d.id); save(`projectflow360-${id}`, pickPartial(await exportAll(), keys)); }, 'Export downloaded.'),
      pick: () => document.getElementById('restoreFile').click(),
      sample: async () => { if (!await confirmDialog({ title: 'Load the sample project', body: 'Runs the real workflow with the demo accounts (about 15 seconds). You will be signed out at the end.', confirmLabel: 'Load sample data' })) return; const m = openModal({ title: 'Loading sample project…', body: '<div class="spinner"></div><p id="sampleStep" style="text-align:center;margin-top:12px" class="soft">Starting…</p>' }); try { await loadSampleData((x) => { const el = document.getElementById('sampleStep'); if (el) el.textContent = x; }); location.replace('login.html?reason=reset'); } catch (e) { m.close(); showError(e); be().auth.signOut().finally(() => setTimeout(() => location.replace('login.html'), 2500)); } },
      resetDemo: async () => { if (await confirmDialog({ title: 'Reset all demo data', body: 'This erases every project, record and user change in this browser’s demo and restores the original demo accounts.', danger: true, confirmLabel: 'Erase demo data', requireText: 'RESET' })) { store.stop(); await be().resetDemo(); location.replace('login.html'); } },
    },
    mount(root) {
      root.querySelector('#restoreFile').addEventListener('change', async (e) => {
        const file = e.target.files[0]; e.target.value = ''; if (!file) return;
        const out = root.querySelector('#restoreResult');
        let data; try { data = JSON.parse(await file.text()); } catch { out.innerHTML = '<div class="err">This file is not valid JSON.</div>'; return; }
        const v = validateBackup(data);
        out.innerHTML = `${v.ok ? `<div class="note">The backup from <b>${esc(data.exportedAt || 'unknown date')}</b> passed validation.</div>` : `<div class="err"><b>The backup failed validation and cannot be restored:</b><br>${v.errors.map(esc).join('<br>')}</div>`}
          ${table({ cols: [{ key: 'k', label: 'Section' }, { key: 'n', label: 'Records', num: true }], rows: Object.entries(v.summary).map(([k, n]) => ({ k, n })), empty: '' })}${v.ok && isDemo() ? `<div style="margin-top:12px"><button class="btn danger" id="doRestore">${icon('upload')}Restore this backup…</button></div>` : ''}`;
        out.querySelector('#doRestore')?.addEventListener('click', async () => {
          if (!await confirmDialog({ title: 'Replace all current data', body: 'Everything currently in the demo database will be replaced by this backup. A backup of the current data is downloaded first.', danger: true, confirmLabel: 'Restore', requireText: 'RESTORE' })) return;
          try { save('projectflow360-before-restore', await exportAll()); await restoreDemo(data); toast('Backup restored. Signing out…'); store.stop(); await be().auth.signOut(); setTimeout(() => location.replace('login.html'), 1200); } catch (err) { showError(err); }
        });
      });
    },
  };
}

export function adminView(ctx) {
  if (!isSuperAdmin()) return { title: 'Administration', html: '<div class="panel"><div class="empty"><b>Only the Super Admin can open Administration.</b></div></div>' };
  const sec = { users: usersSection, roles: rolesSection, departments: departmentsSection, settings: settingsSection, audit: auditSection, backup: backupSection }[ctx.params[0]](ctx);
  const tabs = tabsBar([['users', 'Users'], ['roles', 'Roles'], ['departments', 'Departments'], ['settings', 'Settings'], ['audit', 'Audit log'], ['backup', 'Backup']], ctx.params[0], (t) => `#/admin/${t}`);
  return { title: `Administration — ${ctx.params[0]}`, ...sec, html: tabs + sec.html };
}
