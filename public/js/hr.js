// ============ HR Dashboard Logic ============

document.addEventListener('DOMContentLoaded', () => {
    if (!requireAuth('hr')) return;
    startSessionTimeout();
    initUserDisplay();
    loadDashboard();
    loadTeachers();
    loadAdvanceRequests();
    loadSalaryStructures();
    loadReports();
});

// ============ DASHBOARD ============
async function loadDashboard() {
    try {
        const stats = await apiRequest('/hr/stats');
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        set('statTeachers', stats.total_teachers);
        set('statPendingLeave', stats.pending_leave);
        set('statPendingAdvances', stats.pending_advances);
        set('statPayrolls', stats.total_payrolls);
        if (stats.recent_payroll) {
            set('statLatestPayroll', `${getMonthName(stats.recent_payroll.month)} ${stats.recent_payroll.year}`);
        }
    } catch (err) {
        console.error('Dashboard error:', err);
        showToast('Failed to load dashboard stats', 'error');
    }
}

// ============ TEACHERS ============
let allTeachers = [];

async function loadTeachers() {
    try {
        allTeachers = await apiRequest('/hr/teachers');
        renderTeachersTable();
    } catch (err) { showToast('Failed to load teachers', 'error'); }
}

function renderTeachersTable() {
    const tbody = document.getElementById('teachersTableBody');
    if (!allTeachers.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center" style="padding:32px;color:var(--text-light);">No teachers found</td></tr>';
        return;
    }
    tbody.innerHTML = allTeachers.map(t => {
        let paymentInfo = '-';
        if (t.payment_method === 'mobile_money') {
            paymentInfo = `<span class="badge badge-info">📱 Mobile Money</span><br><small>${t.mobile_money_provider || ''}: ${t.mobile_money_number || ''}</small>`;
        } else if (t.payment_method === 'bank' || t.bank_name || t.bank_account_number) {
            paymentInfo = `<span class="badge badge-success">🏦 Bank</span><br><small>${t.bank_name || ''}: ${t.bank_account_number || ''}</small>`;
        }
        return `
    <tr>
      <td><strong>${t.employee_id}</strong></td>
      <td>${t.full_name}</td>
      <td>${t.position || '-'}</td>
      <td><span class="badge badge-info">${t.salary_scale}</span></td>
      <td>${t.phone || '-'}</td>
      <td>${t.email || '-'}</td>
      <td>${paymentInfo}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-sm btn-secondary" onclick="editTeacher(${t.id})">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteTeacher(${t.id})">Delete</button>
        </div>
      </td>
    </tr>
  `;
    }).join('');
}

function toggleTeacherPaymentFields() {
    const method = document.getElementById('teacherPaymentMethod').value;
    document.getElementById('teacherBankFields').style.display = method === 'bank' ? '' : 'none';
    document.getElementById('teacherMobileFields').style.display = method === 'mobile_money' ? '' : 'none';
}

async function showCreateTeacherModal() {
    document.getElementById('teacherModalTitle').textContent = 'Add New Teacher';
    document.getElementById('editTeacherId').value = '';
    document.getElementById('teacherForm').reset();
    const usernameInput = document.getElementById('teacherUsername');
    usernameInput.disabled = false;
    usernameInput.placeholder = 'Leave blank to auto-generate';
    document.getElementById('teacherUsernameHint').textContent = '';
    document.getElementById('teacherPaymentMethod').value = 'bank';
    document.getElementById('teacherBankName').value = '';
    document.getElementById('teacherBankAccountName').value = '';
    document.getElementById('teacherBankAccountNumber').value = '';
    document.getElementById('teacherMobileProvider').value = 'MTN Mobile Money';
    document.getElementById('teacherMobileNumber').value = '';
    toggleTeacherPaymentFields();
    await loadSalaryScalesDropdown();
    openModal('teacherModal');
}

async function editTeacher(id) {
    const teacher = allTeachers.find(t => t.id === id);
    if (!teacher) return;
    await loadSalaryScalesDropdown();
    document.getElementById('teacherModalTitle').textContent = 'Edit Teacher';
    document.getElementById('editTeacherId').value = id;
    document.getElementById('teacherFullName').value = teacher.full_name;
    document.getElementById('teacherPosition').value = teacher.position || '';
    document.getElementById('teacherSalaryScale').value = teacher.salary_scale;
    document.getElementById('teacherEmail').value = teacher.email || '';
    document.getElementById('teacherPhone').value = teacher.phone || '';
    document.getElementById('teacherDateJoined').value = teacher.date_joined || '';
    // Payment method
    const pm = teacher.payment_method || 'bank';
    document.getElementById('teacherPaymentMethod').value = pm;
    document.getElementById('teacherBankName').value = teacher.bank_name || '';
    document.getElementById('teacherBankAccountName').value = teacher.bank_account_name || '';
    document.getElementById('teacherBankAccountNumber').value = teacher.bank_account_number || '';
    document.getElementById('teacherMobileProvider').value = teacher.mobile_money_provider || 'MTN Mobile Money';
    document.getElementById('teacherMobileNumber').value = teacher.mobile_money_number || '';
    toggleTeacherPaymentFields();
    const usernameInput = document.getElementById('teacherUsername');
    usernameInput.value = teacher.username || '';
    usernameInput.disabled = true;
    document.getElementById('teacherUsernameHint').textContent = '(cannot be changed after creation)';
    openModal('teacherModal');
}

async function saveTeacher() {
    const editId = document.getElementById('editTeacherId').value;
    const usernameVal = document.getElementById('teacherUsername').value.trim();
    const pm = document.getElementById('teacherPaymentMethod').value;
    const data = {
        full_name: document.getElementById('teacherFullName').value,
        position: document.getElementById('teacherPosition').value,
        salary_scale: document.getElementById('teacherSalaryScale').value,
        email: document.getElementById('teacherEmail').value,
        phone: document.getElementById('teacherPhone').value,
        date_joined: document.getElementById('teacherDateJoined').value,
        payment_method: pm,
    };
    if (pm === 'bank') {
        data.bank_name = document.getElementById('teacherBankName').value.trim();
        data.bank_account_name = document.getElementById('teacherBankAccountName').value.trim();
        data.bank_account_number = document.getElementById('teacherBankAccountNumber').value.trim();
        if (!data.bank_name || !data.bank_account_name || !data.bank_account_number) {
            showToast('Bank name, account name, and account number are required for bank payments', 'error');
            return;
        }
    } else {
        data.mobile_money_provider = document.getElementById('teacherMobileProvider').value;
        data.mobile_money_number = document.getElementById('teacherMobileNumber').value.trim();
        if (!data.mobile_money_number) {
            showToast('Mobile money number is required', 'error');
            return;
        }
    }
    if (!editId && usernameVal) data.username = usernameVal;

    if (!data.full_name || !data.salary_scale) {
        showToast('Full name and salary scale are required', 'error');
        return;
    }

    try {
        if (editId) {
            await apiRequest(`/hr/teachers/${editId}`, { method: 'PUT', body: data });
            showToast('Teacher updated successfully');
        } else {
            const result = await apiRequest('/hr/teachers', { method: 'POST', body: data });
            showToast(`Teacher added! Username: ${result.teacher.username}, Default password: teacher123`);
        }
        closeModal('teacherModal');
        loadTeachers();
        loadDashboard();
    } catch (err) { showToast(err.message, 'error'); }
}

async function deleteTeacher(id) {
    if (!confirm('Are you sure you want to remove this teacher? This will also delete their user account.')) return;
    try {
        await apiRequest(`/hr/teachers/${id}`, { method: 'DELETE' });
        showToast('Teacher removed');
        loadTeachers();
        loadDashboard();
    } catch (err) { showToast(err.message, 'error'); }
}

// ============ SALARY STRUCTURES ============
let allSalaryStructures = [];

async function loadSalaryStructures() {
    try {
        allSalaryStructures = await apiRequest('/hr/salary-structures');
        renderSalaryTable();
    } catch (err) { showToast('Failed to load salary structures', 'error'); }
}

function renderSalaryTable() {
    const tbody = document.getElementById('salaryTableBody');
    if (!allSalaryStructures.length) {
        tbody.innerHTML = '<tr><td colspan="10" class="text-center" style="padding:32px;color:var(--text-light);">No salary structures found</td></tr>';
        return;
    }
    tbody.innerHTML = allSalaryStructures.map(s => `
    <tr>
      <td><strong>${s.salary_scale}</strong></td>
      <td>${formatCurrency(s.basic_salary)}</td>
      <td>${formatCurrency(s.housing_allowance)}</td>
      <td>${formatCurrency(s.transport_allowance)}</td>
      <td>${formatCurrency(s.medical_allowance)}</td>
      <td>${formatCurrency(s.other_allowance)}</td>
      <td>${s.tax_percentage}%</td>
      <td>${s.nssf_percentage}%</td>
      <td>${formatCurrency(s.loan_deduction)}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-sm btn-secondary" onclick="editSalaryStructure('${s.salary_scale}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteSalaryStructure(${s.id})">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
}

async function loadSalaryScalesDropdown() {
    try {
        if (!allSalaryStructures.length) {
            allSalaryStructures = await apiRequest('/hr/salary-structures');
        }
        const select = document.getElementById('teacherSalaryScale');
        select.innerHTML = allSalaryStructures.map(s =>
            `<option value="${s.salary_scale}">${s.salary_scale} (${formatCurrency(s.basic_salary)})</option>`
        ).join('');
    } catch (err) { console.error(err); }
}

function showSalaryModal(scale) {
    document.getElementById('salaryForm').reset();
    if (scale) {
        const s = allSalaryStructures.find(x => x.salary_scale === scale);
        if (s) {
            document.getElementById('salaryScale').value = s.salary_scale;
            document.getElementById('salaryBasic').value = s.basic_salary;
            document.getElementById('salaryHousing').value = s.housing_allowance;
            document.getElementById('salaryTransport').value = s.transport_allowance;
            document.getElementById('salaryMedical').value = s.medical_allowance;
            document.getElementById('salaryOther').value = s.other_allowance;
            document.getElementById('salaryTax').value = s.tax_percentage;
            document.getElementById('salaryNSSF').value = s.nssf_percentage;
            document.getElementById('salaryLoan').value = s.loan_deduction;
            document.getElementById('salaryOtherDed').value = s.other_deduction;
        }
    }
    openModal('salaryModal');
}

function editSalaryStructure(scale) {
    showSalaryModal(scale);
}

async function saveSalaryStructure() {
    const data = {
        salary_scale: document.getElementById('salaryScale').value,
        basic_salary: parseFloat(document.getElementById('salaryBasic').value) || 0,
        housing_allowance: parseFloat(document.getElementById('salaryHousing').value) || 0,
        transport_allowance: parseFloat(document.getElementById('salaryTransport').value) || 0,
        medical_allowance: parseFloat(document.getElementById('salaryMedical').value) || 0,
        other_allowance: parseFloat(document.getElementById('salaryOther').value) || 0,
        tax_percentage: parseFloat(document.getElementById('salaryTax').value) || 0,
        nssf_percentage: parseFloat(document.getElementById('salaryNSSF').value) || 5,
        loan_deduction: parseFloat(document.getElementById('salaryLoan').value) || 0,
        other_deduction: parseFloat(document.getElementById('salaryOtherDed').value) || 0,
    };

    if (!data.salary_scale) {
        showToast('Salary scale name is required', 'error');
        return;
    }

    try {
        await apiRequest('/hr/salary-structures', { method: 'POST', body: data });
        showToast('Salary structure saved');
        closeModal('salaryModal');
        loadSalaryStructures();
    } catch (err) { showToast(err.message, 'error'); }
}

async function deleteSalaryStructure(id) {
    if (!confirm('Delete this salary structure?')) return;
    try {
        await apiRequest(`/hr/salary-structures/${id}`, { method: 'DELETE' });
        showToast('Salary structure deleted');
        loadSalaryStructures();
    } catch (err) { showToast(err.message, 'error'); }
}

// ============ LEAVE REQUESTS ============
async function loadLeaveRequests() {
    try {
        const leaves = await apiRequest('/hr/leave');
        const tbody = document.getElementById('leaveTableBody');
        if (!leaves.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center" style="padding:32px;color:var(--text-light);">No leave requests found</td></tr>';
            return;
        }
        tbody.innerHTML = leaves.map(l => {
            let badgeClass = 'badge-warning';
            if (l.status === 'Approved') badgeClass = 'badge-success';
            if (l.status === 'Rejected') badgeClass = 'badge-danger';

            let actions = '-';
            if (l.status === 'Pending') {
                actions = `
                <div class="action-btns">
                    <button class="btn btn-sm btn-success" onclick="updateLeaveStatus(${l.id}, 'Approved')">Approve</button>
                    <button class="btn btn-sm btn-danger" onclick="updateLeaveStatus(${l.id}, 'Rejected')">Reject</button>
                </div>
                `;
            }

            return `
            <tr>
                <td><strong>${l.full_name}</strong><br><small style="color:var(--text-secondary);">${l.employee_id}</small></td>
                <td><span class="badge badge-info">${l.leave_type}</span></td>
                <td style="white-space:nowrap;">${formatDate(l.start_date)} - ${formatDate(l.end_date)}</td>
                <td style="max-width:300px; white-space:normal;">${l.reason}</td>
                <td><span class="badge ${badgeClass}">${l.status}</span></td>
                <td>${actions}</td>
            </tr>
            `;
        }).join('');
    } catch (err) { showToast('Failed to load leave requests', 'error'); }
}

async function updateLeaveStatus(id, status) {
    if (!confirm(`Are you sure you want to ${status.toLowerCase()} this leave request?`)) return;
    try {
        await apiRequest(`/hr/leave/${id}/status`, {
            method: 'PUT',
            body: { status }
        });
        showToast(`Leave request ${status.toLowerCase()} successfully`);
        loadLeaveRequests();
        loadDashboard();
    } catch (err) { showToast(err.message, 'error'); }
}

// ============ ADVANCE REQUESTS ============
async function loadAdvanceRequests() {
    try {
        const advances = await apiRequest('/hr/advances');
        const tbody = document.getElementById('advancesTableBody');
        if (!tbody) return;

        if (!advances.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center" style="padding:32px;color:var(--text-light);">No advance requests found</td></tr>';
            return;
        }

        tbody.innerHTML = advances.map(a => {
            let badgeClass = 'badge-warning';
            if (a.status === 'Approved') badgeClass = 'badge-success';
            if (a.status === 'Rejected') badgeClass = 'badge-danger';
            if (a.status === 'Deducted') badgeClass = 'badge-info';

            let actions = '-';
            if (a.status === 'Pending') {
                actions = `
                <div class="action-btns">
                    <button class="btn btn-sm btn-success" onclick="updateAdvanceStatus(${a.id}, 'Approved')">Approve</button>
                    <button class="btn btn-sm btn-danger" onclick="updateAdvanceStatus(${a.id}, 'Rejected')">Reject</button>
                </div>
                `;
            }

            return `
            <tr>
                <td><strong>${a.full_name}</strong><br><small style="color:var(--text-secondary);">${a.employee_id}</small></td>
                <td>${formatDate(a.created_at)}</td>
                <td><strong>${formatCurrency(a.amount)}</strong></td>
                <td style="max-width:300px; white-space:normal;">${a.reason || '-'}</td>
                <td><span class="badge ${badgeClass}">${a.status}</span></td>
                <td>${actions}</td>
            </tr>
            `;
        }).join('');
    } catch (err) { showToast('Failed to load advance requests', 'error'); }
}

async function updateAdvanceStatus(id, status) {
    if (!confirm(`Are you sure you want to ${status.toLowerCase()} this advance request?`)) return;
    try {
        await apiRequest(`/hr/advances/${id}/status`, {
            method: 'PUT',
            body: { status }
        });
        showToast(`Advance request ${status.toLowerCase()} successfully`);
        loadAdvanceRequests();
        loadDashboard();
    } catch (err) { showToast(err.message, 'error'); }
}

// ============ REPORTS ============
async function loadReports() {
    try {
        const reports = await apiRequest('/hr/reports/payroll-summary');
        const tbody = document.getElementById('reportsTableBody');
        if (!reports.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center" style="padding:32px;color:var(--text-light);">No payroll records yet</td></tr>';
            return;
        }
        tbody.innerHTML = reports.map(r => {
            const actionCell = r.status === 'processed'
                ? `<button class="btn btn-sm btn-success" onclick="approvePayrollByHr(${r.id})">Approve Payroll</button>`
                : '<span style="color:var(--text-secondary);">-</span>';

            return `
      <tr>
        <td><strong>${getMonthName(r.month)} ${r.year}</strong></td>
        <td>${r.teacher_count}</td>
        <td>${formatCurrency(r.total_gross)}</td>
        <td>${formatCurrency(r.total_deductions)}</td>
        <td>${formatCurrency(r.total_net)}</td>
        <td><span class="badge ${r.status === 'paid' ? 'badge-success' : r.status === 'approved' ? 'badge-info' : 'badge-warning'}">${r.status}</span></td>
        <td>${actionCell}</td>
      </tr>
    `;
        }).join('');
    } catch (err) { console.error('Reports error:', err); }
}

async function approvePayrollByHr(payrollId) {
    if (!confirm('Approve this processed payroll? Teachers will be notified immediately.')) return;
    try {
        await apiRequest(`/hr/payroll/${payrollId}/approve`, { method: 'POST' });
        showToast('Payroll approved successfully');
        loadReports();
        loadDashboard();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ============ CHANGE PASSWORD ============
async function changePassword() {
    const currentPwd = document.getElementById('currentPwd').value;
    const newPwd = document.getElementById('newPwd').value;
    if (!currentPwd || !newPwd) {
        showToast('Both fields are required', 'error');
        return;
    }
    try {
        await apiRequest('/auth/change-password', {
            method: 'POST',
            body: { current_password: currentPwd, new_password: newPwd }
        });
        showToast('Password changed successfully');
        document.getElementById('currentPwd').value = '';
        document.getElementById('newPwd').value = '';
    } catch (err) { showToast(err.message, 'error'); }
}

// Update page title on section switch
const originalSwitchSection = switchSection;
switchSection = function (sectionId) {
    originalSwitchSection(sectionId);
    const titles = {
        dashboard: 'Dashboard',
        teachers: 'Teacher Management',
        leave: 'Leave Requests Management',
        advances: 'Advance Requests Management',
        salary: 'Salary Structure',
        reports: 'Reports & Monitoring',
        security: 'Security Control'
    };
    document.getElementById('pageTitle').textContent = titles[sectionId] || 'Dashboard';
};
