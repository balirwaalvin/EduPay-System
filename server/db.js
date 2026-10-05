require('dotenv').config({ quiet: true });
const { Pool, types } = require('pg');
const logger = require('./services/logger');

// ---------------------------------------------------------------------------
// Type parsing
//
// node-postgres returns several types as strings by default to avoid silent
// precision loss. We convert the ones the application treats as plain values,
// and deliberately keep DATE as a 'YYYY-MM-DD' string because every date in
// this system is handled as an ISO day, never as an instant.
// ---------------------------------------------------------------------------
const OID = { INT8: 20, NUMERIC: 1700, DATE: 1082, TIMESTAMPTZ: 1184, TIMESTAMP: 1114 };

// Money is NUMERIC(14,2). Converting to Number is safe at two decimal places
// well beyond any realistic payroll, and SUM() is still computed exactly by
// Postgres before it reaches us.
types.setTypeParser(OID.NUMERIC, (value) => (value === null ? null : Number(value)));

// Identifiers are BIGSERIAL. Converting to Number is safe until 2^53 rows.
types.setTypeParser(OID.INT8, (value) => (value === null ? null : Number(value)));

// Keep calendar dates as plain ISO days, with no timezone shifting.
types.setTypeParser(OID.DATE, (value) => value);

// Timestamps become ISO strings so JSON responses are stable.
const toIso = (value) => (value === null ? null : new Date(value).toISOString());
types.setTypeParser(OID.TIMESTAMPTZ, toIso);
types.setTypeParser(OID.TIMESTAMP, toIso);

// ---------------------------------------------------------------------------
// Connection
//
// Google Cloud SQL is reached one of three ways:
//   1. A Unix socket — how Cloud Run, App Engine and Cloud Functions connect.
//      Set INSTANCE_UNIX_SOCKET=/cloudsql/PROJECT:REGION:INSTANCE
//   2. The Cloud SQL Auth Proxy, which presents the instance on localhost.
//      Then the ordinary host/port settings apply.
//   3. A direct TCP connection with SSL, for hosts outside Google Cloud.
// A plain DATABASE_URL also works and takes precedence.
// ---------------------------------------------------------------------------
function buildPoolConfig() {
    const common = {
        max: Number(process.env.PG_POOL_MAX || 10),
        min: Number(process.env.PG_POOL_MIN || 0),
        idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
        connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000),
        // Fail a stuck query rather than holding a pool slot indefinitely.
        statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 30000),
        query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 30000),
        application_name: 'edupay'
    };

    const socket = process.env.INSTANCE_UNIX_SOCKET;
    if (socket) {
        // The socket path carries the instance identity, so no host/port/SSL.
        logger.info('Connecting to Cloud SQL over a Unix socket', { socket });
        return {
            ...common,
            host: socket,
            user: required('DB_USER'),
            password: required('DB_PASSWORD'),
            database: required('DB_NAME')
        };
    }

    const url = (process.env.DATABASE_URL || '').trim().replace(/^['"]|['"]$/g, '');
    if (url) {
        const sslRequested = /sslmode=require|sslmode=verify/i.test(url);
        logger.info('Connecting to PostgreSQL using DATABASE_URL', { ssl: sslRequested });
        return {
            ...common,
            connectionString: url.replace(/[?&]sslmode=[^&]*/gi, '').replace(/\?$/, ''),
            ssl: sslRequested ? sslConfig() : false
        };
    }

    const host = process.env.DB_HOST || process.env.PGHOST;
    if (host) {
        const useSsl = String(process.env.DB_SSL || 'false').toLowerCase() === 'true';
        logger.info('Connecting to PostgreSQL over TCP', { host, ssl: useSsl });
        return {
            ...common,
            host,
            port: Number(process.env.DB_PORT || process.env.PGPORT || 5432),
            user: required('DB_USER', 'PGUSER'),
            password: required('DB_PASSWORD', 'PGPASSWORD'),
            database: required('DB_NAME', 'PGDATABASE'),
            ssl: useSsl ? sslConfig() : false
        };
    }

    throw new Error(
        'No database configuration found. Set one of:\n'
        + '  INSTANCE_UNIX_SOCKET  (Cloud Run / App Engine: /cloudsql/PROJECT:REGION:INSTANCE)\n'
        + '  DATABASE_URL          (postgresql://user:pass@host:5432/db?sslmode=require)\n'
        + '  DB_HOST + DB_USER + DB_PASSWORD + DB_NAME\n'
    );
}

/**
 * SSL settings for a direct connection.
 *
 * Cloud SQL presents a certificate signed by a per-instance CA, so verifying it
 * requires the server CA that the instance page offers for download. Without
 * that file the connection is still encrypted but unauthenticated, which is why
 * a warning is emitted rather than silently accepting it.
 */
function sslConfig() {
    const ca = process.env.DB_SSL_CA;
    if (ca) {
        return {
            rejectUnauthorized: true,
            ca: ca.includes('BEGIN CERTIFICATE') ? ca : require('fs').readFileSync(ca, 'utf8'),
            ...(process.env.DB_SSL_CERT ? { cert: readMaybeFile(process.env.DB_SSL_CERT) } : {}),
            ...(process.env.DB_SSL_KEY ? { key: readMaybeFile(process.env.DB_SSL_KEY) } : {})
        };
    }

    logger.warn(
        'Connecting with SSL but no DB_SSL_CA, so the server certificate is not verified. '
        + 'Prefer the Cloud SQL Unix socket or the Auth Proxy, or set DB_SSL_CA to the instance server CA.'
    );
    return { rejectUnauthorized: false };
}

function readMaybeFile(value) {
    return value.includes('BEGIN ') ? value : require('fs').readFileSync(value, 'utf8');
}

function required(...names) {
    for (const name of names) {
        if (process.env[name]) return process.env[name];
    }
    throw new Error(`Missing required database setting: ${names.join(' or ')}`);
}

let pool;

function getPool() {
    if (pool) return pool;

    pool = new Pool(buildPoolConfig());

    // An idle client erroring is usually the server closing the connection; the
    // pool replaces it, so this must not be fatal.
    pool.on('error', (err) => {
        logger.error('Idle database client error', { error: err.message });
    });

    return pool;
}

// ---------------------------------------------------------------------------
// Naming
//
// The database uses snake_case, the API and front end use camelCase. Reads are
// converted automatically; writes name their columns explicitly, so the SQL
// stays readable and greppable.
// ---------------------------------------------------------------------------
const camelCache = new Map();

function toCamel(key) {
    let cached = camelCache.get(key);
    if (cached === undefined) {
        cached = key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
        camelCache.set(key, cached);
    }
    return cached;
}

/** Convert one row's keys to camelCase. */
function camelRow(row) {
    if (!row) return null;
    const out = {};
    for (const key of Object.keys(row)) out[toCamel(key)] = row[key];
    return out;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Run a query and return camelCased rows. */
async function query(text, params = [], client = null) {
    const runner = client || getPool();
    const started = Date.now();

    try {
        const result = await runner.query(text, params);
        const elapsed = Date.now() - started;

        if (elapsed > Number(process.env.PG_SLOW_QUERY_MS || 500)) {
            logger.warn('Slow query', { ms: elapsed, sql: text.replace(/\s+/g, ' ').trim().slice(0, 160) });
        }

        return result.rows.map(camelRow);
    } catch (err) {
        logger.error('Query failed', {
            error: err.message,
            code: err.code,
            constraint: err.constraint,
            sql: text.replace(/\s+/g, ' ').trim().slice(0, 200)
        });
        throw err;
    }
}

/** Run a query expected to return at most one row. */
async function queryOne(text, params = [], client = null) {
    const rows = await query(text, params, client);
    return rows[0] || null;
}

/** Run a statement and return how many rows it affected. */
async function execute(text, params = [], client = null) {
    const runner = client || getPool();
    const result = await runner.query(text, params);
    return result.rowCount;
}

/** Read a single scalar, e.g. a COUNT. */
async function scalar(text, params = [], client = null) {
    const row = await queryOne(text, params, client);
    if (!row) return null;
    return row[Object.keys(row)[0]];
}

/**
 * Run a function inside a transaction, committing on success and rolling back on
 * any error.
 *
 * This is what the Firestore build could not provide: its batches cap at 500
 * operations, so a large payroll run had to be split into chunks that were not
 * atomic with one another. Here a run of any size is all-or-nothing.
 */
// Isolation levels cannot be parameterised, so they are restricted to an
// allowlist rather than interpolated from whatever the caller passed.
const ISOLATION_LEVELS = {
    'read committed': 'READ COMMITTED',
    'repeatable read': 'REPEATABLE READ',
    serializable: 'SERIALIZABLE'
};

async function withTransaction(fn, { isolation = null } = {}) {
    let isolationSql = null;
    if (isolation) {
        isolationSql = ISOLATION_LEVELS[String(isolation).toLowerCase()];
        if (!isolationSql) throw new Error(`Unsupported transaction isolation level: ${isolation}`);
    }

    const client = await getPool().connect();

    try {
        await client.query('BEGIN');
        if (isolationSql) await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolationSql}`);

        const result = await fn(client);

        await client.query('COMMIT');
        return result;
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackErr) {
            logger.error('Rollback failed', { error: rollbackErr.message });
        }
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Build a parameterised multi-row INSERT.
 * Returns { text, values } for a statement inserting every row in one round trip.
 */
function buildBulkInsert(table, columns, rows, { returning = 'id' } = {}) {
    const values = [];
    const tuples = rows.map((row) => {
        const placeholders = columns.map((column) => {
            values.push(row[toCamel(column)] ?? null);
            return `$${values.length}`;
        });
        return `(${placeholders.join(', ')})`;
    });

    return {
        text: `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`
            + (returning ? ` RETURNING ${returning}` : ''),
        values
    };
}

/** Atomically increment a named counter and return the new value. */
async function nextSequence(name, client = null) {
    const row = await queryOne(
        `INSERT INTO counters (name, value) VALUES ($1, 1)
         ON CONFLICT (name) DO UPDATE SET value = counters.value + 1, updated_at = now()
         RETURNING value`,
        [name],
        client
    );
    return Number(row.value);
}

// ---------------------------------------------------------------------------
// Constraint violations → meaningful errors
//
// The schema enforces real invariants, so a violation is usually a case the user
// should see explained rather than a 500. This maps Postgres error codes and
// constraint names onto the application's own codes.
// ---------------------------------------------------------------------------
const PG_CODES = {
    UNIQUE_VIOLATION: '23505',
    FOREIGN_KEY_VIOLATION: '23503',
    CHECK_VIOLATION: '23514',
    EXCLUSION_VIOLATION: '23P01',
    NOT_NULL_VIOLATION: '23502'
};

const CONSTRAINT_MESSAGES = {
    users_username_key: [409, 'That username is already taken.', 'USERNAME_TAKEN'],
    payroll_period_unique: [409, 'A payroll run already exists for that period.', 'PAYROLL_PERIOD_EXISTS'],
    payroll_processor_is_not_approver: [403,
        'The person who processed a payroll run cannot also approve it.', 'SELF_APPROVAL'],
    teachers_employee_id_key: [409, 'That employee ID is already in use.', 'EMPLOYEE_ID_TAKEN'],
    teachers_salary_scale_fkey: [400,
        'That salary scale does not exist. Create it first under Salary Structures.', 'UNKNOWN_SCALE'],
    teachers_halt_reason_required: [400, 'A reason is required when pausing payroll.', 'REASON_REQUIRED'],
    salary_structures_pkey: [409, 'A structure for that salary scale already exists.', 'SCALE_EXISTS'],
    leave_no_overlap: [409, 'This overlaps leave that is already pending or approved.', 'LEAVE_OVERLAP'],
    leave_dates_ordered: [400, 'The end date cannot be before the start date.', 'LEAVE_RANGE_INVALID'],
    leave_length_sane: [400, 'A single leave request cannot exceed 120 days.', 'LEAVE_TOO_LONG'],
    advance_one_open_per_teacher: [409,
        'This teacher already has an advance outstanding. It must be settled first.', 'ADVANCE_ALREADY_OPEN'],
    advance_not_over_repaid: [400, 'That would repay more than the advance.', 'ADVANCE_OVER_REPAID'],
    payroll_items_net_salary_check: [400,
        'That would make net pay negative. Reduce the deductions.', 'NEGATIVE_NET_PAY'],
    payroll_items_net_consistent: [500,
        'The payroll arithmetic is inconsistent and was not saved.', 'PAYROLL_ARITHMETIC'],
    payroll_items_unique: [409, 'That teacher already appears on this payroll version.', 'DUPLICATE_PAYROLL_LINE'],
    payroll_items_teacher_id_fkey: [409,
        'That teacher appears on a payroll run, so the record cannot be deleted. Deactivate it instead.',
        'HAS_PAYROLL_HISTORY']
};

/**
 * Translate a database error into an HttpError where the cause is a constraint
 * the user can act on. Anything unrecognised is returned unchanged so the
 * central error handler reports it as a genuine fault.
 */
function translateError(err) {
    const { HttpError } = require('./middleware');

    const mapped = err.constraint && CONSTRAINT_MESSAGES[err.constraint];
    if (mapped) {
        const [status, message, code] = mapped;
        return new HttpError(status, message, code);
    }

    if (err.code === PG_CODES.UNIQUE_VIOLATION) {
        return new HttpError(409, 'That record already exists.', 'DUPLICATE');
    }
    if (err.code === PG_CODES.FOREIGN_KEY_VIOLATION) {
        return new HttpError(409,
            'That record is referenced elsewhere, so the change was refused.', 'REFERENCED');
    }
    if (err.code === PG_CODES.CHECK_VIOLATION || err.code === PG_CODES.EXCLUSION_VIOLATION) {
        return new HttpError(400, 'That value is not allowed.', 'CONSTRAINT_VIOLATION');
    }

    return err;
}

/** Wrap a handler so constraint violations surface as explained failures. */
function withTranslatedErrors(fn) {
    return async (...args) => {
        try {
            return await fn(...args);
        } catch (err) {
            throw translateError(err);
        }
    };
}

/** Verify the database is reachable, so startup fails loudly rather than later. */
async function verifyConnection() {
    const row = await queryOne('SELECT current_database() AS database, version() AS version');
    return {
        database: row.database,
        version: String(row.version).split(' ').slice(0, 2).join(' ')
    };
}

async function close() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

module.exports = {
    getPool,
    query,
    queryOne,
    execute,
    scalar,
    withTransaction,
    buildBulkInsert,
    nextSequence,
    camelRow,
    toCamel,
    translateError,
    withTranslatedErrors,
    verifyConnection,
    close,
    PG_CODES
};
