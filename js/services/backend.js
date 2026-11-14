/**
 * Chooses the backend: Firebase when js/config/firebase-config.js is filled in,
 * otherwise the clearly labelled localStorage DEMO MODE.
 */
import { isFirebaseConfigured } from '../config/firebase-config.js';
import { createLocalBackend } from './backend-local.js';
import { createFirebaseBackend } from './backend-firebase.js';

let backend = null;

export async function initBackend(custom) {
  if (backend) return backend;
  backend = custom || (isFirebaseConfigured() ? createFirebaseBackend() : createLocalBackend());
  await backend.init();
  return backend;
}
export const be = () => { if (!backend) throw new Error('Backend not initialised'); return backend; };
export const isDemo = () => be().mode === 'demo';
/** Test helper. */
export const _setBackend = (b) => { backend = b; };
