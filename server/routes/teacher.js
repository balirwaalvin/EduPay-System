const express = require('express');
const router = express.Router();
const { getDb, saveDatabase } = require('../database');
const { authenticateToken, authorizeRoles, logAudit } = require('../middleware');
const PDFDocument = require('pdfkit');

// All teacher routes require teacher role
router.use(authenticateToken, authorizeRoles('teacher'));

// Helper
function resultToArray(result) {
    if (!result || result.length === 0) return [];
    const columns = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        columns.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

// GET /api/teacher/profile
router.get('/profile', (req, res) => {
    try {
        const db = getDb();
        const result = db.exec(`
      SELECT t.*, s.basic_salary, s.housing_allowance, s.transport_allowance, s.medical_allowance,
             s.other_allowance, s.tax_percentage, s.nssf_percentage
      FROM teachers t
      LEFT JOIN salary_structures s ON t.salary_scale = s.salary_scale
      WHERE t.user_id = ?
    `, [req.user.id]);
        if (!result.length || !result[0].values.length) {
            return res.status(404).json({ error: 'Teacher profile not found.' });
        }
        res.json(resultToArray(result)[0]);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch profile.' });
    }
});

// PUT /api/teacher/profile
router.put('/profile', (req, res) => {
    try {
        const { phone, email } = req.body;
        const db = getDb();
        db.run(
            "UPDATE teachers SET phone = COALESCE(?, phone), email = COALESCE(?, email), updated_at = datetime('now') WHERE user_id = ?",
            [phone, email, req.user.id]
        );
        db.run(
            "UPDATE users SET phone = COALESCE(?, phone), email = COALESCE(?, email), updated_at = datetime('now') WHERE id = ?",
            [phone, email, req.user.id]
        );
        saveDatabase();
        res.json({ message: 'Profile updated successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update profile.' });
    }
});

// GET /api/teacher/payslips
router.get('/payslips', (req, res) => {
    try {
        const db = getDb();
        const teacher = db.exec("SELECT id FROM teachers WHERE user_id = ?", [req.user.id]);
        if (!teacher.length || !teacher[0].values.length) {
            return res.status(404).json({ error: 'Teacher not found.' });
        }
        const teacherId = teacher[0].values[0][0];
        const result = db.exec(`
      SELECT pi.*, p.month, p.year, p.status as payroll_status
      FROM payroll_items pi
      JOIN payroll p ON pi.payroll_id = p.id
      WHERE pi.teacher_id = ? AND p.status IN ('approved', 'paid')
      ORDER BY p.year DESC, p.month DESC
    `, [teacherId]);
        res.json(resultToArray(result));
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch payslips.' });
    }
});

// GET /api/teacher/payslip/:id/pdf
router.get('/payslip/:id/pdf', (req, res) => {
    try {
        const db = getDb();
        const teacher = db.exec("SELECT id FROM teachers WHERE user_id = ?", [req.user.id]);
        if (!teacher.length || !teacher[0].values.length) {
            return res.status(404).json({ error: 'Teacher not found.' });
        }
        const teacherId = teacher[0].values[0][0];

        const result = db.exec(`
      SELECT pi.*, t.full_name, t.employee_id, t.position, t.salary_scale, p.month, p.year
      FROM payroll_items pi
      JOIN teachers t ON pi.teacher_id = t.id
      JOIN payroll p ON pi.payroll_id = p.id
      WHERE pi.id = ? AND pi.teacher_id = ?
    `, [req.params.id, teacherId]);

        if (!result.length || !result[0].values.length) {
            return res.status(404).json({ error: 'Payslip not found.' });
        }

        const item = resultToArray(result)[0];
        const configResult = db.exec("SELECT config_key, config_value FROM system_config");
        const configs = {};
        if (configResult.length > 0) {
            resultToArray(configResult).forEach(c => { configs[c.config_key] = c.config_value; });
        }
        const schoolName = configs.school_name || 'EduPay School';
        const currency = configs.currency || 'UGX';

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=payslip_${item.month}_${item.year}.pdf`);
        doc.pipe(res);

        // Payslip header
        doc.rect(0, 0, 595, 80).fill('#DC2626');
        doc.fontSize(24).fillColor('#FFF').text(schoolName, 50, 20);
        doc.fontSize(12).text('PAYSLIP', 50, 50);

        doc.moveDown(2);
        doc.fillColor('#000');

        const infoY = 100;
        doc.fontSize(10);
        doc.text(`Employee Name: ${item.full_name}`, 50, infoY);
        doc.text(`Employee ID: ${item.employee_id}`, 50, infoY + 18);
        doc.text(`Position: ${item.position || 'N/A'}`, 50, infoY + 36);
        doc.text(`Salary Scale: ${item.salary_scale}`, 350, infoY);
        doc.text(`Pay Period: ${item.month}/${item.year}`, 350, infoY + 18);
        doc.text(`Payment Status: ${item.payment_status}`, 350, infoY + 36);

        let tableY = infoY + 70;

        doc.fontSize(12).fillColor('#DC2626').text('EARNINGS', 50, tableY);
        tableY += 20;
        doc.fontSize(9).fillColor('#000');

        const earnings = [
            ['Basic Salary', item.basic_salary],
            ['Housing Allowance', item.housing_allowance],
            ['Transport Allowance', item.transport_allowance],
            ['Medical Allowance', item.medical_allowance],
            ['Other Allowance', item.other_allowance],
        ];

        earnings.forEach(([label, val]) => {
            doc.text(label, 60, tableY);
            doc.text(`${currency} ${Number(val).toLocaleString()}`, 350, tableY, { width: 150, align: 'right' });
            tableY += 16;
        });

        doc.rect(50, tableY, 460, 0.5).fill('#CCC');
        tableY += 5;
        doc.fontSize(10).font('Helvetica-Bold');
        doc.text('Gross Salary', 60, tableY);
        doc.text(`${currency} ${Number(item.gross_salary).toLocaleString()}`, 350, tableY, { width: 150, align: 'right' });
        tableY += 25;

        doc.fontSize(12).fillColor('#DC2626').font('Helvetica').text('DEDUCTIONS', 50, tableY);
        tableY += 20;
        doc.fontSize(9).fillColor('#000');

        const deductions = [
            ['PAYE Tax', item.tax_amount],
            ['NSSF', item.nssf_amount],
            ['Loan Deduction', item.loan_deduction],
            ['Other Deductions', item.other_deduction],
        ];

        deductions.forEach(([label, val]) => {
            doc.text(label, 60, tableY);
            doc.text(`${currency} ${Number(val).toLocaleString()}`, 350, tableY, { width: 150, align: 'right' });
            tableY += 16;
        });

        doc.rect(50, tableY, 460, 0.5).fill('#CCC');
        tableY += 5;
        doc.fontSize(10).font('Helvetica-Bold');
        doc.text('Total Deductions', 60, tableY);
        doc.text(`${currency} ${Number(item.total_deductions).toLocaleString()}`, 350, tableY, { width: 150, align: 'right' });
        tableY += 30;

        doc.rect(50, tableY, 460, 35).fill('#F0F0F0');
        doc.fontSize(14).fillColor('#DC2626').font('Helvetica-Bold');
        doc.text('NET SALARY', 60, tableY + 8);
        doc.text(`${currency} ${Number(item.net_salary).toLocaleString()}`, 350, tableY + 8, { width: 150, align: 'right' });

        doc.fontSize(8).fillColor('#999').font('Helvetica').text(
            'This is a computer-generated payslip. No signature required.',
            50, 750, { align: 'center' }
        );

        doc.end();
    } catch (err) {
        console.error('Payslip PDF error:', err);
        res.status(500).json({ error: 'Failed to generate payslip.' });
    }
});

// GET /api/teacher/salary-history
router.get('/salary-history', (req, res) => {
    try {
        const db = getDb();
        const teacher = db.exec("SELECT id FROM teachers WHERE user_id = ?", [req.user.id]);
        if (!teacher.length || !teacher[0].values.length) {
            return res.status(404).json({ error: 'Teacher not found.' });
        }
        const teacherId = teacher[0].values[0][0];
        const result = db.exec(`
      SELECT pi.net_salary, pi.gross_salary, pi.total_deductions, pi.payment_status, pi.created_at,
             p.month, p.year, p.status as payroll_status
      FROM payroll_items pi
      JOIN payroll p ON pi.payroll_id = p.id
      WHERE pi.teacher_id = ?
      ORDER BY p.year DESC, p.month DESC
    `, [teacherId]);
        res.json(resultToArray(result));
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch salary history.' });
    }
});

// GET /api/teacher/notifications
router.get('/notifications', (req, res) => {
    try {
        const db = getDb();
        const result = db.exec(
            "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
            [req.user.id]
        );
        res.json(resultToArray(result));
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch notifications.' });
    }
});

// PUT /api/teacher/notifications/:id/read
router.put('/notifications/:id/read', (req, res) => {
    try {
        const db = getDb();
        db.run("UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
        saveDatabase();
        res.json({ message: 'Notification marked as read.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update notification.' });
    }
});

// PUT /api/teacher/notifications/read-all
router.put('/notifications/read-all', (req, res) => {
    try {
        const db = getDb();
        db.run("UPDATE notifications SET is_read = 1 WHERE user_id = ?", [req.user.id]);
        saveDatabase();
        res.json({ message: 'All notifications marked as read.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update notifications.' });
    }
});

module.exports = router;
