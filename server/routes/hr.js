const express = require('express');
const router = express.Router();

const {
    users, teachers, salaryStructures, payroll, payrollItems, leaveRequests,
    advanceRequests, serverTimestamp, docData, docsData, getManyByIds
} = require('../firebase');
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
    if (body.paymentMethod === undefined && body.payment_method === undefined) {
        if (required) throw new HttpError(400, 'A payment method is required.', 'PAYMENT_METHOD_REQUIRED');
        return {};
    }

    const method = v.oneOf(body.paymentMethod ?? body.payment_method, PAYMENT_METHODS, 'Payment method');

    if (method === 'mobile_money') {
        return {
            paymentMethod: method,
            mobileMoneyProvider: v.str(body.mobileMoneyProvider ?? body.mobile_money_provider, 'Mobile money provider', { required, max: 60 }) || '',
            mobileMoneyNumber: v.str(body.mobileMoneyNumber ?? body.mobile_money_number, 'Mobile money number', { required, max: 32 }) || '',
            bankName: null,
            bankAccountName: null,
            bankAccountNumber: null
        };
    }

    return {
        paymentMethod: method,
        bankName: v.str(body.bankName ?? body.bank_name, 'Bank name', { required, max: 80 }) || '',
        bankAccountName: v.str(body.bankAccountName ?? body.bank_account_name, 'Account name', { required, max: 80 }) || '',
        bankAccountNumber: v.str(body.bankAccountNumber ?? body.bank_account_number, 'Account number', { required, max: 40 }) || '',
        mobileMoneyProvider: null,
        mobileMoneyNumber: null
    };
}

// ===========================================================================
// Teachers
// ===========================================================================

router.get('/teachers', asyncHandler(async (req, res) => {
    const includeInactive = v.bool(req.query.includeInactive, false);

    let query = teachers();
    if (!includeInactive) query = query.where('isActive', '==', true);

    const snap = await query.get();
    const rows = docsData(snap).sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
    const userMap = await getManyByIds(users(), rows.map(r => r.userId));

    res.json(rows.map(teacher => {
        const account = userMap.get(teacher.userId);
        return {
            ...teacher,
            username: account?.username || null,
            accountActive: account ? account.isActive !== false : false,
            activationPending: account ? account.passwordSetupCompleted === false : false
        };
    }));
}));

router.post('/teachers', asyncHandler(async (req, res) => {
    const fullName = v.str(req.body.fullName ?? req.body.full_name, 'Full name', { min: 2, max: 120 });
    const salaryScale = v.str(req.body.salaryScale ?? req.body.salary_scale, 'Salary scale', { max: 60 });
    const emailAddress = v.email(req.body.email, 'Email', { required: false });
    const phone = v.str(req.body.phone, 'Phone', { required: false, max: 32 });
    const position = v.str(req.body.position, 'Position', { required: false, max: 80 });
    const dateJoined = v.isoDate(req.body.dateJoined ?? req.body.date_joined, 'Date joined', { required: false })
        || new Date().toISOString().slice(0, 10);

    // Reject an unknown scale up front rather than producing a zero-salary teacher.
    const structure = docData(await salaryStructures().doc(salaryScale).get());
    if (!structure) {
        throw new HttpError(400, `There is no salary scale called "${salaryScale}". Create it first under Salary Structures.`, 'UNKNOWN_SCALE');
    }

    const usernameValue = req.body.username
        ? v.username(req.body.username)
        : await suggestUsername(fullName);

    const paymentDetails = readPaymentDetails(req.body);
    const config = await configService.getConfig();

    let created;
    try {
        created = await accounts.createAccount({
            username: usernameValue,
            role: 'teacher',
            fullName,
            emailAddress,
            phone,
            actor: req.user,
            req
        });
    } catch (err) {
        if (err.code === 'USERNAME_TAKEN') throw new HttpError(409, err.message, 'USERNAME_TAKEN');
        throw err;
    }

    const employeeId = await accounts.allocateEmployeeId('teacher');

    const teacherRef = await teachers().add({
        userId: created.userId,
        employeeId,
        fullName,
        email: emailAddress || '',
        phone: phone || '',
        position: position || '',
        salaryScale,
        dateJoined,
        isActive: true,
        payrollHalted: false,
        leaveEntitlementDays: v.num(req.body.leaveEntitlementDays, 'Leave entitlement', { required: false, min: 0, max: 365, integer: true })
            ?? config.defaultAnnualLeaveDays,
        paymentMethod: paymentDetails.paymentMethod || 'bank',
        bankName: paymentDetails.bankName ?? '',
        bankAccountName: paymentDetails.bankAccountName ?? '',
        bankAccountNumber: paymentDetails.bankAccountNumber ?? '',
        mobileMoneyProvider: paymentDetails.mobileMoneyProvider ?? '',
        mobileMoneyNumber: paymentDetails.mobileMoneyNumber ?? '',
        createdBy: req.user.id,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    });

    logAudit(req.user, 'CREATE_TEACHER', `Added teacher ${fullName} (${employeeId}) on ${salaryScale}`, req.ip);

    res.status(201).json({
        message: created.activation.method === 'setup_link'
            ? `${fullName} has been added. A password setup link was emailed to ${emailAddress}.`
            : `${fullName} has been added with a temporary password. Share it securely — it is shown only once.`,
        teacher: { id: teacherRef.id, employeeId, username: usernameValue, fullName },
        activation: created.activation
    });
}));

/** Derive an available username from a person's name. */
async function suggestUsername(fullName) {
    const base = String(fullName).toLowerCase().trim()
        .replace(/[^a-z\s]/g, '')
        .replace(/\s+/g, '.')
        .slice(0, 28) || 'staff';

    for (let attempt = 0; attempt < 50; attempt++) {
        const candidate = attempt === 0 ? base : `${base}${attempt}`;
        const taken = await users().where('username', '==', candidate).limit(1).get();
        if (taken.empty) return candidate;
    }
    return `${base}.${Date.now().toString(36).slice(-4)}`;
}

router.put('/teachers/:id', asyncHandler(async (req, res) => {
    const teacherId = v.docId(req.params.id, 'Teacher id');
    const existing = docData(await teachers().doc(teacherId).get());
    if (!existing) throw new HttpError(404, 'Teacher not found.', 'NOT_FOUND');

    const updates = { updatedAt: serverTimestamp(), updatedBy: req.user.id };

    const fullName = v.str(req.body.fullName ?? req.body.full_name, 'Full name', { required: false, min: 2, max: 120 });
    if (fullName) updates.fullName = fullName;

    if (req.body.email !== undefined) updates.email = v.email(req.body.email, 'Email', { required: false }) || '';
    if (req.body.phone !== undefined) updates.phone = v.str(req.body.phone, 'Phone', { required: false, max: 32 }) || '';
    if (req.body.position !== undefined) updates.position = v.str(req.body.position, 'Position', { required: false, max: 80 }) || '';

    if (req.body.leaveEntitlementDays !== undefined) {
        updates.leaveEntitlementDays = v.num(req.body.leaveEntitlementDays, 'Leave entitlement', { min: 0, max: 365, integer: true });
    }

    const newScale = req.body.salaryScale ?? req.body.salary_scale;
    if (newScale && newScale !== existing.salaryScale) {
        const structure = docData(await salaryStructures().doc(String(newScale)).get());
        if (!structure) throw new HttpError(400, `There is no salary scale called "${newScale}".`, 'UNKNOWN_SCALE');
        updates.salaryScale = String(newScale);
        updates.salaryScaleChangedAt = serverTimestamp();
    }

    Object.assign(updates, readPaymentDetails(req.body));

    await teachers().doc(teacherId).update(updates);

    // Mirror contact details onto the login account.
    if (existing.userId && (fullName || req.body.email !== undefined || req.body.phone !== undefined)) {
        const accountUpdates = { updatedAt: serverTimestamp() };
        if (fullName) accountUpdates.fullName = fullName;
        if (req.body.email !== undefined) accountUpdates.email = updates.email;
        if (req.body.phone !== undefined) accountUpdates.phone = updates.phone;
        await users().doc(existing.userId).update(accountUpdates);
    }

    const changed = Object.keys(updates).filter(k => !['updatedAt', 'updatedBy'].includes(k));
    logAudit(req.user, 'UPDATE_TEACHER', `Updated ${existing.fullName} (${existing.employeeId}): ${changed.join(', ')}`, req.ip);

    if (updates.salaryScale && existing.userId) {
        await notify.notifyUser(existing.userId, {
            title: 'Your salary scale changed',
            message: `Your salary scale has been changed from ${existing.salaryScale} to ${updates.salaryScale}. This applies from the next payroll run.`,
            category: notify.CATEGORIES.account,
            actorId: req.user.id
        });
    }

    res.json({ message: 'Teacher updated.' });
}));

router.post('/teachers/:id/deactivate', asyncHandler(async (req, res) => {
    const teacherId = v.docId(req.params.id, 'Teacher id');
    const reason = v.str(req.body.reason, 'Reason', { required: false, max: 300 });

    const teacher = docData(await teachers().doc(teacherId).get());
    if (!teacher) throw new HttpError(404, 'Teacher not found.', 'NOT_FOUND');

    if (teacher.userId) {
        await accounts.deactivateAccount({ userId: teacher.userId, actor: req.user, reason });
    } else {
        await teachers().doc(teacherId).update({ isActive: false, updatedAt: serverTimestamp() });
    }

    logAudit(req.user, 'DEACTIVATE_TEACHER', `Deactivated ${teacher.fullName} (${teacher.employeeId})${reason ? `: ${reason}` : ''}`, req.ip);
    res.json({ message: `${teacher.fullName} has been deactivated and excluded from future payroll runs.` });
}));

router.post('/teachers/:id/reactivate', asyncHandler(async (req, res) => {
    const teacherId = v.docId(req.params.id, 'Teacher id');
    const teacher = docData(await teachers().doc(teacherId).get());
    if (!teacher) throw new HttpError(404, 'Teacher not found.', 'NOT_FOUND');

    if (teacher.userId) await accounts.reactivateAccount({ userId: teacher.userId, actor: req.user });
    else await teachers().doc(teacherId).update({ isActive: true, updatedAt: serverTimestamp() });

    logAudit(req.user, 'REACTIVATE_TEACHER', `Reactivated ${teacher.fullName} (${teacher.employeeId})`, req.ip);
    res.json({ message: `${teacher.fullName} has been reactivated.` });
}));

/**
 * Permanent deletion. Refused once the teacher appears on a payroll run, because
 * that history must survive; deactivation is the correct action in that case.
 */
router.delete('/teachers/:id', asyncHandler(async (req, res) => {
    const teacherId = v.docId(req.params.id, 'Teacher id');
    const teacher = docData(await teachers().doc(teacherId).get());
    if (!teacher) throw new HttpError(404, 'Teacher not found.', 'NOT_FOUND');

    if (teacher.userId) {
        await accounts.deleteAccount({ userId: teacher.userId, actor: req.user });
    } else {
        const onPayroll = await payrollItems().where('teacherId', '==', teacherId).limit(1).get();
        if (!onPayroll.empty) {
            throw new HttpError(409, 'This teacher appears on a payroll run. Deactivate the record instead of deleting it.', 'HAS_PAYROLL_HISTORY');
        }
        await teachers().doc(teacherId).delete();
    }

    logAudit(req.user, 'DELETE_TEACHER', `Deleted ${teacher.fullName} (${teacher.employeeId})`, req.ip);
    res.json({ message: `${teacher.fullName} has been permanently deleted.` });
}));

router.post('/teachers/:id/resend-setup', emailLimiter, asyncHandler(async (req, res) => {
    const teacherId = v.docId(req.params.id, 'Teacher id');
    const teacher = docData(await teachers().doc(teacherId).get());
    if (!teacher || !teacher.userId) throw new HttpError(404, 'Teacher not found.', 'NOT_FOUND');

    const result = await accounts.resendSetupLink({ userId: teacher.userId, req });
    logAudit(req.user, 'RESEND_SETUP_LINK', `Resent the setup link for ${teacher.fullName}`, req.ip);
    res.json({ message: `A new setup link has been sent to ${result.email}.`, ...result });
}));

// ===========================================================================
// Salary structures
// ===========================================================================
// The scale name is the document id, so one scale can only ever have one
// structure. The previous schema had no unique constraint, while the insert used
// ON CONFLICT (salary_scale) — which made every save fail.

router.get('/salary-structures', asyncHandler(async (req, res) => {
    const snap = await salaryStructures().get();
    res.json(docsData(snap).sort((a, b) => a.id.localeCompare(b.id)));
}));

router.post('/salary-structures', asyncHandler(async (req, res) => {
    const scale = v.str(req.body.salaryScale ?? req.body.salary_scale, 'Salary scale', { max: 60 });
    if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(scale)) {
        throw new HttpError(400, 'A salary scale name may contain only letters, numbers, spaces, hyphens and underscores.', 'INVALID_SCALE_NAME');
    }

    const existingSnap = await salaryStructures().doc(scale).get();
    const current = docData(existingSnap) || {};

    // An omitted field keeps its current value on an update, and falls back to
    // the default only when the scale is being created. Defaulting every absent
    // field to zero would let a partial save silently wipe someone's allowances.
    const amount = (camel, snake, label, fallback, max = 1e12) => {
        const supplied = req.body[camel] ?? req.body[snake];
        const parsed = v.num(supplied, label, { required: false, min: 0, max });
        if (parsed !== null) return parsed;
        return current[camel] !== undefined ? Number(current[camel]) : fallback;
    };

    const structure = {
        salaryScale: scale,
        basicSalary: amount('basicSalary', 'basic_salary', 'Basic salary',
            existingSnap.exists ? Number(current.basicSalary) : null),
        housingAllowance: amount('housingAllowance', 'housing_allowance', 'Housing allowance', 0),
        transportAllowance: amount('transportAllowance', 'transport_allowance', 'Transport allowance', 0),
        medicalAllowance: amount('medicalAllowance', 'medical_allowance', 'Medical allowance', 0),
        otherAllowance: amount('otherAllowance', 'other_allowance', 'Other allowance', 0),
        taxPercentage: amount('taxPercentage', 'tax_percentage', 'Tax percentage', 0, 100),
        nssfPercentage: amount('nssfPercentage', 'nssf_percentage', 'NSSF percentage', 5, 30),
        loanDeduction: amount('loanDeduction', 'loan_deduction', 'Loan deduction', 0),
        otherDeduction: amount('otherDeduction', 'other_deduction', 'Other deduction', 0),
        updatedAt: serverTimestamp(),
        updatedBy: req.user.id
    };

    // Basic salary is the one field a new scale cannot do without.
    if (structure.basicSalary === null || structure.basicSalary === undefined) {
        throw new HttpError(400, 'Basic salary is required.', 'VALIDATION_FAILED');
    }

    const existing = existingSnap;
    if (!existing.exists) structure.createdAt = serverTimestamp();

    await salaryStructures().doc(scale).set(structure, { merge: true });

    logAudit(
        req.user,
        existing.exists ? 'UPDATE_SALARY_STRUCTURE' : 'CREATE_SALARY_STRUCTURE',
        `${existing.exists ? 'Updated' : 'Created'} salary scale "${scale}" with basic ${structure.basicSalary}`,
        req.ip
    );

    res.json({
        message: `Salary scale "${scale}" ${existing.exists ? 'updated' : 'created'}.`,
        salaryScale: scale
    });
}));

router.delete('/salary-structures/:scale', asyncHandler(async (req, res) => {
    const scale = v.docId(req.params.scale, 'Salary scale');

    // Refuse while teachers still reference the scale, which would otherwise
    // leave them with no salary basis at the next payroll run.
    const inUse = await teachers().where('salaryScale', '==', scale).where('isActive', '==', true).limit(1).get();
    if (!inUse.empty) {
        const holder = docsData(inUse)[0];
        throw new HttpError(
            409,
            `"${scale}" is still assigned to at least one active teacher (${holder.fullName}). Move them to another scale first.`,
            'SCALE_IN_USE'
        );
    }

    await salaryStructures().doc(scale).delete();
    logAudit(req.user, 'DELETE_SALARY_STRUCTURE', `Deleted salary scale "${scale}"`, req.ip);
    res.json({ message: `Salary scale "${scale}" deleted.` });
}));

// ===========================================================================
// Leave
// ===========================================================================

router.get('/leave', asyncHandler(async (req, res) => {
    const status = req.query.status ? v.oneOf(req.query.status, ['Pending', 'Approved', 'Rejected', 'Cancelled'], 'Status') : null;

    let query = leaveRequests();
    if (status) query = query.where('status', '==', status);

    const snap = await query.orderBy('createdAt', 'desc').limit(500).get();
    const rows = docsData(snap);
    const teacherMap = await getManyByIds(teachers(), rows.map(r => r.teacherId));

    res.json(rows.map(request => {
        const teacher = teacherMap.get(request.teacherId);
        return {
            ...request,
            fullName: teacher?.fullName || 'Unknown teacher',
            employeeId: teacher?.employeeId || '-',
            isUnpaid: leaveService.isUnpaid(request.leaveType)
        };
    }));
}));

router.put('/leave/:id/status', asyncHandler(async (req, res) => {
    const requestId = v.docId(req.params.id, 'Leave request id');
    const status = v.oneOf(req.body.status, ['Approved', 'Rejected'], 'Status');
    const note = v.str(req.body.note, 'Note', { required: false, max: 300 });

    const request = docData(await leaveRequests().doc(requestId).get());
    if (!request) throw new HttpError(404, 'Leave request not found.', 'NOT_FOUND');
    if (request.status !== 'Pending') {
        throw new HttpError(400, `This request has already been ${request.status.toLowerCase()}.`, 'ALREADY_DECIDED');
    }

    const teacher = docData(await teachers().doc(request.teacherId).get());
    const config = await configService.getConfig();

    // Check the balance at approval time, not only at submission, because other
    // requests may have been approved in the meantime.
    if (status === 'Approved' && !leaveService.isUnpaid(request.leaveType)) {
        const balance = await leaveService.getBalance(request.teacherId, {
            entitlementDays: teacher?.leaveEntitlementDays ?? config.defaultAnnualLeaveDays,
            year: new Date(request.startDate).getUTCFullYear()
        });

        // The request's own days are inside `pendingDays`, so add them back.
        const availableExcludingThis = balance.remainingDays + Number(request.days || 0);
        if (Number(request.days || 0) > availableExcludingThis) {
            throw new HttpError(
                400,
                `${teacher?.fullName || 'This teacher'} has only ${availableExcludingThis} paid leave day(s) left in ${balance.year}, but this request is for ${request.days}. Reject it, or record it as unpaid leave.`,
                'INSUFFICIENT_LEAVE_BALANCE'
            );
        }
    }

    await leaveRequests().doc(requestId).update({
        status,
        decidedBy: req.user.id,
        decidedByName: req.user.fullName,
        decidedAt: serverTimestamp(),
        decisionNote: note || null,
        updatedAt: serverTimestamp()
    });

    if (teacher?.userId) {
        const unpaidNote = status === 'Approved' && leaveService.isUnpaid(request.leaveType)
            ? ' Because this is unpaid leave, your basic pay for the affected period will be reduced pro rata.'
            : '';

        await notify.notifyUser(teacher.userId, {
            title: `Leave request ${status.toLowerCase()}`,
            message: `Your ${request.leaveType.toLowerCase()} leave from ${request.startDate} to ${request.endDate} (${request.days} day(s)) was ${status.toLowerCase()}.`
                + `${note ? ` Note: ${note}` : ''}${unpaidNote}`,
            category: notify.CATEGORIES.leave,
            severity: status === 'Approved' ? 'success' : 'warning',
            actorId: req.user.id
        });
    }

    logAudit(req.user, 'DECIDE_LEAVE', `${status} leave request ${requestId} for ${teacher?.fullName || 'unknown teacher'}`, req.ip);
    res.json({ message: `Leave request ${status.toLowerCase()}.` });
}));

// ===========================================================================
// Advances
// ===========================================================================

router.get('/advances', asyncHandler(async (req, res) => {
    const status = req.query.status ? v.oneOf(req.query.status, advanceService.STATUSES, 'Status') : null;

    let query = advanceRequests();
    if (status) query = query.where('status', '==', status);

    const snap = await query.orderBy('createdAt', 'desc').limit(500).get();
    const rows = docsData(snap);
    const teacherMap = await getManyByIds(teachers(), rows.map(r => r.teacherId));
    const approverMap = await getManyByIds(users(), rows.map(r => r.approvedBy));

    res.json(rows.map(advance => {
        const teacher = teacherMap.get(advance.teacherId);
        return {
            ...advance,
            fullName: teacher?.fullName || 'Unknown teacher',
            employeeId: teacher?.employeeId || '-',
            approvedByName: approverMap.get(advance.approvedBy)?.fullName || null,
            outstanding: Math.max(0, Number(advance.amount || 0) - Number(advance.amountRepaid || 0)),
            instalmentAmount: advanceService.instalmentAmount(advance)
        };
    }));
}));

router.put('/advances/:id/status', asyncHandler(async (req, res) => {
    const advanceId = v.docId(req.params.id, 'Advance id');
    const status = v.oneOf(req.body.status, ['Approved', 'Rejected'], 'Status');
    const note = v.str(req.body.note, 'Note', { required: false, max: 300 });

    const advance = docData(await advanceRequests().doc(advanceId).get());
    if (!advance) throw new HttpError(404, 'Advance request not found.', 'NOT_FOUND');
    if (advance.status !== 'Pending') {
        throw new HttpError(400, `This advance has already been ${advance.status.toLowerCase()} and cannot be changed.`, 'ALREADY_DECIDED');
    }

    const config = await configService.getConfig();
    const instalments = v.num(req.body.instalments, 'Instalments', { required: false, min: 1, max: config.maxAdvanceInstalments, integer: true })
        ?? Number(advance.requestedInstalments || 1);

    await advanceRequests().doc(advanceId).update({
        status,
        instalments: status === 'Approved' ? instalments : Number(advance.requestedInstalments || 1),
        amountRepaid: 0,
        instalmentsPaid: 0,
        approvedBy: status === 'Approved' ? req.user.id : null,
        approvedAt: status === 'Approved' ? serverTimestamp() : null,
        rejectedBy: status === 'Rejected' ? req.user.id : null,
        rejectedAt: status === 'Rejected' ? serverTimestamp() : null,
        decisionNote: note || null,
        updatedAt: serverTimestamp()
    });

    const teacher = docData(await teachers().doc(advance.teacherId).get());
    if (teacher?.userId) {
        const perInstalment = Math.round((Number(advance.amount) / instalments) * 100) / 100;
        await notify.notifyUser(teacher.userId, {
            title: `Salary advance ${status.toLowerCase()}`,
            message: status === 'Approved'
                ? `Your advance of ${Number(advance.amount).toLocaleString()} was approved and will be recovered over ${instalments} payroll run(s) `
                  + `at about ${perInstalment.toLocaleString()} each.${note ? ` Note: ${note}` : ''}`
                : `Your advance request of ${Number(advance.amount).toLocaleString()} was rejected.${note ? ` Note: ${note}` : ''}`,
            category: notify.CATEGORIES.advance,
            severity: status === 'Approved' ? 'success' : 'warning',
            actorId: req.user.id
        });
    }

    logAudit(req.user, 'DECIDE_ADVANCE', `${status} advance ${advanceId} of ${advance.amount} for ${teacher?.fullName || 'unknown teacher'}`, req.ip);
    res.json({ message: `Advance request ${status.toLowerCase()}.` });
}));

// ===========================================================================
// Payroll approval
// ===========================================================================

/**
 * Approve a processed payroll run.
 *
 * Only HR may approve, including when an administrator is using these routes:
 * processing and approving must stay in different hands.
 */
router.post('/payroll/:id/approve', asyncHandler(async (req, res) => {
    if (req.user.role !== 'hr') {
        throw new HttpError(
            403,
            'Only an HR user can approve payroll. This separation stops one person from both processing and approving a payment run.',
            'HR_ONLY'
        );
    }

    const payrollId = v.docId(req.params.id, 'Payroll id');
    const run = docData(await payroll().doc(payrollId).get());
    if (!run) throw new HttpError(404, 'Payroll run not found.', 'NOT_FOUND');
    if (run.status !== 'processed') {
        throw new HttpError(400, `Only a processed payroll run can be approved — this one is "${run.status}".`, 'INVALID_STATUS');
    }
    if (run.processedBy === req.user.id) {
        throw new HttpError(403, 'You processed this payroll run, so you cannot also approve it.', 'SELF_APPROVAL');
    }

    await payroll().doc(payrollId).update({
        status: 'approved',
        approvedBy: req.user.id,
        approvedByName: req.user.fullName,
        approvedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    });

    const itemSnap = await payrollItems().where('payrollId', '==', payrollId).get();
    const items = docsData(itemSnap);
    const teacherMap = await getManyByIds(teachers(), items.map(i => i.teacherId));
    const config = await configService.getConfig();
    const period = `${run.month}/${run.year}`;

    // Tell each teacher their own figure.
    await notify.notifyUsersIndividually(items.map(item => {
        const teacher = teacherMap.get(item.teacherId);
        if (!teacher?.userId) return null;
        return {
            userId: teacher.userId,
            title: 'Your payslip is ready',
            message: `Your salary for ${period} has been approved. Net pay: ${config.currency} ${Number(item.netSalary).toLocaleString()}.`,
            category: notify.CATEGORIES.payroll,
            severity: 'success',
            actorId: req.user.id
        };
    }).filter(Boolean));

    // Tell the accountants it is now payable.
    await notify.notifyRoles(['accountant'], {
        title: 'Payroll approved — ready for payment',
        message: `Payroll for ${period} was approved by ${req.user.fullName}. `
            + `${items.length} employee(s), net total ${config.currency} ${Number(run.totalNet).toLocaleString()}.`,
        category: notify.CATEGORIES.payroll,
        severity: 'info',
        actorId: req.user.id
    });

    logAudit(req.user, 'APPROVE_PAYROLL', `Approved payroll ${period} (${items.length} employees, net ${run.totalNet})`, req.ip);

    res.json({ message: `Payroll for ${period} approved and released to the accountant for payment.` });
}));

/** Send a processed run back for correction. */
router.post('/payroll/:id/reject', asyncHandler(async (req, res) => {
    if (req.user.role !== 'hr') {
        throw new HttpError(403, 'Only an HR user can reject payroll.', 'HR_ONLY');
    }

    const payrollId = v.docId(req.params.id, 'Payroll id');
    const reason = v.str(req.body.reason, 'Reason', { min: 3, max: 400 });

    const run = docData(await payroll().doc(payrollId).get());
    if (!run) throw new HttpError(404, 'Payroll run not found.', 'NOT_FOUND');
    if (run.status !== 'processed') {
        throw new HttpError(400, `Only a processed payroll run can be rejected — this one is "${run.status}".`, 'INVALID_STATUS');
    }

    await payroll().doc(payrollId).update({
        status: 'rejected',
        rejectedBy: req.user.id,
        rejectedByName: req.user.fullName,
        rejectedAt: serverTimestamp(),
        rejectionReason: reason,
        updatedAt: serverTimestamp()
    });

    await notify.notifyRoles(['accountant'], {
        title: 'Payroll returned for correction',
        message: `Payroll for ${run.month}/${run.year} was returned by ${req.user.fullName}. Reason: ${reason}`,
        category: notify.CATEGORIES.payroll,
        severity: 'warning',
        actorId: req.user.id
    });

    logAudit(req.user, 'REJECT_PAYROLL', `Returned payroll ${run.month}/${run.year}: ${reason}`, req.ip);
    res.json({ message: 'Payroll returned to the accountant for correction.' });
}));

// ===========================================================================
// Reports and stats
// ===========================================================================

router.get('/reports/payroll-summary', asyncHandler(async (req, res) => {
    const snap = await payroll().orderBy('year', 'desc').orderBy('month', 'desc').limit(120).get();
    res.json(docsData(snap));
}));

router.get('/stats', asyncHandler(async (req, res) => {
    const [teacherCount, haltedCount, payrollCount, recentRun, pendingLeave, pendingAdvances, awaitingApproval, pendingActivation] =
        await Promise.all([
            teachers().where('isActive', '==', true).count().get(),
            teachers().where('isActive', '==', true).where('payrollHalted', '==', true).count().get(),
            payroll().count().get(),
            payroll().orderBy('createdAt', 'desc').limit(1).get(),
            leaveRequests().where('status', '==', 'Pending').count().get(),
            advanceRequests().where('status', '==', 'Pending').count().get(),
            payroll().where('status', '==', 'processed').count().get(),
            users().where('role', '==', 'teacher').where('passwordSetupCompleted', '==', false).count().get()
        ]);

    res.json({
        totalTeachers: teacherCount.data().count,
        haltedTeachers: haltedCount.data().count,
        totalPayrolls: payrollCount.data().count,
        pendingLeave: pendingLeave.data().count,
        pendingAdvances: pendingAdvances.data().count,
        awaitingApproval: awaitingApproval.data().count,
        pendingActivation: pendingActivation.data().count,
        recentPayroll: recentRun.empty ? null : docData(recentRun.docs[0])
    });
}));

module.exports = router;
