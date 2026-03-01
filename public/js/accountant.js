// ============ Accountant Dashboard Logic ============

document.addEventListener('DOMContentLoaded', () => {
    if (!requireAuth('accountant')) return;
    initUserDisplay();
    loadAccDashboard();
    loadTeacherRecords();
    loadPayrollHistory();
    loadReports();

    // Set current month
    const now = new Date();
    document.getElementById('payrollMonth').value = now.getMonth() + 1;
});

// ============ DASHBOARD ============
async function loadAccDashboard() {
    try {
        const stats = await apiRequest('/accountant/stats');
        document.getElementById('statTeachers').textContent = stats.total_teachers;
        document.getElementById('statPayrolls').textContent = stats.total_payrolls;
        document.getElementById('statPending').textContent = stats.pending_payrolls;
        document.getElementById('statTotalPaid').textContent = formatCurrency(stats.total_paid);
    } catch (err) { console.error(err); }
}

// ============ TEACHER RECORDS ============
async function loadTeacherRecords() {
    try {
        const teachers = await apiRequest('/accountant/teachers');
        const tbody = document.getElementById('teacherRecordsBody');
        if (!teachers.length) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center" style="padding:32px;color:var(--text-light);">No teachers found</td></tr>';
            return;
        }
        tbody.innerHTML = teachers.map(t => {
            const housing   = parseFloat(t.housing_allowance)   || 0;
            const transport = parseFloat(t.transport_allowance) || 0;
            const medical   = parseFloat(t.medical_allowance)   || 0;
            const other     = parseFloat(t.other_allowance)     || 0;
            const totalAllowances = housing + transport + medical + other;

            const allowanceBreakdown = `
              <div class="salary-breakdown">
                <div class="breakdown-row"><span>Housing</span><span>${formatCurrency(housing)}</span></div>
                <div class="breakdown-row"><span>Transport</span><span>${formatCurrency(transport)}</span></div>
                <div class="breakdown-row"><span>Medical</span><span>${formatCurrency(medical)}</span></div>
                <div class="breakdown-row"><span>Other</span><span>${formatCurrency(other)}</span></div>
                <div class="breakdown-row breakdown-total"><span>Total</span><span>${formatCurrency(totalAllowances)}</span></div>
              </div>`;

            const deductionBreakdown = `
              <div class="salary-breakdown">
                <div class="breakdown-row"><span>Tax (PAYE)</span><span>${t.tax_percentage || 0}%</span></div>
                <div class="breakdown-row"><span>NSSF</span><span>${t.nssf_percentage || 0}%</span></div>
              </div>`;

            let paymentDetails = '-';
            if (t.payment_method === 'mobile_money') {
                paymentDetails = `<span class="badge badge-info">📱 Mobile Money</span><br><small>${t.mobile_money_provider || ''}</small><br><small>${t.mobile_money_number || ''}</small>`;
            } else if (t.bank_name || t.bank_account_number) {
                paymentDetails = `<span class="badge badge-success">🏦 Bank</span><br><small>${t.bank_name || ''}</small><br><small>${t.bank_account_number || ''}</small>`;
            } else {
                paymentDetails = `<span class="badge badge-gray">Not Set</span>`;
            }

            return `
        <tr>
          <td><strong>${t.employee_id}</strong></td>
          <td>${t.full_name}</td>
          <td>${t.position || '-'}</td>
          <td><span class="badge badge-info">${t.salary_scale}</span></td>
          <td>${formatCurrency(t.basic_salary)}</td>
          <td>${allowanceBreakdown}</td>
          <td>${deductionBreakdown}</td>
          <td>${paymentDetails}</td>
        </tr>
      `;
        }).join('');
    } catch (err) { showToast('Failed to load teachers', 'error'); }
}

// ============ PAYROLL ============
let allPayrolls = [];

async function loadPayrollHistory() {
    try {
        allPayrolls = await apiRequest('/accountant/payroll');
        renderPayrollHistory();
        populatePayrollDropdowns();
    } catch (err) { showToast('Failed to load payroll history', 'error'); }
}

function renderPayrollHistory() {
    const tbody = document.getElementById('payrollHistoryBody');
    if (!allPayrolls.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center" style="padding:32px;color:var(--text-light);">No payroll records</td></tr>';
        return;
    }
    tbody.innerHTML = allPayrolls.map(p => `
    <tr>
      <td><strong>${getMonthName(p.month)} ${p.year}</strong></td>
      <td>${p.teacher_count || '-'}</td>
      <td>${formatCurrency(p.total_gross)}</td>
      <td>${formatCurrency(p.total_deductions)}</td>
      <td>${formatCurrency(p.total_net)}</td>
      <td><span class="badge ${p.status === 'paid' ? 'badge-success' : p.status === 'approved' ? 'badge-info' : 'badge-warning'}">${p.status}</span></td>
      <td>
        <div class="action-btns">
          ${p.status === 'processed' ? `<button class="btn btn-sm btn-success" onclick="approvePayroll(${p.id})">✓ Approve</button>` : ''}
          <button class="btn btn-sm btn-secondary" onclick="viewPayrollDetails(${p.id})">View</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function populatePayrollDropdowns() {
    const options = allPayrolls
        .filter(p => p.status === 'approved' || p.status === 'paid')
        .map(p => `<option value="${p.id}">${getMonthName(p.month)} ${p.year} (${p.status})</option>`)
        .join('');

    const allOptions = allPayrolls
        .map(p => `<option value="${p.id}">${getMonthName(p.month)} ${p.year} (${p.status})</option>`)
        .join('');

    document.getElementById('payslipPayroll').innerHTML = '<option value="">Select Payroll Period</option>' + allOptions;
    document.getElementById('paymentPayroll').innerHTML = '<option value="">Select Payroll Period</option>' + allOptions;
}

async function processPayroll() {
    const month = document.getElementById('payrollMonth').value;
    const year = document.getElementById('payrollYear').value;

    if (!confirm(`Process payroll for ${getMonthName(parseInt(month))} ${year}?`)) return;

    try {
        const result = await apiRequest('/accountant/payroll/process', {
            method: 'POST',
            body: { month: parseInt(month), year: parseInt(year) }
        });
        showToast(`Payroll processed! ${result.teacher_count} teachers, Net: ${formatCurrency(result.total_net)}`);
        loadPayrollHistory();
        loadAccDashboard();
    } catch (err) { showToast(err.message, 'error'); }
}

async function approvePayroll(id) {
    if (!confirm('Approve this payroll? This will notify all teachers.')) return;
    try {
        await apiRequest(`/accountant/payroll/${id}/approve`, { method: 'POST' });
        showToast('Payroll approved & teachers notified');
        loadPayrollHistory();
        loadAccDashboard();
    } catch (err) { showToast(err.message, 'error'); }
}

async function viewPayrollDetails(id) {
    document.getElementById('payslipPayroll').value = id;
    switchSection('payslips');
    loadPayrollItems();
}

// ============ PAYSLIPS ============
async function loadPayrollItems() {
    const payrollId = document.getElementById('payslipPayroll').value;
    const tbody = document.getElementById('payslipItemsBody');
    if (!payrollId) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center" style="padding:32px;color:var(--text-light);">Select a payroll period</td></tr>';
        return;
    }
    try {
        const items = await apiRequest(`/accountant/payroll/${payrollId}/items`);
        if (!items.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center" style="padding:32px;color:var(--text-light);">No items</td></tr>';
            return;
        }
        tbody.innerHTML = items.map(i => `
      <tr>
        <td>${i.employee_id}</td>
        <td>${i.full_name}</td>
        <td>${formatCurrency(i.gross_salary)}</td>
        <td>${formatCurrency(i.total_deductions)}</td>
        <td><strong>${formatCurrency(i.net_salary)}</strong></td>
        <td><span class="badge ${i.payment_status === 'Paid' ? 'badge-success' : 'badge-warning'}">${i.payment_status}</span></td>
        <td><button class="btn btn-sm btn-primary" onclick="downloadPayslip(${i.id})">📄 PDF</button></td>
      </tr>
    `).join('');
    } catch (err) { showToast('Failed to load payroll items', 'error'); }
}

async function downloadPayslip(itemId) {
    try {
        await apiRequest(`/accountant/payslip/${itemId}/pdf`);
        showToast('Payslip downloaded');
    } catch (err) { showToast(err.message, 'error'); }
}

// ============ PAYMENT STATUS ============
async function loadPaymentItems() {
    const payrollId = document.getElementById('paymentPayroll').value;
    const tbody = document.getElementById('paymentItemsBody');
    if (!payrollId) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center" style="padding:32px;color:var(--text-light);">Select a payroll period</td></tr>';
        return;
    }
    try {
        const items = await apiRequest(`/accountant/payroll/${payrollId}/items`);
        if (!items.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center" style="padding:32px;color:var(--text-light);">No items</td></tr>';
            return;
        }
        tbody.innerHTML = items.map(i => `
      <tr>
        <td>${i.employee_id}</td>
        <td>${i.full_name}</td>
        <td><strong>${formatCurrency(i.net_salary)}</strong></td>
        <td><span class="badge ${i.payment_status === 'Paid' ? 'badge-success' : 'badge-warning'}">${i.payment_status}</span></td>
        <td>
          <button class="btn btn-sm ${i.payment_status === 'Paid' ? 'btn-warning' : 'btn-success'}" 
            onclick="togglePaymentStatus(${i.id}, '${i.payment_status === 'Paid' ? 'Pending' : 'Paid'}')">
            ${i.payment_status === 'Paid' ? 'Mark Pending' : 'Mark Paid'}
          </button>
        </td>
      </tr>
    `).join('');
    } catch (err) { showToast('Failed to load payment items', 'error'); }
}

async function togglePaymentStatus(itemId, newStatus) {
    try {
        await apiRequest(`/accountant/payroll-items/${itemId}/payment-status`, {
            method: 'PUT',
            body: { payment_status: newStatus }
        });
        showToast(`Payment marked as ${newStatus}`);
        loadPaymentItems();
        loadPayrollHistory();
    } catch (err) { showToast(err.message, 'error'); }
}

// ============ REPORTS ============
async function loadReports() {
    try {
        const month = document.getElementById('reportMonth')?.value || '';
        const year = document.getElementById('reportYear')?.value || '';
        let url = '/accountant/reports/monthly';
        if (month && year) url += `?month=${month}&year=${year}`;
        else if (year) url += `?year=${year}`;

        const reports = await apiRequest(url);
        const tbody = document.getElementById('reportsBody');
        if (!reports.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center" style="padding:32px;color:var(--text-light);">No reports found</td></tr>';
            return;
        }
        tbody.innerHTML = reports.map(r => `
      <tr>
        <td><strong>${getMonthName(r.month)} ${r.year}</strong></td>
        <td>${r.teacher_count || '-'}</td>
        <td>${formatCurrency(r.total_gross)}</td>
        <td>${formatCurrency(r.total_deductions)}</td>
        <td>${formatCurrency(r.total_net)}</td>
        <td><span class="badge ${r.status === 'paid' ? 'badge-success' : r.status === 'approved' ? 'badge-info' : 'badge-warning'}">${r.status}</span></td>
        <td>
          <div class="action-btns">
            <button class="btn btn-sm btn-primary" onclick="exportPDF(${r.id})">📄 PDF</button>
            <button class="btn btn-sm btn-success" onclick="exportExcel(${r.id})">📊 Excel</button>
          </div>
        </td>
      </tr>
    `).join('');
    } catch (err) { console.error(err); }
}

async function exportPDF(payrollId) {
    try {
        await apiRequest(`/accountant/reports/export/pdf/${payrollId}`);
        showToast('PDF report downloaded');
    } catch (err) { showToast(err.message, 'error'); }
}

async function exportExcel(payrollId) {
    try {
        await apiRequest(`/accountant/reports/export/excel/${payrollId}`);
        showToast('Excel report downloaded');
    } catch (err) { showToast(err.message, 'error'); }
}

// Update page title
const originalSwitchSection = switchSection;
switchSection = function (sectionId) {
    originalSwitchSection(sectionId);
    const titles = {
        dashboard: 'Dashboard',
        teachers: 'Teacher Records',
        payroll: 'Process Payroll',
        payslips: 'Payslip Management',
        payment: 'Payment Status',
        reports: 'Financial Reports'
    };
    document.getElementById('pageTitle').textContent = titles[sectionId] || 'Dashboard';
};
