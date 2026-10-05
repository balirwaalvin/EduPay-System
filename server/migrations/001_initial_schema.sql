-- ===========================================================================
-- EduPay initial schema
--
-- Several guards that would otherwise live only in application code are
-- expressed as constraints here, which makes them race-free and impossible to
-- bypass: one structure per salary scale, one payroll run per period, no
-- overlapping leave, one open advance per teacher, net pay never negative, and
-- the processor of a payroll run never also its approver.
--
-- Money is NUMERIC(14,2) — exact decimal. Never use float for currency.
-- ===========================================================================

-- Needed for the exclusion constraint that prevents overlapping leave.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id                        BIGSERIAL PRIMARY KEY,

    -- A real uniqueness constraint. The previous build needed a separate
    -- reservation collection and a transaction to approximate this.
    username                  TEXT        NOT NULL UNIQUE,
    password_hash             TEXT        NOT NULL,
    role                      TEXT        NOT NULL
                                  CHECK (role IN ('admin', 'hr', 'accountant', 'teacher')),
    full_name                 TEXT        NOT NULL CHECK (length(btrim(full_name)) >= 2),
    email                     TEXT        CHECK (email IS NULL OR email = lower(email)),
    phone                     TEXT,

    is_active                 BOOLEAN     NOT NULL DEFAULT TRUE,
    must_change_password      BOOLEAN     NOT NULL DEFAULT TRUE,
    password_setup_completed  BOOLEAN     NOT NULL DEFAULT FALSE,

    -- Incremented to revoke every token already issued for this account.
    token_version             INTEGER     NOT NULL DEFAULT 0,

    mfa_enabled               BOOLEAN     NOT NULL DEFAULT FALSE,
    mfa_method                TEXT        NOT NULL DEFAULT 'email'
                                  CHECK (mfa_method IN ('email', 'authenticator')),
    mfa_secret                TEXT,
    mfa_pending_token_hash    TEXT,
    mfa_pending_code_hash     TEXT,
    mfa_pending_expires_at    TIMESTAMPTZ,
    mfa_pending_attempts      INTEGER     NOT NULL DEFAULT 0 CHECK (mfa_pending_attempts >= 0),
    mfa_last_sent_at          TIMESTAMPTZ,

    password_setup_token_hash TEXT,
    password_setup_expires_at TIMESTAMPTZ,

    created_by                BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    deactivated_at            TIMESTAMPTZ,
    deactivated_by            BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    deactivation_reason       TEXT,
    reactivated_at            TIMESTAMPTZ,
    reactivated_by            BIGINT      REFERENCES users (id) ON DELETE SET NULL,

    last_login_at             TIMESTAMPTZ,
    last_logout_at            TIMESTAMPTZ,
    password_changed_at       TIMESTAMPTZ,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Email lookups for the password-reset flow.
CREATE INDEX users_email_idx ON users (email) WHERE email IS NOT NULL;
CREATE INDEX users_role_active_idx ON users (role, is_active);
CREATE INDEX users_created_at_idx ON users (created_at DESC);

-- Partial indexes for the token lookups, which are sparse.
CREATE INDEX users_setup_token_idx ON users (password_setup_token_hash)
    WHERE password_setup_token_hash IS NOT NULL;
CREATE INDEX users_mfa_pending_idx ON users (mfa_pending_expires_at)
    WHERE mfa_pending_expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Salary structures
--
-- The scale name is the primary key, so a scale can only ever have one
-- structure. The previous schema had no unique constraint while the insert used
-- ON CONFLICT (salary_scale), which made every save fail.
-- ---------------------------------------------------------------------------
CREATE TABLE salary_structures (
    salary_scale        TEXT          PRIMARY KEY
                            CHECK (salary_scale ~ '^[A-Za-z0-9][A-Za-z0-9 _-]*$'),

    basic_salary        NUMERIC(14,2) NOT NULL CHECK (basic_salary >= 0),
    housing_allowance   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (housing_allowance >= 0),
    transport_allowance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (transport_allowance >= 0),
    medical_allowance   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (medical_allowance >= 0),
    other_allowance     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (other_allowance >= 0),

    -- Only consulted in legacy 'flat' tax mode; banded PAYE ignores it.
    tax_percentage      NUMERIC(5,2)  NOT NULL DEFAULT 0
                            CHECK (tax_percentage BETWEEN 0 AND 100),
    nssf_percentage     NUMERIC(5,2)  NOT NULL DEFAULT 5
                            CHECK (nssf_percentage BETWEEN 0 AND 30),
    loan_deduction      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (loan_deduction >= 0),
    other_deduction     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (other_deduction >= 0),

    updated_by          BIGINT        REFERENCES users (id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Teachers
-- ---------------------------------------------------------------------------
CREATE TABLE teachers (
    id                     BIGSERIAL PRIMARY KEY,

    -- One teacher record per login account.
    user_id                BIGINT      NOT NULL UNIQUE
                               REFERENCES users (id) ON DELETE CASCADE,
    employee_id            TEXT        NOT NULL UNIQUE,

    full_name              TEXT        NOT NULL,
    email                  TEXT,
    phone                  TEXT,
    position               TEXT,

    -- A foreign key means a teacher can never reference a scale that does not
    -- exist, and a scale in use cannot be deleted. Both were application checks.
    salary_scale           TEXT        NOT NULL
                               REFERENCES salary_structures (salary_scale)
                               ON UPDATE CASCADE ON DELETE RESTRICT,

    date_joined            DATE        NOT NULL DEFAULT CURRENT_DATE,
    is_active              BOOLEAN     NOT NULL DEFAULT TRUE,
    leave_entitlement_days INTEGER     NOT NULL DEFAULT 21
                               CHECK (leave_entitlement_days BETWEEN 0 AND 365),

    payroll_halted         BOOLEAN     NOT NULL DEFAULT FALSE,
    payroll_halt_reason    TEXT,
    payroll_halted_at      TIMESTAMPTZ,
    payroll_halted_by      BIGINT      REFERENCES users (id) ON DELETE SET NULL,

    payment_method         TEXT        NOT NULL DEFAULT 'bank'
                               CHECK (payment_method IN ('bank', 'mobile_money')),
    bank_name              TEXT,
    bank_account_name      TEXT,
    bank_account_number    TEXT,
    mobile_money_provider  TEXT,
    mobile_money_number    TEXT,

    -- A paused teacher must always carry a reason.
    CONSTRAINT teachers_halt_reason_required
        CHECK (NOT payroll_halted OR payroll_halt_reason IS NOT NULL),

    created_by             BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX teachers_active_idx ON teachers (is_active);
CREATE INDEX teachers_eligible_idx ON teachers (is_active, payroll_halted);
CREATE INDEX teachers_scale_idx ON teachers (salary_scale);
CREATE INDEX teachers_name_idx ON teachers (full_name);

-- ---------------------------------------------------------------------------
-- Accountants
-- ---------------------------------------------------------------------------
CREATE TABLE accountants (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT      NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
    employee_id TEXT        NOT NULL UNIQUE,
    full_name   TEXT        NOT NULL,
    email       TEXT,
    phone       TEXT,
    department  TEXT,
    date_joined DATE        NOT NULL DEFAULT CURRENT_DATE,
    is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Payroll runs
-- ---------------------------------------------------------------------------
CREATE TABLE payroll (
    id                   BIGSERIAL PRIMARY KEY,

    month                SMALLINT      NOT NULL CHECK (month BETWEEN 1 AND 12),
    year                 SMALLINT      NOT NULL CHECK (year BETWEEN 2000 AND 2100),

    status               TEXT          NOT NULL DEFAULT 'processed'
                             CHECK (status IN ('processed', 'approved', 'paid', 'rejected')),
    version              INTEGER       NOT NULL DEFAULT 1 CHECK (version >= 1),
    employee_count       INTEGER       NOT NULL DEFAULT 0 CHECK (employee_count >= 0),
    currency             TEXT          NOT NULL DEFAULT 'UGX',
    tax_mode             TEXT          NOT NULL DEFAULT 'banded',

    total_gross          NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (total_gross >= 0),
    total_deductions     NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (total_deductions >= 0),
    total_net            NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (total_net >= 0),
    total_paye           NUMERIC(16,2) NOT NULL DEFAULT 0,
    total_nssf_employee  NUMERIC(16,2) NOT NULL DEFAULT 0,
    total_nssf_employer  NUMERIC(16,2) NOT NULL DEFAULT 0,
    total_employer_cost  NUMERIC(16,2) NOT NULL DEFAULT 0,

    processed_by         BIGINT        REFERENCES users (id) ON DELETE SET NULL,
    processed_by_name    TEXT,
    processed_at         TIMESTAMPTZ,
    approved_by          BIGINT        REFERENCES users (id) ON DELETE SET NULL,
    approved_by_name     TEXT,
    approved_at          TIMESTAMPTZ,
    rejected_by          BIGINT        REFERENCES users (id) ON DELETE SET NULL,
    rejected_by_name     TEXT,
    rejected_at          TIMESTAMPTZ,
    rejection_reason     TEXT,
    fully_paid_at        TIMESTAMPTZ,

    created_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),

    -- One run per period. Two accountants pressing Process at the same moment
    -- can no longer create duplicates; the second attempt fails on this.
    CONSTRAINT payroll_period_unique UNIQUE (month, year),

    -- Separation of duties, enforced by the database: whoever processed a run
    -- can never be recorded as its approver.
    CONSTRAINT payroll_processor_is_not_approver
        CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM processed_by),

    -- An approved or paid run must record the approval. The approver's NAME is
    -- the durable record and is required; the foreign key is a convenience that
    -- must be allowed to go null if that account is later deleted, otherwise
    -- ON DELETE SET NULL would collide with this constraint and make the
    -- deletion fail outright.
    CONSTRAINT payroll_approval_complete
        CHECK (status NOT IN ('approved', 'paid')
               OR (approved_at IS NOT NULL AND approved_by_name IS NOT NULL)),

    -- A returned run must say why.
    CONSTRAINT payroll_rejection_has_reason
        CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)
);

CREATE INDEX payroll_period_idx ON payroll (year DESC, month DESC);
CREATE INDEX payroll_status_idx ON payroll (status);

-- Archived superseded runs. The snapshot is a document, so JSONB is the right
-- type: it is never queried field by field, only read back whole.
CREATE TABLE payroll_versions (
    payroll_id    BIGINT      NOT NULL REFERENCES payroll (id) ON DELETE CASCADE,
    version       INTEGER     NOT NULL,
    snapshot      JSONB       NOT NULL,
    superseded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    superseded_by BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    PRIMARY KEY (payroll_id, version)
);

-- ---------------------------------------------------------------------------
-- Payroll lines
-- ---------------------------------------------------------------------------
CREATE TABLE payroll_items (
    id                        BIGSERIAL PRIMARY KEY,

    payroll_id                BIGINT        NOT NULL
                                  REFERENCES payroll (id) ON DELETE CASCADE,

    -- RESTRICT, not CASCADE: a teacher who appears on a payroll run cannot be
    -- deleted, because that would destroy financial history.
    teacher_id                BIGINT        NOT NULL
                                  REFERENCES teachers (id) ON DELETE RESTRICT,

    version                   INTEGER       NOT NULL DEFAULT 1,
    superseded                BOOLEAN       NOT NULL DEFAULT FALSE,
    month                     SMALLINT      NOT NULL,
    year                      SMALLINT      NOT NULL,

    -- Denormalised so a historical payslip keeps the name it was issued under.
    teacher_name              TEXT          NOT NULL,
    employee_id               TEXT          NOT NULL,
    salary_scale              TEXT          NOT NULL,

    basic_salary              NUMERIC(14,2) NOT NULL CHECK (basic_salary >= 0),
    contractual_basic_salary  NUMERIC(14,2) NOT NULL CHECK (contractual_basic_salary >= 0),
    housing_allowance         NUMERIC(14,2) NOT NULL DEFAULT 0,
    transport_allowance       NUMERIC(14,2) NOT NULL DEFAULT 0,
    medical_allowance         NUMERIC(14,2) NOT NULL DEFAULT 0,
    other_allowance           NUMERIC(14,2) NOT NULL DEFAULT 0,
    gross_salary              NUMERIC(14,2) NOT NULL CHECK (gross_salary >= 0),

    tax_amount                NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
    nssf_amount               NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (nssf_amount >= 0),
    nssf_employer_amount      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (nssf_employer_amount >= 0),
    loan_deduction            NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (loan_deduction >= 0),
    advance_deduction         NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (advance_deduction >= 0),
    advance_deferred          NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (advance_deferred >= 0),
    advance_id                BIGINT,
    unpaid_leave_days         INTEGER       NOT NULL DEFAULT 0 CHECK (unpaid_leave_days >= 0),
    unpaid_leave_deduction    NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (unpaid_leave_deduction >= 0),
    other_deduction           NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (other_deduction >= 0),
    total_deductions          NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total_deductions >= 0),

    -- Net pay can never be negative. Previously an oversized advance could
    -- produce a negative payslip; now the database itself forbids it.
    net_salary                NUMERIC(14,2) NOT NULL CHECK (net_salary >= 0),
    employer_cost             NUMERIC(14,2) NOT NULL DEFAULT 0,

    payment_status            TEXT          NOT NULL DEFAULT 'Pending'
                                  CHECK (payment_status IN ('Pending', 'Paid')),
    payment_reference         TEXT,
    paid_at                   TIMESTAMPTZ,
    paid_by                   BIGINT        REFERENCES users (id) ON DELETE SET NULL,

    created_at                TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ   NOT NULL DEFAULT now(),

    -- One line per teacher per run version.
    CONSTRAINT payroll_items_unique UNIQUE (payroll_id, teacher_id, version),

    -- The arithmetic must be internally consistent, to one cent.
    CONSTRAINT payroll_items_net_consistent
        CHECK (abs(net_salary - (gross_salary - total_deductions)) < 0.01),

    -- A paid line must record when it was paid. As above, paid_by is allowed to
    -- go null if the account that recorded it is deleted.
    CONSTRAINT payroll_items_payment_complete
        CHECK (payment_status <> 'Paid' OR paid_at IS NOT NULL)
);

CREATE INDEX payroll_items_run_idx ON payroll_items (payroll_id, version);
CREATE INDEX payroll_items_teacher_idx ON payroll_items (teacher_id) WHERE NOT superseded;
CREATE INDEX payroll_items_pending_idx ON payroll_items (payroll_id, version)
    WHERE payment_status = 'Pending';

-- ---------------------------------------------------------------------------
-- Leave
-- ---------------------------------------------------------------------------
CREATE TABLE leave_requests (
    id            BIGSERIAL PRIMARY KEY,

    teacher_id    BIGINT      NOT NULL REFERENCES teachers (id) ON DELETE CASCADE,
    teacher_name  TEXT        NOT NULL,
    employee_id   TEXT        NOT NULL,

    leave_type    TEXT        NOT NULL
                      CHECK (leave_type IN ('Annual', 'Sick', 'Maternity', 'Paternity',
                                            'Compassionate', 'Study', 'Unpaid')),
    start_date    DATE        NOT NULL,
    end_date      DATE        NOT NULL,

    -- Derived by the database, so the stored count can never drift from the dates.
    days          INTEGER     NOT NULL GENERATED ALWAYS AS (end_date - start_date + 1) STORED,

    reason        TEXT        NOT NULL CHECK (length(btrim(reason)) >= 3),
    is_unpaid     BOOLEAN     NOT NULL DEFAULT FALSE,

    status        TEXT        NOT NULL DEFAULT 'Pending'
                      CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Cancelled')),
    decided_by      BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    decided_by_name TEXT,
    decided_at      TIMESTAMPTZ,
    decision_note   TEXT,
    cancelled_at    TIMESTAMPTZ,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- The end date can never precede the start date. The old code accepted it.
    CONSTRAINT leave_dates_ordered CHECK (end_date >= start_date),
    CONSTRAINT leave_length_sane   CHECK (end_date - start_date < 120),

    -- Overlapping leave is impossible, enforced by the database rather than by a
    -- read-then-write check that two concurrent requests could both pass.
    CONSTRAINT leave_no_overlap
        EXCLUDE USING gist (
            teacher_id WITH =,
            daterange(start_date, end_date, '[]') WITH &&
        ) WHERE (status IN ('Pending', 'Approved'))
);

CREATE INDEX leave_teacher_idx ON leave_requests (teacher_id, created_at DESC);
CREATE INDEX leave_status_idx ON leave_requests (status, created_at DESC);
CREATE INDEX leave_unpaid_period_idx ON leave_requests (teacher_id, start_date, end_date)
    WHERE status = 'Approved' AND is_unpaid;

-- ---------------------------------------------------------------------------
-- Salary advances
-- ---------------------------------------------------------------------------
CREATE TABLE advance_requests (
    id                       BIGSERIAL PRIMARY KEY,

    teacher_id               BIGINT        NOT NULL REFERENCES teachers (id) ON DELETE CASCADE,
    teacher_name             TEXT          NOT NULL,
    employee_id              TEXT          NOT NULL,

    amount                   NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    reason                   TEXT          NOT NULL CHECK (length(btrim(reason)) >= 3),

    requested_instalments    INTEGER       NOT NULL DEFAULT 1
                                 CHECK (requested_instalments BETWEEN 1 AND 24),
    instalments              INTEGER       NOT NULL DEFAULT 1
                                 CHECK (instalments BETWEEN 1 AND 24),
    amount_repaid            NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount_repaid >= 0),
    instalments_paid         INTEGER       NOT NULL DEFAULT 0 CHECK (instalments_paid >= 0),

    status                   TEXT          NOT NULL DEFAULT 'Pending'
                                 CHECK (status IN ('Pending', 'Approved', 'Repaying',
                                                   'Settled', 'Rejected', 'Cancelled')),

    approved_by              BIGINT        REFERENCES users (id) ON DELETE SET NULL,
    approved_at              TIMESTAMPTZ,
    rejected_by              BIGINT        REFERENCES users (id) ON DELETE SET NULL,
    rejected_at              TIMESTAMPTZ,
    decision_note            TEXT,
    last_deducted_payroll_id BIGINT        REFERENCES payroll (id) ON DELETE SET NULL,
    last_deducted_at         TIMESTAMPTZ,
    settled_at               TIMESTAMPTZ,
    cancelled_at             TIMESTAMPTZ,

    created_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),

    -- An advance can never be over-repaid.
    CONSTRAINT advance_not_over_repaid CHECK (amount_repaid <= amount),
    CONSTRAINT advance_instalments_consistent CHECK (instalments_paid <= instalments)
);

-- One open advance per teacher, enforced by a partial unique index rather than
-- by a check the application performs before inserting.
CREATE UNIQUE INDEX advance_one_open_per_teacher
    ON advance_requests (teacher_id)
    WHERE status IN ('Pending', 'Approved', 'Repaying');

CREATE INDEX advance_teacher_idx ON advance_requests (teacher_id, created_at DESC);
CREATE INDEX advance_status_idx ON advance_requests (status, created_at DESC);

-- payroll_items.advance_id is declared above; add the reference now that
-- advance_requests exists.
ALTER TABLE payroll_items
    ADD CONSTRAINT payroll_items_advance_fk
    FOREIGN KEY (advance_id) REFERENCES advance_requests (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title      TEXT        NOT NULL,
    message    TEXT        NOT NULL,
    category   TEXT        NOT NULL DEFAULT 'system'
                   CHECK (category IN ('leave', 'advance', 'payroll', 'payment',
                                       'account', 'system')),
    severity   TEXT        NOT NULL DEFAULT 'info'
                   CHECK (severity IN ('info', 'success', 'warning', 'error')),
    link       TEXT,
    actor_id   BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    is_read    BOOLEAN     NOT NULL DEFAULT FALSE,
    read_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE NOT is_read;

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
    id           BIGSERIAL PRIMARY KEY,

    -- SET NULL, not CASCADE: the trail survives the deletion of the account.
    user_id      BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    username     TEXT        NOT NULL DEFAULT 'system',
    role         TEXT,
    action       TEXT        NOT NULL,
    details      TEXT,
    ip_address   TEXT,
    user_deleted BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_action_idx ON audit_log (action, created_at DESC);
CREATE INDEX audit_username_idx ON audit_log (username, created_at DESC);

-- ---------------------------------------------------------------------------
-- System configuration — one row per setting
-- ---------------------------------------------------------------------------
CREATE TABLE system_config (
    config_key   TEXT        PRIMARY KEY,
    config_value JSONB       NOT NULL,
    updated_by   BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Single-use password reset tokens
-- ---------------------------------------------------------------------------
CREATE TABLE password_resets (
    token_hash   TEXT        PRIMARY KEY,
    user_id      BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    username     TEXT        NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    used_at      TIMESTAMPTZ,
    requested_ip TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX password_resets_user_idx ON password_resets (user_id);
CREATE INDEX password_resets_expiry_idx ON password_resets (expires_at);

-- ---------------------------------------------------------------------------
-- Employee-id sequences, one per role
-- ---------------------------------------------------------------------------
CREATE TABLE counters (
    name       TEXT        PRIMARY KEY,
    value      BIGINT      NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Keep updated_at honest without every UPDATE having to remember.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['users', 'salary_structures', 'teachers', 'accountants',
                             'payroll', 'payroll_items', 'leave_requests', 'advance_requests']
    LOOP
        EXECUTE format(
            'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
    END LOOP;
END $$;
