/**
 * Salary advances.
 *
 * Previously an approved advance was deducted in full from the next payroll, with
 * no ceiling relative to pay and no floor under net pay, so an advance larger
 * than someone's salary produced a negative payslip. Advances now have a cap and
 * an instalment schedule, and the calculator trims each instalment so net pay
 * cannot fall below the configured floor.
 */
const { advanceRequests, docsData, serverTimestamp, FieldValue } = require('../firebase');
const { round2 } = require('./tax');
const { HttpError } = require('../middleware');

const STATUSES = ['Pending', 'Approved', 'Repaying', 'Settled', 'Rejected', 'Cancelled'];
const OPEN_STATUSES = ['Pending', 'Approved', 'Repaying'];

/** Cap an advance against estimated monthly net pay. */
function maxAdvanceFor(estimatedNetPay, config) {
    const pct = Number(config.maxAdvancePercentage ?? 50);
    return round2((Number(estimatedNetPay) || 0) * pct / 100);
}

/** Reject a second request while one is still outstanding. */
async function assertNoOpenRequest(teacherId) {
    const snap = await advanceRequests()
        .where('teacherId', '==', teacherId)
        .where('status', 'in', OPEN_STATUSES)
        .limit(1)
        .get();

    if (!snap.empty) {
        const existing = docsData(snap)[0];
        throw new HttpError(
            409,
            `You already have an advance that is ${existing.status.toLowerCase()}. It must be settled before you can request another.`,
            'ADVANCE_ALREADY_OPEN'
        );
    }
}

/** Per-instalment amount for an advance. */
function instalmentAmount(advance) {
    const total = Number(advance.amount) || 0;
    const instalments = Math.max(1, Number(advance.instalments) || 1);
    const repaid = Number(advance.amountRepaid) || 0;
    const outstanding = round2(Math.max(0, total - repaid));
    if (outstanding <= 0) return 0;

    const remainingInstalments = Math.max(1, instalments - Number(advance.instalmentsPaid || 0));
    // Settle the remainder on the final instalment so rounding cannot leave a tail.
    return remainingInstalments === 1 ? outstanding : round2(Math.min(outstanding, total / instalments));
}

/**
 * Advances due for deduction in the next payroll, as a Map of
 * teacherId -> { advanceId, amountDue, outstanding, ... }.
 */
async function dueForPayroll(teacherIds) {
    const result = new Map();
    if (!teacherIds.length) return result;

    const snap = await advanceRequests()
        .where('status', 'in', ['Approved', 'Repaying'])
        .get();

    docsData(snap).forEach(advance => {
        if (!teacherIds.includes(advance.teacherId)) return;

        const amountDue = instalmentAmount(advance);
        if (amountDue <= 0) return;

        // Only one advance per teacher can be open, so the last write wins safely.
        result.set(advance.teacherId, {
            advanceId: advance.id,
            amountDue,
            total: Number(advance.amount) || 0,
            outstanding: round2((Number(advance.amount) || 0) - (Number(advance.amountRepaid) || 0)),
            instalments: Number(advance.instalments) || 1,
            instalmentsPaid: Number(advance.instalmentsPaid) || 0
        });
    });

    return result;
}

/**
 * Record a repayment against an advance, inside an existing batch.
 * Marks the advance settled once it is fully repaid.
 */
function applyRepayment(batch, advanceId, { amount, payrollId, isFinal }) {
    batch.update(advanceRequests().doc(advanceId), {
        amountRepaid: FieldValue.increment(round2(amount)),
        instalmentsPaid: FieldValue.increment(1),
        status: isFinal ? 'Settled' : 'Repaying',
        lastDeductedPayrollId: payrollId,
        lastDeductedAt: serverTimestamp(),
        settledAt: isFinal ? serverTimestamp() : null,
        updatedAt: serverTimestamp()
    });
}

/**
 * Reverse every repayment recorded against a payroll run, used when a run is
 * voided and reprocessed so advances are not double-counted.
 */
async function reverseRepaymentsForPayroll(payrollId, items) {
    const affected = items.filter(item => item.advanceId && Number(item.advanceDeduction) > 0);
    if (!affected.length) return;

    const { commitInChunks } = require('../firebase');
    await commitInChunks(affected.map(item => (batch) => {
        batch.update(advanceRequests().doc(item.advanceId), {
            amountRepaid: FieldValue.increment(-round2(item.advanceDeduction)),
            instalmentsPaid: FieldValue.increment(-1),
            status: 'Repaying',
            settledAt: null,
            reversedFromPayrollId: payrollId,
            updatedAt: serverTimestamp()
        });
    }));
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
