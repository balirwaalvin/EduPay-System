/* EduPay — HR dashboard */
'use strict';

let teacherTable;
let scaleTable;
let approvalTable;
let leaveTable;
let advanceTable;

let salaryScales = [];
let editingTeacherId = null;
let editingScale = null;
let pendingDecision = null;
let hrConfig = { maxAdvanceInstalments: 6, currency: 'UGX' };

document.addEventListener('DOMContentLoaded', () => {
    if (!initDashboard({ role: 'hr' })) return;

    buildTables();
    wireForms();

    loadStats();
    loadSalaryScales();
});

/* -------------------------------------------------------------------------- */

function buildTables() {
    teacherTable = createTable({
        tbody: 'teacherTableBody',
        columns: 7,
        pageSize: 25,
        searchInput: 'teacherSearch',
        countTarget: 'teacherCount',
        pagerTarget: 'teacherPager',
        searchFields: ['fullName', 'employeeId', 'salaryScale', 'position', 'username'],
        emptyMessage: 'No teachers yet',
        emptyHint: 'Use “Add teacher” to create the first record.',
        renderRow: teacher => html`
      <tr>
        <td>
          <span class="cell-primary">${teacher.fullName}</span>
          <span class="cell-sub">${teacher.employeeId} · ${teacher.username || 'no account'}</span>
        </td>
        <td>${teacher.position || '—'}</td>
        <td>${teacher.salaryScale}</td>
        <td>
          ${teacher.email || '—'}
          <span class="cell-sub">${teacher.phone || ''}</span>
        </td>
        <td>
          ${teacher.paymentMethod === 'mobile_money' ? 'Mobile money' : 'Bank transfer'}
          <span class="cell-sub">${teacher.paymentMethod === 'mobile_money'
                ? (teacher.mobileMoneyNumber || 'Not set')
                : (teacher.bankAccountNumber || 'Not set')}</span>
        </td>
        <td>
          ${raw(teacher.isActive === false ? badge('Cancelled', 'Deactivated') : badge('Approved', 'Active'))}
          ${teacher.activationPending
                ? raw(html`<span class="cell-sub text-warning">Password not set</span>`)
                : raw('')}
        </td>
        <td>
          <div class="action-btns">
            <button type="button" class="btn btn-sm btn-secondary" data-edit="${teacher.id}">Edit</button>
            ${teacher.activationPending
                ? raw(html`<button type="button" class="btn btn-sm btn-secondary" data-resend="${teacher.id}">Resend link</button>`)
                : raw('')}
            ${teacher.isActive === false
                ? raw(html`<button type="button" class="btn btn-sm btn-success" data-reactivate="${teacher.id}">Reactivate</button>`)
                : raw(html`<button type="button" class="btn btn-sm btn-warning" data-deactivate="${teacher.id}">Deactivate</button>`)}
          </div>
        </td>
      </tr>`
    });

    scaleTable = createTable({
        tbody: 'scaleTableBody',
        columns: 8,
        pageSize: 50,
        emptyMessage: 'No salary scales defined',
        emptyHint: 'Payroll cannot run until at least one scale exists.',
        renderRow: scale => {
            const gross = Number(scale.basicSalary || 0) + Number(scale.housingAllowance || 0)
                + Number(scale.transportAllowance || 0) + Number(scale.medicalAllowance || 0)
                + Number(scale.otherAllowance || 0);

            return html`
      <tr>
        <td class="cell-primary">${scale.id}</td>
        <td class="numeric">${formatCurrency(scale.basicSalary)}</td>
        <td class="numeric">${formatCurrency(scale.housingAllowance)}</td>
        <td class="numeric">${formatCurrency(scale.transportAllowance)}</td>
        <td class="numeric">${formatCurrency(scale.medicalAllowance)}</td>
        <td class="numeric">${formatCurrency(scale.otherAllowance)}</td>
        <td class="numeric cell-primary">${formatCurrency(gross)}</td>
        <td>
          <div class="action-btns">
            <button type="button" class="btn btn-sm btn-secondary" data-edit-scale="${scale.id}">Edit</button>
            <button type="button" class="btn btn-sm btn-danger" data-delete-scale="${scale.id}">Delete</button>
          </div>
        </td>
      </tr>`;
        }
    });

    approvalTable = createTable({
        tbody: 'approvalTableBody',
        columns: 7,
        pageSize: 20,
        pagerTarget: 'approvalPager',
        emptyMessage: 'No payroll runs yet',
        emptyHint: 'The accountant processes a run before you approve it.',
        renderRow: run => html`
      <tr>
        <td>
          <span class="cell-primary">${run.periodLabel}</span>
          ${run.version > 1 ? raw(html`<span class="cell-sub">Version ${run.version}</span>`) : raw('')}
          ${run.processedByName ? raw(html`<span class="cell-sub">Processed by ${run.processedByName}</span>`) : raw('')}
        </td>
        <td class="numeric">${run.employeeCount ?? 0}</td>
        <td class="numeric">${formatCurrency(run.totalGross)}</td>
        <td class="numeric cell-primary">${formatCurrency(run.totalNet)}</td>
        <td class="numeric">${formatCurrency(run.totalEmployerCost)}</td>
        <td>
          ${raw(badge(run.status))}
          ${run.rejectionReason ? raw(html`<span class="cell-sub">${run.rejectionReason}</span>`) : raw('')}
        </td>
        <td>
          ${run.status === 'processed'
                ? raw(html`<div class="action-btns">
            <button type="button" class="btn btn-sm btn-success" data-approve="${run.id}">Approve</button>
            <button type="button" class="btn btn-sm btn-danger" data-reject="${run.id}">Return</button>
          </div>`)
                : raw('—')}
        </td>
      </tr>`
    });

    leaveTable = createTable({
        tbody: 'leaveTableBody',
        columns: 7,
        pageSize: 25,
        searchInput: 'leaveSearch',
        countTarget: 'leaveCount',
        pagerTarget: 'leavePager',
        searchFields: ['fullName', 'employeeId', 'leaveType'],
        emptyMessage: 'No leave requests',
        renderRow: request => html`
      <tr>
        <td>
          <span class="cell-primary">${request.fullName}</span>
          <span class="cell-sub">${request.employeeId}</span>
        </td>
        <td>
          ${request.leaveType}
          ${request.isUnpaid ? raw('<span class="cell-sub text-warning">Unpaid</span>') : raw('')}
        </td>
        <td>${formatDate(request.startDate)} – ${formatDate(request.endDate)}</td>
        <td class="numeric">${request.days}</td>
        <td class="wrap">${request.reason}</td>
        <td>
          ${raw(badge(request.status))}
          ${request.decidedByName ? raw(html`<span class="cell-sub">by ${request.decidedByName}</span>`) : raw('')}
        </td>
        <td>
          ${request.status === 'Pending'
                ? raw(html`<div class="action-btns">
            <button type="button" class="btn btn-sm btn-success" data-leave-approve="${request.id}">Approve</button>
            <button type="button" class="btn btn-sm btn-danger" data-leave-reject="${request.id}">Reject</button>
          </div>`)
                : raw('—')}
        </td>
      </tr>`
    });

    advanceTable = createTable({
        tbody: 'advanceTableBody',
        columns: 7,
        pageSize: 25,
        searchInput: 'advanceSearch',
        countTarget: 'advanceCount',
        pagerTarget: 'advancePager',
        searchFields: ['fullName', 'employeeId'],
        emptyMessage: 'No advance requests',
        renderRow: advance => html`
      <tr>
        <td>
          <span class="cell-primary">${advance.fullName}</span>
          <span class="cell-sub">${advance.employeeId}</span>
        </td>
        <td class="numeric">${formatCurrency(advance.amount)}</td>
        <td class="numeric">${formatCurrency(advance.outstanding)}</td>
        <td>
          ${advance.instalmentsPaid || 0} of ${advance.instalments || 1}
          ${advance.instalmentAmount > 0
                ? raw(html`<span class="cell-sub">Next: ${formatCurrency(advance.instalmentAmount)}</span>`)
                : raw('')}
        </td>
        <td class="wrap">${advance.reason}</td>
        <td>
          ${raw(badge(advance.status))}
          ${advance.approvedByName ? raw(html`<span class="cell-sub">by ${advance.approvedByName}</span>`) : raw('')}
        </td>
        <td>
          ${advance.status === 'Pending'
                ? raw(html`<div class="action-btns">
            <button type="button" class="btn btn-sm btn-success" data-advance-approve="${advance.id}">Approve</button>
            <button type="button" class="btn btn-sm btn-danger" data-advance-reject="${advance.id}">Reject</button>
          </div>`)
                : raw('—')}
        </td>
      </tr>`
    });

    wireTableActions();
}

function wireTableActions() {
    document.getElementById('teacherTableBody').addEventListener('click', (event) => {
        const el = event.target;
        const edit = el.closest('[data-edit]')?.dataset.edit;
        const resend = el.closest('[data-resend]')?.dataset.resend;
        const deactivate = el.closest('[data-deactivate]')?.dataset.deactivate;
        const reactivate = el.closest('[data-reactivate]')?.dataset.reactivate;

        if (edit) openTeacherModal(edit);
        else if (resend) resendSetupLink(resend, el.closest('[data-resend]'));
        else if (deactivate) deactivateTeacher(deactivate);
        else if (reactivate) reactivateTeacher(reactivate);
    });

    document.getElementById('scaleTableBody').addEventListener('click', (event) => {
        const edit = event.target.closest('[data-edit-scale]')?.dataset.editScale;
        const remove = event.target.closest('[data-delete-scale]')?.dataset.deleteScale;

        if (edit) openScaleModal(edit);
        else if (remove) deleteScale(remove);
    });

    document.getElementById('approvalTableBody').addEventListener('click', (event) => {
        const approve = event.target.closest('[data-approve]')?.dataset.approve;
        const reject = event.target.closest('[data-reject]')?.dataset.reject;

        if (approve) approvePayroll(approve);
        else if (reject) rejectPayroll(reject);
    });

    document.getElementById('leaveTableBody').addEventListener('click', (event) => {
        const approve = event.target.closest('[data-leave-approve]')?.dataset.leaveApprove;
        const reject = event.target.closest('[data-leave-reject]')?.dataset.leaveReject;

        if (approve) openDecision('leave', approve, 'Approved');
        else if (reject) openDecision('leave', reject, 'Rejected');
    });

    document.getElementById('advanceTableBody').addEventListener('click', (event) => {
        const approve = event.target.closest('[data-advance-approve]')?.dataset.advanceApprove;
        const reject = event.target.closest('[data-advance-reject]')?.dataset.advanceReject;

        if (approve) openDecision('advance', approve, 'Approved');
        else if (reject) openDecision('advance', reject, 'Rejected');
    });
}

function wireForms() {
    document.getElementById('addTeacherBtn').addEventListener('click', () => openTeacherModal(null));
    document.getElementById('addScaleBtn').addEventListener('click', () => openScaleModal(null));

    document.getElementById('teacherForm').addEventListener('submit', saveTeacher);
    document.getElementById('scaleForm').addEventListener('submit', saveScale);
    document.getElementById('decisionForm').addEventListener('submit', submitDecision);

    document.getElementById('tPaymentMethod').addEventListener('change', togglePaymentFields);
    document.getElementById('showInactiveTeachers').addEventListener('change', loadTeachers);
    document.getElementById('leaveStatusFilter').addEventListener('change', loadLeave);
    document.getElementById('advanceStatusFilter').addEventListener('change', loadAdvances);

    const loaded = new Set();
    document.addEventListener('section:shown', (event) => {
        const section = event.detail.sectionId;

        // Approval queues are refreshed every visit, since they change often.
        if (section === 'payrollApproval') { loadApprovals(); return; }
        if (section === 'leave') { loadLeave(); return; }
        if (section === 'advances') { loadAdvances(); return; }

        if (loaded.has(section)) return;
        loaded.add(section);

        if (section === 'teachers') loadTeachers();
        else if (section === 'salaries') loadSalaryScales();
    });
}

/* -------------------------------------------------------------------------- */

async function loadStats() {
    try {
        const stats = await apiRequest('/hr/stats');

        document.getElementById('statTeachers').textContent = stats.totalTeachers;
        setText('heroTeachers', stats.totalTeachers);
        document.getElementById('statHalted').textContent = stats.haltedTeachers
            ? `${stats.haltedTeachers} paused by the accountant`
            : 'None paused';
        document.getElementById('statAwaiting').textContent = stats.awaitingApproval;
        document.getElementById('statLeave').textContent = stats.pendingLeave;
        document.getElementById('statAdvances').textContent = stats.pendingAdvances;
        document.getElementById('statPendingActivation').textContent = stats.pendingActivation;

        setNavBadge('navPayrollBadge', stats.awaitingApproval);
        setNavBadge('navLeaveBadge', stats.pendingLeave);
        setNavBadge('navAdvanceBadge', stats.pendingAdvances);

        renderAttention(stats);
    } catch (err) {
        showError(err, 'Could not load the dashboard figures.');
    }
}

function setNavBadge(id, count) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = !count;
    el.textContent = count > 99 ? '99+' : String(count);
}

function renderAttention(stats) {
    const items = [];

    if (stats.awaitingApproval) {
        items.push(['payrollApproval', 'warning',
            `${stats.awaitingApproval} payroll run(s) are waiting for your approval before anyone can be paid.`]);
    }
    if (stats.pendingLeave) {
        items.push(['leave', 'info', `${stats.pendingLeave} leave request(s) need a decision.`]);
    }
    if (stats.pendingAdvances) {
        items.push(['advances', 'info', `${stats.pendingAdvances} advance request(s) need a decision.`]);
    }
    if (stats.pendingActivation) {
        items.push(['teachers', 'warning',
            `${stats.pendingActivation} teacher(s) have not set a password yet and cannot sign in.`]);
    }
    if (stats.haltedTeachers) {
        items.push(['teachers', 'warning',
            `${stats.haltedTeachers} teacher(s) are paused and will be excluded from the next payroll run.`]);
    }

    const host = document.getElementById('attentionList');

    if (!items.length) {
        host.innerHTML = html`<div class="alert alert-success">
      <span class="alert-icon">${raw(icon('check', { size: 16 }))}</span>
      <span>Nothing is waiting on you.</span>
    </div>`;
        return;
    }

    host.innerHTML = items.map(([section, level, message]) => html`
    <div class="alert alert-${raw(level)}">
      <span class="alert-icon">${raw(icon(level === 'warning' ? 'alert' : 'info', { size: 16 }))}</span>
      <span>${message}</span>
      <button type="button" class="btn-link" data-goto="${section}">Open</button>
    </div>`).join('');

    host.querySelectorAll('[data-goto]').forEach(button => {
        button.addEventListener('click', () => switchSection(button.dataset.goto));
    });
}

/* -------------------------------------------------------------------------- */

async function loadTeachers() {
    teacherTable.showLoading();
    const includeInactive = document.getElementById('showInactiveTeachers').checked;

    try {
        teacherTable.setData(await apiRequest(`/hr/teachers?includeInactive=${includeInactive}`));
    } catch (err) {
        showError(err, 'Could not load teachers.');
        teacherTable.setData([]);
    }
}

function togglePaymentFields() {
    const isMomo = document.getElementById('tPaymentMethod').value === 'mobile_money';
    document.getElementById('tBankFields').hidden = isMomo;
    document.getElementById('tMomoFields').hidden = !isMomo;
}

function openTeacherModal(teacherId) {
    editingTeacherId = teacherId;
    const form = document.getElementById('teacherForm');
    form.reset();

    fillSelect('tSalaryScale', salaryScales.map(scale => ({ value: scale.id, label: scale.id })),
        { placeholder: salaryScales.length ? null : 'No scales defined' });

    const usernameField = document.getElementById('tUsername');

    if (teacherId) {
        const teacher = teacherTable.find(teacherId);
        if (!teacher) return;

        document.getElementById('teacherModalTitle').textContent = `Edit ${teacher.fullName}`;
        document.getElementById('teacherSubmitBtn').textContent = 'Save changes';

        document.getElementById('tFullName').value = teacher.fullName || '';
        usernameField.value = teacher.username || '';
        usernameField.disabled = true;
        document.getElementById('tUsernameHint').textContent = 'A username cannot be changed after creation';

        document.getElementById('tEmail').value = teacher.email || '';
        document.getElementById('tPhone').value = teacher.phone || '';
        document.getElementById('tPosition').value = teacher.position || '';
        document.getElementById('tSalaryScale').value = teacher.salaryScale || '';
        document.getElementById('tDateJoined').value = teacher.dateJoined || '';
        document.getElementById('tLeaveDays').value = teacher.leaveEntitlementDays ?? '';

        document.getElementById('tPaymentMethod').value = teacher.paymentMethod || 'bank';
        document.getElementById('tBankName').value = teacher.bankName || '';
        document.getElementById('tBankAccountName').value = teacher.bankAccountName || '';
        document.getElementById('tBankAccountNumber').value = teacher.bankAccountNumber || '';
        document.getElementById('tMomoProvider').value = teacher.mobileMoneyProvider || '';
        document.getElementById('tMomoNumber').value = teacher.mobileMoneyNumber || '';
    } else {
        document.getElementById('teacherModalTitle').textContent = 'Add teacher';
        document.getElementById('teacherSubmitBtn').textContent = 'Add teacher';
        usernameField.disabled = false;
        document.getElementById('tUsernameHint').textContent = 'Generated from the name if left blank';
        document.getElementById('tDateJoined').value = new Date().toISOString().slice(0, 10);
    }

    togglePaymentFields();
    openModal('teacherModal');
}

async function saveTeacher(event) {
    event.preventDefault();

    if (!salaryScales.length) {
        showToast('Define at least one salary scale before adding teachers.', 'error');
        return;
    }

    const payload = readForm('teacherForm');
    if (!payload.username) delete payload.username;
    if (payload.leaveEntitlementDays === '') delete payload.leaveEntitlementDays;

    const submit = document.getElementById('teacherSubmitBtn');

    await withBusy(submit, 'Saving…', async () => {
        try {
            if (editingTeacherId) {
                await apiRequest(`/hr/teachers/${editingTeacherId}`, { method: 'PUT', body: payload });
                showToast('Teacher updated.', 'success');
            } else {
                const result = await apiRequest('/hr/teachers', { method: 'POST', body: payload });
                showToast(result.message, 'success');

                // A temporary password is shown once, for secure hand-off.
                if (result.activation?.temporaryPassword) {
                    showSecret({
                        title: 'Temporary password',
                        label: `${result.teacher.fullName} · username ${result.teacher.username}`,
                        secret: result.activation.temporaryPassword,
                        note: 'Shown only once. Share it over a secure channel — they must change it at first sign-in.'
                    });
                }
                if (result.activation?.emailError) {
                    showToast(result.activation.emailError, 'warning', { duration: 9000 });
                }
            }

            closeModal('teacherModal');
            loadTeachers();
            loadStats();
        } catch (err) {
            showError(err);
        }
    });
}

async function resendSetupLink(teacherId, button) {
    await withBusy(button, 'Sending…', async () => {
        try {
            const result = await apiRequest(`/hr/teachers/${teacherId}/resend-setup`, { method: 'POST' });
            showToast(result.message, 'success');
        } catch (err) {
            showError(err);
        }
    });
}

async function deactivateTeacher(teacherId) {
    const teacher = teacherTable.find(teacherId);

    const ok = await confirmAction({
        title: `Deactivate ${teacher?.fullName || 'this teacher'}?`,
        message: 'They will be signed out, excluded from future payroll runs, and unable to sign in. '
            + 'Their payroll history is kept intact and the record can be reactivated later.',
        confirmLabel: 'Deactivate',
        danger: true
    });
    if (!ok) return;

    try {
        const result = await apiRequest(`/hr/teachers/${teacherId}/deactivate`, { method: 'POST', body: {} });
        showToast(result.message, 'success');
        loadTeachers();
        loadStats();
    } catch (err) {
        showError(err);
    }
}

async function reactivateTeacher(teacherId) {
    try {
        const result = await apiRequest(`/hr/teachers/${teacherId}/reactivate`, { method: 'POST' });
        showToast(result.message, 'success');
        loadTeachers();
        loadStats();
    } catch (err) {
        showError(err);
    }
}

/* -------------------------------------------------------------------------- */

async function loadSalaryScales() {
    try {
        salaryScales = await apiRequest('/hr/salary-structures');
        scaleTable?.setData(salaryScales);
    } catch (err) {
        showError(err, 'Could not load salary scales.');
        salaryScales = [];
        scaleTable?.setData([]);
    }
}

function openScaleModal(scaleId) {
    editingScale = scaleId;
    const form = document.getElementById('scaleForm');
    form.reset();

    const nameField = document.getElementById('sScale');

    if (scaleId) {
        const scale = salaryScales.find(s => s.id === scaleId);
        if (!scale) return;

        document.getElementById('scaleModalTitle').textContent = `Edit ${scale.id}`;
        nameField.value = scale.id;
        nameField.disabled = true;
        document.getElementById('sScaleHint').textContent = 'A scale name cannot be changed after creation';

        document.getElementById('sBasic').value = scale.basicSalary ?? 0;
        document.getElementById('sHousing').value = scale.housingAllowance ?? 0;
        document.getElementById('sTransport').value = scale.transportAllowance ?? 0;
        document.getElementById('sMedical').value = scale.medicalAllowance ?? 0;
        document.getElementById('sOtherAllowance').value = scale.otherAllowance ?? 0;
        document.getElementById('sNssf').value = scale.nssfPercentage ?? 5;
        document.getElementById('sLoan').value = scale.loanDeduction ?? 0;
        document.getElementById('sOtherDeduction').value = scale.otherDeduction ?? 0;
        document.getElementById('sTax').value = scale.taxPercentage ?? 0;
    } else {
        document.getElementById('scaleModalTitle').textContent = 'Add salary scale';
        nameField.disabled = false;
        document.getElementById('sScaleHint').textContent = 'Letters, numbers, spaces, hyphens and underscores';
    }

    openModal('scaleModal');
}

async function saveScale(event) {
    event.preventDefault();

    const payload = readForm('scaleForm');
    if (editingScale) payload.salaryScale = editingScale;

    ['basicSalary', 'housingAllowance', 'transportAllowance', 'medicalAllowance', 'otherAllowance',
        'taxPercentage', 'nssfPercentage', 'loanDeduction', 'otherDeduction'].forEach(key => {
            payload[key] = Number(payload[key] || 0);
        });

    const submit = event.target.querySelector('button[type="submit"]');

    await withBusy(submit, 'Saving…', async () => {
        try {
            const result = await apiRequest('/hr/salary-structures', { method: 'POST', body: payload });
            closeModal('scaleModal');
            showToast(result.message, 'success');
            loadSalaryScales();
        } catch (err) {
            showError(err);
        }
    });
}

async function deleteScale(scaleId) {
    const ok = await confirmAction({
        title: `Delete ${scaleId}?`,
        message: 'This is refused if any active teacher is still on this scale. Move them to another scale first.',
        confirmLabel: 'Delete scale',
        danger: true
    });
    if (!ok) return;

    try {
        const result = await apiRequest(`/hr/salary-structures/${encodeURIComponent(scaleId)}`, { method: 'DELETE' });
        showToast(result.message, 'success');
        loadSalaryScales();
    } catch (err) {
        showError(err);
    }
}

/* -------------------------------------------------------------------------- */

async function loadApprovals() {
    approvalTable.showLoading();
    try {
        const runs = await apiRequest('/hr/reports/payroll-summary');
        approvalTable.setData(runs.map(run => ({
            ...run,
            periodLabel: run.periodLabel || periodLabel(run.month, run.year)
        })));
    } catch (err) {
        showError(err, 'Could not load payroll runs.');
        approvalTable.setData([]);
    }
}

async function approvePayroll(payrollId) {
    const run = approvalTable.find(payrollId);

    const ok = await confirmAction({
        title: `Approve ${run?.periodLabel || 'this payroll run'}?`,
        message: `This releases ${formatCurrency(run?.totalNet)} across ${run?.employeeCount ?? 0} employee(s) `
            + 'to the accountant for payment, and notifies every teacher that their payslip is ready. '
            + 'It cannot be reprocessed afterwards.',
        confirmLabel: 'Approve payroll'
    });
    if (!ok) return;

    try {
        const result = await apiRequest(`/hr/payroll/${payrollId}/approve`, { method: 'POST' });
        showToast(result.message, 'success');
        loadApprovals();
        loadStats();
    } catch (err) {
        showError(err);
    }
}

async function rejectPayroll(payrollId) {
    const run = approvalTable.find(payrollId);
    pendingDecision = { kind: 'payrollReject', id: payrollId };

    document.getElementById('decisionModalTitle').textContent = 'Return payroll for correction';
    document.getElementById('decisionSummary').textContent =
        `${run?.periodLabel || 'This run'} goes back to the accountant. Explain what needs changing.`;
    document.getElementById('instalmentGroup').hidden = true;
    document.getElementById('decisionSubmitBtn').textContent = 'Return to accountant';
    document.getElementById('decisionSubmitBtn').className = 'btn btn-danger';

    const note = document.getElementById('decisionNote');
    note.value = '';
    note.required = true;
    note.previousElementSibling.innerHTML = 'Reason <span class="form-hint">(required, shared with the accountant)</span>';

    openModal('decisionModal');
}

/* -------------------------------------------------------------------------- */

async function loadLeave() {
    leaveTable.showLoading();
    const status = document.getElementById('leaveStatusFilter').value;

    try {
        leaveTable.setData(await apiRequest(`/hr/leave${status ? `?status=${status}` : ''}`));
    } catch (err) {
        showError(err, 'Could not load leave requests.');
        leaveTable.setData([]);
    }
}

async function loadAdvances() {
    advanceTable.showLoading();
    const status = document.getElementById('advanceStatusFilter').value;

    try {
        advanceTable.setData(await apiRequest(`/hr/advances${status ? `?status=${status}` : ''}`));
    } catch (err) {
        showError(err, 'Could not load advance requests.');
        advanceTable.setData([]);
    }
}

function openDecision(kind, id, status) {
    pendingDecision = { kind, id, status };

    const isLeave = kind === 'leave';
    const record = isLeave ? leaveTable.find(id) : advanceTable.find(id);
    const approving = status === 'Approved';

    document.getElementById('decisionModalTitle').textContent =
        `${approving ? 'Approve' : 'Reject'} ${isLeave ? 'leave request' : 'advance request'}`;

    document.getElementById('decisionSummary').textContent = isLeave
        ? `${record?.fullName}: ${record?.days} day(s) of ${record?.leaveType?.toLowerCase()} leave `
          + `from ${formatDate(record?.startDate)} to ${formatDate(record?.endDate)}.`
          + (approving && record?.isUnpaid ? ' This is unpaid leave, so their basic pay will be reduced pro rata.' : '')
        : `${record?.fullName} requested ${formatCurrency(record?.amount)}.`;

    // Only an approved advance needs an instalment plan.
    const instalmentGroup = document.getElementById('instalmentGroup');
    if (!isLeave && approving) {
        const max = hrConfig.maxAdvanceInstalments || 6;
        fillSelect('decisionInstalments',
            Array.from({ length: max }, (_, i) => ({
                value: i + 1,
                label: i === 0 ? '1 payroll run' : `${i + 1} payroll runs`
            })),
            { selected: record?.requestedInstalments || 1 });
        instalmentGroup.hidden = false;
    } else {
        instalmentGroup.hidden = true;
    }

    const submit = document.getElementById('decisionSubmitBtn');
    submit.textContent = approving ? 'Approve' : 'Reject';
    submit.className = `btn ${approving ? 'btn-success' : 'btn-danger'}`;

    const note = document.getElementById('decisionNote');
    note.value = '';
    note.required = false;
    note.previousElementSibling.innerHTML = 'Note <span class="form-hint">(optional, shared with the teacher)</span>';

    openModal('decisionModal');
}

async function submitDecision(event) {
    event.preventDefault();
    if (!pendingDecision) return;

    const note = document.getElementById('decisionNote').value.trim();
    const submit = document.getElementById('decisionSubmitBtn');

    if (pendingDecision.kind === 'payrollReject' && !note) {
        showToast('Explain what needs changing before returning the run.', 'error');
        return;
    }

    await withBusy(submit, 'Saving…', async () => {
        try {
            let result;

            if (pendingDecision.kind === 'payrollReject') {
                result = await apiRequest(`/hr/payroll/${pendingDecision.id}/reject`, {
                    method: 'POST',
                    body: { reason: note }
                });
                loadApprovals();
            } else if (pendingDecision.kind === 'leave') {
                result = await apiRequest(`/hr/leave/${pendingDecision.id}/status`, {
                    method: 'PUT',
                    body: { status: pendingDecision.status, note }
                });
                loadLeave();
            } else {
                const body = { status: pendingDecision.status, note };
                if (pendingDecision.status === 'Approved') {
                    body.instalments = Number(document.getElementById('decisionInstalments').value) || 1;
                }
                result = await apiRequest(`/hr/advances/${pendingDecision.id}/status`, { method: 'PUT', body });
                loadAdvances();
            }

            closeModal('decisionModal');
            showToast(result.message, 'success');
            loadStats();
        } catch (err) {
            showError(err);
        }
    });
}
