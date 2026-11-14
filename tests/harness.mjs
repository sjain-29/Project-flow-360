/**
 * Test harness: runs the REAL application services against the demo backend
 * (in-memory storage) with the REAL security rules enforced on every read and
 * write. Each test acts as one of the demo accounts.
 */
import assert from 'node:assert/strict';
import { createLocalBackend } from '../js/services/backend-local.js';
import { _setBackend } from '../js/services/backend.js';
import { login, logout, session } from '../js/services/session.js';
import { store } from '../js/services/store.js';
import { DEMO_PASSWORD } from '../js/services/seed.js';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
globalThis.localStorage = mem();

export async function makeWorld({ observer } = {}) {
  if (store.isStarted()) store.stop();
  const backend = createLocalBackend({ storage: mem(), sessionStorage: mem(), observer });
  _setBackend(backend);
  await backend.init();
  let current = null;
  const w = {
    backend,
    /** Become a demo user (signs the previous one out). */
    async as(username, password = DEMO_PASSWORD) {
      if (current === username) return w;
      if (current) { store.stop(); await backend.auth.signOut(); }
      const res = await login(username, password, false);
      assert.ok(['ok', 'changePassword'].includes(res.state), `login as ${username} failed: ${res.state}`);
      await store.start({ onAccessRevoked: () => {} });
      current = username;
      return w;
    },
    async out() { if (current) { store.stop(); await logout(); current = null; } },
    /** Let live listeners deliver. */
    settle: () => new Promise((r) => setTimeout(r, 60)),
    raw: (path) => backend.adminGet(path),
    session,
  };
  return w;
}

/** Assert that a promise is rejected (optionally with a message pattern). Returns the error. */
export async function refuses(promise, pattern) {
  let err = null;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, 'expected a refusal, but the call succeeded');
  if (pattern) assert.match(err.message, pattern, `unexpected refusal message: ${err.message}`);
  return err;
}
export { assert, store };
