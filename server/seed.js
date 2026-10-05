#!/usr/bin/env node
/**
 * Idempotent bootstrap for a fresh Firestore database.
 *
 * Replaces the old SQL migration chain, which re-ran ~25 ALTER statements on
 * every boot with their errors swallowed — and, among them, one UPDATE that
 * silently disabled two-factor authentication for every user each restart.
 *
 * Seeds, only where absent:
 *   - default salary scales
 *   - default system configuration
 *   - one administrator account, with a generated password printed once
 *
 * Usage: npm run db:seed
 */
require('dotenv').config();

const {
    users, salaryStructures, systemConfig, serverTimestamp,
    createUserWithUsername, verifyConnection, PROJECT_ID
} = require('./firebase');
const pw = require('./services/passwords');
const { DEFAULTS } = require('./services/config');

const DEFAULT_SCALES = [
    { scale: 'Scale_1', basic: 800000, housing: 100000, transport: 50000, medical: 30000 },
    { scale: 'Scale_2', basic: 1200000, housing: 150000, transport: 80000, medical: 50000 },
    { scale: 'Scale_3', basic: 1800000, housing: 200000, transport: 100000, medical: 80000 },
    { scale: 'Scale_4', basic: 2500000, housing: 300000, transport: 150000, medical: 100000 },
    { scale: 'Scale_5', basic: 3500000, housing: 400000, transport: 200000, medical: 150000 }
];

async function seedSalaryScales() {
    let created = 0;

    for (const entry of DEFAULT_SCALES) {
        const ref = salaryStructures().doc(entry.scale);
        if ((await ref.get()).exists) continue;

        await ref.set({
            salaryScale: entry.scale,
            basicSalary: entry.basic,
            housingAllowance: entry.housing,
            transportAllowance: entry.transport,
            medicalAllowance: entry.medical,
            otherAllowance: 0,
            // PAYE is banded by default, so this per-scale percentage is only
            // consulted when the system is switched to `flat` tax mode.
            taxPercentage: 0,
            nssfPercentage: 5,
            loanDeduction: 0,
            otherDeduction: 0,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });
        created++;
    }

    console.log(created ? `  Created ${created} salary scale(s).` : '  Salary scales already present.');
}

async function seedConfig() {
    let created = 0;

    for (const [key, value] of Object.entries(DEFAULTS)) {
        const ref = systemConfig().doc(key);
        if ((await ref.get()).exists) continue;
        await ref.set({ value, updatedAt: serverTimestamp() });
        created++;
    }

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

    const existing = await users().where('username', '==', username).limit(1).get();
    if (!existing.empty) {
        console.log(`  Administrator "${username}" already exists — left untouched.`);
        return null;
    }

    const anyAdmin = await users().where('role', '==', 'admin').limit(1).get();
    if (!anyAdmin.empty) {
        console.log('  An administrator already exists — skipping.');
        return null;
    }

    const password = process.env.SEED_ADMIN_PASSWORD || pw.generateTemporaryPassword(16);
    const emailAddress = process.env.SEED_ADMIN_EMAIL || '';

    await createUserWithUsername({
        username,
        password: await pw.hash(password),
        role: 'admin',
        fullName: process.env.SEED_ADMIN_FULL_NAME || 'System Administrator',
        email: emailAddress,
        phone: '',
        isActive: true,
        // Forced change on first sign-in, and this flag is now actually enforced.
        mustChangePassword: true,
        passwordSetupCompleted: true,
        // Two-factor stays off until SMTP is configured, otherwise the only
        // administrator could never receive a code.
        mfaEnabled: false,
        mfaMethod: 'email',
        tokenVersion: 0
    });

    return { username, password, generated: !process.env.SEED_ADMIN_PASSWORD };
}

async function run() {
    console.log(`\nSeeding EduPay in Firebase project "${PROJECT_ID}"\n`);

    await verifyConnection();

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
    .then(() => process.exit(0))
    .catch(err => {
        console.error('\nSeeding failed:', err.message);
        if (err.code === 5 || /NOT_FOUND/i.test(err.message)) {
            console.error(
                '\n  The Firestore database may not exist yet. In the Firebase console, open\n'
                + `  Firestore Database for project "${PROJECT_ID}" and create it (production mode).\n`
            );
        }
        process.exit(1);
    });
