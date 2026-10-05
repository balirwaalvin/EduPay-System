/**
 * Password hashing and temporary-credential generation.
 *
 * Accounts used to be created with shared, published defaults (`teacher123` and
 * friends). They now get a unique random temporary password that is shown to the
 * administrator exactly once, or — preferably — a one-time setup link by email.
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);

// Excludes characters that are easy to misread when a password is read aloud.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const SYMBOLS = '!@#$%*?';

function hash(plain) {
    return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

function verify(plain, hashed) {
    if (!hashed) return Promise.resolve(false);
    return bcrypt.compare(plain, hashed);
}

/** Cryptographically random temporary password that satisfies the password policy. */
function generateTemporaryPassword(length = 14) {
    const bytes = crypto.randomBytes(length * 2);
    let out = '';
    for (let i = 0; i < length - 2; i++) out += ALPHABET[bytes[i] % ALPHABET.length];

    // Guarantee a digit and a symbol so the generated value always passes validation.
    out += '23456789'[bytes[length] % 8];
    out += SYMBOLS[bytes[length + 1] % SYMBOLS.length];

    // Ensure at least one uppercase and one lowercase character are present.
    if (!/[A-Z]/.test(out)) out = `A${out.slice(1)}`;
    if (!/[a-z]/.test(out)) out = `${out.slice(0, -1)}z`;
    return out;
}

/** A URL-safe single-use token, plus its hash for storage. */
function generateToken(bytes = 32) {
    const token = crypto.randomBytes(bytes).toString('hex');
    return { token, tokenHash: hashToken(token) };
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** A 6-digit numeric OTP drawn from a cryptographic source. */
function generateOtp() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/** Constant-time comparison, to keep token checks free of timing signal. */
function safeEqual(a, b) {
    const bufA = Buffer.from(String(a || ''));
    const bufB = Buffer.from(String(b || ''));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
    hash, verify, generateTemporaryPassword, generateToken, hashToken,
    generateOtp, safeEqual, BCRYPT_ROUNDS
};
