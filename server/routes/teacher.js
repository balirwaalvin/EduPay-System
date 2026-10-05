const express = require('express');
const router = express.Router();

const {
    users, teachers, salaryStructures, payroll, payrollItems, leaveRequests,
    advanceRequests, serverTimestamp, docData, docsData
} = require('../firebase');
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
const { round2 } = require('../services/tax');

router.use(authenticateToken, authorizeRoles('teacher'), requirePasswordChanged);

/** Resolve the signed-in teacher's own record. */
async function currentTeacher(req) {
    const snap = await teachers().where('userId', '==', req.user.id).limit(1).get();
    if (snap.empty) {
        throw new HttpError(
            404,
            'No teacher record is linked to your account. Please contact HR.',
            'TEACHER_PROFILE_MISSING'
        );
    }
    return docData(snap.docs[0]);
}

// ===========================================================================
// Profile
// ===========================================================================

router.get('/profile', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);
    const [structure, config] = await Promise.all([
        salaryStructures().doc(teacher.salaryScale).get().then(docData),
        configService.getConfig()
    ]);

    const balance = await leaveService.getBalance(teacher.id, {
        entitlementDays: teacher.leaveEntitlementDays ?? config.defaultAnnualLeaveDays
    });

    res.json({
        ...teacher,
        currency: config.currency,
        basicSalary: Number(structure?.basicSalary) || 0,
        housingAllowance: Number(structure?.housingAllowance) || 0,
        transportAllowance: Number(structure?.transportAllowance) || 0,
        medicalAllowance: Number(structure?.medicalAllowance) || 0,
        otherAllowance: Number(structure?.otherAllowance) || 0,
        nssfPercentage: Number(structure?.nssfPercentage) || 0,
        scaleMissing: !structure,
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
    const updates = { updatedAt: serverTimestamp() };

    if (req.body.phone !== undefined) updates.phone = v.str(req.body.phone, 'Phone', { required: false, max: 32 }) || '';
    if (req.body.email !== undefined) updates.email = v.email(req.body.email, 'Email', { required: false }) || '';

    const method = req.body.paymentMethod ?? req.body.payment_method;
    if (method !== undefined) {
        const paymentMethod = v.oneOf(method, ['bank', 'mobile_money'], 'Payment method');
        updates.paymentMethod = paymentMethod;

        if (paymentMethod === 'mobile_money') {
            updates.mobileMoneyProvider = v.str(req.body.mobileMoneyProvider ?? req.body.mobile_money_provider, 'Mobile money provider', { max: 60 });
            updates.mobileMoneyNumber = v.str(req.body.mobileMoneyNumber ?? req.body.mobile_money_number, 'Mobile money number', { max: 32 });
            updates.bankName = null;
            updates.bankAccountName = null;
            updates.bankAccountNumber = null;
        } else {
            updates.bankName = v.str(req.body.bankName ?? req.body.bank_name, 'Bank name', { max: 80 });
            updates.bankAccountName = v.str(req.body.bankAccountName ?? req.body.bank_account_name, 'Account name', { max: 80 });
            updates.bankAccountNumber = v.str(req.body.bankAccountNumber ?? req.body.bank_account_number, 'Account number', { max: 40 });
            updates.mobileMoneyProvider = null;
            updates.mobileMoneyNumber = null;
        }
    }

    await teachers().doc(teacher.id).update(updates);

    if (updates.phone !== undefined || updates.email !== undefined) {
        await users().doc(req.user.id).update({
            ...(updates.phone !== undefined ? { phone: updates.phone } : {}),
            ...(updates.email !== undefined ? { email: updates.email } : {}),
            updatedAt: serverTimestamp()
        });
    }

    // A change of payment destination is security-relevant, so notify HR.
    if (method !== undefined) {
        await notify.notifyRoles(['hr'], {
            title: 'Teacher changed their payment details',
            message: `${teacher.fullName} (${teacher.employeeId}) changed their payment destination to `
                + `${updates.paymentMethod === 'mobile_money' ? 'mobile money' : 'a bank account'}. Verify before the next payment run.`,
            category: notify.CATEGORIES.account,
            severity: 'warning',
            actorId: req.user.id
        });
        logAudit(req.user, 'UPDATE_PAYMENT_DETAILS', `Changed own payment destination to ${updates.paymentMethod}`, req.ip);
    }

    res.json({ message: 'Your details have been updated.' });
}));

// ===========================================================================
// Payslips and salary history
// ===========================================================================

router.get('/payslips', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);

    const snap = await payrollItems()
        .where('teacherId', '==', teacher.id)
        .where('superseded', '==', false)
        .get();

    const items = docsData(snap);
    const runs = await Promise.all([...new Set(items.map(i => i.payrollId))]
        .map(id => payroll().doc(id).get().then(docData)));
    const runMap = new Map(runs.filter(Boolean).map(r => [r.id, r]));

    // Only released runs are visible to the employee.
    const visible = items
        .filter(item => ['approved', 'paid'].includes(runMap.get(item.payrollId)?.status))
        .map(item => ({
            ...item,
            payrollStatus: runMap.get(item.payrollId).status,
            periodLabel: runMap.get(item.payrollId).periodLabel || `${item.month}/${item.year}`
        }))
        .sort((a, b) => (b.year - a.year) || (b.month - a.month));

    res.json(visible);
}));

router.get('/payslip/:id/pdf', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);
    const itemId = v.docId(req.params.id, 'Payslip id');

    const item = docData(await payrollItems().doc(itemId).get());

    // Ownership check: a teacher may only ever download their own payslip.
    if (!item || item.teacherId !== teacher.id) {
        throw new HttpError(404, 'Payslip not found.', 'NOT_FOUND');
    }

    const run = docData(await payroll().doc(item.payrollId).get());
    if (!run || !['approved', 'paid'].includes(run.status)) {
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

    const snap = await payrollItems()
        .where('teacherId', '==', teacher.id)
        .where('superseded', '==', false)
        .get();

    const rows = docsData(snap)
        .map(item => ({
            payrollId: item.payrollId,
            month: item.month,
            year: item.year,
            grossSalary: item.grossSalary,
            totalDeductions: item.totalDeductions,
            netSalary: item.netSalary,
            taxAmount: item.taxAmount,
            nssfAmount: item.nssfAmount,
            advanceDeduction: item.advanceDeduction,
            unpaidLeaveDays: item.unpaidLeaveDays,
            paymentStatus: item.paymentStatus,
            createdAt: item.createdAt
        }))
        .sort((a, b) => (b.year - a.year) || (b.month - a.month));

    res.json(rows);
}));

// ===========================================================================
// Leave
// ===========================================================================

router.get('/leave', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);
    const config = await configService.getConfig();

    const [snap, balance] = await Promise.all([
        leaveRequests().where('teacherId', '==', teacher.id).orderBy('createdAt', 'desc').limit(100).get(),
        leaveService.getBalance(teacher.id, {
            entitlementDays: teacher.leaveEntitlementDays ?? config.defaultAnnualLeaveDays
        })
    ]);

    res.json({
        requests: docsData(snap).map(r => ({ ...r, isUnpaid: leaveService.isUnpaid(r.leaveType) })),
        balance,
        leaveTypes: Object.entries(leaveService.LEAVE_TYPES).map(([key, meta]) => ({
            value: key, label: meta.label, paid: meta.paid
        }))
    });
}));

router.post('/leave', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);
    const config = await configService.getConfig();

    const leaveType = v.oneOf(req.body.leaveType ?? req.body.leave_type, Object.keys(leaveService.LEAVE_TYPES), 'Leave type');
    const startDate = v.isoDate(req.body.startDate ?? req.body.start_date, 'Start date');
    const endDate = v.isoDate(req.body.endDate ?? req.body.end_date, 'End date');
    const reason = v.str(req.body.reason, 'Reason', { min: 3, max: 500 });

    const days = leaveService.validateRange(startDate, endDate);
    await leaveService.assertNoOverlap(teacher.id, startDate, endDate);

    const entitlementDays = teacher.leaveEntitlementDays ?? config.defaultAnnualLeaveDays;
    const balance = await leaveService.getBalance(teacher.id, {
        entitlementDays,
        year: new Date(`${startDate}T00:00:00Z`).getUTCFullYear()
    });

    if (!leaveService.isUnpaid(leaveType) && days > balance.remainingDays) {
        throw new HttpError(
            400,
            `You have ${balance.remainingDays} paid leave day(s) left in ${balance.year} but asked for ${days}. `
            + 'Reduce the dates, or submit it as unpaid leave.',
            'INSUFFICIENT_LEAVE_BALANCE'
        );
    }

    const ref = await leaveRequests().add({
        teacherId: teacher.id,
        teacherName: teacher.fullName,
        employeeId: teacher.employeeId,
        leaveType,
        startDate,
        endDate,
        days,
        reason,
        isUnpaid: leaveService.isUnpaid(leaveType),
        status: 'Pending',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    });

    // HR is told immediately — this is the signal that was previously missing.
    await notify.notifyRoles(['hr'], {
        title: 'New leave request',
        message: `${teacher.fullName} (${teacher.employeeId}) requested ${days} day(s) of `
            + `${leaveType.toLowerCase()} leave from ${startDate} to ${endDate}.`,
        category: notify.CATEGORIES.leave,
        severity: 'info',
        actorId: req.user.id
    });

    logAudit(req.user, 'CREATE_LEAVE_REQUEST', `Requested ${days} day(s) of ${leaveType} leave (${startDate} to ${endDate})`, req.ip);

    res.status(201).json({
        message: 'Your leave request has been submitted to HR.',
        id: ref.id,
        days,
        isUnpaid: leaveService.isUnpaid(leaveType)
    });
}));

/** Withdraw a request that has not been decided yet. */
router.post('/leave/:id/cancel', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);
    const requestId = v.docId(req.params.id, 'Leave request id');

    const request = docData(await leaveRequests().doc(requestId).get());
    if (!request || request.teacherId !== teacher.id) throw new HttpError(404, 'Leave request not found.', 'NOT_FOUND');
    if (request.status !== 'Pending') {
        throw new HttpError(400, `This request has already been ${request.status.toLowerCase()} and cannot be withdrawn.`, 'ALREADY_DECIDED');
    }

    await leaveRequests().doc(requestId).update({
        status: 'Cancelled',
        cancelledAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    });

    logAudit(req.user, 'CANCEL_LEAVE_REQUEST', `Withdrew leave request ${requestId}`, req.ip);
    res.json({ message: 'Your leave request has been withdrawn.' });
}));

// ===========================================================================
// Advances
// ===========================================================================

router.get('/advances', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);
    const config = await configService.getConfig();

    const [snap, structure] = await Promise.all([
        advanceRequests().where('teacherId', '==', teacher.id).orderBy('createdAt', 'desc').limit(50).get(),
        salaryStructures().doc(teacher.salaryScale).get().then(docData)
    ]);

    const estimatedNet = estimateNetPay(structure, config);

    res.json({
        requests: docsData(snap).map(advance => ({
            ...advance,
            outstanding: round2(Math.max(0, Number(advance.amount || 0) - Number(advance.amountRepaid || 0))),
            instalmentAmount: advanceService.instalmentAmount(advance)
        })),
        limits: {
            maxAmount: advanceService.maxAdvanceFor(estimatedNet, config),
            maxAdvancePercentage: config.maxAdvancePercentage,
            maxInstalments: config.maxAdvanceInstalments,
            estimatedMonthlyNet: estimatedNet,
            currency: config.currency
        }
    });
}));

/** Rough net pay, used only to size the advance ceiling. */
function estimateNetPay(structure, config) {
    if (!structure) return 0;
    const { calculatePayrollItem } = require('../services/payroll-calculator');
    const now = new Date();
    const line = calculatePayrollItem(
        { id: 'estimate', fullName: '', employeeId: '', salaryScale: '' },
        structure,
        { month: now.getMonth() + 1, year: now.getFullYear(), config, advanceDeduction: 0, unpaidLeaveDays: 0 }
    );
    return line.netSalary;
}

router.post('/advances', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);
    const config = await configService.getConfig();

    const amount = v.num(req.body.amount, 'Amount', { min: 1, max: 1e12 });
    const reason = v.str(req.body.reason, 'Reason', { min: 3, max: 500 });
    const instalments = v.num(req.body.instalments, 'Instalments', {
        required: false, min: 1, max: config.maxAdvanceInstalments, integer: true
    }) ?? 1;

    await advanceService.assertNoOpenRequest(teacher.id);

    // Cap the request against actual pay, so an advance can never exceed what can
    // realistically be recovered.
    const structure = docData(await salaryStructures().doc(teacher.salaryScale).get());
    if (!structure) {
        throw new HttpError(400, 'Your salary scale is not configured yet, so an advance cannot be assessed. Contact HR.', 'NO_SALARY_STRUCTURE');
    }

    const estimatedNet = estimateNetPay(structure, config);
    const maxAmount = advanceService.maxAdvanceFor(estimatedNet * instalments, config);

    if (amount > maxAmount) {
        throw new HttpError(
            400,
            `The most you can request over ${instalments} instalment(s) is ${config.currency} ${maxAmount.toLocaleString()} `
            + `(${config.maxAdvancePercentage}% of net pay). Reduce the amount or spread it over more instalments.`,
            'ADVANCE_EXCEEDS_LIMIT'
        );
    }

    const ref = await advanceRequests().add({
        teacherId: teacher.id,
        teacherName: teacher.fullName,
        employeeId: teacher.employeeId,
        amount: round2(amount),
        reason,
        requestedInstalments: instalments,
        instalments,
        amountRepaid: 0,
        instalmentsPaid: 0,
        status: 'Pending',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    });

    await notify.notifyRoles(['hr'], {
        title: 'New salary advance request',
        message: `${teacher.fullName} (${teacher.employeeId}) requested an advance of `
            + `${config.currency} ${round2(amount).toLocaleString()} over ${instalments} instalment(s). Reason: ${reason}`,
        category: notify.CATEGORIES.advance,
        severity: 'info',
        actorId: req.user.id
    });

    logAudit(req.user, 'CREATE_ADVANCE_REQUEST', `Requested an advance of ${amount} over ${instalments} instalment(s)`, req.ip);

    res.status(201).json({ message: 'Your advance request has been submitted to HR.', id: ref.id });
}));

router.post('/advances/:id/cancel', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);
    const advanceId = v.docId(req.params.id, 'Advance id');

    const advance = docData(await advanceRequests().doc(advanceId).get());
    if (!advance || advance.teacherId !== teacher.id) throw new HttpError(404, 'Advance request not found.', 'NOT_FOUND');
    if (advance.status !== 'Pending') {
        throw new HttpError(400, `This advance is already ${advance.status.toLowerCase()} and cannot be withdrawn.`, 'ALREADY_DECIDED');
    }

    await advanceRequests().doc(advanceId).update({
        status: 'Cancelled',
        cancelledAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    });

    logAudit(req.user, 'CANCEL_ADVANCE_REQUEST', `Withdrew advance request ${advanceId}`, req.ip);
    res.json({ message: 'Your advance request has been withdrawn.' });
}));

// ===========================================================================
// Dashboard
// ===========================================================================

router.get('/stats', asyncHandler(async (req, res) => {
    const teacher = await currentTeacher(req);
    const config = await configService.getConfig();

    const [itemSnap, pendingLeave, openAdvance, unread, structure] = await Promise.all([
        payrollItems().where('teacherId', '==', teacher.id).where('superseded', '==', false).get(),
        leaveRequests().where('teacherId', '==', teacher.id).where('status', '==', 'Pending').count().get(),
        advanceRequests().where('teacherId', '==', teacher.id).where('status', 'in', advanceService.OPEN_STATUSES).get(),
        notify.unreadCount(req.user.id),
        salaryStructures().doc(teacher.salaryScale).get().then(docData)
    ]);

    const items = docsData(itemSnap).sort((a, b) => (b.year - a.year) || (b.month - a.month));
    const paid = items.filter(i => i.paymentStatus === 'Paid');
    const openAdvances = docsData(openAdvance);

    const balance = await leaveService.getBalance(teacher.id, {
        entitlementDays: teacher.leaveEntitlementDays ?? config.defaultAnnualLeaveDays
    });

    res.json({
        currency: config.currency,
        payrollHalted: Boolean(teacher.payrollHalted),
        payrollHaltReason: teacher.payrollHaltReason || null,
        latestNetSalary: items[0]?.netSalary ?? 0,
        latestPeriod: items[0] ? `${items[0].month}/${items[0].year}` : null,
        totalEarnedToDate: round2(paid.reduce((sum, i) => sum + Number(i.netSalary || 0), 0)),
        payslipCount: items.length,
        pendingLeaveCount: pendingLeave.data().count,
        leaveBalance: balance,
        advanceOutstanding: round2(openAdvances.reduce(
            (sum, a) => sum + Math.max(0, Number(a.amount || 0) - Number(a.amountRepaid || 0)), 0
        )),
        unreadNotifications: unread,
        currentGross: structure
            ? round2(Number(structure.basicSalary || 0) + Number(structure.housingAllowance || 0)
                + Number(structure.transportAllowance || 0) + Number(structure.medicalAllowance || 0)
                + Number(structure.otherAllowance || 0))
            : 0
    });
}));

module.exports = router;
