const express = require('express');
const router = express.Router();

const db = require('../db');
const {
    authenticateToken, authorizeRoles, requirePasswordChanged, asyncHandler, HttpError
} = require('../middleware');
const v = require('../services/validate');
const configService = require('../services/config');
const { calculatePayrollItem, summarisePayroll } = require('../services/payroll-calculator');
const leaveService = require('../services/leave');
const advanceService = require('../services/advances');
const documents = require('../services/documents');
const notify = require('../services/notifications');
const { logAudit } = require('../services/audit');
const { round2 } = require('../services/tax');

router.use(authenticateToken, authorizeRoles('accountant', 'admin'), requirePasswordChanged);

/**
 * The human-readable period, e.g. "June 2026".
 * Takes a table alias because payroll_items and payroll both carry month and
 * year, so an unqualified reference is ambiguous wherever they are joined.
 */
const periodLabelSql = (alias = '') => {
    const q = alias ? `${alias}.` : '';
    return `to_char(make_date(${q}year, ${q}month, 1), 'FMMonth YYYY') AS period_label`;
};

const PERIOD_LABEL = periodLabelSql();

const PAYROLL_COLUMNS = `
    id, month, year, status, version, employee_count, currency, tax_mode,
    total_gross, total_deductions, total_net,
    total_paye, total_nssf_employee, total_nssf_employer, total_employer_cost,
    processed_by, processed_by_name, processed_at,
    approved_by, approved_by_name, approved_at,
    rejected_by_name, rejection_reason, fully_paid_at, created_at, ${PERIOD_LABEL}`;

/** The live lines for a run, i.e. the current version only. */
function currentItems(payrollId, version, client = null) {
    return db.query(
        `SELECT * FROM payroll_items
          WHERE payroll_id = $1 AND version = $2
          ORDER BY teacher_name`,
        [payrollId, version], client
    );
}

// ===========================================================================
// Teacher records
// ===========================================================================

router.get('/teachers', asyncHandler(async (req, res) => {
    // One join brings in the salary structure, the person who paused payroll, and
    // each teacher's outstanding advance.
    const rows = await db.query(`
        SELECT t.*,
               s.basic_salary, s.housing_allowance, s.transport_allowance,
               s.medical_allowance, s.other_allowance, s.tax_percentage, s.nssf_percentage,
               (s.salary_scale IS NULL) AS scale_missing,
               h.full_name AS payroll_halted_by_name,
               COALESCE(a.outstanding, 0) AS advance_outstanding,
               a.id AS advance_id, a.amount AS advance_amount,
               a.instalments, a.amount_repaid, a.instalments_paid
          FROM teachers t
          LEFT JOIN salary_structures s ON s.salary_scale = t.salary_scale
          LEFT JOIN users h ON h.id = t.payroll_halted_by
          LEFT JOIN (
               SELECT id, teacher_id, amount, instalments, amount_repaid, instalments_paid,
                      (amount - amount_repaid) AS outstanding
                 FROM advance_requests
                WHERE status IN ('Approved', 'Repaying') AND amount_repaid < amount
          ) a ON a.teacher_id = t.id
         WHERE t.is_active
         ORDER BY t.full_name
    `);

    res.json(rows.map(row => ({
        ...row,
        nextPayrollAdvance: row.advanceId
            ? advanceService.instalmentAmount({
                amount: row.advanceAmount,
                instalments: row.instalments,
                amountRepaid: row.amountRepaid,
                instalmentsPaid: row.instalmentsPaid
            })
            : 0
    })));
}));

router.put('/teachers/:id/payroll-halt', asyncHandler(async (req, res) => {
    const teacherId = v.num(req.params.id, 'Teacher id', { integer: true, min: 1 });
    const halted = v.bool(req.body.halted, false);
    const reason = halted
        ? v.str(req.body.reason, 'Reason', { min: 3, max: 300 })
        : null;

    const teacher = await db.queryOne(
        'SELECT id, user_id, full_name, employee_id FROM teachers WHERE id = $1', [teacherId]
    );
    if (!teacher) throw new HttpError(404, 'Teacher not found.', 'NOT_FOUND');

    await db.execute(
        `UPDATE teachers
            SET payroll_halted = $1,
                payroll_halt_reason = $2,
                payroll_halted_at = CASE WHEN $1 THEN now() ELSE NULL END,
                payroll_halted_by = CASE WHEN $1 THEN $3::bigint ELSE NULL END
          WHERE id = $4`,
        [halted, reason, req.user.id, teacherId]
    );

    if (teacher.userId) {
        await notify.notifyUser(teacher.userId, {
            title: halted ? 'Your payroll has been paused' : 'Your payroll has resumed',
            message: halted
                ? `Your salary has been withheld from upcoming payroll runs. Reason: ${reason}. `
                  + 'Contact HR if this is unexpected.'
                : 'Your salary will be included in the next payroll run.',
            category: notify.CATEGORIES.payroll,
            severity: halted ? 'warning' : 'success',
            actorId: req.user.id
        });
    }

    // HR needs to know, because they handle the queries that follow.
    await notify.notifyRoles(['hr'], {
        title: halted ? 'Teacher payroll paused' : 'Teacher payroll resumed',
        message: `${req.user.fullName} ${halted ? 'paused' : 'resumed'} payroll for `
            + `${teacher.fullName} (${teacher.employeeId})${halted ? `. Reason: ${reason}` : '.'}`,
        category: notify.CATEGORIES.payroll,
        actorId: req.user.id
    });

    logAudit(req.user, halted ? 'HALT_TEACHER_PAYROLL' : 'RESUME_TEACHER_PAYROLL',
        `${halted ? 'Paused' : 'Resumed'} payroll for ${teacher.fullName} (${teacher.employeeId})`
        + `${halted ? `: ${reason}` : ''}`, req.ip);

    res.json({
        message: halted
            ? `Payroll paused for ${teacher.fullName}.`
            : `Payroll resumed for ${teacher.fullName}.`
    });
}));

// ===========================================================================
// Payroll
// ===========================================================================

router.get('/payroll', asyncHandler(async (req, res) => {
    res.json(await db.query(
        `SELECT ${PAYROLL_COLUMNS} FROM payroll ORDER BY year DESC, month DESC LIMIT 120`
    ));
}));

/**
 * Process a payroll run.
 *
 * The entire run — archiving any previous version, reversing its advance
 * repayments, writing the new header and every line, and recording each
 * repayment — happens inside one transaction. It either all lands or none of it
 * does, at any number of employees.
 *
 * The `payroll_period_unique` constraint means two accountants pressing Process
 * at the same moment cannot create duplicate runs; the second attempt blocks on
 * the row lock and then sees the first one's work.
 */
router.post('/payroll/process', asyncHandler(async (req, res) => {
    const { month, year } = v.period(req.body.month, req.body.year);
    const config = await configService.getConfig();

    const outcome = await db.withTransaction(async (client) => {
        // Lock the period row if it exists, so a concurrent run waits here.
        const existing = await db.queryOne(
            `SELECT id, status, version FROM payroll WHERE month = $1 AND year = $2 FOR UPDATE`,
            [month, year], client
        );

        if (existing && ['approved', 'paid'].includes(existing.status)) {
            throw new HttpError(409,
                `Payroll for ${month}/${year} has already been ${existing.status} and cannot be reprocessed.`,
                'PAYROLL_LOCKED');
        }

        // Eligible teachers, with their salary structure joined in.
        const eligible = await db.query(
            `SELECT t.id, t.full_name, t.employee_id, t.salary_scale, t.user_id,
                    s.salary_scale AS structure_scale, s.basic_salary,
                    s.housing_allowance, s.transport_allowance, s.medical_allowance,
                    s.other_allowance, s.tax_percentage, s.nssf_percentage,
                    s.loan_deduction, s.other_deduction
               FROM teachers t
               LEFT JOIN salary_structures s ON s.salary_scale = t.salary_scale
              WHERE t.is_active AND NOT t.payroll_halted
              ORDER BY t.full_name`,
            [], client
        );

        if (!eligible.length) {
            throw new HttpError(400,
                'No teachers are eligible for this payroll run. Every active teacher may be paused, '
                + 'or no teachers exist yet.',
                'NO_ELIGIBLE_TEACHERS');
        }

        // Fail before writing anything if a teacher has no salary basis.
        const missing = eligible.filter(t => !t.structureScale);
        if (missing.length) {
            throw new HttpError(400,
                `Cannot process payroll: ${missing.length} teacher(s) are on a salary scale that no `
                + `longer exists (${missing.slice(0, 3).map(t => `${t.fullName} → ${t.salaryScale}`).join(', ')}`
                + `${missing.length > 3 ? ', …' : ''}). Fix their scale first.`,
                'MISSING_SALARY_STRUCTURE');
        }

        const teacherIds = eligible.map(t => Number(t.id));
        const [advanceMap, unpaidLeaveMap] = await Promise.all([
            advanceService.dueForPayroll(teacherIds, client),
            leaveService.unpaidDaysForPeriod(teacherIds, month, year)
        ]);

        // Build every line in memory first, so a calculation failure writes nothing.
        // The join above returns the teacher and their structure in one row, so
        // split it back out to keep the calculator's two inputs distinct.
        const lines = eligible.map((row) => {
            const advance = advanceMap.get(Number(row.id));

            const teacher = {
                id: Number(row.id),
                fullName: row.fullName,
                employeeId: row.employeeId,
                salaryScale: row.salaryScale
            };
            const structure = {
                basicSalary: row.basicSalary,
                housingAllowance: row.housingAllowance,
                transportAllowance: row.transportAllowance,
                medicalAllowance: row.medicalAllowance,
                otherAllowance: row.otherAllowance,
                taxPercentage: row.taxPercentage,
                nssfPercentage: row.nssfPercentage,
                loanDeduction: row.loanDeduction,
                otherDeduction: row.otherDeduction
            };

            const line = calculatePayrollItem(teacher, structure, {
                advanceDeduction: advance?.amountDue || 0,
                unpaidLeaveDays: unpaidLeaveMap.get(Number(row.id)) || 0,
                month, year, config
            });

            return { ...line, advanceId: advance?.advanceId || null, userId: row.userId };
        });

        const totals = summarisePayroll(lines);
        const version = Number(existing?.version || 0) + 1;

        // Archive the superseded version and reverse its advance repayments.
        if (existing) {
            const previous = await currentItems(existing.id, existing.version, client);
            const header = await db.queryOne(
                `SELECT ${PAYROLL_COLUMNS} FROM payroll WHERE id = $1`, [existing.id], client
            );

            await client.query(
                `INSERT INTO payroll_versions (payroll_id, version, snapshot, superseded_by)
                 VALUES ($1, $2, $3::jsonb, $4)
                 ON CONFLICT (payroll_id, version) DO NOTHING`,
                [existing.id, existing.version,
                    JSON.stringify({ ...header, items: previous }), req.user.id]
            );

            await advanceService.reverseRepaymentsForPayroll(client, existing.id, existing.version);
            await client.query(
                'UPDATE payroll_items SET superseded = TRUE WHERE payroll_id = $1 AND version = $2',
                [existing.id, existing.version]
            );
        }

        // Upsert the run header.
        const run = await db.queryOne(
            `INSERT INTO payroll (
                 month, year, status, version, employee_count, currency, tax_mode,
                 total_gross, total_deductions, total_net,
                 total_paye, total_nssf_employee, total_nssf_employer, total_employer_cost,
                 processed_by, processed_by_name, processed_at
             ) VALUES ($1,$2,'processed',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
             ON CONFLICT (month, year) DO UPDATE SET
                 status = 'processed', version = EXCLUDED.version,
                 employee_count = EXCLUDED.employee_count,
                 currency = EXCLUDED.currency, tax_mode = EXCLUDED.tax_mode,
                 total_gross = EXCLUDED.total_gross,
                 total_deductions = EXCLUDED.total_deductions,
                 total_net = EXCLUDED.total_net,
                 total_paye = EXCLUDED.total_paye,
                 total_nssf_employee = EXCLUDED.total_nssf_employee,
                 total_nssf_employer = EXCLUDED.total_nssf_employer,
                 total_employer_cost = EXCLUDED.total_employer_cost,
                 processed_by = EXCLUDED.processed_by,
                 processed_by_name = EXCLUDED.processed_by_name,
                 processed_at = now(),
                 approved_by = NULL, approved_by_name = NULL, approved_at = NULL,
                 rejected_by = NULL, rejected_by_name = NULL, rejected_at = NULL,
                 rejection_reason = NULL, fully_paid_at = NULL
             RETURNING id, ${PERIOD_LABEL}`,
            [
                month, year, version, lines.length, config.currency, config.taxMode,
                totals.totalGross, totals.totalDeductions, totals.totalNet,
                totals.totalPaye, totals.totalNssfEmployee, totals.totalNssfEmployer,
                totals.totalEmployerCost,
                req.user.id, req.user.fullName
            ],
            client
        );

        // Write every line in one statement.
        const { text, values } = db.buildBulkInsert(
            'payroll_items',
            ['payroll_id', 'teacher_id', 'version', 'month', 'year',
                'teacher_name', 'employee_id', 'salary_scale',
                'basic_salary', 'contractual_basic_salary', 'housing_allowance',
                'transport_allowance', 'medical_allowance', 'other_allowance', 'gross_salary',
                'tax_amount', 'nssf_amount', 'nssf_employer_amount', 'loan_deduction',
                'advance_deduction', 'advance_deferred', 'advance_id',
                'unpaid_leave_days', 'unpaid_leave_deduction', 'other_deduction',
                'total_deductions', 'net_salary', 'employer_cost'],
            lines.map(line => ({ ...line, payrollId: run.id, version, month, year })),
            { returning: null }
        );
        await client.query(text, values);

        // Record each advance repayment.
        for (const line of lines) {
            if (line.advanceId && line.advanceDeduction > 0) {
                await advanceService.applyRepayment(client, line.advanceId, {
                    amount: line.advanceDeduction,
                    payrollId: run.id
                });
            }
        }

        return { run, lines, totals, version, existed: Boolean(existing) };
    });

    const { run, lines, totals, version } = outcome;

    // HR must be told there is a run waiting for approval.
    await notify.notifyRoles(['hr'], {
        title: 'Payroll awaiting your approval',
        message: `${req.user.fullName} processed payroll for ${run.periodLabel}: ${lines.length} `
            + `employee(s), net total ${config.currency} ${totals.totalNet.toLocaleString()}. `
            + 'It needs HR approval before payment.',
        category: notify.CATEGORIES.payroll,
        actorId: req.user.id
    });

    logAudit(req.user, 'PROCESS_PAYROLL',
        `Processed payroll ${run.periodLabel} version ${version}: ${lines.length} employees, `
        + `gross ${totals.totalGross}, net ${totals.totalNet}`, req.ip);

    const deferred = lines.filter(l => l.advanceDeferred > 0).length;
    const withUnpaidLeave = lines.filter(l => l.unpaidLeaveDays > 0).length;

    res.status(201).json({
        message: `Payroll for ${run.periodLabel} processed and sent to HR for approval.`,
        payrollId: Number(run.id),
        version,
        employeeCount: lines.length,
        ...totals,
        notes: [
            version > 1 ? `This replaced version ${version - 1}, which has been archived.` : null,
            deferred ? `${deferred} advance instalment(s) were reduced to protect minimum net pay.` : null,
            withUnpaidLeave ? `${withUnpaidLeave} payslip(s) were abated for approved unpaid leave.` : null
        ].filter(Boolean)
    });
}));

router.get('/payroll/:id/items', asyncHandler(async (req, res) => {
    const payrollId = v.num(req.params.id, 'Payroll id', { integer: true, min: 1 });

    const run = await db.queryOne(`SELECT ${PAYROLL_COLUMNS} FROM payroll WHERE id = $1`, [payrollId]);
    if (!run) throw new HttpError(404, 'Payroll run not found.', 'NOT_FOUND');

    res.json({ payroll: run, items: await currentItems(payrollId, run.version) });
}));

/** Archived versions of a run, for audit. */
router.get('/payroll/:id/versions', asyncHandler(async (req, res) => {
    const payrollId = v.num(req.params.id, 'Payroll id', { integer: true, min: 1 });

    const rows = await db.query(
        `SELECT version, snapshot, superseded_at, superseded_by
           FROM payroll_versions WHERE payroll_id = $1 ORDER BY version DESC`,
        [payrollId]
    );

    // Flatten the snapshot so the shape matches what the live endpoint returns.
    res.json(rows.map(row => ({
        version: row.version,
        supersededAt: row.supersededAt,
        supersededBy: row.supersededBy,
        ...row.snapshot
    })));
}));

/**
 * Mark one payslip paid or unpaid.
 *
 * Payment is gated on HR approval: previously an item could be marked paid on a
 * run nobody had approved, which bypassed the approval step entirely. The run's
 * own status is recomputed in both directions, so reverting one line also
 * reverts a run that had been marked fully paid.
 */
router.put('/payroll-items/:id/payment-status', asyncHandler(async (req, res) => {
    const itemId = v.num(req.params.id, 'Payroll item id', { integer: true, min: 1 });
    const paymentStatus = v.oneOf(req.body.paymentStatus ?? req.body.payment_status,
        ['Paid', 'Pending'], 'Payment status');
    const reference = v.str(req.body.reference, 'Payment reference', { required: false, max: 80 });

    const outcome = await db.withTransaction(async (client) => {
        const item = await db.queryOne(
            `SELECT pi.*, t.user_id, p.status AS payroll_status, p.version AS payroll_version,
                    p.currency, p.employee_count, ${periodLabelSql('p')}
               FROM payroll_items pi
               JOIN payroll p ON p.id = pi.payroll_id
               JOIN teachers t ON t.id = pi.teacher_id
              WHERE pi.id = $1
              FOR UPDATE OF pi`,
            [itemId], client
        );

        if (!item) throw new HttpError(404, 'Payslip not found.', 'NOT_FOUND');
        if (item.superseded) {
            throw new HttpError(400,
                'This payslip belongs to a superseded payroll version and cannot be changed.', 'SUPERSEDED');
        }
        if (!['approved', 'paid'].includes(item.payrollStatus)) {
            throw new HttpError(409,
                `Payroll for ${item.periodLabel} has not been approved by HR yet, so payments cannot be `
                + 'recorded against it.',
                'PAYROLL_NOT_APPROVED');
        }

        await client.query(
            `UPDATE payroll_items
                SET payment_status = $1,
                    payment_reference = CASE WHEN $1 = 'Paid' THEN $2 ELSE NULL END,
                    paid_at = CASE WHEN $1 = 'Paid' THEN now() ELSE NULL END,
                    paid_by = CASE WHEN $1 = 'Paid' THEN $3::bigint ELSE NULL END
              WHERE id = $4`,
            [paymentStatus, reference || null, req.user.id, itemId]
        );

        // Recompute the run status from its lines, in both directions.
        const pending = Number(await db.scalar(
            `SELECT count(*) AS count FROM payroll_items
              WHERE payroll_id = $1 AND version = $2 AND payment_status = 'Pending'`,
            [item.payrollId, item.payrollVersion], client
        ));

        const newStatus = pending === 0 ? 'paid' : 'approved';

        if (newStatus !== item.payrollStatus) {
            await client.query(
                `UPDATE payroll
                    SET status = $1, fully_paid_at = CASE WHEN $1 = 'paid' THEN now() ELSE NULL END
                  WHERE id = $2`,
                [newStatus, item.payrollId]
            );
        }

        return { item, pending, newStatus, statusChanged: newStatus !== item.payrollStatus };
    });

    const { item, pending, newStatus, statusChanged } = outcome;

    if (statusChanged && newStatus === 'paid') {
        await notify.notifyRoles(['hr', 'admin'], {
            title: 'Payroll fully paid',
            message: `All ${item.employeeCount} payment(s) for ${item.periodLabel} have been recorded as paid.`,
            category: notify.CATEGORIES.payment,
            severity: 'success',
            actorId: req.user.id
        });
    }

    if (paymentStatus === 'Paid' && item.userId) {
        await notify.notifyUser(item.userId, {
            title: 'Salary paid',
            message: `Your salary for ${item.periodLabel} has been paid`
                + `${reference ? ` (reference ${reference})` : ''}. `
                + `Net amount: ${item.currency || 'UGX'} ${Number(item.netSalary).toLocaleString()}.`,
            category: notify.CATEGORIES.payment,
            severity: 'success',
            actorId: req.user.id
        });
    }

    logAudit(req.user, 'UPDATE_PAYMENT_STATUS',
        `Marked ${item.teacherName} (${item.employeeId}) as ${paymentStatus} for ${item.periodLabel}`
        + `${reference ? ` ref ${reference}` : ''}`, req.ip);

    res.json({
        message: `${item.teacherName} marked as ${paymentStatus.toLowerCase()}.`,
        payrollStatus: newStatus,
        pendingCount: pending
    });
}));

/** Mark every outstanding line on an approved run as paid. */
router.post('/payroll/:id/mark-all-paid', asyncHandler(async (req, res) => {
    const payrollId = v.num(req.params.id, 'Payroll id', { integer: true, min: 1 });
    const reference = v.str(req.body.reference, 'Payment reference', { required: false, max: 80 });

    const outcome = await db.withTransaction(async (client) => {
        const run = await db.queryOne(
            `SELECT id, status, version, currency, employee_count, ${PERIOD_LABEL}
               FROM payroll WHERE id = $1 FOR UPDATE`,
            [payrollId], client
        );

        if (!run) throw new HttpError(404, 'Payroll run not found.', 'NOT_FOUND');
        if (!['approved', 'paid'].includes(run.status)) {
            throw new HttpError(409,
                'This payroll run has not been approved by HR yet.', 'PAYROLL_NOT_APPROVED');
        }

        // Update and collect the affected rows in one statement.
        const updated = await db.query(
            `UPDATE payroll_items pi
                SET payment_status = 'Paid', payment_reference = $1, paid_at = now(), paid_by = $2
              WHERE pi.payroll_id = $3 AND pi.version = $4 AND pi.payment_status = 'Pending'
              RETURNING pi.id, pi.net_salary, pi.teacher_id,
                        (SELECT user_id FROM teachers WHERE id = pi.teacher_id) AS user_id`,
            [reference || null, req.user.id, payrollId, run.version], client
        );

        if (updated.length) {
            await client.query(
                `UPDATE payroll SET status = 'paid', fully_paid_at = now() WHERE id = $1`, [payrollId]
            );
        }

        return { run, updated };
    });

    const { run, updated } = outcome;

    if (!updated.length) {
        return res.json({ message: 'Every payment on this run is already recorded as paid.', updated: 0 });
    }

    await notify.notifyUsersIndividually(updated
        .filter(item => item.userId)
        .map(item => ({
            userId: item.userId,
            title: 'Salary paid',
            message: `Your salary for ${run.periodLabel} has been paid. `
                + `Net amount: ${run.currency || 'UGX'} ${Number(item.netSalary).toLocaleString()}.`,
            category: notify.CATEGORIES.payment,
            severity: 'success',
            actorId: req.user.id
        })));

    logAudit(req.user, 'MARK_PAYROLL_PAID',
        `Recorded ${updated.length} payment(s) as paid for ${run.periodLabel}`, req.ip);

    res.json({ message: `${updated.length} payment(s) recorded as paid.`, updated: updated.length });
}));

// ===========================================================================
// Reports and exports
// ===========================================================================

router.get('/reports/monthly', asyncHandler(async (req, res) => {
    let month = null;
    let year = null;

    if (req.query.month && req.query.year) {
        ({ month, year } = v.period(req.query.month, req.query.year));
    } else if (req.query.year) {
        year = v.num(req.query.year, 'Year', { min: 2000, max: 2100, integer: true });
    }

    res.json(await db.query(
        `SELECT ${PAYROLL_COLUMNS} FROM payroll
          WHERE ($1::int IS NULL OR month = $1) AND ($2::int IS NULL OR year = $2)
          ORDER BY year DESC, month DESC
          LIMIT 120`,
        [month, year]
    ));
}));

/**
 * Statutory totals for the NSSF and PAYE returns.
 * Aggregated by the database rather than by summing documents in JavaScript.
 */
router.get('/reports/statutory/:payrollId', asyncHandler(async (req, res) => {
    const payrollId = v.num(req.params.payrollId, 'Payroll id', { integer: true, min: 1 });

    const run = await db.queryOne(
        `SELECT id, status, version, ${PERIOD_LABEL} FROM payroll WHERE id = $1`, [payrollId]
    );
    if (!run) throw new HttpError(404, 'Payroll run not found.', 'NOT_FOUND');

    const totals = await db.queryOne(
        `SELECT count(*)                           AS employee_count,
                COALESCE(SUM(tax_amount), 0)           AS paye,
                COALESCE(SUM(nssf_amount), 0)          AS nssf_employee,
                COALESCE(SUM(nssf_employer_amount), 0) AS nssf_employer,
                COALESCE(SUM(nssf_amount + nssf_employer_amount), 0) AS nssf_total,
                COALESCE(SUM(gross_salary), 0)         AS gross_total,
                COALESCE(SUM(net_salary), 0)           AS net_total,
                COALESCE(SUM(employer_cost), 0)        AS employer_cost_total
           FROM payroll_items
          WHERE payroll_id = $1 AND version = $2`,
        [payrollId, run.version]
    );

    res.json({
        period: run.periodLabel,
        status: run.status,
        employeeCount: Number(totals.employeeCount),
        paye: round2(totals.paye),
        nssfEmployee: round2(totals.nssfEmployee),
        nssfEmployer: round2(totals.nssfEmployer),
        nssfTotal: round2(totals.nssfTotal),
        grossTotal: round2(totals.grossTotal),
        netTotal: round2(totals.netTotal),
        employerCostTotal: round2(totals.employerCostTotal)
    });
}));

async function loadRunForExport(rawId) {
    const payrollId = v.num(rawId, 'Payroll id', { integer: true, min: 1 });

    const run = await db.queryOne(`SELECT ${PAYROLL_COLUMNS} FROM payroll WHERE id = $1`, [payrollId]);
    if (!run) throw new HttpError(404, 'Payroll run not found.', 'NOT_FOUND');

    const [items, config] = await Promise.all([
        currentItems(payrollId, run.version),
        configService.getConfig()
    ]);

    return { run, items, config };
}

router.get('/reports/export/excel/:payrollId', asyncHandler(async (req, res) => {
    const { run, items, config } = await loadRunForExport(req.params.payrollId);
    logAudit(req.user, 'EXPORT_PAYROLL_EXCEL', `Exported payroll ${run.periodLabel} to Excel`, req.ip);
    await documents.streamPayrollExcel(res, run, items, config);
}));

router.get('/reports/export/pdf/:payrollId', asyncHandler(async (req, res) => {
    const { run, items, config } = await loadRunForExport(req.params.payrollId);
    logAudit(req.user, 'EXPORT_PAYROLL_PDF', `Exported payroll ${run.periodLabel} to PDF`, req.ip);
    documents.streamPayrollPdf(res, run, items, config);
}));

router.get('/payslip/:payrollItemId/pdf', asyncHandler(async (req, res) => {
    const itemId = v.num(req.params.payrollItemId, 'Payroll item id', { integer: true, min: 1 });

    // The payment destination comes from the teacher record in the same query.
    const item = await db.queryOne(
        `SELECT pi.*, t.position, t.payment_method,
                t.bank_name, t.bank_account_name, t.bank_account_number,
                t.mobile_money_provider, t.mobile_money_number
           FROM payroll_items pi
           JOIN teachers t ON t.id = pi.teacher_id
          WHERE pi.id = $1`,
        [itemId]
    );
    if (!item) throw new HttpError(404, 'Payslip not found.', 'NOT_FOUND');

    const config = await configService.getConfig();

    logAudit(req.user, 'DOWNLOAD_PAYSLIP',
        `Downloaded the payslip for ${item.teacherName} (${item.month}/${item.year})`, req.ip);

    documents.streamPayslipPdf(res, item, config);
}));

// ===========================================================================
// Stats
// ===========================================================================

router.get('/stats', asyncHandler(async (req, res) => {
    const stats = await db.queryOne(`
        SELECT
            (SELECT count(*) FROM teachers WHERE is_active)                     AS total_teachers,
            (SELECT count(*) FROM teachers WHERE is_active AND payroll_halted)   AS halted_teachers,
            (SELECT count(*) FROM payroll)                                       AS total_payrolls,
            (SELECT count(*) FROM payroll WHERE status = 'processed')             AS awaiting_approval,
            (SELECT count(*) FROM payroll WHERE status = 'approved')              AS approved_awaiting_payment,
            (SELECT COALESCE(SUM(total_net), 0) FROM payroll
              WHERE status IN ('approved', 'paid'))                              AS total_paid,
            (SELECT COALESCE(SUM(amount - amount_repaid), 0) FROM advance_requests
              WHERE status IN ('Approved', 'Repaying'))                          AS pending_advance_total
    `);

    const latest = await db.queryOne(
        `SELECT id, month, year, status, total_net, ${PERIOD_LABEL}
           FROM payroll ORDER BY created_at DESC LIMIT 1`
    );

    res.json({
        totalTeachers: Number(stats.totalTeachers),
        haltedTeachers: Number(stats.haltedTeachers),
        totalPayrolls: Number(stats.totalPayrolls),
        awaitingApproval: Number(stats.awaitingApproval),
        approvedAwaitingPayment: Number(stats.approvedAwaitingPayment),
        pendingPayrolls: Number(stats.awaitingApproval) + Number(stats.approvedAwaitingPayment),
        totalPaid: round2(stats.totalPaid),
        pendingAdvanceTotal: round2(stats.pendingAdvanceTotal),
        latestPayroll: latest
    });
}));

module.exports = router;
