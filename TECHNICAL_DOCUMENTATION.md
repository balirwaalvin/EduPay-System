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

### Brand colours

EduPay has **two** brand colours. Everything else is a neutral or a status hue;
nothing else is "the brand".

| | Value | Role |
|---|---|---|
| **Primary — jade** | `#0E7F76` | The system's voice: primary actions, active navigation, brand surfaces, the logo tile |
| **Secondary — amber** | `#F59E0B` | Attention: counts waiting on someone, the net-pay rule on a payslip, secondary calls to action, the middle arm of the mark |

Jade rather than the previous red. Red is the universal signal for *error*, so a
red brand left the interface looking alarmed at rest, with nothing in reserve for
when something was genuinely wrong.

Each is a full ramp — `--primary-50` … `--primary-900`, `--secondary-50` …
`--secondary-700` — with shorthands components use instead of picking a step:

```css
--primary        --primary-deep   --primary-tint   --primary-line
--secondary      --secondary-deep --secondary-tint --secondary-line
```

Status hues are deliberately neither brand colour, so a brand surface is never
mistaken for a state — with one exception: **success is primary**. In a payroll
system "approved" and "paid" are the good case, and the brand should carry it.

Warning is orange rather than amber for the same reason. It began as the deep end
of the secondary ramp, which meant a cautionary control and a secondary-brand
control rendered in the *same colour* — plainly wrong the moment **Deactivate**
and **Resend link** appeared in one table row. A status hue must not be a brand
hue.

| Token | Value | Role |
|---|---|---|
| `--info` | `#4F46E5` | Informational |
| `--danger` | `#E11D48` | Destructive and error |
| `--warning` | `#C2410C` | Caution — its own orange, **not** the secondary ramp |
| `--ink-*` | cool slate ramp | Text and surfaces |
| `--canvas` | `#F2F5FA` | Page background |

#### Where the secondary actually appears

A secondary colour that only exists as a token is not implemented. It carries:

- `.btn-accent` and `.btn-accent-soft` — the second-most-wanted action on a
  screen, where a neutral button is too quiet and a second primary would compete
  with the real call to action. **Resend link** uses it: it unblocks someone who
  cannot sign in
- `.badge-accent`, and `.stat-card.accent-secondary`
- The notification count and the navigation badges — the things waiting on you
- The rule down the edge of the net-pay panel on every payslip

#### Retheming

Replace the two ramps in `:root` and the interface follows; no component
hardcodes a brand hex. Four places sit outside CSS because they cannot read a
custom property, and must be changed with it:

| File | Why |
|---|---|
| `server/services/brand.js` | PDFs, Excel and email are rendered server-side |
| `public/logo.svg`, `public/favicon.svg` | Standalone files |
| `public/site.webmanifest` | JSON |
| `<meta name="theme-color">` in each page | HTML meta takes no variable |

`brand.js` is the single source for everything the server draws, so payslips,
payroll exports and email all match the interface rather than drifting apart.

**The mark** is `public/logo.svg`: an E built from a stem and three arms, the
short middle one amber. The stem is load-bearing — three bars alone read as a
hamburger menu rather than a letter. It is referenced by the sidebar and the
sign-in panel, and `favicon.svg` is the same shape with heavier strokes so it
survives 16px.

**Browser and app icons** are a full set, not an SVG alone — Safari, Windows and
iOS each want something different:

| File | Purpose |
|---|---|
| `favicon.svg` | Modern browsers; scales to any tab size |
| `favicon.ico` | 16/32/48 in one file, for Safari, Windows and bookmarks |
| `apple-touch-icon.png` | 180×180, iOS home screen — square corners, since iOS applies its own mask |
| `icon-192.png`, `icon-512.png` | Installed-app icons, referenced by the manifest |
| `site.webmanifest` | Name, theme colour and the icon set |

`favicon.svg` is **not** `logo.svg` scaled down. It is drawn separately on a 32
grid with a heavier stroke, a larger mark relative to the tile, and a tighter
corner radius — at 16px a generous radius eats the corners and the shape turns to
mush. The tile stays solid jade so it holds against both light and dark tab bars.

Browsers cache favicons aggressively and often ignore a normal reload. A hard
refresh, or opening the icon URL directly once, is usually needed to see a change.

**Icons** are drawn SVG from `public/js/icons.js`, on a 24 grid at 1.8 stroke,
inheriting `currentColor`. There are no emoji anywhere in the interface: an emoji
is a coloured image that cannot take the brand colour, renders differently on
every operating system, and sits at an inconsistent optical weight beside type.

Markup declares an icon by name and the registry fills it in:

```html
<span class="nav-icon" data-icon="payroll" aria-hidden="true"></span>
<div class="stat-card accent-warning" data-icon="clock"> … </div>
```

`hydrateIcons()` runs on load and can be called again after rendering rows;
elements are marked `data-icon-done` so it never double-fills. Icon markup only
ever comes from the registry — a name is never interpolated into the output — so
nothing user-supplied can reach `innerHTML` through it. Every control carrying an
icon also carries a label or an `aria-label`, so the icons stay decorative.

**Layout.** The sidebar is a detached rounded card rather than an edge-to-edge
column, which keeps the page feeling like a set of surfaces instead of panels.
Each dashboard opens with a gradient hero carrying one headline figure, then
stat tiles with a tinted icon chip, then content cards.

**Row actions** are tinted rather than filled, and fill in on hover. Three solid
buttons on every row of a long table shouts, and makes it hard to see which
action is consequential.

**Wide tables** scroll horizontally with edge shadows painted via
`background-attachment`, so a clipped column reads as "there is more" rather
than as a broken layout — and it needs no script.

### Crowded tables: chips and a row menu

The staff list needed **1351px to show 1106px** of content. Three controls sat
off-screen and "Resend link" was cut in half. Two changes fixed it, and both
generalise to any table that outgrows its width:

**Collapse facts into chips.** *Two-factor* and *Status* were separate columns,
each holding one short badge. They became one `.chip-stack` cell carrying
`Active` · `2FA on` · `No password`. Seven columns became five.

**Collapse actions into a menu.** One action stays visible — the one people
actually use — and the rest move behind a `⋯` button. The staff row went from
six buttons (529px) to one button plus a 30px trigger.

The menu is a **`popover`**, which matters for a specific reason: `.table-wrap`
scrolls horizontally, and *a scroll container clips on both axes*, so an
absolutely-positioned menu would be cut off at the table's edge. A popover
renders in the top layer and escapes that entirely. It also brings light
dismiss and Escape handling with it, for free.

What the popover does **not** bring is position — the top layer has no idea
where the trigger is, so the browser centres it in the viewport.
`positionRowMenu()` in `app.js` places it, flipping above the trigger when it
would run off the bottom (which it will for the last rows of a long table), and
clamping to the viewport on both axes. One delegated `toggle` listener covers
every menu on the page, including rows that do not exist yet.

Menus close on resize and on scroll (captured, because the scrolling element is
often the table wrapper rather than the window) — a menu pinned to a point on
screen has to go when that point moves.

Two things to keep in mind when applying this elsewhere:

- **Icons inside rendered rows need re-hydrating.** `hydrateIcons()` runs at
  `DOMContentLoaded`, but rows are built later and again on every search, sort
  and page turn, so `icons.js` also listens for `table:rendered`. Without it a
  `data-icon` inside a row stays blank.
- **Event delegation still works.** A popover is rendered in the top layer but
  remains a DOM descendant of the row, so a `tbody` click handler still
  receives its items. No rewiring was needed.

Destructive items sit below a `.row-menu-sep` rule and carry `.is-danger`, so
Delete is never what a hurried click lands on.

**Applied twice so far.** Admin → Staff accounts (7 columns, 6 buttons) and HR →
Teachers (7 columns, 3 buttons). The other tables were measured and left alone:
Salary structures, Payroll approval, Leave and Advances all fit, and their
Approve/Reject pairs are *primary* actions that belong in the open, not behind a
menu. The pattern is for crowding, not for uniformity.

HR → Teachers needed two things the staff table did not:

- **`humanise()`** for the salary scale. `Teaching_Assistant` has no break
  opportunity, so the longest value held the column open at 156px to display
  "Scale 2". Showing it as "Teaching Assistant" lets it wrap, and the column
  fell to 95px. The stored value is untouched; `matchesSearch` flattens
  underscores on both sides so either spelling finds it.
- **A column drop below 1200px.** Seven columns of real content cannot fit a
  794px container. Position is the one hidden: it is free text, payroll is
  calculated from Scale rather than from it, and it is still on the edit form.
  The contact address truncates with the full value on `title`.

### Stat tiles are coloured by meaning

A tile's colour states what kind of figure it is, so a dashboard can be scanned
before it is read. There are six, and each has exactly one job:

| Class | Hue | Means | Example |
|---|---|---|---|
| *(none)* | jade | The headline figure, money that moved, the healthy state | Total paid out |
| `accent-pending` | amber | Waiting on a person to decide | Payroll to approve |
| `accent-attention` | orange | Something is broken and needs fixing | Not yet activated |
| `accent-info` | violet | A plain count, no action implied | Accountants |
| `accent-danger` | rose | Failed, rejected, overdue | — |
| `accent-neutral` | grey | A historical total carrying no status | Payroll runs |

Each accent sets four custom properties and the base `.stat-card` rule consumes
them:

```css
.stat-card.accent-pending {
  --card-tint: var(--secondary-50);   /* card background */
  --card-line: var(--secondary-100);  /* border          */
  --card-chip: var(--secondary-100);  /* icon chip       */
  --card-ink:  var(--secondary-700);  /* icon + figure   */
}
```

So adding an accent is four lines, and no accent can be half-applied — the
background, border, chip, figure and hover bar cannot drift apart, because they
all derive from the same four values.

**Only the chip and the figure take the hue.** Labels and hints stay neutral;
colouring those too turns the tile into a block of colour and costs more
legibility than it buys meaning.

Three constraints worth keeping:

- **`.stat-label` and `.stat-hint` use `--ink-600`, not `--text-muted`.** The
  muted grey was chosen against white and measures only 4.2:1 on the tints —
  below AA. `--ink-600` measures at worst 6.5:1. If you add a tint, re-check it.
- **Every accent clears AA on both text roles** (figure and label). The figures
  run 4.8–11.2:1.
- **`accent-attention` is the only accent at the `100` tint rather than `50`.**
  At `50` its background sat 14 perceptual units from the amber of
  `accent-pending` — indistinguishable — and those two must never be confused:
  one means somebody has yet to decide, the other means something is broken. At
  `100` the separation is 67. Its figure uses `--orange-800` because `700` does
  not clear AA on the deeper tint.

`accent-success` and `accent-warning` are kept as aliases of the jade default
and of `accent-attention`, so older markup still renders correctly.

### Scrollbars, and why the two engines are handled separately

The scrollbar is chrome people look at all day, so it carries the brand: a jade
pill floating in a transparent track, achieved with `border: 3px solid
transparent` plus `background-clip: padding-box`, which insets the thumb instead
of letting it sit flush against the edge.

There are two mechanisms for this and **they are mutually exclusive**:

| | Mechanism | Engines |
|---|---|---|
| `::-webkit-scrollbar-*` | Full control: size, inset, radius, hover colour | Chrome, Edge, Safari |
| `scrollbar-width` / `scrollbar-color` | Colour and a coarse width only | Firefox (and Chrome 121+) |

Blink ignores **every** `::-webkit-scrollbar` rule on any element that also sets
`scrollbar-width` or `scrollbar-color`. So the obvious thing — declaring both
globally and calling it progressive enhancement — silently throws the designed
scrollbar away in Chrome and leaves the plain one. The standard properties are
therefore gated:

```css
@supports (scrollbar-width: thin) and (not selector(::-webkit-scrollbar)) { … }
```

which is true only in Firefox. **Do not move those declarations out of that
block,** and do not add `scrollbar-width`/`scrollbar-color` to a component rule
outside it — either change disables the WebKit styling for that element.

Three treatments: the page scrollbar sits on the canvas so it is a step darker;
the sidebar's stays invisible until the sidebar is hovered, because a scrollbar
parked beside navigation is noise; a table's horizontal bar keeps a visible
track, because there it is also the signal that more columns exist.

### Browser-drawn controls, and dropdowns

Some of the interface is drawn by the browser rather than by this stylesheet:
`<select>` popups, date pickers, checkboxes, radios, the scrollbar gutter. Three
things keep those on-brand.

**`color-scheme: light`.** The dashboards previously sent
`<meta name="color-scheme" content="dark light">`, which tells the browser the
page supports dark mode. On a dark-mode OS it then drew every one of those
controls dark — a black dropdown on a white page. EduPay is a light-mode
product, so all eight pages declare `light`, and `:root` declares it too, so a
page added without the meta still behaves.

**`accent-color: var(--primary)`** on `:root`. One line; it is what turns
checkboxes, radios, range and progress from the browser's blue to jade.

**The dropdown list** is the hard one, because a `<select>`'s popup is not part
of the page. There are two layers:

- *Fallback, everywhere:* `option` and `option:checked` colours, which most
  platforms honour, on a popup that `color-scheme` has already made light.
- *`appearance: base-select`:* replaces the browser-drawn popup with a real
  element the page can style — so `::picker(select)` gets the same surface,
  border, radius and shadow as every other floating panel, options get the jade
  tint on hover, focus and selection, `::checkmark` becomes the brand's check
  icon, and `select:open::picker-icon` flips the chevron.

The whole second layer sits behind `@supports (appearance: base-select)`. Where
it is unsupported the block is skipped and the fallback shows — so this degrades
rather than breaks. Note that `base-select` discards the control's own
appearance, which is why the field is redrawn inside that block and the chevron
moves from a `background-image` to `::picker-icon`.

### Collapsing the sidebar

The sidebar has two behaviours that must never overlap:

- **Above 860px** it is a permanent column. `body.nav-collapsed` narrows it to a
  76px icon rail, and the preference persists in `localStorage`
  (`edupay.navCollapsed`).
- **At 860px and below** it is a drawer that slides over the content, driven by
  `.open`.

Collapsing is a **single token change** — `body.nav-collapsed` sets
`--sidebar-width: 76px`, and because every width, margin and offset already
derives from that token, nothing else needs a parallel layout. The rest of the
rules only hide labels.

Two things that are easy to get wrong, both of which this code has hit:

- The rail rules are wrapped in `@media (min-width: 861px)`. Without that guard
  they apply to the mobile drawer too, turning it into icons with no way to read
  them.
- **The collapse control must stay visible while collapsed.** Hiding it in the
  rail is a one-way door: collapse once and the only way back is clearing
  storage. In the rail the header becomes a column and the control moves beneath
  the mark.

Labels are hidden with `font-size: 0` rather than `display: none`, so the text
can transition to nothing as the rail narrows, and so the logo's `::before` —
which has its own fixed size — is untouched.

Because `.sidebar-nav` scrolls, and a scroll container clips on **both** axes, a
tooltip drawn as a pseudo-element on a nav item would be cut off at the rail's
edge. The rail tooltip is therefore one shared `.rail-tip` node on `<body>`,
positioned from script. A pending count moves into the tooltip, since the badge
is only a dot at 76px.

### Motion

Two rules govern all of it.

**Motion explains, it does not decorate.** A section's blocks rise in the order
you read them; a table's rows arrive in sequence; the one looping animation in
the system is the pending-badge pulse, which is tracking work that genuinely
still needs a decision. Where motion had nothing to say, there is none — which
is also why `loadingRow()` renders skeleton rows at the size of real ones
rather than a spinner, so the table does not jump when the data lands.

**It happens once and gets out of the way.** Entrances are 280–380ms and do not
repeat. Nothing animates layout — every keyframe touches only `transform`,
`opacity`, `box-shadow` or `background`, so none of it triggers reflow.

Ordering comes from JS, shape from CSS: `staggerSection()` and `staggerRows()`
set `--i` on each element, and one rule turns it into a delay:

```css
animation-delay: calc(var(--i, 0) * 45ms);
```

Row stagger is capped at 12 (`STAGGER_ROW_CAP`); past that the stagger stops
being life and becomes a wait.

`prefers-reduced-motion: reduce` flattens every animation and transition to
~0ms, and the JS checks it too via `prefersReducedMotion()` — the CSS media
query cannot reach the `--i` values we set from script.

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
reason — `.sk-w1`…`.sk-w5` for skeleton widths, for instance.

**This is easy to trip over.** `style-src 'self'` blocks `style` attributes, so
any markup built in JS with `style="…"` is silently dropped — the element still
renders, just without the style, which looks like a CSS bug rather than a policy
one. Emit a class instead. Setting a property through CSSOM
(`el.style.setProperty('--i', …)`, which is how the motion stagger works) is
**not** affected, because CSP governs parsing inline style text, not the object
model.

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

These are the passwords the **seeder** sets. Changing one in the UI — or using
Staff Accounts → Reset password, which issues a random temporary one shown only
once — makes that account diverge, and the table above stops being true for it.
`node scripts/seed-demo.js` puts everything back.

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
