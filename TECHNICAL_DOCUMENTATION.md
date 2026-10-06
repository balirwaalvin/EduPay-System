# EduPay — Technical Documentation

Implementation reference for the PostgreSQL build. For setup and operations see
[README.md](README.md); for the change history, including the audit remediation
and the move to Cloud SQL, see [CHANGELOG.md](CHANGELOG.md).

---

## 1. Project layout

```
server/
  server.js                  Express app, security headers, health checks, startup
  db.js                      Pool, Cloud SQL connection, query helpers, error mapping
  migrate.js                 Migration runner, checksum-verified
  migrations/                Numbered SQL files, applied once each
  middleware.js              Auth, role gates, rate limiting, error handling
  seed.js                    Idempotent first-run bootstrap
  routes/
    auth.js                  Sign-in, MFA, password setup/reset/change, sign-out
    admin.js                 Accounts, settings, audit log, export, stats
    hr.js                    Teachers, salary structures, approvals
    accountant.js            Payroll processing, payments, reports
    teacher.js               Own profile, payslips, leave, advances
    notifications.js         Shared inbox for every role
  services/
    tax.js                   PAYE bands, NSSF
    payroll-calculator.js    One payroll line, and run totals
    leave.js                 Day counts, entitlement, overlap, unpaid-leave effect
    advances.js              Caps, instalments, repayment, reversal
    accounts.js              Account creation, activation, deactivation, deletion
    passwords.js             Hashing, temporary passwords, tokens, OTPs
    validate.js              Request validation
    config.js                System settings, cached
    documents.js             Payslip and report PDFs, Excel export
    notifications.js         Targeted notifications
    audit.js                 Audit writes and paginated reads
    email.js                 SMTP templates
    logger.js                Structured logging
public/
  index.html                 Sign-in
  setup-password.html        First-time activation
  forgot-password.html       Request a reset
  reset-password.html        Complete a reset
  admin.html hr.html accountant.html teacher.html
  css/styles.css
  js/
    app.js                   Escaping, API client, tables, modals, notifications
    login.js password-flows.js firebase-client.js
    admin.js hr.js accountant.js teacher.js
tests/                       143 tests (76 with no database, 67 against one)
server/migrations/001_initial_schema.sql   Tables, constraints, indexes, triggers
```

---

## 2. Request lifecycle

```
Request
  ├─ helmet                     security headers + CSP
  ├─ cors                       restricted to ALLOWED_ORIGINS
  ├─ express.json               256 KB limit
  ├─ request logger             skips health checks
  ├─ apiLimiter                 300/min per IP across /api
  ├─ authLimiter                20/15min on credential endpoints
  ├─ authenticateToken          JWT verify → load user → check active + tokenVersion
  ├─ authorizeRoles(...)        role gate
  ├─ requirePasswordChanged     blocks until a temporary password is replaced
  ├─ handler (asyncHandler)     validation → Firestore → audit → notify → respond
  ├─ notFoundHandler            JSON 404 for /api, text elsewhere
  └─ errorHandler               logs the cause, returns a safe message
```

`asyncHandler` wraps every handler so a rejected promise reaches
`errorHandler` rather than hanging the request. Deliberate failures throw
`HttpError(status, message, code)`; the client switches on `code`.

---

## 3. Authentication

### Token contents

```json
{ "id": "...", "username": "...", "role": "hr", "fullName": "...", "tokenVersion": 3 }
```

Signed with `JWT_SECRET`, `issuer: "edupay"`, default lifetime 2 hours.

### Revocation

`tokenVersion` lives on the user document and is embedded in the token.
`authenticateToken` compares them and rejects a mismatch with `TOKEN_REVOKED`.
It is incremented by: password change, password reset, password setup, admin
password reset, role change, deactivation, and sign-out. A stolen token
therefore stops working the moment any of those happens.

### User cache

`authenticateToken` would otherwise query the database on every request, so users
are cached for 30 seconds. Anything that must take effect immediately calls
`invalidateUserCache(userId)` — including deactivation, which is handled inside
`services/accounts.js` so every caller benefits.

### Two-factor

1. `POST /auth/login` with a correct password and `mfaEnabled` → a challenge
2. The server generates a 6-digit code, stores **only its SHA-256 hash**, and
   emails the plaintext to the account owner
3. A random 32-byte challenge token is returned to the browser; its hash is
   stored alongside
4. `POST /auth/verify-mfa` checks the challenge token, expiry, attempt count,
   then the code hash — all in constant time via `timingSafeEqual`
5. Success clears the pending fields and issues the access token

The attempt counter is **not** reset by `resend-mfa`; resetting it would allow
unlimited guessing by alternating resend and verify.

Codes are never returned by any endpoint. `GET /admin/mfa-status` reports only
that a challenge exists, its method, a masked address, the attempt count and the
expiry.

### Account activation

| Condition | Path |
|---|---|
| Email address present **and** SMTP configured | Single-use setup link, 24 h. No password is ever known to anyone |
| Otherwise | Unique random temporary password, returned to the creator once, `mustChangePassword: true` |

`mfaEnabled` defaults to whether email can actually deliver — enabling it
without a delivery channel would lock the account out immediately.

---

## 4. Database schema

The schema is in `server/migrations/001_initial_schema.sql`. Its distinguishing
feature is how much it enforces: rules that would otherwise be application-only
checks are constraints, so they are race-free and cannot be bypassed.

### Money

Every amount is `NUMERIC(14,2)` (totals `NUMERIC(16,2)`) — exact decimal.
`0.1 + 0.2 = 0.3` holds for `NUMERIC` and not for floating point, which matters
when the figures are filed with URA and NSSF.

`node-postgres` returns `NUMERIC` as a string to avoid precision loss. `db.js`
registers a type parser converting it to `Number`, which is safe at two decimal
places far beyond any realistic payroll, while storage and `SUM()` remain exact.

### Constraints that carry business rules

| Constraint | Table | Guarantees |
|---|---|---|
| `salary_structures_pkey` | `salary_structures` | One structure per scale. The old schema lacked this while the insert used `ON CONFLICT (salary_scale)`, so every save failed |
| `payroll_period_unique` | `payroll` | One run per period, so concurrent processing cannot duplicate |
| `payroll_processor_is_not_approver` | `payroll` | `approved_by IS DISTINCT FROM processed_by` — separation of duties in the database |
| `payroll_approval_complete` | `payroll` | An approved run records `approved_at` and `approved_by_name` |
| `payroll_items_net_salary_check` | `payroll_items` | Net pay is never negative |
| `payroll_items_net_consistent` | `payroll_items` | `net = gross − deductions`, to one cent |
| `payroll_items_unique` | `payroll_items` | One line per teacher per run version |
| `payroll_items_teacher_id_fkey` | `payroll_items` | `ON DELETE RESTRICT` — payroll history cannot be destroyed |
| `teachers_salary_scale_fkey` | `teachers` | A teacher's scale must exist; a scale in use cannot be deleted |
| `teachers_halt_reason_required` | `teachers` | A paused teacher always carries a reason |
| `leave_no_overlap` | `leave_requests` | `EXCLUDE USING gist` — no overlapping pending or approved leave |
| `leave_dates_ordered` | `leave_requests` | The end date follows the start |
| `advance_one_open_per_teacher` | `advance_requests` | A partial unique index: one open advance per teacher |
| `advance_not_over_repaid` | `advance_requests` | `amount_repaid <= amount` |
| `audit_log.user_id` | `audit_log` | `ON DELETE SET NULL` — the trail survives account deletion |

Two of these deserve a closer look.

**Leave overlap.** An application check reads then writes, so two concurrent
requests can both pass it. An exclusion constraint cannot be raced:

```sql
CONSTRAINT leave_no_overlap
    EXCLUDE USING gist (
        teacher_id WITH =,
        daterange(start_date, end_date, '[]') WITH &&
    ) WHERE (status IN ('Pending', 'Approved'))
```

The `WHERE` clause matters: a rejected or cancelled request releases its dates.

**One open advance.** Likewise, as a partial unique index:

```sql
CREATE UNIQUE INDEX advance_one_open_per_teacher
    ON advance_requests (teacher_id)
    WHERE status IN ('Pending', 'Approved', 'Repaying');
```

### Generated and triggered columns

`leave_requests.days` is `GENERATED ALWAYS AS (end_date - start_date + 1) STORED`,
so the stored count can never drift from the dates. A `set_updated_at` trigger
maintains `updated_at` on the eight mutable tables, so no `UPDATE` has to
remember it.

### Deletion semantics

Chosen per relationship, because the previous schema's lack of any `ON DELETE`
rule is what broke deletes entirely:

| Relationship | Rule | Why |
|---|---|---|
| `teachers.user_id` → `users` | `CASCADE` | The profile has no meaning without the account |
| `accountants.user_id` → `users` | `CASCADE` | As above |
| `notifications.user_id` → `users` | `CASCADE` | Nobody left to read them |
| `payroll_items.teacher_id` → `teachers` | `RESTRICT` | Financial history must survive |
| `payroll_items.payroll_id` → `payroll` | `CASCADE` | Lines belong to their run |
| `audit_log.user_id` → `users` | `SET NULL` | Keep the trail, detach the key |
| `payroll.approved_by` → `users` | `SET NULL` | `approved_by_name` is the durable record |
| `leave_requests.teacher_id` → `teachers` | `CASCADE` | No financial record |

A subtlety worth knowing: `payroll.approved_by` is `SET NULL`, so the approval
check constraint requires `approved_by_name` rather than `approved_by`. Requiring
the foreign key would make deleting a former approver fail — exactly the class of
bug that broke deletes in the first place.

### Tables

```
users                 credentials, role, two-factor state, token_version
teachers              employment record, scale, payment destination, halt state
accountants           accountant profile
salary_structures      PK = scale name; basic, allowances, deduction rates
payroll                PK = id, UNIQUE (month, year); status, version, totals
payroll_versions      PK = (payroll_id, version); JSONB snapshot of a superseded run
payroll_items          one line per teacher per run version; all NUMERIC(14,2)
leave_requests         type, dates, generated day count, paid/unpaid, decision
advance_requests       amount, instalment schedule, repayment progress
notifications          per-user inbox, every role
audit_log              privileged actions, surviving account deletion
system_config          one row per setting, JSONB values
password_resets        PK = token hash; single-use reset tokens
counters               employee-id sequences
schema_migrations      applied migrations with checksums
```

### Indexes

Beyond the primary and unique keys: `users (role, is_active)`,
`users (created_at DESC)`, partial indexes on the sparse token columns,
`teachers (is_active, payroll_halted)` for payroll eligibility,
`payroll (year DESC, month DESC)`, `payroll_items (payroll_id, version)`,
a partial index on pending payments, `leave_requests (teacher_id, status)`,
a partial index on approved unpaid leave for the payroll abatement query,
`notifications (user_id)` partial on unread, and `audit_log` by created_at,
action and username.

---

## 5. Payroll processing

`POST /api/accountant/payroll/process` — the most involved operation, and now a
single transaction.

```
BEGIN
 1  Validate the period                      month 1–12, year 2000..now+1
 2  SELECT … FOR UPDATE on the period row    a concurrent run waits here
 3  Refuse if already approved or paid       PAYROLL_LOCKED
 4  Load eligible teachers joined to their structures
 5  Refuse if any teacher's scale is missing  before writing anything
 6  Resolve advance instalments due          one query
 7  Resolve unpaid-leave days in the period  one query, all teachers
 8  Compute every line in memory             a failure writes nothing
 9  Archive the previous version to payroll_versions (JSONB)
10  Reverse its advance repayments           one UPDATE … FROM
11  Flag its lines superseded                never deleted
12  Upsert the run header at version n+1
13  Insert every line in one multi-row INSERT
14  Record each advance repayment
COMMIT
```

Everything between `BEGIN` and `COMMIT` is atomic at any number of employees.
This is the principal integrity gain over the previous document-store build,
whose batches capped at 500 operations and so had to be split into chunks that
were not atomic with one another — a large run could half-apply.

Steps 5 and 8 matter too: the run is fully validated and calculated before the
first write, so a bad salary scale produces a clear 400 rather than a
half-written payroll.

### Concurrency

`FOR UPDATE` on the period row serialises two accountants pressing Process at the
same moment: the second blocks until the first commits, then sees its work and
supersedes it as version 2. Without the lock, both would pass the existence check
and the `payroll_period_unique` constraint would reject the loser with a 409 —
correct, but a worse experience.

### Calculation order

```
contractualBasic  = structure.basicSalary
unpaidDeduction   = contractualBasic / daysInMonth × unpaidLeaveDays
basic             = contractualBasic − unpaidDeduction
gross             = basic + housing + transport + medical + other

paye              = bandedPaye(gross)                  URA monthly schedule
nssfEmployee      = gross × 5%
nssfEmployer      = gross × 10%                         tracked, not deducted

baseDeductions    = paye + nssfEmployee + loan + other
netBeforeAdvance  = gross − baseDeductions

netFloor          = gross × minimumNetPercentage        default 30%
advanceCapacity   = max(0, netBeforeAdvance − netFloor)
appliedAdvance    = min(instalmentDue, advanceCapacity)
deferredAdvance   = instalmentDue − appliedAdvance      carried forward

totalDeductions   = baseDeductions + appliedAdvance
net               = gross − totalDeductions
employerCost      = gross + nssfEmployer
```

Allowances are never abated for unpaid leave — only basic pay is. The advance
floor guarantees net pay cannot be driven to zero, and `payroll_items_net_salary_check`
means the database would reject the row even if the calculator were wrong.

### Advance instalments

`instalmentAmount(advance)` returns `outstanding` when one instalment remains,
otherwise `total / instalments`. Settling the remainder on the final instalment
prevents a rounding tail: 100,000 over three instalments is 33,333.33,
33,333.33, then **33,333.34**.

---

## 6. Separation of duties

| Control | Where |
|---|---|
| Only HR may approve payroll, administrators included | `hr.js` — explicit `role !== 'hr'` check inside the handler |
| Nobody may approve a run they processed | `hr.js` check, **and** the `payroll_processor_is_not_approver` constraint |
| Payments require an approved run | `accountant.js` — `PAYROLL_NOT_APPROVED` |
| An approved run cannot be reprocessed | `accountant.js` — `PAYROLL_LOCKED` |
| Administrators cannot read another user's MFA code | codes are hashed; no endpoint returns one |
| Administrators cannot choose someone's password | reset generates a random one, shown once |
| The last active administrator cannot be removed | `accounts.js` — `assertNotLastAdmin` |

The HR-only approval check lives in the handler rather than in
`authorizeRoles`, because these routes are deliberately shared with
administrators for every other operation.

---

## 7. Front-end architecture

No framework and no build step. Three ideas carry most of the weight.

### The `hidden` attribute

`[hidden] { display: none !important; }` is set deliberately. The attribute is
implemented by the user-agent stylesheet as `display: none`, which **any** author
`display` rule overrides — so an element carrying both `hidden` and, say,
`.bell-panel { display: flex }` stays on screen. That had the notification panel
permanently open and covering the page (blocking the buttons underneath), and
showed the two-factor form before anyone had signed in. Any new component with a
`display` rule and a `hidden` state depends on this.

### Content security policy, in two flavours

The sign-in page is served a wider policy than the authenticated pages. Firebase
Analytics needs to load script from `googletagmanager.com`, and permitting that
origin inside the dashboards — which show salaries and bank details and hold the
access token — would mean a compromise there could inject script into them. The
sign-in page holds no data, so it carries the risk instead. Analytics is off by
default; `data-analytics="on"` in `index.html` enables it.

No page needs `'unsafe-inline'`: every script is an external file and no markup
carries a `style` attribute. Utility classes in the stylesheet exist for that
reason.

### Escaping by default

```js
html`<td>${teacher.fullName}</td>`     // escaped
html`<td>${raw(badge(status))}</td>`   // explicitly trusted
```

`raw()` returns a `TrustedMarkup` **class instance**, and `html` checks
`instanceof`. A plain object from `JSON.parse` cannot forge that, so server data
can never be promoted to trusted markup by a crafted payload.

### `createTable`

One factory supplies the empty state, loading state, search, column sorting and
pagination for every list:

```js
const table = createTable({
    tbody: 'teacherTableBody', columns: 7, pageSize: 25,
    searchInput: 'teacherSearch', pagerTarget: 'teacherPager',
    searchFields: ['fullName', 'employeeId'],
    renderRow: t => html`<tr>…</tr>`,
    emptyMessage: 'No teachers yet'
});
table.setData(rows);
```

### Event delegation

No inline `onclick`. Rows carry `data-*` attributes and one listener per table
body dispatches. That keeps the content security policy free of
`'unsafe-inline'` and lets navigation be real `<button>` elements, which are
focusable and keyboard-operable.

### Shared bootstrap

`initDashboard({ role })` wires navigation, the sidebar, sign-out, the
notifications bell, the idle timeout, modal dismissal, the forced
password-change prompt, and restores the section named in `location.hash`.
Sections load their data lazily on first display; approval queues reload on
every visit.

---

## 8. Error codes

| Code | Status | Meaning |
|---|---|---|
| `NO_TOKEN` `TOKEN_EXPIRED` `TOKEN_INVALID` `TOKEN_REVOKED` | 401 | The session is unusable; the client clears it and returns to sign-in |
| `USER_INACTIVE` | 403 | The account was deactivated |
| `PASSWORD_CHANGE_REQUIRED` | 403 | The client opens the forced-change dialog |
| `FORBIDDEN` `HR_ONLY` `SELF_APPROVAL` | 403 | Role or duty-separation refusal |
| `VALIDATION_FAILED` | 400 | The message names the field |
| `USERNAME_TAKEN` | 409 | |
| `PAYROLL_LOCKED` `PAYROLL_NOT_APPROVED` | 409 | Workflow state refusal |
| `LEAVE_OVERLAP` `ADVANCE_ALREADY_OPEN` | 409 | |
| `INSUFFICIENT_LEAVE_BALANCE` `ADVANCE_EXCEEDS_LIMIT` | 400 | |
| `HAS_PAYROLL_HISTORY` | 409 | Deletion refused; deactivate instead |
| `UNKNOWN_SCALE` `MISSING_SALARY_STRUCTURE` | 400 | |
| `SCALE_IN_USE` `LAST_ADMIN` | 400/409 | Referential guards |
| `RATE_LIMITED` | 429 | |
| `INTERNAL_ERROR` | 500 | Detail is logged, not returned |

---

## 9. Testing

```bash
npm test                                           # 76 tests, no database needed

createdb edupay_test
TEST_DATABASE_URL=postgresql://…/edupay_test npm test   # 143 tests
```

| File | Covers | Needs a database |
|---|---|---|
| `tax.test.js` | Every PAYE band boundary, the 10 M surcharge, flat and disabled modes, NSSF split | no |
| `payroll-calculator.test.js` | Gross composition, unpaid-leave abatement, the net-pay floor, advance deferral, missing structures, run totals | no |
| `leave.test.js` | Inclusive day counts, month and year boundaries, range and window validation | no |
| `advances.test.js` | Ceilings, instalment arithmetic, the final-instalment remainder | no |
| `validate.test.js` | Every validator, including rejection of the old shared passwords and of `month 47 of 1823` | no |
| `escaping.test.js` | Real XSS payloads, attribute breakout, forged trust markers | no |
| `smoke.test.js` | Security headers, CSP without `unsafe-inline`, page serving, the auth gate, JSON 404s, body limits | no |
| `constraints.test.js` | 30 tests asserting the **schema** refuses negative net pay, overlapping leave, a second open advance, self-approval, deleting a teacher with payroll history, exact decimal money | yes |
| `integration.test.js` | 37 tests covering the whole workflow end to end | yes |

Both database suites truncate and re-seed before running, so they are
repeatable, and each refuses to run unless the database name contains `test`.

They are run with `--test-concurrency=1`, because both reset the same database
and would otherwise cancel one another.

---

## 10. Operational notes

### Connection pooling

`PG_POOL_MAX` (default 10) is per process. Cloud Run scales horizontally, so the
ceiling is `PG_POOL_MAX × max instances`, which must stay below the instance's
`max_connections` — the smaller Cloud SQL tiers allow relatively few. Symptoms of
getting this wrong are `remaining connection slots are reserved` errors under
load.

`statement_timeout` and `query_timeout` default to 30 seconds, so a pathological
query frees its pool slot rather than holding it indefinitely. The pool is
drained on `SIGTERM`, so a Cloud Run revision shutting down releases its slots.

### Error mapping

`db.js` maps constraint violations onto the application's own error codes, so a
violation becomes an explained 4xx rather than an opaque 500. For example
`leave_no_overlap` → `409 LEAVE_OVERLAP`, and
`payroll_items_teacher_id_fkey` → `409 HAS_PAYROLL_HISTORY` with advice to
deactivate instead. Unrecognised database errors pass through untranslated and
are reported as genuine faults.

### Backups

Enable automated backups and point-in-time recovery on the Cloud SQL instance;
that is the real backup. `GET /api/admin/backup` is a JSON export for ad-hoc
inspection and migration, and omits password hashes and two-factor secrets.

### Migrations in deployment

Migrations are not run automatically at startup, deliberately: several Cloud Run
instances starting at once would race. Run `npm run db:migrate` as a separate
step — a Cloud Build step, a one-off Cloud Run job, or from a laptop through the
Auth Proxy — then deploy. The server checks at startup that the schema exists and
exits with a clear message if it does not.

### Query performance

`db.js` logs any query exceeding `PG_SLOW_QUERY_MS` (default 500 ms) with its
duration and a truncated statement. For anything that shows up there, `EXPLAIN
(ANALYZE, BUFFERS)` against a copy of production data is the next step; the
indexes listed in section 4 cover the current query set.

---

## 11. Demo accounts

> **Local development only.** These credentials exist solely in a throwaway
> container database on a developer machine. `scripts/seed-demo.js` refuses to
> run against anything that is not `localhost`, and nothing here is ever created
> on a real deployment. Never use this password, or this pattern, anywhere real:
> production accounts are activated through an emailed single-use link, and the
> only password that ever exists is the one its owner chooses.

Created by:

```bash
./scripts/dev-db.sh up          # Postgres + Mailpit
npm start                        # in one terminal
node scripts/seed-demo.js        # in another
```

**Every demo account uses the same password:**

```
Demo-Edupay-2026!x
```

Sign in at **<http://localhost:3100>**.

### Accounts

| Username | Role | Name | Two-factor | Notes |
|---|---|---|---|---|
| `admin` | Administrator | System Administrator | **off** | No email address, so two-factor could not be delivered and stays off. The only account that signs in with just a password. |
| `agnes.hr` | HR | Agnes Byaruhanga | on | Approves payroll, leave and advances |
| `paul.acc` | Accountant | Paul Okello | on | Processed the seeded payroll run |
| `sarah.acc` | Accountant | Sarah Nambi | on | A second accountant, for testing hand-offs |
| `grace.nakato` | Teacher | Grace Nakato (TCH0001) | on | Has payslips, approved leave and an advance being repaid |
| `samuel.okiror` | Teacher | Samuel Okiror (TCH0002) | on | Head of Sciences; sick leave taken, advance over 4 instalments |

### Signing in with two-factor

Every account except `admin` has two-factor enabled, because the demo
environment has working email — so a code can actually be delivered.

1. Enter the username and password
2. The six-digit code is emailed to the account
3. Open the Mailpit inbox at **<http://localhost:8025>** and read it
4. Enter it on the verification screen

To skip this while developing, turn two-factor off for an account from the
administrator dashboard (Staff Accounts → Disable 2FA), or:

```sql
UPDATE users SET mfa_enabled = FALSE WHERE username = 'agnes.hr';
```

### Teachers who cannot sign in

Eight further teachers exist but were deliberately left unactivated, so the
"Password not set" state and the **Resend setup link** action are visible in the
HR dashboard:

| Employee ID | Name | Scale |
|---|---|---|
| TCH0003 | Agnes Birungi | Scale_2 |
| TCH0004 | Joseph Wasswa | Deputy_Head |
| TCH0005 | Rebecca Atim | Scale_3 |
| TCH0006 | Daniel Kyeyune | Scale_2 |
| TCH0007 | Miriam Nabukenya | Teaching_Assistant — **payroll paused** |
| TCH0008 | Patrick Ssentongo | Scale_4 |
| TCH0009 | Hadija Namaganda | Scale_2 |
| TCH0010 | Emmanuel Tumusiime | Scale_3 |

To activate one: sign in as `agnes.hr`, open Teachers, press **Resend link** on
that row, then open the Mailpit inbox and follow it.

Trying to sign in as one of these returns *"Incorrect username or password"*
rather than *"finish setting up your password"*. That is deliberate and not a
bug: an account awaiting a setup link has an unguessable random password, so the
password check fails first and the account's state is never disclosed to someone
who cannot already authenticate. The clearer message exists for the case where a
password is known but setup is still outstanding.

### What the seeded data contains

- **10 teachers** across six salary scales, with bank and mobile-money
  destinations; one paused so it is excluded from payroll
- **Leave** — approved annual, approved sick, approved *unpaid* (which abates
  basic pay pro rata), and one still pending a decision
- **Advances** — 600,000 over three instalments and 1,500,000 over four, both
  approved and partly repaid by the payroll run
- **One payroll run** for the previous month: 9 employees (the tenth is paused),
  processed by `paul.acc`, approved by `agnes.hr`, with 4 of the 9 payments
  recorded — so the run sits at `approved` rather than `paid`, which is what
  lets you exercise the Record Payments screen
- **Notifications** on every role, generated by the real workflow

### Rebuilding

The seeder is not idempotent for payroll, so start clean:

```bash
./scripts/dev-db.sh reset        # wipe, migrate, seed a fresh administrator
# note the generated administrator password it prints
npm start
ADMIN_PASSWORD='<that password>' node scripts/seed-demo.js
```

The seeder changes the administrator password to the demo one as its first step,
so after it finishes `admin` is back to `Demo-Edupay-2026!x`.

To clear the inbox between runs: `curl -X DELETE http://localhost:8025/api/v1/messages`
