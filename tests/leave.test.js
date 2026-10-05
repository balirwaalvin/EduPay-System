const test = require('node:test');
const assert = require('node:assert/strict');
const leave = require('../server/services/leave');

const iso = (offsetDays) => {
    const date = new Date(Date.now() + offsetDays * 86400000);
    return date.toISOString().slice(0, 10);
};

test('day counts are inclusive of both endpoints', () => {
    assert.equal(leave.countDays('2026-06-01', '2026-06-01'), 1);
    assert.equal(leave.countDays('2026-06-01', '2026-06-05'), 5);
    assert.equal(leave.countDays('2026-06-01', '2026-06-30'), 30);
});

test('day counts span month and year boundaries', () => {
    assert.equal(leave.countDays('2026-01-30', '2026-02-02'), 4);
    assert.equal(leave.countDays('2026-12-30', '2027-01-02'), 4);
});

test('paid and unpaid leave types are distinguished', () => {
    assert.equal(leave.isUnpaid('Annual'), false);
    assert.equal(leave.isUnpaid('Sick'), false);
    assert.equal(leave.isUnpaid('Unpaid'), true);
    assert.equal(leave.isUnpaid('Study'), true);
});

test('an end date before the start date is rejected', () => {
    assert.throws(
        () => leave.validateRange(iso(10), iso(5)),
        err => err.code === 'LEAVE_RANGE_INVALID'
    );
});

test('a valid range returns its day count', () => {
    assert.equal(leave.validateRange(iso(5), iso(9)), 5);
});

test('an excessively long request is rejected', () => {
    assert.throws(
        () => leave.validateRange(iso(1), iso(200)),
        err => err.code === 'LEAVE_TOO_LONG'
    );
});

test('leave starting far in the past is rejected', () => {
    assert.throws(
        () => leave.validateRange(iso(-200), iso(-195)),
        err => err.code === 'LEAVE_TOO_OLD'
    );
});

test('leave starting far in the future is rejected', () => {
    assert.throws(
        () => leave.validateRange(iso(900), iso(905)),
        err => err.code === 'LEAVE_TOO_FAR'
    );
});

test('modest backdating is allowed, for leave recorded after the fact', () => {
    assert.equal(leave.validateRange(iso(-10), iso(-8)), 3);
});
