/**
 * Leave handling.
 *
 * Leave used to be a bare record: no entitlement, no balance, no overlap check,
 * no validation that the end date followed the start date, and no effect on pay.
 *
 * Three of those are now database constraints — `leave_dates_ordered`,
 * `leave_length_sane` and the `leave_no_overlap` exclusion constraint — so they
 * hold even under concurrent requests. The validation kept here runs first
 * purely to give a clearer message than a constraint violation would.
 */
const db = require('../db');
const { HttpError } = require('../middleware');

const LEAVE_TYPES = {
    Annual: { paid: true, label: 'Annual leave' },
    Sick: { paid: true, label: 'Sick leave' },
    Maternity: { paid: true, label: 'Maternity leave' },
    Paternity: { paid: true, label: 'Paternity leave' },
    Compassionate: { paid: true, label: 'Compassionate leave' },
    Study: { paid: false, label: 'Study leave (unpaid)' },
    Unpaid: { paid: false, label: 'Unpaid leave' }
};

const DAY_MS = 24 * 60 * 60 * 1000;
const toUtc = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);

/** Inclusive day count between two ISO dates. */
function countDays(startIso, endIso) {
    return Math.floor((toUtc(endIso) - toUtc(startIso)) / DAY_MS) + 1;
}

/** Whether a leave type reduces pay. */
function isUnpaid(leaveType) {
    return LEAVE_TYPES[leaveType] ? !LEAVE_TYPES[leaveType].paid : false;
}

/**
 * Validate a requested range and return its day count.
 * Policy checks that the schema does not express: how far back leave may be
 * recorded, and how far ahead it may be booked.
 */
function validateRange(startIso, endIso, { maxDays = 120 } = {}) {
    const start = toUtc(startIso);
    const end = toUtc(endIso);

    if (end < start) {
        throw new HttpError(400, 'The end date cannot be before the start date.', 'LEAVE_RANGE_INVALID');
    }

    const days = countDays(startIso, endIso);
    if (days > maxDays) {
        throw new HttpError(400, `A single leave request cannot exceed ${maxDays} days.`, 'LEAVE_TOO_LONG');
    }
    if (start < new Date(Date.now() - 90 * DAY_MS)) {
        throw new HttpError(400, 'Leave cannot start more than 90 days in the past.', 'LEAVE_TOO_OLD');
    }
    if (start > new Date(Date.now() + 730 * DAY_MS)) {
        throw new HttpError(400, 'Leave cannot start more than two years in the future.', 'LEAVE_TOO_FAR');
    }

    return days;
}

/**
 * Report an overlap before attempting the insert, so the message can name the
 * clashing dates. The `leave_no_overlap` exclusion constraint is what actually
 * guarantees it; this is for the wording.
 */
async function findOverlap(teacherId, startIso, endIso, { excludeId = null } = {}) {
    return db.queryOne(
        `SELECT id, start_date, end_date, status
           FROM leave_requests
          WHERE teacher_id = $1
            AND status IN ('Pending', 'Approved')
            AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')
            AND ($4::bigint IS NULL OR id <> $4)
          LIMIT 1`,
        [teacherId, startIso, endIso, excludeId]
    );
}

async function assertNoOverlap(teacherId, startIso, endIso, options = {}) {
    const clash = await findOverlap(teacherId, startIso, endIso, options);
    if (clash) {
        throw new HttpError(
            409,
            `This overlaps leave you already have from ${clash.startDate} to ${clash.endDate} `
            + `(${String(clash.status).toLowerCase()}).`,
            'LEAVE_OVERLAP'
        );
    }
}

/**
 * Paid-leave balance for a calendar year.
 * Only paid types draw down the entitlement; unpaid leave reduces pay instead.
 */
async function getBalance(teacherId, { entitlementDays, year = new Date().getFullYear() }) {
    const rows = await db.query(
        `SELECT status, COALESCE(SUM(days), 0) AS days
           FROM leave_requests
          WHERE teacher_id = $1
            AND NOT is_unpaid
            AND status IN ('Pending', 'Approved')
            AND EXTRACT(YEAR FROM start_date) = $2
          GROUP BY status`,
        [teacherId, year]
    );

    const byStatus = Object.fromEntries(rows.map(row => [row.status, Number(row.days)]));
    const approved = byStatus.Approved || 0;
    const pending = byStatus.Pending || 0;
    const entitlement = Number(entitlementDays) || 0;

    return {
        year: Number(year),
        entitlementDays: entitlement,
        approvedDays: approved,
        pendingDays: pending,
        remainingDays: Math.max(0, entitlement - approved - pending)
    };
}

/**
 * Approved *unpaid* leave days falling inside a payroll period, for every teacher
 * in one query.
 *
 * Only the portion of each request that lies within the period counts, which the
 * database computes with LEAST/GREATEST on the date bounds. The previous
 * implementation issued one query per teacher and intersected the ranges in
 * JavaScript.
 */
async function unpaidDaysForPeriod(teacherIds, month, year) {
    const result = new Map();
    if (!teacherIds.length) return result;

    const rows = await db.query(
        `WITH period AS (
             SELECT make_date($2::int, $3::int, 1) AS starts,
                    (make_date($2::int, $3::int, 1) + INTERVAL '1 month - 1 day')::date AS ends
         )
         SELECT lr.teacher_id,
                SUM(
                    (LEAST(lr.end_date, p.ends) - GREATEST(lr.start_date, p.starts)) + 1
                ) AS days
           FROM leave_requests lr
          CROSS JOIN period p
          WHERE lr.teacher_id = ANY($1::bigint[])
            AND lr.status = 'Approved'
            AND lr.is_unpaid
            AND lr.start_date <= p.ends
            AND lr.end_date >= p.starts
          GROUP BY lr.teacher_id`,
        [teacherIds, year, month]
    );

    for (const row of rows) {
        result.set(Number(row.teacherId), Number(row.days) || 0);
    }
    return result;
}

/** Unpaid days in a period for one teacher. */
async function unpaidDaysInPeriod(teacherId, month, year) {
    const map = await unpaidDaysForPeriod([teacherId], month, year);
    return map.get(Number(teacherId)) || 0;
}

module.exports = {
    LEAVE_TYPES,
    countDays,
    isUnpaid,
    validateRange,
    findOverlap,
    assertNoOverlap,
    getBalance,
    unpaidDaysInPeriod,
    unpaidDaysForPeriod
};
