/**
 * Browser smoke test (optional, needs Chrome):  CHROME=/path/to/chrome node tests/browser-smoke.mjs
 * Serves the app, loads the sample project, then signs in as several demo roles,
 * opens every screen at desktop and phone size and fails on any page error,
 * console error or horizontal page overflow. Screenshots go to tests/screens/.
 */
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try { const data = await readFile(join(root, p === '/' ? 'index.html' : p)); res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' }); res.end(data); } catch { res.writeHead(404); res.end('not found'); }
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const shots = join(root, 'tests', 'screens'); await mkdir(shots, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
const problems = [];
let where = 'start';
page.on('pageerror', (e) => problems.push(`[${where}] page error: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) problems.push(`[${where}] console: ${m.text().slice(0, 300)}`); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DESK = { width: 1366, height: 860 }; const PHONE = { width: 390, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

async function signIn(user) {
  where = `login ${user}`;
  await page.goto(`${base}/login.html`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#loginForm');
  await page.type('#u', user); await page.type('#p', 'demo1234');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#go')]);
  await page.waitForSelector('#content h1', { timeout: 15000 });
}
async function signOut() { await page.evaluate(() => { sessionStorage.clear(); localStorage.removeItem('pf360.demo.session'); localStorage.removeItem('pf360.session'); }); }
async function visit(hash, name, { shot = false, expect } = {}) {
  where = `${name} ${hash}`;
  await page.evaluate((h) => { location.hash = h; }, hash);
  await sleep(450);
  const info = await page.evaluate(() => ({ h1: document.querySelector('#content h1')?.textContent || '', text: document.querySelector('#content')?.innerText.slice(0, 4000) || '', overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
  if (!info.h1 && !/not found|permission|Only the Super Admin|restricted/i.test(info.text)) problems.push(`[${where}] no heading rendered`);
  if (/could not be shown|undefined|NaN|\[object Object\]/.test(info.text)) problems.push(`[${where}] suspicious text: ${info.text.match(/.{0,60}(could not be shown|undefined|NaN|\[object Object\]).{0,60}/)?.[0]}`);
  if (info.overflow > 2) problems.push(`[${where}] horizontal page overflow of ${info.overflow}px`);
  if (expect && !expect.test(info.text)) problems.push(`[${where}] expected ${expect}`);
  if (shot) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: false });
  return info;
}

try {
  await page.setViewport(DESK);
  // 1. login page (demo mode clearly labelled)
  await page.goto(`${base}/login.html`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#loginForm');
  if (!(await page.$eval('.demo-box', (e) => e.innerText)).includes('Demo mode')) problems.push('demo mode is not labelled on the login page');
  await page.screenshot({ path: join(shots, 'login-desktop.png') });
  where = 'bad login';
  await page.type('#u', 'admin'); await page.type('#p', 'wrong-password'); await page.click('#go'); await sleep(500);
  if (!/Incorrect username or password/.test(await page.$eval('[data-msg]', (e) => e.innerText))) problems.push('wrong password does not show an error');

  // 2. admin: empty dashboard → load sample data through the UI
  await signIn('admin');
  await visit('#/dashboard', 'dashboard-empty', { expect: /Start with a sample project/ });
  where = 'load sample';
  await page.click('[data-act="sample"]'); await page.waitForSelector('.modal [data-yes]'); await page.click('.modal [data-yes]');
  await page.waitForSelector('#loginForm', { timeout: 120000 });

  // 3. every screen as admin
  await signIn('admin');
  const pid = 'DRN-A1';
  const ids = await page.evaluate(async () => { const { store } = await import('./js/services/store.js'); const first = (c) => store.list(c, 'DRN-A1')[0]?.id; return { item: store.list('projectItems', 'DRN-A1').find((i) => i.itemCode === 'FC-H743').id, pr: first('purchaseRequests'), po: first('purchaseOrders'), trf: first('stockTransfers'), req: first('procurement'), gp: first('gatePasses'), mr: first('materialRequests'), dsp: first('dispatches'), tc: first('testing'), q: first('quotations'), stock: store.stock()[0].id }; });
  const routes = [['#/dashboard', 'dashboard', /Critical activities/], ['#/projects', 'projects', /DRN-A1/], [`#/projects/${pid}`, 'project-overview', /Project health/], [`#/projects/${pid}?tab=items`, 'project-items', /FC-H743/], [`#/projects/${pid}?tab=timeline`, 'project-timeline', /Project timeline/], [`#/projects/${pid}?tab=activities`, 'project-activities'], [`#/projects/${pid}?tab=expenditure`, 'project-expenditure', /Consolidated/], [`#/projects/${pid}?tab=documents`, 'project-documents'], [`#/projects/${pid}?tab=discussion`, 'project-comments', /Kick-off/], [`#/projects/${pid}?tab=history`, 'project-history', /Stage|PR|Project/], [`#/projects/${pid}?tab=closure`, 'project-closure', /Closure checklist/],
    [`#/items/${pid}/${ids.item}`, 'item-workflow', /Branch B/], [`#/items/${pid}/${ids.item}?tab=records`, 'item-records', /Test cycles/], [`#/items/${pid}/${ids.item}?tab=history`, 'item-history'],
    ...['inventory', 'stockTransfers', 'procurement', 'purchaseRequests', 'quotations', 'purchaseOrders', 'proformaInvoices', 'payments', 'dispatches', 'materialReceipts', 'materialRequests', 'gvtReceipts', 'logistics', 'travelDesk', 'gatePasses', 'development', 'testing'].map((c) => [`#/m/${c}`, `list-${c}`]),
    [`#/r/purchaseRequests/${pid}/${ids.pr}`, 'record-pr'], [`#/r/purchaseOrders/${pid}/${ids.po}`, 'record-po', /Payment position/], [`#/r/stockTransfers/${pid}/${ids.trf}`, 'record-transfer'], [`#/r/procurement/${pid}/${ids.req}`, 'record-requirement'], [`#/r/gatePasses/${pid}/${ids.gp}`, 'record-gatepass'], [`#/r/materialRequests/${pid}/${ids.mr}`, 'record-mr'], [`#/r/dispatches/${pid}/${ids.dsp}`, 'record-dispatch'], [`#/r/testing/${pid}/${ids.tc}`, 'record-test'], [`#/r/quotations/${pid}/${ids.q}`, 'record-quotation'], [`#/r/inventory/_/${ids.stock}`, 'record-stock'], [`#/r/development/${pid}/${ids.item}`, 'record-development'],
    ['#/deadlines', 'deadlines', /Overdue/], ['#/departments', 'departments'], ['#/departments/sourcing', 'departments-sourcing'], ['#/notifications', 'notifications'], ['#/search?q=FC-H743', 'search', /FC-H743/], ['#/reports', 'reports', /Project-wise report/], ['#/account', 'account'], ['#/help', 'help'], ['#/people/u_pm', 'person'],
    ['#/admin/users', 'admin-users', /planning_head/], ['#/admin/roles', 'admin-roles', /Department User/], ['#/admin/departments', 'admin-departments', /Module ownership/], ['#/admin/settings', 'admin-settings'], ['#/admin/audit', 'admin-audit'], ['#/admin/backup', 'admin-backup'], ['#/nope', 'not-found']];
  const SHOTS = ['dashboard', 'project-overview', 'project-items', 'project-timeline', 'project-expenditure', 'project-closure', 'item-workflow', 'record-pr', 'record-po', 'deadlines', 'departments', 'reports', 'admin-users', 'admin-roles', 'list-purchaseOrders'];
  for (const [h, n, expect] of routes) await visit(h, n, { shot: SHOTS.includes(n), expect });
  const reportIds = await page.evaluate(async () => (await import('./js/services/reports.js')).REPORTS.map((r) => r.id));
  for (const r of reportIds) await visit(`#/reports/${r}`, `report-${r}`);
  // charts drawn?
  await visit('#/dashboard', 'dashboard');
  const canv = await page.$$eval('canvas', (c) => c.length); if (canv < 5) problems.push(`only ${canv} charts drawn on the dashboard`);
  // stage dialog opens from the workflow
  where = 'stage dialog';
  await visit(`#/items/${pid}/${ids.item}`, 'item-workflow');
  await page.click('.stop'); await page.waitForSelector('.modal', { timeout: 5000 });
  await page.screenshot({ path: join(shots, 'stage-dialog.png') });
  await page.click('.modal [data-close]');
  // a form: create a project through the UI
  where = 'create project';
  await visit('#/projects', 'projects'); await page.click('[data-act="create"]'); await page.waitForSelector('.modal #f-id');
  await page.type('#f-id', 'ui-test-1'); await page.type('#f-name', 'Created in the browser'); await page.$eval('#f-targetDate', (e) => { e.value = '2027-06-30'; });
  await page.click('.modal [data-submit]'); await sleep(900);
  if (!(await page.evaluate(() => location.hash)).includes('UI-TEST-1')) problems.push(`project creation through the form failed: ${await page.$eval('body', (b) => b.querySelector('.modal .err')?.innerText || 'no error shown')}`);

  // 4. phone layout
  await page.setViewport(PHONE);
  for (const [h, n] of [['#/dashboard', 'm-dashboard'], [`#/projects/${pid}?tab=items`, 'm-project-items'], [`#/items/${pid}/${ids.item}`, 'm-item'], [`#/r/purchaseOrders/${pid}/${ids.po}`, 'm-record-po'], ['#/deadlines', 'm-deadlines'], ['#/admin/roles', 'm-admin-roles'], [`#/projects/${pid}?tab=timeline`, 'm-timeline'], ['#/reports/po', 'm-report'], ['#/m/purchaseRequests', 'm-list']]) await visit(h, n, { shot: true });
  where = 'mobile menu'; await page.click('#menuToggle'); await sleep(300);
  if (!(await page.evaluate(() => document.body.classList.contains('nav-open')))) problems.push('mobile menu does not open');
  await page.screenshot({ path: join(shots, 'm-menu.png') }); await page.keyboard.press('Escape');
  where = 'mobile form'; await visit(`#/r/purchaseOrders/${pid}/${ids.po}`, 'm-record-po'); await page.click('[data-act="run"]'); await page.waitForSelector('.modal'); await sleep(200);
  const mo = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); if (mo > 2) problems.push(`form dialog overflows the phone screen by ${mo}px`);
  await page.screenshot({ path: join(shots, 'm-form.png') }); await page.click('.modal [data-close]');
  await signOut();
  await page.goto(`${base}/login.html`, { waitUntil: 'networkidle0' }); await page.waitForSelector('#loginForm'); await page.screenshot({ path: join(shots, 'm-login.png') });
  await page.setViewport(DESK);

  // 5. other roles: what they see, and that restricted screens stay closed
  // the menu has one entry per area; the modules of an area are tabs on its page
  for (const [user, mustHave, mustNot, extra, tabs = []] of [
    ['viewer', ['Projects', 'Dashboard', 'Procurement'], ['Administration'], [[`#/r/purchaseOrders/${pid}/${ids.po}`, /not found, or you do not have permission/], ['#/admin/users', /Only the Super Admin/], ['#/m/payments', /do not have permission/], [`#/projects/${pid}?tab=expenditure`, /restricted/]],
      [['#/m/procurement', ['Requirements'], ['Payments', 'Purchase orders', 'Quotations']]]],
    ['sourcing', ['Procurement'], ['Administration'], [['#/m/payments', /do not have permission/], [`#/r/purchaseRequests/${pid}/${ids.pr}`, /Purchase request/]],
      [['#/m/procurement', ['Quotations', 'Purchase orders'], ['Payments']]]],
    ['accounts', ['Procurement'], ['Administration'], [[`#/r/purchaseOrders/${pid}/${ids.po}`, /Payment position/]],
      [['#/m/procurement', ['Payments', 'Purchase orders'], []]]],
    ['pm', ['Projects', 'Reports'], ['Administration'], [[`#/projects/${pid}?tab=closure`, /Complete project/]]],
    ['stores', ['Material'], ['Administration'], [['#/departments', /Department work — Stores/]],
      [['#/m/inventory', ['Stock', 'Receipts (GRN)'], []], ['#/m/procurement', [], ['Payments']]]],
    ['tester', ['Engineering'], ['Administration'], [], [['#/m/testing', ['Testing'], ['Payments']]]],
  ]) {
    await signIn(user);
    const nav = await page.$eval('#nav', (n) => n.innerText);
    for (const m of mustHave) if (!nav.includes(m)) problems.push(`[${user}] menu should contain “${m}”`);
    for (const m of mustNot) if (nav.includes(m)) problems.push(`[${user}] menu must not contain “${m}”`);
    await visit('#/dashboard', `dashboard-${user}`, { shot: ['viewer', 'stores'].includes(user) });
    for (const [h, want, never] of tabs) {
      await visit(h, `${user}-tabs`);
      const bar = await page.$eval('.content', (c) => c.querySelector('.tabs')?.innerText || '');
      for (const t of want) if (!bar.includes(t)) problems.push(`[${user}] ${h} should have a “${t}” tab`);
      for (const t of never) if (bar.includes(t)) problems.push(`[${user}] ${h} must not have a “${t}” tab`);
    }
    for (const [h, expect] of extra) await visit(h, `${user}-check`, { expect });
    for (const h of ['#/projects', `#/projects/${pid}`, `#/items/${pid}/${ids.item}`, '#/deadlines', '#/departments', '#/notifications', '#/reports', '#/account']) await visit(h, `${user}-${h}`);
    await signOut();
  }
} catch (e) { problems.push(`[${where}] test crashed: ${e.message}`); }
await browser.close(); server.close();
if (problems.length) { console.log(`${problems.length} problem(s):`); problems.slice(0, 40).forEach((p) => console.log(' -', p)); process.exit(1); }
console.log('browser smoke test passed: every screen rendered for 7 roles on desktop and phone, no page errors, no overflow');
