/* EduPay — accountant dashboard */
'use strict';

let payrollTable;
let paymentTable;
let teacherTable;
let reportTable;

let allPayrollRuns = [];
let selectedPayrollRun = null;
let pendingPaymentItem = null;
let pendingHaltTeacherId = null;

document.addEventListener('DOMContentLoaded', () => {
    if (!initDashboard({ role: 'accountant' })) return;

    buildTables();
    buildPeriodSelectors();
    wireForms();

    loadStats();
    loadPayrollRuns();
});

/* -------------------------------------------------------------------------- */

function buildTables() {
    payrollTable = createTable({
        tbody: 'payrollTableBody',
        columns: 7,
        pageSize: 20,
        searchInput: 'payrollSearch',
        countTarget: 'payrollCount',
        pagerTarget: 'payrollPager',
        searchFields: ['periodLabel', 'status'],
        emptyMessage: 'No payroll runs yet',
        emptyHint: 'Process one from the Dashboard to get started.',
        renderRow: run => html`
      <tr>
        <td>
          <span class="cell-primary">${run.periodLabel}</span>
          ${run.version > 1 ? raw(html`<span class="cell-sub">Version ${run.version}</span>`) : raw('')}
        </td>
        <td class="numeric">${run.employeeCount ?? 0}</td>
        <td class="numeric">${formatCurrency(run.totalGross)}</td>
        <td class="numeric cell-primary">${formatCurrency(run.totalNet)}</td>
        <td>
          ${raw(badge(run.status))}
          ${run.status === 'rejected' && run.rejectionReason
                ? raw(html`<span class="cell-sub">${run.rejectionReason}</span>`)
                : raw('')}
        </td>
        <td>
          ${run.processedByName || '—'}
          ${run.approvedByName ? raw(html`<span class="cell-sub">Approved by ${run.approvedByName}</span>`) : raw('')}
        </td>
        <td>
          <div class="action-btns">
            <button type="button" class="btn btn-sm btn-secondary" data-view="${run.id}">View</button>
            <button type="button" class="btn btn-sm btn-secondary" data-export-excel="${run.id}">Excel</button>
            <button type="button" class="btn btn-sm btn-secondary" data-export-pdf="${run.id}">PDF</button>
          </div>
        </td>
      </tr>`
    });

    paymentTable = createTable({
        tbody: 'paymentTableBody',
        columns: 6,
        pageSize: 25,
        searchInput: 'paymentSearch',
        countTarget: 'paymentCount',
        pagerTarget: 'paymentPager',
        searchFields: ['teacherName', 'employeeId'],
        emptyMessage: 'Choose a payroll run above',
        renderRow: item => html`
      <tr>
        <td>
          <span class="cell-primary">${item.teacherName}</span>
          <span class="cell-sub">${item.employeeId}</span>
        </td>
        <td class="numeric">${formatCurrency(item.grossSalary)}</td>
        <td class="numeric">${formatCurrency(item.totalDeductions)}</td>
        <td class="numeric cell-primary">${formatCurrency(item.netSalary)}</td>
        <td>
          ${raw(badge(item.paymentStatus))}
          ${item.paymentReference ? raw(html`<span class="cell-sub">Ref ${item.paymentReference}</span>`) : raw('')}
        </td>
        <td>
          <div class="action-btns">
            ${item.paymentStatus === 'Pending'
                ? raw(html`<button type="button" class="btn btn-sm btn-success" data-pay="${item.id}">Mark paid</button>`)
                : raw(html`<button type="button" class="btn btn-sm btn-secondary" data-unpay="${item.id}">Revert</button>`)}
            <button type="button" class="btn btn-sm btn-secondary" data-payslip="${item.id}">Payslip</button>
          </div>
        </td>
      </tr>`
    });

    teacherTable = createTable({
        tbody: 'teacherTableBody',
        columns: 7,
        pageSize: 25,
        searchInput: 'teacherSearch',
        countTarget: 'teacherCount',
        pagerTarget: 'teacherPager',
        searchFields: ['fullName', 'employeeId', 'salaryScale'],
        emptyMessage: 'No active teachers',
        renderRow: teacher => html`
      <tr>
        <td>
          <span class="cell-primary">${teacher.fullName}</span>
          <span class="cell-sub">${teacher.employeeId}</span>
        </td>
        <td>
          ${teacher.salaryScale}
          ${teacher.scaleMissing
                ? raw('<span class="cell-sub text-danger">Scale missing</span>')
                : raw('')}
        </td>
        <td class="numeric">${formatCurrency(teacher.basicSalary)}</td>
        <td>
          ${teacher.paymentMethod === 'mobile_money' ? 'Mobile money' : 'Bank transfer'}
          <span class="cell-sub">${teacher.paymentMethod === 'mobile_money'
                ? (teacher.mobileMoneyNumber || 'Not set')
                : (teacher.bankAccountNumber || 'Not set')}</span>
        </td>
        <td class="numeric">${teacher.nextPayrollAdvance > 0 ? formatCurrency(teacher.nextPayrollAdvance) : '—'}</td>
        <td>
          ${teacher.payrollHalted
                ? raw(html`${badge('Rejected', 'Paused')}<span class="cell-sub">${teacher.payrollHaltReason || ''}</span>`)
                : raw(badge('Approved', 'Active'))}
        </td>
        <td>
          ${teacher.payrollHalted
                ? raw(html`<button type="button" class="btn btn-sm btn-success" data-resume="${teacher.id}">Resume</button>`)
                : raw(html`<button type="button" class="btn btn-sm btn-warning" data-halt="${teacher.id}">Pause</button>`)}
        </td>
      </tr>`
    });

    reportTable = createTable({
        tbody: 'reportTableBody',
        columns: 7,
        pageSize: 20,
        pagerTarget: 'reportPager',
        emptyMessage: 'No payroll runs match this filter',
        renderRow: run => html`
      <tr>
        <td class="cell-primary">${run.periodLabel}</td>
        <td class="numeric">${run.employeeCount ?? 0}</td>
        <td class="numeric">${formatCurrency(run.totalGross)}</td>
        <td class="numeric">${formatCurrency(run.totalNet)}</td>
        <td class="numeric">${formatCurrency(run.totalEmployerCost)}</td>
        <td>${raw(badge(run.status))}</td>
        <td>
          <div class="action-btns">
            <button type="button" class="btn btn-sm btn-secondary" data-export-excel="${run.id}">Excel</button>
            <button type="button" class="btn btn-sm btn-secondary" data-export-pdf="${run.id}">PDF</button>
            <button type="button" class="btn btn-sm btn-secondary" data-statutory="${run.id}">Statutory</button>
          </div>
        </td>
      </tr>`
    });

    // Delegated table actions.
    document.getElementById('payrollTableBody').addEventListener('click', handleRunAction);
    document.getElementById('reportTableBody').addEventListener('click', handleRunAction);

    document.getElementById('paymentTableBody').addEventListener('click', (event) => {
        const pay = event.target.closest('[data-pay]')?.dataset.pay;
        const unpay = event.target.closest('[data-unpay]')?.dataset.unpay;
        const slip = event.target.closest('[data-payslip]')?.dataset.payslip;

        if (pay) openPaymentModal(pay);
        else if (unpay) revertPayment(unpay);
        else if (slip) downloadPayslip(slip, event.target.closest('[data-payslip]'));
    });

    document.getElementById('teacherTableBody').addEventListener('click', (event) => {
        const halt = event.target.closest('[data-halt]')?.dataset.halt;
        const resume = event.target.closest('[data-resume]')?.dataset.resume;

        if (halt) openHaltModal(halt);
        else if (resume) setPayrollHalt(resume, false);
    });
}

function handleRunAction(event) {
    const view = event.target.closest('[data-view]')?.dataset.view;
    const excel = event.target.closest('[data-export-excel]')?.dataset.exportExcel;
    const pdf = event.target.closest('[data-export-pdf]')?.dataset.exportPdf;
    const statutory = event.target.closest('[data-statutory]')?.dataset.statutory;

    if (view) openPayrollDetail(view);
    else if (excel) exportRun(excel, 'excel', event.target.closest('[data-export-excel]'));
    else if (pdf) exportRun(pdf, 'pdf', event.target.closest('[data-export-pdf]'));
    else if (statutory) loadStatutory(statutory);
}

function buildPeriodSelectors() {
    const now = new Date();
    const months = Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: getMonthName(i + 1) }));
    const years = Array.from({ length: 6 }, (_, i) => {
        const year = now.getFullYear() + 1 - i;
        return { value: year, label: String(year) };
    });

    // Default to the previous month, which is the usual run being processed.
    const lastMonth = now.getMonth() === 0 ? 12 : now.getMonth();
    const lastMonthYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();

    fillSelect('processMonth', months, { selected: lastMonth });
    fillSelect('processYear', years, { selected: lastMonthYear });

    fillSelect('reportMonth', months, { placeholder: 'All months' });
    fillSelect('reportYear', years, { placeholder: 'All years' });
}

function wireForms() {
    document.getElementById('processForm').addEventListener('submit', processPayroll);
    document.getElementById('haltForm').addEventListener('submit', submitHalt);
    document.getElementById('paymentForm').addEventListener('submit', submitPayment);

    document.getElementById('paymentPayrollSelect').addEventListener('change', (event) => {
        loadPaymentItems(event.target.value);
    });

    document.getElementById('markAllPaidBtn').addEventListener('click', markAllPaid);

    ['reportMonth', 'reportYear'].forEach(id => {
        document.getElementById(id).addEventListener('change', loadReports);
    });

    const loaded = new Set();
    document.addEventListener('section:shown', (event) => {
        const section = event.detail.sectionId;

        // Payments and payroll are refreshed each visit because status changes.
        if (section === 'payments') { populatePaymentSelector(); return; }
        if (section === 'payroll') { loadPayrollRuns(); return; }

        if (loaded.has(section)) return;
        loaded.add(section);

        if (section === 'teachers') loadTeachers();
        else if (section === 'reports') loadReports();
    });
}

/* -------------------------------------------------------------------------- */

async function loadStats() {
    try {
        const stats = await apiRequest('/accountant/stats');

        document.getElementById('statTeachers').textContent = stats.totalTeachers;
        setText('heroPending', stats.pendingPayrolls);
        document.getElementById('statHalted').textContent = stats.haltedTeachers
            ? `${stats.haltedTeachers} paused`
            : 'None paused';
        document.getElementById('statAwaiting').textContent = stats.awaitingApproval;
        document.getElementById('statReadyToPay').textContent = stats.approvedAwaitingPayment;
        document.getElementById('statTotalPaid').textContent = formatCurrency(stats.totalPaid);
        document.getElementById('statPendingAdvance').textContent = formatCurrency(stats.pendingAdvanceTotal);
    } catch (err) {
        showError(err, 'Could not load the dashboard figures.');
    }
}

function decorate(run) {
    return {
        ...run,
        periodLabel: run.periodLabel || periodLabel(run.month, run.year),
        periodSort: run.year * 100 + run.month
    };
}

async function loadPayrollRuns() {
    payrollTable.showLoading();
    try {
        allPayrollRuns = (await apiRequest('/accountant/payroll')).map(decorate);
        payrollTable.setData(allPayrollRuns);
    } catch (err) {
        showError(err, 'Could not load payroll runs.');
        payrollTable.setData([]);
    }
}

async function processPayroll(event) {
    event.preventDefault();

    const month = Number(document.getElementById('processMonth').value);
    const year = Number(document.getElementById('processYear').value);
    const notice = document.getElementById('processNotice');
    notice.innerHTML = '';

    // Warn plainly when this would supersede an existing run.
    const existing = allPayrollRuns.find(run => run.month === month && run.year === year);
    if (existing && ['approved', 'paid'].includes(existing.status)) {
        notice.innerHTML = html`<div class="alert alert-danger" role="alert">
      <span class="alert-icon" aria-hidden="true">⚠</span>
      <span>${periodLabel(month, year)} has already been ${existing.status} and cannot be reprocessed.</span>
    </div>`;
        return;
    }

    if (existing) {
        const ok = await confirmAction({
            title: `Reprocess ${periodLabel(month, year)}?`,
            message: `A ${existing.status} run already exists for this period. It will be archived as version `
                + `${existing.version}, its advance repayments reversed, and a new version created for HR to approve. `
                + 'Nothing is deleted.',
            confirmLabel: 'Reprocess'
        });
        if (!ok) return;
    }

    await withBusy(document.getElementById('processBtn'), 'Processing…', async () => {
        try {
            const result = await apiRequest('/accountant/payroll/process', {
                method: 'POST',
                body: { month, year }
            });

            const notes = (result.notes || []).map(note => html`<li>${note}</li>`).join('');
            notice.innerHTML = html`<div class="alert alert-success" role="status">
        <span class="alert-icon" aria-hidden="true">✓</span>
        <span>
          <strong>${result.message}</strong><br>
          ${result.employeeCount} employee(s) · Gross ${formatCurrency(result.totalGross)} ·
          Net ${formatCurrency(result.totalNet)} · Employer cost ${formatCurrency(result.totalEmployerCost)}
          ${notes ? raw(`<ul class="note-list">${notes}</ul>`) : raw('')}
        </span>
      </div>`;

            showToast(result.message, 'success');
            loadStats();
            loadPayrollRuns();
        } catch (err) {
            notice.innerHTML = html`<div class="alert alert-danger" role="alert">
        <span class="alert-icon" aria-hidden="true">⚠</span>
        <span>${err.message}</span>
      </div>`;
        }
    });
}

async function openPayrollDetail(payrollId) {
    const body = document.getElementById('payrollDetailBody');
    body.innerHTML = loadingRow(7);
    openModal('payrollDetailModal');

    try {
        const { payroll: run, items } = await apiRequest(`/accountant/payroll/${payrollId}/items`);

        document.getElementById('payrollDetailTitle').textContent =
            `${run.periodLabel || periodLabel(run.month, run.year)} — ${run.status}`;

        body.innerHTML = items.length
            ? items.map(item => html`
        <tr>
          <td>
            <span class="cell-primary">${item.teacherName}</span>
            <span class="cell-sub">${item.employeeId}</span>
          </td>
          <td class="numeric">${formatCurrency(item.grossSalary)}</td>
          <td class="numeric">${formatCurrency(item.taxAmount)}</td>
          <td class="numeric">${formatCurrency(item.nssfAmount)}</td>
          <td class="numeric">${formatCurrency(item.advanceDeduction)}</td>
          <td class="numeric cell-primary">${formatCurrency(item.netSalary)}</td>
          <td>
            <button type="button" class="btn btn-sm btn-secondary" data-payslip="${item.id}">PDF</button>
          </td>
        </tr>`).join('')
            : emptyRow(7, 'This run has no lines');

        body.onclick = (event) => {
            const id = event.target.closest('[data-payslip]')?.dataset.payslip;
            if (id) downloadPayslip(id, event.target.closest('[data-payslip]'));
        };
    } catch (err) {
        body.innerHTML = emptyRow(7, 'Could not load this run', err.message);
    }
}

async function exportRun(payrollId, format, button) {
    await withBusy(button, '…', async () => {
        try {
            await apiRequest(`/accountant/reports/export/${format}/${payrollId}`);
            showToast('Your download has started.', 'success');
        } catch (err) {
            showError(err, 'The export failed.');
        }
    });
}

async function downloadPayslip(itemId, button) {
    await withBusy(button, '…', async () => {
        try {
            await apiRequest(`/accountant/payslip/${itemId}/pdf`);
        } catch (err) {
            showError(err, 'Could not generate the payslip.');
        }
    });
}

/* -------------------------------------------------------------------------- */

function populatePaymentSelector() {
    const payable = allPayrollRuns.filter(run => ['approved', 'paid'].includes(run.status));
    const select = document.getElementById('paymentPayrollSelect');

    fillSelect(select, payable.map(run => ({
        value: run.id,
        label: `${run.periodLabel} — ${run.status}`
    })), { placeholder: payable.length ? 'Choose a payroll run' : 'No approved runs yet' });

    const notice = document.getElementById('paymentNotice');
    if (!payable.length) {
        notice.innerHTML = html`<div class="alert alert-info">
      <span class="alert-icon" aria-hidden="true">ℹ</span>
      <span>No payroll run has been approved yet. HR must approve a processed run before payments can be recorded
      against it.</span>
    </div>`;
        paymentTable.setData([]);
        document.getElementById('markAllPaidBtn').hidden = true;
    } else {
        notice.innerHTML = '';
    }
}

async function loadPaymentItems(payrollId) {
    if (!payrollId) {
        paymentTable.setData([]);
        document.getElementById('markAllPaidBtn').hidden = true;
        return;
    }

    paymentTable.showLoading();
    try {
        const { payroll: run, items } = await apiRequest(`/accountant/payroll/${payrollId}/items`);
        selectedPayrollRun = run;
        paymentTable.setData(items);

        const pending = items.filter(item => item.paymentStatus === 'Pending').length;
        const markAll = document.getElementById('markAllPaidBtn');
        markAll.hidden = pending === 0;
        markAll.textContent = `Mark all ${pending} paid`;
    } catch (err) {
        showError(err, 'Could not load this run.');
        paymentTable.setData([]);
    }
}

function openPaymentModal(itemId) {
    pendingPaymentItem = paymentTable.find(itemId);
    if (!pendingPaymentItem) return;

    document.getElementById('paymentForm').reset();
    document.getElementById('paymentSummary').textContent =
        `Record payment of ${formatCurrency(pendingPaymentItem.netSalary)} to `
        + `${pendingPaymentItem.teacherName} (${pendingPaymentItem.employeeId}).`;

    openModal('paymentModal');
}

async function submitPayment(event) {
    event.preventDefault();
    if (!pendingPaymentItem) return;

    const submit = event.target.querySelector('button[type="submit"]');
    const reference = document.getElementById('paymentReference').value.trim();

    await withBusy(submit, 'Saving…', async () => {
        try {
            const result = await apiRequest(`/accountant/payroll-items/${pendingPaymentItem.id}/payment-status`, {
                method: 'PUT',
                body: { paymentStatus: 'Paid', reference }
            });

            closeModal('paymentModal');
            showToast(result.message, 'success');
            loadPaymentItems(document.getElementById('paymentPayrollSelect').value);
            loadStats();
            loadPayrollRuns();
        } catch (err) {
            showError(err);
        }
    });
}

async function revertPayment(itemId) {
    const item = paymentTable.find(itemId);
    const ok = await confirmAction({
        title: 'Revert this payment?',
        message: `${item?.teacherName || 'This payslip'} will go back to pending. If the run was marked fully paid, `
            + 'it will return to approved.',
        confirmLabel: 'Revert to pending',
        danger: true
    });
    if (!ok) return;

    try {
        const result = await apiRequest(`/accountant/payroll-items/${itemId}/payment-status`, {
            method: 'PUT',
            body: { paymentStatus: 'Pending' }
        });
        showToast(result.message, 'success');
        loadPaymentItems(document.getElementById('paymentPayrollSelect').value);
        loadStats();
        loadPayrollRuns();
    } catch (err) {
        showError(err);
    }
}

async function markAllPaid() {
    const payrollId = document.getElementById('paymentPayrollSelect').value;
    if (!payrollId) return;

    const pending = paymentTable.getData().filter(item => item.paymentStatus === 'Pending');

    const ok = await confirmAction({
        title: `Mark ${pending.length} payment(s) as paid?`,
        message: `This records every outstanding payment on ${selectedPayrollRun?.periodLabel || 'this run'} as paid `
            + `(${formatCurrency(pending.reduce((sum, i) => sum + Number(i.netSalary || 0), 0))} in total) and notifies each teacher.`,
        confirmLabel: 'Mark all paid'
    });
    if (!ok) return;

    try {
        const result = await apiRequest(`/accountant/payroll/${payrollId}/mark-all-paid`, {
            method: 'POST',
            body: {}
        });
        showToast(result.message, 'success');
        loadPaymentItems(payrollId);
        loadStats();
        loadPayrollRuns();
    } catch (err) {
        showError(err);
    }
}

/* -------------------------------------------------------------------------- */

async function loadTeachers() {
    teacherTable.showLoading();
    try {
        teacherTable.setData(await apiRequest('/accountant/teachers'));
    } catch (err) {
        showError(err, 'Could not load teacher records.');
        teacherTable.setData([]);
    }
}

function openHaltModal(teacherId) {
    pendingHaltTeacherId = teacherId;
    const teacher = teacherTable.find(teacherId);

    document.getElementById('haltForm').reset();
    document.getElementById('haltTeacherName').textContent = teacher
        ? `${teacher.fullName} (${teacher.employeeId}) will be withheld from upcoming payroll runs.`
        : '';

    openModal('haltModal');
}

async function submitHalt(event) {
    event.preventDefault();
    const reason = document.getElementById('haltReason').value.trim();
    const submit = event.target.querySelector('button[type="submit"]');

    await withBusy(submit, 'Saving…', async () => {
        const done = await setPayrollHalt(pendingHaltTeacherId, true, reason);
        if (done) closeModal('haltModal');
    });
}

async function setPayrollHalt(teacherId, halted, reason = '') {
    try {
        const result = await apiRequest(`/accountant/teachers/${teacherId}/payroll-halt`, {
            method: 'PUT',
            body: { halted, reason }
        });
        showToast(result.message, 'success');
        loadTeachers();
        loadStats();
        return true;
    } catch (err) {
        showError(err);
        return false;
    }
}

/* -------------------------------------------------------------------------- */

async function loadReports() {
    reportTable.showLoading();

    const month = document.getElementById('reportMonth').value;
    const year = document.getElementById('reportYear').value;

    const params = new URLSearchParams();
    if (month && year) { params.set('month', month); params.set('year', year); }
    else if (year) params.set('year', year);

    try {
        const runs = await apiRequest(`/accountant/reports/monthly?${params}`);
        reportTable.setData(runs.map(decorate));
        document.getElementById('statutoryCard').hidden = true;
    } catch (err) {
        showError(err, 'Could not load reports.');
        reportTable.setData([]);
    }
}

async function loadStatutory(payrollId) {
    const card = document.getElementById('statutoryCard');
    const grid = document.getElementById('statutoryGrid');

    card.hidden = false;
    grid.innerHTML = '';

    try {
        const data = await apiRequest(`/accountant/reports/statutory/${payrollId}`);

        document.getElementById('statutoryPeriod').textContent =
            `${data.period} · ${data.employeeCount} employee(s) · status ${data.status}`;

        const tiles = [
            ['PAYE withheld', data.paye, 'For the URA return'],
            ['NSSF employee (5%)', data.nssfEmployee, 'Deducted from pay'],
            ['NSSF employer (10%)', data.nssfEmployer, 'School contribution'],
            ['NSSF total remittance', data.nssfTotal, 'Employee plus employer'],
            ['Gross payroll', data.grossTotal, 'Before deductions'],
            ['Total employer cost', data.employerCostTotal, 'Gross plus employer NSSF']
        ];

        grid.innerHTML = tiles.map(([label, value, hint]) => html`
      <div class="stat-card accent-info">
        <p class="stat-label">${label}</p>
        <p class="stat-value">${formatCurrency(value)}</p>
        <p class="stat-hint">${hint}</p>
      </div>`).join('');

        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
        showError(err, 'Could not load the statutory summary.');
        card.hidden = true;
    }
}
