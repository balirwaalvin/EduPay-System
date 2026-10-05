const test = require('node:test');
const assert = require('node:assert/strict');
const advances = require('../server/services/advances');

test('the advance ceiling is a percentage of net pay', () => {
    assert.equal(advances.maxAdvanceFor(1000000, { maxAdvancePercentage: 50 }), 500000);
    assert.equal(advances.maxAdvanceFor(1000000, { maxAdvancePercentage: 100 }), 1000000);
    assert.equal(advances.maxAdvanceFor(1000000, { maxAdvancePercentage: 0 }), 0);
});

test('a single-instalment advance is due in full', () => {
    const due = advances.instalmentAmount({
        amount: 300000, instalments: 1, amountRepaid: 0, instalmentsPaid: 0
    });
    assert.equal(due, 300000);
});

test('a multi-instalment advance splits evenly', () => {
    const due = advances.instalmentAmount({
        amount: 300000, instalments: 3, amountRepaid: 0, instalmentsPaid: 0
    });
    assert.equal(due, 100000);
});

test('the final instalment clears the remainder, so rounding leaves no tail', () => {
    // 100,000 over 3 instalments is 33,333.33 each; the last must settle the rest.
    const advance = { amount: 100000, instalments: 3, amountRepaid: 66666.66, instalmentsPaid: 2 };
    const due = advances.instalmentAmount(advance);

    assert.equal(due, 33333.34);
    assert.equal(Math.round((advance.amountRepaid + due) * 100) / 100, 100000);
});

test('a fully repaid advance has nothing due', () => {
    assert.equal(advances.instalmentAmount({
        amount: 300000, instalments: 3, amountRepaid: 300000, instalmentsPaid: 3
    }), 0);
});

test('an over-repaid advance never returns a negative amount', () => {
    assert.equal(advances.instalmentAmount({
        amount: 300000, instalments: 3, amountRepaid: 400000, instalmentsPaid: 3
    }), 0);
});

test('a missing instalment count is treated as one', () => {
    assert.equal(advances.instalmentAmount({ amount: 50000 }), 50000);
});

test('the open statuses are the ones that block a new request', () => {
    assert.deepEqual(advances.OPEN_STATUSES, ['Pending', 'Approved', 'Repaying']);
    assert.ok(advances.STATUSES.includes('Settled'));
    assert.ok(advances.STATUSES.includes('Cancelled'));
});
