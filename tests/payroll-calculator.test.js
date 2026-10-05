const test = require('node:test');
const assert = require('node:assert/strict');
const { calculatePayrollItem, summarisePayroll, daysInMonth } = require('../server/services/payroll-calculator');

const teacher = { id: 't1', fullName: 'Grace Nakato', employeeId: 'TCH0001', salaryScale: 'Scale_2' };

const structure = {
    basicSalary: 1200000,
    housingAllowance: 150000,
    transportAllowance: 80000,
    medicalAllowance: 50000,
    otherAllowance: 0,
    nssfPercentage: 5,
    loanDeduction: 0,
    otherDeduction: 0
};

const config = {
    taxEnabled: true, taxMode: 'banded',
    nssfEmployeePercentage: 5, nssfEmployerPercentage: 10,
    minimumNetPercentage: 30, currency: 'UGX'
};

const base = { month: 6, year: 2026, config };

test('gross is the sum of basic and all allowances', () => {
    const line = calculatePayrollItem(teacher, structure, base);
    assert.equal(line.grossSalary, 1480000);
});

test('net equals gross less total deductions', () => {
    const line = calculatePayrollItem(teacher, structure, base);
    assert.equal(line.netSalary, line.grossSalary - line.totalDeductions);
});

test('employer NSSF is tracked but not deducted from net', () => {
    const line = calculatePayrollItem(teacher, structure, base);
    assert.equal(line.nssfEmployerAmount, 148000);
    assert.equal(line.employerCost, line.grossSalary + line.nssfEmployerAmount);
    // The employer share must not appear in the employee's deductions.
    const deductionSum = line.taxAmount + line.nssfAmount + line.loanDeduction
        + line.advanceDeduction + line.otherDeduction;
    assert.equal(line.totalDeductions, Math.round(deductionSum * 100) / 100);
});

test('unpaid leave abates basic pay pro rata and leaves allowances intact', () => {
    const line = calculatePayrollItem(teacher, structure, { ...base, unpaidLeaveDays: 3 });
    // June has 30 days, so three days costs a tenth of basic.
    assert.equal(line.unpaidLeaveDeduction, 120000);
    assert.equal(line.basicSalary, 1080000);
    assert.equal(line.contractualBasicSalary, 1200000);
    assert.equal(line.housingAllowance, 150000);
    assert.equal(line.grossSalary, 1360000);
});

test('unpaid leave days cannot exceed the length of the month', () => {
    const line = calculatePayrollItem(teacher, structure, { ...base, unpaidLeaveDays: 90 });
    assert.equal(line.unpaidLeaveDays, 30);
    assert.equal(line.basicSalary, 0);
});

test('an advance within capacity is deducted in full', () => {
    const line = calculatePayrollItem(teacher, structure, { ...base, advanceDeduction: 200000 });
    assert.equal(line.advanceDeduction, 200000);
    assert.equal(line.advanceDeferred, 0);
});

test('an oversized advance is trimmed to protect the net pay floor', () => {
    const line = calculatePayrollItem(teacher, structure, { ...base, advanceDeduction: 5000000 });
    const floor = line.grossSalary * 0.3;

    assert.ok(line.netSalary >= floor, 'net pay must not fall below the configured floor');
    assert.ok(line.advanceDeferred > 0, 'the untaken remainder must be carried forward');
    assert.equal(
        Math.round((line.advanceDeduction + line.advanceDeferred) * 100) / 100,
        5000000
    );
});

test('net pay never goes negative, even with a huge advance', () => {
    const line = calculatePayrollItem(teacher, structure, { ...base, advanceDeduction: 1e9 });
    assert.ok(line.netSalary >= 0, 'net pay must never be negative');
});

test('a missing salary structure yields zeros rather than NaN', () => {
    const line = calculatePayrollItem(teacher, null, base);
    assert.equal(line.grossSalary, 0);
    assert.equal(line.netSalary, 0);
    assert.ok(!Number.isNaN(line.totalDeductions));
});

test('totals sum each component across lines', () => {
    const lines = [
        calculatePayrollItem(teacher, structure, base),
        calculatePayrollItem({ ...teacher, id: 't2' }, structure, base)
    ];
    const totals = summarisePayroll(lines);

    assert.equal(totals.totalGross, lines[0].grossSalary * 2);
    assert.equal(totals.totalNet, lines[0].netSalary * 2);
    assert.equal(totals.totalNssfEmployer, lines[0].nssfEmployerAmount * 2);
    assert.equal(totals.totalEmployerCost, lines[0].employerCost * 2);
});

test('daysInMonth handles February in a leap year', () => {
    assert.equal(daysInMonth(2, 2024), 29);
    assert.equal(daysInMonth(2, 2026), 28);
    assert.equal(daysInMonth(12, 2026), 31);
});
