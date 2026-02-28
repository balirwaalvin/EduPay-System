const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const fs = require('fs');
const { getDb, DB_PATH } = require('../database');
const { authenticateToken, authorizeRoles, logAudit } = require('../middleware');

// All admin routes require admin role
router.use(authenticateToken, authorizeRoles('admin'));

// ============ USER MANAGEMENT ============

// GET /api/admin/users
router.get('/users', (req, res) => {
    try {
        const db = getDb();
        const users = db.prepare("SELECT id, username, role, full_name, email, phone, is_active, created_at FROM users ORDER BY created_at DESC").all();
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch users.' });
    }
});

// POST /api/admin/users
router.post('/users', (req, res) => {
    try {
        const { username, password, role, full_name, email, phone } = req.body;
        if (!username || !password || !role || !full_name) {
            return res.status(400).json({ error: 'Username, password, role, and full name are required.' });
        }
        const db = getDb();
        const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
        if (existing) {
            return res.status(409).json({ error: 'Username already exists.' });
        }
        const hashedPassword = bcrypt.hashSync(password, 10);
        const { lastInsertRowid: userId } = db.prepare(
            `INSERT INTO users (username, password, role, full_name, email, phone, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1)`
        ).run(username, hashedPassword, role, full_name, email || '', phone || '');

        // If role is teacher, also create a teacher record
        if (role === 'teacher') {
            const empId = 'TCH' + String(userId).padStart(4, '0');
            db.prepare(
                `INSERT INTO teachers (user_id, employee_id, full_name, email, phone, salary_scale) VALUES (?, ?, ?, ?, ?, 'Scale_1')`
            ).run(userId, empId, full_name, email || '', phone || '');
        }

        logAudit(db, req.user.id, req.user.username, 'CREATE_USER',
            `Created user: ${username} (${role})`, req.ip);

        res.status(201).json({ message: 'User created successfully.', userId });
    } catch (err) {
        console.error('Create user error:', err);
        res.status(500).json({ error: 'Failed to create user.' });
    }
});

// PUT /api/admin/users/:id
router.put('/users/:id', (req, res) => {
    try {
        const { full_name, email, phone, role } = req.body;
        const id = parseInt(req.params.id);

        if (!full_name || !role) {
            return res.status(400).json({ error: 'Full name and role are required.' });
        }

        const db = getDb();
        const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
        if (!existing) {
            return res.status(404).json({ error: 'User not found.' });
        }

        db.prepare(
            `UPDATE users SET full_name = ?, email = ?, phone = ?, role = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(full_name, email || null, phone || null, role, id);

        logAudit(db, req.user.id, req.user.username, 'UPDATE_USER',
            `Updated user ID: ${id}`, req.ip);
        res.json({ message: 'User updated successfully.' });
    } catch (err) {
        console.error('Update user error:', err);
        res.status(500).json({ error: 'Failed to update user.' });
    }
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', (req, res) => {
    try {
        const db = getDb();
        const id = parseInt(req.params.id);
        if (id === req.user.id) {
            return res.status(400).json({ error: 'Cannot delete your own account.' });
        }
        db.prepare("DELETE FROM users WHERE id = ?").run(id);
        db.prepare("DELETE FROM teachers WHERE user_id = ?").run(id);
        logAudit(db, req.user.id, req.user.username, 'DELETE_USER',
            `Deleted user ID: ${id}`, req.ip);
        res.json({ message: 'User deleted successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete user.' });
    }
});

// POST /api/admin/users/:id/reset-password
router.post('/users/:id/reset-password', (req, res) => {
    try {
        const { new_password } = req.body;
        if (!new_password || new_password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        }
        const db = getDb();
        const hashed = bcrypt.hashSync(new_password, 10);
        db.prepare("UPDATE users SET password = ?, must_change_password = 1, updated_at = datetime('now') WHERE id = ?")
          .run(hashed, req.params.id);
        logAudit(db, req.user.id, req.user.username, 'RESET_PASSWORD',
            `Reset password for user ID: ${req.params.id}`, req.ip);
        res.json({ message: 'Password reset successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to reset password.' });
    }
});

// POST /api/admin/users/:id/toggle-status
router.post('/users/:id/toggle-status', (req, res) => {
    try {
        const db = getDb();
        const id = parseInt(req.params.id);
        if (id === req.user.id) {
            return res.status(400).json({ error: 'Cannot deactivate your own account.' });
        }
        const user = db.prepare("SELECT is_active FROM users WHERE id = ?").get(id);
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }
        const newStatus = user.is_active ? 0 : 1;
        db.prepare("UPDATE users SET is_active = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, id);
        logAudit(db, req.user.id, req.user.username, 'TOGGLE_USER_STATUS',
            `${newStatus ? 'Activated' : 'Deactivated'} user ID: ${id}`, req.ip);
        res.json({ message: `User ${newStatus ? 'activated' : 'deactivated'} successfully.`, is_active: newStatus });
    } catch (err) {
        res.status(500).json({ error: 'Failed to toggle user status.' });
    }
});

// ============ TEACHER MANAGEMENT ============

// GET /api/admin/teachers
router.get('/teachers', (req, res) => {
    try {
        const db = getDb();
        const teachers = db.prepare(`
      SELECT t.*, u.username, u.is_active as account_active
      FROM teachers t
      LEFT JOIN users u ON t.user_id = u.id
      ORDER BY t.created_at DESC
    `).all();
        res.json(teachers);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch teachers.' });
    }
});

// POST /api/admin/teachers
router.post('/teachers', (req, res) => {
    try {
        const { full_name, email, phone, position, salary_scale, date_joined } = req.body;
        if (!full_name || !salary_scale) {
            return res.status(400).json({ error: 'Full name and salary scale are required.' });
        }
        const db = getDb();

        // Generate unique username from full name
        const baseUsername = full_name.toLowerCase().replace(/\s+/g, '.').replace(/[^a-z.]/g, '');
        let uniqueUsername = baseUsername;
        let counter = 1;
        while (db.prepare("SELECT id FROM users WHERE username = ?").get(uniqueUsername)) {
            uniqueUsername = baseUsername + counter++;
        }

        const defaultPassword = bcrypt.hashSync('teacher123', 10);
        const { lastInsertRowid: userId } = db.prepare(
            `INSERT INTO users (username, password, role, full_name, email, phone, must_change_password) VALUES (?, ?, 'teacher', ?, ?, ?, 1)`
        ).run(uniqueUsername, defaultPassword, full_name, email || '', phone || '');

        const empId = 'TCH' + String(userId).padStart(4, '0');
        db.prepare(
            `INSERT INTO teachers (user_id, employee_id, full_name, email, phone, position, salary_scale, date_joined) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(userId, empId, full_name, email || '', phone || '', position || '', salary_scale, date_joined || new Date().toISOString().split('T')[0]);

        logAudit(db, req.user.id, req.user.username, 'CREATE_TEACHER',
            `Added teacher: ${full_name} (${empId})`, req.ip);

        res.status(201).json({
            message: 'Teacher added successfully.',
            teacher: { employee_id: empId, username: uniqueUsername, default_password: 'teacher123' }
        });
    } catch (err) {
        console.error('Create teacher error:', err);
        res.status(500).json({ error: 'Failed to add teacher.' });
    }
});

// PUT /api/admin/teachers/:id
router.put('/teachers/:id', (req, res) => {
    try {
        const { full_name, email, phone, position, salary_scale } = req.body;
        const db = getDb();
        db.prepare(
            `UPDATE teachers SET full_name = COALESCE(?, full_name), email = COALESCE(?, email), phone = COALESCE(?, phone), position = COALESCE(?, position), salary_scale = COALESCE(?, salary_scale), updated_at = datetime('now') WHERE id = ?`
        ).run(full_name || null, email || null, phone || null, position || null, salary_scale || null, req.params.id);

        // Also update linked user record
        const teacher = db.prepare("SELECT user_id FROM teachers WHERE id = ?").get(req.params.id);
        if (teacher && teacher.user_id) {
            db.prepare(
                `UPDATE users SET full_name = COALESCE(?, full_name), email = COALESCE(?, email), phone = COALESCE(?, phone), updated_at = datetime('now') WHERE id = ?`
            ).run(full_name || null, email || null, phone || null, teacher.user_id);
        }
        logAudit(db, req.user.id, req.user.username, 'UPDATE_TEACHER',
            `Updated teacher ID: ${req.params.id}`, req.ip);
        res.json({ message: 'Teacher updated successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update teacher.' });
    }
});

// DELETE /api/admin/teachers/:id
router.delete('/teachers/:id', (req, res) => {
    try {
        const db = getDb();
        const teacher = db.prepare("SELECT user_id FROM teachers WHERE id = ?").get(req.params.id);
        db.prepare("DELETE FROM teachers WHERE id = ?").run(req.params.id);
        if (teacher && teacher.user_id) {
            db.prepare("DELETE FROM users WHERE id = ?").run(teacher.user_id);
        }
        logAudit(db, req.user.id, req.user.username, 'DELETE_TEACHER',
            `Deleted teacher ID: ${req.params.id}`, req.ip);
        res.json({ message: 'Teacher removed successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete teacher.' });
    }
});

// ============ SALARY STRUCTURE ============

// GET /api/admin/salary-structures
router.get('/salary-structures', (req, res) => {
    try {
        const db = getDb();
        res.json(db.prepare("SELECT * FROM salary_structures ORDER BY salary_scale").all());
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch salary structures.' });
    }
});

// POST /api/admin/salary-structures
router.post('/salary-structures', (req, res) => {
    try {
        const { salary_scale, basic_salary, housing_allowance, transport_allowance, medical_allowance, other_allowance, tax_percentage, nssf_percentage, loan_deduction, other_deduction } = req.body;
        if (!salary_scale || basic_salary === undefined) {
            return res.status(400).json({ error: 'Salary scale and basic salary are required.' });
        }
        const db = getDb();
        const existing = db.prepare("SELECT id FROM salary_structures WHERE salary_scale = ?").get(salary_scale);
        if (existing) {
            db.prepare(
                `UPDATE salary_structures SET basic_salary=?, housing_allowance=?, transport_allowance=?, medical_allowance=?, other_allowance=?, tax_percentage=?, nssf_percentage=?, loan_deduction=?, other_deduction=?, updated_at=datetime('now') WHERE salary_scale=?`
            ).run(basic_salary, housing_allowance || 0, transport_allowance || 0, medical_allowance || 0, other_allowance || 0, tax_percentage || 0, nssf_percentage || 5, loan_deduction || 0, other_deduction || 0, salary_scale);
        } else {
            db.prepare(
                `INSERT INTO salary_structures (salary_scale, basic_salary, housing_allowance, transport_allowance, medical_allowance, other_allowance, tax_percentage, nssf_percentage, loan_deduction, other_deduction) VALUES (?,?,?,?,?,?,?,?,?,?)`
            ).run(salary_scale, basic_salary, housing_allowance || 0, transport_allowance || 0, medical_allowance || 0, other_allowance || 0, tax_percentage || 0, nssf_percentage || 5, loan_deduction || 0, other_deduction || 0);
        }
        logAudit(db, req.user.id, req.user.username, 'UPDATE_SALARY_STRUCTURE',
            `Updated salary structure: ${salary_scale}`, req.ip);
        res.json({ message: 'Salary structure saved successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save salary structure.' });
    }
});

// DELETE /api/admin/salary-structures/:id
router.delete('/salary-structures/:id', (req, res) => {
    try {
        const db = getDb();
        db.prepare("DELETE FROM salary_structures WHERE id = ?").run(req.params.id);
        res.json({ message: 'Salary structure deleted.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete salary structure.' });
    }
});

// ============ SYSTEM CONFIG ============

// GET /api/admin/config
router.get('/config', (req, res) => {
    try {
        const db = getDb();
        const configs = db.prepare("SELECT * FROM system_config").all();
        const configMap = {};
        configs.forEach(c => { configMap[c.config_key] = c.config_value; });
        res.json(configMap);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch config.' });
    }
});

// PUT /api/admin/config
router.put('/config', (req, res) => {
    try {
        const db = getDb();
        const configs = req.body;
        for (const [key, value] of Object.entries(configs)) {
            const existing = db.prepare("SELECT id FROM system_config WHERE config_key = ?").get(key);
            if (existing) {
                db.prepare("UPDATE system_config SET config_value = ?, updated_at = datetime('now') WHERE config_key = ?").run(value, key);
            } else {
                db.prepare("INSERT INTO system_config (config_key, config_value) VALUES (?, ?)").run(key, value);
            }
        }
        logAudit(db, req.user.id, req.user.username, 'UPDATE_CONFIG', 'System configuration updated', req.ip);
        res.json({ message: 'Configuration updated successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update config.' });
    }
});

// ============ AUDIT LOG ============

// GET /api/admin/audit-log
router.get('/audit-log', (req, res) => {
    try {
        const db = getDb();
        res.json(db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200").all());
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch audit log.' });
    }
});

// ============ REPORTS ============

// GET /api/admin/reports/payroll-summary
router.get('/reports/payroll-summary', (req, res) => {
    try {
        const db = getDb();
        const rows = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM payroll_items WHERE payroll_id = p.id) as teacher_count
      FROM payroll p
      ORDER BY p.year DESC, p.month DESC
    `).all();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch payroll summary.' });
    }
});

// ============ BACKUP & RESTORE ============

// GET /api/admin/backup
router.get('/backup', (req, res) => {
    try {
        const db = getDb();
        const buffer = db.serialize();
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', 'attachment; filename=edupay_backup.db');
        logAudit(db, req.user.id, req.user.username, 'BACKUP', 'Database backup downloaded', req.ip);
        res.send(buffer);
    } catch (err) {
        res.status(500).json({ error: 'Failed to create backup.' });
    }
});

// ============ DASHBOARD STATS ============

// GET /api/admin/stats
router.get('/stats', (req, res) => {
    try {
        const db = getDb();
        const totalUsers = db.prepare("SELECT COUNT(*) as cnt FROM users").get().cnt;
        const totalTeachers = db.prepare("SELECT COUNT(*) as cnt FROM teachers WHERE is_active = 1").get().cnt;
        const totalPayrolls = db.prepare("SELECT COUNT(*) as cnt FROM payroll").get().cnt;
        const recentPayroll = db.prepare("SELECT * FROM payroll ORDER BY created_at DESC LIMIT 1").get() || null;

        res.json({
            total_users: totalUsers || 0,
            total_teachers: totalTeachers || 0,
            total_payrolls: totalPayrolls || 0,
            recent_payroll: recentPayroll
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch stats.' });
    }
});

module.exports = router;
