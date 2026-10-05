/**
 * Leave handling.
 *
 * Leave used to be a bare record: no entitlement, no balance, no overlap check,
 * no validation that the end date followed the start date, and no effect on pay.
 * This module supplies the arithmetic the routes and payroll both need.
 */
const { leaveRequests, docsData } = require('../firebase');
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

/** Validate a requested range and return its day count. */
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

    // Allow a little backdating for leave recorded after the fact, but not more.
    const earliest = new Date(Date.now() - 90 * DAY_MS);
    if (start < earliest) {
        throw new HttpError(400, 'Leave cannot start more than 90 days in the past.', 'LEAVE_TOO_OLD');
    }

    const latest = new Date(Date.now() + 730 * DAY_MS);
    if (start > latest) {
        throw new HttpError(400, 'Leave cannot start more than two years in the future.', 'LEAVE_TOO_FAR');
    }

    return days;
}

/** Reject a request that overlaps an existing pending or approved one. */
async function assertNoOverlap(teacherId, startIso, endIso, { excludeId = null } = {}) {
    const snap = await leaveRequests()
        .where('teacherId', '==', teacherId)
        .where('status', 'in', ['Pending', 'Approved'])
        .get();

    const start = toUtc(startIso);
    const end = toUtc(endIso);

    const clash = docsData(snap).find(existing => {
        if (excludeId && existing.id === excludeId) return false;
        return toUtc(existing.startDate) <= end && toUtc(existing.endDate) >= start;
    });

    if (clash) {
        throw new HttpError(
            409,
            `This overlaps leave you already have from ${clash.startDate} to ${clash.endDate} (${clash.status.toLowerCase()}).`,
            'LEAVE_OVERLAP'
        );
    }
}

/**
 * Paid-leave balance for a calendar year.
 * Only paid types draw down the entitlement; unpaid leave reduces pay instead.
 */
async function getBalance(teacherId, { entitlementDays, year = new Date().getFullYear() }) {
    const snap = await leaveRequests()
        .where('teacherId', '==', teacherId)
        .where('status', 'in', ['Pending', 'Approved'])
        .get();

    let approved = 0;
    let pending = 0;

    docsData(snap).forEach(request => {
        if (toUtc(request.startDate).getUTCFullYear() !== Number(year)) return;
        if (isUnpaid(request.leaveType)) return;

        const days = Number(request.days || countDays(request.startDate, request.endDate));
        if (request.status === 'Approved') approved += days;
        else pending += days;
    });

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
 * Approved *unpaid* leave days falling inside a payroll period, used to abate
 * basic pay for that run.
 */
async function unpaidDaysInPeriod(teacherId, month, year) {
    const periodStart = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
    const periodEnd = new Date(Date.UTC(Number(year), Number(month), 0));

    const snap = await leaveRequests()
        .where('teacherId', '==', teacherId)
        .where('status', '==', 'Approved')
        .get();

    return docsData(snap).reduce((total, request) => {
        if (!isUnpaid(request.leaveType)) return total;

        // Count only the portion of the request that lies within the period.
        const start = toUtc(request.startDate);
        const end = toUtc(request.endDate);
        const overlapStart = start > periodStart ? start : periodStart;
        const overlapEnd = end < periodEnd ? end : periodEnd;

        if (overlapEnd < overlapStart) return total;
        return total + Math.floor((overlapEnd - overlapStart) / DAY_MS) + 1;
    }, 0);
}

/** Unpaid days for many teachers at once, as a Map of teacherId -> days. */
async function unpaidDaysForPeriod(teacherIds, month, year) {
    const result = new Map();
    const counts = await Promise.all(
        teacherIds.map(id => unpaidDaysInPeriod(id, month, year).then(days => [id, days]))
    );
    counts.forEach(([id, days]) => result.set(id, days));
    return result;
}

module.exports = {
    LEAVE_TYPES,
    countDays,
    isUnpaid,
    validateRange,
    assertNoOverlap,
    getBalance,
    unpaidDaysInPeriod,
    unpaidDaysForPeriod
};
