// ============ Admin Dashboard Logic ============

document.addEventListener('DOMContentLoaded', () => {
    if (!requireAuth('admin')) return;
    startSessionTimeout();
    initUserDisplay();
    loadDashboard();
    loadUsers();
    loadAdmins();
    loadHr();
    loadAccountants();
    loadConfig();
    loadReports();
    loadAuditLog();
});

// ============ DASHBOARD ============
async function loadDashboard() {
    try {
        const stats = await apiRequest('/admin/stats');
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        set('statUsers', stats.total_users);
        set('statHr', stats.total_hr);
        set('statAccountants', stats.total_accountants);
        set('statAdmins', stats.total_admins);
        set('statPayrolls', stats.total_payrolls);
        if (stats.recent_payroll) {
            set('statLatestPayroll', `${getMonthName(stats.recent_payroll.month)} ${stats.recent_payroll.year}`);
        }
    } catch (err) {
        console.error('Dashboard error:', err);
        showToast('Failed to load dashboard stats', 'error');
    }
}

// ============ ADMINS ============
let allAdmins = [];

async function loadAdmins() {
    try {
        allAdmins = await apiRequest('/admin/admins');
        renderAdminsTable();
    } catch (err) { showToast('Failed to load admins', 'error'); }
}

function renderAdminsTable() {
    const tbody = document.getElementById('adminsTableBody');
    if (!allAdmins.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center" style="padding:32px;color:var(--text-light);">No admins found</td></tr>';
        return;
    }
    tbody.innerHTML = allAdmins.map(a => `
    <tr>
      <td><strong>${a.username}</strong></td>
      <td>${a.full_name}</td>
      <td>${a.email || '-'}</td>
      <td>${a.phone || '-'}</td>
      <td>${a.created_at ? formatDate(a.created_at) : '-'}</td>
      <td><span class="badge ${a.is_active ? 'badge-success' : 'badge-gray'}">${a.is_active ? 'Active' : 'Inactive'}</span></td>
      <td>
        <div class="action-btns">
          <button class="btn btn-sm btn-secondary" onclick="editAdmin(${a.id})">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteAdmin(${a.id})">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function showCreateAdminModal() {
    document.getElementById('adminModalTitle').textContent = 'Add New Admin';
    document.getElementById('editAdminId').value = '';
    document.getElementById('adminForm').reset();
    document.getElementById('adminUsername').disabled = false;
    document.getElementById('adminUsernameHint').textContent = '';
    document.getElementById('adminPasswordGroup').style.display = '';
    openModal('adminModal');
}

function editAdmin(id) {
    const admin = allAdmins.find(a => a.id === id);
    if (!admin) return;
    document.getElementById('adminModalTitle').textContent = 'Edit Admin';
    document.getElementById('editAdminId').value = id;
    document.getElementById('adminFullName').value = admin.full_name;
    document.getElementById('adminUsername').value = admin.username;
    document.getElementById('adminUsername').disabled = true;
    document.getElementById('adminUsernameHint').textContent = '(cannot be changed after creation)';
    document.getElementById('adminEmail').value = admin.email || '';
    document.getElementById('adminPhone').value = admin.phone || '';
    document.getElementById('adminPassword').value = '';
    document.getElementById('adminPasswordGroup').style.display = 'none';
    openModal('adminModal');
}

async function saveAdmin() {
    const editId = document.getElementById('editAdminId').value;
    const data = {
        full_name: document.getElementById('adminFullName').value.trim(),
        email: document.getElementById('adminEmail').value.trim(),
        phone: document.getElementById('adminPhone').value.trim(),
    };
    if (!data.full_name) { showToast('Full name is required', 'error'); return; }
    if (!editId) {
        const username = document.getElementById('adminUsername').value.trim();
        const password = document.getElementById('adminPassword').value.trim();
        if (!username) { showToast('Username is required', 'error'); return; }
        data.username = username;
        if (password) data.password = password;
    }
    try {
        if (editId) {
            await apiRequest(`/admin/admins/${editId}`, { method: 'PUT', body: data });
            showToast('Admin updated successfully');
        } else {
            const result = await apiRequest('/admin/admins', { method: 'POST', body: data });
            showToast(`Admin created! Username: ${result.admin.username}, Password: ${result.admin.default_password}`);
        }
        closeModal('adminModal');
        loadAdmins();
        loadUsers();
        loadDashboard();
    } catch (err) { showToast(err.message || 'Failed to save admin', 'error'); }
}

async function deleteAdmin(id) {
    if (!confirm('Are you sure you want to delete this admin account? This action cannot be undone.')) return;
    try {
        await apiRequest(`/admin/admins/${id}`, { method: 'DELETE' });
        showToast('Admin removed');
        loadAdmins();
        loadUsers();
        loadDashboard();
    } catch (err) { showToast(err.message, 'error'); }
}

// ============ HR ============
let allHr = [];

async function loadHr() {
    try {
        allHr = await apiRequest('/admin/hr');
        renderHrTable();
    } catch (err) { showToast('Failed to load HR details', 'error'); }
}

function renderHrTable() {
    const tbody = document.getElementById('hrTableBody');
    if (!allHr.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center" style="padding:32px;color:var(--text-light);">No HR members found</td></tr>';
        return;
    }
    tbody.innerHTML = allHr.map(a => `
    <tr>
      <td><strong>${a.username}</strong></td>
      <td>${a.full_name}</td>
      <td>${a.email || '-'}</td>
      <td>${a.phone || '-'}</td>
      <td>${a.created_at ? formatDate(a.created_at) : '-'}</td>
      <td><span class="badge ${a.is_active ? 'badge-success' : 'badge-gray'}">${a.is_active ? 'Active' : 'Inactive'}</span></td>
      <td>
        <div class="action-btns">
          <button class="btn btn-sm btn-secondary" onclick="editHr(${a.id})">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteHr(${a.id})">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function showCreateHrModal() {
    document.getElementById('hrModalTitle').textContent = 'Add New HR';
    document.getElementById('editHrId').value = '';
    document.getElementById('hrForm').reset();
    document.getElementById('hrUsername').disabled = false;
    document.getElementById('hrUsernameHint').textContent = '';
    document.getElementById('hrPasswordGroup').style.display = '';
    openModal('hrModal');
}

function editHr(id) {
    const hr = allHr.find(a => a.id === id);
    if (!hr) return;
    document.getElementById('hrModalTitle').textContent = 'Edit HR';
    document.getElementById('editHrId').value = id;
    document.getElementById('hrFullName').value = hr.full_name;
    document.getElementById('hrUsername').value = hr.username;
    document.getElementById('hrUsername').disabled = true;
    document.getElementById('hrUsernameHint').textContent = '(cannot be changed after creation)';
    document.getElementById('hrEmail').value = hr.email || '';
    document.getElementById('hrPhone').value = hr.phone || '';
    document.getElementById('hrPassword').value = '';
    document.getElementById('hrPasswordGroup').style.display = 'none';
    openModal('hrModal');
}

async function saveHr() {
    const editId = document.getElementById('editHrId').value;
    const data = {
        full_name: document.getElementById('hrFullName').value.trim(),
        email: document.getElementById('hrEmail').value.trim(),
        phone: document.getElementById('hrPhone').value.trim(),
    };
    if (!data.full_name) { showToast('Full name is required', 'error'); return; }
    if (!editId) {
        const username = document.getElementById('hrUsername').value.trim();
        const password = document.getElementById('hrPassword').value.trim();
        if (!username) { showToast('Username is required', 'error'); return; }
        data.username = username;
        if (password) data.password = password;
    }
    try {
        if (editId) {
            await apiRequest(`/admin/hr/${editId}`, { method: 'PUT', body: data });
            showToast('HR updated successfully');
        } else {
            const result = await apiRequest('/admin/hr', { method: 'POST', body: data });
            showToast(`HR created! Username: ${result.hr.username}, Password: ${result.hr.default_password}`);
        }
        closeModal('hrModal');
        loadHr();
        loadUsers();
        loadDashboard();
    } catch (err) { showToast(err.message || 'Failed to save HR', 'error'); }
}

async function deleteHr(id) {
    if (!confirm('Are you sure you want to delete this HR account? This action cannot be undone.')) return;
    try {
        await apiRequest(`/admin/hr/${id}`, { method: 'DELETE' });
        showToast('HR removed');
        loadHr();
        loadUsers();
        loadDashboard();
    } catch (err) { showToast(err.message, 'error'); }
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
      <td><span class="badge ${u.role === 'admin' ? 'badge-danger' : (u.role === 'hr' ? 'badge-purple' : (u.role === 'accountant' ? 'badge-info' : 'badge-success'))}">${u.role}</span></td>
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

// ============ ACCOUNTANTS ============
let allAccountants = [];

async function loadAccountants() {
    try {
        allAccountants = await apiRequest('/admin/accountants');
        renderAccountantsTable();
    } catch (err) { showToast('Failed to load accountants', 'error'); }
}

function renderAccountantsTable() {
    const tbody = document.getElementById('accountantsTableBody');
    if (!allAccountants.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center" style="padding:32px;color:var(--text-light);">No accountants found</td></tr>';
        return;
    }
    tbody.innerHTML = allAccountants.map(a => `
    <tr>
      <td><strong>${a.employee_id}</strong></td>
      <td>${a.full_name}</td>
      <td>${a.department || '-'}</td>
      <td>${a.phone || '-'}</td>
      <td>${a.email || '-'}</td>
      <td>${a.date_joined ? formatDate(a.date_joined) : '-'}</td>
      <td><span class="badge ${a.account_active ? 'badge-success' : 'badge-gray'}">${a.account_active ? 'Active' : 'Inactive'}</span></td>
      <td>
        <div class="action-btns">
          <button class="btn btn-sm btn-secondary" onclick="editAccountant(${a.id})">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteAccountant(${a.id})">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function showCreateAccountantModal() {
    document.getElementById('accountantModalTitle').textContent = 'Add New Accountant';
    document.getElementById('editAccountantId').value = '';
    document.getElementById('accountantForm').reset();
    const usernameInput = document.getElementById('accountantUsername');
    usernameInput.disabled = false;
    usernameInput.placeholder = 'Leave blank to auto-generate';
    document.getElementById('accountantUsernameHint').textContent = '';
    openModal('accountantModal');
}

function editAccountant(id) {
    const acc = allAccountants.find(a => a.id === id);
    if (!acc) return;
    document.getElementById('accountantModalTitle').textContent = 'Edit Accountant';
    document.getElementById('editAccountantId').value = id;
    document.getElementById('accountantFullName').value = acc.full_name;
    document.getElementById('accountantDepartment').value = acc.department || '';
    document.getElementById('accountantEmail').value = acc.email || '';
    document.getElementById('accountantPhone').value = acc.phone || '';
    document.getElementById('accountantDateJoined').value = acc.date_joined || '';
    const usernameInput = document.getElementById('accountantUsername');
    usernameInput.value = acc.username || '';
    usernameInput.disabled = true;
    document.getElementById('accountantUsernameHint').textContent = '(cannot be changed after creation)';
    openModal('accountantModal');
}

async function saveAccountant() {
    const editId = document.getElementById('editAccountantId').value;
    const usernameVal = document.getElementById('accountantUsername').value.trim();
    const data = {
        full_name: document.getElementById('accountantFullName').value.trim(),
        department: document.getElementById('accountantDepartment').value.trim(),
        email: document.getElementById('accountantEmail').value.trim(),
        phone: document.getElementById('accountantPhone').value.trim(),
        date_joined: document.getElementById('accountantDateJoined').value,
    };
    if (!editId && usernameVal) data.username = usernameVal;
    if (!data.full_name) {
        showToast('Full name is required', 'error');
        return;
    }
    try {
        if (editId) {
            await apiRequest(`/admin/accountants/${editId}`, { method: 'PUT', body: data });
            showToast('Accountant updated successfully');
        } else {
            const result = await apiRequest('/admin/accountants', { method: 'POST', body: data });
            showToast(`Accountant added! Username: ${result.accountant.username}, Default password: accountant123`);
        }
        closeModal('accountantModal');
        loadAccountants();
        loadUsers();
        loadDashboard();
    } catch (err) { showToast(err.message || 'Failed to save accountant', 'error'); }
}

async function deleteAccountant(id) {
    if (!confirm('Are you sure you want to remove this accountant? This will also delete their user account.')) return;
    try {
        await apiRequest(`/admin/accountants/${id}`, { method: 'DELETE' });
        showToast('Accountant removed');
        loadAccountants();
        loadUsers();
        loadDashboard();
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

// ============ MFA PORTAL ============
async function loadMfaCodes() {
    try {
        const codes = await apiRequest('/admin/mfa-codes');
        const tbody = document.getElementById('mfaTableBody');
        if (!codes.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center" style="padding:32px;color:var(--text-light);">No active MFA requests</td></tr>';
            return;
        }
        
        const now = new Date();
        
        tbody.innerHTML = codes.map(c => {
            const exp = new Date(c.expires_at);
            const diffMs = exp - now;
            const diffMins = Math.max(0, Math.floor(diffMs / 60000));
            const secRemaining = Math.max(0, Math.floor((diffMs % 60000) / 1000));
            
            let timeText = diffMins > 0 ? `${diffMins}m ${secRemaining}s` : `${secRemaining}s`;
            if (diffMs <= 0) timeText = 'Expired';
            const timeColor = diffMs <= 0 ? 'color:var(--text-light)' : (diffMins < 2 ? 'color:var(--danger)' : 'color:var(--success)');
            
            return `
                <tr>
                    <td>${formatDate(c.created_at)}</td>
                    <td><strong>${c.full_name}</strong><br><small style="color:var(--text-secondary);">${c.username}</small></td>
                    <td><span class="badge ${c.role === 'admin' ? 'badge-danger' : (c.role === 'hr' ? 'badge-purple' : (c.role === 'accountant' ? 'badge-info' : 'badge-success'))}">${c.role}</span></td>
                    <td style="font-size:1.5rem; letter-spacing: 2px;"><strong>${c.otp_code}</strong></td>
                    <td style="font-weight:bold; ${timeColor}">${timeText}</td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        console.error('MFA codes error:', err);
        showToast('Failed to load MFA codes', 'error');
    }
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
        admins: 'Admin Management',
        hr: 'HR Management',
        accountants: 'Accountant Management',
        config: 'System Configuration',
        reports: 'Reports & Monitoring',
        audit: 'Audit Log',
        mfa: 'MFA Portal',
        security: 'Security Control'
    };
    document.getElementById('pageTitle').textContent = titles[sectionId] || 'Dashboard';
};
