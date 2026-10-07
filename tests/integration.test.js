/**
 * End-to-end workflow tests against a real PostgreSQL database.
 *
 * Point TEST_DATABASE_URL at a throwaway database and run:
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/edupay_test npm test
 *
 * The suite truncates every table and seeds a known state before running, so it
 * is repeatable. Without TEST_DATABASE_URL it skips entirely, so `npm test`
 * still works with no database. It refuses to run unless the database name
 * contains "test", so it cannot destroy real data.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Load .env first: this is read before any server module pulls dotenv in.
require('dotenv').config({ quiet: true });

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'integration-secret-long-enough-for-tests-32';
process.env.RATE_LIMIT_AUTH = '500';
process.env.RATE_LIMIT_API = '5000';
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const suite = TEST_DATABASE_URL ? test.describe : test.describe.skip;

suite('EduPay payroll workflow', () => {
    let server;
    let base;

    // Credentials discovered as the suite runs.
    const admin = { username: 'admin', password: 'SeedAdmin-2026!x' };
    const hr = { username: 'hr.manager' };
    const accountant = { username: 'acc.officer' };
    const teacher = {};

    let payrollId;
    let teacherId;
    let advanceId;

    const call = async (path, { method = 'GET', body, token } = {}) => {
        const res = await fetch(`${base}/api${path}`, {
            method,
            headers: {
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {})
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        });

        const text = await res.text();
        let payload;
        try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
        return { status: res.status, body: payload };
    };

    const login = async (username, password) => {
        const res = await call('/auth/login', { method: 'POST', body: { username, password } });
        assert.equal(res.status, 200, `login for ${username} failed: ${JSON.stringify(res.body)}`);
        return res.body;
    };

    test.before(async () => {
        // Guard: this suite destroys data, so refuse anything that is not
        // obviously a test database.
        const name = new URL(TEST_DATABASE_URL).pathname.replace('/', '');
        assert.ok(
            /test/i.test(name),
            `refusing to run destructive tests against database "${name}" — its name must contain "test"`
        );

        const db = require('../server/db');
        const { migrate } = require('../server/migrate');

        /* Always migrate. This used to run only when the database was empty,
           which meant that once `users` existed no later migration was ever
           applied — a new table would simply be missing and every test that
           touched it failed with "relation does not exist". The runner records
           what it has applied, so calling it each time is cheap and correct. */
        await migrate();

        // Reset to a known state. TRUNCATE CASCADE also resets the sequences.
        await db.execute(`
            TRUNCATE payroll_versions, payroll_items, payroll, leave_requests, advance_requests,
                     notifications, audit_log, password_resets, teachers, accountants,
                     user_avatars, users, salary_structures, system_config, counters
            RESTART IDENTITY CASCADE
        `);

        const pwService = require('../server/services/passwords');
        const configService = require('../server/services/config');

        await configService.ensureDefaults();

        await db.execute(
            `INSERT INTO salary_structures
                 (salary_scale, basic_salary, housing_allowance, transport_allowance, medical_allowance)
             VALUES ('Scale_1', 800000, 100000, 50000, 30000)`
        );

        await db.execute(
            `INSERT INTO users (
                 username, password_hash, role, full_name,
                 is_active, must_change_password, password_setup_completed, mfa_enabled, token_version
             ) VALUES ($1, $2, 'admin', 'System Administrator', TRUE, TRUE, TRUE, FALSE, 0)`,
            [admin.username, await pwService.hash(admin.password)]
        );

        const { app } = require('../server/server');
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    test.after(async () => {
        await new Promise(resolve => server.close(resolve));
        await require('../server/db').close();
    });

    test('the seeded administrator must change their password before doing anything', async () => {
        const session = await login(admin.username, admin.password);
        assert.equal(session.user.mustChangePassword, true);

        // The forced-change flag is now actually enforced server-side.
        const blocked = await call('/admin/users', { token: session.token });
        assert.equal(blocked.status, 403);
        assert.equal(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED');

        const changed = await call('/auth/change-password', {
            method: 'POST',
            token: session.token,
            body: { currentPassword: admin.password, newPassword: 'AdminChosen-2026!x' }
        });
        assert.equal(changed.status, 200);
        assert.ok(changed.body.token, 'a replacement token must be issued');

        admin.password = 'AdminChosen-2026!x';
        admin.token = changed.body.token;

        const allowed = await call('/admin/users', { token: admin.token });
        assert.equal(allowed.status, 200);
    });

    test('a password change revokes the previous token', async () => {
        const session = await login(admin.username, admin.password);

        await call('/auth/change-password', {
            method: 'POST',
            token: session.token,
            body: { currentPassword: admin.password, newPassword: 'AdminRotated-2026!x' }
        });
        admin.password = 'AdminRotated-2026!x';

        // The token from before the change must no longer work.
        const stale = await call('/admin/users', { token: session.token });
        assert.equal(stale.status, 401);
        assert.equal(stale.body.code, 'TOKEN_REVOKED');

        admin.token = (await login(admin.username, admin.password)).token;
    });

    test('the weak legacy passwords are rejected', async () => {
        for (const weak of ['teacher123', 'admin123', 'hr123']) {
            const res = await call('/auth/change-password', {
                method: 'POST',
                token: admin.token,
                body: { currentPassword: admin.password, newPassword: weak }
            });
            assert.equal(res.status, 400, `${weak} must be rejected`);
        }
    });

    test('the administrator creates HR and accountant accounts with unique temporary passwords', async () => {
        const hrRes = await call('/admin/users', {
            method: 'POST',
            token: admin.token,
            body: { fullName: 'Agnes Byaruhanga', username: hr.username, role: 'hr' }
        });
        assert.equal(hrRes.status, 201, JSON.stringify(hrRes.body));
        assert.ok(hrRes.body.activation.temporaryPassword, 'a temporary password must be issued');
        hr.password = hrRes.body.activation.temporaryPassword;

        const accRes = await call('/admin/users', {
            method: 'POST',
            token: admin.token,
            body: { fullName: 'Paul Okello', username: accountant.username, role: 'accountant' }
        });
        assert.equal(accRes.status, 201, JSON.stringify(accRes.body));
        accountant.password = accRes.body.activation.temporaryPassword;

        // No shared defaults: the two passwords must differ.
        assert.notEqual(hr.password, accountant.password);
    });

    test('a duplicate username is refused', async () => {
        const res = await call('/admin/users', {
            method: 'POST',
            token: admin.token,
            body: { fullName: 'Someone Else', username: hr.username, role: 'hr' }
        });
        assert.equal(res.status, 409);
        assert.equal(res.body.code, 'USERNAME_TAKEN');
    });

    test('HR and the accountant activate their accounts', async () => {
        for (const account of [hr, accountant]) {
            const session = await login(account.username, account.password);
            assert.equal(session.user.mustChangePassword, true);

            const chosen = `Chosen-${account.username.replace(/\W/g, '')}-2026!x`;
            const changed = await call('/auth/change-password', {
                method: 'POST',
                token: session.token,
                body: { currentPassword: account.password, newPassword: chosen }
            });
            assert.equal(changed.status, 200, JSON.stringify(changed.body));

            account.password = chosen;
            account.token = changed.body.token;
        }
    });

    test('a salary structure saves — the operation that always failed before', async () => {
        // The old schema had no unique constraint on the scale while the insert
        // used ON CONFLICT (salary_scale), so every save returned a 500.
        const res = await call('/hr/salary-structures', {
            method: 'POST',
            token: hr.token,
            body: {
                salaryScale: 'Scale_Test', basicSalary: 1200000, housingAllowance: 150000,
                transportAllowance: 80000, medicalAllowance: 50000, nssfPercentage: 5
            }
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));

        // Saving again updates in place rather than creating a duplicate.
        const again = await call('/hr/salary-structures', {
            method: 'POST',
            token: hr.token,
            body: { salaryScale: 'Scale_Test', basicSalary: 1300000 }
        });
        assert.equal(again.status, 200);

        const list = await call('/hr/salary-structures', { token: hr.token });
        const matches = list.body.filter(s => s.id === 'Scale_Test');
        assert.equal(matches.length, 1, 'a scale must never be duplicated');
        assert.equal(Number(matches[0].basicSalary), 1300000);
    });

    test('a teacher on an unknown salary scale is refused', async () => {
        const res = await call('/hr/teachers', {
            method: 'POST',
            token: hr.token,
            body: { fullName: 'Ghost Teacher', salaryScale: 'Scale_Nonexistent' }
        });
        assert.equal(res.status, 400);
        assert.equal(res.body.code, 'UNKNOWN_SCALE');
    });

    test('HR adds a teacher', async () => {
        const res = await call('/hr/teachers', {
            method: 'POST',
            token: hr.token,
            body: {
                fullName: 'Grace Nakato', username: 'grace.nakato', salaryScale: 'Scale_Test',
                position: 'Mathematics Teacher', paymentMethod: 'bank',
                bankName: 'Stanbic', bankAccountName: 'Grace Nakato', bankAccountNumber: '0123456789'
            }
        });
        assert.equal(res.status, 201, JSON.stringify(res.body));

        teacherId = res.body.teacher.id;
        teacher.username = res.body.teacher.username;
        teacher.password = res.body.activation.temporaryPassword;
        assert.match(res.body.teacher.employeeId, /^TCH\d{4}$/);

        const session = await login(teacher.username, teacher.password);
        const changed = await call('/auth/change-password', {
            method: 'POST',
            token: session.token,
            body: { currentPassword: teacher.password, newPassword: 'GraceChosen-2026!x' }
        });
        assert.equal(changed.status, 200);
        teacher.password = 'GraceChosen-2026!x';
        teacher.token = changed.body.token;
    });

    test('the teacher sees their own profile and leave entitlement', async () => {
        const res = await call('/teacher/profile', { token: teacher.token });
        assert.equal(res.status, 200);
        assert.equal(res.body.fullName, 'Grace Nakato');
        assert.equal(res.body.salaryScale, 'Scale_Test');
        assert.equal(res.body.leaveBalance.entitlementDays, 21);
        assert.equal(res.body.scaleMissing, false);

        // Credentials must never be exposed.
        assert.equal(res.body.password, undefined);
    });

    test('leave validation rejects a backwards date range and an overlap', async () => {
        const future = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

        const backwards = await call('/teacher/leave', {
            method: 'POST',
            token: teacher.token,
            body: { leaveType: 'Annual', startDate: future(20), endDate: future(10), reason: 'Backwards' }
        });
        assert.equal(backwards.status, 400);
        assert.equal(backwards.body.code, 'LEAVE_RANGE_INVALID');

        const ok = await call('/teacher/leave', {
            method: 'POST',
            token: teacher.token,
            body: { leaveType: 'Annual', startDate: future(10), endDate: future(14), reason: 'Family visit' }
        });
        assert.equal(ok.status, 201, JSON.stringify(ok.body));
        assert.equal(ok.body.days, 5);

        const overlap = await call('/teacher/leave', {
            method: 'POST',
            token: teacher.token,
            body: { leaveType: 'Annual', startDate: future(12), endDate: future(16), reason: 'Overlaps' }
        });
        assert.equal(overlap.status, 409);
        assert.equal(overlap.body.code, 'LEAVE_OVERLAP');
    });

    test('submitting leave notifies HR', async () => {
        const res = await call('/notifications', { token: hr.token });
        assert.equal(res.status, 200);

        const leaveNote = res.body.notifications.find(n => n.category === 'leave');
        assert.ok(leaveNote, 'HR must be told a leave request arrived');
        assert.match(leaveNote.message, /Grace Nakato/);
    });

    test('an advance beyond the ceiling is refused, and a valid one is accepted', async () => {
        const huge = await call('/teacher/advances', {
            method: 'POST',
            token: teacher.token,
            body: { amount: 99000000, reason: 'Too much' }
        });
        assert.equal(huge.status, 400);
        assert.equal(huge.body.code, 'ADVANCE_EXCEEDS_LIMIT');

        const ok = await call('/teacher/advances', {
            method: 'POST',
            token: teacher.token,
            body: { amount: 400000, reason: 'School fees', instalments: 2 }
        });
        assert.equal(ok.status, 201, JSON.stringify(ok.body));
        advanceId = ok.body.id;

        // Only one open advance at a time.
        const second = await call('/teacher/advances', {
            method: 'POST',
            token: teacher.token,
            body: { amount: 10000, reason: 'Another' }
        });
        assert.equal(second.status, 409);
        assert.equal(second.body.code, 'ADVANCE_ALREADY_OPEN');
    });

    test('HR approves the advance over two instalments', async () => {
        const res = await call(`/hr/advances/${advanceId}/status`, {
            method: 'PUT',
            token: hr.token,
            body: { status: 'Approved', instalments: 2, note: 'Approved over two runs' }
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));

        const list = await call('/hr/advances?status=Approved', { token: hr.token });
        const approved = list.body.find(a => a.id === advanceId);
        assert.equal(approved.instalments, 2);
        assert.equal(approved.instalmentAmount, 200000);
    });

    test('payroll rejects an impossible period', async () => {
        const res = await call('/accountant/payroll/process', {
            method: 'POST',
            token: accountant.token,
            body: { month: 47, year: 1823 }
        });
        assert.equal(res.status, 400);
    });

    test('the accountant processes payroll, deducting one advance instalment', async () => {
        const period = { month: 6, year: 2026 };

        const res = await call('/accountant/payroll/process', {
            method: 'POST',
            token: accountant.token,
            body: period
        });
        assert.equal(res.status, 201, JSON.stringify(res.body));

        payrollId = res.body.payrollId;
        assert.ok(Number.isInteger(payrollId), 'the run has a numeric primary key');
        assert.equal(res.body.version, 1);
        assert.ok(res.body.employeeCount >= 1);

        const items = await call(`/accountant/payroll/${payrollId}/items`, { token: accountant.token });
        const line = items.body.items.find(i => i.teacherId === teacherId);

        assert.equal(line.grossSalary, 1580000);          // 1,300,000 + 280,000 allowances
        assert.equal(line.advanceDeduction, 200000);      // one of two instalments
        assert.equal(line.nssfAmount, 79000);             // 5% employee
        assert.equal(line.nssfEmployerAmount, 158000);    // 10% employer, not deducted
        assert.equal(line.employerCost, 1738000);
        assert.ok(line.taxAmount > 0, 'banded PAYE must apply');
        assert.equal(line.netSalary, line.grossSalary - line.totalDeductions);
        assert.ok(line.netSalary > 0);
    });

    test('processing the same period twice does not create a duplicate run', async () => {
        const again = await call('/accountant/payroll/process', {
            method: 'POST',
            token: accountant.token,
            body: { month: 6, year: 2026 }
        });
        assert.equal(again.status, 201);
        assert.equal(again.body.payrollId, payrollId,
            'the UNIQUE (month, year) constraint must force the same row to be reused');
        assert.equal(again.body.version, 2, 'the run is versioned, not duplicated');

        // The superseded version is archived rather than deleted.
        const versions = await call(`/accountant/payroll/${payrollId}/versions`, { token: accountant.token });
        assert.equal(versions.status, 200);
        assert.ok(versions.body.length >= 1, 'the previous version must be archived');
        assert.ok(Array.isArray(versions.body[0].items), 'the archived version keeps its lines');
    });

    test('reprocessing does not double-count the advance repayment', async () => {
        const list = await call('/hr/advances', { token: hr.token });
        const advance = list.body.find(a => a.id === advanceId);

        // Still exactly one instalment taken, despite two processing runs.
        assert.equal(advance.instalmentsPaid, 1);
        assert.equal(Number(advance.amountRepaid), 200000);
        assert.equal(advance.outstanding, 200000);
    });

    test('payments cannot be recorded before HR approves', async () => {
        const items = await call(`/accountant/payroll/${payrollId}/items`, { token: accountant.token });
        const line = items.body.items[0];

        const res = await call(`/accountant/payroll-items/${line.id}/payment-status`, {
            method: 'PUT',
            token: accountant.token,
            body: { paymentStatus: 'Paid' }
        });
        assert.equal(res.status, 409);
        assert.equal(res.body.code, 'PAYROLL_NOT_APPROVED');
    });

    test('the accountant cannot approve payroll, and neither can an administrator', async () => {
        const byAccountant = await call(`/hr/payroll/${payrollId}/approve`, {
            method: 'POST', token: accountant.token
        });
        assert.equal(byAccountant.status, 403);

        const byAdmin = await call(`/hr/payroll/${payrollId}/approve`, {
            method: 'POST', token: admin.token
        });
        assert.equal(byAdmin.status, 403);
        assert.equal(byAdmin.body.code, 'HR_ONLY');
    });

    test('a teacher cannot reach another role\'s endpoints', async () => {
        for (const path of ['/admin/users', '/hr/teachers', '/accountant/payroll']) {
            const res = await call(path, { token: teacher.token });
            assert.equal(res.status, 403, `${path} must be forbidden to a teacher`);
        }
    });

    test('the payslip is hidden from the teacher until the run is approved', async () => {
        const res = await call('/teacher/payslips', { token: teacher.token });
        assert.equal(res.status, 200);
        assert.equal(res.body.length, 0, 'an unapproved run must not be visible');
    });

    test('HR approves the payroll run', async () => {
        const res = await call(`/hr/payroll/${payrollId}/approve`, { method: 'POST', token: hr.token });
        assert.equal(res.status, 200, JSON.stringify(res.body));

        const runs = await call('/accountant/payroll', { token: accountant.token });
        const run = runs.body.find(r => r.id === payrollId);
        assert.equal(run.status, 'approved');
        assert.equal(run.approvedByName, 'Agnes Byaruhanga');
    });

    test('approval notifies both the teacher and the accountant', async () => {
        const teacherNotes = await call('/notifications', { token: teacher.token });
        assert.ok(
            teacherNotes.body.notifications.some(n => n.category === 'payroll'),
            'the teacher must be told their payslip is ready'
        );

        const accountantNotes = await call('/notifications', { token: accountant.token });
        assert.ok(
            accountantNotes.body.notifications.some(n => /approved/i.test(n.title)),
            'the accountant must be told the run is payable'
        );
    });

    test('an approved run cannot be reprocessed', async () => {
        const res = await call('/accountant/payroll/process', {
            method: 'POST',
            token: accountant.token,
            body: { month: 6, year: 2026 }
        });
        assert.equal(res.status, 409);
        assert.equal(res.body.code, 'PAYROLL_LOCKED');
    });

    test('the teacher can now see and download the payslip', async () => {
        const list = await call('/teacher/payslips', { token: teacher.token });
        assert.equal(list.body.length, 1);

        const payslipId = list.body[0].id;
        const pdf = await fetch(`${base}/api/teacher/payslip/${payslipId}/pdf`, {
            headers: { Authorization: `Bearer ${teacher.token}` }
        });
        assert.equal(pdf.status, 200);
        assert.equal(pdf.headers.get('content-type'), 'application/pdf');

        const bytes = Buffer.from(await pdf.arrayBuffer());
        assert.ok(bytes.length > 1000, 'the PDF must have real content');
        assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
    });

    test('the accountant records payment and the run becomes paid', async () => {
        const items = await call(`/accountant/payroll/${payrollId}/items`, { token: accountant.token });

        for (const line of items.body.items) {
            const res = await call(`/accountant/payroll-items/${line.id}/payment-status`, {
                method: 'PUT',
                token: accountant.token,
                body: { paymentStatus: 'Paid', reference: 'TRX-00417' }
            });
            assert.equal(res.status, 200, JSON.stringify(res.body));
        }

        const runs = await call('/accountant/payroll', { token: accountant.token });
        assert.equal(runs.body.find(r => r.id === payrollId).status, 'paid');
    });

    test('reverting one payment returns the run to approved', async () => {
        const items = await call(`/accountant/payroll/${payrollId}/items`, { token: accountant.token });
        const line = items.body.items[0];

        const res = await call(`/accountant/payroll-items/${line.id}/payment-status`, {
            method: 'PUT',
            token: accountant.token,
            body: { paymentStatus: 'Pending' }
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.payrollStatus, 'approved', 'the run must no longer be fully paid');
    });

    test('the statutory report totals PAYE and both NSSF shares', async () => {
        const res = await call(`/accountant/reports/statutory/${payrollId}`, { token: accountant.token });
        assert.equal(res.status, 200);

        assert.ok(res.body.paye > 0);
        assert.ok(res.body.nssfEmployee > 0);
        assert.ok(res.body.nssfEmployer > 0);
        assert.equal(
            res.body.nssfTotal,
            Math.round((res.body.nssfEmployee + res.body.nssfEmployer) * 100) / 100
        );
        assert.ok(res.body.employerCostTotal > res.body.grossTotal);
    });

    test('the Excel and PDF exports produce real files', async () => {
        const excel = await fetch(`${base}/api/accountant/reports/export/excel/${payrollId}`, {
            headers: { Authorization: `Bearer ${accountant.token}` }
        });
        assert.equal(excel.status, 200);
        const xlsx = Buffer.from(await excel.arrayBuffer());
        assert.ok(xlsx.length > 2000);
        assert.equal(xlsx.subarray(0, 2).toString(), 'PK', 'an xlsx file is a zip archive');

        const pdf = await fetch(`${base}/api/accountant/reports/export/pdf/${payrollId}`, {
            headers: { Authorization: `Bearer ${accountant.token}` }
        });
        assert.equal(pdf.status, 200);
        assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    });

    test('a teacher with payroll history cannot be deleted, only deactivated', async () => {
        const deleted = await call(`/hr/teachers/${teacherId}`, { method: 'DELETE', token: hr.token });
        assert.equal(deleted.status, 409);
        assert.equal(deleted.body.code, 'HAS_PAYROLL_HISTORY');

        const deactivated = await call(`/hr/teachers/${teacherId}/deactivate`, {
            method: 'POST', token: hr.token, body: { reason: 'Resigned' }
        });
        assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));

        // Deactivation revokes their session.
        const stale = await call('/teacher/profile', { token: teacher.token });
        assert.equal(stale.status, 403);
        assert.equal(stale.body.code, 'USER_INACTIVE');
    });

    test('a scale still in use cannot be deleted', async () => {
        await call(`/hr/teachers/${teacherId}/reactivate`, { method: 'POST', token: hr.token });

        const res = await call('/hr/salary-structures/Scale_Test', { method: 'DELETE', token: hr.token });
        assert.equal(res.status, 409);
        assert.equal(res.body.code, 'SCALE_IN_USE');
    });

    test('the last administrator cannot be deactivated', async () => {
        const users = await call('/admin/users?role=admin', { token: admin.token });
        const other = users.body.find(u => u.username !== admin.username && u.isActive);

        if (!other) {
            const res = await call(`/admin/users/${users.body[0].id}/deactivate`, {
                method: 'POST', token: admin.token, body: {}
            });
            // Either refused as self-deactivation or as the last administrator.
            assert.ok([400].includes(res.status), JSON.stringify(res.body));
        }
    });

    test('two-factor activity never exposes a verification code', async () => {
        const res = await call('/admin/mfa-status', { token: admin.token });
        assert.equal(res.status, 200);

        const serialised = JSON.stringify(res.body);
        assert.ok(!/otpCode|otp_code/.test(serialised), 'codes must never be returned');
        res.body.forEach(row => {
            assert.equal(row.code, undefined);
            assert.equal(row.otpCode, undefined);
        });
    });

    test('the audit log records the workflow and paginates', async () => {
        const res = await call('/admin/audit-log?limit=100', { token: admin.token });
        assert.equal(res.status, 200);

        const actions = res.body.entries.map(e => e.action);
        ['PROCESS_PAYROLL', 'APPROVE_PAYROLL', 'UPDATE_PAYMENT_STATUS', 'CREATE_TEACHER',
            'DECIDE_ADVANCE', 'PASSWORD_CHANGED'].forEach(action => {
                assert.ok(actions.includes(action), `${action} must be audited`);
            });

        const paged = await call('/admin/audit-log?limit=2', { token: admin.token });
        assert.equal(paged.body.entries.length, 2);
        assert.ok(paged.body.hasMore);
        assert.ok(paged.body.nextCursor);
    });

    test('the data export omits credentials', async () => {
        const res = await call('/admin/backup', { token: admin.token });
        assert.equal(res.status, 200);

        const serialised = JSON.stringify(res.body);
        assert.ok(!/"password"/.test(serialised), 'password hashes must not be exported');
        assert.ok(!/mfaSecret|passwordSetupTokenHash/.test(serialised), 'secrets must not be exported');
        assert.ok(res.body.users.length > 0);
        assert.ok(res.body.payroll.length > 0);
    });

    test('only an administrator can set a profile picture', async () => {
        // A 1x1-too-small PNG would be rejected on its dimensions, so this is a
        // legitimate 64x64 one: every refusal below is about who is asking,
        // never about what they sent.
        const png = Buffer.alloc(24);
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
        png.writeUInt32BE(13, 8);
        png.write('IHDR', 12, 'ascii');
        png.writeUInt32BE(64, 16);
        png.writeUInt32BE(64, 20);
        const image = `data:image/png;base64,${Buffer.concat([png, Buffer.alloc(64)]).toString('base64')}`;

        const adminSession = await login(admin.username, admin.password);
        const target = (await call('/admin/users?role=hr', { token: adminSession.token })).body[0];

        // The administrator may.
        const set = await call(`/admin/users/${target.id}/avatar`, {
            method: 'PUT', token: adminSession.token, body: { image }
        });
        assert.equal(set.status, 200, `administrator was refused: ${JSON.stringify(set.body)}`);
        assert.ok(set.body.avatar.startsWith('data:image/png;base64,'));

        // Nobody else may — including the account whose own picture it is.
        for (const actor of [hr, accountant, teacher]) {
            const session = await login(actor.username, actor.password);

            const put = await call(`/admin/users/${target.id}/avatar`, {
                method: 'PUT', token: session.token, body: { image }
            });
            assert.equal(put.status, 403, `${actor.username} was allowed to upload`);

            const del = await call(`/admin/users/${target.id}/avatar`, {
                method: 'DELETE', token: session.token
            });
            assert.equal(del.status, 403, `${actor.username} was allowed to delete`);
        }

        // And not without a token at all.
        const anonymous = await call(`/admin/users/${target.id}/avatar`, { method: 'PUT', body: { image } });
        assert.equal(anonymous.status, 401);

        // It is really stored, and the list reports it.
        const profile = await call(`/admin/users/${target.id}`, { token: adminSession.token });
        assert.equal(profile.status, 200);
        assert.ok(profile.body.avatar, 'the picture did not persist');

        const list = await call('/admin/users?role=hr', { token: adminSession.token });
        assert.equal(list.body.find(u => u.id === target.id).hasAvatar, true);

        // Removing it leaves the account intact.
        const removed = await call(`/admin/users/${target.id}/avatar`, {
            method: 'DELETE', token: adminSession.token
        });
        assert.equal(removed.status, 200);

        const after = await call(`/admin/users/${target.id}`, { token: adminSession.token });
        assert.equal(after.body.avatar, null);
        assert.equal(after.body.username, target.username, 'the account itself must survive');
    });

    test('a profile picture is deleted with its account, not left orphaned', async () => {
        const session = await login(admin.username, admin.password);

        const created = await call('/admin/users', {
            method: 'POST', token: session.token,
            body: { role: 'accountant', username: 'avatar.temp', fullName: 'Avatar Temp', email: 'avatar.temp@edupay.local' }
        });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const id = created.body.userId;

        const png = Buffer.alloc(24);
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
        png.writeUInt32BE(13, 8);
        png.write('IHDR', 12, 'ascii');
        png.writeUInt32BE(64, 16);
        png.writeUInt32BE(64, 20);

        await call(`/admin/users/${id}/avatar`, {
            method: 'PUT', token: session.token,
            body: { image: `data:image/png;base64,${Buffer.concat([png, Buffer.alloc(64)]).toString('base64')}` }
        });

        const gone = await call(`/admin/users/${id}`, { method: 'DELETE', token: session.token });
        assert.equal(gone.status, 200, JSON.stringify(gone.body));

        // ON DELETE CASCADE is what makes this true; without it the row would
        // linger with a dangling user_id.
        const orphans = await require('../server/db')
            .scalar('SELECT count(*)::int FROM user_avatars WHERE user_id = $1', [id]);
        assert.equal(orphans, 0, 'the picture outlived the account it belonged to');
    });

    test('signing out revokes the token', async () => {
        const session = await login(hr.username, hr.password);

        const out = await call('/auth/logout', { method: 'POST', token: session.token });
        assert.equal(out.status, 200);

        const after = await call('/hr/teachers', { token: session.token });
        assert.equal(after.status, 401);
        assert.equal(after.body.code, 'TOKEN_REVOKED');
    });
});
