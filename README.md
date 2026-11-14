# ProjectFlow 360 — Project Material & Development Tracker

A multi-user web application for tracking engineering / drone development projects:
every item, every procurement step, every stock movement, every department's task,
development and testing — from the first requirement to project closure.

It is a static website (HTML, CSS, JavaScript — no build step) hosted on **GitHub Pages**,
with **Firebase Authentication** for sign-in and **Firebase Realtime Database** for data.
It runs on Firebase's **free Spark plan**: no Cloud Functions and no Firebase Storage are needed.

> **Demo mode.** Until you fill in `js/config/firebase-config.js`, the app runs in a clearly
> labelled demo mode: data is kept only in your browser, and 14 demo accounts (one per role and
> department, password `demo1234`) let you try every screen. Demo mode switches off automatically
> once Firebase is configured.

---

## Contents

1. [Try it locally (demo mode)](#1-try-it-locally-demo-mode)
2. [Connect Firebase — step by step](#2-connect-firebase--step-by-step)
3. [Create the first administrator (one-time bootstrap)](#3-create-the-first-administrator-one-time-bootstrap)
4. [Publish on GitHub Pages](#4-publish-on-github-pages)
5. [Daily administration](#5-daily-administration)
6. [How security works without Cloud Functions](#6-how-security-works-without-cloud-functions)
7. [Backup and restore](#7-backup-and-restore)
8. [Running the tests](#8-running-the-tests)
9. [Project structure](#9-project-structure)
10. [Limits and known constraints](#10-limits-and-known-constraints)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Try it locally (demo mode)

The pages are ES modules, so they must be served over `http://` (opening `index.html` by
double-click will not work).

```bash
cd projectflow360
python3 -m http.server 8080        # or: npx serve .
```

Open <http://localhost:8080>. Sign in as `admin` / `demo1234`, then press
**Load the sample project** on the dashboard. The sample is created by running the real
workflow with the demo accounts (stock check, transfers, PRs, approvals, quotations, PO,
payment, receipts, a failed and a passed test, a gate pass…), so it obeys every rule.

To see what another role sees, sign out and sign in as e.g. `sourcing`, `accounts`, `stores`,
`planning_head`, `pm`, `tester` or `viewer` (all with `demo1234`).
**Administration → Backup → Reset all demo data** starts the demo again.

---

## 2. Connect Firebase — step by step

You only need a Google account. Everything below is in the Firebase console:
<https://console.firebase.google.com>.

> **Your project is already partly connected.** `js/config/firebase-config.js` now holds your
> database address and project ID:
>
> | Value | Filled in |
> |---|---|
> | `databaseURL` | `https://projectflow360-20945-default-rtdb.europe-west1.firebasedatabase.app` |
> | `projectId` | `projectflow360-20945` |
> | `authDomain` | `projectflow360-20945.firebaseapp.com` |
> | `apiKey` | **still empty** — copy it in Step 5 |
> | `appId` | **still empty** — copy it in Step 5 |
>
> Firebase sign-in cannot work without `apiKey` and `appId`, and they cannot be worked out from
> the database address. Until you add them the app stays in demo mode, and the sign-in page says
> which values are missing. Steps 1 and 3 are already done for you (the project and the database
> in `europe-west1` exist), so for your project the remaining steps are **2, 4, 5, 6** and then
> section 3.
>
> **Do Step 4 today.** If the database was created in *test mode*, it is open to anyone with the
> address until you publish the rules.

### Step 1 — Create the project
1. **Add project** → give it a name (e.g. `projectflow360`) → Google Analytics is not needed → **Create**.
2. Stay on the free **Spark** plan.

### Step 2 — Turn on username/password sign-in
1. **Build → Authentication → Get started**.
2. **Sign-in method** tab → **Email/Password** → enable the first switch only → **Save**.

> People sign in with a *username*. Internally the app turns `suyash` into
> `suyash@pf360.example.com` for Firebase. No e-mail is ever sent to that address.

### Step 3 — Create the Realtime Database
1. **Build → Realtime Database → Create Database**.
2. Choose a location close to your users (for India: `asia-southeast1`, Singapore).
3. Choose **Start in locked mode** → **Enable**.

### Step 4 — Publish the security rules (**required**)
The rules are the app's security. Without them the database is either locked (nothing works)
or open (anyone can read everything).

1. Realtime Database → **Rules** tab.
2. Delete everything in the editor.
3. Open `firebase/database.rules.json` from this project, copy **all** of it, paste it into the editor.
4. **Publish**.

(Alternative for developers: `npm install -g firebase-tools`, `firebase login`,
`firebase use --add`, `firebase deploy --only database` — `firebase.json` is included.)

### Step 5 — Register the web app and copy its configuration
1. Project settings (gear icon) → **General** → **Your apps** → the **`</>`** (Web) icon.
2. Nickname: `ProjectFlow 360`. Do **not** tick “Firebase Hosting”. **Register app**.
3. Firebase shows a `firebaseConfig = { … }` block. Open `js/config/firebase-config.js` and copy
   these five values into it (for your project only `apiKey` and `appId` are still empty; check
   that the other three match what Firebase shows):

```js
export const firebaseConfig = {
  apiKey: 'AIza…',
  authDomain: 'your-project.firebaseapp.com',
  databaseURL: 'https://your-project-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'your-project',
  appId: '1:…:web:…',
};
```

If `databaseURL` is missing from the block, copy it from the top of the Realtime Database **Data** tab.

These values are **not secrets** — they only identify your project; the security rules protect
the data. **Never** put a service-account key or any password into this repository.

### Step 6 — Allow your website's address
Authentication → **Settings** → **Authorized domains** → **Add domain** → add
`YOUR-GITHUB-USERNAME.github.io` (and `localhost` is already there for testing).

---

## 3. Create the first administrator (one-time bootstrap)

The first Super Admin is created in a way nobody outside the Firebase console can imitate.
Nothing about this account is written in the code.

**Account to create (from your requirements):** username `suyash`, display name `Suyash`,
department Project Management, role Super Admin. Use the initial password from your
requirements document — you will be forced to replace it at the first sign-in.

1. **Create the sign-in account.** Authentication → **Users** → **Add user**:
   - Email: `suyash@pf360.example.com`
   - Password: the initial bootstrap password
   - **Add user**, then copy the **User UID** shown in the list (a long code).
2. **Name it as the bootstrap account.** Realtime Database → **Data** tab → hover the root →
   **+** → name `system` → **+** inside it → name `bootstrapUid`, value = the UID you copied → **Add**.
3. **Initialise.** Open the app, sign in as `suyash`. The **Set up ProjectFlow 360** screen
   appears: confirm the display name (`Suyash`), department (Project Management) and organisation
   name → **Initialise the system**. This writes the default roles, departments and settings and
   makes the account Super Admin.
4. **Change the password** on the screen that follows (compulsory).

After step 3, `system/initialized` exists and the security rules close the bootstrap route
permanently — even if someone edits `bootstrapUid` later. You may delete `bootstrapUid` from the
console afterwards; it is no longer used.

> If you see **“This system is not set up yet”** instead, the UID in `system/bootstrapUid` does not
> match. The screen shows the correct UID with a Copy button.

---

## 4. Publish on GitHub Pages

1. Create a repository on GitHub (e.g. `projectflow360`). Public or private (Pages on private
   repositories needs a paid GitHub plan).
2. Upload **the contents** of this folder (so `index.html` is at the top level of the repository).
   Easiest: on the repository page **Add file → Upload files**, drag everything in, **Commit**.
   With git:
   ```bash
   git init && git add . && git commit -m "ProjectFlow 360"
   git branch -M main
   git remote add origin https://github.com/YOUR-USER/projectflow360.git
   git push -u origin main
   ```
3. Repository **Settings → Pages** → Source: **Deploy from a branch** → Branch **main**, folder
   **/ (root)** → **Save**.
4. After a minute the site is at `https://YOUR-USER.github.io/projectflow360/`.
   (Make sure step 2.6 lists `YOUR-USER.github.io`.)

To update the site later, edit or upload files and commit; Pages republishes automatically.
The empty `.nojekyll` file must stay — it tells GitHub to serve the files as they are.

---

## 5. Daily administration

Everything below is in **Administration** (Super Admin only).

| Task | Where |
|---|---|
| Create a user | Users → **New user** (username, name, role, departments, project access, temporary password). Give the person the username and temporary password; they must change it at first sign-in. |
| Deactivate / reactivate | Users → **Deactivate**. Access ends at once, even in open sessions. History is kept. |
| Forgotten password | The user clicks **Forgot password?** — the request shows as a red label in Users. Click **Reset password**, give them the new temporary password. |
| Individual permissions | Users → **Permissions**: allow or deny single actions per module, overriding the role. |
| Roles | Roles and permissions: tick View / Create / Edit / Delete / Comment / Update status / Upload / Approve / Export per module. **New role** creates custom roles. |
| Departments | Departments: add, rename, deactivate. **Module ownership** decides which departments a department-restricted role can work in. |
| Session length, deadline windows, health rules, progress weights, units, currency | Settings |
| Verify the rules are live | Settings → **Check security rules** (tries a forbidden write; it must be refused). |
| Audit log | Audit log (filter, export CSV). |

**Project access** per user: *All projects*, *Projects of their departments*, or *Selected projects*
(plus any project they manage). A person cannot open other projects by typing an address —
the database refuses the read.

---

## 6. How security works without Cloud Functions

Your Firebase project uses the free plan, so there is no server code. The **Security Rules**
(evaluated by Firebase's servers on every read and write) are the trusted backend:

- **Effective permissions** of each active account live at `/acl/{uid}`, writable only by a Super
  Admin. Deactivating a user deletes that entry — every further read or write fails immediately.
- **Every record write** must carry the writer's user ID and the server time, increase the record
  version by exactly one (so two people can never overwrite each other silently) and come with an
  **append-only activity-log entry** in the same atomic write. Log entries can never be changed or
  deleted, not even by the Super Admin.
- **Business rules are enforced by the rules, not just the screens**, for example: no quotation
  before the PR is approved; only approvers approve; a stock transfer cannot exist without its
  linked replenishment requirement; cancelling it sends the requirement to review instead of
  removing it; payments can never exceed PO value + authorised adjustments; receipts must satisfy
  accepted + rejected = received; quantities cannot go negative; a failed test cycle is frozen;
  a project is completed or cancelled only with a closure record by an authorised person.
- Each record's fields are grouped by the permission needed to change them (core, status,
  approval, payments, receipts…), and each group has its own write rule.

What is honestly different from a Cloud-Functions design (and why it is still safe):

| Topic | How it is handled |
|---|---|
| Creating users | The admin's browser creates the sign-in account through a temporary second Firebase connection. Anyone could create a *sign-in* account through Firebase's public API, but it gets **no access** until a Super Admin writes its `/acl` entry. |
| Password reset | No e-mail exists, and changing another person's password needs server code. The admin therefore issues a **new sign-in** for the same user (same history) and the old one stops working. |
| Audit entries | Written by the user's browser, but the rules force the user ID and server time and refuse any record change without its log entry. |
| Scheduled reminders | Overdue and RGP reminders are created when the responsible person (or their manager) opens the app, not by a timer on a server. |
| Attachments | Files up to 500 KB (configurable, max 750 KB) are stored inside the database. For larger files attach a link to your shared drive (OneDrive, Google Drive, SharePoint). |
| Restore | The app may not overwrite history; a validated backup is imported by the owner in the Firebase console (section 7). |

If you later move to the Blaze plan, these points can be moved into Cloud Functions without
changing the data structure.

---

## 7. Backup and restore

- **Backup:** Administration → Backup → **Download full backup** (one JSON file), or
  export single areas (projects, BOM, procurement, payments, material movement, audit logs).
  Do this regularly and store the file safely — it contains financial data.
- **Restore (Firebase mode):**
  1. In the app, **Choose a backup file to check** — it is validated and summarised; nothing is written.
  2. Download a fresh backup of the current data first.
  3. Firebase console → Realtime Database → **Data** → ⋮ menu → **Import JSON** → choose the
     backup file **after** removing its outer wrapper: open the file and keep only the object inside
     `"data": { … }` (save it as e.g. `restore.json`). Import replaces everything.
  4. Users sign in again.
- **Restore (demo mode):** done directly in the app after validation and a typed confirmation.

---

## 8. Running the tests

Requires Node.js 20 or newer.

```bash
npm install          # test tools only: rules simulator and headless-browser driver
npm test             # 46 workflow, permission and security-rule tests
CHROME=/path/to/chrome node tests/browser-smoke.mjs   # optional: every screen, 7 roles, desktop + phone
```

The tests drive the real application code against the demo backend, which enforces the
**same rules file** that Firebase uses. Every forbidden action is tried twice — through the app
and as a hand-crafted direct database request. A separate test replays more than a thousand
recorded reads and writes through **targaryen**, an independent Firebase-rules simulator, and
checks that both agree on every allow/deny decision.

If you edit `js/config/entities.js`, regenerate the rules with `npm run rules` and publish
`firebase/database.rules.json` again (step 2.4).

---

## 9. Project structure

```
index.html, login.html, dashboard.html   pages (entry, sign-in, workspace)
css/                                     app.css (design system), login.css
assets/                                  logo, IBM Plex fonts, Chart.js (vendored, no CDN needed)
js/app.js                                shell, navigation, router, session expiry
js/login.js                              sign-in, password change, bootstrap set-up
js/actions.js                            which actions a user may take on a record, and their forms
js/config/
  firebase-config.js                     ← the only file you edit to go live
  app-config.js                          modules, permissions, roles, departments, stages, settings
  entities.js                            data dictionary: every record type and field
  rules.generated.js                     security rules used by demo mode (generated)
js/services/                             business logic, one file per area
  inventory.js  procurement.js  material.js  devtest.js  closure.js  projects.js  stages.js
  quantities.js (11-quantity ledger)  insights.js (deadlines, progress, health, expenditure, KPIs)
  reports.js (25 reports, search)  admin.js  records.js (comments, documents, audit)  backup.js
  session.js  store.js (live data the user may read)  tx.js (atomic writes + audit)  notify.js
  backend-firebase.js  backend-local.js (demo)  rules-engine.js  permissions.js  seed.js
js/modules/                              screens: dashboard, projects, item, records, work, reports, admin
js/components/                           ui toolkit, charts, Gantt, workflow tracks, comments/documents
firebase/build-rules.mjs                 generates the rules from entities.js
firebase/database.rules.json             ← publish this in the Firebase console
docs/ARCHITECTURE.md                     architecture, data model, permission matrix, workflows
docs/TESTING.md                          test checklist and results
tests/                                   automated tests
```

---

## 10. Limits and known constraints

- **Spark plan quotas:** 1 GB stored, 10 GB downloaded per month, 100 simultaneous connections.
  Comfortable for an organisation of several dozen users and hundreds of projects; keep large
  files on a shared drive.
- The app loads all records of the projects a user may see into the browser. That is fast up to
  roughly tens of thousands of records; beyond that, archive closed projects or move to a
  server-side design.
- Firebase mode was built against the Firebase JS SDK and its rules were verified with an
  independent simulator, but it could not be run against a live Firebase project from the build
  environment. After setting up Firebase, do the 10-minute first-run check in `docs/TESTING.md`.

---

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| “Email/Password sign-in is not enabled” | Step 2.2. |
| Sign-in works, then “You do not have permission…” everywhere | The rules are not published (step 2.4) or the account was never initialised / created by the admin. |
| “This system is not set up yet” | `system/bootstrapUid` does not match the UID shown on that screen (step 3.2). |
| Page stays on “Connecting…” | Check the browser console. Wrong `databaseURL`, or the Firebase SDK could not load (corporate firewall blocking `www.gstatic.com`). The SDK version is set in `js/config/app-config.js` (`firebaseSdkVersion`). |
| `auth/unauthorized-domain` | Add your GitHub Pages domain (step 2.6). |
| Changes to `entities.js` are refused | Run `npm run rules` and publish the new rules file. |
