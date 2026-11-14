# Testing checklist

A feature is only marked complete here when an automated test exercises the real workflow — not
because its screen exists. Tests run the real services against the demo backend, which enforces
the **same rules file** Firebase uses; every forbidden action is also attempted as a hand-made
direct database request that bypasses the app.

Run: `npm install` then `npm test`. Browser test: `CHROME=/path/to/chrome node tests/browser-smoke.mjs`.

## Results of the last run (46 / 46 passed)

- [x] default roles: department users are limited to their department, approvals to heads and PMs, viewers read-only
- [x] Sourcing can run quotations and POs but cannot approve PRs or touch payments — not even with direct requests
- [x] Accounts can record payments and view procurement but cannot change quotations or receipt quantities
- [x] Viewer is read-only, sees no financial data, and only the projects assigned to them
- [x] project scopes: selected projects, project manager, department-assigned, all
- [x] nobody can promote themselves, change roles, or write another user's permissions
- [x] audit trail: every record write needs its log entry; logs are append-only for everyone
- [x] concurrent / duplicate writes: stale versions, reused IDs and counters going backwards are refused
- [x] deactivation ends access immediately, even for a session that is already open
- [x] user lifecycle: create, forced password change, deactivate / reactivate through the app, admin password reset
- [x] unauthenticated visitors can read nothing, and only nudge the failed-login counter by one
- [x] first-run bootstrap: only the UID named by the project owner can initialise, only once
- [x] Super Admin can add roles and departments and remap modules; permissions follow at once
- [x] notifications only reach people who may open the record
- [x] comments: need permission, carry author and time, are private to the module, own-only edit/delete
- [x] attachments: type and size checks, module-scoped visibility, links
- [x] session expiry: idle and maximum length
- [x] rules file: every expression parses, size is within Firebase limits
- [x] positive controls: the hand-crafted writes used in the attack tests succeed for an authorised user
- [x] the app's rules engine and the independent simulator agree on every operation of a full workflow # SKIP targaryen is not installed (npm install)
- [x] inventory: fully available → transfer for all + replenishment for all, no project procurement
- [x] inventory: partially available → transfer 6, procure 4 for project, replenish 6
- [x] inventory: not available → procure 10 for project, no transfer, no replenishment
- [x] inventory: negative quantities and over-reservation are refused; stock never goes negative
- [x] inventory: partial stock transfer, receipt with rejection, and linked quantities
- [x] inventory: cancelled transfer keeps the replenishment requirement and sends it to authorised review
- [x] inventory: replenishment quantity adjustment after a transfer change
- [x] quantities: transferred and procured units are never double-counted; replenishment never counts for the project
- [x] procurement: PR creation, rejection reopens the requirement, approval, no quotation before approval
- [x] procurement: the requester cannot approve their own PR; changes requested → resubmit
- [x] procurement: multiple quotations, comparison, vendor selection, PO limits, PI
- [x] procurement: partial payments, outstanding, overpayment blocked unless an authorised adjustment exists
- [x] procurement + material: multiple dispatches, partial SPIF receipts, rejected quantity, multiple GRNs
- [x] replenishment: full Branch B goes back to the source stock and never fulfils the project
- [x] material: MR, partial movement to GVT, partial GVT receipt with discrepancy
- [x] material: logistics and travel desk run in parallel and never complete each other
- [x] gate passes: RGP approval, issue, overdue tracking, partial returns, authorised closure; NRGP history
- [x] development and testing: completion, pass, failure reopens development, retest, final approval; old cycles are frozen
- [x] development can request additional material; it needs approval and then becomes project procurement
- [x] stages: dates never complete a stage; only authorised people change status; overdue is calculated
- [x] progress and health are derived from configurable rules and explain themselves
- [x] closure: checklist blocks completion, override needs a reason, history is kept, reopen works
- [x] closure: cancellation captures settlement details and deletes nothing
- [x] a clean project completes without override when every check is satisfied
- [x] projects and BOM: unique IDs, validation, duplicate warning, CSV import check, bulk update, clone, archive
- [x] reports and search are built only from data the user may see

Rules cross-check: 1,160 recorded operations of a full multi-user workflow plus attacks
(151 writes, 1,009 reads, 90 denials) replayed through the independent simulator *targaryen* —
no disagreement with the app's rules engine.

Browser smoke test: passed — every screen and all 25 reports render for Super Admin, Project
Manager, Department Heads, Department Users (Sourcing, Accounts, Stores, Testing) and Viewer;
desktop (1366 px) and phone (390 px); no page errors, no horizontal overflow; menus and area tabs show only
permitted modules; restricted pages refuse; project creation through the form works.

## Coverage against the requirements (section 34)

| Area | Scenario | Test |
|---|---|---|
| Inventory | fully / partially / not available | inventory: fully…, partially…, not available… |
| | stock transfer + linked replenishment | all three above + “replenishment: full Branch B…” |
| | partial transfer, cancelled transfer, replenishment adjustment, no duplicate procurement | inventory: partial…, cancelled…, replenishment quantity adjustment…, quantities… |
| Procurement | PR creation, rejection, approval, no quotation before approval | procurement: PR creation, rejection… |
| | multiple quotations, vendor selection, PO, PI | procurement: multiple quotations… |
| | partial payments, outstanding, overpayment | procurement: partial payments… |
| | multiple dispatches | procurement + material: multiple dispatches… |
| Material | partial SPIF receipt, rejected quantity, multiple GRNs | procurement + material… |
| | MR, partial GVT receipt, logistics | material: MR…, material: logistics and travel desk… |
| | RGP overdue, RGP closure | gate passes… |
| Development and testing | completion, pass, failure, reopening, retest, approval | development and testing… |
| Permissions | Super Admin, Project Manager, Department Head, Department User, Viewer — through the app and by direct requests | all tests in permissions.test.mjs |
| Mobile | every major screen, forms, menu | browser-smoke.mjs |

## First-run check after connecting Firebase (about 10 minutes)

Firebase mode was built against the Firebase SDK and the rules were verified with two evaluators,
but it could not be run against a live Firebase project during the build. Please do this once:

1. Administration → Settings → **Check security rules** → must say the rules are active.
2. Create a test user with role *Department User*, department *Sourcing*, scope *Selected
   projects* (no projects). Sign in as that user in a private window: the project list is empty.
3. As Super Admin create a project and one item; give the test user that project.
4. As the test user: the project appears; **Add vendor quotation** is not offered on a PR that is
   pending approval; Procurement has no Payments tab.
5. As Super Admin: verify availability (e.g. 2 of 5 available) → a transfer and two procurement
   requirements appear on the item; the workflow shows Branch A and Branch B.
6. Deactivate the test user while they are signed in — their window returns to the sign-in page
   within seconds.
7. Administration → Audit log shows all of the above.

If any step behaves differently, note the message shown and the browser console output.
