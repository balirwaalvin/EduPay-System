/**
 * Payroll calculation.
 *
 * Extracted from the route handler so it can be unit-tested in isolation and so
 * there is exactly one definition of how a payslip's numbers are derived.
 */
const { calculatePaye, calculateNssf, round2 } = require('./tax');

/** Calendar days in a given month (month is 1-based). */
function daysInMonth(month, year) {
    return new Date(Number(year), Number(month), 0).getDate();
}

/**
 * Compute one teacher's payroll line.
 *
 * @param {object}  teacher              teacher record (needs salaryScale, id)
 * @param {object}  structure            matching salary structure
 * @param {object}  options
 * @param {number}  options.advanceDeduction  advance instalment due this period
 * @param {number}  options.unpaidLeaveDays   approved unpaid-leave days in the period
 * @param {number}  options.month             1-based month
 * @param {number}  options.year
 * @param {object}  options.config            system config (taxMode, rates, netFloor...)
 * @returns {object} full payroll line, all amounts rounded to 2dp
 */
function calculatePayrollItem(teacher, structure, options = {}) {
    const {
        advanceDeduction = 0,
        unpaidLeaveDays = 0,
        month,
        year,
        config = {}
    } = options;

    const s = structure || {};
    const basicFull = Number(s.basicSalary) || 0;
    const housing = Number(s.housingAllowance) || 0;
    const transport = Number(s.transportAllowance) || 0;
    const medical = Number(s.medicalAllowance) || 0;
    const otherAllow = Number(s.otherAllowance) || 0;

    // Unpaid leave is pro-rated against basic salary only; allowances are not abated.
    const periodDays = daysInMonth(month || 1, year || new Date().getFullYear());
    const cappedLeaveDays = Math.min(Math.max(Number(unpaidLeaveDays) || 0, 0), periodDays);
    const unpaidLeaveDeduction = round2(cappedLeaveDays > 0 ? (basicFull / periodDays) * cappedLeaveDays : 0);
    const basic = round2(Math.max(0, basicFull - unpaidLeaveDeduction));

    const gross = round2(basic + housing + transport + medical + otherAllow);

    const taxEnabled = config.taxEnabled !== false && String(config.taxEnabled) !== 'false';
    const taxAmount = calculatePaye({
        grossSalary: gross,
        basicSalary: basic,
        taxPercentage: Number(s.taxPercentage) || 0,
        mode: config.taxMode || 'banded',
        bands: config.taxBands,
        taxEnabled
    });

    const nssf = calculateNssf({
        grossSalary: gross,
        employeeRate: s.nssfPercentage !== undefined && s.nssfPercentage !== null
            ? Number(s.nssfPercentage)
            : Number(config.nssfEmployeePercentage ?? 5),
        employerRate: Number(config.nssfEmployerPercentage ?? 10)
    });

    const loanDeduction = Number(s.loanDeduction) || 0;
    const otherDeduction = Number(s.otherDeduction) || 0;

    // Unpaid leave has already been applied by abating basic salary, so it is not
    // repeated here. Statutory and fixed deductions are taken first; the advance
    // instalment is then trimmed so net pay cannot fall below the configured floor.
    const baseDeductions = round2(taxAmount + nssf.employee + loanDeduction + otherDeduction);
    const netBeforeAdvance = round2(gross - baseDeductions);

    const netFloorPercent = Number(config.minimumNetPercentage ?? 30);
    const netFloor = round2(gross * netFloorPercent / 100);
    const advanceCapacity = round2(Math.max(0, netBeforeAdvance - netFloor));

    const requestedAdvance = round2(Math.max(0, Number(advanceDeduction) || 0));
    const appliedAdvance = round2(Math.min(requestedAdvance, advanceCapacity));
    const deferredAdvance = round2(requestedAdvance - appliedAdvance);

    const totalDeductions = round2(baseDeductions + appliedAdvance);
    const netSalary = round2(gross - totalDeductions);

    return {
        teacherId: teacher.id,
        teacherName: teacher.fullName,
        employeeId: teacher.employeeId,
        salaryScale: teacher.salaryScale,

        basicSalary: basic,
        contractualBasicSalary: basicFull,
        housingAllowance: housing,
        transportAllowance: transport,
        medicalAllowance: medical,
        otherAllowance: otherAllow,
        grossSalary: gross,

        taxAmount,
        nssfAmount: nssf.employee,
        nssfEmployerAmount: nssf.employer,
        loanDeduction,
        advanceDeduction: appliedAdvance,
        advanceDeferred: deferredAdvance,
        unpaidLeaveDays: cappedLeaveDays,
        unpaidLeaveDeduction,
        otherDeduction,
        totalDeductions,
        netSalary,

        // Total cost to the school for this employee.
        employerCost: round2(gross + nssf.employer),
        paymentStatus: 'Pending'
    };
}

/** Sum a set of payroll lines into the run-level totals. */
function summarisePayroll(items) {
    return items.reduce((acc, item) => ({
        totalGross: round2(acc.totalGross + item.grossSalary),
        totalDeductions: round2(acc.totalDeductions + item.totalDeductions),
        totalNet: round2(acc.totalNet + item.netSalary),
        totalPaye: round2(acc.totalPaye + item.taxAmount),
        totalNssfEmployee: round2(acc.totalNssfEmployee + item.nssfAmount),
        totalNssfEmployer: round2(acc.totalNssfEmployer + item.nssfEmployerAmount),
        totalEmployerCost: round2(acc.totalEmployerCost + item.employerCost)
    }), {
        totalGross: 0, totalDeductions: 0, totalNet: 0,
        totalPaye: 0, totalNssfEmployee: 0, totalNssfEmployer: 0, totalEmployerCost: 0
    });
}

module.exports = { calculatePayrollItem, summarisePayroll, daysInMonth };
