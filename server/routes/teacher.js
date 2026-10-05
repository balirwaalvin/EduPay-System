const express = require('express');
const router = express.Router();

const db = require('../db');
const {
    authenticateToken, authorizeRoles, requirePasswordChanged, asyncHandler, HttpError
} = require('../middleware');
const v = require('../services/validate');
const configService = require('../services/config');
const leaveService = require('../services/leave');
const advanceService = require('../services/advances');
const documents = require('../services/documents');
const notify = require('../services/notifications');
const { logAudit } = require('../services/audit');
const { calculatePayrollItem } = require('../services/payroll-calculator');
const { round2 } = require('../services/tax');

router.use(authenticateToken, authorizeRoles('teacher'), requirePasswordChanged);

/** Resolve the signed-in teacher's own record, with their salary structure. */
async function currentTeacher(req) {
    const teacher = await db.queryOne(
        `SELECT t.*, s.salary_scale AS structure_scale, s.basic_salary,
                s.housing_allowance, s.transport_allowance, s.medical_allowance,
                s.other_allowance, s.tax_percentage, s.nssf_percentage,
                s.loan_deduction, s.other_deduction
           FROM teachers t
           LEFT JOIN salary_structures s ON s.salary_scale = t.salary_scale
          WHERE t.user_id = $1`,
        [req.user.id]
    );

    if (!teacher) {
        throw new HttpError(404,
            'No teacher record is linked to your account. Please contact HR.', 'TEACHER_PROFILE_MISSING');
    }
    return teacher;
}

/** The structure fields, separated from the teacher row the join produced. */
const structureOf = (teacher) => ({
    basicSalary: teacher.basicSalary,
    housingAllowance: teacher.housingAllowance,
    transportAllowance: teacher.transportAllowance,
    medicalAllowance: teacher.medicalAllowance,
    otherAllowance: teacher.otherAllowance,
    taxPercentage: teacher.taxPercentage,
    nssfPercentage: teacher.nssfPercentage,
    loanDeduction: teacher.loanDeduction,
    otherDeduction: teacher.otherDeduction
});

/** Rough net pay, used only to size the advance ceiling. */
function estimateNetPay(teacher, config) {
    if (!teacher.structureScale) return 0;

    const now = new Date();
    const line = calculatePayrollItem(
        { id: teacher.id, fullName: '', employeeId: '', salaryScale: teacher.salaryScale },
        structureOf(teacher),
        { month: now.getMonth() + 1, year: now.getFullYear(), config, advanceDeduction: 0, unpaidLeaveDays: 0 }
    );
    return line.netSalary;
}

// ===========================================================================
// Profile
// ===========================================================================

router.get('/profile', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);
    const config = await configService.getConfig();

    const balance = await leaveService.getBalance(teacher.id, {
        entitlementDays: teacher.leaveEntitlementDays ?? config.defaultAnnualLeaveDays
    });

    res.json({
        ...teacher,
        currency: config.currency,
        scaleMissing: !teacher.structureScale,
        leaveBalance: balance
    });
}));

/**
 * Update own contact and payment details.
 *
 * Deliberately narrow: a teacher cannot change their name, employee id, salary
 * scale or active status, all of which belong to HR.
 */
router.put('/profile', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);

    const phone = req.body.phone !== undefined
        ? v.str(req.body.phone, 'Phone', { required: false, max: 32 }) : undefined;
    const emailAddress = req.body.email !== undefined
        ? v.email(req.body.email, 'Email', { required: false }) : undefined;

    const method = req.body.paymentMethod ?? req.body.payment_method;
    let payment = null;

    if (method !== undefined) {
        const paymentMethod = v.oneOf(method, ['bank', 'mobile_money'], 'Payment method');

        payment = paymentMethod === 'mobile_money'
            ? {
                paymentMethod,
                mobileMoneyProvider: v.str(req.body.mobileMoneyProvider ?? req.body.mobile_money_provider,
                    'Mobile money provider', { max: 60 }),
                mobileMoneyNumber: v.str(req.body.mobileMoneyNumber ?? req.body.mobile_money_number,
                    'Mobile money number', { max: 32 }),
                bankName: null, bankAccountName: null, bankAccountNumber: null
            }
            : {
                paymentMethod,
                bankName: v.str(req.body.bankName ?? req.body.bank_name, 'Bank name', { max: 80 }),
                bankAccountName: v.str(req.body.bankAccountName ?? req.body.bank_account_name,
                    'Account name', { max: 80 }),
                bankAccountNumber: v.str(req.body.bankAccountNumber ?? req.body.bank_account_number,
                    'Account number', { max: 40 }),
                mobileMoneyProvider: null, mobileMoneyNumber: null
            };
    }

    await db.withTransaction(async (client) => {
        await client.query(
            `UPDATE teachers
                SET phone = CASE WHEN $1::boolean THEN $2 ELSE phone END,
                    email = CASE WHEN $3::boolean THEN $4 ELSE email END
              WHERE id = $5`,
            [phone !== undefined, phone || null, emailAddress !== undefined, emailAddress || null, teacher.id]
        );

        if (payment) {
            await client.query(
                `UPDATE teachers
                    SET payment_method = $1, bank_name = $2, bank_account_name = $3,
                        bank_account_number = $4, mobile_money_provider = $5, mobile_money_number = $6
                  WHERE id = $7`,
                [payment.paymentMethod, payment.bankName, payment.bankAccountName,
                    payment.bankAccountNumber, payment.mobileMoneyProvider,
                    payment.mobileMoneyNumber, teacher.id]
            );
        }

        if (phone !== undefined || emailAddress !== undefined) {
            await client.query(
                `UPDATE users
                    SET phone = CASE WHEN $1::boolean THEN $2 ELSE phone END,
                        email = CASE WHEN $3::boolean THEN $4 ELSE email END
                  WHERE id = $5`,
                [phone !== undefined, phone || null,
                    emailAddress !== undefined, emailAddress || null, req.user.id]
            );
        }
    });

    // A change of payment destination is security-relevant, so notify HR.
    if (payment) {
        await notify.notifyRoles(['hr'], {
            title: 'Teacher changed their payment details',
            message: `${teacher.fullName} (${teacher.employeeId}) changed their payment destination to `
                + `${payment.paymentMethod === 'mobile_money' ? 'mobile money' : 'a bank account'}. `
                + 'Verify before the next payment run.',
            category: notify.CATEGORIES.account,
            severity: 'warning',
            actorId: req.user.id
        });

        logAudit(req.user, 'UPDATE_PAYMENT_DETAILS',
            `Changed own payment destination to ${payment.paymentMethod}`, req.ip);
    }

    res.json({ message: 'Your details have been updated.' });
}));

// ===========================================================================
// Payslips and salary history
// ===========================================================================

router.get('/payslips', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);

    // Only released runs are visible to the employee.
    res.json(await db.query(
        `SELECT pi.*, p.status AS payroll_status,
                to_char(make_date(pi.year, pi.month, 1), 'FMMonth YYYY') AS period_label
           FROM payroll_items pi
           JOIN payroll p ON p.id = pi.payroll_id
          WHERE pi.teacher_id = $1
            AND NOT pi.superseded
            AND p.status IN ('approved', 'paid')
          ORDER BY pi.year DESC, pi.month DESC`,
        [teacher.id]
    ));
}));

router.get('/payslip/:id/pdf', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);
    const itemId = v.num(req.params.id, 'Payslip id', { integer: true, min: 1 });

    // Ownership is part of the query: a teacher can only ever match their own row.
    const item = await db.queryOne(
        `SELECT pi.*, p.status AS payroll_status
           FROM payroll_items pi
           JOIN payroll p ON p.id = pi.payroll_id
          WHERE pi.id = $1 AND pi.teacher_id = $2`,
        [itemId, teacher.id]
    );
    if (!item) throw new HttpError(404, 'Payslip not found.', 'NOT_FOUND');

    if (!['approved', 'paid'].includes(item.payrollStatus)) {
        throw new HttpError(403, 'This payslip has not been released yet.', 'NOT_RELEASED');
    }

    const config = await configService.getConfig();

    documents.streamPayslipPdf(res, {
        ...item,
        position: teacher.position,
        paymentMethod: teacher.paymentMethod,
        bankName: teacher.bankName,
        bankAccountName: teacher.bankAccountName,
        bankAccountNumber: teacher.bankAccountNumber,
        mobileMoneyProvider: teacher.mobileMoneyProvider,
        mobileMoneyNumber: teacher.mobileMoneyNumber
    }, config);
}));

router.get('/salary-history', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);

    res.json(await db.query(
        `SELECT payroll_id, month, year, gross_salary, total_deductions, net_salary,
                tax_amount, nssf_amount, advance_deduction, unpaid_leave_days,
                payment_status, created_at
           FROM payroll_items
          WHERE teacher_id = $1 AND NOT superseded
          ORDER BY year DESC, month DESC`,
        [teacher.id]
    ));
}));

// ===========================================================================
// Leave
// ===========================================================================

router.get('/leave', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);
    const config = await configService.getConfig();

    const [requests, balance] = await Promise.all([
        db.query(
            `SELECT * FROM leave_requests WHERE teacher_id = $1 ORDER BY created_at DESC LIMIT 100`,
            [teacher.id]
        ),
        leaveService.getBalance(teacher.id, {
            entitlementDays: teacher.leaveEntitlementDays ?? config.defaultAnnualLeaveDays
        })
    ]);

    res.json({
        requests,
        balance,
        leaveTypes: Object.entries(leaveService.LEAVE_TYPES).map(([value, meta]) => ({
            value, label: meta.label, paid: meta.paid
        }))
    });
}));

router.post('/leave', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);
    const config = await configService.getConfig();

    const leaveType = v.oneOf(req.body.leaveType ?? req.body.leave_type,
        Object.keys(leaveService.LEAVE_TYPES), 'Leave type');
    const startDate = v.isoDate(req.body.startDate ?? req.body.start_date, 'Start date');
    const endDate = v.isoDate(req.body.endDate ?? req.body.end_date, 'End date');
    const reason = v.str(req.body.reason, 'Reason', { min: 3, max: 500 });

    const days = leaveService.validateRange(startDate, endDate);
    const isUnpaid = leaveService.isUnpaid(leaveType);

    // Reported here for a clearer message; the leave_no_overlap exclusion
    // constraint is what actually guarantees it, even under concurrency.
    await leaveService.assertNoOverlap(teacher.id, startDate, endDate);

    if (!isUnpaid) {
        const balance = await leaveService.getBalance(teacher.id, {
            entitlementDays: teacher.leaveEntitlementDays ?? config.defaultAnnualLeaveDays,
            year: new Date(`${startDate}T00:00:00Z`).getUTCFullYear()
        });

        if (days > balance.remainingDays) {
            throw new HttpError(400,
                `You have ${balance.remainingDays} paid leave day(s) left in ${balance.year} but asked `
                + `for ${days}. Reduce the dates, or submit it as unpaid leave.`,
                'INSUFFICIENT_LEAVE_BALANCE');
        }
    }

    const created = await db.queryOne(
        `INSERT INTO leave_requests
             (teacher_id, teacher_name, employee_id, leave_type, start_date, end_date, reason, is_unpaid)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, days`,
        [teacher.id, teacher.fullName, teacher.employeeId, leaveType, startDate, endDate, reason, isUnpaid]
    );

    // HR is told immediately — this is the signal that was previously missing.
    await notify.notifyRoles(['hr'], {
        title: 'New leave request',
        message: `${teacher.fullName} (${teacher.employeeId}) requested ${created.days} day(s) of `
            + `${leaveType.toLowerCase()} leave from ${startDate} to ${endDate}.`,
        category: notify.CATEGORIES.leave,
        actorId: req.user.id
    });

    logAudit(req.user, 'CREATE_LEAVE_REQUEST',
        `Requested ${created.days} day(s) of ${leaveType} leave (${startDate} to ${endDate})`, req.ip);

    res.status(201).json({
        message: 'Your leave request has been submitted to HR.',
        id: Number(created.id),
        days: Number(created.days),
        isUnpaid
    });
}));

/** Withdraw a request that has not been decided yet. */
router.post('/leave/:id/cancel', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);
    const requestId = v.num(req.params.id, 'Leave request id', { integer: true, min: 1 });

    // Ownership and state are both in the WHERE clause, so this cannot cancel
    // someone else's request or one that has already been decided.
    const affected = await db.execute(
        `UPDATE leave_requests
            SET status = 'Cancelled', cancelled_at = now()
          WHERE id = $1 AND teacher_id = $2 AND status = 'Pending'`,
        [requestId, teacher.id]
    );

    if (!affected) {
        const existing = await db.queryOne(
            'SELECT status FROM leave_requests WHERE id = $1 AND teacher_id = $2',
            [requestId, teacher.id]
        );
        if (!existing) throw new HttpError(404, 'Leave request not found.', 'NOT_FOUND');
        throw new HttpError(400,
            `This request has already been ${String(existing.status).toLowerCase()} and cannot be withdrawn.`,
            'ALREADY_DECIDED');
    }

    logAudit(req.user, 'CANCEL_LEAVE_REQUEST', `Withdrew leave request ${requestId}`, req.ip);
    res.json({ message: 'Your leave request has been withdrawn.' });
}));

// ===========================================================================
// Advances
// ===========================================================================

router.get('/advances', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);
    const config = await configService.getConfig();

    const rows = await db.query(
        `SELECT *, (amount - amount_repaid) AS outstanding
           FROM advance_requests WHERE teacher_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [teacher.id]
    );

    const estimatedNet = estimateNetPay(teacher, config);

    res.json({
        requests: rows.map(row => ({ ...row, instalmentAmount: advanceService.instalmentAmount(row) })),
        limits: {
            maxAmount: advanceService.maxAdvanceFor(estimatedNet, config),
            maxAdvancePercentage: config.maxAdvancePercentage,
            maxInstalments: config.maxAdvanceInstalments,
            estimatedMonthlyNet: estimatedNet,
            currency: config.currency
        }
    });
}));

router.post('/advances', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);
    const config = await configService.getConfig();

    const amount = v.num(req.body.amount, 'Amount', { min: 1, max: 1e12 });
    const reason = v.str(req.body.reason, 'Reason', { min: 3, max: 500 });
    const instalments = v.num(req.body.instalments, 'Instalments',
        { required: false, min: 1, max: config.maxAdvanceInstalments, integer: true }) ?? 1;

    // Reported here for a clearer message; the advance_one_open_per_teacher
    // partial unique index is what actually guarantees it.
    await advanceService.assertNoOpenRequest(teacher.id);

    if (!teacher.structureScale) {
        throw new HttpError(400,
            'Your salary scale is not configured yet, so an advance cannot be assessed. Contact HR.',
            'NO_SALARY_STRUCTURE');
    }

    // Cap the request against actual pay, so an advance can never exceed what can
    // realistically be recovered.
    const maxAmount = advanceService.maxAdvanceFor(estimateNetPay(teacher, config) * instalments, config);
    if (amount > maxAmount) {
        throw new HttpError(400,
            `The most you can request over ${instalments} instalment(s) is `
            + `${config.currency} ${maxAmount.toLocaleString()} (${config.maxAdvancePercentage}% of net pay). `
            + 'Reduce the amount or spread it over more instalments.',
            'ADVANCE_EXCEEDS_LIMIT');
    }

    const created = await db.queryOne(
        `INSERT INTO advance_requests
             (teacher_id, teacher_name, employee_id, amount, reason, requested_instalments, instalments)
         VALUES ($1,$2,$3,$4,$5,$6,$6)
         RETURNING id`,
        [teacher.id, teacher.fullName, teacher.employeeId, round2(amount), reason, instalments]
    );

    await notify.notifyRoles(['hr'], {
        title: 'New salary advance request',
        message: `${teacher.fullName} (${teacher.employeeId}) requested an advance of `
            + `${config.currency} ${round2(amount).toLocaleString()} over ${instalments} instalment(s). `
            + `Reason: ${reason}`,
        category: notify.CATEGORIES.advance,
        actorId: req.user.id
    });

    logAudit(req.user, 'CREATE_ADVANCE_REQUEST',
        `Requested an advance of ${amount} over ${instalments} instalment(s)`, req.ip);

    res.status(201).json({
        message: 'Your advance request has been submitted to HR.',
        id: Number(created.id)
    });
}));

router.post('/advances/:id/cancel', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);
    const advanceId = v.num(req.params.id, 'Advance id', { integer: true, min: 1 });

    const affected = await db.execute(
        `UPDATE advance_requests
            SET status = 'Cancelled', cancelled_at = now()
          WHERE id = $1 AND teacher_id = $2 AND status = 'Pending'`,
        [advanceId, teacher.id]
    );

    if (!affected) {
        const existing = await db.queryOne(
            'SELECT status FROM advance_requests WHERE id = $1 AND teacher_id = $2',
            [advanceId, teacher.id]
        );
        if (!existing) throw new HttpError(404, 'Advance request not found.', 'NOT_FOUND');
        throw new HttpError(400,
            `This advance is already ${String(existing.status).toLowerCase()} and cannot be withdrawn.`,
            'ALREADY_DECIDED');
    }

    logAudit(req.user, 'CANCEL_ADVANCE_REQUEST', `Withdrew advance request ${advanceId}`, req.ip);
    res.json({ message: 'Your advance request has been withdrawn.' });
}));

// ===========================================================================
// Dashboard
// ===========================================================================

router.get('/stats', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);
    const config = await configService.getConfig();

    const stats = await db.queryOne(
        `SELECT
             (SELECT count(*) FROM payroll_items
               WHERE teacher_id = $1 AND NOT superseded)                        AS payslip_count,
             (SELECT COALESCE(SUM(net_salary), 0) FROM payroll_items
               WHERE teacher_id = $1 AND NOT superseded AND payment_status = 'Paid') AS total_earned,
             (SELECT count(*) FROM leave_requests
               WHERE teacher_id = $1 AND status = 'Pending')                    AS pending_leave_count,
             (SELECT COALESCE(SUM(amount - amount_repaid), 0) FROM advance_requests
               WHERE teacher_id = $1 AND status IN ('Pending','Approved','Repaying')) AS advance_outstanding,
             (SELECT count(*) FROM notifications
               WHERE user_id = $2 AND NOT is_read)                              AS unread_notifications`,
        [teacher.id, req.user.id]
    );

    const latest = await db.queryOne(
        `SELECT net_salary, month, year FROM payroll_items
          WHERE teacher_id = $1 AND NOT superseded
          ORDER BY year DESC, month DESC LIMIT 1`,
        [teacher.id]
    );

    const balance = await leaveService.getBalance(teacher.id, {
        entitlementDays: teacher.leaveEntitlementDays ?? config.defaultAnnualLeaveDays
    });

    const gross = teacher.structureScale
        ? round2(Number(teacher.basicSalary || 0) + Number(teacher.housingAllowance || 0)
            + Number(teacher.transportAllowance || 0) + Number(teacher.medicalAllowance || 0)
            + Number(teacher.otherAllowance || 0))
        : 0;

    res.json({
        currency: config.currency,
        payrollHalted: Boolean(teacher.payrollHalted),
        payrollHaltReason: teacher.payrollHaltReason || null,
        latestNetSalary: latest ? round2(latest.netSalary) : 0,
        latestPeriod: latest ? `${latest.month}/${latest.year}` : null,
        totalEarnedToDate: round2(stats.totalEarned),
        payslipCount: Number(stats.payslipCount),
        pendingLeaveCount: Number(stats.pendingLeaveCount),
        leaveBalance: balance,
        advanceOutstanding: round2(stats.advanceOutstanding),
        unreadNotifications: Number(stats.unreadNotifications),
        currentGross: gross
    });
}));

module.exports = router;
