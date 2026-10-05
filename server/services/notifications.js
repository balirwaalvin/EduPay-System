/**
 * Notifications.
 *
 * Previously only teachers ever received a notification, so approvers had no
 * signal that work was waiting for them and had to poll their dashboards. This
 * service can target a single user or every active holder of a role, which is
 * what the approval chain needs:
 *
 *   teacher submits leave/advance -> HR is told there is something to approve
 *   accountant processes payroll  -> HR is told approval is pending
 *   HR approves payroll           -> accountant is told it is payable
 *   accountant marks paid         -> teacher is told
 */
const { notifications, users, serverTimestamp, docsData, commitInChunks } = require('../firebase');
const logger = require('./logger');

const CATEGORIES = {
    leave: 'leave',
    advance: 'advance',
    payroll: 'payroll',
    payment: 'payment',
    account: 'account',
    system: 'system'
};

function buildNotification({ title, message, category, link, severity, actorId }) {
    return {
        title,
        message,
        category: category || CATEGORIES.system,
        severity: severity || 'info',
        link: link || null,
        actorId: actorId || null,
        isRead: false,
        createdAt: serverTimestamp()
    };
}

/** Notify one user by user id. Resolves even if the write fails. */
async function notifyUser(userId, payload) {
    if (!userId) return;
    try {
        await notifications().add({ userId, ...buildNotification(payload) });
    } catch (err) {
        logger.error('Failed to create notification', { userId, error: err.message });
    }
}

/** Notify every active user holding any of the given roles. */
async function notifyRoles(roles, payload) {
    const roleList = Array.isArray(roles) ? roles : [roles];
    if (!roleList.length) return;

    try {
        const snap = await users()
            .where('role', 'in', roleList.slice(0, 10))
            .where('isActive', '==', true)
            .get();

        const recipients = docsData(snap);
        if (!recipients.length) return;

        const body = buildNotification(payload);
        await commitInChunks(recipients.map(user => (batch) => {
            batch.set(notifications().doc(), { userId: user.id, ...body });
        }));
    } catch (err) {
        logger.error('Failed to create role notifications', { roles: roleList, error: err.message });
    }
}

/** Notify many specific users with the same body in as few writes as possible. */
async function notifyUsers(userIds, payload) {
    const unique = [...new Set((userIds || []).filter(Boolean))];
    if (!unique.length) return;

    try {
        const body = buildNotification(payload);
        await commitInChunks(unique.map(userId => (batch) => {
            batch.set(notifications().doc(), { userId, ...body });
        }));
    } catch (err) {
        logger.error('Failed to create bulk notifications', { count: unique.length, error: err.message });
    }
}

/** Notify many users with a per-user message (e.g. each teacher's own net pay). */
async function notifyUsersIndividually(entries) {
    const valid = (entries || []).filter(e => e && e.userId);
    if (!valid.length) return;

    try {
        await commitInChunks(valid.map(entry => (batch) => {
            batch.set(notifications().doc(), { userId: entry.userId, ...buildNotification(entry) });
        }));
    } catch (err) {
        logger.error('Failed to create individual notifications', { count: valid.length, error: err.message });
    }
}

/** List a user's notifications, newest first. */
async function listForUser(userId, { limit = 50, unreadOnly = false } = {}) {
    let query = notifications().where('userId', '==', userId);
    if (unreadOnly) query = query.where('isRead', '==', false);

    const snap = await query
        .orderBy('createdAt', 'desc')
        .limit(Math.min(Math.max(Number(limit) || 50, 1), 100))
        .get();

    return docsData(snap);
}

async function unreadCount(userId) {
    const snap = await notifications()
        .where('userId', '==', userId)
        .where('isRead', '==', false)
        .count()
        .get();
    return snap.data().count;
}

/** Mark one notification read, but only if it belongs to the caller. */
async function markRead(notificationId, userId) {
    const ref = notifications().doc(notificationId);
    const snap = await ref.get();
    if (!snap.exists || snap.data().userId !== userId) return false;
    await ref.update({ isRead: true, readAt: serverTimestamp() });
    return true;
}

async function markAllRead(userId) {
    const snap = await notifications()
        .where('userId', '==', userId)
        .where('isRead', '==', false)
        .get();

    if (snap.empty) return 0;

    await commitInChunks(snap.docs.map(doc => (batch) => {
        batch.update(doc.ref, { isRead: true, readAt: serverTimestamp() });
    }));
    return snap.size;
}

/** Remove a user's notifications — used when an account is deleted. */
async function deleteForUser(userId) {
    const snap = await notifications().where('userId', '==', userId).get();
    if (snap.empty) return 0;
    await commitInChunks(snap.docs.map(doc => (batch) => batch.delete(doc.ref)));
    return snap.size;
}

module.exports = {
    CATEGORIES,
    notifyUser,
    notifyUsers,
    notifyUsersIndividually,
    notifyRoles,
    listForUser,
    unreadCount,
    markRead,
    markAllRead,
    deleteForUser
};
