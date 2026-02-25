const express = require('express');
const router = express.Router();
const { getDb, saveDatabase } = require('../database');
const { authenticateToken, authorizeRoles, logAudit } = require('../middleware');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

// All accountant routes require accountant or admin role
router.use(authenticateToken, authorizeRoles('accountant', 'admin'));

// Helper to convert sql.js result to array of objects
function resultToArray(result) {
    if (!result || result.length === 0) return [];
    const columns = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        columns.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

// ============ TEACHER RECORDS ============

// GET /api/accountant/teachers
router.get('/teachers', (req, res) => {
    try {
        const db = getDb();
        const result = db.exec(`
      SELECT t.*, s.basic_salary, s.housing_allowance, s.transport_allowance, s.medical_allowance,
             s.other_allowance, s.tax_percentage, s.nssf_percentage, s.loan_deduction, s.other_deduction
      FROM teachers t
      LEFT JOIN salary_structures s ON t.salary_scale = s.salary_scale
      WHERE t.is_active = 1
      ORDER BY t.full_name
    `);
        res.json(resultToArray(result));
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch teacher records.' });
    }
});

// ============ PAYROLL PROCESSING ============

// GET /api/accountant/payroll
router.get('/payroll', (req, res) => {
    try {
        const db = getDb();
        const result = db.exec(`
      SELECT p.*,
        (SELECT COUNT(*) FROM payroll_items WHERE payroll_id = p.id) as teacher_count,
        (SELECT full_name FROM users WHERE id = p.processed_by) as processed_by_name,
        (SELECT full_name FROM users WHERE id = p.approved_by) as approved_by_name
      FROM payroll p ORDER BY p.year DESC, p.month DESC
    `);
        res.json(resultToArray(result));
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch payrolls.' });
    }
});

// POST /api/accountant/payroll/process
router.post('/payroll/process', (req, res) => {
    try {
        const { month, year } = req.body;
        if (!month || !year) {
            return res.status(400).json({ error: 'Month and year are required.' });
        }

        const db = getDb();

        // Check if payroll already exists for this month/year
        const existing = db.exec("SELECT id, status FROM payroll WHERE month = ? AND year = ?", [month, year]);
        if (existing.length > 0 && existing[0].values.length > 0) {
            const status = existing[0].values[0][1];
            if (status === 'approved' || status === 'paid') {
                return res.status(400).json({ error: `Payroll for ${month}/${year} is already ${status}.` });
            }
            // Delete existing draft/processed payroll items
            const payrollId = existing[0].values[0][0];
            db.run("DELETE FROM payroll_items WHERE payroll_id = ?", [payrollId]);
            db.run("DELETE FROM payroll WHERE id = ?", [payrollId]);
        }

        // Get all active teachers with salary info
        const teachers = db.exec(`
      SELECT t.id as teacher_id, t.full_name, t.salary_scale,
             s.basic_salary, s.housing_allowance, s.transport_allowance, s.medical_allowance,
             s.other_allowance, s.tax_percentage, s.nssf_percentage, s.loan_deduction, s.other_deduction
      FROM teachers t
      LEFT JOIN salary_structures s ON t.salary_scale = s.salary_scale
      WHERE t.is_active = 1
    `);

        if (!teachers.length || !teachers[0].values.length) {
            return res.status(400).json({ error: 'No active teachers found.' });
        }

        const teacherList = resultToArray(teachers);

        // Create payroll record
        db.run(
            "INSERT INTO payroll (month, year, status, processed_by) VALUES (?, ?, 'processed', ?)",
            [month, year, req.user.id]
        );
        saveDatabase();

        const payrollResult = db.exec("SELECT id FROM payroll WHERE month = ? AND year = ? ORDER BY id DESC LIMIT 1", [month, year]);
        const payrollId = payrollResult[0].values[0][0];

        let totalGross = 0, totalDeductions = 0, totalNet = 0;

        for (const t of teacherList) {
            const basic = t.basic_salary || 0;
            const housing = t.housing_allowance || 0;
            const transport = t.transport_allowance || 0;
            const medical = t.medical_allowance || 0;
            const otherAllow = t.other_allowance || 0;
            const gross = basic + housing + transport + medical + otherAllow;

            const taxRate = (t.tax_percentage || 0) / 100;
            const nssfRate = (t.nssf_percentage || 0) / 100;
            const taxAmount = basic * taxRate;
            const nssfAmount = basic * nssfRate;
            const loanDed = t.loan_deduction || 0;
            const otherDed = t.other_deduction || 0;
            const totalDed = taxAmount + nssfAmount + loanDed + otherDed;
            const net = gross - totalDed;

            db.run(
                `INSERT INTO payroll_items (payroll_id, teacher_id, basic_salary, housing_allowance, transport_allowance, medical_allowance, other_allowance, gross_salary, tax_amount, nssf_amount, loan_deduction, other_deduction, total_deductions, net_salary)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [payrollId, t.teacher_id, basic, housing, transport, medical, otherAllow, gross, taxAmount, nssfAmount, loanDed, otherDed, totalDed, net]
            );

            totalGross += gross;
            totalDeductions += totalDed;
            totalNet += net;
        }

        db.run(
            "UPDATE payroll SET total_gross = ?, total_deductions = ?, total_net = ?, updated_at = datetime('now') WHERE id = ?",
            [totalGross, totalDeductions, totalNet, payrollId]
        );
        saveDatabase();

        logAudit(db, saveDatabase, req.user.id, req.user.username, 'PROCESS_PAYROLL',
            `Processed payroll for ${month}/${year}: ${teacherList.length} teachers`, req.ip);

        res.json({
            message: 'Payroll processed successfully.',
            payroll_id: payrollId,
            teacher_count: teacherList.length,
            total_gross: totalGross,
            total_deductions: totalDeductions,
            total_net: totalNet
        });
    } catch (err) {
        console.error('Process payroll error:', err);
        res.status(500).json({ error: 'Failed to process payroll.' });
    }
});

// GET /api/accountant/payroll/:id/items
router.get('/payroll/:id/items', (req, res) => {
    try {
        const db = getDb();
        const result = db.exec(`
      SELECT pi.*, t.full_name, t.employee_id, t.salary_scale
      FROM payroll_items pi
      JOIN teachers t ON pi.teacher_id = t.id
      WHERE pi.payroll_id = ?
      ORDER BY t.full_name
    `, [req.params.id]);
        res.json(resultToArray(result));
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch payroll items.' });
    }
});

// POST /api/accountant/payroll/:id/approve
router.post('/payroll/:id/approve', (req, res) => {
    try {
        const db = getDb();
        const payroll = db.exec("SELECT status FROM payroll WHERE id = ?", [req.params.id]);
        if (!payroll.length || !payroll[0].values.length) {
            return res.status(404).json({ error: 'Payroll not found.' });
        }
        if (payroll[0].values[0][0] === 'approved') {
            return res.status(400).json({ error: 'Payroll is already approved.' });
        }
        db.run(
            "UPDATE payroll SET status = 'approved', approved_by = ?, updated_at = datetime('now') WHERE id = ?",
            [req.user.id, req.params.id]
        );
        saveDatabase();

        // Create notifications for teachers
        const items = db.exec(`
      SELECT pi.teacher_id, t.user_id, pi.net_salary
      FROM payroll_items pi JOIN teachers t ON pi.teacher_id = t.id
      WHERE pi.payroll_id = ?
    `, [req.params.id]);
        const teacherItems = resultToArray(items);
        const payrollInfo = db.exec("SELECT month, year FROM payroll WHERE id = ?", [req.params.id]);
        const pInfo = resultToArray(payrollInfo)[0];

        for (const item of teacherItems) {
            if (item.user_id) {
                db.run(
                    "INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)",
                    [item.user_id, 'Salary Processed', `Your salary for ${pInfo.month}/${pInfo.year} has been processed. Net amount: ${item.net_salary.toLocaleString()}`]
                );
            }
        }
        saveDatabase();

        logAudit(db, saveDatabase, req.user.id, req.user.username, 'APPROVE_PAYROLL',
            `Approved payroll ID: ${req.params.id}`, req.ip);
        res.json({ message: 'Payroll approved successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to approve payroll.' });
    }
});

// PUT /api/accountant/payroll-items/:id/payment-status
router.put('/payroll-items/:id/payment-status', (req, res) => {
    try {
        const { payment_status } = req.body;
        if (!['Paid', 'Pending'].includes(payment_status)) {
            return res.status(400).json({ error: 'Invalid payment status.' });
        }
        const db = getDb();
        db.run("UPDATE payroll_items SET payment_status = ? WHERE id = ?", [payment_status, req.params.id]);

        // If marking as paid, also update payroll status
        if (payment_status === 'Paid') {
            const item = db.exec("SELECT payroll_id, teacher_id FROM payroll_items WHERE id = ?", [req.params.id]);
            if (item.length > 0 && item[0].values.length > 0) {
                const payrollId = item[0].values[0][0];
                const teacherId = item[0].values[0][1];
                // Check if all items in this payroll are paid
                const unpaid = db.exec("SELECT COUNT(*) FROM payroll_items WHERE payroll_id = ? AND payment_status = 'Pending'", [payrollId]);
                if (unpaid[0].values[0][0] === 0) {
                    db.run("UPDATE payroll SET status = 'paid', updated_at = datetime('now') WHERE id = ?", [payrollId]);
                }
                // Notify teacher
                const teacher = db.exec("SELECT user_id FROM teachers WHERE id = ?", [teacherId]);
                if (teacher.length > 0 && teacher[0].values.length > 0 && teacher[0].values[0][0]) {
                    db.run(
                        "INSERT INTO notifications (user_id, title, message) VALUES (?, 'Payment Received', 'Your salary payment has been marked as Paid.')",
                        [teacher[0].values[0][0]]
                    );
                }
            }
        }

        saveDatabase();
        logAudit(db, saveDatabase, req.user.id, req.user.username, 'UPDATE_PAYMENT_STATUS',
            `Updated payment status to ${payment_status} for item ID: ${req.params.id}`, req.ip);
        res.json({ message: 'Payment status updated.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update payment status.' });
    }
});

// ============ REPORTS ============

// GET /api/accountant/reports/monthly?month=X&year=Y
router.get('/reports/monthly', (req, res) => {
    try {
        const { month, year } = req.query;
        const db = getDb();
        let query = `
      SELECT p.*, 
        (SELECT COUNT(*) FROM payroll_items WHERE payroll_id = p.id) as teacher_count
      FROM payroll p
    `;
        const params = [];
        if (month && year) {
            query += " WHERE p.month = ? AND p.year = ?";
            params.push(month, year);
        }
        query += " ORDER BY p.year DESC, p.month DESC";
        const result = db.exec(query, params);
        res.json(resultToArray(result));
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch report.' });
    }
});

// GET /api/accountant/reports/export/excel/:payrollId
router.get('/reports/export/excel/:payrollId', async (req, res) => {
    try {
        const db = getDb();
        const payroll = db.exec("SELECT * FROM payroll WHERE id = ?", [req.params.payrollId]);
        if (!payroll.length || !payroll[0].values.length) {
            return res.status(404).json({ error: 'Payroll not found.' });
        }
        const pInfo = resultToArray(payroll)[0];

        const items = db.exec(`
      SELECT pi.*, t.full_name, t.employee_id, t.salary_scale
      FROM payroll_items pi JOIN teachers t ON pi.teacher_id = t.id
      WHERE pi.payroll_id = ?
      ORDER BY t.full_name
    `, [req.params.payrollId]);
        const itemList = resultToArray(items);

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Payroll Report');

        // Title
        sheet.mergeCells('A1:N1');
        sheet.getCell('A1').value = `EduPay Payroll Report - ${pInfo.month}/${pInfo.year}`;
        sheet.getCell('A1').font = { size: 16, bold: true };

        sheet.mergeCells('A2:N2');
        sheet.getCell('A2').value = `Status: ${pInfo.status} | Total Net: ${pInfo.total_net}`;

        // Headers
        const headers = ['#', 'Employee ID', 'Name', 'Scale', 'Basic Salary', 'Housing', 'Transport', 'Medical', 'Other Allow.', 'Gross', 'Tax', 'NSSF', 'Loan', 'Other Ded.', 'Total Ded.', 'Net Salary', 'Status'];
        const headerRow = sheet.addRow(headers);
        headerRow.font = { bold: true };
        headerRow.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDC2626' } }; cell.font = { color: { argb: 'FFFFFFFF' }, bold: true }; });

        itemList.forEach((item, i) => {
            sheet.addRow([
                i + 1, item.employee_id, item.full_name, item.salary_scale,
                item.basic_salary, item.housing_allowance, item.transport_allowance,
                item.medical_allowance, item.other_allowance, item.gross_salary,
                item.tax_amount, item.nssf_amount, item.loan_deduction,
                item.other_deduction, item.total_deductions, item.net_salary,
                item.payment_status
            ]);
        });

        // Auto-width columns
        sheet.columns.forEach(col => { col.width = 15; });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=payroll_${pInfo.month}_${pInfo.year}.xlsx`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error('Excel export error:', err);
        res.status(500).json({ error: 'Failed to export Excel.' });
    }
});

// GET /api/accountant/reports/export/pdf/:payrollId
router.get('/reports/export/pdf/:payrollId', (req, res) => {
    try {
        const db = getDb();
        const payroll = db.exec("SELECT * FROM payroll WHERE id = ?", [req.params.payrollId]);
        if (!payroll.length || !payroll[0].values.length) {
            return res.status(404).json({ error: 'Payroll not found.' });
        }
        const pInfo = resultToArray(payroll)[0];

        const items = db.exec(`
      SELECT pi.*, t.full_name, t.employee_id, t.salary_scale
      FROM payroll_items pi JOIN teachers t ON pi.teacher_id = t.id
      WHERE pi.payroll_id = ?
      ORDER BY t.full_name
    `, [req.params.payrollId]);
        const itemList = resultToArray(items);

        const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=payroll_${pInfo.month}_${pInfo.year}.pdf`);
        doc.pipe(res);

        // Header
        doc.fontSize(20).fillColor('#DC2626').text('EduPay Payroll Report', { align: 'center' });
        doc.moveDown(0.3);
        doc.fontSize(12).fillColor('#333').text(`Period: ${pInfo.month}/${pInfo.year}  |  Status: ${pInfo.status}`, { align: 'center' });
        doc.moveDown(0.5);

        // Summary
        doc.fontSize(10).fillColor('#000');
        doc.text(`Total Gross: ${Number(pInfo.total_gross).toLocaleString()}  |  Total Deductions: ${Number(pInfo.total_deductions).toLocaleString()}  |  Total Net: ${Number(pInfo.total_net).toLocaleString()}`, { align: 'center' });
        doc.moveDown(1);

        // Table
        const startX = 30;
        let y = doc.y;
        const colWidths = [25, 55, 100, 50, 65, 55, 55, 55, 55, 55, 50, 50, 50];
        const headers = ['#', 'Emp ID', 'Name', 'Scale', 'Basic', 'Housing', 'Transport', 'Gross', 'Tax', 'NSSF', 'Deductions', 'Net', 'Status'];

        // Header row
        doc.fontSize(7).fillColor('#FFF');
        let x = startX;
        headers.forEach((h, i) => {
            doc.rect(x, y, colWidths[i], 15).fill('#DC2626');
            doc.fillColor('#FFF').text(h, x + 2, y + 3, { width: colWidths[i] - 4 });
            x += colWidths[i];
        });
        y += 15;

        // Data rows
        doc.fillColor('#000');
        itemList.forEach((item, idx) => {
            if (y > 550) {
                doc.addPage();
                y = 30;
            }
            const bgColor = idx % 2 === 0 ? '#F9F9F9' : '#FFFFFF';
            x = startX;
            const vals = [
                idx + 1, item.employee_id, item.full_name, item.salary_scale,
                Number(item.basic_salary).toLocaleString(),
                Number(item.housing_allowance).toLocaleString(),
                Number(item.transport_allowance).toLocaleString(),
                Number(item.gross_salary).toLocaleString(),
                Number(item.tax_amount).toLocaleString(),
                Number(item.nssf_amount).toLocaleString(),
                Number(item.total_deductions).toLocaleString(),
                Number(item.net_salary).toLocaleString(),
                item.payment_status
            ];
            vals.forEach((v, i) => {
                doc.rect(x, y, colWidths[i], 14).fill(bgColor);
                doc.fillColor('#000').text(String(v), x + 2, y + 3, { width: colWidths[i] - 4 });
                x += colWidths[i];
            });
            y += 14;
        });

        doc.end();
    } catch (err) {
        console.error('PDF export error:', err);
        res.status(500).json({ error: 'Failed to export PDF.' });
    }
});

// ============ PAYSLIP ============

// GET /api/accountant/payslip/:payrollItemId/pdf
router.get('/payslip/:payrollItemId/pdf', (req, res) => {
    try {
        const db = getDb();
        const result = db.exec(`
      SELECT pi.*, t.full_name, t.employee_id, t.position, t.salary_scale, p.month, p.year
      FROM payroll_items pi
      JOIN teachers t ON pi.teacher_id = t.id
      JOIN payroll p ON pi.payroll_id = p.id
      WHERE pi.id = ?
    `, [req.params.payrollItemId]);

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
        res.setHeader('Content-Disposition', `attachment; filename=payslip_${item.employee_id}_${item.month}_${item.year}.pdf`);
        doc.pipe(res);

        // Payslip header
        doc.rect(0, 0, 595, 80).fill('#DC2626');
        doc.fontSize(24).fillColor('#FFF').text(schoolName, 50, 20);
        doc.fontSize(12).text('PAYSLIP', 50, 50);

        doc.moveDown(2);
        doc.fillColor('#000');

        // Employee info
        const infoY = 100;
        doc.fontSize(10);
        doc.text(`Employee Name: ${item.full_name}`, 50, infoY);
        doc.text(`Employee ID: ${item.employee_id}`, 50, infoY + 18);
        doc.text(`Position: ${item.position || 'N/A'}`, 50, infoY + 36);
        doc.text(`Salary Scale: ${item.salary_scale}`, 350, infoY);
        doc.text(`Pay Period: ${item.month}/${item.year}`, 350, infoY + 18);
        doc.text(`Payment Status: ${item.payment_status}`, 350, infoY + 36);

        doc.moveDown(3);
        let tableY = infoY + 70;

        // Earnings table
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

        // Deductions table
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

        // Net pay
        doc.rect(50, tableY, 460, 35).fill('#F0F0F0');
        doc.fontSize(14).fillColor('#DC2626').font('Helvetica-Bold');
        doc.text('NET SALARY', 60, tableY + 8);
        doc.text(`${currency} ${Number(item.net_salary).toLocaleString()}`, 350, tableY + 8, { width: 150, align: 'right' });

        // Footer
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

// GET /api/accountant/stats
router.get('/stats', (req, res) => {
    try {
        const db = getDb();
        const totalTeachers = db.exec("SELECT COUNT(*) FROM teachers WHERE is_active = 1");
        const totalPayrolls = db.exec("SELECT COUNT(*) FROM payroll");
        const pendingPayrolls = db.exec("SELECT COUNT(*) FROM payroll WHERE status IN ('draft','processed')");
        const latestPayroll = db.exec("SELECT * FROM payroll ORDER BY created_at DESC LIMIT 1");
        const totalPaid = db.exec("SELECT COALESCE(SUM(total_net), 0) FROM payroll WHERE status IN ('approved','paid')");

        res.json({
            total_teachers: totalTeachers[0]?.values[0]?.[0] || 0,
            total_payrolls: totalPayrolls[0]?.values[0]?.[0] || 0,
            pending_payrolls: pendingPayrolls[0]?.values[0]?.[0] || 0,
            total_paid: totalPaid[0]?.values[0]?.[0] || 0,
            latest_payroll: resultToArray(latestPayroll)[0] || null
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch stats.' });
    }
});

module.exports = router;
