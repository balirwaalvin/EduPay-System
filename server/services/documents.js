/**
 * PDF and Excel document generation.
 *
 * The payslip layout previously existed as two near-identical copies in the
 * teacher and accountant routes, so every change had to be made twice. There is
 * now one definition used by both.
 */
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

// One palette for the whole system; see services/brand.js. A payslip should
// look like the product that produced it.
const brand = require('./brand');

const BRAND = brand.brand;
const BRAND_DEEP = brand.brandDeep;
const BRAND_TINT = brand.brandTint;
const ACCENT = brand.accent;
const INK = brand.text;
const MUTED = brand.textMuted;
const RULE = brand.rule;

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

const monthName = (m) => MONTHS[Number(m)] || String(m ?? '');
const money = (value, currency) => `${currency} ${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** Payment destination lines, varying by payment method. */
function paymentLines(item) {
    if (item.paymentMethod === 'mobile_money') {
        return [
            ['Payment method', 'Mobile money'],
            ['Provider', item.mobileMoneyProvider || 'Not set'],
            ['Mobile number', item.mobileMoneyNumber || 'Not set']
        ];
    }
    return [
        ['Payment method', 'Bank transfer'],
        ['Bank', item.bankName || 'Not set'],
        ['Account name', item.bankAccountName || 'Not set'],
        ['Account number', item.bankAccountNumber || 'Not set']
    ];
}

/**
 * Stream a single payslip as a PDF to an Express response.
 * @param {import('express').Response} res
 * @param {object} item   payroll item joined with teacher and period fields
 * @param {object} config system config (schoolName, currency)
 */
function streamPayslipPdf(res, item, config = {}) {
    const currency = config.currency || 'UGX';
    const schoolName = config.schoolName || 'EduPay School';

    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
        'Content-Disposition',
        `attachment; filename="payslip_${item.employeeId || 'employee'}_${item.month}_${item.year}.pdf"`
    );
    doc.pipe(res);

    const pageWidth = doc.page.width;
    const left = 48;
    const right = pageWidth - 48;
    const contentWidth = right - left;

    // Header band
    doc.rect(0, 0, pageWidth, 84).fill(BRAND);
    doc.font('Helvetica-Bold').fontSize(21).fillColor('#FFFFFF').text(schoolName, left, 24, { width: contentWidth - 120 });
    doc.font('Helvetica').fontSize(10).fillColor('#FEE2E2').text('Payslip', left, 52);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#FFFFFF')
        .text(`${monthName(item.month)} ${item.year}`, left, 48, { width: contentWidth, align: 'right' });

    // Employee / payment details, two columns
    let y = 108;
    const colGap = 18;
    const colWidth = (contentWidth - colGap) / 2;

    const detailBlock = (x, startY, heading, rows) => {
        doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(heading.toUpperCase(), x, startY, { characterSpacing: 0.6 });
        let rowY = startY + 14;
        rows.forEach(([label, value]) => {
            doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(label, x, rowY, { width: colWidth * 0.45 });
            doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
                .text(String(value ?? '-'), x + colWidth * 0.45, rowY, { width: colWidth * 0.55 });
            rowY += 15;
        });
        return rowY;
    };

    const leftEnd = detailBlock(left, y, 'Employee', [
        ['Name', item.teacherName || item.fullName],
        ['Employee ID', item.employeeId],
        ['Position', item.position || 'Not set'],
        ['Salary scale', item.salaryScale]
    ]);
    const rightEnd = detailBlock(left + colWidth + colGap, y, 'Payment', [
        ['Pay period', `${monthName(item.month)} ${item.year}`],
        ['Status', item.paymentStatus || 'Pending'],
        ...paymentLines(item).slice(0, 3)
    ]);

    y = Math.max(leftEnd, rightEnd) + 10;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.7).strokeColor(RULE).stroke();
    y += 16;

    // Earnings / deductions tables
    const amountX = right - 150;
    const sectionHeading = (text, atY) => {
        doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND).text(text, left, atY);
        return atY + 17;
    };
    const lineItem = (label, value, atY, opts = {}) => {
        doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(opts.muted ? MUTED : INK)
            .text(label, left + 6, atY, { width: amountX - left - 20 });
        doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(opts.muted ? MUTED : INK)
            .text(money(value, currency), amountX, atY, { width: 150, align: 'right' });
        return atY + 15;
    };
    const subtotal = (label, value, atY) => {
        doc.moveTo(left, atY).lineTo(right, atY).lineWidth(0.7).strokeColor(RULE).stroke();
        return lineItem(label, value, atY + 6, { bold: true }) + 8;
    };

    y = sectionHeading('Earnings', y);
    y = lineItem('Basic salary', item.basicSalary, y);
    if (Number(item.unpaidLeaveDeduction) > 0) {
        doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED).text(
            `Abated for ${item.unpaidLeaveDays} day(s) unpaid leave `
            + `(contractual ${money(item.contractualBasicSalary, currency)})`,
            left + 6, y, { width: amountX - left - 20 }
        );
        y += 12;
    }
    y = lineItem('Housing allowance', item.housingAllowance, y);
    y = lineItem('Transport allowance', item.transportAllowance, y);
    y = lineItem('Medical allowance', item.medicalAllowance, y);
    y = lineItem('Other allowance', item.otherAllowance, y);
    y = subtotal('Gross salary', item.grossSalary, y);

    y = sectionHeading('Deductions', y);
    y = lineItem('PAYE', item.taxAmount, y);
    y = lineItem('NSSF (employee 5%)', item.nssfAmount, y);
    y = lineItem('Loan repayment', item.loanDeduction, y);
    y = lineItem('Salary advance', item.advanceDeduction, y);
    if (Number(item.advanceDeferred) > 0) {
        doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED).text(
            `${money(item.advanceDeferred, currency)} carried to the next payroll to protect your minimum net pay`,
            left + 6, y, { width: amountX - left - 20 }
        );
        y += 12;
    }
    y = lineItem('Other deductions', item.otherDeduction, y);
    y = subtotal('Total deductions', item.totalDeductions, y);

    // Net pay panel
    y += 4;
    doc.roundedRect(left, y, contentWidth, 42, 6).fill(BRAND_TINT);
    // A secondary-coloured rule down the edge. On a payslip net pay is the line
    // that matters, and the brand's accent is what marks it.
    doc.roundedRect(left, y, 4, 42, 2).fill(ACCENT);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text('NET PAY', left + 20, y + 15);
    doc.font('Helvetica-Bold').fontSize(16).fillColor(BRAND_DEEP)
        .text(money(item.netSalary, currency), amountX - 40, y + 12, { width: 190, align: 'right' });
    y += 58;

    // Employer contributions, for information only
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('EMPLOYER CONTRIBUTIONS (NOT DEDUCTED)', left, y, { characterSpacing: 0.6 });
    y += 13;
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
        .text(`NSSF employer share (10%): ${money(item.nssfEmployerAmount, currency)}`, left + 6, y);
    y += 13;
    doc.text(`Total cost of employment: ${money(item.employerCost, currency)}`, left + 6, y);

    // Footer
    doc.font('Helvetica').fontSize(7.5).fillColor('#9CA3AF').text(
        `Computer-generated payslip — no signature required. Issued ${new Date().toLocaleDateString('en-GB')}.`,
        left, doc.page.height - 62, { width: contentWidth, align: 'center' }
    );

    doc.end();
}

/** Stream a whole payroll run as a landscape PDF summary. */
function streamPayrollPdf(res, payrollRun, items, config = {}) {
    const currency = config.currency || 'UGX';
    const schoolName = config.schoolName || 'EduPay School';

    const doc = new PDFDocument({ margin: 28, size: 'A4', layout: 'landscape' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="payroll_${payrollRun.month}_${payrollRun.year}.pdf"`);
    doc.pipe(res);

    const left = 28;
    const right = doc.page.width - 28;

    doc.font('Helvetica-Bold').fontSize(16).fillColor(BRAND).text(`${schoolName} — Payroll Report`, left, 30, { align: 'center', width: right - left });
    doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(
        `${monthName(payrollRun.month)} ${payrollRun.year}   ·   Status: ${payrollRun.status}   ·   ${items.length} employee(s)`,
        left, 50, { align: 'center', width: right - left }
    );
    doc.fontSize(9).fillColor(INK).text(
        `Gross ${money(payrollRun.totalGross, currency)}    Deductions ${money(payrollRun.totalDeductions, currency)}    `
        + `Net ${money(payrollRun.totalNet, currency)}    Employer cost ${money(payrollRun.totalEmployerCost, currency)}`,
        left, 66, { align: 'center', width: right - left }
    );

    const cols = [
        { key: 'index', label: '#', width: 22, align: 'left' },
        { key: 'employeeId', label: 'Emp ID', width: 56 },
        { key: 'teacherName', label: 'Name', width: 112 },
        { key: 'salaryScale', label: 'Scale', width: 50 },
        { key: 'basicSalary', label: 'Basic', width: 64, num: true },
        { key: 'grossSalary', label: 'Gross', width: 64, num: true },
        { key: 'taxAmount', label: 'PAYE', width: 56, num: true },
        { key: 'nssfAmount', label: 'NSSF', width: 52, num: true },
        { key: 'loanDeduction', label: 'Loan', width: 52, num: true },
        { key: 'advanceDeduction', label: 'Advance', width: 56, num: true },
        { key: 'otherDeduction', label: 'Other', width: 52, num: true },
        { key: 'totalDeductions', label: 'Total ded.', width: 62, num: true },
        { key: 'netSalary', label: 'Net', width: 66, num: true },
        { key: 'paymentStatus', label: 'Status', width: 48 }
    ];

    const headerRow = (atY) => {
        let x = left;
        cols.forEach(c => {
            doc.rect(x, atY, c.width, 16).fill(BRAND);
            doc.font('Helvetica-Bold').fontSize(6.8).fillColor('#FFFFFF')
                .text(c.label, x + 3, atY + 5, { width: c.width - 6, align: c.num ? 'right' : 'left' });
            x += c.width;
        });
        return atY + 16;
    };

    let y = headerRow(88);

    items.forEach((item, idx) => {
        if (y > doc.page.height - 50) {
            doc.addPage();
            y = headerRow(28);
        }

        let x = left;
        const shade = idx % 2 === 0 ? '#FAFAFA' : '#FFFFFF';
        cols.forEach(c => {
            doc.rect(x, y, c.width, 14).fill(shade);
            const raw = c.key === 'index' ? idx + 1 : item[c.key];
            const text = c.num ? Number(raw || 0).toLocaleString() : String(raw ?? '-');
            doc.font('Helvetica').fontSize(6.8).fillColor(INK)
                .text(text, x + 3, y + 4, { width: c.width - 6, align: c.num ? 'right' : 'left', ellipsis: true, lineBreak: false });
            x += c.width;
        });
        y += 14;
    });

    doc.end();
}

/** Write a whole payroll run to an Excel workbook on the response stream. */
async function streamPayrollExcel(res, payrollRun, items, config = {}) {
    const currency = config.currency || 'UGX';
    const schoolName = config.schoolName || 'EduPay School';

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'EduPay';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet(`Payroll ${payrollRun.month}-${payrollRun.year}`, {
        views: [{ state: 'frozen', ySplit: 4 }]
    });

    const headers = [
        '#', 'Employee ID', 'Name', 'Scale', 'Basic', 'Housing', 'Transport', 'Medical', 'Other allow.',
        'Gross', 'PAYE', 'NSSF (employee)', 'Loan', 'Advance', 'Unpaid leave days', 'Other ded.',
        'Total ded.', 'Net', 'NSSF (employer)', 'Employer cost', 'Payment status'
    ];

    sheet.mergeCells(1, 1, 1, headers.length);
    sheet.getCell('A1').value = `${schoolName} — Payroll Report`;
    sheet.getCell('A1').font = { size: 15, bold: true };

    sheet.mergeCells(2, 1, 2, headers.length);
    sheet.getCell('A2').value =
        `${monthName(payrollRun.month)} ${payrollRun.year}  ·  Status: ${payrollRun.status}  ·  `
        + `Gross ${money(payrollRun.totalGross, currency)}  ·  Net ${money(payrollRun.totalNet, currency)}  ·  `
        + `Employer cost ${money(payrollRun.totalEmployerCost, currency)}`;
    sheet.getCell('A2').font = { size: 10, color: { argb: 'FF6B7280' } };

    sheet.addRow([]);

    const headerRow = sheet.addRow(headers);
    headerRow.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brand.argb(brand.brand) } };
        cell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 10 };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = { bottom: { style: 'thin', color: { argb: brand.argb(brand.brandDeep) } } };
    });

    items.forEach((item, i) => {
        sheet.addRow([
            i + 1, item.employeeId, item.teacherName, item.salaryScale,
            Number(item.basicSalary || 0), Number(item.housingAllowance || 0),
            Number(item.transportAllowance || 0), Number(item.medicalAllowance || 0),
            Number(item.otherAllowance || 0), Number(item.grossSalary || 0),
            Number(item.taxAmount || 0), Number(item.nssfAmount || 0),
            Number(item.loanDeduction || 0), Number(item.advanceDeduction || 0),
            Number(item.unpaidLeaveDays || 0), Number(item.otherDeduction || 0),
            Number(item.totalDeductions || 0), Number(item.netSalary || 0),
            Number(item.nssfEmployerAmount || 0), Number(item.employerCost || 0),
            item.paymentStatus || 'Pending'
        ]);
    });

    // Totals row
    const firstDataRow = 5;
    const lastDataRow = firstDataRow + items.length - 1;
    if (items.length) {
        const totals = sheet.addRow([
            '', '', 'TOTAL', '',
            ...['E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T']
                .map(c => ({ formula: `SUM(${c}${firstDataRow}:${c}${lastDataRow})` })),
            ''
        ]);
        totals.font = { bold: true };
        totals.eachCell(cell => {
            cell.border = { top: { style: 'double', color: { argb: 'FF9CA3AF' } } };
        });
    }

    // Currency formatting on the money columns
    const moneyCols = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20];
    moneyCols.forEach(idx => {
        sheet.getColumn(idx).numFmt = '#,##0.00';
        sheet.getColumn(idx).alignment = { horizontal: 'right' };
    });

    sheet.columns.forEach((col, i) => {
        col.width = i === 2 ? 26 : i === 1 ? 14 : Math.max(11, headers[i].length + 3);
    });

    sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: headers.length } };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="payroll_${payrollRun.month}_${payrollRun.year}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
}

module.exports = { streamPayslipPdf, streamPayrollPdf, streamPayrollExcel, monthName, money };
