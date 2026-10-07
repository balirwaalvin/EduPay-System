const express = require('express');
const router = express.Router();

const db = require('../db');
const {
    authenticateToken, authorizeRoles, requirePasswordChanged,
    asyncHandler, HttpError, invalidateUserCache, emailLimiter
} = require('../middleware');
const v = require('../services/validate');
const pw = require('../services/passwords');
const accounts = require('../services/accounts');
const configService = require('../services/config');
const { logAudit, listAudit, listActions } = require('../services/audit');
const notify = require('../services/notifications');
const avatars = require('../services/avatars');

router.use(authenticateToken, authorizeRoles('admin'), requirePasswordChanged);

const ROLES = ['admin', 'hr', 'accountant', 'teacher'];
const STAFF_ROLES = ['admin', 'hr', 'accountant'];

// Columns safe to return: no password hash, no MFA secret, no token hashes.
const SAFE_USER_COLUMNS = `
    id, username, role, full_name, email, phone, is_active,
    must_change_password, mfa_enabled, mfa_method,
    (NOT password_setup_completed) AS activation_pending,
    last_login_at, created_at, updated_at, deactivated_at, deactivation_reason`;

// ===========================================================================
// Accounts
// ===========================================================================

router.get('/users', asyncHandler(async (req, res) => {
    const role = req.query.role ? v.oneOf(req.query.role, ROLES, 'Role') : null;

    const users = await db.query(
        `SELECT ${SAFE_USER_COLUMNS} FROM users
          WHERE ($1::text IS NULL OR role = $1)
          ORDER BY created_at DESC
          LIMIT 2000`,
        [role]
    );

    /* A flag rather than the picture itself: 2000 rows each carrying a base64
       image would be a response measured in megabytes. The profile view asks
       for the one it needs. */
    const withAvatars = await avatars.summaryFor(users.map(u => u.id));
    for (const user of users) {
        user.hasAvatar = withAvatars.has(String(user.id));
        user.avatarUpdatedAt = withAvatars.get(String(user.id)) || null;
    }

    res.json(users);
}));

/**
 * One account in full, for the profile view: everything the list shows, plus
 * the fields it has no room for and the picture itself.
 */
router.get('/users/:id', asyncHandler(async (req, res) => {
    const userId = v.num(req.params.id, 'User id', { integer: true, min: 1 });

    const user = await db.queryOne(
        `SELECT ${SAFE_USER_COLUMNS},
                password_changed_at, last_logout_at, created_by, deactivated_by, reactivated_at,
                (SELECT full_name FROM users c WHERE c.id = users.created_by)     AS created_by_name,
                (SELECT full_name FROM users d WHERE d.id = users.deactivated_by) AS deactivated_by_name
           FROM users WHERE id = $1`,
        [userId]
    );
    if (!user) throw new HttpError(404, 'Account not found.', 'USER_NOT_FOUND');

    user.avatar = await avatars.asDataUrl(userId);

    // What this account has been doing, so the profile answers "is this person
    // actually using it?" without a trip to the audit page.
    user.recentActivity = await db.query(
        `SELECT action, details, created_at, ip_address
           FROM audit_log WHERE user_id = $1
          ORDER BY created_at DESC LIMIT 8`,
        [userId]
    );

    res.json(user);
}));

/**
 * Upload or replace a profile picture.
 *
 * Administrator-only, which this router enforces for every route on it — see
 * the `authorizeRoles('admin')` at the top. There is deliberately no route by
 * which an account can set its own picture.
 */
router.put('/users/:id/avatar', asyncHandler(async (req, res) => {
    const userId = v.num(req.params.id, 'User id', { integer: true, min: 1 });

    const user = await db.queryOne('SELECT id, username, full_name FROM users WHERE id = $1', [userId]);
    if (!user) throw new HttpError(404, 'Account not found.', 'USER_NOT_FOUND');

    // Everything about the image is re-derived from its bytes in here.
    const stored = await avatars.save(userId, req.body?.image, req.user.id);

    logAudit(req.user, 'UPDATE_AVATAR',
        `Set a profile picture for "${user.username}" (${stored.width}x${stored.height}, ${stored.byteSize} bytes)`,
        req.ip);

    res.json({
        message: 'Profile picture updated.',
        avatar: await avatars.asDataUrl(userId),
        ...stored
    });
}));

/** Just the picture, for the thumbnails in the account list. */
router.get('/users/:id/avatar', asyncHandler(async (req, res) => {
    const userId = v.num(req.params.id, 'User id', { integer: true, min: 1 });
    const avatar = await avatars.asDataUrl(userId);
    if (!avatar) throw new HttpError(404, 'That account has no profile picture.', 'AVATAR_NOT_FOUND');
    res.json({ avatar });
}));

router.delete('/users/:id/avatar', asyncHandler(async (req, res) => {
    const userId = v.num(req.params.id, 'User id', { integer: true, min: 1 });

    const user = await db.queryOne('SELECT id, username FROM users WHERE id = $1', [userId]);
    if (!user) throw new HttpError(404, 'Account not found.', 'USER_NOT_FOUND');

    const removed = await avatars.remove(userId);
    if (!removed) throw new HttpError(404, 'That account has no profile picture.', 'AVATAR_NOT_FOUND');

    logAudit(req.user, 'UPDATE_AVATAR', `Removed the profile picture for "${user.username}"`, req.ip);

    res.json({ message: 'Profile picture removed.' });
}));

router.get('/admins', asyncHandler(async (req, res) => {
    res.json(await db.query(
        `SELECT ${SAFE_USER_COLUMNS} FROM users WHERE role = 'admin' ORDER BY created_at DESC`
    ));
}));

router.get('/hr', asyncHandler(async (req, res) => {
    res.json(await db.query(
        `SELECT ${SAFE_USER_COLUMNS} FROM users WHERE role = 'hr' ORDER BY created_at DESC`
    ));
}));

router.get('/accountants', asyncHandler(async (req, res) => {
    // A single join replaces the batched point reads the document store needed.
    res.json(await db.query(
        `SELECT a.id, a.user_id, a.employee_id, a.full_name, a.email, a.phone,
                a.department, a.date_joined, a.is_active, a.created_at,
                u.username,
                u.is_active AS account_active,
                (NOT u.password_setup_completed) AS activation_pending
           FROM accountants a
           JOIN users u ON u.id = a.user_id
          ORDER BY a.created_at DESC`
    ));
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
    const department = v.str(req.body.department, 'Department', { required: false, max: 80 });
    const dateJoined = v.isoDate(req.body.dateJoined ?? req.body.date_joined, 'Date joined', { required: false })
        || new Date().toISOString().slice(0, 10);

    // The account and its profile are created together, so a failure leaves
    // neither behind.
    const result = await db.withTransaction(async (client) => {
        const created = await accounts.createAccount({
            username: usernameValue, role, fullName, emailAddress, phone,
            actor: req.user, req, client
        });

        if (role === 'accountant') {
            const employeeId = await accounts.allocateEmployeeId('accountant', client);
            await client.query(
                `INSERT INTO accountants (user_id, employee_id, full_name, email, phone, department, date_joined)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [created.userId, employeeId, fullName, emailAddress || null, phone || null,
                    department || null, dateJoined]
            );
            created.employeeId = employeeId;
        }

        return created;
    });

    logAudit(req.user, `CREATE_${role.toUpperCase()}`,
        `Created ${role} account "${usernameValue}" (${fullName})`, req.ip);

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
    const role = v.oneOf(req.body.role, STAFF_ROLES, 'Role');
    await createStaff(req, res, role);
}));

router.post('/admins', asyncHandler((req, res) => createStaff(req, res, 'admin')));
router.post('/hr', asyncHandler((req, res) => createStaff(req, res, 'hr')));
router.post('/accountants', asyncHandler((req, res) => createStaff(req, res, 'accountant')));

/** Shared profile update for any staff account. */
async function updateStaff(req, res, expectedRole) {
    const userId = v.num(req.params.id, 'User id', { integer: true, min: 1 });

    const existing = await db.queryOne('SELECT id, username, role FROM users WHERE id = $1', [userId]);
    if (!existing) throw new HttpError(404, 'Account not found.', 'USER_NOT_FOUND');
    if (expectedRole && existing.role !== expectedRole) {
        throw new HttpError(400, `That account is not a ${expectedRole} account.`, 'ROLE_MISMATCH');
    }

    const fullName = v.str(req.body.fullName ?? req.body.full_name, 'Full name',
        { required: false, min: 2, max: 120 });
    const emailAddress = req.body.email !== undefined
        ? v.email(req.body.email, 'Email', { required: false }) : undefined;
    const phone = req.body.phone !== undefined
        ? v.str(req.body.phone, 'Phone', { required: false, max: 32 }) : undefined;
    const department = req.body.department !== undefined
        ? v.str(req.body.department, 'Department', { required: false, max: 80 }) : undefined;

    let newRole = null;
    if (req.body.role && req.body.role !== existing.role) {
        newRole = v.oneOf(req.body.role, ROLES, 'Role');
        if (existing.role === 'teacher' || newRole === 'teacher') {
            throw new HttpError(400,
                'Teacher accounts cannot be converted to or from another role, '
                + 'because they are tied to a payroll record.',
                'ROLE_CHANGE_UNSUPPORTED');
        }
        if (existing.role === 'admin') {
            await accounts.assertNotLastAdmin({ ...existing, id: userId }, 'change the role of');
        }
    }

    await db.withTransaction(async (client) => {
        // COALESCE leaves a column untouched when the caller omitted the field.
        // A role change also bumps token_version, revoking existing sessions.
        await client.query(
            `UPDATE users
                SET full_name = COALESCE($1, full_name),
                    email     = CASE WHEN $2::boolean THEN $3 ELSE email END,
                    phone     = CASE WHEN $4::boolean THEN $5 ELSE phone END,
                    role      = COALESCE($6, role),
                    token_version = token_version + CASE WHEN $6 IS NULL THEN 0 ELSE 1 END
              WHERE id = $7`,
            [
                fullName || null,
                emailAddress !== undefined, emailAddress || null,
                phone !== undefined, phone || null,
                newRole, userId
            ]
        );

        const role = newRole || existing.role;

        if (role === 'teacher') {
            await client.query(
                `UPDATE teachers
                    SET full_name = COALESCE($1, full_name),
                        email     = CASE WHEN $2::boolean THEN $3 ELSE email END,
                        phone     = CASE WHEN $4::boolean THEN $5 ELSE phone END
                  WHERE user_id = $6`,
                [fullName || null, emailAddress !== undefined, emailAddress || null,
                    phone !== undefined, phone || null, userId]
            );
        } else if (role === 'accountant') {
            await client.query(
                `UPDATE accountants
                    SET full_name  = COALESCE($1, full_name),
                        email      = CASE WHEN $2::boolean THEN $3 ELSE email END,
                        phone      = CASE WHEN $4::boolean THEN $5 ELSE phone END,
                        department = CASE WHEN $6::boolean THEN $7 ELSE department END
                  WHERE user_id = $8`,
                [fullName || null, emailAddress !== undefined, emailAddress || null,
                    phone !== undefined, phone || null,
                    department !== undefined, department || null, userId]
            );
        }
    });

    invalidateUserCache(userId);
    logAudit(req.user, 'UPDATE_USER',
        `Updated ${existing.role} account "${existing.username}"${newRole ? ` → role ${newRole}` : ''}`, req.ip);

    res.json({ message: 'Account updated.' });
}

router.put('/users/:id', asyncHandler((req, res) => updateStaff(req, res, null)));
router.put('/admins/:id', asyncHandler((req, res) => updateStaff(req, res, 'admin')));
router.put('/hr/:id', asyncHandler((req, res) => updateStaff(req, res, 'hr')));

router.put('/accountants/:id', asyncHandler(async (req, res) => {
    const accountantId = v.num(req.params.id, 'Accountant id', { integer: true, min: 1 });
    const profile = await db.queryOne('SELECT user_id FROM accountants WHERE id = $1', [accountantId]);
    if (!profile) throw new HttpError(404, 'Accountant not found.', 'NOT_FOUND');

    req.params.id = String(profile.userId);
    await updateStaff(req, res, 'accountant');
}));

// --- Status changes ---------------------------------------------------------

router.post('/users/:id/deactivate', asyncHandler(async (req, res) => {
    const userId = v.num(req.params.id, 'User id', { integer: true, min: 1 });
    const reason = v.str(req.body.reason, 'Reason', { required: false, max: 300 });

    const user = await accounts.deactivateAccount({ userId, actor: req.user, reason });
    logAudit(req.user, 'DEACTIVATE_USER',
        `Deactivated "${user.username}"${reason ? `: ${reason}` : ''}`, req.ip);

    res.json({
        message: `${user.fullName} has been deactivated and signed out of all sessions.`,
        isActive: false
    });
}));

router.post('/users/:id/reactivate', asyncHandler(async (req, res) => {
    const userId = v.num(req.params.id, 'User id', { integer: true, min: 1 });
    const user = await accounts.reactivateAccount({ userId, actor: req.user });
    logAudit(req.user, 'REACTIVATE_USER', `Reactivated "${user.username}"`, req.ip);

    res.json({ message: `${user.fullName} has been reactivated.`, isActive: true });
}));

/** Retained for the existing UI control; routes to deactivate or reactivate. */
router.post('/users/:id/toggle-status', asyncHandler(async (req, res) => {
    const userId = v.num(req.params.id, 'User id', { integer: true, min: 1 });
    const existing = await db.queryOne('SELECT is_active FROM users WHERE id = $1', [userId]);
    if (!existing) throw new HttpError(404, 'Account not found.', 'USER_NOT_FOUND');

    if (!existing.isActive) {
        const user = await accounts.reactivateAccount({ userId, actor: req.user });
        logAudit(req.user, 'REACTIVATE_USER', `Reactivated "${user.username}"`, req.ip);
        return res.json({ message: `${user.fullName} has been reactivated.`, isActive: true });
    }

    const user = await accounts.deactivateAccount({ userId, actor: req.user });
    logAudit(req.user, 'DEACTIVATE_USER', `Deactivated "${user.username}"`, req.ip);
    res.json({ message: `${user.fullName} has been deactivated.`, isActive: false });
}));

async function deleteStaff(req, res, resolveUserId) {
    const userId = await resolveUserId(req);
    const user = await accounts.deleteAccount({ userId, actor: req.user });
    logAudit(req.user, 'DELETE_USER',
        `Permanently deleted ${user.role} account "${user.username}"`, req.ip);
    res.json({ message: `${user.fullName} has been permanently deleted.` });
}

const userIdFromParam = (req) => v.num(req.params.id, 'User id', { integer: true, min: 1 });

router.delete('/users/:id', asyncHandler((req, res) => deleteStaff(req, res, userIdFromParam)));
router.delete('/admins/:id', asyncHandler((req, res) => deleteStaff(req, res, userIdFromParam)));
router.delete('/hr/:id', asyncHandler((req, res) => deleteStaff(req, res, userIdFromParam)));

router.delete('/accountants/:id', asyncHandler((req, res) => deleteStaff(req, res, async (r) => {
    const id = v.num(r.params.id, 'Accountant id', { integer: true, min: 1 });
    const profile = await db.queryOne('SELECT user_id FROM accountants WHERE id = $1', [id]);
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
    const userId = v.num(req.params.id, 'User id', { integer: true, min: 1 });

    const user = await db.queryOne('SELECT id, username, full_name FROM users WHERE id = $1', [userId]);
    if (!user) throw new HttpError(404, 'Account not found.', 'USER_NOT_FOUND');

    const temporaryPassword = pw.generateTemporaryPassword();

    await db.execute(
        `UPDATE users
            SET password_hash = $1, must_change_password = TRUE, password_setup_completed = TRUE,
                password_setup_token_hash = NULL, password_setup_expires_at = NULL,
                password_changed_at = now(), token_version = token_version + 1
          WHERE id = $2`,
        [await pw.hash(temporaryPassword), userId]
    );
    invalidateUserCache(userId);

    await notify.notifyUser(userId, {
        title: 'Your password was reset',
        message: 'An administrator reset your password. You will be asked to choose a new one '
            + 'when you next sign in.',
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
    const userId = v.num(req.params.id, 'User id', { integer: true, min: 1 });
    const result = await accounts.resendSetupLink({ userId, req });
    logAudit(req.user, 'RESEND_SETUP_LINK', `Resent the setup link for user ${userId}`, req.ip);
    res.json({ message: `A new setup link has been sent to ${result.email}.`, ...result });
}));

/** Turn two-factor authentication on or off for an account. */
router.post('/users/:id/mfa', asyncHandler(async (req, res) => {
    const userId = v.num(req.params.id, 'User id', { integer: true, min: 1 });
    const enabled = v.bool(req.body.enabled, true);

    const user = await db.queryOne('SELECT id, username, full_name, email FROM users WHERE id = $1', [userId]);
    if (!user) throw new HttpError(404, 'Account not found.', 'USER_NOT_FOUND');
    if (enabled && !user.email) {
        throw new HttpError(400,
            'Add an email address to this account before enabling two-factor authentication.', 'NO_EMAIL');
    }

    await db.execute(
        `UPDATE users
            SET mfa_enabled = $1,
                mfa_pending_token_hash = NULL, mfa_pending_code_hash = NULL,
                mfa_pending_expires_at = NULL, mfa_pending_attempts = 0
          WHERE id = $2`,
        [enabled, userId]
    );
    invalidateUserCache(userId);

    logAudit(req.user, enabled ? 'MFA_ENABLED' : 'MFA_DISABLED',
        `Two-factor authentication ${enabled ? 'enabled' : 'disabled'} for "${user.username}"`, req.ip);

    res.json({
        message: `Two-factor authentication ${enabled ? 'enabled' : 'disabled'} for ${user.fullName}.`,
        mfaEnabled: enabled
    });
}));

/**
 * Two-factor activity view.
 *
 * This replaces the old "MFA portal", which displayed live one-time codes in
 * plain text and therefore let any administrator sign in as any other user. It
 * reports only *that* a challenge is outstanding, never the code — note that
 * mfa_pending_code_hash is deliberately absent from the column list.
 */
router.get('/mfa-status', asyncHandler(async (req, res) => {
    res.json(await db.query(
        `SELECT id AS user_id, username, full_name, role,
                CASE WHEN mfa_method = 'authenticator' AND mfa_secret IS NOT NULL
                     THEN 'authenticator' ELSE 'email' END AS method,
                CASE WHEN email IS NULL THEN NULL
                     ELSE left(email, 1) || '***@' || split_part(email, '@', 2) END AS masked_email,
                mfa_pending_attempts AS attempts,
                mfa_pending_expires_at AS expires_at,
                mfa_last_sent_at AS sent_at
           FROM users
          WHERE mfa_pending_expires_at > now()
          ORDER BY mfa_last_sent_at DESC NULLS LAST`
    ));
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
    const bounds = {
        nssfEmployeePercentage: [0, 30], nssfEmployerPercentage: [0, 30],
        minimumNetPercentage: [0, 90], maxAdvancePercentage: [0, 100],
        defaultAnnualLeaveDays: [0, 365], maxAdvanceInstalments: [1, 24]
    };
    for (const [key, [min, max]] of Object.entries(bounds)) {
        if (payload[key] !== undefined) v.num(payload[key], key, { min, max });
    }
    if (payload.taxMode !== undefined) v.oneOf(payload.taxMode, ['banded', 'flat', 'none'], 'Tax mode');
    if (payload.schoolName !== undefined) v.str(payload.schoolName, 'School name', { max: 120 });
    if (payload.currency !== undefined) v.str(payload.currency, 'Currency', { max: 8 });

    const applied = await configService.updateConfig(payload, req.user.id);
    logAudit(req.user, 'UPDATE_CONFIG', `Updated settings: ${Object.keys(applied).join(', ')}`, req.ip);
    res.json({ message: 'Settings saved.', config: applied });
}));

// ===========================================================================
// Audit log
// ===========================================================================

router.get('/audit-log', asyncHandler(async (req, res) => {
    res.json(await listAudit({
        limit: req.query.limit,
        cursor: req.query.cursor || null,
        action: req.query.action || null,
        username: req.query.username || null,
        since: req.query.since || null
    }));
}));

router.get('/audit-log/actions', asyncHandler(async (req, res) => {
    res.json(await listActions());
}));

// ===========================================================================
// Reports, export, stats
// ===========================================================================

router.get('/reports/payroll-summary', asyncHandler(async (req, res) => {
    res.json(await db.query(
        `SELECT id, month, year, status, version, employee_count, currency,
                total_gross, total_deductions, total_net,
                total_paye, total_nssf_employee, total_nssf_employer, total_employer_cost,
                processed_by_name, approved_by_name, rejection_reason,
                processed_at, approved_at, created_at,
                to_char(make_date(year, month, 1), 'FMMonth YYYY') AS period_label
           FROM payroll
          ORDER BY year DESC, month DESC
          LIMIT 120`
    ));
}));

/**
 * JSON export of the operational tables.
 *
 * Cloud SQL takes managed backups and supports point-in-time recovery; this
 * endpoint is for ad-hoc inspection and migration, and omits credential fields.
 */
router.get('/backup', asyncHandler(async (req, res) => {
    const [users, teachers, accountantRows, payroll, payrollItems, structures, config, leave, advances] =
        await Promise.all([
            db.query(`SELECT ${SAFE_USER_COLUMNS} FROM users`),
            db.query('SELECT * FROM teachers'),
            db.query('SELECT * FROM accountants'),
            db.query('SELECT * FROM payroll'),
            db.query('SELECT * FROM payroll_items'),
            db.query('SELECT * FROM salary_structures'),
            db.query('SELECT config_key, config_value FROM system_config'),
            db.query('SELECT * FROM leave_requests'),
            db.query('SELECT * FROM advance_requests')
        ]);

    logAudit(req.user, 'BACKUP_EXPORTED', 'Downloaded a JSON data export', req.ip);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition',
        `attachment; filename="edupay_backup_${new Date().toISOString().slice(0, 10)}.json"`);

    res.send(JSON.stringify({
        exportedAt: new Date().toISOString(),
        exportedBy: req.user.username,
        users, teachers, accountants: accountantRows, payroll, payrollItems,
        salaryStructures: structures, systemConfig: config,
        leaveRequests: leave, advanceRequests: advances
    }, null, 2));
}));

router.get('/stats', asyncHandler(async (req, res) => {
    // One round trip for every dashboard figure, rather than eight.
    const stats = await db.queryOne(`
        SELECT
            (SELECT count(*) FROM users)                                              AS total_users,
            (SELECT count(*) FROM users WHERE role = 'admin'      AND is_active)      AS total_admins,
            (SELECT count(*) FROM users WHERE role = 'hr'         AND is_active)      AS total_hr,
            (SELECT count(*) FROM users WHERE role = 'accountant' AND is_active)      AS total_accountants,
            (SELECT count(*) FROM users WHERE role = 'teacher'    AND is_active)      AS total_teachers,
            (SELECT count(*) FROM users WHERE NOT password_setup_completed)           AS pending_activation,
            (SELECT count(*) FROM payroll)                                            AS total_payrolls
    `);

    const recent = await db.queryOne(
        `SELECT id, month, year, status, total_net,
                to_char(make_date(year, month, 1), 'FMMonth YYYY') AS period_label
           FROM payroll ORDER BY created_at DESC LIMIT 1`
    );

    res.json({
        totalUsers: Number(stats.totalUsers),
        totalAdmins: Number(stats.totalAdmins),
        totalHr: Number(stats.totalHr),
        totalAccountants: Number(stats.totalAccountants),
        totalTeachers: Number(stats.totalTeachers),
        pendingActivation: Number(stats.pendingActivation),
        totalPayrolls: Number(stats.totalPayrolls),
        recentPayroll: recent
    });
}));

module.exports = router;
