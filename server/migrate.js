#!/usr/bin/env node
/**
 * Migration runner.
 *
 * Replaces the previous pattern of running ~25 ALTER TABLE statements on every
 * boot with their errors swallowed — which is how a one-time MFA migration came
 * to execute on every restart and silently disable two-factor authentication for
 * every user.
 *
 * Each file in server/migrations/ runs exactly once, in filename order, inside a
 * transaction, and is recorded in schema_migrations. A failure rolls that file
 * back and stops.
 *
 *   npm run db:migrate          apply everything pending
 *   npm run db:migrate status   show what is applied and what is pending
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureRegistry() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version     TEXT        PRIMARY KEY,
            checksum    TEXT        NOT NULL,
            applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            duration_ms INTEGER
        )
    `);
}

function discover() {
    if (!fs.existsSync(MIGRATIONS_DIR)) return [];

    return fs.readdirSync(MIGRATIONS_DIR)
        .filter(name => name.endsWith('.sql'))
        .sort()
        .map(name => {
            const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
            return {
                version: name.replace(/\.sql$/, ''),
                name,
                sql,
                checksum: crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16)
            };
        });
}

async function applied() {
    const rows = await db.query('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version');
    return new Map(rows.map(row => [row.version, row]));
}

async function migrate() {
    await ensureRegistry();

    const all = discover();
    const done = await applied();

    // An already-applied file that has since changed means the database and the
    // repository disagree. Stop rather than guess.
    for (const migration of all) {
        const record = done.get(migration.version);
        if (record && record.checksum !== migration.checksum) {
            throw new Error(
                `Migration ${migration.name} has changed since it was applied.\n`
                + `  applied checksum: ${record.checksum}\n`
                + `  current checksum: ${migration.checksum}\n`
                + 'Add a new migration instead of editing one that has already run.'
            );
        }
    }

    const pending = all.filter(m => !done.has(m.version));

    if (!pending.length) {
        console.log(`Database is up to date (${done.size} migration(s) applied).`);
        return;
    }

    console.log(`Applying ${pending.length} migration(s):\n`);

    for (const migration of pending) {
        const started = Date.now();
        process.stdout.write(`  ${migration.name} … `);

        // Each migration is atomic: a failure leaves no partial schema behind.
        await db.withTransaction(async (client) => {
            await client.query(migration.sql);
            await client.query(
                'INSERT INTO schema_migrations (version, checksum, duration_ms) VALUES ($1, $2, $3)',
                [migration.version, migration.checksum, Date.now() - started]
            );
        });

        console.log(`ok (${Date.now() - started} ms)`);
    }

    console.log('\nMigrations complete.');
}

async function status() {
    await ensureRegistry();

    const all = discover();
    const done = await applied();

    console.log('\nMigration status\n');

    if (!all.length) {
        console.log('  No migration files found in server/migrations/.');
        return;
    }

    for (const migration of all) {
        const record = done.get(migration.version);
        if (!record) {
            console.log(`  pending  ${migration.name}`);
        } else if (record.checksum !== migration.checksum) {
            console.log(`  CHANGED  ${migration.name}  (applied ${record.appliedAt}) — file differs from what ran`);
        } else {
            console.log(`  applied  ${migration.name}  (${record.appliedAt})`);
        }
    }

    const pending = all.filter(m => !done.has(m.version)).length;
    console.log(`\n  ${done.size} applied, ${pending} pending\n`);
}

async function run() {
    const command = process.argv[2] || 'up';

    try {
        const info = await db.verifyConnection();
        console.log(`\nConnected to ${info.database} (${info.version})`);

        if (command === 'status') await status();
        else await migrate();

        await db.close();
        process.exit(0);
    } catch (err) {
        console.error(`\nMigration failed: ${err.message}\n`);
        if (err.code === '42501') {
            console.error('  The database user lacks permission to create objects.\n');
        }
        if (err.code === '3D000') {
            console.error('  That database does not exist. Create it first in the Cloud SQL console.\n');
        }
        if (/btree_gist/.test(err.message)) {
            console.error('  The btree_gist extension is required for the leave-overlap constraint.\n'
                + '  On Cloud SQL it is available by default; a superuser may need to run:\n'
                + '    CREATE EXTENSION btree_gist;\n');
        }
        await db.close().catch(() => { });
        process.exit(1);
    }
}

if (require.main === module) run();

module.exports = { migrate, status, discover };
