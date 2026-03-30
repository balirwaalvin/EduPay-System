const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getDb } = require('../database');
const { authenticateToken, authorizeRoles, logAudit } = require('../middleware');
const { sendPasswordSetupEmail } = require('../services/email');

// Both HR and Admin roles can access these features based on user feedback
router.use(authenticateToken, authorizeRoles('hr', 'admin'));

// ============ TEACHER MANAGEMENT ============

router.get('/teachers', async (req, res) => {
    try {
        const db = getDb();
        const { rows } = await db.query(`
            SELECT t.*, u.username, u.is_active as account_active
            FROM teachers t LEFT JOIN users u ON t.user_id = u.id
            ORDER BY t.created_at DESC
        `);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch teachers.' }); }
});

router.post('/teachers', async (req, res) => {
    try {
        const {
            full_name, email, phone, position, salary_scale, date_joined,
            username: requestedUsername,
            payment_method, bank_name, bank_account_name, bank_account_number, mobile_money_provider, mobile_money_number
        } = req.body;
        if (!full_name || !salary_scale)
            return res.status(400).json({ error: 'Full name and salary scale are required.' });
        const db = getDb();
        // Use provided username or auto-generate from full name
        const baseUsername = (requestedUsername || full_name).toLowerCase().replace(/\s+/g, '.').replace(/[^a-z.]/g, '');
        let uniqueUsername = baseUsername;
        let counter = 1;
        while ((await db.query("SELECT id FROM users WHERE username = $1", [uniqueUsername])).rows.length) {
            if (requestedUsername) return res.status(409).json({ error: `Username "${requestedUsername}" is already taken.` });
            uniqueUsername = baseUsername + counter++;
        }
        const defaultPassword = bcrypt.hashSync('teacher123', 10);
        const { rows: [newUser] } = await db.query(
            `INSERT INTO users (username, password, role, full_name, email, phone, must_change_password)
             VALUES ($1,$2,'teacher',$3,$4,$5,1) RETURNING id`,
            [uniqueUsername, defaultPassword, full_name, email || '', phone || '']
        );
        const empId = 'TCH' + String(newUser.id).padStart(4, '0');
        const pm = payment_method || 'bank';
        await db.query(
            `INSERT INTO teachers
                (user_id, employee_id, full_name, email, phone, position, salary_scale, date_joined,
                 payment_method, bank_name, bank_account_name, bank_account_number, mobile_money_provider, mobile_money_number)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [newUser.id, empId, full_name, email || '', phone || '', position || '',
                salary_scale, date_joined || new Date().toISOString().split('T')[0],
                pm,
            pm === 'bank' ? (bank_name || '') : null,
            pm === 'bank' ? (bank_account_name || '') : null,
            pm === 'bank' ? (bank_account_number || '') : null,
            pm === 'mobile_money' ? (mobile_money_provider || '') : null,
            pm === 'mobile_money' ? (mobile_money_number || '') : null]
        );
        logAudit(db, req.user.id, req.user.username, 'CREATE_TEACHER', `Added teacher: ${full_name} (${empId})`, req.ip);
        res.status(201).json({
            message: 'Teacher added successfully.',
            teacher: { employee_id: empId, username: uniqueUsername, default_password: 'teacher123' }
        });
    } catch (err) {
        console.error('Create teacher error:', err);
        res.status(500).json({ error: 'Failed to add teacher.' });
    }
});

router.put('/teachers/:id', async (req, res) => {
    try {
        const {
            full_name, email, phone, position, salary_scale,
            payment_method, bank_name, bank_account_name, bank_account_number, mobile_money_provider, mobile_money_number
        } = req.body;
        const db = getDb();
        const pm = payment_method || null;
        await db.query(
            `UPDATE teachers SET
                full_name=COALESCE($1,full_name),
                email=COALESCE($2,email),
                phone=COALESCE($3,phone),
                position=COALESCE($4,position),
                salary_scale=COALESCE($5,salary_scale),
                payment_method=COALESCE($6,payment_method),
                bank_name=CASE WHEN $6='bank' THEN $7 WHEN $6='mobile_money' THEN NULL ELSE bank_name END,
                bank_account_name=CASE WHEN $6='bank' THEN $8 WHEN $6='mobile_money' THEN NULL ELSE bank_account_name END,
                bank_account_number=CASE WHEN $6='bank' THEN $9 WHEN $6='mobile_money' THEN NULL ELSE bank_account_number END,
                mobile_money_provider=CASE WHEN $6='mobile_money' THEN $10 WHEN $6='bank' THEN NULL ELSE mobile_money_provider END,
                mobile_money_number=CASE WHEN $6='mobile_money' THEN $11 WHEN $6='bank' THEN NULL ELSE mobile_money_number END,
                updated_at=NOW()
             WHERE id=$12`,
            [full_name || null, email || null, phone || null, position || null, salary_scale || null,
                pm, bank_name || null, bank_account_name || null, bank_account_number || null,
            mobile_money_provider || null, mobile_money_number || null, req.params.id]
        );
        const { rows: [teacher] } = await db.query("SELECT user_id FROM teachers WHERE id = $1", [req.params.id]);
        if (teacher && teacher.user_id) {
            await db.query(
                `UPDATE users SET
                    full_name=COALESCE($1,full_name), email=COALESCE($2,email), phone=COALESCE($3,phone), updated_at=NOW()
                 WHERE id=$4`,
                [full_name || null, email || null, phone || null, teacher.user_id]
            );
        }
        logAudit(db, req.user.id, req.user.username, 'UPDATE_TEACHER', `Updated teacher ID: ${req.params.id}`, req.ip);
        res.json({ message: 'Teacher updated successfully.' });
    } catch (err) { res.status(500).json({ error: 'Failed to update teacher.' }); }
});

router.delete('/teachers/:id', async (req, res) => {
    try {
        const db = getDb();
        const { rows: [teacher] } = await db.query("SELECT user_id FROM teachers WHERE id = $1", [req.params.id]);
        await db.query("DELETE FROM teachers WHERE id = $1", [req.params.id]);
        if (teacher && teacher.user_id) await db.query("DELETE FROM users WHERE id = $1", [teacher.user_id]);
        logAudit(db, req.user.id, req.user.username, 'DELETE_TEACHER', `Deleted teacher ID: ${req.params.id}`, req.ip);
        res.json({ message: 'Teacher removed successfully.' });
    } catch (err) { res.status(500).json({ error: 'Failed to delete teacher.' }); }
});

// ============ SALARY STRUCTURES ============

router.get('/salary-structures', async (req, res) => {
    try {
        const db = getDb();
        const { rows } = await db.query("SELECT * FROM salary_structures ORDER BY salary_scale");
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch salary structures.' }); }
});

router.post('/salary-structures', async (req, res) => {
    try {
        const {
            salary_scale, basic_salary, housing_allowance, transport_allowance,
            medical_allowance, other_allowance, tax_percentage, nssf_percentage,
            loan_deduction, other_deduction
        } = req.body;
        if (!salary_scale || basic_salary === undefined)
            return res.status(400).json({ error: 'Salary scale and basic salary are required.' });
        const db = getDb();
        await db.query(
            `INSERT INTO salary_structures (
                salary_scale, basic_salary, housing_allowance, transport_allowance,
                medical_allowance, other_allowance, tax_percentage, nssf_percentage,
                loan_deduction, other_deduction
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (salary_scale) DO UPDATE SET
                basic_salary=$2, housing_allowance=$3, transport_allowance=$4,
                medical_allowance=$5, other_allowance=$6, tax_percentage=$7,
                nssf_percentage=$8, loan_deduction=$9, other_deduction=$10, updated_at=NOW()`,
            [salary_scale, basic_salary, housing_allowance || 0, transport_allowance || 0,
                medical_allowance || 0, other_allowance || 0, tax_percentage || 0,
                nssf_percentage || 5, loan_deduction || 0, other_deduction || 0]
        );
        logAudit(db, req.user.id, req.user.username, 'UPDATE_SALARY_STRUCTURE', `Updated salary structure: ${salary_scale}`, req.ip);
        res.json({ message: 'Salary structure saved successfully.' });
    } catch (err) { res.status(500).json({ error: 'Failed to save salary structure.' }); }
});

router.delete('/salary-structures/:id', async (req, res) => {
    try {
        const db = getDb();
        await db.query("DELETE FROM salary_structures WHERE id = $1", [req.params.id]);
        res.json({ message: 'Salary structure deleted.' });
    } catch (err) { res.status(500).json({ error: 'Failed to delete salary structure.' }); }
});

// ============ LEAVE REQUESTS ============

router.get('/leave', async (req, res) => {
    try {
        const db = getDb();
        const { rows } = await db.query(`
            SELECT lr.*, t.full_name, t.employee_id
            FROM leave_requests lr
            JOIN teachers t ON lr.teacher_id = t.id
            ORDER BY lr.created_at DESC
        `);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch leave requests.' }); }
});

router.put('/leave/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        if (!['Approved', 'Rejected'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status.' });
        }
        const db = getDb();
        const id = parseInt(req.params.id);

        await db.query("UPDATE leave_requests SET status = $1, updated_at = NOW() WHERE id = $2", [status, id]);

        logAudit(db, req.user.id, req.user.username, 'UPDATE_LEAVE_STATUS', `Updated leave request ID ${id} to ${status}`, req.ip);
        res.json({ message: `Leave request ${status.toLowerCase()} successfully.` });
    } catch (err) { res.status(500).json({ error: 'Failed to update leave request status.' }); }
});

// ============ ADVANCE REQUESTS ============

router.get('/advances', async (req, res) => {
    try {
        const db = getDb();
        const { rows } = await db.query(`
            SELECT ar.*, t.full_name, t.employee_id, u.full_name as approved_by_name
            FROM advance_requests ar
            JOIN teachers t ON ar.teacher_id = t.id
            LEFT JOIN users u ON ar.approved_by = u.id
            ORDER BY ar.created_at DESC
        `);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch advance requests.' }); }
});

router.put('/advances/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        if (!['Approved', 'Rejected'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status.' });
        }

        const db = getDb();
        const id = parseInt(req.params.id);
        if (!Number.isInteger(id)) {
            return res.status(400).json({ error: 'Invalid advance request ID.' });
        }
        const { rows: [adv] } = await db.query(
            'SELECT id, teacher_id, amount, status FROM advance_requests WHERE id = $1',
            [id]
        );
        if (!adv) return res.status(404).json({ error: 'Advance request not found.' });
        if (adv.status === 'Deducted') return res.status(400).json({ error: 'Advance is already deducted and cannot be updated.' });

        await db.query(
            `UPDATE advance_requests
             SET status = $1,
                 approved_by = CASE WHEN $1='Approved' THEN $2::integer ELSE NULL::integer END,
                 approved_at = CASE WHEN $1='Approved' THEN NOW() ELSE NULL END,
                 updated_at = NOW()
             WHERE id = $3`,
            [status, parseInt(req.user.id, 10), id]
        );

        if (status === 'Approved') {
            const { rows: [teacher] } = await db.query('SELECT user_id FROM teachers WHERE id = $1', [adv.teacher_id]);
            if (teacher && teacher.user_id) {
                db.query(
                    "INSERT INTO notifications (user_id, title, message) VALUES ($1, $2, $3)",
                    [teacher.user_id, 'Advance Request Approved', `Your advance request of ${Number(adv.amount).toLocaleString()} has been approved and will be deducted from your salary.`]
                ).catch(() => { });
            }
        }

        if (status === 'Rejected') {
            const { rows: [teacher] } = await db.query('SELECT user_id FROM teachers WHERE id = $1', [adv.teacher_id]);
            if (teacher && teacher.user_id) {
                db.query(
                    "INSERT INTO notifications (user_id, title, message) VALUES ($1, $2, $3)",
                    [teacher.user_id, 'Advance Request Rejected', 'Your advance request has been rejected.']
                ).catch(() => { });
            }
        }

        logAudit(db, req.user.id, req.user.username, 'UPDATE_ADVANCE_STATUS', `Updated advance request ID ${id} to ${status}`, req.ip);
        res.json({ message: `Advance request ${status.toLowerCase()} successfully.` });
    } catch (err) {
        console.error('Update advance status error:', err);
        res.status(500).json({ error: `Failed to update advance request status. ${err.message || ''}`.trim() });
    }
});

// ============ PAYROLL APPROVAL ============

router.post('/payroll/:id/approve', async (req, res) => {
    try {
        if (req.user.role !== 'hr') {
            return res.status(403).json({ error: 'Only HR users can approve payroll.' });
        }

        const db = getDb();
        const payrollId = parseInt(req.params.id, 10);
        if (!Number.isInteger(payrollId)) {
            return res.status(400).json({ error: 'Invalid payroll ID.' });
        }

        const { rows: [payroll] } = await db.query(
            'SELECT id, status, month, year FROM payroll WHERE id = $1',
            [payrollId]
        );
        if (!payroll) return res.status(404).json({ error: 'Payroll not found.' });
        if (payroll.status !== 'processed') {
            return res.status(400).json({ error: 'Only processed payroll can be approved.' });
        }

        await db.query(
            "UPDATE payroll SET status = 'approved', approved_by = $1, updated_at = NOW() WHERE id = $2",
            [req.user.id, payrollId]
        );

        const { rows: teacherItems } = await db.query(`
            SELECT t.user_id, pi.net_salary
            FROM payroll_items pi
            JOIN teachers t ON pi.teacher_id = t.id
            WHERE pi.payroll_id = $1
        `, [payrollId]);

        for (const item of teacherItems) {
            if (item.user_id) {
                db.query(
                    'INSERT INTO notifications (user_id, title, message) VALUES ($1, $2, $3)',
                    [
                        item.user_id,
                        'Salary Processed',
                        `Your salary for ${payroll.month}/${payroll.year} has been approved. Net amount: ${Number(item.net_salary).toLocaleString()}`
                    ]
                ).catch(err => console.error('Notification insert error:', err));
            }
        }

        logAudit(db, req.user.id, req.user.username, 'APPROVE_PAYROLL', `Approved payroll ID: ${payrollId}`, req.ip);
        res.json({ message: 'Payroll approved successfully.' });
    } catch (err) {
        console.error('HR approve payroll error:', err);
        res.status(500).json({ error: 'Failed to approve payroll.' });
    }
});

// ============ REPORTS ============

router.get('/reports/payroll-summary', async (req, res) => {
    try {
        const db = getDb();
        const { rows } = await db.query(`
            SELECT p.*, (SELECT COUNT(*) FROM payroll_items WHERE payroll_id = p.id) as teacher_count
            FROM payroll p ORDER BY p.year DESC, p.month DESC
        `);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch payroll summary.' }); }
});

// ============ DASHBOARD STATS ============

router.get('/stats', async (req, res) => {
    try {
        const db = getDb();
        const [teachersR, payrollsR, recentR, pendingLeave, pendingAdvances] = await Promise.all([
            db.query("SELECT COUNT(*) as cnt FROM teachers WHERE is_active = 1"),
            db.query("SELECT COUNT(*) as cnt FROM payroll"),
            db.query("SELECT * FROM payroll ORDER BY created_at DESC LIMIT 1"),
            db.query("SELECT COUNT(*) as cnt FROM leave_requests WHERE status = 'Pending'"),
            db.query("SELECT COUNT(*) as cnt FROM advance_requests WHERE status = 'Pending'"),
        ]);
        res.json({
            total_teachers: parseInt(teachersR.rows[0].cnt) || 0,
            total_payrolls: parseInt(payrollsR.rows[0].cnt) || 0,
            recent_payroll: recentR.rows[0] || null,
            pending_leave: parseInt(pendingLeave.rows[0].cnt) || 0,
            pending_advances: parseInt(pendingAdvances.rows[0].cnt) || 0
        });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch hr stats.' }); }
});

module.exports = router;
