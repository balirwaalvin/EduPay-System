const express = require('express');
const router = express.Router();

const db = require('../db');
const {
    authenticateToken, authorizeRoles, requirePasswordChanged,
    asyncHandler, HttpError, emailLimiter
} = require('../middleware');
const v = require('../services/validate');
const accounts = require('../services/accounts');
const configService = require('../services/config');
const leaveService = require('../services/leave');
const advanceService = require('../services/advances');
const notify = require('../services/notifications');
const { logAudit } = require('../services/audit');

router.use(authenticateToken, authorizeRoles('hr', 'admin'), requirePasswordChanged);

const PAYMENT_METHODS = ['bank', 'mobile_money'];

/** Read and validate the payment-destination fields for a teacher. */
function readPaymentDetails(body, { required = false } = {}) {
    const supplied = body.paymentMethod ?? body.payment_method;
    if (supplied === undefined) {
        if (required) throw new HttpError(400, 'A payment method is required.', 'PAYMENT_METHOD_REQUIRED');
        return null;
    }

    const method = v.oneOf(supplied, PAYMENT_METHODS, 'Payment method');

    if (method === 'mobile_money') {
        return {
            paymentMethod: method,
            mobileMoneyProvider: v.str(body.mobileMoneyProvider ?? body.mobile_money_provider,
                'Mobile money provider', { required, max: 60 }) || '',
            mobileMoneyNumber: v.str(body.mobileMoneyNumber ?? body.mobile_money_number,
                'Mobile money number', { required, max: 32 }) || '',
            bankName: null, bankAccountName: null, bankAccountNumber: null
        };
    }

    return {
        paymentMethod: method,
        bankName: v.str(body.bankName ?? body.bank_name, 'Bank name', { required, max: 80 }) || '',
        bankAccountName: v.str(body.bankAccountName ?? body.bank_account_name,
            'Account name', { required, max: 80 }) || '',
        bankAccountNumber: v.str(body.bankAccountNumber ?? body.bank_account_number,
            'Account number', { required, max: 40 }) || '',
        mobileMoneyProvider: null, mobileMoneyNumber: null
    };
}

// ===========================================================================
// Teachers
// ===========================================================================

router.get('/teachers', asyncHandler(async (req, res) => {
    const includeInactive = v.bool(req.query.includeInactive, false);

    res.json(await db.query(
        `SELECT t.*, u.username,
                u.is_active AS account_active,
                (NOT u.password_setup_completed) AS activation_pending
           FROM teachers t
           JOIN users u ON u.id = t.user_id
          WHERE ($1::boolean OR t.is_active)
          ORDER BY t.full_name`,
        [includeInactive]
    ));
}));

/** Derive an available username from a person's name. */
async function suggestUsername(fullName, client = null) {
    const base = String(fullName).toLowerCase().trim()
        .replace(/[^a-z\s]/g, '')
        .replace(/\s+/g, '.')
        .slice(0, 28) || 'staff';

    // One query finds every taken variant, instead of probing one at a time.
    const taken = new Set((await db.query(
        'SELECT username FROM users WHERE username = $1 OR username LIKE $1 || \'%\'',
        [base], client
    )).map(row => row.username));

    if (!taken.has(base)) return base;
    for (let n = 1; n < 100; n++) {
        if (!taken.has(`${base}${n}`)) return `${base}${n}`;
    }
    return `${base}.${Date.now().toString(36).slice(-4)}`;
}

router.post('/teachers', asyncHandler(async (req, res) => {
    const fullName = v.str(req.body.fullName ?? req.body.full_name, 'Full name', { min: 2, max: 120 });
    const salaryScale = v.str(req.body.salaryScale ?? req.body.salary_scale, 'Salary scale', { max: 60 });
    const emailAddress = v.email(req.body.email, 'Email', { required: false });
    const phone = v.str(req.body.phone, 'Phone', { required: false, max: 32 });
    const position = v.str(req.body.position, 'Position', { required: false, max: 80 });
    const dateJoined = v.isoDate(req.body.dateJoined ?? req.body.date_joined, 'Date joined', { required: false })
        || new Date().toISOString().slice(0, 10);
    const entitlement = v.num(req.body.leaveEntitlementDays, 'Leave entitlement',
        { required: false, min: 0, max: 365, integer: true });

    const payment = readPaymentDetails(req.body) || { paymentMethod: 'bank' };
    const config = await configService.getConfig();

    // The teachers.salary_scale foreign key means an unknown scale is rejected by
    // the database; this check only exists to phrase the error better.
    const structure = await db.queryOne(
        'SELECT salary_scale FROM salary_structures WHERE salary_scale = $1', [salaryScale]
    );
    if (!structure) {
        throw new HttpError(400,
            `There is no salary scale called "${salaryScale}". Create it first under Salary Structures.`,
            'UNKNOWN_SCALE');
    }

    const result = await db.withTransaction(async (client) => {
        const usernameValue = req.body.username
            ? v.username(req.body.username)
            : await suggestUsername(fullName, client);

        const created = await accounts.createAccount({
            username: usernameValue, role: 'teacher', fullName, emailAddress, phone,
            actor: req.user, req, client
        });

        const employeeId = await accounts.allocateEmployeeId('teacher', client);

        const teacher = await db.queryOne(
            `INSERT INTO teachers (
                 user_id, employee_id, full_name, email, phone, position, salary_scale, date_joined,
                 leave_entitlement_days, payment_method,
                 bank_name, bank_account_name, bank_account_number,
                 mobile_money_provider, mobile_money_number, created_by
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
             RETURNING id, employee_id`,
            [
                created.userId, employeeId, fullName, emailAddress || null, phone || null,
                position || null, salaryScale, dateJoined,
                entitlement ?? config.defaultAnnualLeaveDays,
                payment.paymentMethod,
                payment.bankName ?? '', payment.bankAccountName ?? '', payment.bankAccountNumber ?? '',
                payment.mobileMoneyProvider ?? '', payment.mobileMoneyNumber ?? '',
                req.user.id
            ],
            client
        );

        return { ...created, teacherId: Number(teacher.id), employeeId, username: usernameValue };
    });

    logAudit(req.user, 'CREATE_TEACHER',
        `Added teacher ${fullName} (${result.employeeId}) on ${salaryScale}`, req.ip);

    res.status(201).json({
        message: result.activation.method === 'setup_link'
            ? `${fullName} has been added. A password setup link was emailed to ${emailAddress}.`
            : `${fullName} has been added with a temporary password. `
              + 'Share it securely — it is shown only once.',
        teacher: {
            id: result.teacherId,
            employeeId: result.employeeId,
            username: result.username,
            fullName
        },
        activation: result.activation
    });
}));

router.put('/teachers/:id', asyncHandler(async (req, res) => {
    const teacherId = v.num(req.params.id, 'Teacher id', { integer: true, min: 1 });

    const existing = await db.queryOne(
        'SELECT id, user_id, full_name, employee_id, salary_scale FROM teachers WHERE id = $1',
        [teacherId]
    );
    if (!existing) throw new HttpError(404, 'Teacher not found.', 'NOT_FOUND');

    const fullName = v.str(req.body.fullName ?? req.body.full_name, 'Full name',
        { required: false, min: 2, max: 120 });
    const emailAddress = req.body.email !== undefined
        ? v.email(req.body.email, 'Email', { required: false }) : undefined;
    const phone = req.body.phone !== undefined
        ? v.str(req.body.phone, 'Phone', { required: false, max: 32 }) : undefined;
    const position = req.body.position !== undefined
        ? v.str(req.body.position, 'Position', { required: false, max: 80 }) : undefined;
    const entitlement = req.body.leaveEntitlementDays !== undefined
        ? v.num(req.body.leaveEntitlementDays, 'Leave entitlement', { min: 0, max: 365, integer: true })
        : undefined;

    const newScale = req.body.salaryScale ?? req.body.salary_scale;
    const scaleChanged = newScale && newScale !== existing.salaryScale;

    const payment = readPaymentDetails(req.body);
    const changed = [];

    await db.withTransaction(async (client) => {
        await client.query(
            `UPDATE teachers
                SET full_name = COALESCE($1, full_name),
                    email     = CASE WHEN $2::boolean THEN $3 ELSE email END,
                    phone     = CASE WHEN $4::boolean THEN $5 ELSE phone END,
                    position  = CASE WHEN $6::boolean THEN $7 ELSE position END,
                    leave_entitlement_days = COALESCE($8, leave_entitlement_days),
                    salary_scale = COALESCE($9, salary_scale)
              WHERE id = $10`,
            [
                fullName || null,
                emailAddress !== undefined, emailAddress || null,
                phone !== undefined, phone || null,
                position !== undefined, position || null,
                entitlement ?? null,
                scaleChanged ? String(newScale) : null,
                teacherId
            ]
        );

        if (payment) {
            await client.query(
                `UPDATE teachers
                    SET payment_method = $1, bank_name = $2, bank_account_name = $3,
                        bank_account_number = $4, mobile_money_provider = $5, mobile_money_number = $6
                  WHERE id = $7`,
                [payment.paymentMethod, payment.bankName, payment.bankAccountName,
                    payment.bankAccountNumber, payment.mobileMoneyProvider,
                    payment.mobileMoneyNumber, teacherId]
            );
            changed.push('payment details');
        }

        // Mirror contact details onto the login account.
        if (fullName || emailAddress !== undefined || phone !== undefined) {
            await client.query(
                `UPDATE users
                    SET full_name = COALESCE($1, full_name),
                        email     = CASE WHEN $2::boolean THEN $3 ELSE email END,
                        phone     = CASE WHEN $4::boolean THEN $5 ELSE phone END
                  WHERE id = $6`,
                [fullName || null, emailAddress !== undefined, emailAddress || null,
                    phone !== undefined, phone || null, existing.userId]
            );
        }
    });

    if (fullName) changed.push('name');
    if (emailAddress !== undefined) changed.push('email');
    if (phone !== undefined) changed.push('phone');
    if (position !== undefined) changed.push('position');
    if (entitlement !== undefined) changed.push('leave entitlement');
    if (scaleChanged) changed.push(`scale → ${newScale}`);

    logAudit(req.user, 'UPDATE_TEACHER',
        `Updated ${existing.fullName} (${existing.employeeId}): ${changed.join(', ') || 'no changes'}`, req.ip);

    if (scaleChanged && existing.userId) {
        await notify.notifyUser(existing.userId, {
            title: 'Your salary scale changed',
            message: `Your salary scale has been changed from ${existing.salaryScale} to ${newScale}. `
                + 'This applies from the next payroll run.',
            category: notify.CATEGORIES.account,
            actorId: req.user.id
        });
    }

    res.json({ message: 'Teacher updated.' });
}));

router.post('/teachers/:id/deactivate', asyncHandler(async (req, res) => {
    const teacherId = v.num(req.params.id, 'Teacher id', { integer: true, min: 1 });
    const reason = v.str(req.body.reason, 'Reason', { required: false, max: 300 });

    const teacher = await db.queryOne(
        'SELECT id, user_id, full_name, employee_id FROM teachers WHERE id = $1', [teacherId]
    );
    if (!teacher) throw new HttpError(404, 'Teacher not found.', 'NOT_FOUND');

    await accounts.deactivateAccount({ userId: teacher.userId, actor: req.user, reason });

    logAudit(req.user, 'DEACTIVATE_TEACHER',
        `Deactivated ${teacher.fullName} (${teacher.employeeId})${reason ? `: ${reason}` : ''}`, req.ip);

    res.json({
        message: `${teacher.fullName} has been deactivated and excluded from future payroll runs.`
    });
}));

router.post('/teachers/:id/reactivate', asyncHandler(async (req, res) => {
    const teacherId = v.num(req.params.id, 'Teacher id', { integer: true, min: 1 });

    const teacher = await db.queryOne(
        'SELECT id, user_id, full_name, employee_id FROM teachers WHERE id = $1', [teacherId]
    );
    if (!teacher) throw new HttpError(404, 'Teacher not found.', 'NOT_FOUND');

    await accounts.reactivateAccount({ userId: teacher.userId, actor: req.user });

    logAudit(req.user, 'REACTIVATE_TEACHER',
        `Reactivated ${teacher.fullName} (${teacher.employeeId})`, req.ip);
    res.json({ message: `${teacher.fullName} has been reactivated.` });
}));

/**
 * Permanent deletion. The `payroll_items.teacher_id` foreign key is
 * ON DELETE RESTRICT, so the database refuses this for anyone who appears on a
 * payroll run; the refusal is translated into advice to deactivate instead.
 */
router.delete('/teachers/:id', asyncHandler(async (req, res) => {
    const teacherId = v.num(req.params.id, 'Teacher id', { integer: true, min: 1 });

    const teacher = await db.queryOne(
        'SELECT id, user_id, full_name, employee_id FROM teachers WHERE id = $1', [teacherId]
    );
    if (!teacher) throw new HttpError(404, 'Teacher not found.', 'NOT_FOUND');

    await accounts.deleteAccount({ userId: teacher.userId, actor: req.user });

    logAudit(req.user, 'DELETE_TEACHER', `Deleted ${teacher.fullName} (${teacher.employeeId})`, req.ip);
    res.json({ message: `${teacher.fullName} has been permanently deleted.` });
}));

router.post('/teachers/:id/resend-setup', emailLimiter, asyncHandler(async (req, res) => {
    const teacherId = v.num(req.params.id, 'Teacher id', { integer: true, min: 1 });

    const teacher = await db.queryOne(
        'SELECT user_id, full_name FROM teachers WHERE id = $1', [teacherId]
    );
    if (!teacher) throw new HttpError(404, 'Teacher not found.', 'NOT_FOUND');

    const result = await accounts.resendSetupLink({ userId: teacher.userId, req });
    logAudit(req.user, 'RESEND_SETUP_LINK', `Resent the setup link for ${teacher.fullName}`, req.ip);
    res.json({ message: `A new setup link has been sent to ${result.email}.`, ...result });
}));

// ===========================================================================
// Salary structures
//
// The scale name is the primary key, so one scale can only ever have one
// structure. The previous schema had no unique constraint while the insert used
// ON CONFLICT (salary_scale) — which made every save fail.
// ===========================================================================

router.get('/salary-structures', asyncHandler(async (req, res) => {
    res.json(await db.query(
        `SELECT salary_scale AS id, salary_scale, basic_salary,
                housing_allowance, transport_allowance, medical_allowance, other_allowance,
                tax_percentage, nssf_percentage, loan_deduction, other_deduction,
                (basic_salary + housing_allowance + transport_allowance
                 + medical_allowance + other_allowance) AS gross_salary,
                (SELECT count(*) FROM teachers t
                  WHERE t.salary_scale = s.salary_scale AND t.is_active) AS teacher_count,
                created_at, updated_at
           FROM salary_structures s
          ORDER BY salary_scale`
    ));
}));

router.post('/salary-structures', asyncHandler(async (req, res) => {
    const scale = v.str(req.body.salaryScale ?? req.body.salary_scale, 'Salary scale', { max: 60 });
    if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(scale)) {
        throw new HttpError(400,
            'A salary scale name may contain only letters, numbers, spaces, hyphens and underscores.',
            'INVALID_SCALE_NAME');
    }

    const existing = await db.queryOne(
        'SELECT * FROM salary_structures WHERE salary_scale = $1', [scale]
    );

    // An omitted field keeps its current value on an update, and falls back to the
    // default only when the scale is being created. Defaulting every absent field
    // to zero would let a partial save silently wipe someone's allowances.
    const amount = (camel, snake, label, fallback, max = 1e12) => {
        const supplied = req.body[camel] ?? req.body[snake];
        const parsed = v.num(supplied, label, { required: false, min: 0, max });
        if (parsed !== null) return parsed;
        return existing ? Number(existing[camel]) : fallback;
    };

    const basicSalary = amount('basicSalary', 'basic_salary', 'Basic salary', null);
    if (basicSalary === null || basicSalary === undefined) {
        throw new HttpError(400, 'Basic salary is required.', 'VALIDATION_FAILED');
    }

    await db.execute(
        `INSERT INTO salary_structures (
             salary_scale, basic_salary, housing_allowance, transport_allowance,
             medical_allowance, other_allowance, tax_percentage, nssf_percentage,
             loan_deduction, other_deduction, updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (salary_scale) DO UPDATE SET
             basic_salary        = EXCLUDED.basic_salary,
             housing_allowance   = EXCLUDED.housing_allowance,
             transport_allowance = EXCLUDED.transport_allowance,
             medical_allowance   = EXCLUDED.medical_allowance,
             other_allowance     = EXCLUDED.other_allowance,
             tax_percentage      = EXCLUDED.tax_percentage,
             nssf_percentage     = EXCLUDED.nssf_percentage,
             loan_deduction      = EXCLUDED.loan_deduction,
             other_deduction     = EXCLUDED.other_deduction,
             updated_by          = EXCLUDED.updated_by,
             updated_at          = now()`,
        [
            scale, basicSalary,
            amount('housingAllowance', 'housing_allowance', 'Housing allowance', 0),
            amount('transportAllowance', 'transport_allowance', 'Transport allowance', 0),
            amount('medicalAllowance', 'medical_allowance', 'Medical allowance', 0),
            amount('otherAllowance', 'other_allowance', 'Other allowance', 0),
            amount('taxPercentage', 'tax_percentage', 'Tax percentage', 0, 100),
            amount('nssfPercentage', 'nssf_percentage', 'NSSF percentage', 5, 30),
            amount('loanDeduction', 'loan_deduction', 'Loan deduction', 0),
            amount('otherDeduction', 'other_deduction', 'Other deduction', 0),
            req.user.id
        ]
    );

    logAudit(req.user,
        existing ? 'UPDATE_SALARY_STRUCTURE' : 'CREATE_SALARY_STRUCTURE',
        `${existing ? 'Updated' : 'Created'} salary scale "${scale}" with basic ${basicSalary}`, req.ip);

    res.json({
        message: `Salary scale "${scale}" ${existing ? 'updated' : 'created'}.`,
        salaryScale: scale
    });
}));

/**
 * Delete a salary scale. The foreign key from `teachers` is ON DELETE RESTRICT,
 * so the database refuses this while the scale is in use.
 */
router.delete('/salary-structures/:scale', asyncHandler(async (req, res) => {
    const scale = v.str(req.params.scale, 'Salary scale', { max: 60 });

    const holder = await db.queryOne(
        `SELECT full_name FROM teachers
          WHERE salary_scale = $1 AND is_active
          ORDER BY full_name LIMIT 1`,
        [scale]
    );
    if (holder) {
        throw new HttpError(409,
            `"${scale}" is still assigned to at least one active teacher (${holder.fullName}). `
            + 'Move them to another scale first.',
            'SCALE_IN_USE');
    }

    const removed = await db.execute('DELETE FROM salary_structures WHERE salary_scale = $1', [scale]);
    if (!removed) throw new HttpError(404, `There is no salary scale called "${scale}".`, 'NOT_FOUND');

    logAudit(req.user, 'DELETE_SALARY_STRUCTURE', `Deleted salary scale "${scale}"`, req.ip);
    res.json({ message: `Salary scale "${scale}" deleted.` });
}));

// ===========================================================================
// Leave
// ===========================================================================

router.get('/leave', asyncHandler(async (req, res) => {
    const status = req.query.status
        ? v.oneOf(req.query.status, ['Pending', 'Approved', 'Rejected', 'Cancelled'], 'Status')
        : null;

    res.json(await db.query(
        `SELECT lr.*, t.full_name, t.employee_id
           FROM leave_requests lr
           JOIN teachers t ON t.id = lr.teacher_id
          WHERE ($1::text IS NULL OR lr.status = $1)
          ORDER BY lr.created_at DESC
          LIMIT 500`,
        [status]
    ));
}));

router.put('/leave/:id/status', asyncHandler(async (req, res) => {
    const requestId = v.num(req.params.id, 'Leave request id', { integer: true, min: 1 });
    const status = v.oneOf(req.body.status, ['Approved', 'Rejected'], 'Status');
    const note = v.str(req.body.note, 'Note', { required: false, max: 300 });

    const config = await configService.getConfig();

    const request = await db.queryOne(
        `SELECT lr.*, t.full_name, t.user_id, t.leave_entitlement_days
           FROM leave_requests lr
           JOIN teachers t ON t.id = lr.teacher_id
          WHERE lr.id = $1`,
        [requestId]
    );
    if (!request) throw new HttpError(404, 'Leave request not found.', 'NOT_FOUND');
    if (request.status !== 'Pending') {
        throw new HttpError(400,
            `This request has already been ${String(request.status).toLowerCase()}.`, 'ALREADY_DECIDED');
    }

    // Re-check the balance at approval time, not only at submission, because
    // other requests may have been approved in the meantime.
    if (status === 'Approved' && !request.isUnpaid) {
        const balance = await leaveService.getBalance(request.teacherId, {
            entitlementDays: request.leaveEntitlementDays ?? config.defaultAnnualLeaveDays,
            year: new Date(`${request.startDate}T00:00:00Z`).getUTCFullYear()
        });

        // This request's own days sit in pendingDays, so add them back.
        const available = balance.remainingDays + Number(request.days || 0);
        if (Number(request.days) > available) {
            throw new HttpError(400,
                `${request.fullName} has only ${available} paid leave day(s) left in ${balance.year}, `
                + `but this request is for ${request.days}. Reject it, or record it as unpaid leave.`,
                'INSUFFICIENT_LEAVE_BALANCE');
        }
    }

    await db.execute(
        `UPDATE leave_requests
            SET status = $1, decided_by = $2, decided_by_name = $3, decided_at = now(), decision_note = $4
          WHERE id = $5`,
        [status, req.user.id, req.user.fullName, note || null, requestId]
    );

    if (request.userId) {
        const unpaidNote = status === 'Approved' && request.isUnpaid
            ? ' Because this is unpaid leave, your basic pay for the affected period will be reduced pro rata.'
            : '';

        await notify.notifyUser(request.userId, {
            title: `Leave request ${status.toLowerCase()}`,
            message: `Your ${String(request.leaveType).toLowerCase()} leave from ${request.startDate} `
                + `to ${request.endDate} (${request.days} day(s)) was ${status.toLowerCase()}.`
                + `${note ? ` Note: ${note}` : ''}${unpaidNote}`,
            category: notify.CATEGORIES.leave,
            severity: status === 'Approved' ? 'success' : 'warning',
            actorId: req.user.id
        });
    }

    logAudit(req.user, 'DECIDE_LEAVE',
        `${status} leave request ${requestId} for ${request.fullName}`, req.ip);
    res.json({ message: `Leave request ${status.toLowerCase()}.` });
}));

// ===========================================================================
// Advances
// ===========================================================================

router.get('/advances', asyncHandler(async (req, res) => {
    const status = req.query.status
        ? v.oneOf(req.query.status, advanceService.STATUSES, 'Status') : null;

    const rows = await db.query(
        `SELECT ar.*, t.full_name, t.employee_id,
                u.full_name AS approved_by_name,
                (ar.amount - ar.amount_repaid) AS outstanding
           FROM advance_requests ar
           JOIN teachers t ON t.id = ar.teacher_id
           LEFT JOIN users u ON u.id = ar.approved_by
          WHERE ($1::text IS NULL OR ar.status = $1)
          ORDER BY ar.created_at DESC
          LIMIT 500`,
        [status]
    );

    res.json(rows.map(row => ({ ...row, instalmentAmount: advanceService.instalmentAmount(row) })));
}));

router.put('/advances/:id/status', asyncHandler(async (req, res) => {
    const advanceId = v.num(req.params.id, 'Advance id', { integer: true, min: 1 });
    const status = v.oneOf(req.body.status, ['Approved', 'Rejected'], 'Status');
    const note = v.str(req.body.note, 'Note', { required: false, max: 300 });

    const config = await configService.getConfig();

    const advance = await db.queryOne(
        `SELECT ar.*, t.full_name, t.user_id
           FROM advance_requests ar
           JOIN teachers t ON t.id = ar.teacher_id
          WHERE ar.id = $1`,
        [advanceId]
    );
    if (!advance) throw new HttpError(404, 'Advance request not found.', 'NOT_FOUND');
    if (advance.status !== 'Pending') {
        throw new HttpError(400,
            `This advance has already been ${String(advance.status).toLowerCase()} and cannot be changed.`,
            'ALREADY_DECIDED');
    }

    const instalments = v.num(req.body.instalments, 'Instalments',
        { required: false, min: 1, max: config.maxAdvanceInstalments, integer: true })
        ?? Number(advance.requestedInstalments || 1);

    await db.execute(
        `UPDATE advance_requests
            SET status           = $1,
                instalments      = $2,
                amount_repaid    = 0,
                instalments_paid = 0,
                approved_by      = CASE WHEN $1 = 'Approved' THEN $3::bigint ELSE NULL END,
                approved_at      = CASE WHEN $1 = 'Approved' THEN now() ELSE NULL END,
                rejected_by      = CASE WHEN $1 = 'Rejected' THEN $3::bigint ELSE NULL END,
                rejected_at      = CASE WHEN $1 = 'Rejected' THEN now() ELSE NULL END,
                decision_note    = $4
          WHERE id = $5`,
        [status, status === 'Approved' ? instalments : Number(advance.requestedInstalments || 1),
            req.user.id, note || null, advanceId]
    );

    if (advance.userId) {
        const perInstalment = Math.round((Number(advance.amount) / instalments) * 100) / 100;

        await notify.notifyUser(advance.userId, {
            title: `Salary advance ${status.toLowerCase()}`,
            message: status === 'Approved'
                ? `Your advance of ${Number(advance.amount).toLocaleString()} was approved and will be `
                  + `recovered over ${instalments} payroll run(s) at about `
                  + `${perInstalment.toLocaleString()} each.${note ? ` Note: ${note}` : ''}`
                : `Your advance request of ${Number(advance.amount).toLocaleString()} was rejected.`
                  + `${note ? ` Note: ${note}` : ''}`,
            category: notify.CATEGORIES.advance,
            severity: status === 'Approved' ? 'success' : 'warning',
            actorId: req.user.id
        });
    }

    logAudit(req.user, 'DECIDE_ADVANCE',
        `${status} advance ${advanceId} of ${advance.amount} for ${advance.fullName}`, req.ip);
    res.json({ message: `Advance request ${status.toLowerCase()}.` });
}));

// ===========================================================================
// Payroll approval
// ===========================================================================

/**
 * Approve a processed payroll run.
 *
 * Only HR may approve, including when an administrator is using these routes:
 * processing and approving must stay in different hands. The
 * `payroll_processor_is_not_approver` check constraint backs this up, so the
 * database would reject it even if this guard were bypassed.
 */
router.post('/payroll/:id/approve', asyncHandler(async (req, res) => {
    if (req.user.role !== 'hr') {
        throw new HttpError(403,
            'Only an HR user can approve payroll. This separation stops one person from both '
            + 'processing and approving a payment run.',
            'HR_ONLY');
    }

    const payrollId = v.num(req.params.id, 'Payroll id', { integer: true, min: 1 });
    const config = await configService.getConfig();

    const { run, items } = await db.withTransaction(async (client) => {
        const existing = await db.queryOne(
            `SELECT id, month, year, status, version, employee_count, total_net, processed_by,
                    to_char(make_date(year, month, 1), 'FMMonth YYYY') AS period_label
               FROM payroll WHERE id = $1 FOR UPDATE`,
            [payrollId], client
        );

        if (!existing) throw new HttpError(404, 'Payroll run not found.', 'NOT_FOUND');
        if (existing.status !== 'processed') {
            throw new HttpError(400,
                `Only a processed payroll run can be approved — this one is "${existing.status}".`,
                'INVALID_STATUS');
        }
        if (Number(existing.processedBy) === Number(req.user.id)) {
            throw new HttpError(403,
                'You processed this payroll run, so you cannot also approve it.', 'SELF_APPROVAL');
        }

        await client.query(
            `UPDATE payroll
                SET status = 'approved', approved_by = $1, approved_by_name = $2, approved_at = now()
              WHERE id = $3`,
            [req.user.id, req.user.fullName, payrollId]
        );

        const lines = await db.query(
            `SELECT pi.net_salary, t.user_id
               FROM payroll_items pi
               JOIN teachers t ON t.id = pi.teacher_id
              WHERE pi.payroll_id = $1 AND pi.version = $2`,
            [payrollId, existing.version], client
        );

        return { run: existing, items: lines };
    });

    // Tell each teacher their own figure.
    await notify.notifyUsersIndividually(items
        .filter(item => item.userId)
        .map(item => ({
            userId: item.userId,
            title: 'Your payslip is ready',
            message: `Your salary for ${run.periodLabel} has been approved. `
                + `Net pay: ${config.currency} ${Number(item.netSalary).toLocaleString()}.`,
            category: notify.CATEGORIES.payroll,
            severity: 'success',
            actorId: req.user.id
        })));

    // Tell the accountants it is now payable.
    await notify.notifyRoles(['accountant'], {
        title: 'Payroll approved — ready for payment',
        message: `Payroll for ${run.periodLabel} was approved by ${req.user.fullName}. `
            + `${items.length} employee(s), net total ${config.currency} `
            + `${Number(run.totalNet).toLocaleString()}.`,
        category: notify.CATEGORIES.payroll,
        actorId: req.user.id
    });

    logAudit(req.user, 'APPROVE_PAYROLL',
        `Approved payroll ${run.periodLabel} (${items.length} employees, net ${run.totalNet})`, req.ip);

    res.json({
        message: `Payroll for ${run.periodLabel} approved and released to the accountant for payment.`
    });
}));

/** Send a processed run back for correction. */
router.post('/payroll/:id/reject', asyncHandler(async (req, res) => {
    if (req.user.role !== 'hr') {
        throw new HttpError(403, 'Only an HR user can reject payroll.', 'HR_ONLY');
    }

    const payrollId = v.num(req.params.id, 'Payroll id', { integer: true, min: 1 });
    const reason = v.str(req.body.reason, 'Reason', { min: 3, max: 400 });

    const run = await db.queryOne(
        `SELECT id, month, year, status,
                to_char(make_date(year, month, 1), 'FMMonth YYYY') AS period_label
           FROM payroll WHERE id = $1`,
        [payrollId]
    );
    if (!run) throw new HttpError(404, 'Payroll run not found.', 'NOT_FOUND');
    if (run.status !== 'processed') {
        throw new HttpError(400,
            `Only a processed payroll run can be rejected — this one is "${run.status}".`, 'INVALID_STATUS');
    }

    await db.execute(
        `UPDATE payroll
            SET status = 'rejected', rejected_by = $1, rejected_by_name = $2,
                rejected_at = now(), rejection_reason = $3
          WHERE id = $4`,
        [req.user.id, req.user.fullName, reason, payrollId]
    );

    await notify.notifyRoles(['accountant'], {
        title: 'Payroll returned for correction',
        message: `Payroll for ${run.periodLabel} was returned by ${req.user.fullName}. Reason: ${reason}`,
        category: notify.CATEGORIES.payroll,
        severity: 'warning',
        actorId: req.user.id
    });

    logAudit(req.user, 'REJECT_PAYROLL', `Returned payroll ${run.periodLabel}: ${reason}`, req.ip);
    res.json({ message: 'Payroll returned to the accountant for correction.' });
}));

// ===========================================================================
// Reports and stats
// ===========================================================================

router.get('/reports/payroll-summary', asyncHandler(async (req, res) => {
    res.json(await db.query(
        `SELECT id, month, year, status, version, employee_count,
                total_gross, total_deductions, total_net, total_employer_cost,
                processed_by_name, approved_by_name, rejection_reason, created_at,
                to_char(make_date(year, month, 1), 'FMMonth YYYY') AS period_label
           FROM payroll
          ORDER BY year DESC, month DESC
          LIMIT 120`
    ));
}));

router.get('/stats', asyncHandler(async (req, res) => {
    const stats = await db.queryOne(`
        SELECT
            (SELECT count(*) FROM teachers WHERE is_active)                             AS total_teachers,
            (SELECT count(*) FROM teachers WHERE is_active AND payroll_halted)          AS halted_teachers,
            (SELECT count(*) FROM payroll)                                              AS total_payrolls,
            (SELECT count(*) FROM payroll WHERE status = 'processed')                   AS awaiting_approval,
            (SELECT count(*) FROM leave_requests WHERE status = 'Pending')              AS pending_leave,
            (SELECT count(*) FROM advance_requests WHERE status = 'Pending')            AS pending_advances,
            (SELECT count(*) FROM users
              WHERE role = 'teacher' AND NOT password_setup_completed)                  AS pending_activation
    `);

    const recent = await db.queryOne(
        `SELECT id, month, year, status, total_net,
                to_char(make_date(year, month, 1), 'FMMonth YYYY') AS period_label
           FROM payroll ORDER BY created_at DESC LIMIT 1`
    );

    res.json({
        totalTeachers: Number(stats.totalTeachers),
        haltedTeachers: Number(stats.haltedTeachers),
        totalPayrolls: Number(stats.totalPayrolls),
        awaitingApproval: Number(stats.awaitingApproval),
        pendingLeave: Number(stats.pendingLeave),
        pendingAdvances: Number(stats.pendingAdvances),
        pendingActivation: Number(stats.pendingActivation),
        recentPayroll: recent
    });
}));

module.exports = router;
