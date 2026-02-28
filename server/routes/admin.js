const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../database');
const { authenticateToken, authorizeRoles, logAudit } = require('../middleware');

// All admin routes require admin role
router.use(authenticateToken, authorizeRoles('admin'));

// ============ USER MANAGEMENT ============

router.get('/users', async (req, res) => {
    try {
        const db = getDb();
        const { rows } = await db.query("SELECT id, username, role, full_name, email, phone, is_active, created_at FROM users ORDER BY created_at DESC");
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch users.' }); }
});

router.post('/users', async (req, res) => {
    try {
        const { username, password, role, full_name, email, phone } = req.body;
        if (!username || !password || !role || !full_name)
            return res.status(400).json({ error: 'Username, password, role, and full name are required.' });
        const db = getDb();
        const { rows: ex } = await db.query("SELECT id FROM users WHERE username = $1", [username]);
        if (ex.length) return res.status(409).json({ error: 'Username already exists.' });
        const hashedPassword = bcrypt.hashSync(password, 10);
        const { rows: [newUser] } = await db.query(
            `INSERT INTO users (username, password, role, full_name, email, phone, must_change_password)
             VALUES ($1,$2,$3,$4,$5,$6,1) RETURNING id`,
            [username, hashedPassword, role, full_name, email || '', phone || '']
        );
        if (role === 'teacher') {
            const empId = 'TCH' + String(newUser.id).padStart(4, '0');
            await db.query(
                `INSERT INTO teachers (user_id, employee_id, full_name, email, phone, salary_scale)
                 VALUES ($1,$2,$3,$4,$5,'Scale_1')`,
                [newUser.id, empId, full_name, email || '', phone || '']
            );
        }
        logAudit(db, req.user.id, req.user.username, 'CREATE_USER', `Created user: ${username} (${role})`, req.ip);
        res.status(201).json({ message: 'User created successfully.', userId: newUser.id });
    } catch (err) {
        console.error('Create user error:', err);
        res.status(500).json({ error: 'Failed to create user.' });
    }
});

router.put('/users/:id', async (req, res) => {
    try {
        const { full_name, email, phone, role } = req.body;
        const id = parseInt(req.params.id);
        if (!full_name || !role) return res.status(400).json({ error: 'Full name and role are required.' });
        const db = getDb();
        const { rows } = await db.query("SELECT id FROM users WHERE id = $1", [id]);
        if (!rows.length) return res.status(404).json({ error: 'User not found.' });
        await db.query(
            "UPDATE users SET full_name=$1, email=$2, phone=$3, role=$4, updated_at=NOW() WHERE id=$5",
            [full_name, email || null, phone || null, role, id]
        );
        logAudit(db, req.user.id, req.user.username, 'UPDATE_USER', `Updated user ID: ${id}`, req.ip);
        res.json({ message: 'User updated successfully.' });
    } catch (err) {
        console.error('Update user error:', err);
        res.status(500).json({ error: 'Failed to update user.' });
    }
});

router.delete('/users/:id', async (req, res) => {
    try {
        const db = getDb();
        const id = parseInt(req.params.id);
        if (id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account.' });
        await db.query("DELETE FROM teachers WHERE user_id = $1", [id]);
        await db.query("DELETE FROM users WHERE id = $1", [id]);
        logAudit(db, req.user.id, req.user.username, 'DELETE_USER', `Deleted user ID: ${id}`, req.ip);
        res.json({ message: 'User deleted successfully.' });
    } catch (err) { res.status(500).json({ error: 'Failed to delete user.' }); }
});

router.post('/users/:id/reset-password', async (req, res) => {
    try {
        const { new_password } = req.body;
        if (!new_password || new_password.length < 6)
            return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        const db = getDb();
        const hashed = bcrypt.hashSync(new_password, 10);
        await db.query(
            "UPDATE users SET password=$1, must_change_password=1, updated_at=NOW() WHERE id=$2",
            [hashed, req.params.id]
        );
        logAudit(db, req.user.id, req.user.username, 'RESET_PASSWORD', `Reset password for user ID: ${req.params.id}`, req.ip);
        res.json({ message: 'Password reset successfully.' });
    } catch (err) { res.status(500).json({ error: 'Failed to reset password.' }); }
});

router.post('/users/:id/toggle-status', async (req, res) => {
    try {
        const db = getDb();
        const id = parseInt(req.params.id);
        if (id === req.user.id) return res.status(400).json({ error: 'Cannot deactivate your own account.' });
        const { rows } = await db.query("SELECT is_active FROM users WHERE id = $1", [id]);
        if (!rows.length) return res.status(404).json({ error: 'User not found.' });
        const newStatus = rows[0].is_active ? 0 : 1;
        await db.query("UPDATE users SET is_active=$1, updated_at=NOW() WHERE id=$2", [newStatus, id]);
        logAudit(db, req.user.id, req.user.username, 'TOGGLE_USER_STATUS',
            `${newStatus ? 'Activated' : 'Deactivated'} user ID: ${id}`, req.ip);
        res.json({ message: `User ${newStatus ? 'activated' : 'deactivated'} successfully.`, is_active: newStatus });
    } catch (err) { res.status(500).json({ error: 'Failed to toggle user status.' }); }
});

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
        const { full_name, email, phone, position, salary_scale, date_joined, username: requestedUsername } = req.body;
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
        await db.query(
            `INSERT INTO teachers (user_id, employee_id, full_name, email, phone, position, salary_scale, date_joined)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [newUser.id, empId, full_name, email || '', phone || '', position || '',
             salary_scale, date_joined || new Date().toISOString().split('T')[0]]
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
        const { full_name, email, phone, position, salary_scale } = req.body;
        const db = getDb();
        await db.query(
            `UPDATE teachers SET
                full_name=COALESCE($1,full_name), email=COALESCE($2,email), phone=COALESCE($3,phone),
                position=COALESCE($4,position), salary_scale=COALESCE($5,salary_scale), updated_at=NOW()
             WHERE id=$6`,
            [full_name || null, email || null, phone || null, position || null, salary_scale || null, req.params.id]
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

// ============ ACCOUNTANT MANAGEMENT ============

router.get('/accountants', async (req, res) => {
    try {
        const db = getDb();
        const { rows } = await db.query(`
            SELECT a.*, u.username, u.is_active as account_active
            FROM accountants a LEFT JOIN users u ON a.user_id = u.id
            ORDER BY a.created_at DESC
        `);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch accountants.' }); }
});

router.post('/accountants', async (req, res) => {
    try {
        const { full_name, email, phone, department, date_joined, username: requestedUsername } = req.body;
        if (!full_name) return res.status(400).json({ error: 'Full name is required.' });
        const db = getDb();
        // Use provided username or auto-generate from full name
        const baseUsername = (requestedUsername || full_name).toLowerCase().replace(/\s+/g, '.').replace(/[^a-z.]/g, '');
        let uniqueUsername = baseUsername;
        let counter = 1;
        while ((await db.query("SELECT id FROM users WHERE username = $1", [uniqueUsername])).rows.length) {
            if (requestedUsername) return res.status(409).json({ error: `Username "${requestedUsername}" is already taken.` });
            uniqueUsername = baseUsername + counter++;
        }
        const defaultPassword = bcrypt.hashSync('accountant123', 10);
        const { rows: [newUser] } = await db.query(
            `INSERT INTO users (username, password, role, full_name, email, phone, must_change_password)
             VALUES ($1,$2,'accountant',$3,$4,$5,1) RETURNING id`,
            [uniqueUsername, defaultPassword, full_name, email || '', phone || '']
        );
        const empId = 'ACC' + String(newUser.id).padStart(4, '0');
        await db.query(
            `INSERT INTO accountants (user_id, employee_id, full_name, email, phone, department, date_joined)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [newUser.id, empId, full_name, email || '', phone || '', department || '', date_joined || new Date().toISOString().split('T')[0]]
        );
        logAudit(db, req.user.id, req.user.username, 'CREATE_ACCOUNTANT', `Added accountant: ${full_name} (${empId})`, req.ip);
        res.status(201).json({
            message: 'Accountant added successfully.',
            accountant: { employee_id: empId, username: uniqueUsername, default_password: 'accountant123' }
        });
    } catch (err) {
        console.error('Create accountant error:', err);
        res.status(500).json({ error: 'Failed to add accountant.' });
    }
});

router.put('/accountants/:id', async (req, res) => {
    try {
        const { full_name, email, phone, department } = req.body;
        const db = getDb();
        await db.query(
            `UPDATE accountants SET
                full_name=COALESCE($1,full_name), email=COALESCE($2,email), phone=COALESCE($3,phone),
                department=COALESCE($4,department), updated_at=NOW()
             WHERE id=$5`,
            [full_name || null, email || null, phone || null, department || null, req.params.id]
        );
        const { rows: [acc] } = await db.query("SELECT user_id FROM accountants WHERE id = $1", [req.params.id]);
        if (acc && acc.user_id) {
            await db.query(
                "UPDATE users SET full_name=COALESCE($1,full_name), email=COALESCE($2,email), phone=COALESCE($3,phone), updated_at=NOW() WHERE id=$4",
                [full_name || null, email || null, phone || null, acc.user_id]
            );
        }
        logAudit(db, req.user.id, req.user.username, 'UPDATE_ACCOUNTANT', `Updated accountant ID: ${req.params.id}`, req.ip);
        res.json({ message: 'Accountant updated successfully.' });
    } catch (err) { res.status(500).json({ error: 'Failed to update accountant.' }); }
});

router.delete('/accountants/:id', async (req, res) => {
    try {
        const db = getDb();
        const { rows: [acc] } = await db.query("SELECT user_id FROM accountants WHERE id = $1", [req.params.id]);
        await db.query("DELETE FROM accountants WHERE id = $1", [req.params.id]);
        if (acc && acc.user_id) await db.query("DELETE FROM users WHERE id = $1", [acc.user_id]);
        logAudit(db, req.user.id, req.user.username, 'DELETE_ACCOUNTANT', `Deleted accountant ID: ${req.params.id}`, req.ip);
        res.json({ message: 'Accountant removed successfully.' });
    } catch (err) { res.status(500).json({ error: 'Failed to delete accountant.' }); }
});

// ============ ADMIN MANAGEMENT ============

router.get('/admins', async (req, res) => {
    try {
        const db = getDb();
        const { rows } = await db.query(
            "SELECT id, username, full_name, email, phone, is_active, created_at FROM users WHERE role='admin' ORDER BY created_at DESC"
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch admins.' }); }
});

router.post('/admins', async (req, res) => {
    try {
        const { full_name, username, email, phone, password: customPassword } = req.body;
        if (!full_name || !username) return res.status(400).json({ error: 'Full name and username are required.' });
        const db = getDb();
        const { rows: ex } = await db.query("SELECT id FROM users WHERE username = $1", [username]);
        if (ex.length) return res.status(409).json({ error: `Username "${username}" is already taken.` });
        const hashedPassword = bcrypt.hashSync(customPassword || 'admin123', 10);
        const { rows: [newUser] } = await db.query(
            `INSERT INTO users (username, password, role, full_name, email, phone, must_change_password)
             VALUES ($1,$2,'admin',$3,$4,$5,1) RETURNING id, username`,
            [username, hashedPassword, full_name, email || '', phone || '']
        );
        logAudit(db, req.user.id, req.user.username, 'CREATE_ADMIN', `Created admin: ${username}`, req.ip);
        res.status(201).json({
            message: 'Admin created successfully.',
            admin: { id: newUser.id, username: newUser.username, default_password: customPassword || 'admin123' }
        });
    } catch (err) {
        console.error('Create admin error:', err);
        res.status(500).json({ error: 'Failed to create admin.' });
    }
});

router.put('/admins/:id', async (req, res) => {
    try {
        const { full_name, email, phone } = req.body;
        const db = getDb();
        await db.query(
            "UPDATE users SET full_name=COALESCE($1,full_name), email=COALESCE($2,email), phone=COALESCE($3,phone), updated_at=NOW() WHERE id=$4 AND role='admin'",
            [full_name || null, email || null, phone || null, req.params.id]
        );
        logAudit(db, req.user.id, req.user.username, 'UPDATE_ADMIN', `Updated admin ID: ${req.params.id}`, req.ip);
        res.json({ message: 'Admin updated successfully.' });
    } catch (err) { res.status(500).json({ error: 'Failed to update admin.' }); }
});

router.delete('/admins/:id', async (req, res) => {
    try {
        if (parseInt(req.params.id) === req.user.id)
            return res.status(400).json({ error: 'You cannot delete your own admin account.' });
        const db = getDb();
        await db.query("DELETE FROM users WHERE id=$1 AND role='admin'", [req.params.id]);
        logAudit(db, req.user.id, req.user.username, 'DELETE_ADMIN', `Deleted admin ID: ${req.params.id}`, req.ip);
        res.json({ message: 'Admin removed successfully.' });
    } catch (err) { res.status(500).json({ error: 'Failed to delete admin.' }); }
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
            [salary_scale, basic_salary, housing_allowance||0, transport_allowance||0,
             medical_allowance||0, other_allowance||0, tax_percentage||0,
             nssf_percentage||5, loan_deduction||0, other_deduction||0]
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

// ============ SYSTEM CONFIG ============

router.get('/config', async (req, res) => {
    try {
        const db = getDb();
        const { rows } = await db.query("SELECT * FROM system_config");
        const configMap = {};
        rows.forEach(c => { configMap[c.config_key] = c.config_value; });
        res.json(configMap);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch config.' }); }
});

router.put('/config', async (req, res) => {
    try {
        const db = getDb();
        for (const [key, value] of Object.entries(req.body)) {
            await db.query(
                `INSERT INTO system_config (config_key, config_value) VALUES ($1,$2)
                 ON CONFLICT (config_key) DO UPDATE SET config_value=$2, updated_at=NOW()`,
                [key, value]
            );
        }
        logAudit(db, req.user.id, req.user.username, 'UPDATE_CONFIG', 'System configuration updated', req.ip);
        res.json({ message: 'Configuration updated successfully.' });
    } catch (err) { res.status(500).json({ error: 'Failed to update config.' }); }
});

// ============ AUDIT LOG ============

router.get('/audit-log', async (req, res) => {
    try {
        const db = getDb();
        const { rows } = await db.query("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200");
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch audit log.' }); }
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

// ============ BACKUP ============
// Exports all data as JSON (DigitalOcean Managed PostgreSQL has automated daily backups built-in)

router.get('/backup', async (req, res) => {
    try {
        const db = getDb();
        const [u, t, p, pi, ss, sc] = await Promise.all([
            db.query("SELECT id, username, role, full_name, email, phone, is_active, created_at FROM users"),
            db.query("SELECT * FROM teachers"),
            db.query("SELECT * FROM payroll"),
            db.query("SELECT * FROM payroll_items"),
            db.query("SELECT * FROM salary_structures"),
            db.query("SELECT * FROM system_config"),
        ]);
        const backup = {
            exported_at: new Date().toISOString(),
            users: u.rows, teachers: t.rows, payrolls: p.rows,
            payroll_items: pi.rows, salary_structures: ss.rows, system_config: sc.rows,
        };
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=edupay_backup_${new Date().toISOString().split('T')[0]}.json`);
        logAudit(db, req.user.id, req.user.username, 'BACKUP', 'Data backup downloaded', req.ip);
        res.json(backup);
    } catch (err) { res.status(500).json({ error: 'Failed to create backup.' }); }
});

// ============ DASHBOARD STATS ============

router.get('/stats', async (req, res) => {
    try {
        const db = getDb();
        const [usersR, teachersR, payrollsR, recentR] = await Promise.all([
            db.query("SELECT COUNT(*) as cnt FROM users"),
            db.query("SELECT COUNT(*) as cnt FROM teachers WHERE is_active = true"),
            db.query("SELECT COUNT(*) as cnt FROM payroll"),
            db.query("SELECT * FROM payroll ORDER BY created_at DESC LIMIT 1"),
        ]);
        res.json({
            total_users:    parseInt(usersR.rows[0].cnt)    || 0,
            total_teachers: parseInt(teachersR.rows[0].cnt) || 0,
            total_payrolls: parseInt(payrollsR.rows[0].cnt) || 0,
            recent_payroll: recentR.rows[0] || null,
        });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch stats.' }); }
});

module.exports = router;

