/**
 * Notifications.
 *
 * Previously only teachers ever received one, so approvers had no signal that
 * work was waiting and had to poll their dashboards. This service can target a
 * single user or every active holder of a role, which is what the approval chain
 * needs:
 *
 *   teacher submits leave/advance -> HR is told there is something to approve
 *   accountant processes payroll  -> HR is told approval is pending
 *   HR approves payroll           -> accountant is told it is payable
 *   accountant marks paid         -> teacher is told
 */
const db = require('../db');
const logger = require('./logger');

const CATEGORIES = {
    leave: 'leave',
    advance: 'advance',
    payroll: 'payroll',
    payment: 'payment',
    account: 'account',
    system: 'system'
};

const COLUMNS = '(user_id, title, message, category, severity, link, actor_id)';

/** Notify one user. Resolves even if the write fails. */
async function notifyUser(userId, { title, message, category, severity, link, actorId }, client = null) {
    if (!userId) return;

    try {
        await db.execute(
            `INSERT INTO notifications ${COLUMNS} VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [userId, title, message, category || CATEGORIES.system, severity || 'info', link || null, actorId || null],
            client
        );
    } catch (err) {
        logger.error('Failed to create notification', { userId, error: err.message });
    }
}

/**
 * Notify every active user holding any of the given roles.
 *
 * One statement: the recipients are selected and inserted in the same query,
 * rather than read into the application and written back row by row.
 */
async function notifyRoles(roles, { title, message, category, severity, link, actorId }, client = null) {
    const roleList = Array.isArray(roles) ? roles : [roles];
    if (!roleList.length) return 0;

    try {
        return await db.execute(
            `INSERT INTO notifications ${COLUMNS}
             SELECT id, $1, $2, $3, $4, $5, $6
               FROM users
              WHERE role = ANY($7::text[]) AND is_active`,
            [title, message, category || CATEGORIES.system, severity || 'info',
                link || null, actorId || null, roleList],
            client
        );
    } catch (err) {
        logger.error('Failed to create role notifications', { roles: roleList, error: err.message });
        return 0;
    }
}

/** Notify many specific users with the same body. */
async function notifyUsers(userIds, { title, message, category, severity, link, actorId }, client = null) {
    const unique = [...new Set((userIds || []).filter(Boolean))];
    if (!unique.length) return 0;

    try {
        return await db.execute(
            `INSERT INTO notifications ${COLUMNS}
             SELECT unnest($1::bigint[]), $2, $3, $4, $5, $6, $7`,
            [unique, title, message, category || CATEGORIES.system, severity || 'info',
                link || null, actorId || null],
            client
        );
    } catch (err) {
        logger.error('Failed to create bulk notifications', { count: unique.length, error: err.message });
        return 0;
    }
}

/**
 * Notify many users with a per-user message, e.g. each teacher's own net pay.
 * Sent as one multi-row insert regardless of how many recipients there are.
 */
async function notifyUsersIndividually(entries, client = null) {
    const valid = (entries || []).filter(entry => entry && entry.userId);
    if (!valid.length) return 0;

    try {
        const { text, values } = db.buildBulkInsert(
            'notifications',
            ['user_id', 'title', 'message', 'category', 'severity', 'link', 'actor_id'],
            valid.map(entry => ({
                userId: entry.userId,
                title: entry.title,
                message: entry.message,
                category: entry.category || CATEGORIES.system,
                severity: entry.severity || 'info',
                link: entry.link || null,
                actorId: entry.actorId || null
            })),
            { returning: null }
        );

        return await db.execute(text, values, client);
    } catch (err) {
        logger.error('Failed to create individual notifications', { count: valid.length, error: err.message });
        return 0;
    }
}

/** List a user's notifications, newest first. */
async function listForUser(userId, { limit = 50, unreadOnly = false } = {}) {
    const capped = Math.min(Math.max(Number(limit) || 50, 1), 100);

    return db.query(
        `SELECT id, title, message, category, severity, link, is_read, created_at, read_at
           FROM notifications
          WHERE user_id = $1 ${unreadOnly ? 'AND NOT is_read' : ''}
          ORDER BY id DESC
          LIMIT $2`,
        [userId, capped]
    );
}

async function unreadCount(userId) {
    const count = await db.scalar(
        'SELECT count(*) AS count FROM notifications WHERE user_id = $1 AND NOT is_read',
        [userId]
    );
    return Number(count) || 0;
}

/** Mark one notification read, but only if it belongs to the caller. */
async function markRead(notificationId, userId) {
    const affected = await db.execute(
        `UPDATE notifications SET is_read = TRUE, read_at = now()
          WHERE id = $1 AND user_id = $2 AND NOT is_read`,
        [notificationId, userId]
    );

    if (affected) return true;

    // Distinguish "already read" from "not yours", so the caller can 404 correctly.
    const exists = await db.scalar(
        'SELECT count(*) AS count FROM notifications WHERE id = $1 AND user_id = $2',
        [notificationId, userId]
    );
    return Number(exists) > 0;
}

async function markAllRead(userId) {
    return db.execute(
        'UPDATE notifications SET is_read = TRUE, read_at = now() WHERE user_id = $1 AND NOT is_read',
        [userId]
    );
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
    markAllRead
};
