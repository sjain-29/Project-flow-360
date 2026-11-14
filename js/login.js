/**
 * Sign-in page: login, forced password change, "forgot password", the one-time
 * system initialisation by the bootstrap administrator, and — only when
 * Firebase is not configured — the clearly labelled demo accounts.
 */
import { initBackend, isDemo, be } from './services/backend.js';
import { missingFirebaseValues } from './config/firebase-config.js';
import { login, establish, changePassword, requestPasswordReset, initialiseSystem, logout, session } from './services/session.js';
import { DEMO_USERS, DEMO_PASSWORD } from './services/seed.js';
import { DEFAULT_DEPARTMENTS, defaultRoles, PASSWORD_MIN } from './config/app-config.js';
import { esc, icon } from './components/ui.js';
import { AppError } from './utils/format.js';

const card = document.getElementById('card');
const params = new URLSearchParams(location.search);
const REASONS = {
  expired: 'Your session has ended because of inactivity or its maximum length. Please sign in again.',
  deactivated: 'This account has been deactivated or its sign-in was re-issued. Contact your administrator.',
  signedout: 'You have signed out.',
  reset: 'Sample data was loaded. Sign in with any demo account to explore it.',
  changed: 'Your password was changed. Sign in with the new password.',
};
const goApp = () => location.replace('dashboard.html');
const errBox = (msg, kind = 'err') => (msg ? `<div class="${kind}" role="alert">${esc(msg)}</div>` : '');

function busy(btn, on) { btn.classList.toggle('busy', on); btn.disabled = on; }
async function run(btn, fn) {
  const box = card.querySelector('[data-msg]');
  box.innerHTML = '';
  busy(btn, true);
  try { await fn(); } catch (e) {
    if (!(e instanceof AppError)) console.error(e);
    box.innerHTML = errBox(e instanceof AppError ? e.message : `Something went wrong: ${e?.message || e}`);
  } finally { busy(btn, false); }
}

/* ------------------------------------------------------------------ screens */
function showLogin(message, kind) {
  const roles = defaultRoles();
  const dept = Object.fromEntries(DEFAULT_DEPARTMENTS);
  const missing = missingFirebaseValues();
  const partial = isDemo() && missing.length && missing.length < 5
    ? `<div class="note warn">Firebase is partly set up. Add <b>${missing.map(esc).join('</b> and <b>')}</b> to <code>js/config/firebase-config.js</code> to switch from demo mode to your live database (see README, step 5).</div>` : '';
  const demo = isDemo() ? `
    <div class="demo-box">${partial}
      <h3>${icon('alert')} Demo mode — not connected to Firebase</h3>
      <p>Everything you enter is stored only in this browser. These demo-only accounts all use the password <b>${esc(DEMO_PASSWORD)}</b>. Pick one to fill in the form.</p>
      <div class="demo-users">${DEMO_USERS.map(([u, , r, d]) => `<button type="button" data-demo="${esc(u)}"><b>${esc(u)}</b><span>${esc(roles[r].name)} · ${esc(dept[d])}</span></button>`).join('')}</div>
    </div>` : '';
  card.innerHTML = `
    <h2>Sign in</h2>
    <div class="sub">Use the username and password given to you by your administrator.</div>
    <div data-msg>${errBox(message, kind)}</div>
    <form id="loginForm" novalidate>
      <div class="field"><label for="u">Username</label><input id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
      <div class="field"><label for="p">Password</label>
        <div class="pw"><input id="p" name="password" type="password" autocomplete="current-password" required>
        <button type="button" class="iconbtn" id="togglePw" aria-label="Show password" aria-pressed="false">${icon('eye')}</button></div></div>
      <div class="row">
        <label class="check"><input type="checkbox" id="remember"><span>Remember me on this device</span></label>
        <button type="button" class="linkbtn" id="forgot">Forgot password?</button>
      </div>
      <button type="submit" class="btn primary" id="go">Sign in</button>
    </form>${demo}`;
  const form = card.querySelector('#loginForm');
  const pw = card.querySelector('#p');
  card.querySelector('#togglePw').addEventListener('click', (e) => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    e.currentTarget.setAttribute('aria-pressed', String(show));
    e.currentTarget.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    e.currentTarget.innerHTML = icon(show ? 'eyeOff' : 'eye');
  });
  card.querySelectorAll('[data-demo]').forEach((b) => b.addEventListener('click', () => { form.username.value = b.dataset.demo; pw.value = DEMO_PASSWORD; card.querySelector('#go').focus(); }));
  card.querySelector('#forgot').addEventListener('click', async () => {
    const box = card.querySelector('[data-msg]');
    try {
      await requestPasswordReset(form.username.value);
      box.innerHTML = errBox('If that username exists, your administrator has been asked to reset the password. They will give you a temporary password, which you must change at your next sign-in.', 'note');
    } catch (e) { box.innerHTML = errBox(e.message); }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run(card.querySelector('#go'), async () => {
      const res = await login(form.username.value, pw.value, card.querySelector('#remember').checked);
      route(res);
    });
  });
  form.username.focus();
}

function showChange() {
  card.innerHTML = `
    <h2>Choose a new password</h2>
    <div class="sub">Hello ${esc(session.user?.displayName || '')}. You are using a temporary password, so it has to be changed before you can continue.</div>
    <div data-msg></div>
    <form id="cp" novalidate>
      <div class="field"><label for="n1">New password</label><input id="n1" type="password" autocomplete="new-password" required>
        <div class="hint">At least ${PASSWORD_MIN} characters, with a letter and a number. It must not contain your username.</div></div>
      <div class="field"><label for="n2">Repeat the new password</label><input id="n2" type="password" autocomplete="new-password" required></div>
      <button type="submit" class="btn primary" id="go">Save password and continue</button>
      <button type="button" class="linkbtn" id="out">Sign out instead</button>
    </form>`;
  card.querySelector('#out').addEventListener('click', async () => { await logout(); showLogin(REASONS.signedout, 'note'); });
  card.querySelector('#cp').addEventListener('submit', (e) => {
    e.preventDefault();
    run(card.querySelector('#go'), async () => {
      const a = card.querySelector('#n1').value; const b = card.querySelector('#n2').value;
      if (a !== b) throw new AppError('The two passwords are not the same.');
      await changePassword(a);
      goApp();
    });
  });
  card.querySelector('#n1').focus();
}

/** Signed in, but the system has never been initialised and this is not the named bootstrap account. */
function showUninitialised(res) {
  card.innerHTML = `
    <h2>This system is not set up yet</h2>
    <div class="sub">You are signed in as <b>${esc(res.username)}</b>, but no administrator exists yet.</div>
    <div data-msg></div>
    <p>If you are the owner of the Firebase project, name this account as the first administrator:</p>
    <ol class="steps">
      <li>Copy this account's UID:<div class="uidbox" id="uid">${esc(res.uid)}</div></li>
      <li>Open the Firebase console → <b>Realtime Database</b> → <b>Data</b>.</li>
      <li>Add a child named <b>system</b>, and inside it a child named <b>bootstrapUid</b> whose value is the UID above.</li>
      <li>Come back and press the button below.</li>
    </ol>
    <p class="muted small">Only someone with access to the Firebase console can do this, which is what makes the first administrator trustworthy. If you are not the owner, ask your administrator for an account.</p>
    <div class="row"><button type="button" class="btn primary" id="again" style="width:auto">I have done this — continue</button>
    <button type="button" class="btn" id="copy">${icon('copy')}Copy UID</button>
    <button type="button" class="linkbtn" id="out">Sign out</button></div>`;
  card.querySelector('#copy').addEventListener('click', () => navigator.clipboard?.writeText(res.uid));
  card.querySelector('#out').addEventListener('click', async () => { await be().auth.signOut(); showLogin(); });
  card.querySelector('#again').addEventListener('click', (e) => run(e.currentTarget, async () => {
    const r = await establish();
    if (r.state === 'uninitialised') throw new AppError('The value at system/bootstrapUid does not match this account yet. Check that the UID was pasted exactly, without quotes or spaces.');
    route(r);
  }));
}

function showBootstrap(res) {
  card.innerHTML = `
    <h2>Set up ProjectFlow 360</h2>
    <div class="sub">You are the bootstrap administrator (<b>${esc(res.username)}</b>). This runs once: it creates the default roles, departments and settings, and makes you the Super Admin.</div>
    <div data-msg></div>
    <form id="bs" novalidate>
      <div class="field"><label for="org">Organisation name</label><input id="org" maxlength="100" placeholder="Shown in the header and on reports"></div>
      <div class="field"><label for="dn">Your display name</label><input id="dn" maxlength="100" required value="${esc(res.username.charAt(0).toUpperCase() + res.username.slice(1))}"></div>
      <div class="field"><label for="dp">Your department</label><select id="dp">${DEFAULT_DEPARTMENTS.map(([id, n]) => `<option value="${id}"${id === 'project_management' ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
      <div class="note">After this step you will be asked to replace the initial password. The setup route is then closed permanently.</div>
      <button type="submit" class="btn primary" id="go">Initialise the system</button>
    </form>`;
  card.querySelector('#bs').addEventListener('submit', (e) => {
    e.preventDefault();
    run(card.querySelector('#go'), async () => route(await initialiseSystem({ displayName: card.querySelector('#dn').value, departmentId: card.querySelector('#dp').value, orgName: card.querySelector('#org').value })));
  });
}

function route(res) {
  if (res.state === 'ok') return goApp();
  if (res.state === 'changePassword') return showChange();
  if (res.state === 'bootstrap') return showBootstrap(res);
  if (res.state === 'uninitialised') return showUninitialised(res);
  if (res.state === 'deactivated') return showLogin(REASONS.deactivated);
  return showLogin(REASONS[params.get('reason')], params.get('reason') === 'deactivated' || params.get('reason') === 'expired' ? 'err' : 'note');
}

/* ------------------------------------------------------------------ start */
try {
  await initBackend();
  const res = await establish();
  // a reason in the address (expired / deactivated …) always shows the form, never an automatic redirect
  if (res.state === 'ok' && params.get('reason')) { await logout(params.get('reason')); route({ state: 'none' }); } else route(res);
} catch (e) {
  console.error(e);
  card.innerHTML = `<h2>Cannot connect</h2>${errBox(`The application could not start: ${e?.message || e}`)}<p class="muted">Check your internet connection and the values in <code>js/config/firebase-config.js</code>, then reload the page.</p><button class="btn" onclick="location.reload()">Reload</button>`;
}
