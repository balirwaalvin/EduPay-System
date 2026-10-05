# EduPay — Technical Documentation

Implementation reference for the Firebase/Firestore build. For setup and
operations see [README.md](README.md); for what changed from the PostgreSQL
version and why, see [CHANGELOG.md](CHANGELOG.md).

---

## 1. Project layout

```
server/
  server.js                  Express app, security headers, health checks, startup
  firebase.js                Admin SDK init, collection handles, Firestore helpers
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
tests/                       113 tests (76 without Firebase, 37 end-to-end)
firestore.rules              Deny-all backstop
firestore.indexes.json       Composite indexes (required)
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

`authenticateToken` would otherwise read Firestore on every request, so users
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

## 4. Firestore data model

Firestore has no joins, no unique constraints and no `OFFSET`. Three
consequences shape the design.

### Natural document ids give uniqueness

| Collection | Id | Invariant |
|---|---|---|
| `salaryStructures` | scale name | One structure per scale |
| `payroll` | `YYYY-MM` | One run per period |
| `usernames` | the username | One account per username |
| `systemConfig` | setting key | One value per setting |

`usernames` is a reservation index written in the same transaction as the user
document, so two concurrent sign-ups cannot share a username:

```js
await getDb().runTransaction(async (tx) => {
    if ((await tx.get(nameRef)).exists) throw usernameTaken;
    tx.set(nameRef, { userId: userRef.id });
    tx.set(userRef, userData);
});
```

### Reads are composed, not joined

`getManyByIds(collection, ids)` batches point reads through `getAll` in chunks,
returning a `Map`. Routes fetch the primary list, then resolve related documents
in one batch — rather than a query per row.

Frequently displayed fields are denormalised onto `payrollItems`
(`teacherName`, `employeeId`, `salaryScale`) so a payroll table needs no second
read, and so a historical payslip keeps the name it was issued under.

### Pagination uses cursors

The audit log orders by `createdAt desc` and pages with `startAfter(doc)`,
returning `nextCursor`. Each page requests `limit + 1` rows to determine
`hasMore` without a second query.

### Batch limits

Firestore allows 500 writes per batch. `commitInChunks(writes)` and
`deleteQueryBatched(query)` split work into chunks of 400, so a payroll run or
an account cleanup of any size completes.

### Collections

```
users/{id}
  username role fullName email phone
  password                       bcrypt hash, never returned
  isActive mustChangePassword passwordSetupCompleted
  tokenVersion                   session revocation counter
  mfaEnabled mfaMethod mfaSecret
  mfaPendingTokenHash mfaPendingCodeHash mfaPendingExpiresAt mfaPendingAttempts
  passwordSetupTokenHash passwordSetupExpiresAt
  createdAt updatedAt lastLoginAt passwordChangedAt
  deactivatedAt deactivatedBy deactivationReason

teachers/{id}
  userId employeeId fullName email phone position
  salaryScale dateJoined isActive leaveEntitlementDays
  payrollHalted payrollHaltReason payrollHaltedAt payrollHaltedBy
  paymentMethod bankName bankAccountName bankAccountNumber
  mobileMoneyProvider mobileMoneyNumber

salaryStructures/{scale}
  basicSalary housingAllowance transportAllowance medicalAllowance otherAllowance
  taxPercentage                  only used in flat tax mode
  nssfPercentage loanDeduction otherDeduction

payroll/{YYYY-MM}
  month year periodLabel status version employeeCount currency taxMode
  totalGross totalDeductions totalNet
  totalPaye totalNssfEmployee totalNssfEmployer totalEmployerCost
  processedBy processedByName processedAt
  approvedBy approvedByName approvedAt
  rejectedBy rejectionReason fullyPaidAt

payroll/{YYYY-MM}/versions/{n}
  a full copy of the superseded run, including its items

payrollItems/{id}
  payrollId version month year superseded
  teacherId teacherName employeeId salaryScale
  basicSalary contractualBasicSalary  abated vs contractual
  housingAllowance transportAllowance medicalAllowance otherAllowance grossSalary
  taxAmount nssfAmount nssfEmployerAmount loanDeduction
  advanceDeduction advanceDeferred advanceId
  unpaidLeaveDays unpaidLeaveDeduction otherDeduction
  totalDeductions netSalary employerCost
  paymentStatus paymentReference paidAt paidBy

leaveRequests/{id}
  teacherId teacherName employeeId leaveType startDate endDate days
  reason isUnpaid status decidedBy decidedByName decidedAt decisionNote

advanceRequests/{id}
  teacherId teacherName employeeId amount reason status
  requestedInstalments instalments amountRepaid instalmentsPaid
  approvedBy approvedAt rejectedBy decisionNote
  lastDeductedPayrollId lastDeductedAt settledAt

notifications/{id}   userId title message category severity link isRead createdAt readAt
auditLog/{id}        userId username role action details ipAddress createdAt
counters/{name}      value          transactional sequences
passwordResets/{hash} userId username expiresAt usedAt requestedIp
```

### Status values

| Entity | States |
|---|---|
| `payroll.status` | `processed` → `approved` → `paid`, or `rejected` |
| `payrollItems.paymentStatus` | `Pending`, `Paid` |
| `leaveRequests.status` | `Pending`, `Approved`, `Rejected`, `Cancelled` |
| `advanceRequests.status` | `Pending`, `Approved`, `Repaying`, `Settled`, `Rejected`, `Cancelled` |

---

## 5. Payroll processing

`POST /api/accountant/payroll/process` — the most involved operation.

```
1  Validate the period                      month 1–12, year 2000..now+1
2  Load the run at payroll/{YYYY-MM}        the id is the period
3  Refuse if already approved or paid       PAYROLL_LOCKED
4  Load eligible teachers                   isActive && !payrollHalted
5  Load every salary structure
6  Refuse if any teacher's scale is missing  before writing anything
7  Resolve advance instalments due
8  Resolve approved unpaid-leave days in the period
9  Compute every line in memory              a failure writes nothing
10 Archive the previous version              payroll/{id}/versions/{n}
11 Reverse its advance repayments            so nothing is double-counted
12 Flag its lines superseded: true           never deleted
13 Write the run at version n+1
14 Write the lines, recording each repayment
15 Notify HR that approval is pending
16 Audit
```

Steps 6 and 9 matter: the whole run is validated and calculated before the
first write, so a bad salary scale produces a clear 400 rather than a
half-written payroll.

### Versioning

Reprocessing supersedes rather than destroys. `GET /payroll/:id/versions`
returns the archive. Live queries filter `version == run.version`, and
superseded lines carry `superseded: true` so a teacher's payslip list and salary
history never show stale figures.

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
floor is what guarantees net pay cannot be driven to zero, and the deferred
remainder is shown on the payslip so the employee can see why less was taken.

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
| Nobody may approve a run they processed | `hr.js` — `processedBy === req.user.id` → `SELF_APPROVAL` |
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
npm test                                            # 76 tests, no credentials
npx firebase emulators:start --only firestore       # in another terminal
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm test     # 113 tests
```

| File | Covers |
|---|---|
| `tax.test.js` | Every PAYE band boundary, the 10 M surcharge, flat and disabled modes, NSSF split |
| `payroll-calculator.test.js` | Gross composition, unpaid-leave abatement, the net-pay floor, advance deferral, missing structures, run totals |
| `leave.test.js` | Inclusive day counts, month and year boundaries, range and window validation |
| `advances.test.js` | Ceilings, instalment arithmetic, the final-instalment remainder |
| `validate.test.js` | Every validator, including rejection of the old shared passwords and of `month 47 of 1823` |
| `escaping.test.js` | Real XSS payloads, attribute breakout, forged trust markers |
| `smoke.test.js` | Security headers, CSP without `unsafe-inline`, page serving, the auth gate, JSON 404s, body limits |
| `integration.test.js` | The whole workflow against real Firestore |

The integration suite wipes and seeds the emulator before running, so it is
repeatable, and refuses to run unless `FIRESTORE_EMULATOR_HOST` points at
localhost — it must never touch a real database.

---

## 10. Operational notes

### Required indexes

`firestore.indexes.json` declares 20 composite indexes. Without them several
dashboard queries fail with `FAILED_PRECONDITION`. Deploy with:

```bash
npx firebase deploy --only firestore:indexes
```

### Costs

Firestore bills per document read. The deliberate choices that reduce reads:
batched `getAll` instead of per-row queries, denormalised display fields on
payroll items, a 30-second config cache, a 30-second user cache in auth, and
`count()` aggregation queries for dashboard figures rather than fetching
documents to count them.

### Known limitation

`firebase-admin` depends on `google-gax`, which pins a `uuid` version carrying a
moderate advisory (`GHSA-w5hq-g745-h8pq`). The affected path is `uuid` v3/v5/v6
called with an explicit `buf` argument, which neither EduPay nor the Firebase
SDK does. Resolving it requires an upstream release; `npm audit` will continue
to report it.
