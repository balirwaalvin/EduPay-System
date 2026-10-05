const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateBandedPaye, calculatePaye, calculateNssf } = require('../server/services/tax');

test('PAYE is nil at or below the tax-free threshold', () => {
    assert.equal(calculateBandedPaye(0), 0);
    assert.equal(calculateBandedPaye(150000), 0);
    assert.equal(calculateBandedPaye(235000), 0);
});

test('PAYE in the 10% band charges only the excess over 235,000', () => {
    assert.equal(calculateBandedPaye(235001), 0.1);
    assert.equal(calculateBandedPaye(300000), 6500);
    assert.equal(calculateBandedPaye(335000), 10000);
});

test('PAYE in the 20% band adds to the 10,000 base', () => {
    assert.equal(calculateBandedPaye(335001), 10000.2);
    assert.equal(calculateBandedPaye(400000), 23000);
    assert.equal(calculateBandedPaye(410000), 25000);
});

test('PAYE in the 30% band adds to the 25,000 base', () => {
    assert.equal(calculateBandedPaye(410001), 25000.3);
    assert.equal(calculateBandedPaye(1000000), 202000);
    assert.equal(calculateBandedPaye(2000000), 502000);
});

test('the additional 10% applies above 10,000,000', () => {
    // 25,000 + 30% of 9,590,000 = 2,902,000 at the threshold.
    assert.equal(calculateBandedPaye(10000000), 2902000);
    // One million above: 30% on the excess plus the 10% surcharge on it.
    assert.equal(calculateBandedPaye(11000000), 2902000 + 300000 + 100000);
});

test('PAYE is never negative', () => {
    assert.equal(calculateBandedPaye(-50000), 0);
});

test('flat mode reproduces the legacy percentage-of-basic behaviour', () => {
    const result = calculatePaye({
        grossSalary: 1000000, basicSalary: 800000, taxPercentage: 10, mode: 'flat'
    });
    assert.equal(result, 80000);
});

test('PAYE is skipped when tax is disabled or mode is none', () => {
    assert.equal(calculatePaye({ grossSalary: 5000000, taxEnabled: false }), 0);
    assert.equal(calculatePaye({ grossSalary: 5000000, mode: 'none' }), 0);
});

test('banded mode assesses gross, not basic', () => {
    // A flat 10% of basic would be 80,000; the banded schedule on gross is higher.
    const banded = calculatePaye({ grossSalary: 1000000, basicSalary: 800000, taxPercentage: 10, mode: 'banded' });
    assert.equal(banded, 202000);
});

test('NSSF splits employee and employer shares on gross', () => {
    const nssf = calculateNssf({ grossSalary: 1000000 });
    assert.equal(nssf.employee, 50000);
    assert.equal(nssf.employer, 100000);
});

test('NSSF rates are configurable', () => {
    const nssf = calculateNssf({ grossSalary: 1000000, employeeRate: 0, employerRate: 15 });
    assert.equal(nssf.employee, 0);
    assert.equal(nssf.employer, 150000);
});
