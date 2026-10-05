# Changelog

## 2.1.0 — PostgreSQL on Google Cloud SQL

The data layer moved from Cloud Firestore to PostgreSQL. Every fix from 2.0.0 is
retained; what changed is where the data lives and how much of the correctness is
enforced by the database rather than by application code.

### Why move back

Firestore is a good fit for horizontally-scaled, offline-first, document-shaped
workloads. Payroll is none of those. Concretely, building it on Firestore
required hand-rolling six things PostgreSQL provides natively — batched point
reads standing in for joins, a username reservation collection standing in for a
unique constraint, natural document ids standing in for two more, chunked batches
standing in for transactions, a rounding helper standing in for a decimal type,
and manual dependent cleanup standing in for `ON DELETE` rules.

Three points settled it:

1. **Money had no exact type.** Firestore stores IEEE 754 doubles. Payroll
   figures are filed with URA and NSSF, so amounts are now `NUMERIC(14,2)` —
   exact decimal.
2. **Large payroll runs were not atomic.** Firestore caps a batch at 500
   operations, so a run was split into chunks that could half-apply. The whole
   run is now one transaction.
3. **Nothing could be enforced by the store.** Every invariant lived in
   application code, where the next change can forget it.

Worth being clear: the original bugs were not PostgreSQL's fault. Of the 26 audit
findings, about 24 were application-layer, and the two that were database-related
— the salary-structure save and the broken deletes — were *missing constraints*.
The lesson was that the schema was underspecified, not that the engine was wrong.

### Removed

`firebase-admin`, `server/firebase.js`, `firestore.rules`,
`firestore.indexes.json`, `firebase.json`, `.firebaserc`.

Firebase Analytics on the sign-in page is kept — it is independent of the data
layer — so `public/js/firebase-client.js` and the project's web config remain.

### Added

- `server/db.js` — connection pool with three Cloud SQL connection styles,
  camelCase row mapping, exact-decimal type parsing, `withTransaction`, bulk
  insert building, and constraint-violation translation into HTTP error codes
- `server/migrate.js` — a migration runner: numbered files, applied once each
  inside a transaction, recorded with checksums, with drift detection. This
  replaces the ALTER-on-every-boot chain that caused the MFA bug in 1.x
- `server/migrations/001_initial_schema.sql` — the full schema
- `tests/constraints.test.js` — 30 tests asserting the schema itself refuses the
  bad cases

### Invariants now enforced by the database

These were application-only checks and are now constraints, which makes them
race-free:

| Rule | Mechanism |
|---|---|
| Net pay is never negative | `CHECK (net_salary >= 0)` |
| Payroll arithmetic is consistent | `CHECK (abs(net − (gross − deductions)) < 0.01)` |
| The processor never approves their own run | `CHECK (approved_by IS DISTINCT FROM processed_by)` |
| Leave never overlaps | `EXCLUDE USING gist` on teacher + date range |
| One open advance per teacher | Partial unique index on open statuses |
| An advance is never over-repaid | `CHECK (amount_repaid <= amount)` |
| One structure per salary scale | Primary key on the scale name |
| One payroll run per period | `UNIQUE (month, year)` |
| A teacher's scale must exist | Foreign key, `ON DELETE RESTRICT` |
| Payroll history survives staff deletion | `ON DELETE RESTRICT` on `payroll_items.teacher_id` |
| The audit trail survives account deletion | `ON DELETE SET NULL` on `audit_log.user_id` |
| Leave day counts cannot drift | `GENERATED ALWAYS AS … STORED` |
| A paused teacher carries a reason | `CHECK (NOT payroll_halted OR reason IS NOT NULL)` |

### Other improvements the move enabled

- **Payroll processing is one transaction**, with `SELECT … FOR UPDATE` on the
  period row so concurrent runs serialise instead of colliding
- **Aggregates are computed by the database.** Dashboard figures are one query
  with scalar subqueries instead of eight round trips; statutory totals are a
  `SUM`, not a JavaScript reduce over fetched documents
- **Joins replace batched point reads** throughout, so a teacher list is one
  query rather than a list plus several key lookups
- **Role notifications are a single `INSERT … SELECT`**, rather than reading the
  recipients into the application and writing them back
- **Unpaid-leave abatement is one query** for all teachers, using `LEAST`/
  `GREATEST` on the date bounds, replacing one query per teacher
- **Audit pagination uses keyset paging** on a monotonic id, which stays fast at
  any depth
- **Zero npm vulnerabilities.** Dropping `firebase-admin` removed the
  unfixable transitive `uuid` advisory; the one remaining instance, from
  `exceljs`, is resolved with an `overrides` entry, verified not to break Excel
  generation

### Bugs found while building this

- **A `CHECK` constraint collided with `ON DELETE SET NULL`.** Requiring
  `approved_by IS NOT NULL` on an approved run meant deleting a former approver
  failed — the same class of bug as finding #3. The constraint now requires
  `approved_by_name`, so the name is preserved while the key detaches.
- **An ambiguous column reference.** A shared SQL snippet used unqualified
  `year, month`, which breaks wherever `payroll_items` and `payroll` are joined.
  It now takes a table alias.
- **Two destructive test suites raced.** Both reset the same database and
  cancelled one another under parallel execution; `npm test` now runs with
  `--test-concurrency=1`.

### Breaking changes

- **Identifiers are integers.** Payroll ids were `YYYY-MM` strings and are now
  `BIGSERIAL`. Any stored link or bookmark containing an old id will not resolve.
- `GET /api/admin/audit-log` cursors are numeric ids rather than document ids.
- `GET /readyz` reports `database`, `databaseName` and `databaseVersion` in place
  of `firestore` and `projectId`.
- Environment variables changed: `FIREBASE_SERVICE_ACCOUNT` and friends are gone;
  use `INSTANCE_UNIX_SOCKET`, `DATABASE_URL`, or `DB_HOST`/`DB_USER`/
  `DB_PASSWORD`/`DB_NAME`. See `.env.example`.
- `npm run db:init` is gone. Use `npm run db:setup`, or `db:migrate` then
  `db:seed`.

### Migrating data from the Firestore build

If the 2.0.0 build holds production data:

1. Export it with `GET /api/admin/backup` while still on 2.0.0
2. Create the schema on Cloud SQL: `npm run db:migrate`
3. Load `salaryStructures` first, then `users`, then `teachers` and
   `accountants` — the foreign keys require that order
4. Map camelCase fields to snake_case columns, and ISO timestamp strings to
   `TIMESTAMPTZ`
5. Load `payroll`, then `payrollItems`, then `leaveRequests` and
   `advanceRequests`
6. Set the `counters` rows above the highest existing employee id, so newly
   allocated ids do not collide
7. Confirm with `npm run db:migrate:status` and a sign-in as each role

The constraints will reject inconsistent historical rows — a negative net salary,
overlapping leave, two open advances for one teacher. That is the schema doing its
job; those rows need correcting rather than the constraint relaxing.

---

## 2.0.0 — Audit remediation (data layer since superseded by 2.1.0)

Two changes at once: the data layer moved from DigitalOcean PostgreSQL to Cloud
Firestore, and the 26 findings from the code audit were addressed.

### Database

PostgreSQL (`pg`) is gone. `server/database.js` and `server/seed-users.js` are
replaced by `server/firebase.js` and `server/seed.js`; `.do/app.yaml` is replaced
by `firebase.json`, `firestore.rules`, `firestore.indexes.json` and `.firebaserc`.

The server uses the Firebase Admin SDK with a **service account**. The web config
(`apiKey`, `authDomain`, …) is wired into the login page for Analytics only — it
cannot authenticate a server. Firestore rules deny all direct client access,
because payroll authorisation depends on workflow state that rules cannot
evaluate.

Field names moved from `snake_case` to `camelCase`. The API still accepts the
snake_case spellings on input for compatibility.

---

### Tier 1 — features that were broken

**1. Salary structures could never be saved.**
`ON CONFLICT (salary_scale)` was used against a column with no unique
constraint, so every save returned 500 and HR could not define a single pay
scale. The scale name is now the Firestore document id, making uniqueness a
property of the database. Verified by `integration.test.js`.

**2. Two-factor authentication disabled itself on every restart.**
`UPDATE users SET mfa_enabled = 0 WHERE mfa_pending_token_hash IS NULL` sat
inside `createTables()`, written as a one-time migration but executed on every
boot — so MFA was effectively permanently off. The whole migration chain is gone;
`seed.js` is idempotent and touches no existing records.

**3. Deleting HR, accountants and teachers failed.**
`audit_log.user_id`, `notifications.user_id` and `payroll_items.teacher_id` had
no `ON DELETE` rule, so deletion broke for anyone who had logged in once or
appeared on a payroll run. Deletion now runs through `services/accounts.js`:
dependents are cleaned up explicitly, audit entries are detached rather than
destroyed, and deletion is **refused** for anyone with payroll history —
deactivation is offered instead, which is the correct action for a payroll system.

**4. `setup-password.html` did not exist.**
New teachers were emailed a link to a page that was never written, and login was
blocked until setup completed — so every teacher created by an administrator was
permanently locked out. The page now exists, along with `forgot-password.html`
and `reset-password.html`.

**5. Accountants could not change their password.**
The accountant dashboard had no Security section. It now has one, as do all four
dashboards.

---

### Tier 2 — security

**6. Stored XSS in every dashboard table.**
49 sites interpolated unescaped server data into `innerHTML`. A teacher could
put markup in a leave reason and have it execute in an HR session, where the
token is held — teacher to HR privilege escalation. All output now passes through
an auto-escaping `html` template tag. `raw()` returns a class instance, so a
JSON payload cannot forge the trust marker. Covered by `escaping.test.js`
against real payloads.

**7. Administrators could read any user's live MFA code.**
Codes were stored in plain text in `admin_mfa_codes` and displayed in an admin
portal, letting any administrator sign in as anyone. Codes are now hashed and
emailed to the account owner. `GET /admin/mfa-status` shows only that a challenge
exists — method, masked address, attempt count, expiry — never the code.

**8. No rate limiting, and the MFA counter was resettable.**
`/auth/login` accepted unlimited attempts, and `resend-mfa` reset
`mfa_pending_attempts` to 0, making a 6-digit code brute-forceable by alternating
resend and verify. Added `express-rate-limit` (20 sign-ins per 15 min, 5
email-sending requests per hour, 300 API requests per minute) and the resend path
no longer touches the attempt counter.

**9. Shared default passwords, and a forced-rotation flag that did nothing.**
`teacher123`, `accountant123`, `hr123` and `admin123` were hardcoded, while
`must_change_password` was set everywhere and read by no front-end code. There
are now no shared defaults: accounts activate through an emailed single-use link,
or a unique random temporary password shown once. `requirePasswordChanged`
enforces the flag server-side, and the client shows a blocking dialog.

**10. Weak auth plumbing.**
`JWT_SECRET` fell back to a hardcoded `'edupay_secret_key_2024'`; startup now
refuses in production, and requires 32+ characters. Tokens are 2 hours (was 8),
carry a `tokenVersion` for revocation, and `POST /auth/logout` invalidates them.
`app.use(cors())` allowed all origins; CORS is now restricted to
`ALLOWED_ORIGINS`. Added `helmet` with a CSP that needs no inline-script
allowance — which required moving the login page's inline script to `login.js`.

**11. Eight npm vulnerabilities.**
Resolved by the dependency change plus upgrades: `nodemailer` 6 → 10.0.15
clears GHSA-mm7p-fcc7-pg87; dropping `pg` removes its transitive issues; Express
and `pdfkit` are current. One moderate remains — `uuid` inside
`firebase-admin`'s gRPC stack — on a code path (v3/v5/v6 with an explicit `buf`)
that nothing here uses. It needs an upstream release.

---

### Tier 3 — payroll correctness

**12. PAYE was a flat percentage of basic salary.**
Replaced with Uganda's URA banded monthly schedule applied to gross, in
`services/tax.js`, with the bands held in configuration. NSSF now tracks the
**10% employer share** alongside the 5% employee deduction, so the true cost of
employment and the monthly NSSF remittance are both available — the employer
portion was not modelled at all. A `flat` mode is retained to reproduce
historical figures. Every band boundary is tested.

**13. Reprocessing destroyed payroll history.**
The previous run and all its items were hard-deleted. Runs are now versioned:
the prior version is archived to `payroll/{id}/versions/{n}` with its lines, its
advance repayments are reversed so nothing is double-counted, its lines are
flagged `superseded`, and a new version is written. Nothing is deleted.

**14. Duplicate payroll runs were possible.**
The existence check ran before `BEGIN`, so two accountants could both pass it.
The run's document id is now its period (`2026-06`), making duplication
impossible. Month and year are also validated — the old code accepted month 47
of year 1823.

**15. Payments bypassed the approval gate.**
An item could be marked Paid on a run nobody had approved. Payment now requires
`approved` or `paid` status. The run's status is recomputed in both directions,
so reverting one line returns a fully-paid run to approved — previously it stayed
`paid` with pending items.

**16. Advances could exceed a whole salary.**
The full amount was deducted from the next run with no cap and no floor, so net
pay could go negative. Advances now have a configurable ceiling as a share of net
pay, an instalment schedule, and a net-pay floor that trims each instalment and
carries the remainder forward. The payslip shows the deferred amount and why.

**17. Leave was a record-keeping stub.**
No entitlement, balance, overlap check, date validation, or effect on pay.
`services/leave.js` adds paid/unpaid types, inclusive day counts, annual
entitlement with balance checked at both submission and approval, overlap
rejection, and date-window validation. Approved **unpaid** leave now abates basic
pay pro rata at payroll time — allowances are left intact.

---

### Tier 4 — workflow, UX, maintainability

**18. Notifications were teacher-only.**
Approvers received nothing and had to poll their dashboards. `services/
notifications.js` can target a role, so: a leave or advance request notifies HR;
processing payroll notifies HR that approval is pending; approval notifies the
accountant that it is payable and each teacher individually with their own net
figure; payment notifies the teacher; a teacher changing their payment
destination notifies HR. Every dashboard has a notifications bell.

**19. No search, filter or pagination.**
Every table rendered every row, and the audit log was a hard `LIMIT 200`.
`createTable` provides search, column sorting and paging everywhere; the audit
log is cursor-paginated with username and action filters. Twenty composite
indexes are declared for the queries that need them.

**20. Two divergent teacher-creation paths.**
`POST /admin/users` with `role: teacher` and `POST /hr/teachers` produced
differently-shaped accounts with different activation. All roles now go through
`accounts.createAccount`; teachers are created only via HR, where the payroll
fields belong.

**21. No self-service password reset.**
Added `/auth/forgot-password` with single-use hashed tokens consumed in a
transaction. The response is identical whether or not the account exists, so it
cannot be used to enumerate usernames.

**22. Accessibility was effectively zero.**
No `aria-` attributes anywhere, navigation built from `<div onclick>` (not
focusable, invisible to screen readers), 101 inline handlers, `confirm()` for
destructive actions. Navigation is now `<button>` elements with `aria-current`;
modals have `role="dialog"`, `aria-modal`, focus management and Escape handling;
tables have captions and `aria-sort`; toasts are polite live regions; forms use
`aria-describedby`; every page has a skip link. `confirm()` is replaced by a
dialog that explains consequences and can require typing a name to proceed.

**23. The login page animated 42 positioned elements.**
Replaced with three CSS gradient layers, and disabled under
`prefers-reduced-motion`.

**24. Duplication and dead code.**
The 80-line payslip PDF generator existed as two near-identical copies;
`services/documents.js` is now the single definition. Payroll calculation moved
out of the route handler into `services/payroll-calculator.js`, which is what
made it testable. `maskEmail` and `sendMfaOtpEmail` were dead — both are now
used. The `admin_mfa_codes` table and the unused `draft` payroll status are gone.

**25. Migrations ran on every boot with errors swallowed.**
~25 `ALTER TABLE` statements with `.catch(() => {})` each startup. Firestore is
schemaless; `seed.js` runs on request, is idempotent, and reports failures.

**26. No tests, logging, error middleware or health endpoint.**
Added 113 tests, a structured JSON logger, central error handling that logs the
real cause while returning a safe message, and `/healthz` plus `/readyz` — the
platform check previously hit `/`, which only proved static files were serving
and would not detect a database outage.

---

### Found while building

Two bugs in the new code, caught by the integration suite:

- **Deactivation took up to 30 seconds to apply.** The auth user cache was not
  invalidated when an account was deactivated, so a revoked session kept working
  until the cache expired. `invalidateUserCache` now runs inside
  `services/accounts.js`, so every caller gets immediate effect.
- **A partial salary-structure save silently zeroed allowances.** Omitted fields
  defaulted to `0` and were written with `merge: true`. Omitted fields now retain
  their current value on an update.

---

### Upgrading from 1.x

There is no automated data migration — the storage model is different. To move
existing data:

1. Export from PostgreSQL (the 1.x `GET /api/admin/backup` produces JSON)
2. Map `snake_case` columns to `camelCase` fields per the model in
   [TECHNICAL_DOCUMENTATION.md](TECHNICAL_DOCUMENTATION.md#4-firestore-data-model)
3. Write `salaryStructures` keyed by scale name and `payroll` keyed by `YYYY-MM`
4. Set `tokenVersion: 0`, `mustChangePassword: true` and `mfaEnabled` per account
5. Re-hash passwords or, preferably, send every user a setup link — 1.x bcrypt
   hashes remain valid, but accounts on the old shared defaults should be reset

Breaking changes for any existing API client: `camelCase` responses, `mfaRequired`
replaces `mfa_required`, `/admin/mfa-codes` is removed in favour of
`/admin/mfa-status`, admin password reset no longer accepts a chosen password,
and payroll ids are now `YYYY-MM` strings rather than integers.
