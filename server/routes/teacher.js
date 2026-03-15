const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const { authenticateToken, authorizeRoles, logAudit } = require('../middleware');
const PDFDocument = require('pdfkit');

// All teacher routes require teacher role
router.use(authenticateToken, authorizeRoles('teacher'));

// GET /api/teacher/profile
router.get('/profile', async (req, res) => {
    try {
        const db = getDb();
        const { rows: [profile] } = await db.query(`
            SELECT t.*, s.basic_salary, s.housing_allowance, s.transport_allowance, s.medical_allowance,
                   s.other_allowance, s.tax_percentage, s.nssf_percentage
            FROM teachers t
            LEFT JOIN salary_structures s ON t.salary_scale = s.salary_scale
            WHERE t.user_id = $1
        `, [req.user.id]);
        if (!profile) return res.status(404).json({ error: 'Teacher profile not found.' });
        res.json(profile);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch profile.' }); }
});

// PUT /api/teacher/profile
router.put('/profile', async (req, res) => {
    try {
        const {
            phone, email,
            payment_method, bank_name, bank_account_name, bank_account_number,
            mobile_money_provider, mobile_money_number
        } = req.body;
        const db = getDb();
        const pm = payment_method || null;
        await db.query(
            `UPDATE teachers SET
                phone=COALESCE($1,phone),
                email=COALESCE($2,email),
                payment_method=COALESCE($3,payment_method),
                bank_name=CASE WHEN $3='bank' THEN $4 WHEN $3='mobile_money' THEN NULL ELSE bank_name END,
                bank_account_name=CASE WHEN $3='bank' THEN $5 WHEN $3='mobile_money' THEN NULL ELSE bank_account_name END,
                bank_account_number=CASE WHEN $3='bank' THEN $6 WHEN $3='mobile_money' THEN NULL ELSE bank_account_number END,
                mobile_money_provider=CASE WHEN $3='mobile_money' THEN $7 WHEN $3='bank' THEN NULL ELSE mobile_money_provider END,
                mobile_money_number=CASE WHEN $3='mobile_money' THEN $8 WHEN $3='bank' THEN NULL ELSE mobile_money_number END,
                updated_at=NOW()
             WHERE user_id=$9`,
            [phone || null, email || null, pm,
            bank_name || null, bank_account_name || null, bank_account_number || null,
            mobile_money_provider || null, mobile_money_number || null,
            req.user.id]
        );
        await db.query(
            "UPDATE users SET phone=COALESCE($1,phone), email=COALESCE($2,email), updated_at=NOW() WHERE id=$3",
            [phone || null, email || null, req.user.id]
        );
        res.json({ message: 'Profile updated successfully.' });
    } catch (err) { res.status(500).json({ error: 'Failed to update profile.' }); }
});

// GET /api/teacher/payslips
router.get('/payslips', async (req, res) => {
    try {
        const db = getDb();
        const { rows: [teacher] } = await db.query("SELECT id FROM teachers WHERE user_id = $1", [req.user.id]);
        if (!teacher) return res.status(404).json({ error: 'Teacher not found.' });
        const { rows } = await db.query(`
            SELECT pi.*, p.month, p.year, p.status as payroll_status
            FROM payroll_items pi
            JOIN payroll p ON pi.payroll_id = p.id
            WHERE pi.teacher_id = $1 AND p.status IN ('approved', 'paid')
            ORDER BY p.year DESC, p.month DESC
        `, [teacher.id]);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch payslips.' }); }
});

// GET /api/teacher/payslip/:id/pdf
router.get('/payslip/:id/pdf', async (req, res) => {
    try {
        const db = getDb();
        const { rows: [teacher] } = await db.query("SELECT id FROM teachers WHERE user_id = $1", [req.user.id]);
        if (!teacher) return res.status(404).json({ error: 'Teacher not found.' });

        const { rows: [item] } = await db.query(`
            SELECT pi.*, t.full_name, t.employee_id, t.position, t.salary_scale, p.month, p.year,
                   t.payment_method, t.bank_name, t.bank_account_name, t.bank_account_number, 
                   t.mobile_money_provider, t.mobile_money_number
            FROM payroll_items pi
            JOIN teachers t ON pi.teacher_id = t.id
            JOIN payroll p ON pi.payroll_id = p.id
            WHERE pi.id = $1 AND pi.teacher_id = $2
        `, [req.params.id, teacher.id]);
        if (!item) return res.status(404).json({ error: 'Payslip not found.' });

        const { rows: configRows } = await db.query("SELECT config_key, config_value FROM system_config");
        const configs = {};
        configRows.forEach(c => { configs[c.config_key] = c.config_value; });
        const schoolName = configs.school_name || 'EduPay School';
        const currency = configs.currency || 'UGX';

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=payslip_${item.month}_${item.year}.pdf`);
        doc.pipe(res);

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
        doc.text(`Pay Period: ${item.month}/${item.year}`, 350, infoY);
        doc.text(`Payment Status: ${item.payment_status}`, 350, infoY + 18);

        // Add Bank details section
        let bankY = infoY + 60;
        doc.fontSize(10).fillColor('#000');
        if (item.payment_method === 'mobile_money') {
            doc.text(`Payment Method: Mobile Money`, 50, bankY);
            doc.text(`Provider: ${item.mobile_money_provider || 'N/A'}`, 50, bankY + 14);
            doc.text(`Mobile Number: ${item.mobile_money_number || 'N/A'}`, 50, bankY + 28);
        } else {
            doc.text(`Payment Method: Bank Transfer`, 50, bankY);
            doc.text(`Bank Name: ${item.bank_name || 'N/A'}`, 50, bankY + 14);
            doc.text(`Account Name: ${item.bank_account_name || 'N/A'}`, 300, bankY + 14);
            doc.text(`Account Number: ${item.bank_account_number || 'N/A'}`, 50, bankY + 28);
        }

        let tableY = bankY + 50;
        doc.fontSize(12).fillColor('#DC2626').text('EARNINGS', 50, tableY);
        tableY += 20;
        doc.fontSize(9).fillColor('#000');

        [['Basic Salary', item.basic_salary], ['Housing Allowance', item.housing_allowance],
        ['Transport Allowance', item.transport_allowance], ['Medical Allowance', item.medical_allowance],
        ['Other Allowance', item.other_allowance]].forEach(([label, val]) => {
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

        [['PAYE Tax', item.tax_amount], ['NSSF', item.nssf_amount],
        ['Loan Deduction', item.loan_deduction], ['Advance Deduction', item.advance_deduction], ['Other Deductions', item.other_deduction]].forEach(([label, val]) => {
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
router.get('/salary-history', async (req, res) => {
    try {
        const db = getDb();
        const { rows: [teacher] } = await db.query("SELECT id FROM teachers WHERE user_id = $1", [req.user.id]);
        if (!teacher) return res.status(404).json({ error: 'Teacher not found.' });
        const { rows } = await db.query(`
            SELECT pi.net_salary, pi.gross_salary, pi.total_deductions, pi.payment_status, pi.created_at,
                   p.month, p.year, p.status as payroll_status
            FROM payroll_items pi
            JOIN payroll p ON pi.payroll_id = p.id
            WHERE pi.teacher_id = $1
            ORDER BY p.year DESC, p.month DESC
        `, [teacher.id]);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch salary history.' }); }
});

// GET /api/teacher/notifications
router.get('/notifications', async (req, res) => {
    try {
        const db = getDb();
        const { rows } = await db.query(
            "SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50",
            [req.user.id]
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch notifications.' }); }
});

// PUT /api/teacher/notifications/:id/read
router.put('/notifications/:id/read', async (req, res) => {
    try {
        const db = getDb();
        await db.query("UPDATE notifications SET is_read = 1 WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
        res.json({ message: 'Notification marked as read.' });
    } catch (err) { res.status(500).json({ error: 'Failed to update notification.' }); }
});

// PUT /api/teacher/notifications/read-all
router.put('/notifications/read-all', async (req, res) => {
    try {
        const db = getDb();
        await db.query("UPDATE notifications SET is_read = 1 WHERE user_id = $1", [req.user.id]);
        res.json({ message: 'All notifications marked as read.' });
    } catch (err) { res.status(500).json({ error: 'Failed to update notifications.' }); }
});

// ============ LEAVE REQUESTS ============

// GET /api/teacher/leave
router.get('/leave', async (req, res) => {
    try {
        const db = getDb();
        const { rows: [teacher] } = await db.query("SELECT id FROM teachers WHERE user_id = $1", [req.user.id]);
        if (!teacher) return res.status(404).json({ error: 'Teacher not found.' });

        const { rows } = await db.query(
            "SELECT * FROM leave_requests WHERE teacher_id = $1 ORDER BY created_at DESC",
            [teacher.id]
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch leave requests.' }); }
});

// POST /api/teacher/leave
router.post('/leave', async (req, res) => {
    try {
        const { leave_type, start_date, end_date, reason } = req.body;
        if (!leave_type || !start_date || !end_date || !reason) {
            return res.status(400).json({ error: 'All fields are required.' });
        }

        const db = getDb();
        const { rows: [teacher] } = await db.query("SELECT id FROM teachers WHERE user_id = $1", [req.user.id]);
        if (!teacher) return res.status(404).json({ error: 'Teacher not found.' });

        const { rows: [newLeave] } = await db.query(
            `INSERT INTO leave_requests (teacher_id, leave_type, start_date, end_date, reason)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [teacher.id, leave_type, start_date, end_date, reason]
        );

        logAudit(db, req.user.id, req.user.username, 'CREATE_LEAVE_REQUEST', `Submitted leave request for ${leave_type}`, req.ip);
        res.json({ message: 'Leave request submitted successfully.', id: newLeave.id });
    } catch (err) { res.status(500).json({ error: 'Failed to submit leave request.' }); }
});

// ============ ADVANCE REQUESTS ============

// GET /api/teacher/advances
router.get('/advances', async (req, res) => {
    try {
        const db = getDb();
        const { rows: [teacher] } = await db.query("SELECT id FROM teachers WHERE user_id = $1", [req.user.id]);
        if (!teacher) return res.status(404).json({ error: 'Teacher not found.' });

        const { rows } = await db.query(
            `SELECT ar.*, u.full_name as approved_by_name
             FROM advance_requests ar
             LEFT JOIN users u ON ar.approved_by = u.id
             WHERE ar.teacher_id = $1
             ORDER BY ar.created_at DESC`,
            [teacher.id]
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch advance requests.' }); }
});

// POST /api/teacher/advances
router.post('/advances', async (req, res) => {
    try {
        const amount = Number(req.body.amount);
        const reason = (req.body.reason || '').trim();

        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ error: 'A valid advance amount is required.' });
        }
        if (!reason) {
            return res.status(400).json({ error: 'Reason is required.' });
        }

        const db = getDb();
        const { rows: [teacher] } = await db.query("SELECT id FROM teachers WHERE user_id = $1", [req.user.id]);
        if (!teacher) return res.status(404).json({ error: 'Teacher not found.' });

        const { rows: [activeReq] } = await db.query(
            "SELECT id FROM advance_requests WHERE teacher_id = $1 AND status IN ('Pending','Approved') LIMIT 1",
            [teacher.id]
        );
        if (activeReq) {
            return res.status(400).json({ error: 'You already have a pending or approved advance request.' });
        }

        const { rows: [newAdvance] } = await db.query(
            `INSERT INTO advance_requests (teacher_id, amount, reason)
             VALUES ($1, $2, $3) RETURNING id`,
            [teacher.id, amount, reason]
        );

        logAudit(db, req.user.id, req.user.username, 'CREATE_ADVANCE_REQUEST', `Submitted advance request: ${amount}`, req.ip);
        res.status(201).json({ message: 'Advance request submitted successfully.', id: newAdvance.id });
    } catch (err) { res.status(500).json({ error: 'Failed to submit advance request.' }); }
});

module.exports = router;
