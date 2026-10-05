#!/usr/bin/env node
/**
 * Idempotent bootstrap for a fresh database.
 *
 * Seeds, only where absent:
 *   - default salary scales
 *   - default system configuration
 *   - one administrator account, with a generated password printed once
 *
 * Schema changes belong in server/migrations/, not here. Run migrations first:
 *   npm run db:migrate && npm run db:seed
 */
require('dotenv').config({ quiet: true });

const db = require('./db');
const pw = require('./services/passwords');
const configService = require('./services/config');

const DEFAULT_SCALES = [
    { scale: 'Scale_1', basic: 800000, housing: 100000, transport: 50000, medical: 30000 },
    { scale: 'Scale_2', basic: 1200000, housing: 150000, transport: 80000, medical: 50000 },
    { scale: 'Scale_3', basic: 1800000, housing: 200000, transport: 100000, medical: 80000 },
    { scale: 'Scale_4', basic: 2500000, housing: 300000, transport: 150000, medical: 100000 },
    { scale: 'Scale_5', basic: 3500000, housing: 400000, transport: 200000, medical: 150000 }
];

async function requireSchema() {
    const present = await db.scalar(
        `SELECT count(*) AS count FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'users'`
    );

    if (Number(present) === 0) {
        throw Object.assign(new Error('The schema has not been created yet.'), { code: 'NO_SCHEMA' });
    }
}

async function seedSalaryScales() {
    let created = 0;

    for (const entry of DEFAULT_SCALES) {
        // ON CONFLICT DO NOTHING makes this safe to re-run.
        created += await db.execute(
            `INSERT INTO salary_structures
                 (salary_scale, basic_salary, housing_allowance, transport_allowance,
                  medical_allowance, other_allowance, tax_percentage, nssf_percentage)
             VALUES ($1, $2, $3, $4, $5, 0, 0, 5)
             ON CONFLICT (salary_scale) DO NOTHING`,
            [entry.scale, entry.basic, entry.housing, entry.transport, entry.medical]
        );
    }

    console.log(created ? `  Created ${created} salary scale(s).` : '  Salary scales already present.');
}

async function seedConfig() {
    const created = await configService.ensureDefaults();
    console.log(created ? `  Created ${created} configuration value(s).` : '  Configuration already present.');
}

/**
 * Create the first administrator.
 *
 * No shared default password: a random one is generated and printed once, and
 * must be changed at first sign-in. Set SEED_ADMIN_PASSWORD to choose your own.
 */
async function seedAdministrator() {
    const username = (process.env.SEED_ADMIN_USERNAME || 'admin').toLowerCase();

    const existingAdmin = await db.queryOne(
        "SELECT username FROM users WHERE role = 'admin' LIMIT 1"
    );
    if (existingAdmin) {
        console.log(`  An administrator already exists ("${existingAdmin.username}") — left untouched.`);
        return null;
    }

    const password = process.env.SEED_ADMIN_PASSWORD || pw.generateTemporaryPassword(16);

    await db.execute(
        `INSERT INTO users (
             username, password_hash, role, full_name, email,
             is_active, must_change_password, password_setup_completed,
             mfa_enabled, mfa_method, token_version
         ) VALUES ($1, $2, 'admin', $3, $4, TRUE, TRUE, TRUE, FALSE, 'email', 0)`,
        [
            username,
            await pw.hash(password),
            process.env.SEED_ADMIN_FULL_NAME || 'System Administrator',
            (process.env.SEED_ADMIN_EMAIL || '').toLowerCase() || null
        ]
    );

    return { username, password, generated: !process.env.SEED_ADMIN_PASSWORD };
}

async function run() {
    const info = await db.verifyConnection();
    console.log(`\nSeeding ${info.database} (${info.version})\n`);

    await requireSchema();
    await seedSalaryScales();
    await seedConfig();
    const admin = await seedAdministrator();

    if (admin) {
        console.log('\n  ──────────────────────────────────────────────────────────');
        console.log('   Administrator account created');
        console.log(`   Username: ${admin.username}`);
        console.log(`   Password: ${admin.password}`);
        if (admin.generated) {
            console.log('\n   This password was generated and is shown only once.');
            console.log('   Store it now. You must change it at first sign-in.');
        }
        console.log('  ──────────────────────────────────────────────────────────');
    }

    console.log('\nSeeding complete.\n');
}

run()
    .then(async () => { await db.close(); process.exit(0); })
    .catch(async (err) => {
        console.error(`\nSeeding failed: ${err.message}\n`);

        if (err.code === 'NO_SCHEMA' || err.code === '42P01') {
            console.error('  Run the migrations first:\n    npm run db:migrate\n');
        } else if (err.code === '3D000') {
            console.error('  That database does not exist. Create it in the Cloud SQL console first.\n');
        } else if (err.code === 'ECONNREFUSED') {
            console.error('  Nothing is listening at that address. If this is Cloud SQL, check that the\n'
                + '  Auth Proxy is running, or that INSTANCE_UNIX_SOCKET is set.\n');
        }

        await db.close().catch(() => { });
        process.exit(1);
    });
