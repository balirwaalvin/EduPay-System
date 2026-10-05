const express = require('express');
const router = express.Router();

const {
    users, teachers, salaryStructures, payroll, payrollItems, advanceRequests,
    serverTimestamp, docData, docsData, getManyByIds, commitInChunks
} = require('../firebase');
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

/** Natural document id for a payroll period, so one period can have one run. */
const periodId = (month, year) => `${year}-${String(month).padStart(2, '0')}`;

/** Fetch the live items for a run (the current version only). */
async function currentItems(payrollId, version) {
    const snap = await payrollItems()
        .where('payrollId', '==', payrollId)
        .where('version', '==', version)
        .get();
    return docsData(snap).sort((a, b) => String(a.teacherName).localeCompare(String(b.teacherName)));
}

// ===========================================================================
// Teacher records
// ===========================================================================

router.get('/teachers', asyncHandler(async (req, res) => {
    const snap = await teachers().where('isActive', '==', true).get();
    const rows = docsData(snap).sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));

    const [structureSnap, halterMap, advanceMap] = await Promise.all([
        salaryStructures().get(),
        getManyByIds(users(), rows.map(r => r.payrollHaltedBy)),
        advanceService.dueForPayroll(rows.map(r => r.id))
    ]);

    const structures = new Map(docsData(structureSnap).map(s => [s.id, s]));

    res.json(rows.map(teacher => {
        const structure = structures.get(teacher.salaryScale) || {};
        const advance = advanceMap.get(teacher.id);
        return {
            ...teacher,
            basicSalary: Number(structure.basicSalary) || 0,
            housingAllowance: Number(structure.housingAllowance) || 0,
            transportAllowance: Number(structure.transportAllowance) || 0,
            medicalAllowance: Number(structure.medicalAllowance) || 0,
            otherAllowance: Number(structure.otherAllowance) || 0,
            taxPercentage: Number(structure.taxPercentage) || 0,
            nssfPercentage: Number(structure.nssfPercentage) || 0,
            scaleMissing: !structures.has(teacher.salaryScale),
            payrollHaltedByName: halterMap.get(teacher.payrollHaltedBy)?.fullName || null,
            nextPayrollAdvance: advance?.amountDue || 0,
            advanceOutstanding: advance?.outstanding || 0
        };
    }));
}));

router.put('/teachers/:id/payroll-halt', asyncHandler(async (req, res) => {
    const teacherId = v.docId(req.params.id, 'Teacher id');
    const halted = v.bool(req.body.halted, false);
    const reason = v.str(req.body.reason, 'Reason', { required: !halted ? false : true, max: 300 });

    const teacher = docData(await teachers().doc(teacherId).get());
    if (!teacher) throw new HttpError(404, 'Teacher not found.', 'NOT_FOUND');

    await teachers().doc(teacherId).update({
        payrollHalted: halted,
        payrollHaltReason: halted ? reason : null,
        payrollHaltedAt: halted ? serverTimestamp() : null,
        payrollHaltedBy: halted ? req.user.id : null,
        updatedAt: serverTimestamp()
    });

    if (teacher.userId) {
        await notify.notifyUser(teacher.userId, {
            title: halted ? 'Your payroll has been paused' : 'Your payroll has resumed',
            message: halted
                ? `Your salary has been withheld from upcoming payroll runs. Reason: ${reason}. Contact HR if this is unexpected.`
                : 'Your salary will be included in the next payroll run.',
            category: notify.CATEGORIES.payroll,
            severity: halted ? 'warning' : 'success',
            actorId: req.user.id
        });
    }

    // HR needs to know, because they handle the queries that follow.
    await notify.notifyRoles(['hr'], {
        title: halted ? 'Teacher payroll paused' : 'Teacher payroll resumed',
        message: `${req.user.fullName} ${halted ? 'paused' : 'resumed'} payroll for ${teacher.fullName} (${teacher.employeeId})`
            + `${halted ? `. Reason: ${reason}` : '.'}`,
        category: notify.CATEGORIES.payroll,
        severity: 'info',
        actorId: req.user.id
    });

    logAudit(
        req.user,
        halted ? 'HALT_TEACHER_PAYROLL' : 'RESUME_TEACHER_PAYROLL',
        `${halted ? 'Paused' : 'Resumed'} payroll for ${teacher.fullName} (${teacher.employeeId})${halted ? `: ${reason}` : ''}`,
        req.ip
    );

    res.json({ message: halted ? `Payroll paused for ${teacher.fullName}.` : `Payroll resumed for ${teacher.fullName}.` });
}));

// ===========================================================================
// Payroll
// ===========================================================================

router.get('/payroll', asyncHandler(async (req, res) => {
    const snap = await payroll().orderBy('year', 'desc').orderBy('month', 'desc').limit(120).get();
    const rows = docsData(snap);
    const userMap = await getManyByIds(users(), rows.flatMap(r => [r.processedBy, r.approvedBy]));

    res.json(rows.map(run => ({
        ...run,
        processedByName: userMap.get(run.processedBy)?.fullName || run.processedByName || null,
        approvedByName: userMap.get(run.approvedBy)?.fullName || run.approvedByName || null
    })));
}));

/**
 * Process a payroll run.
 *
 * Two behaviours changed here. The run is keyed by its period, so two accountants
 * clicking Process at the same moment cannot create duplicate runs. And
 * reprocessing no longer deletes the previous run and its items: the old version
 * is archived and its lines marked superseded, so the figures that were already
 * seen remain auditable.
 */
router.post('/payroll/process', asyncHandler(async (req, res) => {
    const { month, year } = v.period(req.body.month, req.body.year);
    const id = periodId(month, year);
    const config = await configService.getConfig();

    const existing = docData(await payroll().doc(id).get());
    if (existing && ['approved', 'paid'].includes(existing.status)) {
        throw new HttpError(
            409,
            `Payroll for ${month}/${year} has already been ${existing.status} and cannot be reprocessed.`,
            'PAYROLL_LOCKED'
        );
    }

    // Eligible teachers: active, not halted.
    const teacherSnap = await teachers()
        .where('isActive', '==', true)
        .where('payrollHalted', '==', false)
        .get();
    const eligible = docsData(teacherSnap);

    if (!eligible.length) {
        throw new HttpError(
            400,
            'No teachers are eligible for this payroll run. Every active teacher may be paused, or no teachers exist yet.',
            'NO_ELIGIBLE_TEACHERS'
        );
    }

    const structureSnap = await salaryStructures().get();
    const structures = new Map(docsData(structureSnap).map(s => [s.id, s]));

    // Fail before writing anything if a teacher has no salary basis.
    const missingScales = eligible.filter(t => !structures.has(t.salaryScale));
    if (missingScales.length) {
        throw new HttpError(
            400,
            `Cannot process payroll: ${missingScales.length} teacher(s) are on a salary scale that no longer exists `
            + `(${missingScales.slice(0, 3).map(t => `${t.fullName} → ${t.salaryScale}`).join(', ')}`
            + `${missingScales.length > 3 ? ', …' : ''}). Fix their scale first.`,
            'MISSING_SALARY_STRUCTURE'
        );
    }

    const teacherIds = eligible.map(t => t.id);
    const [advanceMap, unpaidLeaveMap] = await Promise.all([
        advanceService.dueForPayroll(teacherIds),
        leaveService.unpaidDaysForPeriod(teacherIds, month, year)
    ]);

    // Build every line in memory first, so a calculation failure writes nothing.
    const lines = eligible.map(teacher => {
        const advance = advanceMap.get(teacher.id);
        const line = calculatePayrollItem(teacher, structures.get(teacher.salaryScale), {
            advanceDeduction: advance?.amountDue || 0,
            unpaidLeaveDays: unpaidLeaveMap.get(teacher.id) || 0,
            month,
            year,
            config
        });
        return { ...line, advanceId: advance?.advanceId || null };
    });

    const totals = summarisePayroll(lines);
    const version = Number(existing?.version || 0) + 1;

    // Archive the superseded version and reverse its advance repayments before
    // recording the new one.
    if (existing) {
        const previousItems = await currentItems(id, existing.version);

        await payroll().doc(id).collection('versions').doc(String(existing.version)).set({
            ...existing,
            items: previousItems,
            supersededAt: serverTimestamp(),
            supersededBy: req.user.id
        });

        await advanceService.reverseRepaymentsForPayroll(id, previousItems);

        await commitInChunks(previousItems.map(item => (batch) => {
            batch.update(payrollItems().doc(item.id), { superseded: true, supersededAt: serverTimestamp() });
        }));
    }

    const run = {
        month,
        year,
        periodLabel: `${documents.monthName(month)} ${year}`,
        status: 'processed',
        version,
        employeeCount: lines.length,
        ...totals,
        currency: config.currency,
        taxMode: config.taxMode,
        processedBy: req.user.id,
        processedByName: req.user.fullName,
        processedAt: serverTimestamp(),
        approvedBy: null,
        approvedAt: null,
        updatedAt: serverTimestamp(),
        ...(existing ? {} : { createdAt: serverTimestamp() })
    };

    await payroll().doc(id).set(run, { merge: true });

    // Write the new lines and record each advance repayment.
    await commitInChunks(lines.map(line => (batch) => {
        const ref = payrollItems().doc();
        batch.set(ref, {
            ...line,
            payrollId: id,
            version,
            month,
            year,
            superseded: false,
            createdAt: serverTimestamp()
        });

        if (line.advanceId && line.advanceDeduction > 0) {
            const advance = advanceMap.get(line.teacherId);
            const isFinal = round2(advance.outstanding - line.advanceDeduction) <= 0;
            advanceService.applyRepayment(batch, line.advanceId, {
                amount: line.advanceDeduction,
                payrollId: id,
                isFinal
            });
        }
    }));

    // HR must be told there is a run waiting for approval — previously nobody was.
    await notify.notifyRoles(['hr'], {
        title: 'Payroll awaiting your approval',
        message: `${req.user.fullName} processed payroll for ${run.periodLabel}: ${lines.length} employee(s), `
            + `net total ${config.currency} ${totals.totalNet.toLocaleString()}. It needs HR approval before payment.`,
        category: notify.CATEGORIES.payroll,
        severity: 'info',
        actorId: req.user.id
    });

    logAudit(
        req.user,
        'PROCESS_PAYROLL',
        `Processed payroll ${run.periodLabel} version ${version}: ${lines.length} employees, `
        + `gross ${totals.totalGross}, net ${totals.totalNet}`,
        req.ip
    );

    const deferred = lines.filter(l => l.advanceDeferred > 0).length;
    const withUnpaidLeave = lines.filter(l => l.unpaidLeaveDays > 0).length;

    res.status(201).json({
        message: `Payroll for ${run.periodLabel} processed and sent to HR for approval.`,
        payrollId: id,
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
    const payrollId = v.docId(req.params.id, 'Payroll id');
    const run = docData(await payroll().doc(payrollId).get());
    if (!run) throw new HttpError(404, 'Payroll run not found.', 'NOT_FOUND');

    const items = await currentItems(payrollId, run.version);
    res.json({ payroll: run, items });
}));

/** Archived versions of a run, for audit. */
router.get('/payroll/:id/versions', asyncHandler(async (req, res) => {
    const payrollId = v.docId(req.params.id, 'Payroll id');
    const snap = await payroll().doc(payrollId).collection('versions').orderBy('version', 'desc').get();
    res.json(docsData(snap));
}));

/**
 * Mark one payslip paid or unpaid.
 *
 * Payment is now gated on HR approval: previously an item could be marked paid on
 * a run nobody had approved, which bypassed the approval step entirely. The run's
 * own status is recomputed in both directions, so reverting one line also reverts
 * a run that had been marked fully paid.
 */
router.put('/payroll-items/:id/payment-status', asyncHandler(async (req, res) => {
    const itemId = v.docId(req.params.id, 'Payroll item id');
    const paymentStatus = v.oneOf(req.body.paymentStatus ?? req.body.payment_status, ['Paid', 'Pending'], 'Payment status');
    const reference = v.str(req.body.reference, 'Payment reference', { required: false, max: 80 });

    const item = docData(await payrollItems().doc(itemId).get());
    if (!item) throw new HttpError(404, 'Payslip not found.', 'NOT_FOUND');
    if (item.superseded) {
        throw new HttpError(400, 'This payslip belongs to a superseded payroll version and cannot be changed.', 'SUPERSEDED');
    }

    const run = docData(await payroll().doc(item.payrollId).get());
    if (!run) throw new HttpError(404, 'Payroll run not found.', 'NOT_FOUND');

    if (!['approved', 'paid'].includes(run.status)) {
        throw new HttpError(
            409,
            `Payroll for ${run.periodLabel || `${run.month}/${run.year}`} has not been approved by HR yet, so payments cannot be recorded against it.`,
            'PAYROLL_NOT_APPROVED'
        );
    }

    await payrollItems().doc(itemId).update({
        paymentStatus,
        paymentReference: paymentStatus === 'Paid' ? (reference || null) : null,
        paidAt: paymentStatus === 'Paid' ? serverTimestamp() : null,
        paidBy: paymentStatus === 'Paid' ? req.user.id : null,
        updatedAt: serverTimestamp()
    });

    // Recompute the run status from its lines, in both directions.
    const pendingSnap = await payrollItems()
        .where('payrollId', '==', item.payrollId)
        .where('version', '==', run.version)
        .where('paymentStatus', '==', 'Pending')
        .count()
        .get();

    const pendingCount = pendingSnap.data().count;
    const newStatus = pendingCount === 0 ? 'paid' : 'approved';

    if (newStatus !== run.status) {
        await payroll().doc(item.payrollId).update({
            status: newStatus,
            fullyPaidAt: newStatus === 'paid' ? serverTimestamp() : null,
            updatedAt: serverTimestamp()
        });

        if (newStatus === 'paid') {
            await notify.notifyRoles(['hr', 'admin'], {
                title: 'Payroll fully paid',
                message: `All ${run.employeeCount} payment(s) for ${run.periodLabel || `${run.month}/${run.year}`} have been recorded as paid.`,
                category: notify.CATEGORIES.payment,
                severity: 'success',
                actorId: req.user.id
            });
        }
    }

    if (paymentStatus === 'Paid') {
        const teacher = docData(await teachers().doc(item.teacherId).get());
        if (teacher?.userId) {
            await notify.notifyUser(teacher.userId, {
                title: 'Salary paid',
                message: `Your salary for ${run.periodLabel || `${run.month}/${run.year}`} has been paid`
                    + `${reference ? ` (reference ${reference})` : ''}. Net amount: ${run.currency || 'UGX'} ${Number(item.netSalary).toLocaleString()}.`,
                category: notify.CATEGORIES.payment,
                severity: 'success',
                actorId: req.user.id
            });
        }
    }

    logAudit(
        req.user,
        'UPDATE_PAYMENT_STATUS',
        `Marked ${item.teacherName} (${item.employeeId}) as ${paymentStatus} for ${run.month}/${run.year}`
        + `${reference ? ` ref ${reference}` : ''}`,
        req.ip
    );

    res.json({
        message: `${item.teacherName} marked as ${paymentStatus.toLowerCase()}.`,
        payrollStatus: newStatus,
        pendingCount
    });
}));

/** Mark every outstanding line on an approved run as paid. */
router.post('/payroll/:id/mark-all-paid', asyncHandler(async (req, res) => {
    const payrollId = v.docId(req.params.id, 'Payroll id');
    const reference = v.str(req.body.reference, 'Payment reference', { required: false, max: 80 });

    const run = docData(await payroll().doc(payrollId).get());
    if (!run) throw new HttpError(404, 'Payroll run not found.', 'NOT_FOUND');
    if (!['approved', 'paid'].includes(run.status)) {
        throw new HttpError(409, 'This payroll run has not been approved by HR yet.', 'PAYROLL_NOT_APPROVED');
    }

    const pendingSnap = await payrollItems()
        .where('payrollId', '==', payrollId)
        .where('version', '==', run.version)
        .where('paymentStatus', '==', 'Pending')
        .get();

    const pending = docsData(pendingSnap);
    if (!pending.length) return res.json({ message: 'Every payment on this run is already recorded as paid.', updated: 0 });

    await commitInChunks(pending.map(item => (batch) => {
        batch.update(payrollItems().doc(item.id), {
            paymentStatus: 'Paid',
            paymentReference: reference || null,
            paidAt: serverTimestamp(),
            paidBy: req.user.id,
            updatedAt: serverTimestamp()
        });
    }));

    await payroll().doc(payrollId).update({
        status: 'paid',
        fullyPaidAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    });

    const teacherMap = await getManyByIds(teachers(), pending.map(i => i.teacherId));
    await notify.notifyUsersIndividually(pending.map(item => {
        const teacher = teacherMap.get(item.teacherId);
        if (!teacher?.userId) return null;
        return {
            userId: teacher.userId,
            title: 'Salary paid',
            message: `Your salary for ${run.periodLabel || `${run.month}/${run.year}`} has been paid. `
                + `Net amount: ${run.currency || 'UGX'} ${Number(item.netSalary).toLocaleString()}.`,
            category: notify.CATEGORIES.payment,
            severity: 'success',
            actorId: req.user.id
        };
    }).filter(Boolean));

    logAudit(req.user, 'MARK_PAYROLL_PAID', `Recorded ${pending.length} payment(s) as paid for ${run.month}/${run.year}`, req.ip);
    res.json({ message: `${pending.length} payment(s) recorded as paid.`, updated: pending.length });
}));

// ===========================================================================
// Reports and exports
// ===========================================================================

router.get('/reports/monthly', asyncHandler(async (req, res) => {
    let query = payroll();

    if (req.query.month && req.query.year) {
        const { month, year } = v.period(req.query.month, req.query.year);
        query = query.where('month', '==', month).where('year', '==', year);
    } else if (req.query.year) {
        query = query.where('year', '==', v.num(req.query.year, 'Year', { min: 2000, max: 2100, integer: true }));
    }

    const snap = await query.orderBy('year', 'desc').orderBy('month', 'desc').limit(120).get();
    res.json(docsData(snap));
}));

/** Statutory totals for the NSSF and PAYE returns. */
router.get('/reports/statutory/:payrollId', asyncHandler(async (req, res) => {
    const payrollId = v.docId(req.params.payrollId, 'Payroll id');
    const run = docData(await payroll().doc(payrollId).get());
    if (!run) throw new HttpError(404, 'Payroll run not found.', 'NOT_FOUND');

    const items = await currentItems(payrollId, run.version);

    res.json({
        period: run.periodLabel || `${run.month}/${run.year}`,
        status: run.status,
        employeeCount: items.length,
        paye: round2(items.reduce((sum, i) => sum + Number(i.taxAmount || 0), 0)),
        nssfEmployee: round2(items.reduce((sum, i) => sum + Number(i.nssfAmount || 0), 0)),
        nssfEmployer: round2(items.reduce((sum, i) => sum + Number(i.nssfEmployerAmount || 0), 0)),
        nssfTotal: round2(items.reduce((sum, i) => sum + Number(i.nssfAmount || 0) + Number(i.nssfEmployerAmount || 0), 0)),
        grossTotal: round2(items.reduce((sum, i) => sum + Number(i.grossSalary || 0), 0)),
        netTotal: round2(items.reduce((sum, i) => sum + Number(i.netSalary || 0), 0)),
        employerCostTotal: round2(items.reduce((sum, i) => sum + Number(i.employerCost || 0), 0))
    });
}));

async function loadRunForExport(payrollIdRaw) {
    const payrollId = v.docId(payrollIdRaw, 'Payroll id');
    const run = docData(await payroll().doc(payrollId).get());
    if (!run) throw new HttpError(404, 'Payroll run not found.', 'NOT_FOUND');

    const items = await currentItems(payrollId, run.version);
    const config = await configService.getConfig();
    return { run, items, config };
}

router.get('/reports/export/excel/:payrollId', asyncHandler(async (req, res) => {
    const { run, items, config } = await loadRunForExport(req.params.payrollId);
    logAudit(req.user, 'EXPORT_PAYROLL_EXCEL', `Exported payroll ${run.month}/${run.year} to Excel`, req.ip);
    await documents.streamPayrollExcel(res, run, items, config);
}));

router.get('/reports/export/pdf/:payrollId', asyncHandler(async (req, res) => {
    const { run, items, config } = await loadRunForExport(req.params.payrollId);
    logAudit(req.user, 'EXPORT_PAYROLL_PDF', `Exported payroll ${run.month}/${run.year} to PDF`, req.ip);
    documents.streamPayrollPdf(res, run, items, config);
}));

router.get('/payslip/:payrollItemId/pdf', asyncHandler(async (req, res) => {
    const itemId = v.docId(req.params.payrollItemId, 'Payroll item id');
    const item = docData(await payrollItems().doc(itemId).get());
    if (!item) throw new HttpError(404, 'Payslip not found.', 'NOT_FOUND');

    const [teacher, config] = await Promise.all([
        teachers().doc(item.teacherId).get().then(docData),
        configService.getConfig()
    ]);

    logAudit(req.user, 'DOWNLOAD_PAYSLIP', `Downloaded the payslip for ${item.teacherName} (${item.month}/${item.year})`, req.ip);

    documents.streamPayslipPdf(res, {
        ...item,
        position: teacher?.position,
        paymentMethod: teacher?.paymentMethod,
        bankName: teacher?.bankName,
        bankAccountName: teacher?.bankAccountName,
        bankAccountNumber: teacher?.bankAccountNumber,
        mobileMoneyProvider: teacher?.mobileMoneyProvider,
        mobileMoneyNumber: teacher?.mobileMoneyNumber
    }, config);
}));

// ===========================================================================
// Stats
// ===========================================================================

router.get('/stats', asyncHandler(async (req, res) => {
    const [teacherCount, haltedCount, payrollCount, awaitingApproval, approvedUnpaid, latestRun, paidSnap, advanceSnap] =
        await Promise.all([
            teachers().where('isActive', '==', true).count().get(),
            teachers().where('isActive', '==', true).where('payrollHalted', '==', true).count().get(),
            payroll().count().get(),
            payroll().where('status', '==', 'processed').count().get(),
            payroll().where('status', '==', 'approved').count().get(),
            payroll().orderBy('createdAt', 'desc').limit(1).get(),
            payroll().where('status', 'in', ['approved', 'paid']).get(),
            advanceRequests().where('status', 'in', ['Approved', 'Repaying']).get()
        ]);

    const totalPaid = docsData(paidSnap).reduce((sum, run) => sum + Number(run.totalNet || 0), 0);
    const outstandingAdvances = docsData(advanceSnap)
        .reduce((sum, a) => sum + Math.max(0, Number(a.amount || 0) - Number(a.amountRepaid || 0)), 0);

    res.json({
        totalTeachers: teacherCount.data().count,
        haltedTeachers: haltedCount.data().count,
        totalPayrolls: payrollCount.data().count,
        awaitingApproval: awaitingApproval.data().count,
        approvedAwaitingPayment: approvedUnpaid.data().count,
        pendingPayrolls: awaitingApproval.data().count + approvedUnpaid.data().count,
        totalPaid: round2(totalPaid),
        pendingAdvanceTotal: round2(outstandingAdvances),
        latestPayroll: latestRun.empty ? null : docData(latestRun.docs[0])
    });
}));

module.exports = router;
