const express = require('express');
const router = express.Router();

const {
    users, teachers, accountants, payroll, payrollItems, salaryStructures,
    leaveRequests, advanceRequests, systemConfig, serverTimestamp, docData, docsData,
    getManyByIds, FieldValue
} = require('../firebase');
const {
    authenticateToken, authorizeRoles, requirePasswordChanged,
    asyncHandler, HttpError, invalidateUserCache, emailLimiter
} = require('../middleware');
const v = require('../services/validate');
const pw = require('../services/passwords');
const accounts = require('../services/accounts');
const configService = require('../services/config');
const { logAudit, listAudit } = require('../services/audit');
const notify = require('../services/notifications');

router.use(authenticateToken, authorizeRoles('admin'), requirePasswordChanged);

const ROLES = ['admin', 'hr', 'accountant', 'teacher'];

/** Strip secrets from a user document before it leaves the server. */
function safeUser(user) {
    const {
        password, mfaSecret, mfaPendingCodeHash, mfaPendingTokenHash,
        passwordSetupTokenHash, ...rest
    } = user;
    return {
        ...rest,
        isActive: user.isActive !== false,
        activationPending: user.passwordSetupCompleted === false
    };
}

// ===========================================================================
// Users
// ===========================================================================

router.get('/users', asyncHandler(async (req, res) => {
    const role = req.query.role ? v.oneOf(req.query.role, ROLES, 'Role') : null;

    let query = users();
    if (role) query = query.where('role', '==', role);

    const snap = await query.orderBy('createdAt', 'desc').limit(1000).get();
    res.json(docsData(snap).map(safeUser));
}));

/**
 * Create a staff account. Teachers are created through the HR routes, which also
 * capture the payroll fields a teacher record needs.
 */
async function createStaff(req, res, role) {
    const fullName = v.str(req.body.fullName ?? req.body.full_name, 'Full name', { min: 2, max: 120 });
    const usernameValue = v.username(req.body.username);
    const emailAddress = v.email(req.body.email, 'Email', { required: false });
    const phone = v.str(req.body.phone, 'Phone', { required: false, max: 32 });

    let result;
    try {
        result = await accounts.createAccount({
            username: usernameValue,
            role,
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

    if (role === 'accountant') {
        const employeeId = await accounts.allocateEmployeeId('accountant');
        await accountants().add({
            userId: result.userId,
            employeeId,
            fullName,
            email: emailAddress || '',
            phone: phone || '',
            department: v.str(req.body.department, 'Department', { required: false, max: 80 }) || '',
            dateJoined: v.isoDate(req.body.dateJoined ?? req.body.date_joined, 'Date joined', { required: false })
                || new Date().toISOString().slice(0, 10),
            isActive: true,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });
        result.employeeId = employeeId;
    }

    logAudit(req.user, `CREATE_${role.toUpperCase()}`, `Created ${role} account "${usernameValue}" (${fullName})`, req.ip);

    res.status(201).json({
        message: result.activation.method === 'setup_link'
            ? `Account created. A setup link has been emailed to ${emailAddress}.`
            : 'Account created with a temporary password. Share it securely — it is shown only once.',
        userId: result.userId,
        username: usernameValue,
        employeeId: result.employeeId,
        activation: result.activation
    });
}

router.post('/users', asyncHandler(async (req, res) => {
    const role = v.oneOf(req.body.role, ['admin', 'hr', 'accountant'], 'Role');
    await createStaff(req, res, role);
}));

router.post('/admins', asyncHandler((req, res) => createStaff(req, res, 'admin')));
router.post('/hr', asyncHandler((req, res) => createStaff(req, res, 'hr')));
router.post('/accountants', asyncHandler((req, res) => createStaff(req, res, 'accountant')));

router.get('/admins', asyncHandler(async (req, res) => {
    const snap = await users().where('role', '==', 'admin').orderBy('createdAt', 'desc').get();
    res.json(docsData(snap).map(safeUser));
}));

router.get('/hr', asyncHandler(async (req, res) => {
    const snap = await users().where('role', '==', 'hr').orderBy('createdAt', 'desc').get();
    res.json(docsData(snap).map(safeUser));
}));

router.get('/accountants', asyncHandler(async (req, res) => {
    const snap = await accountants().orderBy('createdAt', 'desc').get();
    const rows = docsData(snap);
    const userMap = await getManyByIds(users(), rows.map(r => r.userId));

    res.json(rows.map(row => {
        const account = userMap.get(row.userId);
        return {
            ...row,
            username: account?.username || null,
            accountActive: account ? account.isActive !== false : false,
            activationPending: account ? account.passwordSetupCompleted === false : false
        };
    }));
}));

/** Shared profile update for any staff account. */
async function updateStaff(req, res, expectedRole) {
    const userId = v.docId(req.params.id, 'User id');
    const existing = docData(await users().doc(userId).get());
    if (!existing) throw new HttpError(404, 'Account not found.', 'USER_NOT_FOUND');
    if (expectedRole && existing.role !== expectedRole) {
        throw new HttpError(400, `That account is not a ${expectedRole} account.`, 'ROLE_MISMATCH');
    }

    const updates = { updatedAt: serverTimestamp() };
    const fullName = v.str(req.body.fullName ?? req.body.full_name, 'Full name', { required: false, min: 2, max: 120 });
    const emailAddress = req.body.email !== undefined ? v.email(req.body.email, 'Email', { required: false }) : undefined;
    const phone = req.body.phone !== undefined ? v.str(req.body.phone, 'Phone', { required: false, max: 32 }) : undefined;

    if (fullName) updates.fullName = fullName;
    if (emailAddress !== undefined) updates.email = emailAddress || '';
    if (phone !== undefined) updates.phone = phone || '';

    // A role change rewrites permissions, so existing sessions must be revoked.
    if (req.body.role && req.body.role !== existing.role) {
        const newRole = v.oneOf(req.body.role, ROLES, 'Role');
        if (existing.role === 'teacher' || newRole === 'teacher') {
            throw new HttpError(
                400,
                'Teacher accounts cannot be converted to or from another role, because they are tied to a payroll record.',
                'ROLE_CHANGE_UNSUPPORTED'
            );
        }
        if (existing.role === 'admin') await accountsAssertNotLastAdmin(existing);
        updates.role = newRole;
        updates.tokenVersion = FieldValue.increment(1);
    }

    await users().doc(userId).update(updates);
    invalidateUserCache(userId);

    // Keep the role profile in step with the account.
    const profile = await accounts.findProfileByUserId(userId, updates.role || existing.role);
    if (profile) {
        const profileUpdates = { updatedAt: serverTimestamp() };
        if (fullName) profileUpdates.fullName = fullName;
        if (emailAddress !== undefined) profileUpdates.email = emailAddress || '';
        if (phone !== undefined) profileUpdates.phone = phone || '';
        if (req.body.department !== undefined) {
            profileUpdates.department = v.str(req.body.department, 'Department', { required: false, max: 80 }) || '';
        }
        await profile.ref.update(profileUpdates);
    }

    logAudit(req.user, 'UPDATE_USER', `Updated ${existing.role} account "${existing.username}"`, req.ip);
    res.json({ message: 'Account updated.' });
}

async function accountsAssertNotLastAdmin(user) {
    const snap = await users().where('role', '==', 'admin').where('isActive', '==', true).count().get();
    if (snap.data().count <= 1) {
        throw new HttpError(400, 'This is the only active administrator account, so its role cannot be changed.', 'LAST_ADMIN');
    }
}

router.put('/users/:id', asyncHandler((req, res) => updateStaff(req, res, null)));
router.put('/admins/:id', asyncHandler((req, res) => updateStaff(req, res, 'admin')));
router.put('/hr/:id', asyncHandler((req, res) => updateStaff(req, res, 'hr')));

router.put('/accountants/:id', asyncHandler(async (req, res) => {
    const accountantId = v.docId(req.params.id, 'Accountant id');
    const profile = docData(await accountants().doc(accountantId).get());
    if (!profile) throw new HttpError(404, 'Accountant not found.', 'NOT_FOUND');

    req.params.id = profile.userId;
    await updateStaff(req, res, 'accountant');
}));

// --- Status changes ---------------------------------------------------------

router.post('/users/:id/deactivate', asyncHandler(async (req, res) => {
    const userId = v.docId(req.params.id, 'User id');
    const reason = v.str(req.body.reason, 'Reason', { required: false, max: 300 });

    const user = await accounts.deactivateAccount({ userId, actor: req.user, reason });
    invalidateUserCache(userId);
    logAudit(req.user, 'DEACTIVATE_USER', `Deactivated "${user.username}"${reason ? `: ${reason}` : ''}`, req.ip);

    res.json({ message: `${user.fullName} has been deactivated and signed out of all sessions.`, isActive: false });
}));

router.post('/users/:id/reactivate', asyncHandler(async (req, res) => {
    const userId = v.docId(req.params.id, 'User id');
    const user = await accounts.reactivateAccount({ userId, actor: req.user });
    invalidateUserCache(userId);
    logAudit(req.user, 'REACTIVATE_USER', `Reactivated "${user.username}"`, req.ip);

    res.json({ message: `${user.fullName} has been reactivated.`, isActive: true });
}));

/** Retained for the existing UI control; routes to deactivate/reactivate. */
router.post('/users/:id/toggle-status', asyncHandler(async (req, res) => {
    const userId = v.docId(req.params.id, 'User id');
    const existing = docData(await users().doc(userId).get());
    if (!existing) throw new HttpError(404, 'Account not found.', 'USER_NOT_FOUND');

    if (existing.isActive === false) {
        const user = await accounts.reactivateAccount({ userId, actor: req.user });
        invalidateUserCache(userId);
        logAudit(req.user, 'REACTIVATE_USER', `Reactivated "${user.username}"`, req.ip);
        return res.json({ message: `${user.fullName} has been reactivated.`, isActive: true });
    }

    const user = await accounts.deactivateAccount({ userId, actor: req.user });
    invalidateUserCache(userId);
    logAudit(req.user, 'DEACTIVATE_USER', `Deactivated "${user.username}"`, req.ip);
    res.json({ message: `${user.fullName} has been deactivated.`, isActive: false });
}));

async function deleteStaff(req, res, lookup) {
    const userId = await lookup(req);
    const user = await accounts.deleteAccount({ userId, actor: req.user });
    invalidateUserCache(userId);
    logAudit(req.user, 'DELETE_USER', `Permanently deleted ${user.role} account "${user.username}"`, req.ip);
    res.json({ message: `${user.fullName} has been permanently deleted.` });
}

router.delete('/users/:id', asyncHandler((req, res) => deleteStaff(req, res, r => v.docId(r.params.id, 'User id'))));
router.delete('/admins/:id', asyncHandler((req, res) => deleteStaff(req, res, r => v.docId(r.params.id, 'User id'))));
router.delete('/hr/:id', asyncHandler((req, res) => deleteStaff(req, res, r => v.docId(r.params.id, 'User id'))));

router.delete('/accountants/:id', asyncHandler((req, res) => deleteStaff(req, res, async (r) => {
    const profile = docData(await accountants().doc(v.docId(r.params.id, 'Accountant id')).get());
    if (!profile) throw new HttpError(404, 'Accountant not found.', 'NOT_FOUND');
    return profile.userId;
})));

// --- Credentials -----------------------------------------------------------

/**
 * Issue a new temporary password. The value is returned once, for out-of-band
 * delivery; administrators can no longer set a password of their choosing on
 * someone else's account.
 */
router.post('/users/:id/reset-password', asyncHandler(async (req, res) => {
    const userId = v.docId(req.params.id, 'User id');
    const user = docData(await users().doc(userId).get());
    if (!user) throw new HttpError(404, 'Account not found.', 'USER_NOT_FOUND');

    const temporaryPassword = pw.generateTemporaryPassword();

    await users().doc(userId).update({
        password: await pw.hash(temporaryPassword),
        mustChangePassword: true,
        passwordSetupCompleted: true,
        passwordChangedAt: serverTimestamp(),
        tokenVersion: FieldValue.increment(1),
        updatedAt: serverTimestamp()
    });
    invalidateUserCache(userId);

    await notify.notifyUser(userId, {
        title: 'Your password was reset',
        message: 'An administrator reset your password. You will be asked to choose a new one when you next sign in.',
        category: notify.CATEGORIES.account,
        severity: 'warning',
        actorId: req.user.id
    });

    logAudit(req.user, 'RESET_PASSWORD', `Issued a temporary password for "${user.username}"`, req.ip);

    res.json({
        message: 'A temporary password has been generated. Share it securely — it is shown only once.',
        temporaryPassword,
        mustChangePassword: true
    });
}));

router.post('/users/:id/resend-setup', emailLimiter, asyncHandler(async (req, res) => {
    const userId = v.docId(req.params.id, 'User id');
    const result = await accounts.resendSetupLink({ userId, req });
    logAudit(req.user, 'RESEND_SETUP_LINK', `Resent the setup link for user ${userId}`, req.ip);
    res.json({ message: `A new setup link has been sent to ${result.email}.`, ...result });
}));

/** Turn two-factor authentication on or off for an account. */
router.post('/users/:id/mfa', asyncHandler(async (req, res) => {
    const userId = v.docId(req.params.id, 'User id');
    const enabled = v.bool(req.body.enabled, true);

    const user = docData(await users().doc(userId).get());
    if (!user) throw new HttpError(404, 'Account not found.', 'USER_NOT_FOUND');
    if (enabled && !user.email) {
        throw new HttpError(400, 'Add an email address to this account before enabling two-factor authentication.', 'NO_EMAIL');
    }

    await users().doc(userId).update({
        mfaEnabled: enabled,
        mfaPendingTokenHash: FieldValue.delete(),
        mfaPendingCodeHash: FieldValue.delete(),
        mfaPendingExpiresAt: FieldValue.delete(),
        mfaPendingAttempts: FieldValue.delete(),
        updatedAt: serverTimestamp()
    });
    invalidateUserCache(userId);

    logAudit(req.user, enabled ? 'MFA_ENABLED' : 'MFA_DISABLED', `Two-factor authentication ${enabled ? 'enabled' : 'disabled'} for "${user.username}"`, req.ip);
    res.json({ message: `Two-factor authentication ${enabled ? 'enabled' : 'disabled'} for ${user.fullName}.`, mfaEnabled: enabled });
}));

/**
 * Two-factor activity view.
 *
 * This replaces the old "MFA portal", which displayed live one-time codes in
 * plain text and therefore let any administrator sign in as any other user. It
 * now reports only *that* a challenge is outstanding, never the code itself.
 */
router.get('/mfa-status', asyncHandler(async (req, res) => {
    const snap = await users().where('mfaPendingExpiresAt', '>', new Date()).get();

    res.json(docsData(snap).map(user => ({
        userId: user.id,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
        method: user.mfaMethod === 'authenticator' && user.mfaSecret ? 'authenticator' : 'email',
        maskedEmail: user.email ? `${user.email[0]}***@${user.email.split('@')[1] || ''}` : null,
        attempts: Number(user.mfaPendingAttempts || 0),
        expiresAt: user.mfaPendingExpiresAt,
        sentAt: user.mfaLastSentAt || null
    })));
}));

// ===========================================================================
// System configuration
// ===========================================================================

router.get('/config', asyncHandler(async (req, res) => {
    res.json(await configService.getConfig({ fresh: true }));
}));

router.put('/config', asyncHandler(async (req, res) => {
    const payload = { ...req.body };

    // Guard the numeric policy settings so a typo cannot make payroll nonsensical.
    if (payload.nssfEmployeePercentage !== undefined) v.num(payload.nssfEmployeePercentage, 'NSSF employee percentage', { min: 0, max: 30 });
    if (payload.nssfEmployerPercentage !== undefined) v.num(payload.nssfEmployerPercentage, 'NSSF employer percentage', { min: 0, max: 30 });
    if (payload.minimumNetPercentage !== undefined) v.num(payload.minimumNetPercentage, 'Minimum net percentage', { min: 0, max: 90 });
    if (payload.maxAdvancePercentage !== undefined) v.num(payload.maxAdvancePercentage, 'Maximum advance percentage', { min: 0, max: 100 });
    if (payload.defaultAnnualLeaveDays !== undefined) v.num(payload.defaultAnnualLeaveDays, 'Annual leave days', { min: 0, max: 365, integer: true });
    if (payload.maxAdvanceInstalments !== undefined) v.num(payload.maxAdvanceInstalments, 'Maximum advance instalments', { min: 1, max: 24, integer: true });
    if (payload.taxMode !== undefined) v.oneOf(payload.taxMode, ['banded', 'flat', 'none'], 'Tax mode');
    if (payload.schoolName !== undefined) v.str(payload.schoolName, 'School name', { max: 120 });
    if (payload.currency !== undefined) v.str(payload.currency, 'Currency', { max: 8 });

    const applied = await configService.updateConfig(payload);
    logAudit(req.user, 'UPDATE_CONFIG', `Updated settings: ${Object.keys(applied).join(', ')}`, req.ip);
    res.json({ message: 'Settings saved.', config: applied });
}));

// ===========================================================================
// Audit log
// ===========================================================================

router.get('/audit-log', asyncHandler(async (req, res) => {
    const result = await listAudit({
        limit: req.query.limit,
        cursor: req.query.cursor || null,
        action: req.query.action || null,
        username: req.query.username || null,
        since: req.query.since || null
    });
    res.json(result);
}));

// ===========================================================================
// Reports, backup, stats
// ===========================================================================

router.get('/reports/payroll-summary', asyncHandler(async (req, res) => {
    const snap = await payroll().orderBy('year', 'desc').orderBy('month', 'desc').limit(120).get();
    res.json(docsData(snap));
}));

/**
 * JSON export of the operational collections.
 *
 * Firebase takes managed backups of Firestore itself; this endpoint exists for
 * ad-hoc inspection and migration, and deliberately omits credential fields.
 */
router.get('/backup', asyncHandler(async (req, res) => {
    const [userSnap, teacherSnap, accountantSnap, payrollSnap, itemSnap, structureSnap, configSnap, leaveSnap, advanceSnap] =
        await Promise.all([
            users().get(), teachers().get(), accountants().get(), payroll().get(),
            payrollItems().get(), salaryStructures().get(), systemConfig().get(),
            leaveRequests().get(), advanceRequests().get()
        ]);

    const backup = {
        exportedAt: new Date().toISOString(),
        exportedBy: req.user.username,
        projectId: process.env.FIREBASE_PROJECT_ID || 'edupay-ug',
        users: docsData(userSnap).map(safeUser),
        teachers: docsData(teacherSnap),
        accountants: docsData(accountantSnap),
        payroll: docsData(payrollSnap),
        payrollItems: docsData(itemSnap),
        salaryStructures: docsData(structureSnap),
        systemConfig: docsData(configSnap),
        leaveRequests: docsData(leaveSnap),
        advanceRequests: docsData(advanceSnap)
    };

    logAudit(req.user, 'BACKUP_EXPORTED', 'Downloaded a JSON data export', req.ip);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="edupay_backup_${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(backup, null, 2));
}));

router.get('/stats', asyncHandler(async (req, res) => {
    const [totalUsers, activeAdmins, activeHr, activeAccountants, activeTeachers, payrollCount, recentPayroll, pendingActivation] =
        await Promise.all([
            users().count().get(),
            users().where('role', '==', 'admin').where('isActive', '==', true).count().get(),
            users().where('role', '==', 'hr').where('isActive', '==', true).count().get(),
            users().where('role', '==', 'accountant').where('isActive', '==', true).count().get(),
            users().where('role', '==', 'teacher').where('isActive', '==', true).count().get(),
            payroll().count().get(),
            payroll().orderBy('createdAt', 'desc').limit(1).get(),
            users().where('passwordSetupCompleted', '==', false).count().get()
        ]);

    res.json({
        totalUsers: totalUsers.data().count,
        totalAdmins: activeAdmins.data().count,
        totalHr: activeHr.data().count,
        totalAccountants: activeAccountants.data().count,
        totalTeachers: activeTeachers.data().count,
        totalPayrolls: payrollCount.data().count,
        pendingActivation: pendingActivation.data().count,
        recentPayroll: recentPayroll.empty ? null : docData(recentPayroll.docs[0])
    });
}));

module.exports = router;
