/**
 * Account lifecycle.
 *
 * Teacher accounts used to be creatable through two different routes that
 * produced differently-shaped records: one issued an emailed setup link, the
 * other assigned the shared password `teacher123`. Every role now goes through
 * `createAccount` here, so activation, employee-id allocation and the audit
 * trail behave the same way everywhere.
 */
const {
    users, teachers, accountants, notifications, auditLog, leaveRequests,
    advanceRequests, payrollItems, serverTimestamp, docData, createUserWithUsername,
    releaseUsername, nextSequence, getDb, FieldValue, deleteQueryBatched, commitInChunks
} = require('../firebase');
const pw = require('./passwords');
const email = require('./email');
const logger = require('./logger');
const { HttpError, invalidateUserCache } = require('../middleware');

const SETUP_TTL_HOURS = Number(process.env.PASSWORD_SETUP_TTL_HOURS || 24);

const EMPLOYEE_ID_PREFIX = { teacher: 'TCH', accountant: 'ACC', hr: 'HRM', admin: 'ADM' };

/** Allocate the next employee id for a role, e.g. TCH0007. */
async function allocateEmployeeId(role) {
    const prefix = EMPLOYEE_ID_PREFIX[role] || 'EMP';
    const seq = await nextSequence(`employeeId_${role}`);
    return `${prefix}${String(seq).padStart(4, '0')}`;
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
 * @returns {{userId: string, activation: object}}
 */
async function createAccount({
    username, role, fullName, emailAddress, phone,
    actor, req, preferSetupLink = true, mfaEnabled = null
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

    // Two-factor authentication defaults on, but only where email can actually
    // deliver the code — otherwise it would lock the account out immediately.
    const mfa = mfaEnabled === null ? canEmail : Boolean(mfaEnabled);

    const userId = await createUserWithUsername({
        username,
        password: passwordHash,
        role,
        fullName,
        email: emailAddress || '',
        phone: phone || '',
        isActive: true,
        mustChangePassword: !useSetupLink,
        passwordSetupCompleted: !useSetupLink,
        passwordSetupTokenHash: setupTokenHash,
        passwordSetupExpiresAt: setupExpiresAt,
        mfaEnabled: mfa,
        mfaMethod: 'email',
        tokenVersion: 0,
        createdBy: actor?.id || null
    });

    const activation = {
        method: useSetupLink ? 'setup_link' : 'temporary_password',
        emailSent: false,
        temporaryPassword,
        setupLinkExpiresInHours: useSetupLink ? SETUP_TTL_HOURS : null
    };

    if (useSetupLink) {
        const base = (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
        try {
            await email.sendPasswordSetupEmail({
                toEmail: emailAddress,
                fullName,
                setupLink: `${base}/setup-password.html?token=${setupToken}`,
                expiryHours: SETUP_TTL_HOURS
            });
            activation.emailSent = true;
        } catch (err) {
            logger.error('Failed to send setup email', { userId, error: err.message });
            activation.emailError = 'The account was created but the setup email could not be sent. Use "Resend setup link".';
        }
    } else if (emailAddress && email.isConfigured()) {
        const base = (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
        try {
            await email.sendTemporaryCredentialsEmail({
                toEmail: emailAddress,
                fullName,
                username,
                temporaryPassword,
                loginUrl: `${base}/`
            });
            activation.emailSent = true;
        } catch (err) {
            logger.error('Failed to send credentials email', { userId, error: err.message });
        }
    }

    return { userId, activation };
}

/** Issue a fresh setup link for an account that has not been activated yet. */
async function resendSetupLink({ userId, req }) {
    const user = docData(await users().doc(userId).get());
    if (!user) throw new HttpError(404, 'Account not found.', 'USER_NOT_FOUND');
    if (user.passwordSetupCompleted !== false) {
        throw new HttpError(400, 'This account is already active, so no setup link is needed. Use "Reset password" instead.', 'ALREADY_ACTIVE');
    }
    if (!user.email) throw new HttpError(400, 'This account has no email address on file.', 'NO_EMAIL');
    if (!email.isConfigured()) throw new HttpError(503, 'Email delivery is not configured.', 'EMAIL_UNAVAILABLE');

    const { token, tokenHash } = pw.generateToken(32);
    const expiresAt = new Date(Date.now() + SETUP_TTL_HOURS * 60 * 60 * 1000);

    await users().doc(userId).update({
        passwordSetupTokenHash: tokenHash,
        passwordSetupExpiresAt: expiresAt,
        updatedAt: serverTimestamp()
    });

    const base = (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    await email.sendPasswordSetupEmail({
        toEmail: user.email,
        fullName: user.fullName,
        setupLink: `${base}/setup-password.html?token=${token}`,
        expiryHours: SETUP_TTL_HOURS
    });

    return { email: user.email, expiresInHours: SETUP_TTL_HOURS };
}

/**
 * Deactivate an account.
 *
 * Preferred over deletion: staff appear on historical payroll runs, and those
 * records must stay intact and attributable. Also revokes live sessions.
 */
async function deactivateAccount({ userId, actor, reason }) {
    if (userId === actor.id) {
        throw new HttpError(400, 'You cannot deactivate your own account.', 'SELF_DEACTIVATE');
    }

    const user = docData(await users().doc(userId).get());
    if (!user) throw new HttpError(404, 'Account not found.', 'USER_NOT_FOUND');

    await assertNotLastAdmin(user, 'deactivate');

    const batch = getDb().batch();
    batch.update(users().doc(userId), {
        isActive: false,
        deactivatedAt: serverTimestamp(),
        deactivatedBy: actor.id,
        deactivationReason: reason || null,
        tokenVersion: FieldValue.increment(1),
        updatedAt: serverTimestamp()
    });

    // Mirror the status onto the role profile so lists and payroll agree.
    const profile = await findProfileByUserId(userId, user.role);
    if (profile) {
        batch.update(profile.ref, { isActive: false, updatedAt: serverTimestamp() });
    }

    await batch.commit();

    // Drop the cached copy so the revocation takes effect on the very next
    // request rather than whenever the cache happens to expire.
    invalidateUserCache(userId);

    return user;
}

async function reactivateAccount({ userId, actor }) {
    const user = docData(await users().doc(userId).get());
    if (!user) throw new HttpError(404, 'Account not found.', 'USER_NOT_FOUND');

    const batch = getDb().batch();
    batch.update(users().doc(userId), {
        isActive: true,
        deactivatedAt: FieldValue.delete(),
        deactivatedBy: FieldValue.delete(),
        deactivationReason: FieldValue.delete(),
        reactivatedAt: serverTimestamp(),
        reactivatedBy: actor.id,
        updatedAt: serverTimestamp()
    });

    const profile = await findProfileByUserId(userId, user.role);
    if (profile) batch.update(profile.ref, { isActive: true, updatedAt: serverTimestamp() });

    await batch.commit();
    invalidateUserCache(userId);

    return user;
}

/** Locate a user's role profile document (teacher/accountant), if any. */
async function findProfileByUserId(userId, role) {
    const collection = role === 'teacher' ? teachers() : role === 'accountant' ? accountants() : null;
    if (!collection) return null;

    const snap = await collection.where('userId', '==', userId).limit(1).get();
    if (snap.empty) return null;
    return { ref: snap.docs[0].ref, data: docData(snap.docs[0]) };
}

/** Refuse to remove the last route into the system. */
async function assertNotLastAdmin(user, verb) {
    if (user.role !== 'admin') return;

    const snap = await users()
        .where('role', '==', 'admin')
        .where('isActive', '==', true)
        .count()
        .get();

    if (snap.data().count <= 1) {
        throw new HttpError(
            400,
            `This is the only active administrator account, so it cannot be ${verb}d. Create another administrator first.`,
            'LAST_ADMIN'
        );
    }
}

/**
 * Permanently delete an account and its dependent records.
 *
 * The old implementation deleted the parent row and left referencing records
 * behind, so the request failed outright for anyone who had ever been audited or
 * paid. Deletion is now refused when payroll history exists — that record must
 * be preserved — and all other dependents are cleaned up explicitly.
 */
async function deleteAccount({ userId, actor }) {
    if (userId === actor.id) {
        throw new HttpError(400, 'You cannot delete your own account.', 'SELF_DELETE');
    }

    const user = docData(await users().doc(userId).get());
    if (!user) throw new HttpError(404, 'Account not found.', 'USER_NOT_FOUND');

    await assertNotLastAdmin(user, 'delete');

    const profile = await findProfileByUserId(userId, user.role);

    // Payroll history is immutable: block deletion and point to deactivation.
    if (profile && user.role === 'teacher') {
        const paid = await payrollItems().where('teacherId', '==', profile.data.id).limit(1).get();
        if (!paid.empty) {
            throw new HttpError(
                409,
                'This teacher appears on at least one payroll run, so the record cannot be deleted without destroying payroll history. Deactivate the account instead.',
                'HAS_PAYROLL_HISTORY'
            );
        }
    }

    // Remove dependents that carry no financial history.
    await deleteQueryBatched(notifications().where('userId', '==', userId));

    if (profile && user.role === 'teacher') {
        await deleteQueryBatched(leaveRequests().where('teacherId', '==', profile.data.id));
        await deleteQueryBatched(advanceRequests().where('teacherId', '==', profile.data.id));
    }

    // Keep audit entries, but detach them from the deleted account so the trail
    // survives while no longer pointing at a record that is gone.
    const auditSnap = await auditLog().where('userId', '==', userId).get();
    if (!auditSnap.empty) {
        await commitInChunks(auditSnap.docs.map(doc => (batch) => {
            batch.update(doc.ref, { userId: null, userDeleted: true });
        }));
    }

    const batch = getDb().batch();
    if (profile) batch.delete(profile.ref);
    batch.delete(users().doc(userId));
    await batch.commit();
    invalidateUserCache(userId);

    await releaseUsername(user.username);

    return user;
}

module.exports = {
    createAccount,
    resendSetupLink,
    deactivateAccount,
    reactivateAccount,
    deleteAccount,
    allocateEmployeeId,
    findProfileByUserId
};
