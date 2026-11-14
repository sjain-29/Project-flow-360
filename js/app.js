/**
 * Application shell: session check, navigation (built from the user's
 * permissions), hash router, live re-rendering, session expiry.
 *
 * Hidden menus are a convenience only. Whatever a user types into the address
 * bar, the data layer loads nothing the security rules do not allow.
 */
import { initBackend, isDemo, be } from './services/backend.js';
import { establish, session, can, isSuperAdmin, logout, touchActivity, sessionExpiry } from './services/session.js';
import { store } from './services/store.js';
import { overdue } from './services/insights.js';
import { syncReminders } from './services/reminders.js';
import { APP } from './config/app-config.js';
import { $, esc, icon, showError, modalIsOpen } from './components/ui.js';
import { timeAgo, fmtDateTime } from './utils/format.js';
import { dashboardView } from './modules/dashboard.js';
import { projectsView, projectView } from './modules/projects.js';
import { itemView } from './modules/item.js';
import { listView, recordView, groupFor, permittedTabs } from './modules/records.js';
import { deadlinesView, departmentsView, notificationsView, searchView, personView, accountView, helpView } from './modules/work.js';
import { reportsView } from './modules/reports.js';
import { adminView } from './modules/admin.js';

const ROUTES = [
  [/^\/dashboard$/, dashboardView],
  [/^\/projects$/, projectsView],
  [/^\/projects\/([^/]+)$/, projectView],
  [/^\/items\/([^/]+)\/([^/]+)$/, itemView],
  [/^\/m\/([^/]+)$/, listView],
  [/^\/r\/([^/]+)\/([^/]+)\/([^/]+)$/, recordView],
  [/^\/deadlines$/, deadlinesView],
  [/^\/departments(?:\/([^/]+))?$/, departmentsView],
  [/^\/reports(?:\/([^/]+))?$/, reportsView],
  [/^\/search$/, searchView],
  [/^\/notifications$/, notificationsView],
  [/^\/people\/([^/]+)$/, personView],
  [/^\/account$/, accountView],
  [/^\/help$/, helpView],
  [/^\/admin\/(users|roles|departments|settings|audit|backup)$/, adminView],
];

const NAV = [
  ['#/dashboard', 'Dashboard', 'dashboard'],
  ['#/projects', 'Projects', 'projects', 'projects.view'],
  ['#/departments', 'My work', 'clipboard'],
  ['#/deadlines', 'Deadlines', 'clock', null, () => overdue().length],
  ['group:procurement', 'Procurement', 'cart'],
  ['group:material', 'Material', 'stock'],
  ['group:movement', 'Movement', 'truck'],
  ['group:engineering', 'Engineering', 'wrench'],
  ['#/reports', 'Reports', 'chart', 'reports.view'],
  ['#/admin/users', 'Administration', 'settings', 'sa'],
];

const root = document.getElementById('app');
let current = null;      // { view, ctx, key }
let dirty = false;
let renderTimer = null;
const states = new Map(); // per-route view state (filters, tabs…)
let leaving = false;

const parseHash = () => {
  const raw = location.hash.replace(/^#/, '') || '/dashboard';
  const [path, qs] = raw.split('?');
  return { path, query: new URLSearchParams(qs || '') };
};
const allowed = (perm) => !perm || (perm === 'sa' ? isSuperAdmin() : can(perm));

async function leave(reason) {
  if (leaving) return; leaving = true;
  store.stop();
  await logout(reason).catch(() => {});
  location.replace(`login.html?reason=${reason === 'deactivated' ? 'deactivated' : reason === 'signed out' ? 'signedout' : 'expired'}`);
}

/* ------------------------------------------------------------------ shell */
function navHtml() {
  const { path } = parseHash();
  const here = `#${path}`;
  const group = groupFor((/^#\/(?:m|r)\/([^/]+)/.exec(here) || [])[1]);
  return NAV.map(([href, label, ic, perm, count]) => {
    let link = href; let active;
    if (href.startsWith('group:')) {
      // one menu entry per area; its modules are tabs on the page, filtered by permission
      const tabs = permittedTabs(href.slice(6));
      if (!tabs.length) return '';
      link = `#/m/${tabs[0][0]}`; active = group === href.slice(6);
    } else {
      if (!allowed(perm)) return '';
      active = here === href || here.startsWith(`${href}/`) || (href === '#/projects' && here.startsWith('#/items/')) || (href.startsWith('#/admin') && here.startsWith('#/admin'));
    }
    const n = count ? count() : 0;
    return `<a href="${link}" data-k="${ic}"${active ? ' aria-current="page"' : ''}>${icon(ic)}<span>${esc(label)}</span>${n ? `<span class="count" title="${n} overdue">${n}</span>` : ''}</a>`;
  }).join('');
}

function shellHtml() {
  const u = session.user;
  const initials = (u.displayName || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return `
  <div class="shell">
    <aside class="rail" id="rail">
      <a class="brand" href="#/dashboard" style="color:inherit;text-decoration:none"><img src="assets/logo.svg" alt=""><div><b>ProjectFlow 360</b><span id="orgName"></span></div></a>
      <nav class="nav" id="nav" aria-label="Main"></nav>
      <div class="rail-foot">Version ${APP.version} · <a href="#/help">Help</a></div>
    </aside>
    <div class="main">
      ${isDemo() ? `<div class="demo-banner">${icon('alert')}<span><b>Demo mode.</b> Not connected to Firebase — data lives only in this browser and is not shared with anyone.</span></div>` : ''}
      <header class="topbar">
        <button class="iconbtn menu-toggle" id="menuToggle" aria-label="Open menu" aria-controls="rail">${icon('menu')}</button>
        <form class="search" id="searchForm" role="search">${icon('search')}<input id="q" type="search" placeholder="Search projects, items, PR, PO, GRN, vendors…" aria-label="Search" autocomplete="off"></form>
        <span class="spacer"></span>
        <div class="rel"><button class="iconbtn" id="bell" aria-label="Notifications" aria-haspopup="true">${icon('bell')}<span class="dot" id="bellDot" hidden></span></button><div class="pop" id="bellPop" hidden></div></div>
        <div class="rel"><button class="userchip" id="userBtn" aria-haspopup="true"><span class="avatar">${esc(initials)}</span><div><b>${esc(u.displayName)}</b><span id="userSub"></span></div></button><div class="pop" id="userPop" hidden></div></div>
      </header>
      <main class="content" id="content" tabindex="-1"></main>
    </div>
  </div>`;
}

function refreshChrome() {
  $('#nav').innerHTML = navHtml();
  $('#orgName').textContent = store.settings().orgName || '';
  $('#userSub').textContent = `${store.role(session.user.roleId)?.name || ''} · ${store.deptName(session.user.departmentId)}`;
  const unread = store.notifications().filter((n) => !n.read).length;
  const dot = $('#bellDot');
  dot.hidden = unread === 0; dot.textContent = unread > 99 ? '99+' : unread;
}

function bellPopHtml() {
  const list = store.notifications().slice(0, 8);
  return `<header><b>Notifications</b>${list.some((n) => !n.read) ? '<button class="btn sm ghost" data-shell="readAll">Mark all read</button>' : ''}</header>
    <div class="list">${list.map((n) => `<button data-shell="openNote" data-id="${esc(n.id)}" class="${n.read ? '' : 'unread'}"><span>${esc(n.title)}</span><small>${esc(n.fromName || '')} · ${esc(timeAgo(n.at))}</small></button>`).join('') || '<div class="empty">You have no notifications.</div>'}</div>
    <header><a href="#/notifications" data-shell="closePops">See all notifications</a></header>`;
}
function userPopHtml() {
  const u = session.user;
  return `<header><div><b>${esc(u.displayName)}</b><br><small class="muted">${esc(u.username)} · ${esc(store.role(u.roleId)?.name || '')} · ${esc(store.deptName(u.departmentId))}</small><br><small class="muted">Last sign-in: ${esc(u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : 'first time')}</small></div></header>
    <div class="list"><a href="#/account" data-shell="closePops">${icon('key')} My account and password</a><a href="#/help" data-shell="closePops">${icon('info')} Help</a><button data-shell="signOut">${icon('logout')} Sign out</button></div>`;
}
const closePops = () => { $('#bellPop').hidden = true; $('#userPop').hidden = true; };

const shellActions = {
  closePops,
  async readAll() {
    const u = {};
    for (const n of store.notifications()) if (!n.read) u[`/notifications/${session.userId}/${n.id}/read`] = true;
    await be().update(u).catch(showError);
    $('#bellPop').innerHTML = bellPopHtml();
  },
  async openNote(d) {
    const n = store.notifications().find((x) => x.id === d.id);
    closePops();
    if (!n) return;
    if (!n.read) be().update({ [`/notifications/${session.userId}/${n.id}/read`]: true }).catch(() => {});
    if (n.link) location.hash = n.link;
  },
  signOut: () => leave('signed out'),
};

/* ------------------------------------------------------------------ router */
function scheduleRender(delay = 0) { clearTimeout(renderTimer); renderTimer = setTimeout(render, delay); }

function render() {
  if (!store.isStarted() || leaving) return;
  if (modalIsOpen()) { dirty = true; return; }
  dirty = false;
  const { path, query } = parseHash();
  const content = $('#content');
  const match = ROUTES.map(([re, view]) => [re.exec(path), view]).find(([m]) => m);
  const sameRoute = current?.key === path;
  // remember focus (so typing in a filter survives re-rendering)
  const ae = document.activeElement;
  const focusId = sameRoute && ae && content.contains(ae) && ae.id ? ae.id : null;
  const caret = focusId && typeof ae.selectionStart === 'number' ? [ae.selectionStart, ae.selectionEnd] : null;
  const scrollY = window.scrollY;
  current?.ctx.cleanups.splice(0).forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  if (!states.has(path)) states.set(path, {});
  const ctx = { params: match ? match[0].slice(1).map((p) => (p === undefined ? undefined : decodeURIComponent(p))) : [], query, state: states.get(path), cleanups: [], rerender: () => scheduleRender(0), onCleanup: (fn) => ctx.cleanups.push(fn) };
  let view;
  try {
    view = match ? match[1](ctx) : { title: 'Page not found', html: '<div class="pagehead"><div class="titles"><h1>Page not found</h1></div></div><div class="panel"><div class="empty"><b>This page does not exist.</b><a href="#/dashboard">Go to the dashboard</a></div></div>' };
  } catch (e) {
    console.error(e);
    view = { title: 'Something went wrong', html: `<div class="panel"><div class="empty"><b>This page could not be shown.</b>${esc(e?.message || e)}</div></div>` };
  }
  content.innerHTML = view.html;
  document.title = `${view.title} — ProjectFlow 360`;
  current = { view, ctx, key: path };
  try { view.mount?.(content, ctx); } catch (e) { console.error(e); }
  refreshChrome();
  if (sameRoute) {
    window.scrollTo(0, scrollY);
    if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); if (caret && el.setSelectionRange) { try { el.setSelectionRange(caret[0], caret[1]); } catch { /* not a text input */ } } } }
  } else { window.scrollTo(0, 0); document.body.classList.remove('nav-open'); }
}

function wireEvents() {
  const content = $('#content');
  content.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act && content.contains(act)) {
      const fn = current?.view.actions?.[act.dataset.act];
      if (fn) { if (act.tagName !== 'INPUT') e.preventDefault(); Promise.resolve().then(() => fn(act.dataset, act, e)).catch(showError); }
      return;
    }
    const row = e.target.closest('[data-href]');
    if (row && !e.target.closest('a, button, input, select, label, textarea')) location.hash = row.dataset.href;
  });
  content.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('tr[data-href]')) location.hash = e.target.dataset.href; });
  // generic two-way binding for filters: <input data-bind="key">
  const onBind = (e) => {
    const el = e.target.closest('[data-bind]');
    if (!el || !current) return;
    current.ctx.state[el.dataset.bind] = el.type === 'checkbox' ? el.checked : el.value;
    scheduleRender(el.tagName === 'INPUT' && !['checkbox', 'date'].includes(el.type) ? 260 : 0);
  };
  content.addEventListener('input', onBind);
  content.addEventListener('change', (e) => { if (e.target.closest('select[data-bind], input[type=date][data-bind], input[type=checkbox][data-bind]')) onBind(e); });

  document.addEventListener('click', (e) => {
    const s = e.target.closest('[data-shell]');
    if (s) { const fn = shellActions[s.dataset.shell]; if (fn) Promise.resolve(fn(s.dataset, s)).catch(showError); }
    if (!e.target.closest('.rel')) closePops();
    if (document.body.classList.contains('nav-open') && !e.target.closest('#rail') && !e.target.closest('#menuToggle')) document.body.classList.remove('nav-open');
  });
  $('#menuToggle').addEventListener('click', () => document.body.classList.toggle('nav-open'));
  $('#nav').addEventListener('click', (e) => { if (e.target.closest('a')) document.body.classList.remove('nav-open'); });
  $('#bell').addEventListener('click', () => { const p = $('#bellPop'); const open = p.hidden; closePops(); if (open) { p.innerHTML = bellPopHtml(); p.hidden = false; } });
  $('#userBtn').addEventListener('click', () => { const p = $('#userPop'); const open = p.hidden; closePops(); if (open) { p.innerHTML = userPopHtml(); p.hidden = false; } });
  $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); const q = $('#q').value.trim(); if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`; });
  window.addEventListener('hashchange', () => scheduleRender(0));
  document.addEventListener('pf360:modalclosed', () => { if (dirty) scheduleRender(0); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePops(); document.body.classList.remove('nav-open'); } });

  // session expiry: activity keeps the session alive; the check also runs in background tabs
  let lastTouch = 0;
  const touch = () => { if (Date.now() - lastTouch > 15000) { lastTouch = Date.now(); touchActivity(); } };
  ['click', 'keydown', 'pointerdown'].forEach((ev) => document.addEventListener(ev, touch, { passive: true }));
  setInterval(() => { const why = sessionExpiry(store.settings()); if (why) leave(why); }, 20000);
  setInterval(() => syncReminders().catch(() => {}), 10 * 60000);
}

/* ------------------------------------------------------------------ start */
async function start() {
  try {
    await initBackend();
    const res = await establish();
    if (res.state !== 'ok') { location.replace(res.state === 'none' ? 'login.html' : 'login.html?mode=continue'); return; }
    const why = sessionExpiry(null);
    if (why) { await leave(why); return; }
    await store.start({ onAccessRevoked: (r) => leave(r) });
    root.innerHTML = shellHtml();
    wireEvents();
    store.onChange(() => scheduleRender(0));
    render();
    syncReminders().catch(() => {});
  } catch (e) {
    console.error(e);
    root.innerHTML = `<div class="loading"><div><p><b>The workspace could not be loaded.</b></p><p class="muted">${esc(e?.message || e)}</p><p><button class="btn" onclick="location.reload()">Try again</button> <a class="btn" href="login.html">Back to sign-in</a></p></div></div>`;
  }
}
start();
