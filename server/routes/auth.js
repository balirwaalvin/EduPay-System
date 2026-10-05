const express = require('express');
const router = express.Router();
const { authenticator } = require('otplib');

const {
    users, passwordResets, serverTimestamp, docData, findUserByUsername,
    getDb, FieldValue
} = require('../firebase');
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
const SETUP_TTL_HOURS = Number(process.env.PASSWORD_SETUP_TTL_HOURS || 24);
const RESET_TTL_MINUTES = Number(process.env.PASSWORD_RESET_TTL_MINUTES || 60);

/** Shape the user object returned to the browser. Never includes secrets. */
function publicUser(user) {
    return {
        id: user.id,
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

/** Clear every pending-MFA field on a user document. */
const CLEAR_MFA = {
    mfaPendingTokenHash: FieldValue.delete(),
    mfaPendingCodeHash: FieldValue.delete(),
    mfaPendingExpiresAt: FieldValue.delete(),
    mfaPendingAttempts: FieldValue.delete(),
    updatedAt: serverTimestamp()
};

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
        await users().doc(user.id).update({
            mfaPendingTokenHash: challengeHash,
            mfaPendingCodeHash: FieldValue.delete(),
            mfaPendingExpiresAt: expiresAt,
            mfaPendingAttempts: 0,
            updatedAt: serverTimestamp()
        });
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
        throw new HttpError(
            403,
            'Two-factor authentication is enabled but no email address is on file for this account. Ask an administrator to add one.',
            'MFA_NO_EMAIL'
        );
    }
    if (!email.isConfigured()) {
        throw new HttpError(
            503,
            'Two-factor authentication cannot be completed because email delivery is not configured. Contact your administrator.',
            'MFA_EMAIL_UNAVAILABLE'
        );
    }

    const otpCode = pw.generateOtp();

    await users().doc(user.id).update({
        mfaPendingTokenHash: challengeHash,
        mfaPendingCodeHash: pw.hashToken(otpCode),
        mfaPendingExpiresAt: expiresAt,
        mfaPendingAttempts: 0,
        mfaLastSentAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    });
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

/** Partially mask an email address for display in the UI. */
function maskEmail(address) {
    if (!address || !address.includes('@')) return 'your email address';
    const [local, domain] = address.split('@');
    if (local.length <= 2) return `${local[0]}***@${domain}`;
    return `${local[0]}***${local[local.length - 1]}@${domain}`;
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

    const user = await findUserByUsername(usernameInput);

    // Compare against a dummy hash when the account is unknown, so that a missing
    // account and a wrong password take a similar amount of time to answer.
    const passwordMatches = user
        ? await pw.verify(passwordInput, user.password)
        : await pw.verify(passwordInput, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');

    if (!user || !passwordMatches) {
        if (user) logAudit(user, 'LOGIN_FAILED', 'Incorrect password', req.ip);
        throw new HttpError(401, 'Incorrect username or password.', 'INVALID_CREDENTIALS');
    }

    if (user.isActive === false) {
        logAudit(user, 'LOGIN_BLOCKED', 'Account is deactivated', req.ip);
        throw new HttpError(403, 'This account has been deactivated. Contact your administrator.', 'USER_INACTIVE');
    }

    if (user.passwordSetupCompleted === false) {
        throw new HttpError(
            403,
            'Finish setting up your password using the link that was emailed to you before signing in.',
            'SETUP_REQUIRED'
        );
    }

    if (user.mfaEnabled) {
        const challenge = await startMfaChallenge(user, req);
        return res.json(challenge);
    }

    const token = issueAccessToken(user);
    await users().doc(user.id).update({ lastLoginAt: serverTimestamp() });
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

    const user = await findUserByUsername(usernameInput);
    if (!user || user.isActive === false) {
        throw new HttpError(401, 'This sign-in session is not valid. Please start again.', 'MFA_TOKEN_INVALID');
    }

    assertChallengeValid(user, mfaToken);

    const attempts = Number(user.mfaPendingAttempts || 0);
    if (attempts >= MFA_MAX_ATTEMPTS) {
        await users().doc(user.id).update(CLEAR_MFA);
        invalidateUserCache(user.id);
        logAudit(user, 'MFA_LOCKED', `Challenge abandoned after ${attempts} incorrect codes`, req.ip);
        throw new HttpError(429, 'Too many incorrect codes. Please sign in again.', 'MFA_ATTEMPTS_EXCEEDED');
    }

    const usesAuthenticator = user.mfaMethod === 'authenticator' && user.mfaSecret;
    const codeValid = usesAuthenticator
        ? authenticator.check(otp, user.mfaSecret)
        : pw.safeEqual(pw.hashToken(otp), user.mfaPendingCodeHash || '');

    if (!codeValid) {
        await users().doc(user.id).update({
            mfaPendingAttempts: FieldValue.increment(1),
            updatedAt: serverTimestamp()
        });
        invalidateUserCache(user.id);
        logAudit(user, 'MFA_FAILED', `Incorrect verification code (attempt ${attempts + 1})`, req.ip);

        const remaining = MFA_MAX_ATTEMPTS - attempts - 1;
        throw new HttpError(
            401,
            remaining > 0
                ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
                : 'Incorrect code. Please sign in again.',
            'MFA_CODE_INVALID'
        );
    }

    await users().doc(user.id).update({ ...CLEAR_MFA, lastLoginAt: serverTimestamp() });
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

    const user = await findUserByUsername(usernameInput);
    if (!user || user.isActive === false) {
        throw new HttpError(401, 'This sign-in session is not valid. Please start again.', 'MFA_TOKEN_INVALID');
    }

    assertChallengeValid(user, mfaToken);

    if (user.mfaMethod === 'authenticator' && user.mfaSecret) {
        throw new HttpError(400, 'Your authenticator app generates its own codes — no resend is needed.', 'MFA_RESEND_UNSUPPORTED');
    }
    if (!email.isConfigured()) {
        throw new HttpError(503, 'Email delivery is not configured. Contact your administrator.', 'MFA_EMAIL_UNAVAILABLE');
    }

    const otpCode = pw.generateOtp();

    // The attempt counter is deliberately preserved. Resetting it here previously
    // allowed unlimited guessing by alternating resend and verify calls.
    await users().doc(user.id).update({
        mfaPendingCodeHash: pw.hashToken(otpCode),
        mfaPendingExpiresAt: new Date(Date.now() + MFA_TTL_MINUTES * 60 * 1000),
        mfaLastSentAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    });
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

/** Find a user by the hash of a one-time setup token. */
async function findBySetupToken(token) {
    const snap = await users()
        .where('passwordSetupTokenHash', '==', pw.hashToken(token))
        .limit(1)
        .get();
    return snap.empty ? null : docData(snap.docs[0]);
}

function assertSetupTokenUsable(user) {
    if (!user) throw new HttpError(400, 'This setup link is not valid.', 'SETUP_TOKEN_INVALID');
    if (user.passwordSetupCompleted !== false) {
        throw new HttpError(400, 'This setup link has already been used.', 'SETUP_TOKEN_USED');
    }
    if (!user.passwordSetupExpiresAt || new Date(user.passwordSetupExpiresAt) < new Date()) {
        throw new HttpError(400, 'This setup link has expired. Ask an administrator to send a new one.', 'SETUP_TOKEN_EXPIRED');
    }
}

router.post('/setup-password/validate', authLimiter, asyncHandler(async (req, res) => {
    const token = v.str(req.body.token, 'Setup token', { max: 128 });
    const user = await findBySetupToken(token);
    assertSetupTokenUsable(user);

    res.json({
        valid: true,
        fullName: user.fullName,
        username: user.username,
        email: user.email || ''
    });
}));

router.post('/setup-password/complete', authLimiter, asyncHandler(async (req, res) => {
    const token = v.str(req.body.token, 'Setup token', { max: 128 });
    const newPassword = v.password(req.body.newPassword ?? req.body.new_password, 'Password');

    const user = await findBySetupToken(token);
    assertSetupTokenUsable(user);

    await users().doc(user.id).update({
        password: await pw.hash(newPassword),
        mustChangePassword: false,
        passwordSetupCompleted: true,
        passwordSetupTokenHash: FieldValue.delete(),
        passwordSetupExpiresAt: FieldValue.delete(),
        passwordChangedAt: serverTimestamp(),
        tokenVersion: FieldValue.increment(1),
        updatedAt: serverTimestamp()
    });
    invalidateUserCache(user.id);

    logAudit(user, 'PASSWORD_SETUP_COMPLETED', 'Completed first-time password setup', req.ip);

    res.json({ message: 'Your password has been set. You can now sign in.' });
}));

// ===========================================================================
// Self-service password reset
// ===========================================================================

router.post('/forgot-password', emailLimiter, asyncHandler(async (req, res) => {
    const identifier = v.str(req.body.identifier ?? req.body.username ?? req.body.email, 'Username or email', { max: 254 });

    // The response is deliberately identical whether or not the account exists,
    // so this endpoint cannot be used to enumerate usernames.
    const genericResponse = {
        message: 'If that account exists, we have sent a password reset link to its email address.'
    };

    let user = await findUserByUsername(identifier);
    if (!user && identifier.includes('@')) {
        const snap = await users().where('email', '==', identifier.toLowerCase()).limit(1).get();
        if (!snap.empty) user = docData(snap.docs[0]);
    }

    if (!user || user.isActive === false || !user.email) {
        logger.info('Password reset requested for an unusable account', { identifier });
        return res.json(genericResponse);
    }

    if (!email.isConfigured()) {
        logger.error('Password reset requested but SMTP is not configured');
        return res.json(genericResponse);
    }

    const { token, tokenHash } = pw.generateToken(32);
    const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000);

    await passwordResets().doc(tokenHash).set({
        userId: user.id,
        username: user.username,
        expiresAt,
        usedAt: null,
        requestedIp: req.ip || '',
        createdAt: serverTimestamp()
    });

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
    const snap = await passwordResets().doc(pw.hashToken(token)).get();
    const record = docData(snap);

    if (!record || record.usedAt || new Date(record.expiresAt) < new Date()) {
        throw new HttpError(400, 'This reset link is no longer valid. Please request a new one.', 'RESET_TOKEN_INVALID');
    }

    res.json({ valid: true, username: record.username });
}));

router.post('/reset-password/complete', authLimiter, asyncHandler(async (req, res) => {
    const token = v.str(req.body.token, 'Reset token', { max: 128 });
    const newPassword = v.password(req.body.newPassword ?? req.body.new_password, 'Password');
    const tokenHash = pw.hashToken(token);

    const hashed = await pw.hash(newPassword);

    // Consume the token and rotate the password together, so a reset link cannot
    // be replayed even if two requests arrive at once.
    const userId = await getDb().runTransaction(async (tx) => {
        const resetRef = passwordResets().doc(tokenHash);
        const resetSnap = await tx.get(resetRef);

        if (!resetSnap.exists) throw new HttpError(400, 'This reset link is no longer valid.', 'RESET_TOKEN_INVALID');

        const record = resetSnap.data();
        const expiresAt = record.expiresAt?.toDate ? record.expiresAt.toDate() : new Date(record.expiresAt);
        if (record.usedAt || expiresAt < new Date()) {
            throw new HttpError(400, 'This reset link is no longer valid. Please request a new one.', 'RESET_TOKEN_INVALID');
        }

        tx.update(resetRef, { usedAt: serverTimestamp() });
        tx.update(users().doc(record.userId), {
            password: hashed,
            mustChangePassword: false,
            passwordSetupCompleted: true,
            passwordChangedAt: serverTimestamp(),
            tokenVersion: FieldValue.increment(1),
            updatedAt: serverTimestamp()
        });

        return record.userId;
    });

    invalidateUserCache(userId);
    const user = docData(await users().doc(userId).get());
    logAudit(user, 'PASSWORD_RESET_COMPLETED', 'Password changed using a reset link', req.ip);

    res.json({ message: 'Your password has been changed. You can now sign in.' });
}));

// ===========================================================================
// Authenticated account actions
// ===========================================================================

router.get('/me', authenticateToken, asyncHandler(async (req, res) => {
    const user = docData(await users().doc(req.user.id).get());
    if (!user) throw new HttpError(404, 'Account not found.', 'USER_GONE');
    res.json({ user: publicUser(user) });
}));

router.post('/change-password', authenticateToken, asyncHandler(async (req, res) => {
    const currentPassword = v.str(req.body.currentPassword ?? req.body.current_password, 'Current password', { max: 128 });
    const newPassword = v.password(req.body.newPassword ?? req.body.new_password, 'New password');

    const user = docData(await users().doc(req.user.id).get());
    if (!user) throw new HttpError(404, 'Account not found.', 'USER_GONE');

    if (!(await pw.verify(currentPassword, user.password))) {
        logAudit(req.user, 'PASSWORD_CHANGE_FAILED', 'Current password was incorrect', req.ip);
        throw new HttpError(401, 'Your current password is incorrect.', 'CURRENT_PASSWORD_WRONG');
    }
    if (await pw.verify(newPassword, user.password)) {
        throw new HttpError(400, 'Your new password must be different from your current one.', 'PASSWORD_UNCHANGED');
    }

    await users().doc(req.user.id).update({
        password: await pw.hash(newPassword),
        mustChangePassword: false,
        passwordChangedAt: serverTimestamp(),
        tokenVersion: FieldValue.increment(1),
        updatedAt: serverTimestamp()
    });
    invalidateUserCache(req.user.id);

    logAudit(req.user, 'PASSWORD_CHANGED', 'Password changed by the account owner', req.ip);

    // The old token is now void, so hand back a fresh one to avoid an immediate
    // forced sign-out the moment the user changes their password.
    const refreshed = docData(await users().doc(req.user.id).get());
    res.json({
        message: 'Your password has been changed.',
        token: issueAccessToken(refreshed),
        user: publicUser(refreshed)
    });
}));

/**
 * Sign out. Incrementing `tokenVersion` invalidates every token issued for this
 * account, which also ends any session an attacker may hold.
 */
router.post('/logout', authenticateToken, asyncHandler(async (req, res) => {
    await users().doc(req.user.id).update({
        tokenVersion: FieldValue.increment(1),
        lastLogoutAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    });
    invalidateUserCache(req.user.id);
    logAudit(req.user, 'LOGOUT', 'Signed out', req.ip);
    res.json({ message: 'You have been signed out.' });
}));

module.exports = router;
