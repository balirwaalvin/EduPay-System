/**
 * System configuration, one row per setting in `system_config` so a write to one
 * setting cannot clobber another. Values are stored as JSONB, which keeps types
 * intact — a boolean comes back a boolean, and the tax band table comes back as
 * an array rather than a string that has to be parsed.
 *
 * Cached briefly because payroll reads it per run and dashboards read it on
 * every page load.
 */
const db = require('../db');
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

// camelCase in the application, snake_case keys in the table.
const toKey = (name) => name.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
const fromKey = (key) => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

const CACHE_TTL_MS = 30 * 1000;
let cache = null;
let cachedAt = 0;

/** Read the full configuration, merged over defaults. */
async function getConfig({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache;

    const rows = await db.query('SELECT config_key, config_value FROM system_config');

    const stored = {};
    for (const row of rows) {
        stored[fromKey(row.configKey)] = row.configValue;
    }

    cache = { ...DEFAULTS, ...stored };
    cachedAt = Date.now();
    return cache;
}

/** Write a set of configuration keys. Unknown keys are rejected. */
async function updateConfig(updates, actorId = null) {
    const allowed = Object.keys(DEFAULTS);
    const entries = Object.entries(updates || {}).filter(([name]) => allowed.includes(name));

    if (!entries.length) {
        const err = new Error('No recognised configuration keys were supplied.');
        err.code = 'NO_VALID_KEYS';
        throw err;
    }

    const applied = {};

    await db.withTransaction(async (client) => {
        for (const [name, rawValue] of entries) {
            const value = coerce(name, rawValue);
            applied[name] = value;

            await client.query(
                `INSERT INTO system_config (config_key, config_value, updated_by)
                 VALUES ($1, $2::jsonb, $3)
                 ON CONFLICT (config_key)
                 DO UPDATE SET config_value = $2::jsonb, updated_by = $3, updated_at = now()`,
                [toKey(name), JSON.stringify(value), actorId]
            );
        }
    });

    invalidate();
    return applied;
}

/** Coerce an incoming value to the type its default implies. */
function coerce(name, value) {
    const fallback = DEFAULTS[name];

    if (typeof fallback === 'boolean') {
        return value === true || String(value).toLowerCase() === 'true';
    }
    if (typeof fallback === 'number') {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }
    if (Array.isArray(fallback)) {
        if (typeof value === 'string') {
            try { return JSON.parse(value); } catch { return fallback; }
        }
        return Array.isArray(value) ? value : fallback;
    }
    return value;
}

function invalidate() {
    cache = null;
    cachedAt = 0;
}

/** Seed any missing settings with their defaults. */
async function ensureDefaults() {
    let created = 0;

    for (const [name, value] of Object.entries(DEFAULTS)) {
        const rowCount = await db.execute(
            `INSERT INTO system_config (config_key, config_value) VALUES ($1, $2::jsonb)
             ON CONFLICT (config_key) DO NOTHING`,
            [toKey(name), JSON.stringify(value)]
        );
        created += rowCount;
    }

    invalidate();
    return created;
}

module.exports = { DEFAULTS, getConfig, updateConfig, invalidate, ensureDefaults };
