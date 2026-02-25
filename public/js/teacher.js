// ============ Teacher Portal Logic ============

document.addEventListener('DOMContentLoaded', () => {
    if (!requireAuth('teacher')) return;
    initUserDisplay();
    loadProfile();
    loadPayslips();
    loadSalaryHistory();
    loadNotifications();
});

// ============ PROFILE ============
let profileData = null;

async function loadProfile() {
    try {
        profileData = await apiRequest('/teacher/profile');
        document.getElementById('profName').textContent = profileData.full_name;
        document.getElementById('profEmpId').textContent = profileData.employee_id;
        document.getElementById('profPosition').textContent = profileData.position || 'N/A';
        document.getElementById('profScale').textContent = profileData.salary_scale;
        document.getElementById('profEmail').textContent = profileData.email || 'Not set';
        document.getElementById('profPhone').textContent = profileData.phone || 'Not set';
        document.getElementById('profJoined').textContent = formatDate(profileData.date_joined);

        document.getElementById('profBasic').textContent = formatCurrency(profileData.basic_salary);
        document.getElementById('profHousing').textContent = formatCurrency(profileData.housing_allowance);
        document.getElementById('profTransport').textContent = formatCurrency(profileData.transport_allowance);
        document.getElementById('profMedical').textContent = formatCurrency(profileData.medical_allowance);
        document.getElementById('profTax').textContent = `${profileData.tax_percentage || 0}%`;
        document.getElementById('profNSSF').textContent = `${profileData.nssf_percentage || 0}%`;
    } catch (err) {
        showToast('Failed to load profile', 'error');
    }
}

function toggleEditProfile() {
    const viewEl = document.getElementById('profileView');
    const editEl = document.getElementById('profileEdit');
    const btn = document.getElementById('editProfileBtn');

    if (editEl.style.display === 'none') {
        editEl.style.display = 'block';
        viewEl.style.display = 'none';
        btn.style.display = 'none';
        document.getElementById('editEmail').value = profileData?.email || '';
        document.getElementById('editPhone').value = profileData?.phone || '';
    } else {
        editEl.style.display = 'none';
        viewEl.style.display = 'grid';
        btn.style.display = 'inline-flex';
    }
}

async function saveProfile() {
    const email = document.getElementById('editEmail').value;
    const phone = document.getElementById('editPhone').value;
    try {
        await apiRequest('/teacher/profile', {
            method: 'PUT',
            body: { email, phone }
        });
        showToast('Profile updated');
        toggleEditProfile();
        loadProfile();
    } catch (err) { showToast(err.message, 'error'); }
}

// ============ PAYSLIPS ============
async function loadPayslips() {
    try {
        const payslips = await apiRequest('/teacher/payslips');
        const tbody = document.getElementById('payslipsBody');
        if (!payslips.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center" style="padding:32px;color:var(--text-light);">No payslips available yet</td></tr>';
            return;
        }
        tbody.innerHTML = payslips.map(p => {
            const allowances = (p.housing_allowance || 0) + (p.transport_allowance || 0) + (p.medical_allowance || 0) + (p.other_allowance || 0);
            return `
        <tr>
          <td><strong>${getMonthName(p.month)} ${p.year}</strong></td>
          <td>${formatCurrency(p.basic_salary)}</td>
          <td>${formatCurrency(allowances)}</td>
          <td>${formatCurrency(p.total_deductions)}</td>
          <td><strong>${formatCurrency(p.net_salary)}</strong></td>
          <td><span class="badge ${p.payment_status === 'Paid' ? 'badge-success' : 'badge-warning'}">${p.payment_status}</span></td>
          <td>
            <div class="action-btns">
              <button class="btn btn-sm btn-primary" onclick="downloadPayslip(${p.id})">📄 Download</button>
              <button class="btn btn-sm btn-secondary" onclick="printPayslip(${p.id})">🖨️ Print</button>
            </div>
          </td>
        </tr>
      `;
        }).join('');
    } catch (err) { showToast('Failed to load payslips', 'error'); }
}

async function downloadPayslip(id) {
    try {
        await apiRequest(`/teacher/payslip/${id}/pdf`);
        showToast('Payslip downloaded');
    } catch (err) { showToast(err.message, 'error'); }
}

async function printPayslip(id) {
    try {
        const token = getToken();
        const response = await fetch(`/api/teacher/payslip/${id}/pdf`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const printWindow = window.open(url);
        printWindow.addEventListener('load', () => {
            printWindow.print();
        });
    } catch (err) { showToast('Failed to print', 'error'); }
}

// ============ SALARY HISTORY ============
async function loadSalaryHistory() {
    try {
        const history = await apiRequest('/teacher/salary-history');
        const tbody = document.getElementById('historyBody');
        if (!history.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center" style="padding:32px;color:var(--text-light);">No salary history yet</td></tr>';
            return;
        }
        tbody.innerHTML = history.map(h => `
      <tr>
        <td><strong>${getMonthName(h.month)} ${h.year}</strong></td>
        <td>${formatCurrency(h.gross_salary)}</td>
        <td>${formatCurrency(h.total_deductions)}</td>
        <td><strong>${formatCurrency(h.net_salary)}</strong></td>
        <td><span class="badge ${h.payment_status === 'Paid' ? 'badge-success' : 'badge-warning'}">${h.payment_status}</span></td>
      </tr>
    `).join('');
    } catch (err) { showToast('Failed to load salary history', 'error'); }
}

// ============ NOTIFICATIONS ============
async function loadNotifications() {
    try {
        const notifications = await apiRequest('/teacher/notifications');
        const container = document.getElementById('notificationsList');

        const unreadCount = notifications.filter(n => !n.is_read).length;
        const badge = document.getElementById('notifBadge');
        if (unreadCount > 0) {
            badge.textContent = unreadCount;
            badge.style.display = 'inline';
        } else {
            badge.style.display = 'none';
        }

        if (!notifications.length) {
            container.innerHTML = '<div class="empty-state"><div class="empty-icon">🔔</div><p>No notifications yet</p></div>';
            return;
        }
        container.innerHTML = notifications.map(n => `
      <div class="notification-item ${n.is_read ? 'read' : 'unread'}" onclick="markNotificationRead(${n.id})">
        <div class="notification-dot"></div>
        <div class="notification-content">
          <h4>${n.title}</h4>
          <p>${n.message}</p>
          <div class="notification-time">${formatDate(n.created_at)}</div>
        </div>
      </div>
    `).join('');
    } catch (err) { console.error('Notifications error:', err); }
}

async function markNotificationRead(id) {
    try {
        await apiRequest(`/teacher/notifications/${id}/read`, { method: 'PUT' });
        loadNotifications();
    } catch (err) { console.error(err); }
}

async function markAllRead() {
    try {
        await apiRequest('/teacher/notifications/read-all', { method: 'PUT' });
        showToast('All notifications marked as read');
        loadNotifications();
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
    if (newPwd.length < 6) {
        showToast('New password must be at least 6 characters', 'error');
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

// Update page title
const originalSwitchSection = switchSection;
switchSection = function (sectionId) {
    originalSwitchSection(sectionId);
    const titles = {
        profile: 'My Profile',
        payslips: 'My Payslips',
        history: 'Salary History',
        notifications: 'Notifications',
        password: 'Change Password'
    };
    document.getElementById('pageTitle').textContent = titles[sectionId] || 'My Profile';
};
