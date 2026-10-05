/**
 * Salary advances.
 *
 * Previously an approved advance was deducted in full from the next payroll, with
 * no ceiling relative to pay and no floor under net pay, so an advance larger
 * than someone's salary produced a negative payslip.
 *
 * Advances now have a cap and an instalment schedule, and the calculator trims
 * each instalment so net pay cannot fall below the configured floor. Two
 * invariants are enforced by the schema rather than by application checks: at
 * most one open advance per teacher (a partial unique index) and never repaying
 * more than was advanced (a check constraint).
 */
const db = require('../db');
const { round2 } = require('./tax');
const { HttpError } = require('../middleware');

const STATUSES = ['Pending', 'Approved', 'Repaying', 'Settled', 'Rejected', 'Cancelled'];
const OPEN_STATUSES = ['Pending', 'Approved', 'Repaying'];

/** Cap an advance against estimated monthly net pay. */
function maxAdvanceFor(estimatedNetPay, config) {
    const pct = Number(config.maxAdvancePercentage ?? 50);
    return round2((Number(estimatedNetPay) || 0) * pct / 100);
}

/**
 * Report an existing open advance before attempting the insert, so the message
 * can say what state it is in. The `advance_one_open_per_teacher` index is what
 * actually guarantees it.
 */
async function assertNoOpenRequest(teacherId) {
    const existing = await db.queryOne(
        `SELECT id, status FROM advance_requests
          WHERE teacher_id = $1 AND status = ANY($2::text[])
          LIMIT 1`,
        [teacherId, OPEN_STATUSES]
    );

    if (existing) {
        throw new HttpError(
            409,
            `You already have an advance that is ${String(existing.status).toLowerCase()}. `
            + 'It must be settled before you can request another.',
            'ADVANCE_ALREADY_OPEN'
        );
    }
}

/**
 * Per-instalment amount for an advance.
 * The final instalment settles the remainder so rounding cannot leave a tail.
 */
function instalmentAmount(advance) {
    const total = Number(advance.amount) || 0;
    const instalments = Math.max(1, Number(advance.instalments) || 1);
    const repaid = Number(advance.amountRepaid) || 0;

    const outstanding = round2(Math.max(0, total - repaid));
    if (outstanding <= 0) return 0;

    const remaining = Math.max(1, instalments - Number(advance.instalmentsPaid || 0));
    return remaining === 1 ? outstanding : round2(Math.min(outstanding, total / instalments));
}

/**
 * Advances due for deduction in the next payroll, as a Map of
 * teacherId -> { advanceId, amountDue, outstanding, ... }.
 */
async function dueForPayroll(teacherIds, client = null) {
    const result = new Map();
    if (!teacherIds.length) return result;

    const rows = await db.query(
        `SELECT id, teacher_id, amount, instalments, amount_repaid, instalments_paid,
                (amount - amount_repaid) AS outstanding
           FROM advance_requests
          WHERE teacher_id = ANY($1::bigint[])
            AND status IN ('Approved', 'Repaying')
            AND amount_repaid < amount`,
        [teacherIds],
        client
    );

    for (const row of rows) {
        const amountDue = instalmentAmount(row);
        if (amountDue <= 0) continue;

        result.set(Number(row.teacherId), {
            advanceId: Number(row.id),
            amountDue,
            total: Number(row.amount),
            outstanding: round2(Number(row.outstanding)),
            instalments: Number(row.instalments),
            instalmentsPaid: Number(row.instalmentsPaid)
        });
    }

    return result;
}

/**
 * Record a repayment against an advance, marking it settled once fully repaid.
 * Takes a transaction client so it commits atomically with the payroll run.
 */
async function applyRepayment(client, advanceId, { amount, payrollId }) {
    await client.query(
        `UPDATE advance_requests
            SET amount_repaid    = amount_repaid + $1,
                instalments_paid = instalments_paid + 1,
                status           = CASE WHEN amount_repaid + $1 >= amount THEN 'Settled' ELSE 'Repaying' END,
                settled_at       = CASE WHEN amount_repaid + $1 >= amount THEN now() ELSE NULL END,
                last_deducted_payroll_id = $2,
                last_deducted_at = now()
          WHERE id = $3`,
        [round2(amount), payrollId, advanceId]
    );
}

/**
 * Reverse every repayment recorded against a payroll run, used when a run is
 * superseded so advances are not double-counted.
 */
async function reverseRepaymentsForPayroll(client, payrollId, version) {
    const affected = await client.query(
        `UPDATE advance_requests a
            SET amount_repaid    = GREATEST(0, a.amount_repaid - r.total),
                instalments_paid = GREATEST(0, a.instalments_paid - r.lines),
                status           = CASE
                                      WHEN GREATEST(0, a.amount_repaid - r.total) <= 0 THEN 'Approved'
                                      ELSE 'Repaying'
                                   END,
                settled_at       = NULL
           FROM (
                SELECT advance_id, SUM(advance_deduction) AS total, COUNT(*) AS lines
                  FROM payroll_items
                 WHERE payroll_id = $1 AND version = $2
                   AND advance_id IS NOT NULL AND advance_deduction > 0
                 GROUP BY advance_id
           ) r
          WHERE a.id = r.advance_id
          RETURNING a.id`,
        [payrollId, version]
    );

    return affected.rowCount;
}

module.exports = {
    STATUSES,
    OPEN_STATUSES,
    maxAdvanceFor,
    assertNoOpenRequest,
    instalmentAmount,
    dueForPayroll,
    applyRepayment,
    reverseRepaymentsForPayroll
};
