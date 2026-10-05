/**
 * Account lifecycle.
 *
 * Teacher accounts used to be creatable through two different routes that
 * produced differently-shaped records: one issued an emailed setup link, the
 * other assigned the shared password `teacher123`. Every role now goes through
 * `createAccount`, so activation, employee-id allocation and the audit trail
 * behave the same way everywhere.
 */
const db = require('../db');
const pw = require('./passwords');
const email = require('./email');
const logger = require('./logger');
const { HttpError, invalidateUserCache } = require('../middleware');

const SETUP_TTL_HOURS = Number(process.env.PASSWORD_SETUP_TTL_HOURS || 24);
const EMPLOYEE_ID_PREFIX = { teacher: 'TCH', accountant: 'ACC', hr: 'HRM', admin: 'ADM' };

/** Allocate the next employee id for a role, e.g. TCH0007. */
async function allocateEmployeeId(role, client = null) {
    const prefix = EMPLOYEE_ID_PREFIX[role] || 'EMP';
    const next = await db.nextSequence(`employee_id_${role}`, client);
    return `${prefix}${String(next).padStart(4, '0')}`;
}

function baseUrl(req) {
    return (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

/**
 * Create a user account.
 *
 * Activation depends on whether we can email the person:
 *   - with an email address and working SMTP -> a one-time setup link, and no
 *     password is ever known to anybody
 *   - otherwise -> a unique random temporary password returned to the caller
 *     once, for out-of-band delivery, with a forced change on first sign-in
 *
 * Accepts an optional transaction client so the account and its role profile are
 * created atomically.
 *
 * @returns {{userId: number, activation: object}}
 */
async function createAccount({
    username, role, fullName, emailAddress, phone,
    actor, req, preferSetupLink = true, mfaEnabled = null, client = null
}) {
    const canEmail = Boolean(emailAddress) && email.isConfigured();
    const useSetupLink = preferSetupLink && canEmail;

    let setupToken = null;
    let setupTokenHash = null;
    let setupExpiresAt = null;
    let temporaryPassword = null;
    let passwordHash;

    if (useSetupLink) {
        const generated = pw.generateToken(32);
        setupToken = generated.token;
        setupTokenHash = generated.tokenHash;
        setupExpiresAt = new Date(Date.now() + SETUP_TTL_HOURS * 60 * 60 * 1000);
        // Unguessable placeholder: the account cannot be signed into until the
        // setup link is used.
        passwordHash = await pw.hash(pw.generateTemporaryPassword(32));
    } else {
        temporaryPassword = pw.generateTemporaryPassword();
        passwordHash = await pw.hash(temporaryPassword);
    }

    // Two-factor defaults on, but only where email can actually deliver the
    // code — otherwise it would lock the account out immediately.
    const mfa = mfaEnabled === null ? canEmail : Boolean(mfaEnabled);

    let created;
    try {
        created = await db.queryOne(
            `INSERT INTO users (
                 username, password_hash, role, full_name, email, phone,
                 is_active, must_change_password, password_setup_completed,
                 password_setup_token_hash, password_setup_expires_at,
                 mfa_enabled, mfa_method, token_version, created_by
             ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, $8, $9, $10, $11, 'email', 0, $12)
             RETURNING id`,
            [
                username, passwordHash, role, fullName, emailAddress || null, phone || null,
                !useSetupLink, !useSetupLink, setupTokenHash, setupExpiresAt, mfa, actor?.id || null
            ],
            client
        );
    } catch (err) {
        // The unique index on username turns a race into a clean 409.
        throw db.translateError(err);
    }

    const activation = {
        method: useSetupLink ? 'setup_link' : 'temporary_password',
        emailSent: false,
        temporaryPassword,
        setupLinkExpiresInHours: useSetupLink ? SETUP_TTL_HOURS : null
    };

    if (useSetupLink) {
        try {
            await email.sendPasswordSetupEmail({
                toEmail: emailAddress,
                fullName,
                setupLink: `${baseUrl(req)}/setup-password.html?token=${setupToken}`,
                expiryHours: SETUP_TTL_HOURS
            });
            activation.emailSent = true;
        } catch (err) {
            logger.error('Failed to send setup email', { userId: created.id, error: err.message });
            activation.emailError =
                'The account was created but the setup email could not be sent. Use "Resend setup link".';
        }
    } else if (emailAddress && email.isConfigured()) {
        try {
            await email.sendTemporaryCredentialsEmail({
                toEmail: emailAddress,
                fullName,
                username,
                temporaryPassword,
                loginUrl: `${baseUrl(req)}/`
            });
            activation.emailSent = true;
        } catch (err) {
            logger.error('Failed to send credentials email', { userId: created.id, error: err.message });
        }
    }

    return { userId: Number(created.id), activation };
}

/** Issue a fresh setup link for an account that has not been activated yet. */
async function resendSetupLink({ userId, req }) {
    const user = await db.queryOne(
        'SELECT id, full_name, email, password_setup_completed FROM users WHERE id = $1',
        [userId]
    );

    if (!user) throw new HttpError(404, 'Account not found.', 'USER_NOT_FOUND');
    if (user.passwordSetupCompleted) {
        throw new HttpError(400,
            'This account is already active, so no setup link is needed. Use "Reset password" instead.',
            'ALREADY_ACTIVE');
    }
    if (!user.email) throw new HttpError(400, 'This account has no email address on file.', 'NO_EMAIL');
    if (!email.isConfigured()) throw new HttpError(503, 'Email delivery is not configured.', 'EMAIL_UNAVAILABLE');

    const { token, tokenHash } = pw.generateToken(32);

    await db.execute(
        `UPDATE users SET password_setup_token_hash = $1, password_setup_expires_at = $2 WHERE id = $3`,
        [tokenHash, new Date(Date.now() + SETUP_TTL_HOURS * 60 * 60 * 1000), userId]
    );

    await email.sendPasswordSetupEmail({
        toEmail: user.email,
        fullName: user.fullName,
        setupLink: `${baseUrl(req)}/setup-password.html?token=${token}`,
        expiryHours: SETUP_TTL_HOURS
    });

    return { email: user.email, expiresInHours: SETUP_TTL_HOURS };
}

/** Refuse to remove the last route into the system. */
async function assertNotLastAdmin(user, verb, client = null) {
    if (user.role !== 'admin') return;

    const count = await db.scalar(
        "SELECT count(*) AS count FROM users WHERE role = 'admin' AND is_active AND id <> $1",
        [user.id],
        client
    );

    if (Number(count) === 0) {
        throw new HttpError(
            400,
            `This is the only active administrator account, so it cannot be ${verb}d. `
            + 'Create another administrator first.',
            'LAST_ADMIN'
        );
    }
}

/**
 * Deactivate an account.
 *
 * Preferred over deletion: staff appear on historical payroll runs, and those
 * records must stay intact and attributable. Also revokes live sessions by
 * bumping `token_version`.
 */
async function deactivateAccount({ userId, actor, reason }) {
    if (Number(userId) === Number(actor.id)) {
        throw new HttpError(400, 'You cannot deactivate your own account.', 'SELF_DEACTIVATE');
    }

    const user = await db.withTransaction(async (client) => {
        const existing = await db.queryOne(
            'SELECT id, username, full_name, role FROM users WHERE id = $1 FOR UPDATE',
            [userId],
            client
        );
        if (!existing) throw new HttpError(404, 'Account not found.', 'USER_NOT_FOUND');

        await assertNotLastAdmin(existing, 'deactivate', client);

        await client.query(
            `UPDATE users
                SET is_active = FALSE, deactivated_at = now(), deactivated_by = $1,
                    deactivation_reason = $2, token_version = token_version + 1
              WHERE id = $3`,
            [actor.id, reason || null, userId]
        );

        // Mirror the status onto the role profile so lists and payroll agree.
        if (existing.role === 'teacher') {
            await client.query('UPDATE teachers SET is_active = FALSE WHERE user_id = $1', [userId]);
        } else if (existing.role === 'accountant') {
            await client.query('UPDATE accountants SET is_active = FALSE WHERE user_id = $1', [userId]);
        }

        return existing;
    });

    // Drop the cached copy so the revocation takes effect on the very next
    // request rather than whenever the cache happens to expire.
    invalidateUserCache(userId);
    return user;
}

async function reactivateAccount({ userId, actor }) {
    const user = await db.withTransaction(async (client) => {
        const existing = await db.queryOne(
            'SELECT id, username, full_name, role FROM users WHERE id = $1 FOR UPDATE',
            [userId],
            client
        );
        if (!existing) throw new HttpError(404, 'Account not found.', 'USER_NOT_FOUND');

        await client.query(
            `UPDATE users
                SET is_active = TRUE, deactivated_at = NULL, deactivated_by = NULL,
                    deactivation_reason = NULL, reactivated_at = now(), reactivated_by = $1
              WHERE id = $2`,
            [actor.id, userId]
        );

        if (existing.role === 'teacher') {
            await client.query('UPDATE teachers SET is_active = TRUE WHERE user_id = $1', [userId]);
        } else if (existing.role === 'accountant') {
            await client.query('UPDATE accountants SET is_active = TRUE WHERE user_id = $1', [userId]);
        }

        return existing;
    });

    invalidateUserCache(userId);
    return user;
}

/**
 * Permanently delete an account.
 *
 * The schema does most of the work. `ON DELETE CASCADE` removes the teacher or
 * accountant profile and the account's notifications; `ON DELETE SET NULL`
 * detaches the audit trail so it survives; and `payroll_items.teacher_id`
 * is `ON DELETE RESTRICT`, so the database itself refuses to destroy anyone with
 * payroll history. That refusal is caught here and reported as advice to
 * deactivate instead.
 */
async function deleteAccount({ userId, actor }) {
    if (Number(userId) === Number(actor.id)) {
        throw new HttpError(400, 'You cannot delete your own account.', 'SELF_DELETE');
    }

    const user = await db.withTransaction(async (client) => {
        const existing = await db.queryOne(
            'SELECT id, username, full_name, role FROM users WHERE id = $1 FOR UPDATE',
            [userId],
            client
        );
        if (!existing) throw new HttpError(404, 'Account not found.', 'USER_NOT_FOUND');

        await assertNotLastAdmin(existing, 'delete', client);

        // Keep the trail, detached from the account that is going away.
        await client.query(
            'UPDATE audit_log SET user_id = NULL, user_deleted = TRUE WHERE user_id = $1',
            [userId]
        );

        try {
            await client.query('DELETE FROM users WHERE id = $1', [userId]);
        } catch (err) {
            // payroll_items_teacher_id_fkey is RESTRICT, which lands here.
            throw db.translateError(err);
        }

        return existing;
    });

    invalidateUserCache(userId);
    return user;
}

/** Look up a user's teacher or accountant profile, if any. */
async function findProfileByUserId(userId, role) {
    if (role === 'teacher') {
        return db.queryOne('SELECT * FROM teachers WHERE user_id = $1', [userId]);
    }
    if (role === 'accountant') {
        return db.queryOne('SELECT * FROM accountants WHERE user_id = $1', [userId]);
    }
    return null;
}

module.exports = {
    createAccount,
    resendSetupLink,
    deactivateAccount,
    reactivateAccount,
    deleteAccount,
    allocateEmployeeId,
    findProfileByUserId,
    assertNotLastAdmin
};
