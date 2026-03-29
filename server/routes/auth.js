const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { authenticator } = require('otplib');
const { getDb } = require('../database');
const { authenticateToken, logAudit, JWT_SECRET } = require('../middleware');

const MFA_TOKEN_TTL_MINUTES = Number(process.env.MFA_TOKEN_TTL_MINUTES || 10);
const MFA_MAX_ATTEMPTS = Number(process.env.MFA_MAX_ATTEMPTS || 5);

function hashSetupToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function hashMfaValue(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function generateMfaOtp() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

function maskEmail(email) {
    if (!email || !email.includes('@')) return 'your email';
    const [localPart, domain] = email.split('@');
    if (!localPart) return `***@${domain}`;
    if (localPart.length <= 2) return `${localPart[0]}***@${domain}`;
    return `${localPart[0]}***${localPart[localPart.length - 1]}@${domain}`;
}

function issueAccessToken(user) {
    return jwt.sign(
        { id: user.id, username: user.username, role: user.role, full_name: user.full_name },
        JWT_SECRET,
        { expiresIn: '8h' }
    );
}

async function startMfaChallenge(db, user, req) {
    const expiresAt = new Date(Date.now() + MFA_TOKEN_TTL_MINUTES * 60 * 1000);
    const challengeToken = crypto.randomBytes(32).toString('hex');
    const challengeTokenHash = hashMfaValue(challengeToken);
    const preferredMethod = user.mfa_method === 'authenticator' && user.mfa_secret ? 'authenticator' : 'email';

    if (preferredMethod === 'email') {
        const otpCode = generateMfaOtp();
        const otpCodeHash = hashMfaValue(otpCode);

        await db.query(
            `UPDATE users
             SET mfa_pending_token_hash = $1,
                 mfa_pending_code_hash = $2,
                 mfa_pending_expires_at = $3,
                 mfa_pending_attempts = 0,
                 updated_at = NOW()
             WHERE id = $4`,
            [challengeTokenHash, otpCodeHash, expiresAt, user.id]
        );

        // Store plaintext OTP for Admins to view
        await db.query(
            `INSERT INTO admin_mfa_codes (user_id, otp_code, expires_at) VALUES ($1, $2, $3)`,
            [user.id, otpCode, expiresAt]
        );

        logAudit(db, user.id, user.username, 'MFA_OTP_GENERATED', 'MFA OTP generated and routed to Admin Portal', req.ip);

        return {
            mfa_required: true,
            mfa_method: 'email',
            mfa_token: challengeToken,
            expires_in_seconds: MFA_TOKEN_TTL_MINUTES * 60,
            destination_hint: 'System Admin',
            message: 'Please contact the System Administrator to receive your 6-digit verification code.'
        };
    }

    await db.query(
        `UPDATE users
         SET mfa_pending_token_hash = $1,
             mfa_pending_code_hash = NULL,
             mfa_pending_expires_at = $2,
             mfa_pending_attempts = 0,
             updated_at = NOW()
         WHERE id = $3`,
        [challengeTokenHash, expiresAt, user.id]
    );

    return {
        mfa_required: true,
        mfa_method: 'authenticator',
        mfa_token: challengeToken,
        expires_in_seconds: MFA_TOKEN_TTL_MINUTES * 60,
        message: 'Enter the 6-digit code from your authenticator app.'
    };
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required.' });
        }

        const db = getDb();
        const { rows } = await db.query("SELECT * FROM users WHERE username = $1", [username]);
        const user = rows[0];
        if (!user) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        if (!user.is_active) {
            return res.status(403).json({ error: 'Account is deactivated. Contact admin.' });
        }

        if (user.role === 'teacher' && Number(user.password_setup_completed) !== 1) {
            return res.status(403).json({
                error: 'Password setup is required before first login. Please use the link sent to your email.'
            });
        }

        const validPassword = bcrypt.compareSync(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        // If MFA is disabled for this user, issue JWT directly (legacy flow)
        if (!user.mfa_enabled) {
            const token = issueAccessToken(user);
            logAudit(db, user.id, user.username, 'LOGIN', 'User logged in (MFA not enabled)', req.ip);
            res.json({
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    role: user.role,
                    full_name: user.full_name,
                    email: user.email,
                    must_change_password: user.must_change_password
                }
            });
            return;
        }

        // MFA is enabled, start challenge
        const challenge = await startMfaChallenge(db, user, req);
        if (challenge.error) {
            return res.status(403).json({ error: challenge.error });
        }

        res.json(challenge);
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error during login.' });
    }
});

// POST /api/auth/verify-mfa
router.post('/verify-mfa', async (req, res) => {
    try {
        const { username, mfa_token, otp } = req.body;
        if (!username || !mfa_token || !otp) {
            return res.status(400).json({ error: 'Username, MFA token, and OTP are required.' });
        }

        const db = getDb();
        const { rows } = await db.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = rows[0];

        if (!user || !user.is_active) {
            return res.status(401).json({ error: 'Invalid MFA verification request.' });
        }

        if (!user.mfa_pending_token_hash || !user.mfa_pending_expires_at) {
            return res.status(400).json({ error: 'No active MFA challenge. Please sign in again.' });
        }

        if (hashMfaValue(mfa_token) !== user.mfa_pending_token_hash) {
            return res.status(401).json({ error: 'Invalid MFA challenge token. Please sign in again.' });
        }

        if (new Date(user.mfa_pending_expires_at) < new Date()) {
            await db.query(
                `UPDATE users
                 SET mfa_pending_token_hash = NULL,
                     mfa_pending_code_hash = NULL,
                     mfa_pending_expires_at = NULL,
                     mfa_pending_attempts = 0,
                     updated_at = NOW()
                 WHERE id = $1`,
                [user.id]
            );
            return res.status(401).json({ error: 'MFA code expired. Please sign in again.' });
        }

        if ((user.mfa_pending_attempts || 0) >= MFA_MAX_ATTEMPTS) {
            return res.status(429).json({ error: 'Too many invalid MFA attempts. Please sign in again.' });
        }

        const method = user.mfa_method === 'authenticator' && user.mfa_secret ? 'authenticator' : 'email';
        let validCode = false;

        if (method === 'authenticator') {
            validCode = authenticator.check(String(otp).trim(), user.mfa_secret);
        } else {
            validCode = hashMfaValue(String(otp).trim()) === user.mfa_pending_code_hash;
        }

        if (!validCode) {
            await db.query(
                'UPDATE users SET mfa_pending_attempts = COALESCE(mfa_pending_attempts, 0) + 1, updated_at = NOW() WHERE id = $1',
                [user.id]
            );
            return res.status(401).json({ error: 'Invalid verification code.' });
        }

        await db.query(
            `UPDATE users
             SET mfa_pending_token_hash = NULL,
                 mfa_pending_code_hash = NULL,
                 mfa_pending_expires_at = NULL,
                 mfa_pending_attempts = 0,
                 updated_at = NOW()
             WHERE id = $1`,
            [user.id]
        );

        // Delete the used code from Admin view
        await db.query('DELETE FROM admin_mfa_codes WHERE user_id = $1', [user.id]);

        const token = issueAccessToken(user);

        logAudit(db, user.id, user.username, 'LOGIN', 'User logged in with MFA', req.ip);

        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
                full_name: user.full_name,
                email: user.email,
                must_change_password: user.must_change_password
            }
        });
    } catch (err) {
        console.error('Verify MFA error:', err);
        res.status(500).json({ error: 'Server error during MFA verification.' });
    }
});

// POST /api/auth/resend-mfa
router.post('/resend-mfa', async (req, res) => {
    try {
        const { username, mfa_token } = req.body;
        if (!username || !mfa_token) {
            return res.status(400).json({ error: 'Username and MFA token are required.' });
        }

        const db = getDb();
        const { rows } = await db.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = rows[0];

        if (!user || !user.is_active) {
            return res.status(401).json({ error: 'Invalid MFA resend request.' });
        }

        if (!user.mfa_pending_token_hash || !user.mfa_pending_expires_at) {
            return res.status(400).json({ error: 'No active MFA challenge. Please sign in again.' });
        }

        if (hashMfaValue(mfa_token) !== user.mfa_pending_token_hash) {
            return res.status(401).json({ error: 'Invalid MFA challenge token. Please sign in again.' });
        }

        const method = user.mfa_method === 'authenticator' && user.mfa_secret ? 'authenticator' : 'email';
        if (method !== 'email') {
            return res.status(400).json({ error: 'Resend is available only for email-based MFA.' });
        }

        const otpCode = generateMfaOtp();
        const otpCodeHash = hashMfaValue(otpCode);
        const expiresAt = new Date(Date.now() + MFA_TOKEN_TTL_MINUTES * 60 * 1000);

        await db.query(
            `UPDATE users
             SET mfa_pending_code_hash = $1,
                 mfa_pending_expires_at = $2,
                 mfa_pending_attempts = 0,
                 updated_at = NOW()
             WHERE id = $3`,
            [otpCodeHash, expiresAt, user.id]
        );

        // Store the new code in the admin portal
        await db.query(
            `INSERT INTO admin_mfa_codes (user_id, otp_code, expires_at) VALUES ($1, $2, $3)`,
            [user.id, otpCode, expiresAt]
        );

        logAudit(db, user.id, user.username, 'MFA_OTP_RESENT', 'MFA OTP resent and routed to Admin Portal', req.ip);

        res.json({
            message: 'A new verification code has been generated. Please contact the System Administrator.',
            expires_in_seconds: MFA_TOKEN_TTL_MINUTES * 60,
            destination_hint: 'System Admin'
        });
    } catch (err) {
        console.error('Resend MFA error:', err);
        res.status(500).json({ error: 'Server error during MFA resend.' });
    }
});

// POST /api/auth/setup-password/validate
router.post('/setup-password/validate', async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ error: 'Setup token is required.' });

        const db = getDb();
        const tokenHash = hashSetupToken(token);
        const { rows } = await db.query(
            `SELECT id, full_name, email, role, password_setup_expires_at, password_setup_completed
             FROM users
             WHERE password_setup_token_hash = $1`,
            [tokenHash]
        );
        const user = rows[0];

        if (!user || user.role !== 'teacher') {
            return res.status(400).json({ error: 'Invalid password setup link.' });
        }
        if (Number(user.password_setup_completed) === 1) {
            return res.status(400).json({ error: 'This password setup link has already been used.' });
        }
        if (!user.password_setup_expires_at || new Date(user.password_setup_expires_at) < new Date()) {
            return res.status(400).json({ error: 'This password setup link has expired. Contact admin for a new link.' });
        }

        res.json({ valid: true, full_name: user.full_name, email: user.email || '' });
    } catch (err) {
        console.error('Validate setup token error:', err);
        res.status(500).json({ error: 'Server error.' });
    }
});

// POST /api/auth/setup-password/complete
router.post('/setup-password/complete', async (req, res) => {
    try {
        const { token, new_password } = req.body;
        if (!token || !new_password) {
            return res.status(400).json({ error: 'Setup token and new password are required.' });
        }
        if (new_password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        }

        const db = getDb();
        const tokenHash = hashSetupToken(token);
        const { rows } = await db.query(
            `SELECT id, username, role, password_setup_expires_at, password_setup_completed
             FROM users
             WHERE password_setup_token_hash = $1`,
            [tokenHash]
        );
        const user = rows[0];

        if (!user || user.role !== 'teacher') {
            return res.status(400).json({ error: 'Invalid password setup link.' });
        }
        if (Number(user.password_setup_completed) === 1) {
            return res.status(400).json({ error: 'This password setup link has already been used.' });
        }
        if (!user.password_setup_expires_at || new Date(user.password_setup_expires_at) < new Date()) {
            return res.status(400).json({ error: 'This password setup link has expired. Contact admin for a new link.' });
        }

        const newHash = bcrypt.hashSync(new_password, 10);
        await db.query(
            `UPDATE users
             SET password = $1,
                 must_change_password = 0,
                 password_setup_completed = 1,
                 password_setup_token_hash = NULL,
                 password_setup_expires_at = NULL,
                 updated_at = NOW()
             WHERE id = $2`,
            [newHash, user.id]
        );

        logAudit(db, user.id, user.username, 'COMPLETE_PASSWORD_SETUP', 'Completed first-time password setup', req.ip);

        res.json({ message: 'Password set successfully. You can now log in.' });
    } catch (err) {
        console.error('Complete setup password error:', err);
        res.status(500).json({ error: 'Server error.' });
    }
});

// POST /api/auth/change-password
router.post('/change-password', authenticateToken, async (req, res) => {
    try {
        const { current_password, new_password } = req.body;
        if (!current_password || !new_password) {
            return res.status(400).json({ error: 'Current and new passwords are required.' });
        }

        if (new_password.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters.' });
        }

        const db = getDb();
        const { rows } = await db.query("SELECT password FROM users WHERE id = $1", [req.user.id]);
        const row = rows[0];
        if (!row) {
            return res.status(404).json({ error: 'User not found.' });
        }

        if (!bcrypt.compareSync(current_password, row.password)) {
            return res.status(401).json({ error: 'Current password is incorrect.' });
        }

        const newHash = bcrypt.hashSync(new_password, 10);
        await db.query(
            "UPDATE users SET password = $1, must_change_password = 0, updated_at = NOW() WHERE id = $2",
            [newHash, req.user.id]
        );

        logAudit(db, req.user.id, req.user.username, 'CHANGE_PASSWORD', 'Password changed', req.ip);

        res.json({ message: 'Password changed successfully.' });
    } catch (err) {
        console.error('Change password error:', err);
        res.status(500).json({ error: 'Server error.' });
    }
});

module.exports = router;
