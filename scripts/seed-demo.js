#!/usr/bin/env node
/**
 * Seed a realistic school into a running development instance.
 *
 * Drives the HTTP API rather than writing to the database, so everything goes
 * through the real validation, fires the real notifications, and is subject to
 * the real constraints — which makes this a workflow smoke test as well as a
 * data generator.
 *
 * Accounts are activated the way a real one would be: if SMTP is configured, the
 * seeder reads the emailed setup link out of Mailpit and uses it. Otherwise it
 * uses the one-time temporary password the API returns.
 *
 *   node scripts/seed-demo.js
 *   ADMIN_PASSWORD=… node scripts/seed-demo.js
 *
 * Intended for development only. It refuses to run against anything that does
 * not look like a local instance.
 */
require('dotenv').config({ quiet: true });

const PORT = process.env.PORT || 3100;
const BASE = process.env.DEMO_BASE_URL || `http://localhost:${PORT}`;
const MAILPIT = process.env.DEMO_MAILPIT_URL || 'http://localhost:8025';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'DevAdmin-2026!x';

// A single password for every demo account, so they are easy to sign in as.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Demo-Edupay-2026!x';

const created = { staff: [], teachers: [], notes: [] };

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

const log = (msg) => process.stdout.write(`  ${msg}\n`);
const step = (msg) => process.stdout.write(`\n\x1b[2m${msg}\x1b[0m\n`);

class ApiError extends Error {
    constructor(status, body, request) {
        super(`${request} → ${status} ${body?.error || JSON.stringify(body)}`);
        this.status = status;
        this.code = body?.code;
    }
}

async function api(path, { method = 'GET', body, token } = {}) {
    const res = await fetch(`${BASE}/api${path}`, {
        method,
        headers: {
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });

    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;

    if (!res.ok) throw new ApiError(res.status, parsed, `${method} ${path}`);
    return parsed;
}

/** Find the most recent email to an address, and pull a token out of it. */
async function tokenFromEmail(address, { attempts = 12 } = {}) {
    for (let i = 0; i < attempts; i++) {
        const search = await fetch(
            `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}&limit=5`
        ).then(r => (r.ok ? r.json() : null)).catch(() => null);

        const message = search?.messages?.[0];
        if (message) {
            const full = await fetch(`${MAILPIT}/api/v1/message/${message.ID}`).then(r => r.json());
            const match = `${full.Text || ''}${full.HTML || ''}`.match(/token=([a-f0-9]{64})/);
            if (match) return match[1];
        }
        await new Promise(r => setTimeout(r, 500));
    }
    return null;
}

const mailConfigured = async () => {
    const ready = await fetch(`${BASE}/readyz`).then(r => r.json()).catch(() => ({}));
    return ready.email === 'configured';
};

/** Pull the most recent 6-digit verification code sent to an address. */
async function otpFromEmail(address, { attempts = 14 } = {}) {
    for (let i = 0; i < attempts; i++) {
        const search = await fetch(
            `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address} subject:Verification`)}&limit=1`
        ).then(r => (r.ok ? r.json() : null)).catch(() => null);

        const message = search?.messages?.[0];
        if (message) {
            const full = await fetch(`${MAILPIT}/api/v1/message/${message.ID}`).then(r => r.json());
            // Match the code in the plain-text part, which states it on its own.
            const match = `${full.Text || ''}`.match(/code is:\s*(\d{6})/)
                || `${full.HTML || ''}`.match(/>(\d{6})</);
            if (match) return match[1];
        }
        await new Promise(r => setTimeout(r, 500));
    }
    return null;
}

/**
 * Sign in, completing a two-factor challenge when one is issued.
 *
 * Accounts created while SMTP is configured have MFA switched on, because a code
 * can actually be delivered — so the seeder has to go through it, exactly as a
 * person would.
 */
async function login(username, password, email) {
    const first = await api('/auth/login', { method: 'POST', body: { username, password } });

    if (!first.mfaRequired) return first;

    if (!email) throw new Error(`${username} requires two-factor but no address was given to read the code from`);

    const otp = await otpFromEmail(email);
    if (!otp) throw new Error(`No verification code arrived for ${email}`);

    return api('/auth/verify-mfa', {
        method: 'POST',
        body: { username, mfaToken: first.mfaToken, otp }
    });
}

/**
 * Turn a freshly created account into one that can sign in, and return its
 * token. Uses the emailed setup link when available, the temporary password
 * otherwise, then normalises everything onto DEMO_PASSWORD.
 */
async function activate({ username, email, activation }) {
    if (activation.method === 'setup_link' && email) {
        const token = await tokenFromEmail(email);
        if (!token) throw new Error(`No setup email arrived for ${email}`);

        await api('/auth/setup-password/complete', {
            method: 'POST',
            body: { token, newPassword: DEMO_PASSWORD }
        });

        const session = await login(username, DEMO_PASSWORD, email);
        return session.token;
    }

    // Temporary-password path: sign in, then replace it.
    const first = await login(username, activation.temporaryPassword, email);

    const changed = await api('/auth/change-password', {
        method: 'POST',
        token: first.token,
        body: { currentPassword: activation.temporaryPassword, newPassword: DEMO_PASSWORD }
    });

    return changed.token;
}

const iso = (offsetDays) =>
    new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

/** The month before this one, which is the run an accountant would process. */
function lastMonth() {
    const now = new Date();
    const month = now.getMonth() === 0 ? 12 : now.getMonth();
    const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    return { month, year };
}

// ---------------------------------------------------------------------------
// Demo content
// ---------------------------------------------------------------------------

const SCALES = [
    { salaryScale: 'Teaching_Assistant', basicSalary: 650000, housingAllowance: 80000, transportAllowance: 40000, medicalAllowance: 25000 },
    { salaryScale: 'Head_of_Department', basicSalary: 2800000, housingAllowance: 350000, transportAllowance: 180000, medicalAllowance: 120000 },
    { salaryScale: 'Deputy_Head', basicSalary: 4200000, housingAllowance: 500000, transportAllowance: 250000, medicalAllowance: 180000 }
];

const TEACHERS = [
    { fullName: 'Grace Nakato',        position: 'Mathematics Teacher',  salaryScale: 'Scale_3', paymentMethod: 'bank',         bankName: 'Stanbic Bank',   bankAccountName: 'Grace Nakato',        bankAccountNumber: '9030012345671', signIn: true },
    { fullName: 'Samuel Okiror',       position: 'Head of Sciences',     salaryScale: 'Head_of_Department', paymentMethod: 'bank', bankName: 'Centenary Bank', bankAccountName: 'Samuel Okiror',      bankAccountNumber: '3100098765432', signIn: true },
    { fullName: 'Agnes Birungi',       position: 'English Teacher',      salaryScale: 'Scale_2', paymentMethod: 'mobile_money', mobileMoneyProvider: 'MTN',  mobileMoneyNumber: '0772345678' },
    { fullName: 'Joseph Wasswa',       position: 'Deputy Head Teacher',  salaryScale: 'Deputy_Head', paymentMethod: 'bank',     bankName: 'DFCU Bank',      bankAccountName: 'Joseph Wasswa',       bankAccountNumber: '0120034567891' },
    { fullName: 'Rebecca Atim',        position: 'Biology Teacher',      salaryScale: 'Scale_3', paymentMethod: 'mobile_money', mobileMoneyProvider: 'Airtel', mobileMoneyNumber: '0701234567' },
    { fullName: 'Daniel Kyeyune',      position: 'Geography Teacher',    salaryScale: 'Scale_2', paymentMethod: 'bank',         bankName: 'Equity Bank',    bankAccountName: 'Daniel Kyeyune',      bankAccountNumber: '1001256789012' },
    { fullName: 'Miriam Nabukenya',    position: 'Teaching Assistant',   salaryScale: 'Teaching_Assistant', paymentMethod: 'mobile_money', mobileMoneyProvider: 'MTN', mobileMoneyNumber: '0783456789' },
    { fullName: 'Patrick Ssentongo',   position: 'Physics Teacher',      salaryScale: 'Scale_4', paymentMethod: 'bank',         bankName: 'Stanbic Bank',   bankAccountName: 'Patrick Ssentongo',   bankAccountNumber: '9030087654321' },
    { fullName: 'Hadija Namaganda',    position: 'History Teacher',      salaryScale: 'Scale_2', paymentMethod: 'mobile_money', mobileMoneyProvider: 'Airtel', mobileMoneyNumber: '0756789012' },
    { fullName: 'Emmanuel Tumusiime',  position: 'ICT Teacher',          salaryScale: 'Scale_3', paymentMethod: 'bank',         bankName: 'Centenary Bank', bankAccountName: 'Emmanuel Tumusiime',  bankAccountNumber: '3100012398765' }
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function run() {
    // Guard: this writes a lot of data, so refuse anything non-local.
    if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(BASE)) {
        throw new Error(`Refusing to seed demo data into "${BASE}" — it must be a local instance.`);
    }

    process.stdout.write('\n  EduPay — demo data\n');

    const emailWorks = await mailConfigured();
    log(emailWorks
        ? 'Email is configured, so accounts activate via their emailed setup link'
        : 'Email is not configured, so accounts activate with a temporary password');

    // --- Sign in as the administrator --------------------------------------
    step('Signing in as the administrator');
    let adminToken;
    try {
        const session = await login(ADMIN_USERNAME, ADMIN_PASSWORD, process.env.ADMIN_EMAIL || 'admin@edupay.local');
        adminToken = session.token;

        if (session.user.mustChangePassword) {
            const changed = await api('/auth/change-password', {
                method: 'POST',
                token: adminToken,
                body: { currentPassword: ADMIN_PASSWORD, newPassword: DEMO_PASSWORD }
            });
            adminToken = changed.token;
            created.notes.push(`The administrator password is now ${DEMO_PASSWORD}`);
            log(`Administrator password changed to ${DEMO_PASSWORD}`);
        } else {
            log('Administrator signed in');
        }
    } catch (err) {
        throw new Error(
            `Could not sign in as "${ADMIN_USERNAME}".\n`
            + `  ${err.message}\n\n`
            + '  Pass the current password:  ADMIN_PASSWORD=… node scripts/seed-demo.js\n'
            + '  Or reseed from scratch:     ./scripts/dev-db.sh reset'
        );
    }

    // --- HR and accountant -------------------------------------------------
    step('Creating staff accounts');
    const staff = {};

    for (const person of [
        { role: 'hr', username: 'agnes.hr', fullName: 'Agnes Byaruhanga', email: 'agnes.hr@edupay.local' },
        { role: 'accountant', username: 'paul.acc', fullName: 'Paul Okello', email: 'paul.acc@edupay.local', department: 'Finance' },
        { role: 'accountant', username: 'sarah.acc', fullName: 'Sarah Nambi', email: 'sarah.acc@edupay.local', department: 'Finance' }
    ]) {
        try {
            const result = await api('/admin/users', { method: 'POST', token: adminToken, body: person });
            const token = await activate({ username: person.username, email: person.email, activation: result.activation });

            staff[person.username] = { ...person, token };
            created.staff.push({ ...person, password: DEMO_PASSWORD });
            log(`${person.role.padEnd(10)} ${person.username.padEnd(12)} ${person.fullName}`);
        } catch (err) {
            if (err.code === 'USERNAME_TAKEN') {
                const session = await login(person.username, DEMO_PASSWORD, person.email);
                staff[person.username] = { ...person, token: session.token };
                log(`${person.role.padEnd(10)} ${person.username.padEnd(12)} already existed, signed in`);
            } else {
                throw err;
            }
        }
    }

    const hr = staff['agnes.hr'];
    const accountant = staff['paul.acc'];

    for (const [label, person] of [['HR', hr], ['accountant', accountant]]) {
        if (!person?.token) throw new Error(`The ${label} account has no session token — activation did not complete.`);
    }

    // --- Extra salary scales ----------------------------------------------
    step('Adding salary scales');
    for (const scale of SCALES) {
        await api('/hr/salary-structures', { method: 'POST', token: hr.token, body: scale });
        log(`${scale.salaryScale.padEnd(20)} basic ${scale.basicSalary.toLocaleString()}`);
    }

    // --- Teachers ----------------------------------------------------------
    step('Adding teachers');
    const teacherTokens = {};

    for (const teacher of TEACHERS) {
        const username = teacher.fullName.toLowerCase().replace(/\s+/g, '.');
        const email = `${username}@edupay.local`;

        try {
            const result = await api('/hr/teachers', {
                method: 'POST', token: hr.token, body: { ...teacher, username, email }
            });

            created.teachers.push({
                fullName: teacher.fullName,
                username,
                employeeId: result.teacher.employeeId,
                scale: teacher.salaryScale,
                canSignIn: Boolean(teacher.signIn)
            });

            // Only activate the few we want to demonstrate the portal with;
            // the rest stay pending, which is realistic and shows that state.
            if (teacher.signIn) {
                teacherTokens[username] = await activate({ username, email, activation: result.activation });
            }

            log(`${result.teacher.employeeId}  ${teacher.fullName.padEnd(22)} ${teacher.salaryScale}`
                + (teacher.signIn ? '  (can sign in)' : ''));
        } catch (err) {
            if (err.code === 'USERNAME_TAKEN') log(`${teacher.fullName} already existed, skipped`);
            else throw err;
        }
    }

    // --- Leave requests ----------------------------------------------------
    step('Submitting leave requests');
    const grace = teacherTokens['grace.nakato'];
    const samuel = teacherTokens['samuel.okiror'];

    const leaveRequests = [
        { token: grace,  body: { leaveType: 'Annual', startDate: iso(14), endDate: iso(18), reason: 'Family wedding upcountry' }, decide: 'Approved' },
        { token: samuel, body: { leaveType: 'Sick',   startDate: iso(-6), endDate: iso(-4), reason: 'Malaria, with a medical certificate' }, decide: 'Approved' },
        { token: grace,  body: { leaveType: 'Unpaid', startDate: iso(30), endDate: iso(34), reason: 'Personal matters abroad' }, decide: 'Approved' },
        { token: samuel, body: { leaveType: 'Study',  startDate: iso(60), endDate: iso(66), reason: 'Postgraduate residency week' }, decide: null }
    ];

    for (const request of leaveRequests) {
        if (!request.token) continue;
        try {
            const result = await api('/teacher/leave', { method: 'POST', token: request.token, body: request.body });
            log(`${request.body.leaveType.padEnd(8)} ${result.days} day(s) from ${request.body.startDate}`
                + `${result.isUnpaid ? '  (unpaid)' : ''}`);
            request.id = result.id;
        } catch (err) {
            log(`${request.body.leaveType}: ${err.message}`);
        }
    }

    step('HR deciding on leave');
    const pendingLeave = await api('/hr/leave?status=Pending', { token: hr.token });
    for (const request of pendingLeave) {
        const planned = leaveRequests.find(r => r.id === request.id);
        if (!planned?.decide) continue;

        await api(`/hr/leave/${request.id}/status`, {
            method: 'PUT', token: hr.token,
            body: { status: planned.decide, note: planned.decide === 'Approved' ? 'Approved — enjoy.' : undefined }
        });
        log(`${planned.decide}: ${request.fullName}, ${request.leaveType}, ${request.days} day(s)`);
    }

    // --- Advances ----------------------------------------------------------
    step('Submitting advance requests');
    const advances = [];

    for (const [username, token, amount, instalments, reason] of [
        ['grace.nakato', grace, 600000, 3, 'School fees for my children'],
        ['samuel.okiror', samuel, 1500000, 4, 'Roof repairs after the storm']
    ]) {
        if (!token) continue;
        try {
            const result = await api('/teacher/advances', {
                method: 'POST', token, body: { amount, reason, instalments }
            });
            advances.push({ id: result.id, username, amount, instalments });
            log(`${username.padEnd(16)} ${amount.toLocaleString()} over ${instalments} instalment(s)`);
        } catch (err) {
            log(`${username}: ${err.message}`);
        }
    }

    step('HR approving advances');
    for (const advance of advances) {
        await api(`/hr/advances/${advance.id}/status`, {
            method: 'PUT', token: hr.token,
            body: { status: 'Approved', instalments: advance.instalments, note: 'Approved.' }
        });
        log(`Approved ${advance.amount.toLocaleString()} for ${advance.username} over ${advance.instalments}`);
    }

    // --- Pause one teacher -------------------------------------------------
    step('Pausing one teacher’s payroll');
    const teacherList = await api('/accountant/teachers', { token: accountant.token });
    const toPause = teacherList.find(t => t.fullName === 'Miriam Nabukenya');
    if (toPause) {
        await api(`/accountant/teachers/${toPause.id}/payroll-halt`, {
            method: 'PUT', token: accountant.token,
            body: { halted: true, reason: 'Contract under review by the board' }
        });
        log(`${toPause.fullName} paused — excluded from the next run`);
    }

    // --- Payroll -----------------------------------------------------------
    const { month, year } = lastMonth();

    step(`Processing payroll for ${month}/${year}`);
    const processed = await api('/accountant/payroll/process', {
        method: 'POST', token: accountant.token, body: { month, year }
    });
    log(`${processed.employeeCount} employee(s)`);
    log(`gross ${processed.totalGross.toLocaleString()}  net ${processed.totalNet.toLocaleString()}`);
    log(`PAYE ${processed.totalPaye.toLocaleString()}  NSSF employee ${processed.totalNssfEmployee.toLocaleString()}`
        + `  employer ${processed.totalNssfEmployer.toLocaleString()}`);
    (processed.notes || []).forEach(note => log(note));

    step('HR approving the payroll run');
    const approved = await api(`/hr/payroll/${processed.payrollId}/approve`, {
        method: 'POST', token: hr.token
    });
    log(approved.message);

    step('Recording some payments');
    const { items } = await api(`/accountant/payroll/${processed.payrollId}/items`, { token: accountant.token });
    const toPay = items.slice(0, Math.max(1, Math.floor(items.length / 2)));

    for (const item of toPay) {
        await api(`/accountant/payroll-items/${item.id}/payment-status`, {
            method: 'PUT', token: accountant.token,
            body: { paymentStatus: 'Paid', reference: `TRX-${String(item.id).padStart(5, '0')}` }
        });
    }
    log(`${toPay.length} of ${items.length} paid — the run stays "approved" until all are`);

    // --- Summary -----------------------------------------------------------
    const stats = await api('/admin/stats', { token: adminToken });

    process.stdout.write('\n\x1b[32m  ✓ Demo data ready\x1b[0m\n\n');
    process.stdout.write('  Sign in at ' + BASE + ' — every demo account uses the same password:\n\n');
    process.stdout.write(`    password:  ${DEMO_PASSWORD}\n\n`);
    process.stdout.write('    admin        ' + ADMIN_USERNAME + '\n');
    created.staff.forEach(s => process.stdout.write(`    ${s.role.padEnd(12)} ${s.username}\n`));
    created.teachers.filter(t => t.canSignIn).forEach(t =>
        process.stdout.write(`    teacher      ${t.username.padEnd(22)} (${t.employeeId})\n`));

    const pending = created.teachers.filter(t => !t.canSignIn).length;
    if (pending) {
        process.stdout.write(`\n  ${pending} more teachers exist but have not activated — they show as\n`);
        process.stdout.write('  "Password not set" in the HR dashboard, with a Resend link action.\n');
    }

    process.stdout.write(`\n  ${stats.totalTeachers} teachers · ${stats.totalPayrolls} payroll run(s)`
        + ` · ${stats.totalUsers} accounts\n`);

    if (await mailConfigured()) {
        process.stdout.write(`  Every email sent along the way: ${MAILPIT}\n`);
    }
    process.stdout.write('\n');
}

run().catch(err => {
    process.stderr.write(`\n\x1b[31m  Demo seeding failed\x1b[0m\n  ${err.message}\n\n`);
    process.exit(1);
});
