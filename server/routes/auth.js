const express = require('express');
const router = express.Router();
const { authenticator } = require('otplib');

const db = require('../db');
const {
    issueAccessToken, authenticateToken, authLimiter, emailLimiter,
    asyncHandler, HttpError, invalidateUserCache
} = require('../middleware');
const pw = require('../services/passwords');
const v = require('../services/validate');
const email = require('../services/email');
const { logAudit } = require('../services/audit');
const logger = require('../services/logger');

const MFA_TTL_MINUTES = Number(process.env.MFA_TOKEN_TTL_MINUTES || 10);
const MFA_MAX_ATTEMPTS = Number(process.env.MFA_MAX_ATTEMPTS || 5);
const RESET_TTL_MINUTES = Number(process.env.PASSWORD_RESET_TTL_MINUTES || 60);

/** Shape the user object returned to the browser. Never includes secrets. */
function publicUser(user) {
    return {
        id: Number(user.id),
        username: user.username,
        role: user.role,
        fullName: user.fullName,
        email: user.email || '',
        mustChangePassword: Boolean(user.mustChangePassword),
        mfaEnabled: Boolean(user.mfaEnabled)
    };
}

function baseUrl(req) {
    return (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

const USER_COLUMNS = `
    id, username, password_hash, role, full_name, email, is_active,
    must_change_password, password_setup_completed, token_version,
    mfa_enabled, mfa_method, mfa_secret,
    mfa_pending_token_hash, mfa_pending_code_hash, mfa_pending_expires_at, mfa_pending_attempts,
    password_setup_token_hash, password_setup_expires_at`;

function findByUsername(username) {
    return db.queryOne(`SELECT ${USER_COLUMNS} FROM users WHERE username = $1`, [String(username).toLowerCase()]);
}

/** Clear every pending-MFA field. */
const CLEAR_MFA_SQL = `
    mfa_pending_token_hash = NULL,
    mfa_pending_code_hash  = NULL,
    mfa_pending_expires_at = NULL,
    mfa_pending_attempts   = 0`;

/** Partially mask an email address for display. */
function maskEmail(address) {
    if (!address || !address.includes('@')) return 'your email address';
    const [local, domain] = address.split('@');
    if (local.length <= 2) return `${local[0]}***@${domain}`;
    return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

/**
 * Begin an MFA challenge.
 *
 * The previous implementation wrote the one-time code to the database in plain
 * text and showed it to administrators, which let any admin sign in as any other
 * user. The code is now hashed and delivered to the account owner by email, and
 * is never returned to the caller or exposed through an admin view.
 */
async function startMfaChallenge(user, req) {
    const expiresAt = new Date(Date.now() + MFA_TTL_MINUTES * 60 * 1000);
    const { token: challengeToken, tokenHash: challengeHash } = pw.generateToken(32);
    const useAuthenticator = user.mfaMethod === 'authenticator' && user.mfaSecret;

    if (useAuthenticator) {
        await db.execute(
            `UPDATE users
                SET mfa_pending_token_hash = $1, mfa_pending_code_hash = NULL,
                    mfa_pending_expires_at = $2, mfa_pending_attempts = 0
              WHERE id = $3`,
            [challengeHash, expiresAt, user.id]
        );
        invalidateUserCache(user.id);

        return {
            mfaRequired: true,
            mfaMethod: 'authenticator',
            mfaToken: challengeToken,
            expiresInSeconds: MFA_TTL_MINUTES * 60,
            message: 'Enter the 6-digit code from your authenticator app.'
        };
    }

    if (!user.email) {
        throw new HttpError(403,
            'Two-factor authentication is enabled but no email address is on file for this account. '
            + 'Ask an administrator to add one.',
            'MFA_NO_EMAIL');
    }
    if (!email.isConfigured()) {
        throw new HttpError(503,
            'Two-factor authentication cannot be completed because email delivery is not configured. '
            + 'Contact your administrator.',
            'MFA_EMAIL_UNAVAILABLE');
    }

    const otpCode = pw.generateOtp();

    await db.execute(
        `UPDATE users
            SET mfa_pending_token_hash = $1, mfa_pending_code_hash = $2,
                mfa_pending_expires_at = $3, mfa_pending_attempts = 0, mfa_last_sent_at = now()
          WHERE id = $4`,
        [challengeHash, pw.hashToken(otpCode), expiresAt, user.id]
    );
    invalidateUserCache(user.id);

    await email.sendMfaOtpEmail({
        toEmail: user.email,
        fullName: user.fullName,
        otpCode,
        expiryMinutes: MFA_TTL_MINUTES
    });

    logAudit(user, 'MFA_CHALLENGE_SENT', 'Verification code emailed to the account owner', req.ip);

    return {
        mfaRequired: true,
        mfaMethod: 'email',
        mfaToken: challengeToken,
        expiresInSeconds: MFA_TTL_MINUTES * 60,
        destinationHint: maskEmail(user.email),
        message: `We emailed a 6-digit code to ${maskEmail(user.email)}.`
    };
}

/** Validate an in-flight MFA challenge token against the stored hash. */
function assertChallengeValid(user, mfaToken) {
    if (!user.mfaPendingTokenHash || !user.mfaPendingExpiresAt) {
        throw new HttpError(400, 'No sign-in is in progress. Please start again.', 'NO_MFA_CHALLENGE');
    }
    if (!pw.safeEqual(pw.hashToken(mfaToken), user.mfaPendingTokenHash)) {
        throw new HttpError(401, 'This sign-in session is not valid. Please start again.', 'MFA_TOKEN_INVALID');
    }
    if (new Date(user.mfaPendingExpiresAt) < new Date()) {
        throw new HttpError(401, 'Your verification code has expired. Please sign in again.', 'MFA_EXPIRED');
    }
}

// ===========================================================================
// POST /api/auth/login
// ===========================================================================
router.post('/login', authLimiter, asyncHandler(async (req, res) => {
    const usernameInput = v.str(req.body.username, 'Username', { max: 64 }).toLowerCase();
    const passwordInput = v.str(req.body.password, 'Password', { max: 128 });

    const user = await findByUsername(usernameInput);

    // Compare against a dummy hash when the account is unknown, so a missing
    // account and a wrong password take a similar amount of time to answer.
    const passwordMatches = user
        ? await pw.verify(passwordInput, user.passwordHash)
        : await pw.verify(passwordInput, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');

    if (!user || !passwordMatches) {
        if (user) logAudit(user, 'LOGIN_FAILED', 'Incorrect password', req.ip);
        throw new HttpError(401, 'Incorrect username or password.', 'INVALID_CREDENTIALS');
    }

    if (!user.isActive) {
        logAudit(user, 'LOGIN_BLOCKED', 'Account is deactivated', req.ip);
        throw new HttpError(403, 'This account has been deactivated. Contact your administrator.', 'USER_INACTIVE');
    }

    if (!user.passwordSetupCompleted) {
        throw new HttpError(403,
            'Finish setting up your password using the link that was emailed to you before signing in.',
            'SETUP_REQUIRED');
    }

    if (user.mfaEnabled) {
        return res.json(await startMfaChallenge(user, req));
    }

    const token = issueAccessToken(user);
    await db.execute('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    invalidateUserCache(user.id);
    logAudit(user, 'LOGIN', 'Signed in without two-factor authentication', req.ip);

    res.json({ token, user: publicUser(user) });
}));

// ===========================================================================
// POST /api/auth/verify-mfa
// ===========================================================================
router.post('/verify-mfa', authLimiter, asyncHandler(async (req, res) => {
    const usernameInput = v.str(req.body.username, 'Username', { max: 64 }).toLowerCase();
    const mfaToken = v.str(req.body.mfaToken ?? req.body.mfa_token, 'Sign-in session', { max: 128 });
    const otp = v.otp(req.body.otp);

    const user = await findByUsername(usernameInput);
    if (!user || !user.isActive) {
        throw new HttpError(401, 'This sign-in session is not valid. Please start again.', 'MFA_TOKEN_INVALID');
    }

    assertChallengeValid(user, mfaToken);

    const attempts = Number(user.mfaPendingAttempts || 0);
    if (attempts >= MFA_MAX_ATTEMPTS) {
        await db.execute(`UPDATE users SET ${CLEAR_MFA_SQL} WHERE id = $1`, [user.id]);
        invalidateUserCache(user.id);
        logAudit(user, 'MFA_LOCKED', `Challenge abandoned after ${attempts} incorrect codes`, req.ip);
        throw new HttpError(429, 'Too many incorrect codes. Please sign in again.', 'MFA_ATTEMPTS_EXCEEDED');
    }

    const usesAuthenticator = user.mfaMethod === 'authenticator' && user.mfaSecret;
    const codeValid = usesAuthenticator
        ? authenticator.check(otp, user.mfaSecret)
        : pw.safeEqual(pw.hashToken(otp), user.mfaPendingCodeHash || '');

    if (!codeValid) {
        await db.execute(
            'UPDATE users SET mfa_pending_attempts = mfa_pending_attempts + 1 WHERE id = $1',
            [user.id]
        );
        invalidateUserCache(user.id);
        logAudit(user, 'MFA_FAILED', `Incorrect verification code (attempt ${attempts + 1})`, req.ip);

        const remaining = MFA_MAX_ATTEMPTS - attempts - 1;
        throw new HttpError(401,
            remaining > 0
                ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
                : 'Incorrect code. Please sign in again.',
            'MFA_CODE_INVALID');
    }

    await db.execute(`UPDATE users SET ${CLEAR_MFA_SQL}, last_login_at = now() WHERE id = $1`, [user.id]);
    invalidateUserCache(user.id);

    const token = issueAccessToken(user);
    logAudit(user, 'LOGIN', 'Signed in with two-factor authentication', req.ip);

    res.json({ token, user: publicUser(user) });
}));

// ===========================================================================
// POST /api/auth/resend-mfa
// ===========================================================================
router.post('/resend-mfa', emailLimiter, asyncHandler(async (req, res) => {
    const usernameInput = v.str(req.body.username, 'Username', { max: 64 }).toLowerCase();
    const mfaToken = v.str(req.body.mfaToken ?? req.body.mfa_token, 'Sign-in session', { max: 128 });

    const user = await findByUsername(usernameInput);
    if (!user || !user.isActive) {
        throw new HttpError(401, 'This sign-in session is not valid. Please start again.', 'MFA_TOKEN_INVALID');
    }

    assertChallengeValid(user, mfaToken);

    if (user.mfaMethod === 'authenticator' && user.mfaSecret) {
        throw new HttpError(400,
            'Your authenticator app generates its own codes — no resend is needed.', 'MFA_RESEND_UNSUPPORTED');
    }
    if (!email.isConfigured()) {
        throw new HttpError(503, 'Email delivery is not configured. Contact your administrator.',
            'MFA_EMAIL_UNAVAILABLE');
    }

    const otpCode = pw.generateOtp();

    // The attempt counter is deliberately preserved. Resetting it here previously
    // allowed unlimited guessing by alternating resend and verify calls.
    await db.execute(
        `UPDATE users
            SET mfa_pending_code_hash = $1, mfa_pending_expires_at = $2, mfa_last_sent_at = now()
          WHERE id = $3`,
        [pw.hashToken(otpCode), new Date(Date.now() + MFA_TTL_MINUTES * 60 * 1000), user.id]
    );
    invalidateUserCache(user.id);

    await email.sendMfaOtpEmail({
        toEmail: user.email,
        fullName: user.fullName,
        otpCode,
        expiryMinutes: MFA_TTL_MINUTES
    });

    logAudit(user, 'MFA_CHALLENGE_RESENT', 'Replacement verification code emailed', req.ip);

    res.json({
        message: `A new code has been sent to ${maskEmail(user.email)}.`,
        expiresInSeconds: MFA_TTL_MINUTES * 60,
        destinationHint: maskEmail(user.email)
    });
}));

// ===========================================================================
// Password setup (first-time activation via emailed link)
// ===========================================================================

function findBySetupToken(token) {
    return db.queryOne(
        `SELECT id, username, full_name, email, password_setup_completed, password_setup_expires_at
           FROM users WHERE password_setup_token_hash = $1`,
        [pw.hashToken(token)]
    );
}

function assertSetupTokenUsable(user) {
    if (!user) throw new HttpError(400, 'This setup link is not valid.', 'SETUP_TOKEN_INVALID');
    if (user.passwordSetupCompleted) {
        throw new HttpError(400, 'This setup link has already been used.', 'SETUP_TOKEN_USED');
    }
    if (!user.passwordSetupExpiresAt || new Date(user.passwordSetupExpiresAt) < new Date()) {
        throw new HttpError(400,
            'This setup link has expired. Ask an administrator to send a new one.', 'SETUP_TOKEN_EXPIRED');
    }
}

router.post('/setup-password/validate', authLimiter, asyncHandler(async (req, res) => {
    const token = v.str(req.body.token, 'Setup token', { max: 128 });
    const user = await findBySetupToken(token);
    assertSetupTokenUsable(user);

    res.json({ valid: true, fullName: user.fullName, username: user.username, email: user.email || '' });
}));

router.post('/setup-password/complete', authLimiter, asyncHandler(async (req, res) => {
    const token = v.str(req.body.token, 'Setup token', { max: 128 });
    const newPassword = v.password(req.body.newPassword ?? req.body.new_password, 'Password');

    const hashed = await pw.hash(newPassword);

    // Consume the token and set the password together, so a link cannot be
    // replayed even if two requests arrive at once.
    const user = await db.withTransaction(async (client) => {
        const existing = await db.queryOne(
            `SELECT id, username, role, password_setup_completed, password_setup_expires_at
               FROM users WHERE password_setup_token_hash = $1 FOR UPDATE`,
            [pw.hashToken(token)],
            client
        );
        assertSetupTokenUsable(existing);

        await client.query(
            `UPDATE users
                SET password_hash = $1, must_change_password = FALSE, password_setup_completed = TRUE,
                    password_setup_token_hash = NULL, password_setup_expires_at = NULL,
                    password_changed_at = now(), token_version = token_version + 1
              WHERE id = $2`,
            [hashed, existing.id]
        );

        return existing;
    });

    invalidateUserCache(user.id);
    logAudit(user, 'PASSWORD_SETUP_COMPLETED', 'Completed first-time password setup', req.ip);

    res.json({ message: 'Your password has been set. You can now sign in.' });
}));

// ===========================================================================
// Self-service password reset
// ===========================================================================

router.post('/forgot-password', emailLimiter, asyncHandler(async (req, res) => {
    const identifier = v.str(
        req.body.identifier ?? req.body.username ?? req.body.email,
        'Username or email', { max: 254 }
    );

    // The response is deliberately identical whether or not the account exists,
    // so this endpoint cannot be used to enumerate usernames.
    const genericResponse = {
        message: 'If that account exists, we have sent a password reset link to its email address.'
    };

    const user = await db.queryOne(
        `SELECT id, username, full_name, email, is_active
           FROM users
          WHERE username = $1 OR (email IS NOT NULL AND email = $1)
          LIMIT 1`,
        [identifier.toLowerCase()]
    );

    if (!user || !user.isActive || !user.email) {
        logger.info('Password reset requested for an unusable account', { identifier });
        return res.json(genericResponse);
    }
    if (!email.isConfigured()) {
        logger.error('Password reset requested but SMTP is not configured');
        return res.json(genericResponse);
    }

    const { token, tokenHash } = pw.generateToken(32);

    await db.execute(
        `INSERT INTO password_resets (token_hash, user_id, username, expires_at, requested_ip)
         VALUES ($1, $2, $3, $4, $5)`,
        [tokenHash, user.id, user.username, new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000), req.ip || '']
    );

    try {
        await email.sendPasswordResetEmail({
            toEmail: user.email,
            fullName: user.fullName,
            resetLink: `${baseUrl(req)}/reset-password.html?token=${token}`,
            expiryMinutes: RESET_TTL_MINUTES
        });
        logAudit(user, 'PASSWORD_RESET_REQUESTED', 'Reset link emailed', req.ip);
    } catch (err) {
        logger.error('Failed to send password reset email', { userId: user.id, error: err.message });
    }

    res.json(genericResponse);
}));

router.post('/reset-password/validate', authLimiter, asyncHandler(async (req, res) => {
    const token = v.str(req.body.token, 'Reset token', { max: 128 });

    const record = await db.queryOne(
        'SELECT username, expires_at, used_at FROM password_resets WHERE token_hash = $1',
        [pw.hashToken(token)]
    );

    if (!record || record.usedAt || new Date(record.expiresAt) < new Date()) {
        throw new HttpError(400,
            'This reset link is no longer valid. Please request a new one.', 'RESET_TOKEN_INVALID');
    }

    res.json({ valid: true, username: record.username });
}));

router.post('/reset-password/complete', authLimiter, asyncHandler(async (req, res) => {
    const token = v.str(req.body.token, 'Reset token', { max: 128 });
    const newPassword = v.password(req.body.newPassword ?? req.body.new_password, 'Password');

    const hashed = await pw.hash(newPassword);

    // Consume the token and rotate the password in one transaction, so a reset
    // link cannot be replayed even under concurrent requests.
    const user = await db.withTransaction(async (client) => {
        const record = await db.queryOne(
            `SELECT token_hash, user_id, username, expires_at, used_at
               FROM password_resets WHERE token_hash = $1 FOR UPDATE`,
            [pw.hashToken(token)],
            client
        );

        if (!record || record.usedAt || new Date(record.expiresAt) < new Date()) {
            throw new HttpError(400,
                'This reset link is no longer valid. Please request a new one.', 'RESET_TOKEN_INVALID');
        }

        await client.query('UPDATE password_resets SET used_at = now() WHERE token_hash = $1', [record.tokenHash]);
        await client.query(
            `UPDATE users
                SET password_hash = $1, must_change_password = FALSE, password_setup_completed = TRUE,
                    password_changed_at = now(), token_version = token_version + 1
              WHERE id = $2`,
            [hashed, record.userId]
        );

        return { id: record.userId, username: record.username };
    });

    invalidateUserCache(user.id);
    logAudit(user, 'PASSWORD_RESET_COMPLETED', 'Password changed using a reset link', req.ip);

    res.json({ message: 'Your password has been changed. You can now sign in.' });
}));

// ===========================================================================
// Authenticated account actions
// ===========================================================================

router.get('/me', authenticateToken, asyncHandler(async (req, res) => {
    const user = await db.queryOne(
        `SELECT id, username, role, full_name, email, must_change_password, mfa_enabled
           FROM users WHERE id = $1`,
        [req.user.id]
    );
    if (!user) throw new HttpError(404, 'Account not found.', 'USER_GONE');
    res.json({ user: publicUser(user) });
}));

router.post('/change-password', authenticateToken, asyncHandler(async (req, res) => {
    const currentPassword = v.str(
        req.body.currentPassword ?? req.body.current_password, 'Current password', { max: 128 }
    );
    const newPassword = v.password(req.body.newPassword ?? req.body.new_password, 'New password');

    const user = await db.queryOne(
        `SELECT id, username, role, full_name, email, password_hash, mfa_enabled
           FROM users WHERE id = $1`,
        [req.user.id]
    );
    if (!user) throw new HttpError(404, 'Account not found.', 'USER_GONE');

    if (!(await pw.verify(currentPassword, user.passwordHash))) {
        logAudit(req.user, 'PASSWORD_CHANGE_FAILED', 'Current password was incorrect', req.ip);
        throw new HttpError(401, 'Your current password is incorrect.', 'CURRENT_PASSWORD_WRONG');
    }
    if (await pw.verify(newPassword, user.passwordHash)) {
        throw new HttpError(400,
            'Your new password must be different from your current one.', 'PASSWORD_UNCHANGED');
    }

    const updated = await db.queryOne(
        `UPDATE users
            SET password_hash = $1, must_change_password = FALSE,
                password_changed_at = now(), token_version = token_version + 1
          WHERE id = $2
          RETURNING id, username, role, full_name, email, must_change_password, mfa_enabled, token_version`,
        [await pw.hash(newPassword), req.user.id]
    );
    invalidateUserCache(req.user.id);

    logAudit(req.user, 'PASSWORD_CHANGED', 'Password changed by the account owner', req.ip);

    // The old token is now void, so hand back a fresh one to avoid an immediate
    // forced sign-out the moment the user changes their password.
    res.json({
        message: 'Your password has been changed.',
        token: issueAccessToken(updated),
        user: publicUser(updated)
    });
}));

/**
 * Sign out. Incrementing `token_version` invalidates every token issued for this
 * account, which also ends any session an attacker may hold.
 */
router.post('/logout', authenticateToken, asyncHandler(async (req, res) => {
    await db.execute(
        'UPDATE users SET token_version = token_version + 1, last_logout_at = now() WHERE id = $1',
        [req.user.id]
    );
    invalidateUserCache(req.user.id);
    logAudit(req.user, 'LOGOUT', 'Signed out', req.ip);
    res.json({ message: 'You have been signed out.' });
}));

module.exports = router;
