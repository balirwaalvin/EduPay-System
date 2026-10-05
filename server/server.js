require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');

const { verifyConnection, PROJECT_ID } = require('./firebase');
const { apiLimiter, notFoundHandler, errorHandler, IS_PRODUCTION } = require('./middleware');
const logger = require('./services/logger');
const emailService = require('./services/email');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const hrRoutes = require('./routes/hr');
const accountantRoutes = require('./routes/accountant');
const teacherRoutes = require('./routes/teacher');
const notificationRoutes = require('./routes/notifications');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.disable('x-powered-by');

// ---------------------------------------------------------------------------
// Security headers.
//
// A content security policy matters here because the dashboards render
// user-supplied text; it is the backstop behind output escaping. All page
// scripts live in external files so that `script-src` needs no inline allowance.
// ---------------------------------------------------------------------------
const FIREBASE_ORIGINS = [
    'https://www.googleapis.com',
    'https://firebase.googleapis.com',
    'https://firebaseinstallations.googleapis.com',
    'https://www.google-analytics.com',
    'https://region1.google-analytics.com'
];

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            baseUri: ["'self'"],
            scriptSrc: ["'self'", 'https://www.gstatic.com'],
            styleSrc: ["'self'"],
            imgSrc: ["'self'", 'data:'],
            fontSrc: ["'self'"],
            connectSrc: ["'self'", ...FIREBASE_ORIGINS],
            formAction: ["'self'"],
            frameAncestors: ["'none'"],
            objectSrc: ["'none'"],
            ...(IS_PRODUCTION ? { upgradeInsecureRequests: [] } : {})
        }
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: IS_PRODUCTION ? { maxAge: 31536000, includeSubDomains: true, preload: false } : false
}));

// Restrict cross-origin API access to configured origins rather than allowing all.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
    origin(origin, callback) {
        // Same-origin and non-browser callers send no Origin header.
        if (!origin) return callback(null, true);
        if (!allowedOrigins.length) return callback(null, !IS_PRODUCTION);
        return callback(null, allowedOrigins.includes(origin));
    },
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 600
}));

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

// Request logging, excluding health checks so they do not flood the log.
app.use((req, res, next) => {
    if (req.path === '/healthz' || req.path === '/readyz') return next();

    const start = Date.now();
    res.on('finish', () => {
        const meta = {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            ms: Date.now() - start
        };
        if (res.statusCode >= 500) logger.error('Request failed', meta);
        else if (res.statusCode >= 400) logger.warn('Request rejected', meta);
        else logger.debug('Request', meta);
    });
    next();
});

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------
app.use(express.static(PUBLIC_DIR, {
    etag: true,
    lastModified: true,
    maxAge: IS_PRODUCTION ? '1h' : 0,
    setHeaders(res, filePath) {
        // HTML is always revalidated so a deploy is picked up immediately.
        if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache, must-revalidate');
    }
}));

// ---------------------------------------------------------------------------
// Health and readiness
// ---------------------------------------------------------------------------

/** Liveness: the process is up. */
app.get('/healthz', (req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});

/**
 * Readiness: dependencies are reachable.
 * The platform health check points here, so a database outage is actually
 * detected — previously the check hit `/`, which only proved static files served.
 */
app.get('/readyz', async (req, res) => {
    try {
        await verifyConnection();
        res.json({
            status: 'ready',
            firestore: 'connected',
            projectId: PROJECT_ID,
            email: emailService.isConfigured() ? 'configured' : 'not configured'
        });
    } catch (err) {
        logger.error('Readiness check failed', { error: err.message });
        res.status(503).json({ status: 'unavailable', firestore: 'unreachable', error: err.message });
    }
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
app.use('/api', apiLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/hr', hrRoutes);
app.use('/api/accountant', accountantRoutes);
app.use('/api/teacher', teacherRoutes);
app.use('/api/notifications', notificationRoutes);

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
const page = (file) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, file));

app.get('/admin', page('admin.html'));
app.get('/hr', page('hr.html'));
app.get('/accountant', page('accountant.html'));
app.get('/teacher-portal', page('teacher.html'));
app.get('/setup-password', page('setup-password.html'));
app.get('/reset-password', page('reset-password.html'));
app.get('/forgot-password', page('forgot-password.html'));

app.use(notFoundHandler);
app.use(errorHandler);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function start() {
    try {
        await verifyConnection();
        logger.info('Connected to Firestore', { projectId: PROJECT_ID });
    } catch (err) {
        logger.error('Could not reach Firestore', { error: err.message });
        console.error(
            '\n  Firestore is not reachable. Check that:\n'
            + '    1. A service account is configured (FIREBASE_SERVICE_ACCOUNT, '
            + 'FIREBASE_SERVICE_ACCOUNT_BASE64 or GOOGLE_APPLICATION_CREDENTIALS)\n'
            + `    2. The Firestore database exists in project "${PROJECT_ID}"\n`
            + '    3. The service account has the "Cloud Datastore User" role\n'
        );
        process.exit(1);
    }

    if (!emailService.isConfigured()) {
        logger.warn(
            'SMTP is not configured. Password setup links, password resets and two-factor codes cannot be delivered, '
            + 'so new accounts will be issued temporary passwords instead.'
        );
    }

    const server = app.listen(PORT, () => {
        logger.info('EduPay started', {
            port: PORT,
            env: process.env.NODE_ENV || 'development',
            projectId: PROJECT_ID
        });
        if (!IS_PRODUCTION) {
            console.log(`\n  EduPay — School Payroll System`);
            console.log(`  http://localhost:${PORT}`);
            console.log(`  Firebase project: ${PROJECT_ID}\n`);
        }
    });

    const shutdown = (signal) => {
        logger.info('Shutting down', { signal });
        server.close(() => process.exit(0));
        // Do not hang indefinitely if connections refuse to drain.
        setTimeout(() => process.exit(1), 10000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => {
        logger.error('Unhandled promise rejection', { reason: String(reason) });
    });
}

if (require.main === module) start();

module.exports = { app };
