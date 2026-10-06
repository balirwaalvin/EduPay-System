require('dotenv').config({ quiet: true });
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');

const db = require('./db');
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

// Port and bind address both come from the environment. 3100 rather than the
// conventional 3000, which is commonly already taken by another project.
const PORT = Number(process.env.PORT || 3100);

// Bind address. The default accepts connections on every interface, which is
// what a container needs. Set HOST=127.0.0.1 to accept local connections only.
const HOST = process.env.HOST || '0.0.0.0';

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
// ---------------------------------------------------------------------------
// Content security policy.
//
// Two policies, not one. Firebase Analytics needs to load a third-party script
// from googletagmanager.com, and allowing that origin inside the dashboards —
// which display salaries and bank details and hold the access token — would mean
// a compromise of that origin could inject script into them.
//
// So the sign-in page, which holds no data, gets the wider policy that lets
// Analytics work; every authenticated page gets the strict one. Analytics only
// ever runs on the sign-in page, so nothing is lost.
// ---------------------------------------------------------------------------
const STRICT_CSP = {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    imgSrc: ["'self'", 'data:'],
    fontSrc: ["'self'"],
    connectSrc: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    objectSrc: ["'none'"]
};

// Origins Firebase Analytics needs: the SDK from gstatic, gtag from
// googletagmanager, remote config from firebase.googleapis.com, installation
// ids from firebaseinstallations, and measurement beacons to google-analytics.
const ANALYTICS_CSP = {
    ...STRICT_CSP,
    scriptSrc: ["'self'", 'https://www.gstatic.com', 'https://www.googletagmanager.com'],
    connectSrc: [
        "'self'",
        'https://firebase.googleapis.com',
        'https://firebaseinstallations.googleapis.com',
        'https://www.googleapis.com',
        'https://www.google-analytics.com',
        'https://region1.google-analytics.com',
        // GA4 falls back to this origin for its collect beacon.
        'https://www.google.com'
    ],
    imgSrc: ["'self'", 'data:', 'https://www.google-analytics.com']
};

const withUpgrade = (directives) => ({
    ...directives,
    ...(IS_PRODUCTION ? { upgradeInsecureRequests: [] } : {})
});

const commonHelmet = {
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: IS_PRODUCTION ? { maxAge: 31536000, includeSubDomains: true, preload: false } : false
};

const strictHelmet = helmet({ ...commonHelmet, contentSecurityPolicy: { directives: withUpgrade(STRICT_CSP) } });
const analyticsHelmet = helmet({ ...commonHelmet, contentSecurityPolicy: { directives: withUpgrade(ANALYTICS_CSP) } });

// Only the sign-in page and the scripts it needs get the wider policy.
const ANALYTICS_PATHS = new Set(['/', '/index.html', '/js/firebase-client.js', '/js/analytics-init.js']);

app.use((req, res, next) => {
    (ANALYTICS_PATHS.has(req.path) ? analyticsHelmet : strictHelmet)(req, res, next);
});

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
        const info = await db.verifyConnection();
        res.json({
            status: 'ready',
            database: 'connected',
            databaseName: info.database,
            databaseVersion: info.version,
            email: emailService.isConfigured() ? 'configured' : 'not configured'
        });
    } catch (err) {
        logger.error('Readiness check failed', { error: err.message });
        res.status(503).json({ status: 'unavailable', database: 'unreachable', error: err.message });
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
    let dbInfo;
    try {
        dbInfo = await db.verifyConnection();
        logger.info('Connected to PostgreSQL', dbInfo);
    } catch (err) {
        logger.error('Could not reach the database', { error: err.message, code: err.code });
        console.error(
            '\n  PostgreSQL is not reachable. Check that:\n'
            + '    1. A connection is configured — INSTANCE_UNIX_SOCKET (Cloud Run),\n'
            + '       DATABASE_URL, or DB_HOST/DB_USER/DB_PASSWORD/DB_NAME\n'
            + '    2. For Cloud SQL from outside Google Cloud, the Auth Proxy is running\n'
            + '    3. The database exists and the user can connect to it\n'
            + '    4. Migrations have been applied: npm run db:migrate\n'
        );
        process.exit(1);
    }

    // A missing schema is a configuration mistake, not a runtime fault, so say so
    // at startup rather than failing on the first request.
    try {
        const ready = await db.scalar(
            `SELECT count(*) AS count FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'users'`
        );
        if (Number(ready) === 0) {
            logger.error('The database has no schema');
            console.error('\n  The schema has not been created. Run:\n    npm run db:migrate\n');
            process.exit(1);
        }
    } catch (err) {
        logger.warn('Could not verify the schema', { error: err.message });
    }

    if (!emailService.isConfigured()) {
        logger.warn(
            'SMTP is not configured. Password setup links, password resets and two-factor codes cannot be delivered, '
            + 'so new accounts will be issued temporary passwords instead.'
        );
    }

    const server = app.listen(PORT, HOST, () => {
        logger.info('EduPay started', {
            host: HOST,
            port: PORT,
            env: process.env.NODE_ENV || 'development',
            database: dbInfo.database
        });
        if (!IS_PRODUCTION) {
            console.log(`\n  EduPay — School Payroll System`);
            console.log(`  http://localhost:${PORT}`);
            console.log(`  Database: ${dbInfo.database} (${dbInfo.version})\n`);
        }
    });

    // A port clash is a common local annoyance; say so plainly rather than
    // printing a stack trace.
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            logger.error('Port already in use', { host: HOST, port: PORT });
            console.error(
                `\n  Port ${PORT} is already in use by another process.\n\n`
                + '  Either stop whatever is using it, or choose a different port:\n'
                + `    PORT=4100 npm start\n`
                + '  or set PORT in your .env file.\n'
            );
            process.exit(1);
        }
        if (err.code === 'EACCES') {
            logger.error('Permission denied binding the port', { host: HOST, port: PORT });
            console.error(`\n  Permission denied binding port ${PORT}. Ports below 1024 need elevated rights.\n`);
            process.exit(1);
        }
        throw err;
    });

    const shutdown = (signal) => {
        logger.info('Shutting down', { signal });
        server.close(async () => {
            // Close the connection pool so Cloud SQL does not hold the slots.
            await db.close().catch(() => { });
            process.exit(0);
        });
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
