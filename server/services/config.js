/**
 * System configuration, stored one key per document in `systemConfig` so a write
 * to one setting cannot clobber another.
 *
 * Values are cached briefly because payroll processing reads them per run and
 * dashboards read them on every page load.
 */
const { systemConfig, serverTimestamp, docsData } = require('../firebase');
const { UGANDA_MONTHLY_PAYE_BANDS } = require('./tax');

const DEFAULTS = {
    schoolName: 'EduPay School',
    currency: 'UGX',
    payrollPeriod: 'monthly',
    taxEnabled: true,
    taxMode: 'banded',                  // 'banded' | 'flat' | 'none'
    taxBands: UGANDA_MONTHLY_PAYE_BANDS,
    nssfEmployeePercentage: 5,
    nssfEmployerPercentage: 10,
    minimumNetPercentage: 30,           // net pay floor, as a % of gross
    maxAdvancePercentage: 50,           // advance ceiling, as a % of monthly net
    defaultAnnualLeaveDays: 21,
    maxAdvanceInstalments: 6
};

const TYPES = {
    taxEnabled: 'boolean',
    nssfEmployeePercentage: 'number',
    nssfEmployerPercentage: 'number',
    minimumNetPercentage: 'number',
    maxAdvancePercentage: 'number',
    defaultAnnualLeaveDays: 'number',
    maxAdvanceInstalments: 'number',
    taxBands: 'json'
};

const CACHE_TTL_MS = 30 * 1000;
let cache = null;
let cachedAt = 0;

function coerce(key, value) {
    switch (TYPES[key]) {
        case 'boolean':
            return value === true || String(value).toLowerCase() === 'true';
        case 'number': {
            const n = Number(value);
            return Number.isFinite(n) ? n : DEFAULTS[key];
        }
        case 'json':
            if (typeof value === 'string') {
                try { return JSON.parse(value); } catch { return DEFAULTS[key]; }
            }
            return value;
        default:
            return value;
    }
}

/** Read the full configuration, merged over defaults. */
async function getConfig({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache;

    const snap = await systemConfig().get();
    const stored = {};
    docsData(snap).forEach(doc => {
        if (doc.value !== undefined) stored[doc.id] = coerce(doc.id, doc.value);
    });

    cache = { ...DEFAULTS, ...stored };
    cachedAt = Date.now();
    return cache;
}

/** Write a set of configuration keys. Unknown keys are rejected. */
async function updateConfig(updates) {
    const allowed = Object.keys(DEFAULTS);
    const applied = {};

    const writes = Object.entries(updates || {})
        .filter(([key]) => allowed.includes(key))
        .map(([key, value]) => {
            const coerced = coerce(key, value);
            applied[key] = coerced;
            return systemConfig().doc(key).set(
                { value: coerced, updatedAt: serverTimestamp() },
                { merge: true }
            );
        });

    if (!writes.length) {
        const err = new Error('No recognised configuration keys were supplied.');
        err.code = 'NO_VALID_KEYS';
        throw err;
    }

    await Promise.all(writes);
    invalidate();
    return applied;
}

function invalidate() {
    cache = null;
    cachedAt = 0;
}

module.exports = { DEFAULTS, getConfig, updateConfig, invalidate };
