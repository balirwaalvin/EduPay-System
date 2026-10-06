/* EduPay — teacher portal */
'use strict';

let profileData = null;
let advanceLimits = null;
let payslipTable;
let historyTable;
let leaveTable;
let advanceTable;

document.addEventListener('DOMContentLoaded', () => {
    if (!initDashboard({ role: 'teacher' })) return;

    buildTables();
    wireForms();

    loadDashboard();
    loadProfile();
});

/* -------------------------------------------------------------------------- */

function buildTables() {
    payslipTable = createTable({
        tbody: 'payslipTableBody',
        columns: 6,
        pageSize: 15,
        searchInput: 'payslipSearch',
        countTarget: 'payslipCount',
        pagerTarget: 'payslipPager',
        searchFields: ['periodLabel'],
        emptyMessage: 'No payslips yet',
        emptyHint: 'Your payslip appears here once HR approves the payroll run.',
        renderRow: item => html`
      <tr>
        <td class="cell-primary">${item.periodLabel || periodLabel(item.month, item.year)}</td>
        <td class="numeric">${formatCurrency(item.grossSalary)}</td>
        <td class="numeric">${formatCurrency(item.totalDeductions)}</td>
        <td class="numeric cell-primary">${formatCurrency(item.netSalary)}</td>
        <td>${raw(badge(item.paymentStatus))}</td>
        <td>
          <button type="button" class="btn btn-sm btn-secondary" data-payslip="${item.id}">Download</button>
        </td>
      </tr>`
    });

    historyTable = createTable({
        tbody: 'historyTableBody',
        columns: 7,
        pageSize: 15,
        pagerTarget: 'historyPager',
        emptyMessage: 'No salary history yet',
        renderRow: row => html`
      <tr>
        <td class="cell-primary">${periodLabel(row.month, row.year)}</td>
        <td class="numeric">${formatCurrency(row.grossSalary)}</td>
        <td class="numeric">${formatCurrency(row.taxAmount)}</td>
        <td class="numeric">${formatCurrency(row.nssfAmount)}</td>
        <td class="numeric">${formatCurrency(row.advanceDeduction)}</td>
        <td class="numeric cell-primary">${formatCurrency(row.netSalary)}</td>
        <td>${raw(badge(row.paymentStatus))}</td>
      </tr>`
    });

    leaveTable = createTable({
        tbody: 'leaveTableBody',
        columns: 6,
        pageSize: 15,
        pagerTarget: 'leavePager',
        emptyMessage: 'No leave requests yet',
        emptyHint: 'Use “Request leave” to submit one to HR.',
        renderRow: request => html`
      <tr>
        <td>
          <span class="cell-primary">${request.leaveType}</span>
          ${request.isUnpaid ? raw('<span class="cell-sub">Unpaid</span>') : raw('')}
        </td>
        <td>${formatDate(request.startDate)} – ${formatDate(request.endDate)}</td>
        <td class="numeric">${request.days}</td>
        <td class="wrap">${request.reason}</td>
        <td>
          ${raw(badge(request.status))}
          ${request.decisionNote ? raw(html`<span class="cell-sub">${request.decisionNote}</span>`) : raw('')}
        </td>
        <td>${request.status === 'Pending'
            ? raw(html`<button type="button" class="btn btn-sm btn-secondary" data-cancel-leave="${request.id}">Withdraw</button>`)
            : raw('—')}</td>
      </tr>`
    });

    advanceTable = createTable({
        tbody: 'advanceTableBody',
        columns: 7,
        pageSize: 15,
        pagerTarget: 'advancePager',
        emptyMessage: 'No advance requests yet',
        renderRow: advance => html`
      <tr>
        <td>${formatDate(advance.createdAt)}</td>
        <td class="numeric">${formatCurrency(advance.amount)}</td>
        <td class="numeric">${formatCurrency(advance.amountRepaid)}</td>
        <td class="numeric cell-primary">${formatCurrency(advance.outstanding)}</td>
        <td>
          ${advance.instalmentsPaid || 0} of ${advance.instalments || 1}
          ${advance.instalmentAmount > 0
                ? raw(html`<span class="cell-sub">Next: ${formatCurrency(advance.instalmentAmount)}</span>`)
                : raw('')}
        </td>
        <td>${raw(badge(advance.status))}</td>
        <td>${advance.status === 'Pending'
                ? raw(html`<button type="button" class="btn btn-sm btn-secondary" data-cancel-advance="${advance.id}">Withdraw</button>`)
                : raw('—')}</td>
      </tr>`
    });

    // One delegated listener per table, rather than inline onclick attributes.
    document.getElementById('payslipTableBody').addEventListener('click', (event) => {
        const id = event.target.closest('[data-payslip]')?.dataset.payslip;
        if (id) downloadPayslip(id, event.target.closest('[data-payslip]'));
    });

    document.getElementById('leaveTableBody').addEventListener('click', (event) => {
        const id = event.target.closest('[data-cancel-leave]')?.dataset.cancelLeave;
        if (id) cancelLeave(id);
    });

    document.getElementById('advanceTableBody').addEventListener('click', (event) => {
        const id = event.target.closest('[data-cancel-advance]')?.dataset.cancelAdvance;
        if (id) cancelAdvance(id);
    });
}

function wireForms() {
    document.getElementById('newLeaveBtn').addEventListener('click', openLeaveModal);
    document.getElementById('newAdvanceBtn').addEventListener('click', openAdvanceModal);

    document.getElementById('leaveForm').addEventListener('submit', submitLeave);
    document.getElementById('advanceForm').addEventListener('submit', submitAdvance);
    document.getElementById('profileForm').addEventListener('submit', saveProfile);

    document.getElementById('profPaymentMethod').addEventListener('change', togglePaymentFields);

    // Live day count and unpaid-leave warning as the dates change.
    ['leaveStart', 'leaveEnd', 'leaveType'].forEach(id => {
        document.getElementById(id).addEventListener('change', updateLeavePreview);
    });

    // Load each section's data the first time it is shown.
    const loaded = new Set();
    document.addEventListener('section:shown', (event) => {
        const section = event.detail.sectionId;
        if (loaded.has(section)) return;
        loaded.add(section);

        if (section === 'payslips') loadPayslips();
        else if (section === 'history') loadHistory();
        else if (section === 'leave') loadLeave();
        else if (section === 'advances') loadAdvances();
    });
}

/* -------------------------------------------------------------------------- */

async function loadDashboard() {
    try {
        const stats = await apiRequest('/teacher/stats');
        setCurrency(stats.currency);

        document.getElementById('statLatestNet').textContent = formatCurrency(stats.latestNetSalary);
        setText('heroNet', formatCurrency(stats.latestNetSalary));
        document.getElementById('statLatestPeriod').textContent = stats.latestPeriod
            ? `For ${stats.latestPeriod}`
            : 'No payslips yet';
        document.getElementById('statTotalEarned').textContent = formatCurrency(stats.totalEarnedToDate);
        document.getElementById('statLeaveLeft').textContent = `${stats.leaveBalance.remainingDays} days`;
        document.getElementById('statLeaveHint').textContent =
            `${stats.leaveBalance.approvedDays} of ${stats.leaveBalance.entitlementDays} used`;
        document.getElementById('statAdvance').textContent = formatCurrency(stats.advanceOutstanding);

        // A paused payroll is the single most important thing to surface.
        const banner = document.getElementById('haltBanner');
        if (stats.payrollHalted) {
            banner.innerHTML = html`<div class="alert alert-warning" role="alert">
        <span class="alert-icon" aria-hidden="true">⚠</span>
        <span><strong>Your payroll is paused.</strong>
        ${stats.payrollHaltReason ? `Reason: ${stats.payrollHaltReason}.` : ''}
        You will not be included in the next payroll run — contact HR if this is unexpected.</span>
      </div>`;
            banner.hidden = false;
        } else {
            banner.hidden = true;
        }
    } catch (err) {
        showError(err, 'Could not load your dashboard.');
    }
}

async function loadProfile() {
    try {
        profileData = await apiRequest('/teacher/profile');
        setCurrency(profileData.currency);

        document.getElementById('profName').value = profileData.fullName || '';
        document.getElementById('profEmpId').value = profileData.employeeId || '';
        document.getElementById('profPosition').value = profileData.position || 'Not set';
        document.getElementById('profScale').value = profileData.salaryScale || '';
        document.getElementById('profEmail').value = profileData.email || '';
        document.getElementById('profPhone').value = profileData.phone || '';

        document.getElementById('profPaymentMethod').value = profileData.paymentMethod || 'bank';
        document.getElementById('profBankName').value = profileData.bankName || '';
        document.getElementById('profBankAccountName').value = profileData.bankAccountName || '';
        document.getElementById('profBankAccountNumber').value = profileData.bankAccountNumber || '';
        document.getElementById('profMomoProvider').value = profileData.mobileMoneyProvider || '';
        document.getElementById('profMomoNumber').value = profileData.mobileMoneyNumber || '';
        togglePaymentFields();

        renderStructure(profileData);

        document.getElementById('leaveEntitlement').textContent = `${profileData.leaveBalance.entitlementDays} days`;
        document.getElementById('leaveRemaining').textContent = `${profileData.leaveBalance.remainingDays} days`;
        document.getElementById('leavePending').textContent = `${profileData.leaveBalance.pendingDays} days`;
    } catch (err) {
        showError(err, 'Could not load your profile.');
    }
}

function renderStructure(profile) {
    const rows = [
        ['Basic salary', profile.basicSalary],
        ['Housing allowance', profile.housingAllowance],
        ['Transport allowance', profile.transportAllowance],
        ['Medical allowance', profile.medicalAllowance],
        ['Other allowance', profile.otherAllowance]
    ];

    const gross = rows.reduce((sum, [, value]) => sum + Number(value || 0), 0);

    const body = document.getElementById('structureTableBody');

    if (profile.scaleMissing) {
        body.innerHTML = emptyRow(2, 'Your salary scale is not configured',
            `Scale “${profile.salaryScale}” no longer exists. Contact HR — payroll cannot be calculated until this is fixed.`);
        return;
    }

    body.innerHTML = rows.map(([label, value]) => html`
    <tr>
      <td>${label}</td>
      <td class="numeric">${formatCurrency(value)}</td>
    </tr>`).join('') + html`
    <tr>
      <td class="cell-primary">Gross salary</td>
      <td class="numeric cell-primary">${formatCurrency(gross)}</td>
    </tr>`;
}

function togglePaymentFields() {
    const isMomo = document.getElementById('profPaymentMethod').value === 'mobile_money';
    document.getElementById('profBankFields').hidden = isMomo;
    document.getElementById('profMomoFields').hidden = !isMomo;
}

async function saveProfile(event) {
    event.preventDefault();
    const submit = event.target.querySelector('button[type="submit"]');

    const payload = readForm('profileForm');

    await withBusy(submit, 'Saving…', async () => {
        try {
            await apiRequest('/teacher/profile', { method: 'PUT', body: payload });
            showToast('Your details have been updated.', 'success');
            loadProfile();
        } catch (err) {
            showError(err);
        }
    });
}

/* -------------------------------------------------------------------------- */

async function loadPayslips() {
    payslipTable.showLoading();
    try {
        const items = await apiRequest('/teacher/payslips');
        payslipTable.setData(items.map(item => ({
            ...item,
            periodLabel: item.periodLabel || periodLabel(item.month, item.year),
            periodSort: item.year * 100 + item.month
        })));
    } catch (err) {
        showError(err, 'Could not load your payslips.');
        payslipTable.setData([]);
    }
}

async function downloadPayslip(id, button) {
    await withBusy(button, 'Preparing…', async () => {
        try {
            await apiRequest(`/teacher/payslip/${id}/pdf`);
        } catch (err) {
            showError(err, 'Could not download the payslip.');
        }
    });
}

async function loadHistory() {
    historyTable.showLoading();
    try {
        historyTable.setData(await apiRequest('/teacher/salary-history'));
    } catch (err) {
        showError(err, 'Could not load your salary history.');
        historyTable.setData([]);
    }
}

/* -------------------------------------------------------------------------- */

let leaveTypes = [];

async function loadLeave() {
    leaveTable.showLoading();
    try {
        const data = await apiRequest('/teacher/leave');
        leaveTypes = data.leaveTypes;
        leaveTable.setData(data.requests);

        document.getElementById('leaveEntitlement').textContent = `${data.balance.entitlementDays} days`;
        document.getElementById('leaveRemaining').textContent = `${data.balance.remainingDays} days`;
        document.getElementById('leavePending').textContent = `${data.balance.pendingDays} days`;
    } catch (err) {
        showError(err, 'Could not load your leave requests.');
        leaveTable.setData([]);
    }
}

function openLeaveModal() {
    const form = document.getElementById('leaveForm');
    form.reset();

    fillSelect('leaveType', leaveTypes.map(type => ({ value: type.value, label: type.label })));

    const today = new Date().toISOString().slice(0, 10);
    document.getElementById('leaveStart').min = today;
    document.getElementById('leaveEnd').min = today;
    document.getElementById('leaveDaysHint').textContent = '';

    updateLeavePreview();
    openModal('leaveModal');
}

/** Show the day count, and warn clearly when the type is unpaid. */
function updateLeavePreview() {
    const start = document.getElementById('leaveStart').value;
    const end = document.getElementById('leaveEnd').value;
    const selected = leaveTypes.find(t => t.value === document.getElementById('leaveType').value);

    const typeHint = document.getElementById('leaveTypeHint');
    typeHint.textContent = selected && !selected.paid
        ? 'This is unpaid leave — your basic pay will be reduced pro rata for these days.'
        : 'Paid leave draws down your annual entitlement.';

    const daysHint = document.getElementById('leaveDaysHint');
    if (!start || !end) {
        daysHint.textContent = '';
        return;
    }

    const startDate = new Date(`${start}T00:00:00Z`);
    const endDate = new Date(`${end}T00:00:00Z`);

    if (endDate < startDate) {
        daysHint.textContent = 'The end date is before the start date.';
        return;
    }

    const days = Math.floor((endDate - startDate) / 86400000) + 1;
    daysHint.textContent = `${days} day${days === 1 ? '' : 's'} requested.`;
}

async function submitLeave(event) {
    event.preventDefault();
    const submit = event.target.querySelector('button[type="submit"]');

    await withBusy(submit, 'Submitting…', async () => {
        try {
            const result = await apiRequest('/teacher/leave', { method: 'POST', body: readForm('leaveForm') });
            closeModal('leaveModal');
            showToast(result.message, 'success');
            loadLeave();
            loadDashboard();
        } catch (err) {
            showError(err);
        }
    });
}

async function cancelLeave(id) {
    const ok = await confirmAction({
        title: 'Withdraw this leave request?',
        message: 'HR will no longer see it. You can submit a new request afterwards.',
        confirmLabel: 'Withdraw request'
    });
    if (!ok) return;

    try {
        const result = await apiRequest(`/teacher/leave/${id}/cancel`, { method: 'POST' });
        showToast(result.message, 'success');
        loadLeave();
    } catch (err) {
        showError(err);
    }
}

/* -------------------------------------------------------------------------- */

async function loadAdvances() {
    advanceTable.showLoading();
    try {
        const data = await apiRequest('/teacher/advances');
        advanceLimits = data.limits;
        advanceTable.setData(data.requests);

        document.getElementById('advanceLimitHint').textContent =
            `You may request up to ${formatCurrency(data.limits.maxAmount, data.limits.currency)} `
            + `(${data.limits.maxAdvancePercentage}% of net pay), repayable over up to `
            + `${data.limits.maxInstalments} payroll runs.`;
    } catch (err) {
        showError(err, 'Could not load your advance requests.');
        advanceTable.setData([]);
    }
}

function openAdvanceModal() {
    if (!advanceLimits) {
        showToast('Still loading your advance limits — try again in a moment.', 'warning');
        return;
    }

    const form = document.getElementById('advanceForm');
    form.reset();

    const instalments = Array.from({ length: advanceLimits.maxInstalments }, (_, i) => ({
        value: i + 1,
        label: i === 0 ? '1 payroll run' : `${i + 1} payroll runs`
    }));
    fillSelect('advanceInstalments', instalments, { selected: 1 });

    document.getElementById('advanceAmount').max = advanceLimits.maxAmount;
    document.getElementById('advanceMaxHint').textContent =
        `Maximum ${formatCurrency(advanceLimits.maxAmount, advanceLimits.currency)} based on your estimated net pay of `
        + `${formatCurrency(advanceLimits.estimatedMonthlyNet, advanceLimits.currency)}.`;

    openModal('advanceModal');
}

async function submitAdvance(event) {
    event.preventDefault();
    const submit = event.target.querySelector('button[type="submit"]');

    const payload = readForm('advanceForm');
    payload.amount = Number(payload.amount);
    payload.instalments = Number(payload.instalments);

    await withBusy(submit, 'Submitting…', async () => {
        try {
            const result = await apiRequest('/teacher/advances', { method: 'POST', body: payload });
            closeModal('advanceModal');
            showToast(result.message, 'success');
            loadAdvances();
            loadDashboard();
        } catch (err) {
            showError(err);
        }
    });
}

async function cancelAdvance(id) {
    const ok = await confirmAction({
        title: 'Withdraw this advance request?',
        message: 'HR will no longer see it. You can submit a new request afterwards.',
        confirmLabel: 'Withdraw request'
    });
    if (!ok) return;

    try {
        const result = await apiRequest(`/teacher/advances/${id}/cancel`, { method: 'POST' });
        showToast(result.message, 'success');
        loadAdvances();
    } catch (err) {
        showError(err);
    }
}
