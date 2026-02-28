const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const { authenticateToken, authorizeRoles, logAudit } = require('../middleware');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

// All accountant routes require accountant or admin role
router.use(authenticateToken, authorizeRoles('accountant', 'admin'));

// ============ TEACHER RECORDS ============

router.get('/teachers', async (req, res) => {
    try {
        const db = getDb();
        const { rows } = await db.query(`
            SELECT t.*, s.basic_salary, s.housing_allowance, s.transport_allowance, s.medical_allowance,
                   s.other_allowance, s.tax_percentage, s.nssf_percentage, s.loan_deduction, s.other_deduction
            FROM teachers t
            LEFT JOIN salary_structures s ON t.salary_scale = s.salary_scale
            WHERE t.is_active = true
            ORDER BY t.full_name
        `);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch teacher records.' }); }
});

// ============ PAYROLL PROCESSING ============

router.get('/payroll', async (req, res) => {
    try {
        const db = getDb();
        const { rows } = await db.query(`
            SELECT p.*,
                (SELECT COUNT(*) FROM payroll_items WHERE payroll_id = p.id) as teacher_count,
                (SELECT full_name FROM users WHERE id = p.processed_by) as processed_by_name,
                (SELECT full_name FROM users WHERE id = p.approved_by) as approved_by_name
            FROM payroll p ORDER BY p.year DESC, p.month DESC
        `);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch payrolls.' }); }
});

router.post('/payroll/process', async (req, res) => {
    const db = getDb();
    const client = await db.connect();
    try {
        const { month, year } = req.body;
        if (!month || !year)
            return res.status(400).json({ error: 'Month and year are required.' });

        // Check for existing payroll
        const { rows: existRows } = await client.query(
            "SELECT id, status FROM payroll WHERE month = $1 AND year = $2", [month, year]
        );
        if (existRows.length) {
            const existing = existRows[0];
            if (existing.status === 'approved' || existing.status === 'paid') {
                return res.status(400).json({ error: `Payroll for ${month}/${year} is already ${existing.status}.` });
            }
        }

        // Get active teachers with salary info
        const { rows: teacherList } = await client.query(`
            SELECT t.id as teacher_id, t.full_name, t.salary_scale,
                   s.basic_salary, s.housing_allowance, s.transport_allowance, s.medical_allowance,
                   s.other_allowance, s.tax_percentage, s.nssf_percentage, s.loan_deduction, s.other_deduction
            FROM teachers t
            LEFT JOIN salary_structures s ON t.salary_scale = s.salary_scale
            WHERE t.is_active = true
        `);
        if (!teacherList.length)
            return res.status(400).json({ error: 'No active teachers found.' });

        await client.query('BEGIN');

        // Remove existing draft if any
        if (existRows.length) {
            await client.query("DELETE FROM payroll_items WHERE payroll_id = $1", [existRows[0].id]);
            await client.query("DELETE FROM payroll WHERE id = $1", [existRows[0].id]);
        }

        // Create payroll record
        const { rows: [newPayroll] } = await client.query(
            "INSERT INTO payroll (month, year, status, processed_by) VALUES ($1,$2,'processed',$3) RETURNING id",
            [month, year, req.user.id]
        );
        const payrollId = newPayroll.id;

        let totalGross = 0, totalDeductions = 0, totalNet = 0;

        for (const t of teacherList) {
            const basic      = Number(t.basic_salary)      || 0;
            const housing    = Number(t.housing_allowance)  || 0;
            const transport  = Number(t.transport_allowance)|| 0;
            const medical    = Number(t.medical_allowance)  || 0;
            const otherAllow = Number(t.other_allowance)    || 0;
            const gross      = basic + housing + transport + medical + otherAllow;

            const taxAmount  = basic * (Number(t.tax_percentage)  || 0) / 100;
            const nssfAmount = basic * (Number(t.nssf_percentage) || 0) / 100;
            const loanDed    = Number(t.loan_deduction)  || 0;
            const otherDed   = Number(t.other_deduction) || 0;
            const totalDed   = taxAmount + nssfAmount + loanDed + otherDed;
            const net        = gross - totalDed;

            await client.query(
                `INSERT INTO payroll_items
                    (payroll_id, teacher_id, basic_salary, housing_allowance, transport_allowance,
                     medical_allowance, other_allowance, gross_salary, tax_amount, nssf_amount,
                     loan_deduction, other_deduction, total_deductions, net_salary)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
                [payrollId, t.teacher_id, basic, housing, transport, medical, otherAllow,
                 gross, taxAmount, nssfAmount, loanDed, otherDed, totalDed, net]
            );

            totalGross       += gross;
            totalDeductions  += totalDed;
            totalNet         += net;
        }

        await client.query(
            "UPDATE payroll SET total_gross=$1, total_deductions=$2, total_net=$3, updated_at=NOW() WHERE id=$4",
            [totalGross, totalDeductions, totalNet, payrollId]
        );

        await client.query('COMMIT');

        logAudit(db, req.user.id, req.user.username, 'PROCESS_PAYROLL',
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
        await client.query('ROLLBACK');
        console.error('Process payroll error:', err);
        res.status(500).json({ error: 'Failed to process payroll.' });
    } finally {
        client.release();
    }
});

router.get('/payroll/:id/items', async (req, res) => {
    try {
        const db = getDb();
        const { rows } = await db.query(`
            SELECT pi.*, t.full_name, t.employee_id, t.salary_scale
            FROM payroll_items pi
            JOIN teachers t ON pi.teacher_id = t.id
            WHERE pi.payroll_id = $1
            ORDER BY t.full_name
        `, [req.params.id]);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch payroll items.' }); }
});

router.post('/payroll/:id/approve', async (req, res) => {
    try {
        const db = getDb();
        const { rows: [payroll] } = await db.query("SELECT status, month, year FROM payroll WHERE id = $1", [req.params.id]);
        if (!payroll) return res.status(404).json({ error: 'Payroll not found.' });
        if (payroll.status === 'approved') return res.status(400).json({ error: 'Payroll is already approved.' });

        await db.query(
            "UPDATE payroll SET status='approved', approved_by=$1, updated_at=NOW() WHERE id=$2",
            [req.user.id, req.params.id]
        );

        // Notify each teacher
        const { rows: teacherItems } = await db.query(`
            SELECT pi.teacher_id, t.user_id, pi.net_salary
            FROM payroll_items pi JOIN teachers t ON pi.teacher_id = t.id
            WHERE pi.payroll_id = $1
        `, [req.params.id]);

        for (const item of teacherItems) {
            if (item.user_id) {
                db.query(
                    "INSERT INTO notifications (user_id, title, message) VALUES ($1,$2,$3)",
                    [item.user_id, 'Salary Processed',
                     `Your salary for ${payroll.month}/${payroll.year} has been processed. Net amount: ${Number(item.net_salary).toLocaleString()}`]
                ).catch(err => console.error('Notification insert error:', err));
            }
        }

        logAudit(db, req.user.id, req.user.username, 'APPROVE_PAYROLL', `Approved payroll ID: ${req.params.id}`, req.ip);
        res.json({ message: 'Payroll approved successfully.' });
    } catch (err) { res.status(500).json({ error: 'Failed to approve payroll.' }); }
});

router.put('/payroll-items/:id/payment-status', async (req, res) => {
    try {
        const { payment_status } = req.body;
        if (!['Paid', 'Pending'].includes(payment_status))
            return res.status(400).json({ error: 'Invalid payment status.' });
        const db = getDb();
        await db.query("UPDATE payroll_items SET payment_status = $1 WHERE id = $2", [payment_status, req.params.id]);

        if (payment_status === 'Paid') {
            const { rows: [item] } = await db.query("SELECT payroll_id, teacher_id FROM payroll_items WHERE id = $1", [req.params.id]);
            if (item) {
                const { rows: [cnt] } = await db.query(
                    "SELECT COUNT(*) as cnt FROM payroll_items WHERE payroll_id = $1 AND payment_status = 'Pending'",
                    [item.payroll_id]
                );
                if (parseInt(cnt.cnt) === 0) {
                    await db.query("UPDATE payroll SET status='paid', updated_at=NOW() WHERE id=$1", [item.payroll_id]);
                }
                const { rows: [teacher] } = await db.query("SELECT user_id FROM teachers WHERE id = $1", [item.teacher_id]);
                if (teacher && teacher.user_id) {
                    db.query(
                        "INSERT INTO notifications (user_id, title, message) VALUES ($1, 'Payment Received', 'Your salary payment has been marked as Paid.')",
                        [teacher.user_id]
                    ).catch(err => console.error('Notification insert error:', err));
                }
            }
        }

        logAudit(db, req.user.id, req.user.username, 'UPDATE_PAYMENT_STATUS',
            `Updated payment status to ${payment_status} for item ID: ${req.params.id}`, req.ip);
        res.json({ message: 'Payment status updated.' });
    } catch (err) { res.status(500).json({ error: 'Failed to update payment status.' }); }
});

// ============ REPORTS ============

router.get('/reports/monthly', async (req, res) => {
    try {
        const { month, year } = req.query;
        const db = getDb();
        let rows;
        if (month && year) {
            ({ rows } = await db.query(`
                SELECT p.*, (SELECT COUNT(*) FROM payroll_items WHERE payroll_id = p.id) as teacher_count
                FROM payroll p WHERE p.month = $1 AND p.year = $2 ORDER BY p.year DESC, p.month DESC
            `, [month, year]));
        } else {
            ({ rows } = await db.query(`
                SELECT p.*, (SELECT COUNT(*) FROM payroll_items WHERE payroll_id = p.id) as teacher_count
                FROM payroll p ORDER BY p.year DESC, p.month DESC
            `));
        }
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch report.' }); }
});

router.get('/reports/export/excel/:payrollId', async (req, res) => {
    try {
        const db = getDb();
        const { rows: [pInfo] } = await db.query("SELECT * FROM payroll WHERE id = $1", [req.params.payrollId]);
        if (!pInfo) return res.status(404).json({ error: 'Payroll not found.' });

        const { rows: itemList } = await db.query(`
            SELECT pi.*, t.full_name, t.employee_id, t.salary_scale
            FROM payroll_items pi JOIN teachers t ON pi.teacher_id = t.id
            WHERE pi.payroll_id = $1 ORDER BY t.full_name
        `, [req.params.payrollId]);

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Payroll Report');

        sheet.mergeCells('A1:N1');
        sheet.getCell('A1').value = `EduPay Payroll Report - ${pInfo.month}/${pInfo.year}`;
        sheet.getCell('A1').font = { size: 16, bold: true };
        sheet.mergeCells('A2:N2');
        sheet.getCell('A2').value = `Status: ${pInfo.status} | Total Net: ${pInfo.total_net}`;

        const headers = ['#','Employee ID','Name','Scale','Basic Salary','Housing','Transport','Medical',
                         'Other Allow.','Gross','Tax','NSSF','Loan','Other Ded.','Total Ded.','Net Salary','Status'];
        const headerRow = sheet.addRow(headers);
        headerRow.font = { bold: true };
        headerRow.eachCell(cell => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDC2626' } };
            cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
        });

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

router.get('/reports/export/pdf/:payrollId', async (req, res) => {
    try {
        const db = getDb();
        const { rows: [pInfo] } = await db.query("SELECT * FROM payroll WHERE id = $1", [req.params.payrollId]);
        if (!pInfo) return res.status(404).json({ error: 'Payroll not found.' });

        const { rows: itemList } = await db.query(`
            SELECT pi.*, t.full_name, t.employee_id, t.salary_scale
            FROM payroll_items pi JOIN teachers t ON pi.teacher_id = t.id
            WHERE pi.payroll_id = $1 ORDER BY t.full_name
        `, [req.params.payrollId]);

        const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=payroll_${pInfo.month}_${pInfo.year}.pdf`);
        doc.pipe(res);

        doc.fontSize(20).fillColor('#DC2626').text('EduPay Payroll Report', { align: 'center' });
        doc.moveDown(0.3);
        doc.fontSize(12).fillColor('#333').text(`Period: ${pInfo.month}/${pInfo.year}  |  Status: ${pInfo.status}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(10).fillColor('#000');
        doc.text(
            `Total Gross: ${Number(pInfo.total_gross).toLocaleString()}  |  Total Deductions: ${Number(pInfo.total_deductions).toLocaleString()}  |  Total Net: ${Number(pInfo.total_net).toLocaleString()}`,
            { align: 'center' }
        );
        doc.moveDown(1);

        const startX = 30;
        let y = doc.y;
        const colWidths = [25, 55, 100, 50, 65, 55, 55, 55, 55, 55, 50, 50, 50];
        const headers = ['#','Emp ID','Name','Scale','Basic','Housing','Transport','Gross','Tax','NSSF','Deductions','Net','Status'];

        let x = startX;
        headers.forEach((h, i) => {
            doc.rect(x, y, colWidths[i], 15).fill('#DC2626');
            doc.fillColor('#FFF').fontSize(7).text(h, x + 2, y + 3, { width: colWidths[i] - 4 });
            x += colWidths[i];
        });
        y += 15;

        doc.fillColor('#000');
        itemList.forEach((item, idx) => {
            if (y > 550) { doc.addPage(); y = 30; }
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
                doc.fillColor('#000').fontSize(7).text(String(v), x + 2, y + 3, { width: colWidths[i] - 4 });
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

router.get('/payslip/:payrollItemId/pdf', async (req, res) => {
    try {
        const db = getDb();
        const { rows: [item] } = await db.query(`
            SELECT pi.*, t.full_name, t.employee_id, t.position, t.salary_scale, p.month, p.year
            FROM payroll_items pi
            JOIN teachers t ON pi.teacher_id = t.id
            JOIN payroll p ON pi.payroll_id = p.id
            WHERE pi.id = $1
        `, [req.params.payrollItemId]);
        if (!item) return res.status(404).json({ error: 'Payslip not found.' });

        const { rows: configRows } = await db.query("SELECT config_key, config_value FROM system_config");
        const configs = {};
        configRows.forEach(c => { configs[c.config_key] = c.config_value; });
        const schoolName = configs.school_name || 'EduPay School';
        const currency = configs.currency || 'UGX';

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=payslip_${item.employee_id}_${item.month}_${item.year}.pdf`);
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
        doc.text(`Salary Scale: ${item.salary_scale}`, 350, infoY);
        doc.text(`Pay Period: ${item.month}/${item.year}`, 350, infoY + 18);
        doc.text(`Payment Status: ${item.payment_status}`, 350, infoY + 36);

        let tableY = infoY + 70;
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
         ['Loan Deduction', item.loan_deduction], ['Other Deductions', item.other_deduction]].forEach(([label, val]) => {
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

// ============ STATS ============

router.get('/stats', async (req, res) => {
    try {
        const db = getDb();
        const [teachersR, payrollsR, pendingR, latestR, paidR] = await Promise.all([
            db.query("SELECT COUNT(*) as cnt FROM teachers WHERE is_active = true"),
            db.query("SELECT COUNT(*) as cnt FROM payroll"),
            db.query("SELECT COUNT(*) as cnt FROM payroll WHERE status IN ('draft','processed')"),
            db.query("SELECT * FROM payroll ORDER BY created_at DESC LIMIT 1"),
            db.query("SELECT COALESCE(SUM(total_net), 0) as total FROM payroll WHERE status IN ('approved','paid')"),
        ]);
        res.json({
            total_teachers:   parseInt(teachersR.rows[0].cnt) || 0,
            total_payrolls:   parseInt(payrollsR.rows[0].cnt) || 0,
            pending_payrolls: parseInt(pendingR.rows[0].cnt)  || 0,
            total_paid:       Number(paidR.rows[0].total)     || 0,
            latest_payroll:   latestR.rows[0] || null,
        });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch stats.' }); }
});

module.exports = router;
