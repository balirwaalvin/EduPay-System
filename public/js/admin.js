/* EduPay — administrator dashboard */
'use strict';

let staffTable;
let reportTable;

let editingUserId = null;
let auditCursor = null;
let auditRows = [];

const AUDIT_ACTIONS = [
    'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'MFA_CHALLENGE_SENT', 'MFA_FAILED',
    'CREATE_ADMIN', 'CREATE_HR', 'CREATE_ACCOUNTANT', 'CREATE_TEACHER',
    'UPDATE_USER', 'UPDATE_TEACHER', 'DEACTIVATE_USER', 'REACTIVATE_USER', 'DELETE_USER',
    'RESET_PASSWORD', 'PASSWORD_CHANGED', 'PASSWORD_RESET_COMPLETED',
    'CREATE_SALARY_STRUCTURE', 'UPDATE_SALARY_STRUCTURE', 'DELETE_SALARY_STRUCTURE',
    'PROCESS_PAYROLL', 'APPROVE_PAYROLL', 'REJECT_PAYROLL', 'UPDATE_PAYMENT_STATUS',
    'MARK_PAYROLL_PAID', 'HALT_TEACHER_PAYROLL', 'RESUME_TEACHER_PAYROLL',
    'DECIDE_LEAVE', 'DECIDE_ADVANCE', 'UPDATE_CONFIG', 'BACKUP_EXPORTED', 'UPDATE_AVATAR'
];

document.addEventListener('DOMContentLoaded', () => {
    if (!initDashboard({ role: 'admin' })) return;

    buildTables();
    wireForms();

    loadStats();
});

/* -------------------------------------------------------------------------- */

function buildTables() {
    staffTable = createTable({
        tbody: 'staffTableBody',
        columns: 5,
        pageSize: 25,
        searchInput: 'staffSearch',
        countTarget: 'staffCount',
        pagerTarget: 'staffPager',
        searchFields: ['fullName', 'username', 'email', 'role'],
        emptyMessage: 'No accounts match',
        /* Five columns, not seven. Two-factor and the activation state became
           chips in Status, and five of the six buttons moved into a menu — the
           row used to need 245px more width than it had. */
        renderRow: user => html`
      <tr>
        <td>
          <button type="button" class="identity" data-profile="${user.id}">
            <span class="identity-avatar" data-initials="${initials(user.fullName)}"
              data-avatar-for="${user.hasAvatar ? user.id : ''}"></span>
            <span class="identity-text">
              <span class="cell-primary">${user.fullName}</span>
              <span class="cell-sub">${user.username}</span>
            </span>
          </button>
        </td>
        <td>
          ${user.email || '—'}
          <span class="cell-sub">${user.phone || ''}</span>
        </td>
        <td>${raw(roleBadge(user.role))}</td>
        <td>
          <div class="chip-stack">
            ${raw(user.isActive ? badge('Approved', 'Active') : badge('Cancelled', 'Deactivated'))}
            ${raw(user.mfaEnabled ? badge('Approved', '2FA on') : badge('Muted', '2FA off'))}
            ${user.activationPending ? raw(badge('Pending', 'No password')) : raw('')}
          </div>
        </td>
        <td class="col-actions">
          <div class="row-actions">
            <button type="button" class="btn btn-sm btn-secondary" data-edit="${user.id}">Edit</button>
            <button type="button" class="row-menu-btn" popovertarget="staffMenu${user.id}"
              aria-label="More actions for ${user.fullName}" data-icon="more" data-icon-size="16"></button>
            <div class="row-menu" popover id="staffMenu${user.id}">
              <button type="button" data-reset="${user.id}">
                <span class="icon-slot" data-icon="key" data-icon-size="16"></span> Reset password</button>
              ${user.activationPending
                ? raw(html`<button type="button" class="is-accent" data-resend="${user.id}">
                <span class="icon-slot" data-icon="mail" data-icon-size="16"></span> Resend setup link</button>`)
                : raw('')}
              <button type="button" data-mfa="${user.id}" data-mfa-state="${user.mfaEnabled ? 'on' : 'off'}">
                <span class="icon-slot" data-icon="shield" data-icon-size="16"></span>
                ${user.mfaEnabled ? 'Disable two-factor' : 'Enable two-factor'}</button>
              <div class="row-menu-sep"></div>
              ${user.isActive
                ? raw(html`<button type="button" data-deactivate="${user.id}">
                <span class="icon-slot" data-icon="lock" data-icon-size="16"></span> Deactivate</button>`)
                : raw(html`<button type="button" data-reactivate="${user.id}">
                <span class="icon-slot" data-icon="check" data-icon-size="16"></span> Reactivate</button>`)}
              <button type="button" class="is-danger" data-delete="${user.id}">
                <span class="icon-slot" data-icon="close" data-icon-size="16"></span> Delete account</button>
            </div>
          </div>
        </td>
      </tr>`
    });

    reportTable = createTable({
        tbody: 'reportTableBody',
        columns: 7,
        pageSize: 25,
        pagerTarget: 'reportPager',
        emptyMessage: 'No payroll runs yet',
        renderRow: run => html`
      <tr>
        <td class="cell-primary">${run.periodLabel || periodLabel(run.month, run.year)}</td>
        <td class="numeric">${run.employeeCount ?? 0}</td>
        <td class="numeric">${formatCurrency(run.totalGross)}</td>
        <td class="numeric">${formatCurrency(run.totalDeductions)}</td>
        <td class="numeric cell-primary">${formatCurrency(run.totalNet)}</td>
        <td class="numeric">${formatCurrency(run.totalEmployerCost)}</td>
        <td>${raw(badge(run.status))}</td>
      </tr>`
    });

    document.getElementById('staffTableBody').addEventListener('click', handleStaffAction);

    // The profile offers the same actions as the row, so it shares the handler.
    document.getElementById('profileBody').addEventListener('click', handleStaffAction);

    document.getElementById('staffTableBody').addEventListener('table:rendered',
        (event) => fillAvatarThumbnails(event.target));
    document.getElementById('profileBack').addEventListener('click', () => switchSection('staff'));
}

function roleBadge(role) {
    const labels = { admin: 'Administrator', hr: 'HR', accountant: 'Accountant', teacher: 'Teacher' };
    const classes = { admin: 'badge-danger', hr: 'badge-info', accountant: 'badge-warning', teacher: 'badge-success' };
    return html`<span class="badge ${raw(classes[role] || 'badge-muted')}">${labels[role] || role}</span>`;
}

function handleStaffAction(event) {
    const target = event.target;
    const get = (name) => target.closest(`[data-${name}]`)?.dataset[name];

    const profile = get('profile');
    const edit = get('edit');
    const reset = get('reset');
    const resend = get('resend');
    const mfaBtn = target.closest('[data-mfa]');
    const deactivate = get('deactivate');
    const reactivate = get('reactivate');
    const remove = get('delete');

    if (profile) switchSection('staffProfile', profile);
    else if (edit) openStaffModal(edit);
    else if (reset) resetPassword(reset);
    else if (resend) resendSetupLink(resend, target.closest('[data-resend]'));
    else if (mfaBtn) toggleMfa(mfaBtn.dataset.mfa, mfaBtn.dataset.mfaState !== 'on');
    else if (deactivate) setAccountStatus(deactivate, false);
    else if (reactivate) setAccountStatus(reactivate, true);
    else if (remove) deleteAccount(remove);
}

function wireForms() {
    document.getElementById('addStaffBtn').addEventListener('click', () => openStaffModal(null));
    document.getElementById('staffForm').addEventListener('submit', saveStaff);
    document.getElementById('configForm').addEventListener('submit', saveConfig);
    document.getElementById('backupBtn').addEventListener('click', downloadBackup);
    document.getElementById('mfaRefreshBtn').addEventListener('click', loadMfaActivity);

    document.getElementById('roleFilter').addEventListener('change', loadStaff);

    // Show the department field only where it applies.
    document.getElementById('uRole').addEventListener('change', (event) => {
        document.getElementById('departmentGroup').hidden = event.target.value !== 'accountant';
    });

    document.getElementById('auditFilterBtn').addEventListener('click', () => loadAudit({ reset: true }));
    document.getElementById('auditResetBtn').addEventListener('click', () => {
        document.getElementById('auditUsername').value = '';
        document.getElementById('auditAction').value = '';
        loadAudit({ reset: true });
    });
    document.getElementById('auditMoreBtn').addEventListener('click', () => loadAudit({ reset: false }));

    fillSelect('auditAction',
        AUDIT_ACTIONS.map(action => ({ value: action, label: action.replace(/_/g, ' ').toLowerCase() })),
        { placeholder: 'All actions' });

    const loaded = new Set();
    document.addEventListener('section:shown', (event) => {
        const section = event.detail.sectionId;

        if (section === 'mfa') { loadMfaActivity(); return; }
        if (section === 'staff') { loadStaff(); return; }
        if (section === 'staffProfile') { loadStaffProfile(event.detail.param); return; }

        if (loaded.has(section)) return;
        loaded.add(section);

        if (section === 'config') loadConfig();
        else if (section === 'reports') loadReports();
        else if (section === 'audit') loadAudit({ reset: true });
    });
}

/* -------------------------------------------------------------------------- */

async function loadStats() {
    try {
        const stats = await apiRequest('/admin/stats');

        document.getElementById('statUsers').textContent = stats.totalUsers;
        setText('heroAccounts', stats.totalUsers);
        document.getElementById('statPendingActivation').textContent = stats.pendingActivation
            ? `${stats.pendingActivation} not yet activated`
            : 'All activated';
        document.getElementById('statAdmins').textContent = stats.totalAdmins;
        document.getElementById('statHr').textContent = stats.totalHr;
        document.getElementById('statAccountants').textContent = stats.totalAccountants;
        document.getElementById('statTeachers').textContent = stats.totalTeachers;
        document.getElementById('statPayrolls').textContent = stats.totalPayrolls;
        document.getElementById('statRecentPayroll').textContent = stats.recentPayroll
            ? `Latest: ${stats.recentPayroll.periodLabel || periodLabel(stats.recentPayroll.month, stats.recentPayroll.year)}`
            : 'None processed yet';

        renderHealth(stats);
    } catch (err) {
        showError(err, 'Could not load the dashboard figures.');
    }
}

/** Flag configuration gaps that would otherwise surface as confusing failures. */
async function renderHealth(stats) {
    const host = document.getElementById('healthList');
    const items = [];

    try {
        const ready = await fetch('/readyz').then(r => r.json());

        items.push(ready.database === 'connected'
            ? ['success', `Database connected — ${ready.databaseName} on ${ready.databaseVersion}.`]
            : ['danger', 'The database is not reachable. Payroll cannot be processed.']);

        if (ready.email !== 'configured') {
            items.push(['warning',
                'Email delivery is not configured, so password setup links, password resets and two-factor '
                + 'codes cannot be sent. New accounts will be issued temporary passwords instead.']);
        } else {
            items.push(['success', 'Email delivery is configured.']);
        }
    } catch {
        items.push(['warning', 'Could not read the service health endpoint.']);
    }

    if (stats.totalAdmins === 1) {
        items.push(['warning',
            'There is only one administrator account. Create a second so you cannot be locked out.']);
    }
    if (stats.pendingActivation) {
        items.push(['warning', `${stats.pendingActivation} account(s) have never set a password and cannot sign in.`]);
    }

    host.innerHTML = items.map(([level, message]) => html`
    <div class="alert alert-${raw(level)}">
      <span class="alert-icon">${raw(icon(level === 'success' ? 'check' : level === 'danger' ? 'close' : 'alert', { size: 16 }))}</span>
      <span>${message}</span>
    </div>`).join('');
}

/* -------------------------------------------------------------------------- */

async function loadStaff() {
    staffTable.showLoading();
    const role = document.getElementById('roleFilter').value;

    try {
        staffTable.setData(await apiRequest(`/admin/users${role ? `?role=${role}` : ''}`));
    } catch (err) {
        showError(err, 'Could not load accounts.');
        staffTable.setData([]);
    }

    // Every account action funnels through here, so this one line keeps an open
    // profile in step with whatever just happened to it.
    if (profileUserId && document.getElementById('staffProfile')?.classList.contains('active')) {
        loadStaffProfile(profileUserId);
    }
}

/* ==========================================================================
   Staff profile

   The list answers "who are the accounts"; this answers "who is this one".
   Everything the row had no space for lives here — when the account was
   created and by whom, when it last signed in, when its password last changed,
   what it has been doing — alongside the same actions, so nothing has to be
   done back on the list.
   ========================================================================== */

let profileUserId = null;

/** The square the picture is stored at. Large enough for a retina 128px frame. */
const AVATAR_SIZE = 512;

/** Refused before the file is ever decoded; the resized result is far smaller. */
const AVATAR_MAX_SOURCE_BYTES = 12 * 1024 * 1024;

async function loadStaffProfile(userId) {
    if (!userId) { switchSection('staff'); return; }

    profileUserId = userId;
    const body = document.getElementById('profileBody');
    if (!body) return;

    try {
        renderStaffProfile(await apiRequest(`/admin/users/${encodeURIComponent(userId)}`));
    } catch (err) {
        showError(err, 'Could not load that account.');
        body.innerHTML = html`
      <div class="card"><div class="card-body">
        <p class="empty-hint">That account could not be loaded. It may have been deleted.</p>
      </div></div>`;
    }
}

function renderStaffProfile(user) {
    const body = document.getElementById('profileBody');
    const pending = user.activationPending;

    body.innerHTML = html`
    <div class="profile-head card">
      <div class="profile-identity">
        <div class="profile-photo-frame">
          ${user.avatar
            ? raw(html`<img class="profile-photo" src="${user.avatar}" alt="Profile picture of ${user.fullName}">`)
            : raw(html`<span class="profile-photo is-placeholder" aria-hidden="true">${initials(user.fullName)}</span>`)}
        </div>
        <div class="profile-headline">
          <h2>${user.fullName}</h2>
          <p class="profile-username">${user.username}</p>
          <div class="chip-stack">
            ${raw(roleBadge(user.role))}
            ${raw(user.isActive ? badge('Approved', 'Active') : badge('Cancelled', 'Deactivated'))}
            ${raw(user.mfaEnabled ? badge('Approved', '2FA on') : badge('Muted', '2FA off'))}
            ${pending ? raw(badge('Pending', 'No password')) : raw('')}
          </div>
        </div>
      </div>

      <div class="profile-photo-actions">
        <input type="file" id="avatarInput" accept="image/jpeg,image/png,image/webp" hidden>
        <button type="button" class="btn btn-sm btn-primary" id="avatarPick">
          ${user.avatar ? 'Replace photo' : 'Upload photo'}</button>
        ${user.avatar
          ? raw(html`<button type="button" class="btn btn-sm btn-secondary" id="avatarRemove">Remove</button>`)
          : raw('')}
        <p class="form-hint">JPEG, PNG or WebP. Squared and resized in your browser before it is sent.</p>
      </div>
    </div>

    <div class="profile-columns">
      <div class="card">
        <div class="card-header"><h3>Details</h3></div>
        <div class="card-body">
          <dl class="detail-list">
            <div><dt>Full name</dt><dd>${user.fullName}</dd></div>
            <div><dt>Username</dt><dd>${user.username}</dd></div>
            <div><dt>Role</dt><dd>${raw(roleBadge(user.role))}</dd></div>
            <div><dt>Email</dt><dd>${user.email || '—'}</dd></div>
            <div><dt>Phone</dt><dd>${user.phone || '—'}</dd></div>
            <div><dt>Two-factor</dt><dd>${user.mfaEnabled ? `On, by ${user.mfaMethod || 'email'}` : 'Off'}</dd></div>
            <div><dt>Status</dt><dd>${user.isActive ? 'Active' : `Deactivated ${formatDate(user.deactivatedAt)}`}</dd></div>
            ${user.isActive ? raw('') : raw(html`<div><dt>Reason</dt><dd>${user.deactivationReason || '—'}</dd></div>`)}
            <div><dt>Created</dt><dd>${formatDate(user.createdAt)}${user.createdByName ? ` by ${user.createdByName}` : ''}</dd></div>
            <div><dt>Last sign-in</dt><dd>${user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Never'}</dd></div>
            <div><dt>Password set</dt><dd>${pending ? 'Not yet set' : (user.passwordChangedAt ? formatDateTime(user.passwordChangedAt) : '—')}</dd></div>
          </dl>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h3>Actions</h3></div>
        <div class="card-body profile-actions">
          <button type="button" class="btn btn-secondary btn-block" data-edit="${user.id}">Edit details</button>
          <button type="button" class="btn btn-secondary btn-block" data-reset="${user.id}">Reset password</button>
          ${pending
            ? raw(html`<button type="button" class="btn btn-accent-soft btn-block" data-resend="${user.id}">Resend setup link</button>`)
            : raw('')}
          <button type="button" class="btn btn-secondary btn-block" data-mfa="${user.id}"
            data-mfa-state="${user.mfaEnabled ? 'on' : 'off'}">
            ${user.mfaEnabled ? 'Disable two-factor' : 'Enable two-factor'}</button>
          <div class="row-menu-sep"></div>
          ${user.isActive
            ? raw(html`<button type="button" class="btn btn-warning btn-block" data-deactivate="${user.id}">Deactivate account</button>`)
            : raw(html`<button type="button" class="btn btn-success btn-block" data-reactivate="${user.id}">Reactivate account</button>`)}
          <button type="button" class="btn btn-danger btn-block" data-delete="${user.id}">Delete account</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>Recent activity</h3>
        <p class="card-subtitle">The last eight entries for this account</p>
      </div>
      <div class="card-body">
        <div class="table-wrap">
          <table>
            <caption class="sr-only">Recent activity</caption>
            <thead><tr>
              <th scope="col">When</th><th scope="col">Action</th>
              <th scope="col">Detail</th><th scope="col">From</th>
            </tr></thead>
            <tbody>
              ${raw(user.recentActivity?.length
                ? user.recentActivity.map(entry => html`
                  <tr>
                    <td>${formatDateTime(entry.createdAt)}</td>
                    <td><span class="cell-primary">${humanise(entry.action).toLowerCase()}</span></td>
                    <td class="wrap">${entry.details || '—'}</td>
                    <td>${entry.ipAddress || '—'}</td>
                  </tr>`).join('')
                : emptyRow(4, 'Nothing recorded yet'))}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

    hydrateIcons(body);
    wireAvatarControls(user);
}

/* --- Thumbnails in the list --------------------------------------------- */

/* Pictures cannot ride in the list response — 2000 accounts of base64 would be
   a response measured in megabytes — so the rows say only whether one exists
   and these are fetched after the fact. Cached by account and upload time, so
   paging, sorting and searching do not re-fetch what is already in hand, and a
   replaced picture still busts the entry. */
const avatarCache = new Map();

async function fillAvatarThumbnails(root = document) {
    const slots = root.querySelectorAll('[data-avatar-for]:not([data-avatar-done])');

    await Promise.all([...slots].map(async (slot) => {
        const userId = slot.dataset.avatarFor;
        slot.setAttribute('data-avatar-done', '');
        if (!userId) return;                        // No picture: the initials stand.

        try {
            if (!avatarCache.has(userId)) {
                const { avatar } = await apiRequest(`/admin/users/${encodeURIComponent(userId)}/avatar`);
                avatarCache.set(userId, avatar);
            }
            const image = document.createElement('img');
            image.src = avatarCache.get(userId);
            image.alt = '';
            slot.replaceChildren(image);
            slot.classList.add('has-photo');
        } catch {
            /* Leave the initials in place; a missing thumbnail is not worth a
               toast, and the row is still perfectly usable. */
        }
    }));
}

/* --- The picture -------------------------------------------------------- */

function wireAvatarControls(user) {
    const input = document.getElementById('avatarInput');
    const pick = document.getElementById('avatarPick');
    const remove = document.getElementById('avatarRemove');

    pick?.addEventListener('click', () => input.click());

    input?.addEventListener('change', async () => {
        const file = input.files?.[0];
        input.value = '';                       // So picking the same file again still fires.
        if (!file) return;

        pick.disabled = true;
        const original = pick.textContent;
        pick.textContent = 'Uploading…';

        try {
            const image = await squareImage(file);
            await apiRequest(`/admin/users/${encodeURIComponent(user.id)}/avatar`, {
                method: 'PUT',
                body: { image }
            });
            avatarCache.delete(String(user.id));
            showToast(`Profile picture set for ${user.fullName}.`);
            loadStaffProfile(user.id);
            loadStaff();
        } catch (err) {
            showError(err, 'That picture could not be uploaded.');
            pick.disabled = false;
            pick.textContent = original;
        }
    });

    remove?.addEventListener('click', async () => {
        const ok = await confirmAction({
            title: 'Remove profile picture',
            message: `Remove the profile picture for ${user.fullName}?`,
            confirmLabel: 'Remove',
            danger: true
        });
        if (!ok) return;

        try {
            await apiRequest(`/admin/users/${encodeURIComponent(user.id)}/avatar`, { method: 'DELETE' });
            avatarCache.delete(String(user.id));
            showToast('Profile picture removed.');
            loadStaffProfile(user.id);
            loadStaff();
        } catch (err) {
            showError(err, 'That picture could not be removed.');
        }
    });
}

/**
 * Centre-crop a chosen file to a square and re-encode it as JPEG.
 *
 * Doing this in the browser keeps the upload small enough to travel as JSON,
 * and re-encoding through a canvas drops every scrap of metadata the original
 * carried — which for a photo off a phone includes the GPS coordinates of
 * wherever it was taken. The server does not rely on any of this: it reads the
 * type and dimensions back out of the bytes it receives.
 */
async function squareImage(file) {
    if (!file.type.startsWith('image/')) {
        throw new ApiError('That file is not an image.', 'NOT_AN_IMAGE', 400);
    }
    if (file.size > AVATAR_MAX_SOURCE_BYTES) {
        throw new ApiError('That image is very large. Choose one under 12 MB.', 'TOO_LARGE', 400);
    }

    // `from-image` applies the EXIF orientation, so a portrait photo off a
    // phone is not stored on its side.
    let bitmap;
    try {
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
        throw new ApiError('That image could not be read. It may be damaged.', 'DECODE_FAILED', 400);
    }

    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext('2d');

    // JPEG has no transparency, so anything see-through would turn black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);

    // Cover: fill the square from the centre of the image, cropping the long side.
    const side = Math.min(bitmap.width, bitmap.height);
    ctx.drawImage(
        bitmap,
        (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
        0, 0, AVATAR_SIZE, AVATAR_SIZE
    );
    bitmap.close?.();

    // Step the quality down if a busy photo still comes out over the limit.
    for (const quality of [0.85, 0.72, 0.6, 0.45]) {
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        if (dataUrl.length * 0.75 <= 262144) return dataUrl;
    }
    throw new ApiError('That image could not be compressed enough. Try a simpler picture.', 'TOO_LARGE', 400);
}

function openStaffModal(userId) {
    editingUserId = userId;
    const form = document.getElementById('staffForm');
    form.reset();

    const usernameField = document.getElementById('uUsername');
    const roleField = document.getElementById('uRole');

    if (userId) {
        const user = staffTable.find(userId);
        if (!user) return;

        document.getElementById('staffModalTitle').textContent = `Edit ${user.fullName}`;
        document.getElementById('staffSubmitBtn').textContent = 'Save changes';

        document.getElementById('uFullName').value = user.fullName || '';
        usernameField.value = user.username || '';
        usernameField.disabled = true;
        usernameField.required = false;
        document.getElementById('uUsernameHint').textContent = 'A username cannot be changed after creation';

        document.getElementById('uEmail').value = user.email || '';
        document.getElementById('uPhone').value = user.phone || '';

        // Teachers appear in this list but are edited from the HR dashboard.
        if (user.role === 'teacher') {
            roleField.innerHTML = html`<option value="teacher">Teacher</option>`;
            roleField.disabled = true;
        } else {
            roleField.innerHTML = html`<option value="hr">HR</option>
        <option value="accountant">Accountant</option>
        <option value="admin">Administrator</option>`;
            roleField.disabled = false;
        }
        roleField.value = user.role;
    } else {
        document.getElementById('staffModalTitle').textContent = 'Add account';
        document.getElementById('staffSubmitBtn').textContent = 'Create account';

        usernameField.disabled = false;
        usernameField.required = true;
        document.getElementById('uUsernameHint').textContent =
            '3–32 characters: letters, numbers, dots, hyphens, underscores';

        roleField.innerHTML = html`<option value="hr">HR</option>
      <option value="accountant">Accountant</option>
      <option value="admin">Administrator</option>`;
        roleField.disabled = false;
    }

    document.getElementById('departmentGroup').hidden = roleField.value !== 'accountant';
    openModal('staffModal');
}

async function saveStaff(event) {
    event.preventDefault();

    const payload = readForm('staffForm');
    const submit = document.getElementById('staffSubmitBtn');

    await withBusy(submit, 'Saving…', async () => {
        try {
            if (editingUserId) {
                delete payload.username;
                await apiRequest(`/admin/users/${editingUserId}`, { method: 'PUT', body: payload });
                showToast('Account updated.', 'success');
            } else {
                const result = await apiRequest('/admin/users', { method: 'POST', body: payload });
                showToast(result.message, 'success');

                if (result.activation?.temporaryPassword) {
                    showSecret({
                        title: 'Temporary password',
                        label: `${payload.fullName} · username ${result.username}`,
                        secret: result.activation.temporaryPassword,
                        note: 'Shown only once. Share it over a secure channel — they must change it at first sign-in.'
                    });
                }
                if (result.activation?.emailError) {
                    showToast(result.activation.emailError, 'warning', { duration: 9000 });
                }
            }

            closeModal('staffModal');
            loadStaff();
            loadStats();
        } catch (err) {
            showError(err);
        }
    });
}

async function resetPassword(userId) {
    const user = staffTable.find(userId);

    const ok = await confirmAction({
        title: `Reset the password for ${user?.fullName || 'this account'}?`,
        message: 'A new temporary password is generated and shown once. Their current sessions end immediately, '
            + 'and they must choose a new password at next sign-in.',
        confirmLabel: 'Generate temporary password',
        danger: true
    });
    if (!ok) return;

    try {
        const result = await apiRequest(`/admin/users/${userId}/reset-password`, { method: 'POST', body: {} });

        showSecret({
            title: 'Temporary password',
            label: `${user?.fullName} · username ${user?.username}`,
            secret: result.temporaryPassword,
            note: 'Shown only once. Share it over a secure channel.'
        });

        loadStaff();
    } catch (err) {
        showError(err);
    }
}

async function resendSetupLink(userId, button) {
    await withBusy(button, 'Sending…', async () => {
        try {
            const result = await apiRequest(`/admin/users/${userId}/resend-setup`, { method: 'POST' });
            showToast(result.message, 'success');
        } catch (err) {
            showError(err);
        }
    });
}

async function toggleMfa(userId, enable) {
    const user = staffTable.find(userId);

    if (!enable) {
        const ok = await confirmAction({
            title: `Turn off two-factor authentication for ${user?.fullName}?`,
            message: 'Their account will be protected by a password alone. This is recorded in the audit log.',
            confirmLabel: 'Turn off',
            danger: true
        });
        if (!ok) return;
    }

    try {
        const result = await apiRequest(`/admin/users/${userId}/mfa`, {
            method: 'POST',
            body: { enabled: enable }
        });
        showToast(result.message, 'success');
        loadStaff();
    } catch (err) {
        showError(err);
    }
}

async function setAccountStatus(userId, activate) {
    const user = staffTable.find(userId);

    if (!activate) {
        const ok = await confirmAction({
            title: `Deactivate ${user?.fullName || 'this account'}?`,
            message: 'They will be signed out immediately and unable to sign in. All their records are kept, '
                + 'and the account can be reactivated later.',
            confirmLabel: 'Deactivate',
            danger: true
        });
        if (!ok) return;
    }

    try {
        const result = await apiRequest(`/admin/users/${userId}/${activate ? 'reactivate' : 'deactivate'}`, {
            method: 'POST',
            body: {}
        });
        showToast(result.message, 'success');
        loadStaff();
        loadStats();
    } catch (err) {
        showError(err);
    }
}

async function deleteAccount(userId) {
    const user = staffTable.find(userId);

    // Typing the username guards against deleting the wrong row.
    const ok = await confirmAction({
        title: `Permanently delete ${user?.fullName || 'this account'}?`,
        message: 'This cannot be undone. Audit entries are kept but detached from the account. '
            + 'Deletion is refused if the person appears on any payroll run — deactivate them instead.',
        confirmLabel: 'Delete permanently',
        danger: true,
        requireText: user?.username
    });
    if (!ok) return;

    try {
        const result = await apiRequest(`/admin/users/${userId}`, { method: 'DELETE' });
        showToast(result.message, 'success');
        loadStaff();
        loadStats();
    } catch (err) {
        showError(err);
    }
}

/* -------------------------------------------------------------------------- */

async function loadConfig() {
    try {
        const config = await apiRequest('/admin/config');
        setCurrency(config.currency);

        document.getElementById('cfgSchoolName').value = config.schoolName || '';
        document.getElementById('cfgCurrency').value = config.currency || 'UGX';
        document.getElementById('cfgTaxEnabled').checked = config.taxEnabled !== false;
        document.getElementById('cfgTaxMode').value = config.taxMode || 'banded';
        document.getElementById('cfgNssfEmployee').value = config.nssfEmployeePercentage ?? 5;
        document.getElementById('cfgNssfEmployer').value = config.nssfEmployerPercentage ?? 10;
        document.getElementById('cfgMinNet').value = config.minimumNetPercentage ?? 30;
        document.getElementById('cfgMaxAdvance').value = config.maxAdvancePercentage ?? 50;
        document.getElementById('cfgMaxInstalments').value = config.maxAdvanceInstalments ?? 6;
        document.getElementById('cfgLeaveDays').value = config.defaultAnnualLeaveDays ?? 21;
    } catch (err) {
        showError(err, 'Could not load the settings.');
    }
}

async function saveConfig(event) {
    event.preventDefault();

    const payload = readForm('configForm');
    ['nssfEmployeePercentage', 'nssfEmployerPercentage', 'minimumNetPercentage',
        'maxAdvancePercentage', 'maxAdvanceInstalments', 'defaultAnnualLeaveDays'].forEach(key => {
            payload[key] = Number(payload[key]);
        });

    const submit = event.target.querySelector('button[type="submit"]');

    await withBusy(submit, 'Saving…', async () => {
        try {
            const result = await apiRequest('/admin/config', { method: 'PUT', body: payload });
            showToast(result.message, 'success');
            setCurrency(result.config.currency);
        } catch (err) {
            showError(err);
        }
    });
}

/* -------------------------------------------------------------------------- */

async function loadReports() {
    reportTable.showLoading();
    try {
        reportTable.setData(await apiRequest('/admin/reports/payroll-summary'));
    } catch (err) {
        showError(err, 'Could not load reports.');
        reportTable.setData([]);
    }
}

/**
 * Keyset-paginated audit log. The server pages on a monotonic id rather than
 * OFFSET, which stays fast at any depth.
 */
async function loadAudit({ reset }) {
    const body = document.getElementById('auditTableBody');
    const moreBtn = document.getElementById('auditMoreBtn');

    if (reset) {
        auditCursor = null;
        auditRows = [];
        body.innerHTML = loadingRow(5);
    }

    const params = new URLSearchParams({ limit: '50' });
    const username = document.getElementById('auditUsername').value.trim();
    const action = document.getElementById('auditAction').value;

    if (username) params.set('username', username.toLowerCase());
    if (action) params.set('action', action);
    if (auditCursor) params.set('cursor', auditCursor);

    try {
        const result = await apiRequest(`/admin/audit-log?${params}`);

        auditRows = auditRows.concat(result.entries);
        auditCursor = result.nextCursor;

        body.innerHTML = auditRows.length
            ? auditRows.map(entry => html`
        <tr>
          <td class="nowrap">${formatDateTime(entry.createdAt)}</td>
          <td>
            <span class="cell-primary">${entry.username || 'system'}</span>
            ${entry.role ? raw(html`<span class="cell-sub">${entry.role}</span>`) : raw('')}
          </td>
          <td><code>${entry.action}</code></td>
          <td class="wrap">${entry.details}</td>
          <td>${entry.ipAddress || '—'}</td>
        </tr>`).join('')
            : emptyRow(5, 'No audit entries match', 'Try clearing the filters.');

        moreBtn.hidden = !result.hasMore;
    } catch (err) {
        body.innerHTML = emptyRow(5, 'Could not load the audit log', err.message);
        moreBtn.hidden = true;
    }
}

async function loadMfaActivity() {
    const body = document.getElementById('mfaTableBody');
    body.innerHTML = loadingRow(6);

    try {
        const rows = await apiRequest('/admin/mfa-status');

        body.innerHTML = rows.length
            ? rows.map(row => html`
        <tr>
          <td>
            <span class="cell-primary">${row.fullName}</span>
            <span class="cell-sub">${row.username}</span>
          </td>
          <td>${raw(roleBadge(row.role))}</td>
          <td>${row.method === 'authenticator' ? 'Authenticator app' : 'Email'}</td>
          <td>${row.maskedEmail || '—'}</td>
          <td class="numeric">${row.attempts}</td>
          <td>${formatRelative(row.expiresAt)}</td>
        </tr>`).join('')
            : emptyRow(6, 'No sign-ins are in progress',
                'Challenges appear here while someone is partway through signing in.');
    } catch (err) {
        body.innerHTML = emptyRow(6, 'Could not load two-factor activity', err.message);
    }
}

async function downloadBackup() {
    const button = document.getElementById('backupBtn');

    await withBusy(button, 'Preparing…', async () => {
        try {
            // Not a recognised download content type, so fetch it directly.
            const response = await fetch('/api/admin/backup', {
                headers: { Authorization: `Bearer ${getToken()}` }
            });
            if (!response.ok) throw new Error('The export failed.');

            downloadBlob(await response.blob(), `edupay_backup_${new Date().toISOString().slice(0, 10)}.json`);
            showToast('Your export has been downloaded.', 'success');
        } catch (err) {
            showError(err, 'Could not create the export.');
        }
    });
}
