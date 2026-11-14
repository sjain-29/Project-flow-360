/**
 * FIREBASE CONNECTION — the only file you need to edit to go live.
 *
 * 1. Firebase console → Project settings (gear icon) → "Your apps" → Web app → "Config".
 * 2. Copy the values into the object below and save the file.
 * 3. Commit and push. The app switches from DEMO MODE to your Firebase project.
 *
 * These values are not secrets: they only identify your project. Your data is
 * protected by Firebase Authentication and the Security Rules in
 * firebase/database.rules.json — never by hiding this file.
 * NEVER put a service-account key or any password in this repository.
 */
export const firebaseConfig = {
  apiKey: 'AIzaSyCjI4-lqbSQYrib6Sb-IpboUwyOiKOuyn4',      // ← still needed: Project settings → General → Your apps → Web app → Config
  authDomain: 'projectflow360-20945.firebaseapp.com',
  databaseURL: 'https://projectflow360-20945-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'projectflow360-20945',
  appId: '1:217593527887:web:92880a8a9bf1c94877f43a',       // ← still needed: same place as apiKey (looks like 1:123…:web:abc…)
};

/**
 * People sign in with a username. Firebase Authentication needs an e-mail address,
 * so the app builds one internally: <username>@<USERNAME_DOMAIN>. No e-mail is ever
 * sent to it. Keep the default unless you have a reason to change it — and never
 * change it after users have been created.
 */
export const USERNAME_DOMAIN = 'pf360.example.com';

const REQUIRED = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'appId'];
/** Names of the values that are still empty (all of them = not started). */
export const missingFirebaseValues = () => REQUIRED.filter((k) => !String(firebaseConfig[k] || '').trim());
export const isFirebaseConfigured = () => missingFirebaseValues().length === 0;
