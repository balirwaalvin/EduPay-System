// ============ EduPay Shared Utilities ============

const API_BASE = '/api';

// Auth token management
function getToken() {
    return localStorage.getItem('edupay_token');
}

function setToken(token) {
    localStorage.setItem('edupay_token', token);
}

function getUser() {
    const user = localStorage.getItem('edupay_user');
    return user ? JSON.parse(user) : null;
}

function setUser(user) {
    localStorage.setItem('edupay_user', JSON.stringify(user));
}

function clearAuth() {
    localStorage.removeItem('edupay_token');
    localStorage.removeItem('edupay_user');
}

function requireAuth(requiredRole) {
    const token = getToken();
    const user = getUser();
    if (!token || !user) {
        window.location.href = '/';
        return false;
    }
    if (requiredRole && user.role !== requiredRole && user.role !== 'admin') {
        window.location.href = '/';
        return false;
    }
    return true;
}

// API helper
async function apiRequest(endpoint, options = {}) {
    const token = getToken();
    const config = {
        headers: {
            'Content-Type': 'application/json',
            ...(token && { 'Authorization': `Bearer ${token}` })
        },
        ...options
    };

    if (config.body && typeof config.body === 'object') {
        config.body = JSON.stringify(config.body);
    }

    try {
        const response = await fetch(`${API_BASE}${endpoint}`, config);

        // Handle file downloads
        const contentType = response.headers.get('content-type');
        if (contentType && (contentType.includes('application/pdf') || contentType.includes('spreadsheetml') || contentType.includes('octet-stream'))) {
            if (!response.ok) throw new Error('Download failed');
            const blob = await response.blob();
            const disposition = response.headers.get('content-disposition');
            let filename = 'download';
            if (disposition) {
                const match = disposition.match(/filename=(.+)/);
                if (match) filename = match[1];
            }
            downloadBlob(blob, filename);
            return { success: true };
        }

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'Request failed');
        }
        return data;
    } catch (err) {
        if (err.message.includes('expired') || err.message.includes('Access denied')) {
            clearAuth();
            window.location.href = '/';
        }
        throw err;
    }
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Toast notifications
function showToast(message, type = 'success') {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
    toast.innerHTML = `
    <span style="font-size:1.1rem;font-weight:bold;">${icons[type] || icons.info}</span>
    <span class="toast-message">${message}</span>
  `;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(50px)';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// Modal helpers
function openModal(modalId) {
    document.getElementById(modalId).classList.add('active');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
}

// Navigation
function switchSection(sectionId) {
    document.querySelectorAll('.page-section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    const section = document.getElementById(sectionId);
    if (section) section.classList.add('active');

    const navItem = document.querySelector(`[data-section="${sectionId}"]`);
    if (navItem) navItem.classList.add('active');
}

// Format currency
function formatCurrency(amount, currency = 'UGX') {
    return `${currency} ${Number(amount || 0).toLocaleString()}`;
}

// Format date
function formatDate(dateStr) {
    if (!dateStr) return 'N/A';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// Get month name
function getMonthName(monthNum) {
    const months = ['', 'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
    return months[monthNum] || '';
}

// Logout
function logout() {
    clearAuth();
    window.location.href = '/';
}

// Mobile sidebar toggle
function toggleSidebar() {
    document.querySelector('.sidebar').classList.toggle('open');
}

// Initialize user display
function initUserDisplay() {
    const user = getUser();
    if (!user) return;

    const nameEls = document.querySelectorAll('.user-full-name');
    nameEls.forEach(el => el.textContent = user.full_name);

    const avatarEls = document.querySelectorAll('.user-avatar');
    avatarEls.forEach(el => {
        el.textContent = user.full_name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    });

    const roleEls = document.querySelectorAll('.user-role-display');
    roleEls.forEach(el => el.textContent = user.role.charAt(0).toUpperCase() + user.role.slice(1));
}
