/**
 * PRODUCTION backend: Firebase Authentication + Firebase Realtime Database.
 *
 * Works on the free Spark plan — no Cloud Functions, no Storage. All protection
 * comes from Firebase Authentication plus the Security Rules in
 * firebase/database.rules.json, which Firebase evaluates on its servers for every
 * read and write. Nothing in this file (or any other browser code) is trusted.
 *
 * The Firebase SDK is loaded from Google's CDN only when Firebase is configured.
 */
import { firebaseConfig } from '../config/firebase-config.js';
import { APP } from '../config/app-config.js';
import { AppError } from '../utils/format.js';

const AUTH_MESSAGES = {
  'auth/invalid-credential': 'Incorrect username or password.',
  'auth/wrong-password': 'Incorrect username or password.',
  'auth/user-not-found': 'Incorrect username or password.',
  'auth/invalid-email': 'Incorrect username or password.',
  'auth/user-disabled': 'This account has been deactivated. Contact your administrator.',
  'auth/too-many-requests': 'Too many failed attempts. Sign-in is temporarily blocked for this account — wait a few minutes and try again.',
  'auth/network-request-failed': 'No connection to the server. Check your internet connection and try again.',
  'auth/email-already-in-use': 'That username is already in use.',
  'auth/weak-password': 'That password is too weak. Use at least 8 characters.',
  'auth/requires-recent-login': 'For security, sign out and sign in again before changing your password.',
  'auth/operation-not-allowed': 'Email/Password sign-in is not enabled in Firebase Authentication (see README, step 2).',
};

async function loadSdk() {
  if (globalThis.__PF360_FIREBASE_SDK__) return globalThis.__PF360_FIREBASE_SDK__; // test double
  const base = `https://www.gstatic.com/firebasejs/${APP.firebaseSdkVersion}`;
  const [app, auth, database] = await Promise.all([
    import(`${base}/firebase-app.js`), import(`${base}/firebase-auth.js`), import(`${base}/firebase-database.js`),
  ]);
  return { app, auth, database };
}

const wrapAuthError = (e) => { const x = new AppError(AUTH_MESSAGES[e?.code] || `Sign-in failed (${e?.code || e?.message || 'unknown error'}).`); x.code = e?.code; return x; };
const wrapDbError = (e, what, path) => {
  const msg = String(e?.code || e?.message || '').toLowerCase();
  if (msg.includes('permission')) {
    const x = new AppError('You do not have permission to do this, or the record was changed by someone else. Refresh and try again.', { code: 'PERMISSION_DENIED', what, path });
    x.code = 'PERMISSION_DENIED'; return x;
  }
  const x = new AppError(`Could not reach the database (${e?.message || e}). Check your connection and try again.`); x.code = 'NETWORK'; return x;
};

export function createFirebaseBackend() {
  let sdk, app, auth, db;
  let readyResolve; let user = null;
  const ready = new Promise((r) => { readyResolve = r; });
  const authSubs = new Set();
  const norm = (p) => String(p).replace(/^\/+/, '');

  const backend = {
    mode: 'firebase',
    serverTimestamp: () => sdk.database.serverTimestamp(),
    newId: () => sdk.database.push(sdk.database.ref(db, 'ids')).key,

    async init() {
      sdk = await loadSdk();
      app = sdk.app.initializeApp(firebaseConfig);
      auth = sdk.auth.getAuth(app);
      db = sdk.database.getDatabase(app);
      sdk.auth.onAuthStateChanged(auth, (u) => {
        user = u ? { uid: u.uid, email: u.email } : null;
        readyResolve(user);
        authSubs.forEach((cb) => cb(user));
      });
    },

    auth: {
      ready: () => ready,
      current: () => user,
      onChange(cb) { authSubs.add(cb); return () => authSubs.delete(cb); },
      async signIn(email, password, remember) {
        try {
          await sdk.auth.setPersistence(auth, remember ? sdk.auth.browserLocalPersistence : sdk.auth.browserSessionPersistence);
          const cred = await sdk.auth.signInWithEmailAndPassword(auth, email, password);
          user = { uid: cred.user.uid, email: cred.user.email };
          return user;
        } catch (e) { throw wrapAuthError(e); }
      },
      async signOut() { try { await sdk.auth.signOut(auth); } finally { user = null; } },
      async updatePassword(newPassword) {
        try { await sdk.auth.updatePassword(auth.currentUser, newPassword); } catch (e) { throw wrapAuthError(e); }
      },
      /**
       * Create a sign-in account for a new user WITHOUT signing the administrator out:
       * a second, temporary Firebase app instance does the sign-up and is then discarded.
       * The new account can do nothing until the Super Admin writes its /acl entry.
       */
      async adminCreateUser(email, password) {
        const app2 = sdk.app.initializeApp(firebaseConfig, `pf360-provision-${Date.now()}`);
        try {
          const auth2 = sdk.auth.initializeAuth(app2, { persistence: sdk.auth.inMemoryPersistence });
          const cred = await sdk.auth.createUserWithEmailAndPassword(auth2, email, password);
          const uid = cred.user.uid;
          await sdk.auth.signOut(auth2);
          return uid;
        } catch (e) { throw wrapAuthError(e); } finally { await sdk.app.deleteApp(app2).catch(() => {}); }
      },
    },

    async get(path) {
      try { return (await sdk.database.get(sdk.database.ref(db, norm(path)))).val(); } catch (e) { throw wrapDbError(e, 'read', path); }
    },

    subscribe(path, cb, onError) {
      return sdk.database.onValue(sdk.database.ref(db, norm(path)), (snap) => cb(snap.val()), (e) => onError?.(wrapDbError(e, 'listen', path)));
    },

    /** Atomic multi-path update: either every path is written or none is. */
    async update(updates) {
      const flat = {};
      for (const [p, v] of Object.entries(updates)) flat[norm(p)] = v;
      try { await sdk.database.update(sdk.database.ref(db), flat); } catch (e) { throw wrapDbError(e, 'write'); }
    },
  };
  return backend;
}
