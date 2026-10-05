const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const logger = require('./services/logger');

// ---------------------------------------------------------------------------
// Secret handling. A hardcoded fallback meant a production deployment that
// forgot to set JWT_SECRET would silently sign tokens with a public value, so
// startup now refuses to continue instead.
// ---------------------------------------------------------------------------
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DEV_FALLBACK_SECRET = 'edupay-development-only-secret-do-not-use-in-production';

function resolveJwtSecret() {
    const secret = process.env.JWT_SECRET;

    if (!secret || !secret.trim()) {
        if (IS_PRODUCTION) {
            throw new Error('JWT_SECRET must be set in production. Refusing to start with a default signing key.');
        }
        logger.warn('JWT_SECRET is not set; using an insecure development fallback.');
        return DEV_FALLBACK_SECRET;
    }

    if (IS_PRODUCTION && secret.trim().length < 32) {
        throw new Error('JWT_SECRET must be at least 32 characters in production.');
    }

    return secret.trim();
}

const JWT_SECRET = resolveJwtSecret();
const TOKEN_TTL = process.env.JWT_TTL || '2h';

// ---------------------------------------------------------------------------
// Token issue / verify
// ---------------------------------------------------------------------------

/**
 * Sign an access token. `tokenVersion` is embedded so that a password change,
 * deactivation, or explicit sign-out can invalidate tokens already in the wild —
 * previously a stolen token stayed valid for its full lifetime.
 */
function issueAccessToken(user) {
    return jwt.sign(
        {
            id: user.id,
            username: user.username,
            role: user.role,
            fullName: user.fullName,
            tokenVersion: Number(user.tokenVersion || 0)
        },
        JWT_SECRET,
        { expiresIn: TOKEN_TTL, issuer: 'edupay' }
    );
}

// Small cache so token validation does not query the database on every request.
const userCache = new Map();
const USER_CACHE_TTL_MS = 30 * 1000;

function cacheUser(user) {
    userCache.set(Number(user.id), { user, at: Date.now() });
}

function invalidateUserCache(userId) {
    userCache.delete(Number(userId));
}

async function loadUser(userId) {
    const hit = userCache.get(Number(userId));
    if (hit && Date.now() - hit.at < USER_CACHE_TTL_MS) return hit.user;

    // Required lazily: db.js depends on this module for HttpError, so importing
    // it at the top would create a cycle.
    const db = require('./db');

    const user = await db.queryOne(
        `SELECT id, username, role, full_name, email, is_active,
                must_change_password, token_version
           FROM users WHERE id = $1`,
        [userId]
    );
    if (!user) return null;

    cacheUser(user);
    return user;
}

/**
 * Verify the bearer token, then confirm the account is still active and the
 * token has not been superseded.
 */
async function authenticateToken(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

    if (!token) {
        return res.status(401).json({ error: 'Authentication required.', code: 'NO_TOKEN' });
    }

    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET, { issuer: 'edupay' });
    } catch (err) {
        const expired = err.name === 'TokenExpiredError';
        return res.status(401).json({
            error: expired ? 'Your session has expired. Please sign in again.' : 'Invalid session. Please sign in again.',
            code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID'
        });
    }

    try {
        const user = await loadUser(decoded.id);

        if (!user) {
            return res.status(401).json({ error: 'Account no longer exists.', code: 'USER_GONE' });
        }
        if (!user.isActive) {
            return res.status(403).json({ error: 'This account has been deactivated.', code: 'USER_INACTIVE' });
        }
        if (Number(user.tokenVersion || 0) !== Number(decoded.tokenVersion || 0)) {
            return res.status(401).json({
                error: 'Your session is no longer valid. Please sign in again.',
                code: 'TOKEN_REVOKED'
            });
        }

        req.user = {
            id: Number(user.id),
            username: user.username,
            role: user.role,
            fullName: user.fullName,
            email: user.email,
            mustChangePassword: Boolean(user.mustChangePassword)
        };
        return next();
    } catch (err) {
        logger.error('Token verification failed', { error: err.message });
        return res.status(503).json({ error: 'Unable to verify your session right now.', code: 'AUTH_UNAVAILABLE' });
    }
}

/** Restrict a route to the given roles. */
function authorizeRoles(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({
                error: 'You do not have permission to perform this action.',
                code: 'FORBIDDEN'
            });
        }
        next();
    };
}

/**
 * Block normal work until a forced password change is done. Applied to the
 * dashboards' data routes so the `mustChangePassword` flag actually has effect —
 * previously it was set everywhere and never enforced.
 */
function requirePasswordChanged(req, res, next) {
    if (req.user?.mustChangePassword) {
        return res.status(403).json({
            error: 'You must change your password before continuing.',
            code: 'PASSWORD_CHANGE_REQUIRED'
        });
    }
    next();
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
const rateLimitMessage = (message) => (req, res) => res.status(429).json({ error: message, code: 'RATE_LIMITED' });

/** Brute-force protection on credential endpoints. */
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.RATE_LIMIT_AUTH || 20),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: rateLimitMessage('Too many sign-in attempts. Please wait 15 minutes and try again.')
});

/** Tighter limit on the endpoints that send email, to prevent mail flooding. */
const emailLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: Number(process.env.RATE_LIMIT_EMAIL || 5),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: rateLimitMessage('Too many requests. Please wait before requesting another email.')
});

/** Broad ceiling on the rest of the API. */
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.RATE_LIMIT_API || 300),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: rateLimitMessage('Too many requests. Please slow down.')
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

/** Wrap an async handler so a rejected promise reaches the error middleware. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** An error carrying an HTTP status, for deliberate failures. */
class HttpError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function notFoundHandler(req, res) {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}`, code: 'NOT_FOUND' });
    }
    res.status(404).send('Not found');
}

/**
 * Central error handler. Logs the real cause server-side and returns a generic
 * message to the client, so failures stop disappearing into empty 500s.
 */
function errorHandler(err, req, res, _next) {
    const status = err.status || err.statusCode || 500;

    if (status >= 500) {
        logger.error('Unhandled request error', {
            method: req.method,
            path: req.path,
            user: req.user?.username,
            error: err.message,
            stack: err.stack
        });
    } else {
        logger.warn('Request rejected', { method: req.method, path: req.path, status, error: err.message });
    }

    if (res.headersSent) return;

    res.status(status).json({
        error: status >= 500 ? 'Something went wrong on our side. Please try again.' : err.message,
        code: err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED'),
        ...(IS_PRODUCTION ? {} : { detail: status >= 500 ? err.message : undefined })
    });
}

module.exports = {
    JWT_SECRET,
    TOKEN_TTL,
    IS_PRODUCTION,
    issueAccessToken,
    authenticateToken,
    authorizeRoles,
    requirePasswordChanged,
    invalidateUserCache,
    cacheUser,
    authLimiter,
    emailLimiter,
    apiLimiter,
    asyncHandler,
    HttpError,
    notFoundHandler,
    errorHandler
};
