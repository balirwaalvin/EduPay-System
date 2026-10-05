/**
 * Schema constraint tests.
 *
 * Several guards that previously lived only in application code are now database
 * constraints, which makes them race-free and impossible to bypass. These tests
 * assert the database itself refuses the bad cases, independently of any route.
 *
 *   TEST_DATABASE_URL=postgresql://... npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'constraint-tests-secret-long-enough-32';

const suite = TEST_DATABASE_URL ? test.describe : test.describe.skip;

suite('database constraints', () => {
    let db;
    let teacherId;
    let hrId;
    let accId;
    let payrollId;

    /** Assert a statement is rejected, optionally by a named constraint. */
    async function rejects(sql, params, constraint) {
        try {
            await db.execute(sql, params);
            assert.fail(`expected the database to reject this${constraint ? ` on ${constraint}` : ''}`);
        } catch (err) {
            assert.ok(err.code, `expected a database error, got: ${err.message}`);
            if (constraint) {
                assert.equal(err.constraint, constraint,
                    `expected constraint ${constraint}, got ${err.constraint} (${err.message})`);
            }
            return err;
        }
    }

    test.before(async () => {
        // Guard: this suite truncates every table, so refuse anything that is not
        // obviously a test database.
        const name = new URL(TEST_DATABASE_URL).pathname.replace('/', '');
        assert.ok(
            /test/i.test(name),
            `refusing to run destructive tests against database "${name}" — its name must contain "test"`
        );

        db = require('../server/db');
        const { migrate } = require('../server/migrate');

        const hasSchema = Number(await db.scalar(
            `SELECT count(*) AS count FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'users'`
        ));
        if (!hasSchema) await migrate();

        await db.execute(`
            TRUNCATE payroll_versions, payroll_items, payroll, leave_requests, advance_requests,
                     notifications, audit_log, password_resets, teachers, accountants,
                     users, salary_structures, system_config, counters
            RESTART IDENTITY CASCADE
        `);

        await db.execute(
            `INSERT INTO salary_structures (salary_scale, basic_salary, housing_allowance)
             VALUES ('Scale_C', 1200000, 150000)`
        );

        const rows = await db.query(
            `INSERT INTO users (username, password_hash, role, full_name, password_setup_completed)
             VALUES ('c.teacher','x','teacher','C Teacher',TRUE),
                    ('c.hr','x','hr','C HR',TRUE),
                    ('c.acc','x','accountant','C Acc',TRUE)
             RETURNING id, username`
        );
        hrId = rows.find(r => r.username === 'c.hr').id;
        accId = rows.find(r => r.username === 'c.acc').id;

        const teacher = await db.queryOne(
            `INSERT INTO teachers (user_id, employee_id, full_name, salary_scale)
             VALUES ($1, 'TCH9001', 'C Teacher', 'Scale_C') RETURNING id`,
            [rows.find(r => r.username === 'c.teacher').id]
        );
        teacherId = teacher.id;

        const run = await db.queryOne(
            `INSERT INTO payroll (month, year, processed_by, processed_by_name)
             VALUES (3, 2026, $1, 'C Acc') RETURNING id`,
            [accId]
        );
        payrollId = run.id;
    });

    test.after(async () => { if (db) await db.close(); });

    // --- Money ------------------------------------------------------------

    test('money is stored as exact decimal, not floating point', async () => {
        const row = await db.queryOne(`
            SELECT (0.1::numeric(14,2) + 0.2::numeric(14,2) = 0.3::numeric(14,2)) AS numeric_exact,
                   (0.1::float8 + 0.2::float8 = 0.3::float8)                      AS float_exact
        `);

        assert.equal(row.numericExact, true, 'NUMERIC arithmetic must be exact');
        assert.equal(row.floatExact, false, 'float arithmetic is not — which is why money is NUMERIC');
    });

    test('a stored amount round-trips without drift', async () => {
        await db.execute(
            `UPDATE salary_structures SET basic_salary = 1234567.89 WHERE salary_scale = 'Scale_C'`
        );
        const row = await db.queryOne(
            `SELECT basic_salary FROM salary_structures WHERE salary_scale = 'Scale_C'`
        );
        assert.equal(row.basicSalary, 1234567.89);

        await db.execute(
            `UPDATE salary_structures SET basic_salary = 1200000 WHERE salary_scale = 'Scale_C'`
        );
    });

    // --- Uniqueness -------------------------------------------------------

    test('one salary structure per scale', async () => {
        await rejects(
            `INSERT INTO salary_structures (salary_scale, basic_salary) VALUES ('Scale_C', 999)`,
            [], 'salary_structures_pkey'
        );
    });

    test('one payroll run per period', async () => {
        await rejects(
            `INSERT INTO payroll (month, year) VALUES (3, 2026)`,
            [], 'payroll_period_unique'
        );
    });

    test('usernames are unique', async () => {
        await rejects(
            `INSERT INTO users (username, password_hash, role, full_name) VALUES ('c.hr','x','hr','Clash')`,
            [], 'users_username_key'
        );
    });

    // --- Referential integrity --------------------------------------------

    test('a teacher cannot be put on a salary scale that does not exist', async () => {
        await rejects(
            `INSERT INTO users (username, password_hash, role, full_name) VALUES ('ghost','x','teacher','Ghost')`
        ).catch(() => { });

        const ghost = await db.queryOne(
            `INSERT INTO users (username, password_hash, role, full_name)
             VALUES ('c.ghost','x','teacher','Ghost') RETURNING id`
        );

        await rejects(
            `INSERT INTO teachers (user_id, employee_id, full_name, salary_scale)
             VALUES ($1, 'TCH9099', 'Ghost', 'Scale_Nonexistent')`,
            [ghost.id], 'teachers_salary_scale_fkey'
        );
    });

    test('a salary scale in use cannot be deleted', async () => {
        await rejects(
            `DELETE FROM salary_structures WHERE salary_scale = 'Scale_C'`,
            [], 'teachers_salary_scale_fkey'
        );
    });

    // --- Payroll integrity ------------------------------------------------

    const insertLine = (overrides = {}) => {
        const line = {
            gross: 1350000, deductions: 350000, net: 1000000, ...overrides
        };
        return db.execute(
            `INSERT INTO payroll_items (
                 payroll_id, teacher_id, month, year, teacher_name, employee_id, salary_scale,
                 basic_salary, contractual_basic_salary, gross_salary, total_deductions, net_salary
             ) VALUES ($1,$2,3,2026,'C Teacher','TCH9001','Scale_C',1200000,1200000,$3,$4,$5)`,
            [payrollId, teacherId, line.gross, line.deductions, line.net]
        );
    };

    test('net pay can never be negative', async () => {
        await rejects(
            `INSERT INTO payroll_items (
                 payroll_id, teacher_id, month, year, teacher_name, employee_id, salary_scale,
                 basic_salary, contractual_basic_salary, gross_salary, total_deductions, net_salary
             ) VALUES ($1,$2,3,2026,'C Teacher','TCH9001','Scale_C',1200000,1200000,1350000,1500000,-150000)`,
            [payrollId, teacherId], 'payroll_items_net_salary_check'
        );
    });

    test('the payroll arithmetic must be internally consistent', async () => {
        await rejects(
            `INSERT INTO payroll_items (
                 payroll_id, teacher_id, month, year, teacher_name, employee_id, salary_scale,
                 basic_salary, contractual_basic_salary, gross_salary, total_deductions, net_salary
             ) VALUES ($1,$2,3,2026,'C Teacher','TCH9001','Scale_C',1200000,1200000,1350000,350000,999999)`,
            [payrollId, teacherId], 'payroll_items_net_consistent'
        );
    });

    test('a consistent payroll line is accepted', async () => {
        await insertLine();
        const count = Number(await db.scalar(
            'SELECT count(*) AS count FROM payroll_items WHERE payroll_id = $1', [payrollId]
        ));
        assert.equal(count, 1);
    });

    test('the same teacher cannot appear twice on one payroll version', async () => {
        await rejects(
            `INSERT INTO payroll_items (
                 payroll_id, teacher_id, version, month, year, teacher_name, employee_id, salary_scale,
                 basic_salary, contractual_basic_salary, gross_salary, total_deductions, net_salary
             ) VALUES ($1,$2,1,3,2026,'C Teacher','TCH9001','Scale_C',1200000,1200000,1350000,350000,1000000)`,
            [payrollId, teacherId], 'payroll_items_unique'
        );
    });

    test('a teacher with payroll history cannot be deleted', async () => {
        await rejects(
            'DELETE FROM teachers WHERE id = $1', [teacherId], 'payroll_items_teacher_id_fkey'
        );
    });

    test('an impossible payroll period is rejected', async () => {
        await rejects('INSERT INTO payroll (month, year) VALUES (47, 2026)', [], 'payroll_month_check');
        await rejects('INSERT INTO payroll (month, year) VALUES (6, 1823)', [], 'payroll_year_check');
    });

    // --- Separation of duties ---------------------------------------------

    test('the processor of a payroll run cannot also be its approver', async () => {
        await rejects(
            `UPDATE payroll SET status = 'approved', approved_at = now(),
                    approved_by = $1, approved_by_name = 'C Acc' WHERE id = $2`,
            [accId, payrollId], 'payroll_processor_is_not_approver'
        );
    });

    test('a different approver is accepted', async () => {
        await db.execute(
            `UPDATE payroll SET status = 'approved', approved_at = now(),
                    approved_by = $1, approved_by_name = 'C HR' WHERE id = $2`,
            [hrId, payrollId]
        );
        const run = await db.queryOne('SELECT status, approved_by_name FROM payroll WHERE id = $1', [payrollId]);
        assert.equal(run.status, 'approved');
        assert.equal(run.approvedByName, 'C HR');
    });

    test('an approved run must record who approved it', async () => {
        await rejects(
            `UPDATE payroll SET approved_by_name = NULL WHERE id = $1`,
            [payrollId], 'payroll_approval_complete'
        );
    });

    test('deleting the approver keeps the approval, detaching only the key', async () => {
        // ON DELETE SET NULL must not collide with the approval constraint, or the
        // delete would fail — the bug class that broke deletes in the first place.
        await db.execute('DELETE FROM users WHERE id = $1', [hrId]);

        const run = await db.queryOne(
            'SELECT status, approved_by, approved_by_name FROM payroll WHERE id = $1', [payrollId]
        );
        assert.equal(run.status, 'approved', 'the run stays approved');
        assert.equal(run.approvedBy, null, 'the foreign key is detached');
        assert.equal(run.approvedByName, 'C HR', 'the approver name is preserved');
    });

    // --- Leave ------------------------------------------------------------

    const insertLeave = (start, end, type = 'Annual', status = 'Pending') => db.execute(
        `INSERT INTO leave_requests
             (teacher_id, teacher_name, employee_id, leave_type, start_date, end_date, reason, status)
         VALUES ($1,'C Teacher','TCH9001',$2,$3,$4,'Testing',$5)`,
        [teacherId, type, start, end, status]
    );

    test('a leave end date cannot precede its start', async () => {
        await rejects(
            `INSERT INTO leave_requests
                 (teacher_id, teacher_name, employee_id, leave_type, start_date, end_date, reason)
             VALUES ($1,'C Teacher','TCH9001','Annual','2026-07-20','2026-07-10','Backwards')`,
            [teacherId], 'leave_dates_ordered'
        );
    });

    test('the leave day count is derived by the database', async () => {
        await insertLeave('2026-07-10', '2026-07-14');
        const row = await db.queryOne(
            `SELECT days FROM leave_requests WHERE teacher_id = $1 AND start_date = '2026-07-10'`,
            [teacherId]
        );
        assert.equal(row.days, 5, 'five inclusive days, computed not supplied');
    });

    test('overlapping leave is impossible', async () => {
        await rejects(
            `INSERT INTO leave_requests
                 (teacher_id, teacher_name, employee_id, leave_type, start_date, end_date, reason)
             VALUES ($1,'C Teacher','TCH9001','Sick','2026-07-12','2026-07-16','Overlaps')`,
            [teacherId], 'leave_no_overlap'
        );
    });

    test('adjacent, non-overlapping leave is allowed', async () => {
        await insertLeave('2026-07-15', '2026-07-18', 'Sick');
        const count = Number(await db.scalar(
            'SELECT count(*) AS count FROM leave_requests WHERE teacher_id = $1', [teacherId]
        ));
        assert.equal(count, 2);
    });

    test('a rejected request does not block a later overlapping one', async () => {
        // The exclusion constraint only applies to Pending and Approved rows.
        await insertLeave('2026-09-01', '2026-09-05', 'Annual', 'Rejected');
        await insertLeave('2026-09-03', '2026-09-07', 'Annual', 'Pending');

        const count = Number(await db.scalar(
            `SELECT count(*) AS count FROM leave_requests
              WHERE teacher_id = $1 AND start_date >= '2026-09-01'`, [teacherId]
        ));
        assert.equal(count, 2, 'a rejected request must not reserve the dates');
    });

    // --- Advances ---------------------------------------------------------

    test('one open advance per teacher', async () => {
        await db.execute(
            `INSERT INTO advance_requests (teacher_id, teacher_name, employee_id, amount, reason)
             VALUES ($1,'C Teacher','TCH9001',400000,'First')`,
            [teacherId]
        );

        await rejects(
            `INSERT INTO advance_requests (teacher_id, teacher_name, employee_id, amount, reason)
             VALUES ($1,'C Teacher','TCH9001',100000,'Second')`,
            [teacherId], 'advance_one_open_per_teacher'
        );
    });

    test('a settled advance frees the teacher to request another', async () => {
        await db.execute(
            `UPDATE advance_requests SET status = 'Settled', amount_repaid = amount
              WHERE teacher_id = $1 AND status = 'Pending'`,
            [teacherId]
        );

        await db.execute(
            `INSERT INTO advance_requests (teacher_id, teacher_name, employee_id, amount, reason)
             VALUES ($1,'C Teacher','TCH9001',50000,'After settling')`,
            [teacherId]
        );

        const open = Number(await db.scalar(
            `SELECT count(*) AS count FROM advance_requests
              WHERE teacher_id = $1 AND status IN ('Pending','Approved','Repaying')`, [teacherId]
        ));
        assert.equal(open, 1);
    });

    test('an advance cannot be over-repaid', async () => {
        await rejects(
            `UPDATE advance_requests SET amount_repaid = amount + 1 WHERE teacher_id = $1
              AND status = 'Pending'`,
            [teacherId], 'advance_not_over_repaid'
        );
    });

    test('a zero or negative advance is rejected', async () => {
        await rejects(
            `INSERT INTO advance_requests (teacher_id, teacher_name, employee_id, amount, reason)
             VALUES ($1,'X','TCH9001',0,'Zero')`,
            [teacherId], 'advance_requests_amount_check'
        );
    });

    // --- Misc -------------------------------------------------------------

    test('a paused teacher must carry a reason', async () => {
        await rejects(
            'UPDATE teachers SET payroll_halted = TRUE WHERE id = $1',
            [teacherId], 'teachers_halt_reason_required'
        );

        await db.execute(
            `UPDATE teachers SET payroll_halted = TRUE, payroll_halt_reason = 'Under review' WHERE id = $1`,
            [teacherId]
        );
    });

    test('an unknown role is rejected', async () => {
        await rejects(
            `INSERT INTO users (username, password_hash, role, full_name)
             VALUES ('c.bad','x','superuser','Bad Role')`,
            [], 'users_role_check'
        );
    });

    test('updated_at is maintained by a trigger', async () => {
        const before = await db.queryOne('SELECT updated_at FROM teachers WHERE id = $1', [teacherId]);
        await new Promise(r => setTimeout(r, 25));
        await db.execute(`UPDATE teachers SET position = 'Updated' WHERE id = $1`, [teacherId]);
        const after = await db.queryOne('SELECT updated_at FROM teachers WHERE id = $1', [teacherId]);

        assert.ok(new Date(after.updatedAt) > new Date(before.updatedAt),
            'the trigger must advance updated_at without the UPDATE naming it');
    });

    test('audit entries survive deletion of their account', async () => {
        const user = await db.queryOne(
            `INSERT INTO users (username, password_hash, role, full_name)
             VALUES ('c.temp','x','hr','Temp') RETURNING id`
        );
        await db.execute(
            `INSERT INTO audit_log (user_id, username, action, details)
             VALUES ($1, 'c.temp', 'TEST_ACTION', 'must survive')`,
            [user.id]
        );

        await db.execute('DELETE FROM users WHERE id = $1', [user.id]);

        const row = await db.queryOne(
            `SELECT user_id, username, details FROM audit_log WHERE action = 'TEST_ACTION'`
        );
        assert.ok(row, 'the audit entry must still exist');
        assert.equal(row.userId, null, 'detached from the deleted account');
        assert.equal(row.username, 'c.temp', 'but the actor is still named');
    });
});
