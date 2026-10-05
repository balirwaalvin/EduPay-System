const db = require('../db');
const logger = require('./logger');

/**
 * Append an audit entry. Never throws: a logging failure must not fail the
 * action being logged, but it is reported so it cannot disappear silently.
 */
function logAudit(actor, action, details, ip) {
    return db.execute(
        `INSERT INTO audit_log (user_id, username, role, action, details, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
            actor?.id || null,
            actor?.username || 'system',
            actor?.role || null,
            action,
            details || '',
            ip || ''
        ]
    ).catch(err => {
        logger.error('Failed to write audit entry', { action, error: err.message });
    });
}

/**
 * Read the audit log with keyset pagination.
 *
 * The log is append-only and its ids are monotonic, so paging on `id` is both
 * correct and index-friendly — and unlike OFFSET it stays fast at any depth.
 */
async function listAudit({ limit = 50, cursor = null, action = null, username = null, since = null } = {}) {
    const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);

    const conditions = [];
    const params = [];

    if (action) {
        params.push(action);
        conditions.push(`action = $${params.length}`);
    }
    if (username) {
        params.push(String(username).toLowerCase());
        conditions.push(`username = $${params.length}`);
    }
    if (since) {
        params.push(new Date(since));
        conditions.push(`created_at >= $${params.length}`);
    }
    if (cursor) {
        params.push(Number(cursor));
        conditions.push(`id < $${params.length}`);
    }

    params.push(capped + 1);

    const rows = await db.query(
        `SELECT id, user_id, username, role, action, details, ip_address, user_deleted, created_at
           FROM audit_log
          ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
          ORDER BY id DESC
          LIMIT $${params.length}`,
        params
    );

    const hasMore = rows.length > capped;
    const entries = hasMore ? rows.slice(0, capped) : rows;

    return {
        entries,
        nextCursor: hasMore ? String(entries[entries.length - 1].id) : null,
        hasMore
    };
}

/** Distinct actions present in the log, for the filter dropdown. */
async function listActions() {
    const rows = await db.query('SELECT DISTINCT action FROM audit_log ORDER BY action');
    return rows.map(row => row.action);
}

module.exports = { logAudit, listAudit, listActions };
