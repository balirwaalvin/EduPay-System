// ============ Admin Dashboard Logic ============

document.addEventListener('DOMContentLoaded', () => {
    if (!requireAuth('admin')) return;
    initUserDisplay();
    loadDashboard();
    loadUsers();
    loadTeachers();
    loadSalaryStructures();
    loadConfig();
    loadReports();
    loadAuditLog();
});

// ============ DASHBOARD ============
async function loadDashboard() {
    try {
        const stats = await apiRequest('/admin/stats');
        document.getElementById('statUsers').textContent = stats.total_users;
        document.getElementById('statTeachers').textContent = stats.total_teachers;
        document.getElementById('statPayrolls').textContent = stats.total_payrolls;
        if (stats.recent_payroll) {
            document.getElementById('statLatestPayroll').textContent =
                `${getMonthName(stats.recent_payroll.month)} ${stats.recent_payroll.year}`;
        }
    } catch (err) { console.error('Dashboard error:', err); }
}

// ============ USERS ============
let allUsers = [];

async function loadUsers() {
    try {
        allUsers = await apiRequest('/admin/users');
        renderUsersTable();
    } catch (err) { showToast('Failed to load users', 'error'); }
}

function renderUsersTable() {
    const tbody = document.getElementById('usersTableBody');
    if (!allUsers.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center" style="padding:32px;color:var(--text-light);">No users found</td></tr>';
        return;
    }
    tbody.innerHTML = allUsers.map(u => `
    <tr>
      <td><strong>${u.username}</strong></td>
      <td>${u.full_name}</td>
      <td><span class="badge ${u.role === 'admin' ? 'badge-danger' : u.role === 'accountant' ? 'badge-info' : 'badge-success'}">${u.role}</span></td>
      <td>${u.email || '-'}</td>
      <td><span class="badge ${u.is_active ? 'badge-success' : 'badge-gray'}">${u.is_active ? 'Active' : 'Inactive'}</span></td>
      <td>${formatDate(u.created_at)}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-sm btn-secondary" onclick="editUser(${u.id})">Edit</button>
          <button class="btn btn-sm ${u.is_active ? 'btn-warning' : 'btn-success'}" onclick="toggleUserStatus(${u.id})">${u.is_active ? 'Deactivate' : 'Activate'}</button>
          <button class="btn btn-sm btn-secondary" onclick="showResetPwdModal(${u.id})">🔑</button>
          <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id})">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function showCreateUserModal() {
    document.getElementById('userModalTitle').textContent = 'Add New User';
    document.getElementById('editUserId').value = '';
    document.getElementById('userForm').reset();
    document.getElementById('passwordGroup').style.display = 'block';
    openModal('userModal');
}

function editUser(id) {
    const user = allUsers.find(u => u.id === id);
    if (!user) return;
    document.getElementById('userModalTitle').textContent = 'Edit User';
    document.getElementById('editUserId').value = id;
    document.getElementById('userFullName').value = user.full_name;
    document.getElementById('userUsername').value = user.username;
    document.getElementById('userUsername').disabled = true;
    document.getElementById('passwordGroup').style.display = 'none';
    document.getElementById('userRole').value = user.role;
    document.getElementById('userEmail').value = user.email || '';
    document.getElementById('userPhone').value = user.phone || '';
    openModal('userModal');
}

async function saveUser() {
    const editId = document.getElementById('editUserId').value;
    const data = {
        full_name: document.getElementById('userFullName').value.trim(),
        username: document.getElementById('userUsername').value.trim(),
        role: document.getElementById('userRole').value,
        email: document.getElementById('userEmail').value.trim(),
        phone: document.getElementById('userPhone').value.trim(),
    };

    if (!data.full_name || !data.username) {
        showToast('Full name and username are required', 'error');
        return;
    }

    try {
        if (editId) {
            await apiRequest(`/admin/users/${editId}`, { method: 'PUT', body: data });
            showToast('User updated successfully');
        } else {
            data.password = document.getElementById('userPassword').value;
            if (!data.password) { showToast('Password is required', 'error'); return; }
            await apiRequest('/admin/users', { method: 'POST', body: data });
            showToast('User created successfully');
        }
        closeModal('userModal');
        loadUsers();
        loadDashboard();
    } catch (err) {
        showToast(err.message || 'Failed to save user', 'error');
    } finally {
        document.getElementById('userUsername').disabled = false;
    }
}

async function deleteUser(id) {
    if (!confirm('Are you sure you want to delete this user?')) return;
    try {
        await apiRequest(`/admin/users/${id}`, { method: 'DELETE' });
        showToast('User deleted');
        loadUsers();
        loadDashboard();
    } catch (err) { showToast(err.message, 'error'); }
}

async function toggleUserStatus(id) {
    try {
        const result = await apiRequest(`/admin/users/${id}/toggle-status`, { method: 'POST' });
        showToast(result.message);
        loadUsers();
    } catch (err) { showToast(err.message, 'error'); }
}

function showResetPwdModal(id) {
    document.getElementById('resetPwdUserId').value = id;
    document.getElementById('resetPwdValue').value = '';
    openModal('resetPwdModal');
}

async function resetPassword() {
    const id = document.getElementById('resetPwdUserId').value;
    const newPwd = document.getElementById('resetPwdValue').value;
    if (!newPwd || newPwd.length < 6) {
        showToast('Password must be at least 6 characters', 'error');
        return;
    }
    try {
        await apiRequest(`/admin/users/${id}/reset-password`, { method: 'POST', body: { new_password: newPwd } });
        showToast('Password reset successfully');
        closeModal('resetPwdModal');
    } catch (err) { showToast(err.message, 'error'); }
}

// ============ TEACHERS ============
let allTeachers = [];

async function loadTeachers() {
    try {
        allTeachers = await apiRequest('/admin/teachers');
        renderTeachersTable();
    } catch (err) { showToast('Failed to load teachers', 'error'); }
}

function renderTeachersTable() {
    const tbody = document.getElementById('teachersTableBody');
    if (!allTeachers.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center" style="padding:32px;color:var(--text-light);">No teachers found</td></tr>';
        return;
    }
    tbody.innerHTML = allTeachers.map(t => `
    <tr>
      <td><strong>${t.employee_id}</strong></td>
      <td>${t.full_name}</td>
      <td>${t.position || '-'}</td>
      <td><span class="badge badge-info">${t.salary_scale}</span></td>
      <td>${t.phone || '-'}</td>
      <td>${t.email || '-'}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-sm btn-secondary" onclick="editTeacher(${t.id})">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteTeacher(${t.id})">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
}

async function showCreateTeacherModal() {
    document.getElementById('teacherModalTitle').textContent = 'Add New Teacher';
    document.getElementById('editTeacherId').value = '';
    document.getElementById('teacherForm').reset();
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
    openModal('teacherModal');
}

async function saveTeacher() {
    const editId = document.getElementById('editTeacherId').value;
    const data = {
        full_name: document.getElementById('teacherFullName').value,
        position: document.getElementById('teacherPosition').value,
        salary_scale: document.getElementById('teacherSalaryScale').value,
        email: document.getElementById('teacherEmail').value,
        phone: document.getElementById('teacherPhone').value,
        date_joined: document.getElementById('teacherDateJoined').value,
    };

    if (!data.full_name || !data.salary_scale) {
        showToast('Full name and salary scale are required', 'error');
        return;
    }

    try {
        if (editId) {
            await apiRequest(`/admin/teachers/${editId}`, { method: 'PUT', body: data });
            showToast('Teacher updated successfully');
        } else {
            const result = await apiRequest('/admin/teachers', { method: 'POST', body: data });
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
        await apiRequest(`/admin/teachers/${id}`, { method: 'DELETE' });
        showToast('Teacher removed');
        loadTeachers();
        loadDashboard();
    } catch (err) { showToast(err.message, 'error'); }
}

// ============ SALARY STRUCTURES ============
let allSalaryStructures = [];

async function loadSalaryStructures() {
    try {
        allSalaryStructures = await apiRequest('/admin/salary-structures');
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
            allSalaryStructures = await apiRequest('/admin/salary-structures');
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
        await apiRequest('/admin/salary-structures', { method: 'POST', body: data });
        showToast('Salary structure saved');
        closeModal('salaryModal');
        loadSalaryStructures();
    } catch (err) { showToast(err.message, 'error'); }
}

async function deleteSalaryStructure(id) {
    if (!confirm('Delete this salary structure?')) return;
    try {
        await apiRequest(`/admin/salary-structures/${id}`, { method: 'DELETE' });
        showToast('Salary structure deleted');
        loadSalaryStructures();
    } catch (err) { showToast(err.message, 'error'); }
}

// ============ CONFIGURATION ============
async function loadConfig() {
    try {
        const config = await apiRequest('/admin/config');
        document.getElementById('cfgSchoolName').value = config.school_name || '';
        document.getElementById('cfgCurrency').value = config.currency || 'UGX';
        document.getElementById('cfgPayrollPeriod').value = config.payroll_period || 'monthly';
        document.getElementById('cfgNSSF').value = config.nssf_percentage || '5';
        document.getElementById('cfgTaxEnabled').value = config.tax_enabled || 'true';
    } catch (err) { console.error('Config error:', err); }
}

async function saveConfig() {
    const data = {
        school_name: document.getElementById('cfgSchoolName').value,
        currency: document.getElementById('cfgCurrency').value,
        payroll_period: document.getElementById('cfgPayrollPeriod').value,
        nssf_percentage: document.getElementById('cfgNSSF').value,
        tax_enabled: document.getElementById('cfgTaxEnabled').value,
    };
    try {
        await apiRequest('/admin/config', { method: 'PUT', body: data });
        showToast('Configuration saved');
    } catch (err) { showToast(err.message, 'error'); }
}

// ============ REPORTS ============
async function loadReports() {
    try {
        const reports = await apiRequest('/admin/reports/payroll-summary');
        const tbody = document.getElementById('reportsTableBody');
        if (!reports.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center" style="padding:32px;color:var(--text-light);">No payroll records yet</td></tr>';
            return;
        }
        tbody.innerHTML = reports.map(r => `
      <tr>
        <td><strong>${getMonthName(r.month)} ${r.year}</strong></td>
        <td>${r.teacher_count}</td>
        <td>${formatCurrency(r.total_gross)}</td>
        <td>${formatCurrency(r.total_deductions)}</td>
        <td>${formatCurrency(r.total_net)}</td>
        <td><span class="badge ${r.status === 'paid' ? 'badge-success' : r.status === 'approved' ? 'badge-info' : 'badge-warning'}">${r.status}</span></td>
      </tr>
    `).join('');
    } catch (err) { console.error('Reports error:', err); }
}

// ============ AUDIT LOG ============
async function loadAuditLog() {
    try {
        const logs = await apiRequest('/admin/audit-log');
        const tbody = document.getElementById('auditTableBody');
        if (!logs.length) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center" style="padding:32px;color:var(--text-light);">No audit records yet</td></tr>';
            return;
        }
        tbody.innerHTML = logs.map(l => `
      <tr>
        <td>${formatDate(l.created_at)}</td>
        <td><strong>${l.username || 'System'}</strong></td>
        <td><span class="badge badge-gray">${l.action}</span></td>
        <td>${l.details || '-'}</td>
      </tr>
    `).join('');
    } catch (err) { console.error('Audit error:', err); }
}

// ============ BACKUP ============
async function backupDatabase() {
    try {
        await apiRequest('/admin/backup');
        showToast('Database backup downloaded');
    } catch (err) { showToast(err.message, 'error'); }
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
        users: 'User Management',
        teachers: 'Teacher Management',
        salary: 'Salary Structure',
        config: 'System Configuration',
        reports: 'Reports & Monitoring',
        audit: 'Audit Log',
        security: 'Security Control'
    };
    document.getElementById('pageTitle').textContent = titles[sectionId] || 'Dashboard';
};
