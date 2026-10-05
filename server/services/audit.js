const { auditLog, serverTimestamp, docsData } = require('../firebase');
const logger = require('./logger');

/**
 * Append an audit entry. Never throws: a logging failure must not fail the action
 * being logged, but it is reported so it cannot disappear silently.
 */
function logAudit(actor, action, details, ip) {
    const entry = {
        userId: actor?.id || null,
        username: actor?.username || 'system',
        role: actor?.role || null,
        action,
        details: details || '',
        ipAddress: ip || '',
        createdAt: serverTimestamp()
    };

    return auditLog().add(entry).catch(err => {
        logger.error('Failed to write audit entry', { action, error: err.message });
    });
}

/**
 * Read the audit log with cursor pagination and optional filters.
 * Firestore has no OFFSET, so paging uses the last document id as a cursor.
 */
async function listAudit({ limit = 50, cursor = null, action = null, username = null, since = null } = {}) {
    let query = auditLog().orderBy('createdAt', 'desc');

    if (action) query = query.where('action', '==', action);
    if (username) query = query.where('username', '==', String(username).toLowerCase());
    if (since) query = query.where('createdAt', '>=', new Date(since));

    if (cursor) {
        const cursorSnap = await auditLog().doc(cursor).get();
        if (cursorSnap.exists) query = query.startAfter(cursorSnap);
    }

    const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const snap = await query.limit(capped + 1).get();
    const rows = docsData(snap);

    const hasMore = rows.length > capped;
    const page = hasMore ? rows.slice(0, capped) : rows;

    return {
        entries: page,
        nextCursor: hasMore ? page[page.length - 1].id : null,
        hasMore
    };
}

module.exports = { logAudit, listAudit };
