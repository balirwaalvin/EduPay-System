/**
 * Request validation helpers.
 *
 * Collected here because the routes previously accepted almost anything: payroll
 * would process month 47 of year 1823, and leave requests accepted an end date
 * before their start date.
 */
const { HttpError } = require('../middleware');

const fail = (message, code = 'VALIDATION_FAILED') => { throw new HttpError(400, message, code); };

/** Trimmed, length-checked string. */
function str(value, label, { required = true, min = 1, max = 500 } = {}) {
    const trimmed = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
    if (!trimmed) {
        if (required) fail(`${label} is required.`);
        return null;
    }
    if (trimmed.length < min) fail(`${label} must be at least ${min} characters.`);
    if (trimmed.length > max) fail(`${label} must be ${max} characters or fewer.`);
    return trimmed;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function email(value, label = 'Email', { required = false } = {}) {
    const trimmed = str(value, label, { required, max: 254 });
    if (!trimmed) return null;
    if (!EMAIL_RE.test(trimmed)) fail(`${label} is not a valid email address.`);
    return trimmed.toLowerCase();
}

/** Usernames become document ids, so restrict them to a safe character set. */
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

function username(value, label = 'Username') {
    const trimmed = String(value || '').trim().toLowerCase();
    if (!trimmed) fail(`${label} is required.`);
    if (!USERNAME_RE.test(trimmed)) {
        fail(`${label} must be 3-32 characters using letters, numbers, dots, hyphens or underscores, and start with a letter or number.`);
    }
    return trimmed;
}

function num(value, label, { required = true, min = null, max = null, integer = false } = {}) {
    if (value === undefined || value === null || value === '') {
        if (required) fail(`${label} is required.`);
        return null;
    }
    const n = Number(value);
    if (!Number.isFinite(n)) fail(`${label} must be a number.`);
    if (integer && !Number.isInteger(n)) fail(`${label} must be a whole number.`);
    if (min !== null && n < min) fail(`${label} must be at least ${min}.`);
    if (max !== null && n > max) fail(`${label} must be no more than ${max}.`);
    return n;
}

function bool(value, fallback = false) {
    if (value === true || value === false) return value;
    if (value === undefined || value === null || value === '') return fallback;
    return String(value).toLowerCase() === 'true' || value === 1 || value === '1';
}

function oneOf(value, allowed, label) {
    const v = typeof value === 'string' ? value.trim() : value;
    if (!allowed.includes(v)) fail(`${label} must be one of: ${allowed.join(', ')}.`);
    return v;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ISO date (YYYY-MM-DD), validated as a real calendar date. */
function isoDate(value, label, { required = true } = {}) {
    const trimmed = str(value, label, { required, max: 10 });
    if (!trimmed) return null;
    if (!DATE_RE.test(trimmed)) fail(`${label} must be in YYYY-MM-DD format.`);

    const parsed = new Date(`${trimmed}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) fail(`${label} is not a valid date.`);
    if (parsed.toISOString().slice(0, 10) !== trimmed) fail(`${label} is not a valid calendar date.`);
    return trimmed;
}

/** Validate a payroll period and reject implausible values. */
function period(monthValue, yearValue) {
    const month = num(monthValue, 'Month', { min: 1, max: 12, integer: true });
    const currentYear = new Date().getFullYear();
    const year = num(yearValue, 'Year', { min: 2000, max: currentYear + 1, integer: true });
    return { month, year };
}

/**
 * Password policy. The old rule was six characters with no other requirement,
 * while accounts shipped with shared defaults like `teacher123`.
 */
const WEAK_PASSWORDS = new Set([
    'password', 'password1', 'password123', '12345678', '123456789', 'qwerty123',
    'admin123', 'teacher123', 'accountant123', 'hr123', 'edupay123', 'letmein',
    'welcome1', 'changeme', 'abc12345', 'iloveyou'
]);

function password(value, label = 'Password') {
    const raw = typeof value === 'string' ? value : '';
    if (!raw) fail(`${label} is required.`);

    const minLength = Number(process.env.PASSWORD_MIN_LENGTH || 10);
    if (raw.length < minLength) fail(`${label} must be at least ${minLength} characters.`);
    if (raw.length > 128) fail(`${label} must be 128 characters or fewer.`);
    if (WEAK_PASSWORDS.has(raw.toLowerCase())) fail(`${label} is too common. Please choose something less guessable.`);

    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(raw)).length;
    if (classes < 3) {
        fail(`${label} must combine at least three of: lowercase letters, uppercase letters, numbers, symbols.`);
    }

    return raw;
}

/** A 6-digit one-time code. */
function otp(value, label = 'Verification code') {
    const trimmed = String(value || '').trim();
    if (!/^\d{6}$/.test(trimmed)) fail(`${label} must be 6 digits.`);
    return trimmed;
}

/**
 * A natural-key identifier used directly in a URL path, such as a salary scale
 * name. Numeric primary keys go through `num` instead.
 */
function docId(value, label = 'Identifier') {
    const trimmed = String(value || '').trim();
    if (!trimmed || trimmed.length > 128 || trimmed.includes('/')) fail(`${label} is not valid.`);
    return trimmed;
}

module.exports = {
    str, email, username, num, bool, oneOf, isoDate, period, password, otp, docId, fail,
    USERNAME_RE, EMAIL_RE
};
