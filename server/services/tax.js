/**
 * PAYE computation.
 *
 * The previous implementation charged a flat percentage of *basic* salary, which
 * matched neither Uganda's banded PAYE schedule nor its chargeable-income base.
 * This module implements the URA monthly schedule for resident individuals and
 * keeps the bands in configuration so they can be updated without a code change.
 */

// URA monthly PAYE schedule for resident individuals (amounts in UGX).
// `upTo: null` marks the final, open-ended band.
const UGANDA_MONTHLY_PAYE_BANDS = [
    { upTo: 235000, rate: 0, baseTax: 0, from: 0 },
    { upTo: 335000, rate: 0.10, baseTax: 0, from: 235000 },
    { upTo: 410000, rate: 0.20, baseTax: 10000, from: 335000 },
    { upTo: 10000000, rate: 0.30, baseTax: 25000, from: 410000 },
    { upTo: null, rate: 0.30, baseTax: 25000, from: 410000, surcharge: { over: 10000000, rate: 0.10 } }
];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Banded PAYE on chargeable income.
 * @param {number} chargeableIncome monthly chargeable income
 * @param {Array}  bands           band table; defaults to the URA monthly schedule
 * @returns {number} tax payable, rounded to 2dp
 */
function calculateBandedPaye(chargeableIncome, bands = UGANDA_MONTHLY_PAYE_BANDS) {
    const income = Number(chargeableIncome) || 0;
    if (income <= 0) return 0;

    const band = bands.find(b => b.upTo === null || income <= b.upTo);
    if (!band) return 0;

    let tax = Number(band.baseTax || 0) + Math.max(0, income - Number(band.from || 0)) * Number(band.rate || 0);

    // The top band carries an additional levy on income above its threshold.
    if (band.surcharge && income > band.surcharge.over) {
        tax += (income - band.surcharge.over) * band.surcharge.rate;
    }

    return round2(Math.max(0, tax));
}

/**
 * Resolve PAYE for one employee according to the active tax mode.
 *
 * mode `banded` (default) - URA schedule applied to chargeable income
 * mode `flat`             - legacy behaviour: a flat percentage of basic salary,
 *                           retained so historical figures can be reproduced
 * mode `none`             - PAYE switched off (honours the `taxEnabled` config flag)
 */
function calculatePaye({ grossSalary, basicSalary, taxPercentage, mode = 'banded', bands, taxEnabled = true }) {
    if (!taxEnabled || mode === 'none') return 0;

    if (mode === 'flat') {
        return round2((Number(basicSalary) || 0) * (Number(taxPercentage) || 0) / 100);
    }

    return calculateBandedPaye(grossSalary, bands && bands.length ? bands : UGANDA_MONTHLY_PAYE_BANDS);
}

/**
 * NSSF contributions. The employee share is a payroll deduction; the employer
 * share is an additional cost to the school and is *not* deducted from net pay,
 * but must still be tracked for the monthly NSSF return.
 */
function calculateNssf({ grossSalary, employeeRate = 5, employerRate = 10 }) {
    const gross = Number(grossSalary) || 0;
    return {
        employee: round2(gross * (Number(employeeRate) || 0) / 100),
        employer: round2(gross * (Number(employerRate) || 0) / 100)
    };
}

module.exports = {
    UGANDA_MONTHLY_PAYE_BANDS,
    calculateBandedPaye,
    calculatePaye,
    calculateNssf,
    round2
};
