/* ==========================================================================
   EduPay — shared front-end utilities
   ========================================================================== */
'use strict';

const API_BASE = '/api';

/* --------------------------------------------------------------------------
   Output escaping

   Every dashboard table used to interpolate server data straight into
   innerHTML, so a teacher could put markup in a leave reason and have it run
   inside an HR session — where the access token lives. `esc` escapes a value
   and the `html` tag applies it to every interpolation automatically, so the
   safe form is also the convenient one.
   -------------------------------------------------------------------------- */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"'`]/g, ch => HTML_ESCAPES[ch]);
}

/**
 * A trusted-markup wrapper.
 *
 * This is a class rather than a plain `{__raw: true}` object on purpose: server
 * data arrives as plain objects from JSON.parse, and a plain-property marker
 * could be forged by an attacker-controlled payload to bypass escaping
 * entirely. An `instanceof` check cannot be forged that way.
 */
class TrustedMarkup {
    constructor(value) {
        this.value = value == null ? '' : String(value);
    }
}

/**
 * Tagged template that escapes every interpolated value.
 * Wrap a value in `raw()` to opt out, for markup you built yourself.
 *
 *   html`<td>${teacher.fullName}</td>`
 */
function html(strings, ...values) {
    return strings.reduce((out, chunk, i) => {
        if (i === 0) return chunk;
        const value = values[i - 1];
        const rendered = value instanceof TrustedMarkup ? value.value : esc(value);
        return out + rendered + chunk;
    }, '');
}

/**
 * Mark pre-built markup as safe inside an `html` template.
 * Only ever pass markup this code built — never a value from the server.
 */
function raw(value) {
    return new TrustedMarkup(value);
}

/** Escape a value for use inside a double-quoted HTML attribute. */
function attr(value) {
    return esc(value);
}

/* --------------------------------------------------------------------------
   Session storage
   -------------------------------------------------------------------------- */

const TOKEN_KEY = 'edupay_token';
const USER_KEY = 'edupay_user';

function getToken() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function setToken(token) {
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* storage unavailable */ }
}

function getUser() {
    try {
        const raw = localStorage.getItem(USER_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

function setUser(user) {
    try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch { /* storage unavailable */ }
}

function clearAuth() {
    try {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
    } catch { /* storage unavailable */ }
}

/** Gate a dashboard page on role. Administrators may view any dashboard. */
function requireAuth(requiredRole) {
    const user = getUser();
    if (!getToken() || !user) {
        redirectToLogin();
        return false;
    }
    if (requiredRole && user.role !== requiredRole && user.role !== 'admin') {
        redirectToLogin();
        return false;
    }
    return true;
}

function redirectToLogin(message) {
    const query = message ? `?notice=${encodeURIComponent(message)}` : '';
    window.location.replace(`/${query}`);
}

function dashboardPathFor(role) {
    return { admin: '/admin', hr: '/hr', accountant: '/accountant', teacher: '/teacher-portal' }[role] || '/';
}

/* --------------------------------------------------------------------------
   API access
   -------------------------------------------------------------------------- */

/** Error carrying the server's machine-readable code. */
class ApiError extends Error {
    constructor(message, code, status) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

// Codes that mean the stored session is no longer usable.
const SESSION_DEAD_CODES = new Set([
    'NO_TOKEN', 'TOKEN_EXPIRED', 'TOKEN_INVALID', 'TOKEN_REVOKED', 'USER_GONE', 'USER_INACTIVE'
]);

async function apiRequest(endpoint, options = {}) {
    const token = getToken();
    const { body, headers, raw: wantRaw, ...rest } = options;

    const config = {
        ...rest,
        headers: {
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...headers
        }
    };

    if (body !== undefined) {
        config.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    let response;
    try {
        response = await fetch(`${API_BASE}${endpoint}`, config);
    } catch {
        throw new ApiError('Cannot reach the server. Check your connection and try again.', 'NETWORK_ERROR', 0);
    }

    // File downloads
    const contentType = response.headers.get('content-type') || '';
    const isFile = /application\/pdf|spreadsheetml|octet-stream/.test(contentType);

    if (isFile || wantRaw) {
        if (!response.ok) {
            const problem = await response.json().catch(() => ({}));
            throw new ApiError(problem.error || 'The download failed.', problem.code || 'DOWNLOAD_FAILED', response.status);
        }
        downloadBlob(await response.blob(), filenameFrom(response));
        return { success: true };
    }

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
        const code = payload?.code || 'REQUEST_FAILED';
        const message = payload?.error || 'The request could not be completed.';

        if (SESSION_DEAD_CODES.has(code)) {
            clearAuth();
            redirectToLogin(message);
            throw new ApiError(message, code, response.status);
        }

        if (code === 'PASSWORD_CHANGE_REQUIRED') {
            openForcedPasswordChange();
            throw new ApiError(message, code, response.status);
        }

        throw new ApiError(message, code, response.status);
    }

    return payload;
}

/** Read the filename from Content-Disposition, handling quotes and RFC 5987. */
function filenameFrom(response) {
    const disposition = response.headers.get('content-disposition') || '';
    const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8) return decodeURIComponent(utf8[1]);
    const quoted = disposition.match(/filename="([^"]+)"/i) || disposition.match(/filename=([^;]+)/i);
    return quoted ? quoted[1].trim() : 'download';
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* --------------------------------------------------------------------------
   Toasts
   -------------------------------------------------------------------------- */

const TOAST_ICONS = { success: 'check', error: 'close', warning: 'alert', info: 'info' };

function showToast(message, type = 'success', { duration = 4500 } = {}) {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        // Announced to assistive technology without stealing focus.
        container.setAttribute('role', 'status');
        container.setAttribute('aria-live', 'polite');
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = html`<span class="toast-icon">${raw(icon(TOAST_ICONS[type] || TOAST_ICONS.info, { size: 13 }))}</span>
    <span class="toast-message">${message}</span>`;
    container.appendChild(toast);

    const dismiss = () => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(40px)';
        setTimeout(() => toast.remove(), 300);
    };

    toast.addEventListener('click', dismiss);
    setTimeout(dismiss, duration);
}

/** Report a caught error, preferring the server's message. */
function showError(err, fallback = 'Something went wrong.') {
    showToast(err?.message || fallback, 'error', { duration: 6500 });
}

/* --------------------------------------------------------------------------
   Modals
   -------------------------------------------------------------------------- */

let lastFocusedElement = null;

function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    lastFocusedElement = document.activeElement;
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');

    // Move focus into the dialog so keyboard and screen-reader users land there.
    const focusable = modal.querySelector(
        'input:not([type=hidden]):not([disabled]), select, textarea, button, [href], [tabindex]:not([tabindex="-1"])'
    );
    if (focusable) setTimeout(() => focusable.focus(), 40);
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    if (lastFocusedElement && document.contains(lastFocusedElement)) lastFocusedElement.focus();
}

function closeTopModal() {
    const open = [...document.querySelectorAll('.modal.active')].pop();
    if (open) closeModal(open.id);
}

/* --------------------------------------------------------------------------
   Navigation
   -------------------------------------------------------------------------- */

/**
 * Show a section.
 *
 * `param` is for a section that shows one record — a profile, say. It rides in
 * the hash as `#section/param` so the page survives a reload and the link can
 * be shared, and arrives at the listener in `section:shown`.
 *
 * A section with no nav item is legitimate: a detail view is reached by opening
 * a record, not from the sidebar. Such a section carries its own
 * `data-title`, since there is no nav item to take one from.
 */
function switchSection(sectionId, param = null) {
    document.querySelectorAll('.page-section').forEach(section => {
        const active = section.id === sectionId;
        section.classList.toggle('active', active);
        section.hidden = !active;
    });

    document.querySelectorAll('.nav-item').forEach(item => {
        const active = item.dataset.section === sectionId;
        item.classList.toggle('active', active);
        // Communicate the current page to assistive technology.
        item.setAttribute('aria-current', active ? 'page' : 'false');
    });

    const title = document.querySelector(`.nav-item[data-section="${sectionId}"]`)?.dataset.title
        || document.getElementById(sectionId)?.dataset.title;
    const heading = document.getElementById('pageTitle');
    if (heading && title) heading.textContent = title;

    if (isDrawerLayout()) closeSidebar();

    // Reflect the section in the URL so Back works and links are shareable.
    const hash = param ? `#${sectionId}/${encodeURIComponent(param)}` : `#${sectionId}`;
    if (window.location.hash !== hash) {
        history.replaceState(null, '', hash);
    }

    staggerSection(document.getElementById(sectionId));

    document.dispatchEvent(new CustomEvent('section:shown', { detail: { sectionId, param } }));
}

/** Split `#section/param` into its two parts. */
function readHashRoute() {
    const raw = window.location.hash.replace(/^#/, '');
    if (!raw) return { sectionId: null, param: null };

    const slash = raw.indexOf('/');
    if (slash === -1) return { sectionId: raw, param: null };

    return {
        sectionId: raw.slice(0, slash),
        param: decodeURIComponent(raw.slice(slash + 1))
    };
}

function openSidebar() {
    document.querySelector('.sidebar')?.classList.add('open');
    document.querySelector('.sidebar-overlay')?.classList.add('open');
    document.querySelector('.menu-toggle')?.setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
    document.querySelector('.sidebar')?.classList.remove('open');
    document.querySelector('.sidebar-overlay')?.classList.remove('open');
    document.querySelector('.menu-toggle')?.setAttribute('aria-expanded', 'false');
}

function toggleSidebar() {
    const sidebar = document.querySelector('.sidebar');
    if (sidebar?.classList.contains('open')) closeSidebar();
    else openSidebar();
}

/* --------------------------------------------------------------------------
   Sidebar collapse

   Two different behaviours share one element. Below the drawer breakpoint the
   sidebar slides over the content and `.open` controls it. Above it, the
   sidebar is a permanent column and `body.nav-collapsed` narrows it to an icon
   rail. The two never apply at once, which is why the collapsed CSS is behind
   a min-width guard.
   -------------------------------------------------------------------------- */

/** The width at which the sidebar stops being a column and becomes a drawer.
 *  Must match the `max-width: 860px` breakpoint in styles.css. */
const DRAWER_BREAKPOINT = 860;

const NAV_COLLAPSED_KEY = 'edupay.navCollapsed';

function isDrawerLayout() {
    return window.innerWidth <= DRAWER_BREAKPOINT;
}

/** Honour the OS "reduce motion" setting for JS-driven motion too — the CSS
 *  media query cannot reach animations we drive from script. */
function prefersReducedMotion() {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/* localStorage is unavailable in some privacy modes and throws rather than
   returning null, so every access is guarded. A failure here must not stop the
   dashboard loading — it just means the preference does not persist. */
function readNavCollapsed() {
    try {
        return localStorage.getItem(NAV_COLLAPSED_KEY) === '1';
    } catch {
        return false;
    }
}

function writeNavCollapsed(collapsed) {
    try {
        localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
        /* Preference simply will not survive a reload. */
    }
}

function setNavCollapsed(collapsed, { persist = true } = {}) {
    document.body.classList.toggle('nav-collapsed', collapsed);

    const button = document.querySelector('.sidebar-collapse');
    if (button) {
        button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        button.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation');
    }

    if (collapsed) hideRailTip();
    if (persist) writeNavCollapsed(collapsed);
}

function initSidebarCollapse() {
    const button = document.querySelector('.sidebar-collapse');

    // Restore the stored preference, but never into the drawer layout.
    if (!isDrawerLayout() && readNavCollapsed()) setNavCollapsed(true, { persist: false });

    button?.addEventListener('click', () => {
        setNavCollapsed(!document.body.classList.contains('nav-collapsed'));
    });

    // Crossing the breakpoint: drop the rail on the way down to the drawer, and
    // restore the stored preference on the way back up.
    window.matchMedia(`(max-width: ${DRAWER_BREAKPOINT}px)`).addEventListener('change', (event) => {
        if (event.matches) setNavCollapsed(false, { persist: false });
        else if (readNavCollapsed()) setNavCollapsed(true, { persist: false });
    });

    initRailTips();
}

/* --- Rail tooltips ------------------------------------------------------- */

/* A collapsed rail is icon-only, so every item needs its name on hover. One
   shared node on <body>, positioned from script: .sidebar-nav scrolls, and a
   scroll container clips both axes, so a tooltip drawn inside the sidebar
   would be cut off at its edge. */

let railTip = null;

function hideRailTip() {
    railTip?.classList.remove('show');
}

function showRailTip(item) {
    if (!document.body.classList.contains('nav-collapsed') || isDrawerLayout()) return;

    const label = item.dataset.title || item.textContent.trim();
    if (!label) return;

    if (!railTip) {
        railTip = document.createElement('div');
        railTip.className = 'rail-tip';
        railTip.setAttribute('role', 'presentation');
        document.body.appendChild(railTip);
    }

    // The badge is a bare dot when collapsed, so the count moves into the tip —
    // otherwise "3 approvals waiting" becomes an unreadable blob.
    const badge = item.querySelector('.nav-badge:not([hidden])');
    railTip.textContent = label;
    if (badge?.textContent.trim()) {
        const count = document.createElement('span');
        count.className = 'rail-tip-count';
        count.textContent = badge.textContent.trim();
        railTip.appendChild(count);
    }

    // Measured after the text is in, so the vertical centring is correct.
    const rect = item.getBoundingClientRect();
    railTip.style.left = `${rect.right + 14}px`;
    railTip.style.top = `${rect.top + rect.height / 2 - railTip.offsetHeight / 2}px`;
    railTip.classList.add('show');
}

function initRailTips() {
    document.querySelectorAll('.sidebar .nav-item, .sidebar-footer .btn').forEach(item => {
        item.addEventListener('mouseenter', () => showRailTip(item));
        item.addEventListener('focus', () => showRailTip(item));
        item.addEventListener('mouseleave', hideRailTip);
        item.addEventListener('blur', hideRailTip);
        item.addEventListener('click', hideRailTip);
    });

    // A tip anchored to a nav item would otherwise hang in place while the
    // list moves underneath it.
    document.querySelector('.sidebar-nav')?.addEventListener('scroll', hideRailTip, { passive: true });
}

/* --------------------------------------------------------------------------
   Row overflow menus

   A `popover` renders in the top layer, which is what lets a row menu escape
   .table-wrap's clipping — but the top layer has no idea where its button is,
   so the browser centres it in the viewport. Position is ours to supply.

   One delegated listener covers every menu on the page, including rows that do
   not exist yet, because tables re-render on every search, sort and page turn.
   -------------------------------------------------------------------------- */

/** Place an open row menu beside its trigger, flipping when space runs out. */
function positionRowMenu(menu) {
    const trigger = document.querySelector(`[popovertarget="${menu.id}"]`);
    if (!trigger) return;

    const anchor = trigger.getBoundingClientRect();
    const menuBox = menu.getBoundingClientRect();
    const margin = 8;

    // Prefer below-left of the trigger; flip above if the menu would run off
    // the bottom, which it will for the last rows of a long table.
    const spaceBelow = window.innerHeight - anchor.bottom;
    const below = spaceBelow >= menuBox.height + margin || spaceBelow > anchor.top;

    let top = below ? anchor.bottom + 6 : anchor.top - menuBox.height - 6;
    let left = anchor.right - menuBox.width;

    // Keep it on screen on both axes.
    left = Math.max(margin, Math.min(left, window.innerWidth - menuBox.width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - menuBox.height - margin));

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
}

function initRowMenus() {
    // `toggle` fires after the popover is laid out, so the menu can be measured.
    document.addEventListener('toggle', (event) => {
        const menu = event.target;
        if (!(menu instanceof HTMLElement) || !menu.classList.contains('row-menu')) return;
        if (event.newState === 'open') positionRowMenu(menu);
    }, true);

    // A menu is pinned to a point on screen, so it has to go when that point
    // moves. Scroll is captured because the scrolling element may be the table
    // wrapper rather than the window.
    const closeAll = () => document.querySelectorAll('.row-menu:popover-open')
        .forEach(menu => { try { menu.hidePopover(); } catch { /* already closed */ } });

    window.addEventListener('resize', closeAll, { passive: true });
    document.addEventListener('scroll', closeAll, { passive: true, capture: true });

    // Choosing an item acts and dismisses; leaving it open over a row that is
    // about to re-render would strand it.
    document.addEventListener('click', (event) => {
        const item = event.target.closest?.('.row-menu button');
        if (item) item.closest('.row-menu')?.hidePopover();
    });
}

/* --------------------------------------------------------------------------
   Motion

   Entrances are CSS; what JS supplies is the ordering. Setting `--i` on each
   element lets one `animation-delay: calc(var(--i) * 45ms)` rule produce a
   stagger without a rule per position.
   -------------------------------------------------------------------------- */

/** Order the direct children of a section so they rise in reading order. */
function staggerSection(section) {
    if (!section || prefersReducedMotion()) return;

    const blocks = section.querySelectorAll(':scope > .hero, :scope > .card, :scope > .toolbar');
    blocks.forEach((el, i) => el.style.setProperty('--i', String(i)));

    // Tiles are their own sequence — they sit side by side, so they should not
    // inherit the delay of the block they are in.
    section.querySelectorAll(':scope > .stats-grid > *').forEach((el, i) => {
        el.style.setProperty('--i', String(i));
    });
}

/** Cap on staggered rows. Past this the stagger stops being life and becomes a
 *  wait — a 25-row page would otherwise take ~650ms to finish arriving. */
const STAGGER_ROW_CAP = 12;

function staggerRows(tbody) {
    if (!tbody || prefersReducedMotion()) return;

    const rows = tbody.querySelectorAll('tr');
    if (rows.length <= 1) return;   // A lone empty-state row should not animate in.

    rows.forEach((row, i) => {
        if (i < STAGGER_ROW_CAP) row.style.setProperty('--i', String(i));
    });
}

/** Give the sticky topbar an edge once content has scrolled beneath it. */
function initTopbarScroll() {
    const topbar = document.querySelector('.topbar');
    if (!topbar) return;

    let queued = false;
    const update = () => {
        topbar.classList.toggle('scrolled', window.scrollY > 6);
        queued = false;
    };

    window.addEventListener('scroll', () => {
        // Coalesce to one class write per frame; scroll fires far faster.
        if (!queued) {
            queued = true;
            requestAnimationFrame(update);
        }
    }, { passive: true });

    update();
}

/* --------------------------------------------------------------------------
   Formatting
   -------------------------------------------------------------------------- */

let activeCurrency = 'UGX';

function setCurrency(code) {
    if (code) activeCurrency = code;
}

function formatCurrency(amount, currency = activeCurrency) {
    const n = Number(amount);
    if (!Number.isFinite(n)) return `${currency} 0`;
    return `${currency} ${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function formatNumber(value, decimals = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('en-GB', {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
}

/** Short relative time, e.g. "4 min ago". */
function formatRelative(value) {
    if (!value) return '';
    const then = new Date(value).getTime();
    if (Number.isNaN(then)) return '';

    const seconds = Math.round((Date.now() - then) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)} d ago`;
    return formatDate(value);
}

const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

function getMonthName(month) {
    return MONTH_NAMES[Number(month)] || '';
}

function periodLabel(month, year) {
    return `${getMonthName(month)} ${year}`;
}

/* --------------------------------------------------------------------------
   Status badges
   -------------------------------------------------------------------------- */

const BADGE_CLASSES = {
    draft: 'badge-muted', processed: 'badge-warning', approved: 'badge-info',
    paid: 'badge-success', rejected: 'badge-danger', superseded: 'badge-muted',
    Pending: 'badge-warning', Approved: 'badge-success', Rejected: 'badge-danger',
    Cancelled: 'badge-muted', Repaying: 'badge-info', Settled: 'badge-success',
    Paid: 'badge-success', Muted: 'badge-muted'
};

function badge(status, label) {
    const cls = BADGE_CLASSES[status] || 'badge-muted';
    return html`<span class="badge ${raw(cls)}">${label ?? status ?? '—'}</span>`;
}

/* --------------------------------------------------------------------------
   Tables: empty states, search, sort, pagination

   None of the lists had search or paging, so every table rendered every row.
   -------------------------------------------------------------------------- */

function emptyRow(colspan, message, hint) {
    return html`<tr class="empty-row"><td colspan="${colspan}">
    <div class="empty-state">
      <p class="empty-title">${message}</p>
      ${hint ? raw(html`<p class="empty-hint">${hint}</p>`) : raw('')}
    </div>
  </td></tr>`;
}

function loadingRow(colspan) {
    // Skeleton rows rather than a spinner: they stand in at the shape and size
    // of the real thing, so the table does not visibly jump when data lands.
    // colspan is always a column count from our own call sites, never input,
    // but it is coerced anyway since it is interpolated into markup.
    const columns = Math.max(1, Math.min(20, Number(colspan) || 1));
    // Widths come from classes, not a style attribute: the dashboards run under
    // `style-src 'self'` with no 'unsafe-inline', which blocks inline styles.
    const cells = Array.from({ length: columns }, (_, i) =>
        `<td><span class="skeleton skeleton-line sk-w${(i % 5) + 1}"></span></td>`
    ).join('');

    return Array.from({ length: 3 }, () =>
        `<tr class="skeleton-row" aria-hidden="true">${cells}</tr>`
    ).join('')
        + `<tr class="sr-only"><td colspan="${columns}">Loading…</td></tr>`;
}

/** Case-insensitive substring match across the chosen fields. */
/**
 * Turn a stored enum into something readable: `Head_of_Department` reads as
 * "Head of Department". The stored value is never changed — only how it is
 * shown — so sorting, filtering and anything sent back to the API still use
 * the real one.
 */
function humanise(value) {
    return String(value ?? '').replace(/_/g, ' ').trim();
}

function matchesSearch(row, term, fields) {
    if (!term) return true;
    // Underscores are flattened on both sides, so a value displayed as
    // "Teaching Assistant" is found by typing it that way as well as by the
    // stored "Teaching_Assistant".
    const needle = term.trim().toLowerCase().replace(/_/g, ' ');
    if (!needle) return true;
    return fields.some(field =>
        String(row[field] ?? '').toLowerCase().replace(/_/g, ' ').includes(needle));
}

/**
 * A searchable, sortable, paginated table.
 *
 *   const table = createTable({
 *     tbody: 'teachersTableBody', columns: 8, pageSize: 25,
 *     searchFields: ['fullName', 'employeeId'],
 *     renderRow: t => html`<tr>…</tr>`,
 *     emptyMessage: 'No teachers yet'
 *   });
 *   table.setData(rows);
 */
function createTable(options) {
    const {
        tbody, columns, renderRow, searchFields = [], pageSize = 25,
        emptyMessage = 'Nothing to show', emptyHint = '',
        searchInput = null, countTarget = null, pagerTarget = null
    } = options;

    const body = typeof tbody === 'string' ? document.getElementById(tbody) : tbody;
    const search = searchInput
        ? (typeof searchInput === 'string' ? document.getElementById(searchInput) : searchInput)
        : null;
    const counter = countTarget
        ? (typeof countTarget === 'string' ? document.getElementById(countTarget) : countTarget)
        : null;
    const pager = pagerTarget
        ? (typeof pagerTarget === 'string' ? document.getElementById(pagerTarget) : pagerTarget)
        : null;

    let data = [];
    let term = '';
    let page = 1;
    let sortKey = null;
    let sortDir = 'asc';

    function visibleRows() {
        let rows = data.filter(row => matchesSearch(row, term, searchFields));

        if (sortKey) {
            rows = [...rows].sort((a, b) => {
                const av = a[sortKey];
                const bv = b[sortKey];
                const numeric = typeof av === 'number' && typeof bv === 'number';
                const cmp = numeric
                    ? av - bv
                    : String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true });
                return sortDir === 'asc' ? cmp : -cmp;
            });
        }
        return rows;
    }

    function render() {
        if (!body) return;

        const rows = visibleRows();
        const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
        page = Math.min(page, totalPages);
        const slice = rows.slice((page - 1) * pageSize, page * pageSize);

        if (!rows.length) {
            body.innerHTML = term
                ? emptyRow(columns, `No results for “${term}”`, 'Try a different search term.')
                : emptyRow(columns, emptyMessage, emptyHint);
        } else {
            body.innerHTML = slice.map(renderRow).join('');
            staggerRows(body);
        }

        if (counter) {
            counter.textContent = rows.length === data.length
                ? `${data.length} record${data.length === 1 ? '' : 's'}`
                : `${rows.length} of ${data.length}`;
        }

        if (pager) renderPager(pager, page, totalPages, rows.length, (next) => { page = next; render(); });

        body.dispatchEvent(new CustomEvent('table:rendered', { bubbles: true }));
    }

    if (search) {
        let debounce;
        search.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
                term = search.value;
                page = 1;
                render();
            }, 180);
        });
    }

    // Clicking a column header with `data-sort` sorts by that field.
    const table = body?.closest('table');
    table?.querySelectorAll('th[data-sort]').forEach(header => {
        header.setAttribute('role', 'button');
        header.setAttribute('tabindex', '0');
        header.classList.add('sortable');

        const activate = () => {
            const key = header.dataset.sort;
            sortDir = sortKey === key && sortDir === 'asc' ? 'desc' : 'asc';
            sortKey = key;

            table.querySelectorAll('th[data-sort]').forEach(h => {
                h.removeAttribute('aria-sort');
                h.classList.remove('sorted-asc', 'sorted-desc');
            });
            header.setAttribute('aria-sort', sortDir === 'asc' ? 'ascending' : 'descending');
            header.classList.add(sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');

            render();
        };

        header.addEventListener('click', activate);
        header.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activate();
            }
        });
    });

    return {
        setData(rows) { data = Array.isArray(rows) ? rows : []; page = 1; render(); },
        getData() { return data; },
        find(id) { return data.find(row => row.id === id); },
        showLoading() { if (body) body.innerHTML = loadingRow(columns); },
        refresh: render
    };
}

function renderPager(target, page, totalPages, totalRows, onGo) {
    if (totalPages <= 1) {
        target.innerHTML = '';
        return;
    }

    target.innerHTML = html`
    <button type="button" class="btn btn-sm btn-secondary" data-page="${page - 1}"
            ${raw(page === 1 ? 'disabled' : '')} aria-label="Previous page">‹ Previous</button>
    <span class="pager-status">Page ${page} of ${totalPages} · ${totalRows} record${totalRows === 1 ? '' : 's'}</span>
    <button type="button" class="btn btn-sm btn-secondary" data-page="${page + 1}"
            ${raw(page === totalPages ? 'disabled' : '')} aria-label="Next page">Next ›</button>`;

    target.querySelectorAll('button[data-page]').forEach(button => {
        button.addEventListener('click', () => {
            const next = Number(button.dataset.page);
            if (next >= 1 && next <= totalPages) onGo(next);
        });
    });
}

/* --------------------------------------------------------------------------
   Confirmation dialog

   Replaces window.confirm, which cannot be styled, cannot explain consequences
   and reads poorly to screen readers.
   -------------------------------------------------------------------------- */

function confirmAction({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, requireText = null }) {
    return new Promise(resolve => {
        const existing = document.getElementById('confirmDialog');
        if (existing) existing.remove();

        const wrapper = document.createElement('div');
        wrapper.id = 'confirmDialog';
        wrapper.className = 'modal active';
        wrapper.setAttribute('role', 'dialog');
        wrapper.setAttribute('aria-modal', 'true');
        wrapper.setAttribute('aria-labelledby', 'confirmDialogTitle');

        wrapper.innerHTML = html`
      <div class="modal-content modal-sm">
        <div class="modal-header">
          <h3 id="confirmDialogTitle">${title}</h3>
        </div>
        <div class="modal-body">
          <p>${message}</p>
          ${requireText ? raw(html`<label class="confirm-gate" for="confirmGateInput">
            Type <strong>${requireText}</strong> to continue
            <input type="text" id="confirmGateInput" autocomplete="off" spellcheck="false">
          </label>`) : raw('')}
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-act="cancel">${cancelLabel}</button>
          <button type="button" class="btn ${raw(danger ? 'btn-danger' : 'btn-primary')}" data-act="ok"
                  ${raw(requireText ? 'disabled' : '')}>${confirmLabel}</button>
        </div>
      </div>`;

        document.body.appendChild(wrapper);

        const okButton = wrapper.querySelector('[data-act="ok"]');
        const gate = wrapper.querySelector('#confirmGateInput');

        if (gate) {
            gate.addEventListener('input', () => {
                okButton.disabled = gate.value.trim() !== requireText;
            });
        }

        const finish = (result) => {
            wrapper.remove();
            document.removeEventListener('keydown', onKey);
            resolve(result);
        };

        const onKey = (event) => {
            if (event.key === 'Escape') finish(false);
        };

        wrapper.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(false));
        okButton.addEventListener('click', () => finish(true));
        wrapper.addEventListener('click', (event) => { if (event.target === wrapper) finish(false); });
        document.addEventListener('keydown', onKey);

        setTimeout(() => (gate || okButton).focus(), 40);
    });
}

/** Show a one-time secret (temporary password) with a copy button. */
function showSecret({ title, label, secret, note }) {
    const existing = document.getElementById('secretDialog');
    if (existing) existing.remove();

    const wrapper = document.createElement('div');
    wrapper.id = 'secretDialog';
    wrapper.className = 'modal active';
    wrapper.setAttribute('role', 'dialog');
    wrapper.setAttribute('aria-modal', 'true');
    wrapper.innerHTML = html`
    <div class="modal-content modal-sm">
      <div class="modal-header"><h3>${title}</h3></div>
      <div class="modal-body">
        <p class="secret-label">${label}</p>
        <div class="secret-value"><code id="secretValue">${secret}</code></div>
        <p class="empty-hint">${note || 'This is shown only once. Copy it now and share it over a secure channel.'}</p>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-act="copy">Copy</button>
        <button type="button" class="btn btn-primary" data-act="done">Done</button>
      </div>
    </div>`;

    document.body.appendChild(wrapper);

    wrapper.querySelector('[data-act="copy"]').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(secret);
            showToast('Copied to the clipboard.', 'success');
        } catch {
            showToast('Could not copy automatically — select the text and copy it manually.', 'warning');
        }
    });
    wrapper.querySelector('[data-act="done"]').addEventListener('click', () => wrapper.remove());
}

/* --------------------------------------------------------------------------
   Notifications bell

   Previously only the teacher portal could read notifications, so approvers had
   no inbox. Every dashboard now gets the same control.
   -------------------------------------------------------------------------- */

let notificationPollId = null;

const NOTIFICATION_ICONS = {
    leave: 'calendar', advance: 'banknote', payroll: 'clipboard',
    payment: 'checkCircle', account: 'user', system: 'info'
};

function initNotifications({ pollMs = 60000 } = {}) {
    const host = document.getElementById('notificationBell');
    if (!host) return;

    host.innerHTML = html`
    <button type="button" class="bell-button" id="bellButton"
            aria-label="Notifications" aria-expanded="false" aria-haspopup="true">
      ${raw(icon('bell', { size: 19 }))}
      <span class="bell-count" id="bellCount" hidden>0</span>
    </button>
    <div class="bell-panel" id="bellPanel" role="region" aria-label="Notifications" hidden>
      <header class="bell-panel-header">
        <h3>Notifications</h3>
        <button type="button" class="btn-link" id="bellMarkAll">Mark all read</button>
      </header>
      <ul class="bell-list" id="bellList"></ul>
    </div>`;

    const button = document.getElementById('bellButton');
    const panel = document.getElementById('bellPanel');

    button.addEventListener('click', () => {
        const open = !panel.hidden;
        panel.hidden = open;
        button.setAttribute('aria-expanded', String(!open));
        if (!open) loadNotifications();
    });

    document.getElementById('bellMarkAll').addEventListener('click', async () => {
        try {
            await apiRequest('/notifications/read-all', { method: 'PUT' });
            await loadNotifications();
            await refreshUnreadCount();
        } catch (err) { showError(err); }
    });

    document.addEventListener('click', (event) => {
        if (!panel.hidden && !event.target.closest('#notificationBell')) {
            panel.hidden = true;
            button.setAttribute('aria-expanded', 'false');
        }
    });

    refreshUnreadCount();
    clearInterval(notificationPollId);
    notificationPollId = setInterval(refreshUnreadCount, pollMs);
}

async function refreshUnreadCount() {
    const badgeEl = document.getElementById('bellCount');
    if (!badgeEl || !getToken()) return;

    try {
        const { unreadCount } = await apiRequest('/notifications/unread-count');
        badgeEl.hidden = !unreadCount;
        badgeEl.textContent = unreadCount > 99 ? '99+' : String(unreadCount);

        const button = document.getElementById('bellButton');
        if (button) {
            button.setAttribute('aria-label',
                unreadCount ? `Notifications, ${unreadCount} unread` : 'Notifications');
        }
    } catch { /* a transient failure should not disturb the page */ }
}

async function loadNotifications() {
    const list = document.getElementById('bellList');
    if (!list) return;

    list.innerHTML = '<li class="bell-empty">Loading…</li>';

    try {
        const { notifications } = await apiRequest('/notifications?limit=25');

        if (!notifications.length) {
            list.innerHTML = '<li class="bell-empty">You have no notifications.</li>';
            return;
        }

        list.innerHTML = notifications.map(item => html`
      <li class="bell-item ${raw(item.isRead ? '' : 'unread')}" data-id="${item.id}">
        <span class="bell-item-icon">${raw(icon(NOTIFICATION_ICONS[item.category] || 'info', { size: 15 }))}</span>
        <div class="bell-item-body">
          <p class="bell-item-title">${item.title}</p>
          <p class="bell-item-message">${item.message}</p>
          <time class="bell-item-time">${formatRelative(item.createdAt)}</time>
        </div>
        ${item.isRead ? raw('') : raw(html`<button type="button" class="btn-link bell-mark"
          data-id="${item.id}" aria-label="Mark “${item.title}” as read">Mark read</button>`)}
      </li>`).join('');

        list.querySelectorAll('.bell-mark').forEach(button => {
            button.addEventListener('click', async (event) => {
                event.stopPropagation();
                try {
                    await apiRequest(`/notifications/${button.dataset.id}/read`, { method: 'PUT' });
                    button.closest('.bell-item')?.classList.remove('unread');
                    button.remove();
                    refreshUnreadCount();
                } catch (err) { showError(err); }
            });
        });
    } catch (err) {
        list.innerHTML = html`<li class="bell-empty">${err.message || 'Could not load notifications.'}</li>`;
    }
}

/* --------------------------------------------------------------------------
   Forced password change

   `mustChangePassword` was set on every account the system created and never
   read by the front end, so the requirement never had any effect.
   -------------------------------------------------------------------------- */

function openForcedPasswordChange() {
    if (document.getElementById('forcedPasswordModal')) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'forcedPasswordModal';
    wrapper.className = 'modal active';
    wrapper.setAttribute('role', 'dialog');
    wrapper.setAttribute('aria-modal', 'true');
    wrapper.setAttribute('aria-labelledby', 'forcedPasswordTitle');

    wrapper.innerHTML = html`
    <div class="modal-content modal-sm">
      <div class="modal-header">
        <h3 id="forcedPasswordTitle">Choose a new password</h3>
      </div>
      <form id="forcedPasswordForm" novalidate>
        <div class="modal-body">
          <p>Your account is using a temporary password. Choose your own before continuing.</p>
          <div class="form-group">
            <label for="fpCurrent">Temporary password</label>
            <input type="password" id="fpCurrent" autocomplete="current-password" required>
          </div>
          <div class="form-group">
            <label for="fpNew">New password</label>
            <input type="password" id="fpNew" autocomplete="new-password" required
                   aria-describedby="fpHint">
            <p class="form-hint" id="fpHint">At least 10 characters, combining three of:
              lowercase, uppercase, numbers, symbols.</p>
          </div>
          <div class="form-group">
            <label for="fpConfirm">Confirm new password</label>
            <input type="password" id="fpConfirm" autocomplete="new-password" required>
          </div>
          <p class="form-error" id="fpError" role="alert" hidden></p>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="fpSignOut">Sign out</button>
          <button type="submit" class="btn btn-primary" id="fpSubmit">Set password</button>
        </div>
      </form>
    </div>`;

    document.body.appendChild(wrapper);

    const form = document.getElementById('forcedPasswordForm');
    const errorEl = document.getElementById('fpError');
    const submit = document.getElementById('fpSubmit');

    document.getElementById('fpSignOut').addEventListener('click', () => logout());

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        errorEl.hidden = true;

        const current = document.getElementById('fpCurrent').value;
        const next = document.getElementById('fpNew').value;
        const confirm = document.getElementById('fpConfirm').value;

        if (next !== confirm) {
            errorEl.textContent = 'The two new passwords do not match.';
            errorEl.hidden = false;
            return;
        }

        submit.disabled = true;
        submit.textContent = 'Saving…';

        try {
            const result = await apiRequest('/auth/change-password', {
                method: 'POST',
                body: { currentPassword: current, newPassword: next }
            });

            // The server rotates the token, so store the replacement.
            if (result.token) setToken(result.token);
            if (result.user) setUser(result.user);

            wrapper.remove();
            showToast('Your password has been set.', 'success');
            setTimeout(() => window.location.reload(), 600);
        } catch (err) {
            errorEl.textContent = err.message || 'Could not change your password.';
            errorEl.hidden = false;
            submit.disabled = false;
            submit.textContent = 'Set password';
        }
    });

    setTimeout(() => document.getElementById('fpCurrent').focus(), 50);
}

/* --------------------------------------------------------------------------
   User display and sign-out
   -------------------------------------------------------------------------- */

const ROLE_LABELS = {
    admin: 'Administrator',
    hr: 'HR',
    accountant: 'Accountant',
    teacher: 'Teacher'
};

function initials(name) {
    return String(name || '')
        .trim()
        .split(/\s+/)
        .map(part => part[0] || '')
        .join('')
        .toUpperCase()
        .slice(0, 2) || '?';
}

function initUserDisplay() {
    const user = getUser();
    if (!user) return;

    document.querySelectorAll('.user-full-name').forEach(el => { el.textContent = user.fullName || user.username; });
    document.querySelectorAll('.user-avatar').forEach(el => { el.textContent = initials(user.fullName || user.username); });
    // Spelled out rather than capitalised, so "hr" does not render as "Hr".
    document.querySelectorAll('.user-role-display').forEach(el => {
        el.textContent = ROLE_LABELS[user.role] || user.role || '';
    });

    if (user.mustChangePassword) openForcedPasswordChange();
}

async function logout({ silent = false } = {}) {
    stopSessionTimeout();
    clearInterval(notificationPollId);

    // Best-effort server-side revocation; the local session is cleared regardless.
    try {
        if (getToken()) await apiRequest('/auth/logout', { method: 'POST' });
    } catch { /* already invalid */ }

    clearAuth();
    if (!silent) window.location.replace('/');
}

/* --------------------------------------------------------------------------
   Idle session timeout
   -------------------------------------------------------------------------- */

const ACTIVITY_EVENTS = ['click', 'keydown', 'input', 'scroll', 'touchstart', 'focus'];

let idleTimer = null;
let warnTimer = null;
let activityHandler = null;

function clearSessionTimers() {
    clearTimeout(idleTimer);
    clearTimeout(warnTimer);
    idleTimer = null;
    warnTimer = null;
}

function resetSessionTimeout(timeoutMs, warningMs) {
    if (!getToken()) return;
    clearSessionTimers();

    if (warningMs > 0 && warningMs < timeoutMs) {
        warnTimer = setTimeout(() => {
            showToast(
                `You will be signed out in ${Math.round(warningMs / 60000) || 1} minute(s) due to inactivity.`,
                'warning',
                { duration: warningMs }
            );
        }, timeoutMs - warningMs);
    }

    idleTimer = setTimeout(() => {
        showToast('Signing you out due to inactivity…', 'warning');
        setTimeout(() => logout(), 800);
    }, timeoutMs);
}

function startSessionTimeout({ timeoutMs = 20 * 60 * 1000, warningMs = 60 * 1000 } = {}) {
    stopSessionTimeout();
    activityHandler = () => resetSessionTimeout(timeoutMs, warningMs);
    ACTIVITY_EVENTS.forEach(name => window.addEventListener(name, activityHandler, { passive: true }));
    resetSessionTimeout(timeoutMs, warningMs);
}

function stopSessionTimeout() {
    if (activityHandler) {
        ACTIVITY_EVENTS.forEach(name => window.removeEventListener(name, activityHandler));
        activityHandler = null;
    }
    clearSessionTimers();
}

/* --------------------------------------------------------------------------
   Shared dashboard bootstrap
   -------------------------------------------------------------------------- */

/**
 * Wire up the chrome every dashboard shares: navigation, sidebar, sign-out,
 * notifications, idle timeout and the change-password form.
 *
 * Uses event delegation rather than inline `onclick` attributes, which keeps the
 * content security policy strict and makes the navigation keyboard-operable.
 */
function initDashboard({ role, onSection } = {}) {
    if (!requireAuth(role)) return false;

    initUserDisplay();
    initNotifications();
    startSessionTimeout();

    // Navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => switchSection(item.dataset.section));
        item.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                switchSection(item.dataset.section);
            }
        });
    });

    // Sidebar
    document.querySelector('.menu-toggle')?.addEventListener('click', toggleSidebar);
    document.querySelector('.mobile-close-btn')?.addEventListener('click', closeSidebar);
    initSidebarCollapse();
    initTopbarScroll();
    initRowMenus();

    if (!document.querySelector('.sidebar-overlay')) {
        const overlay = document.createElement('div');
        overlay.className = 'sidebar-overlay';
        overlay.addEventListener('click', closeSidebar);
        document.body.appendChild(overlay);
    }

    // Sign-out
    document.querySelectorAll('[data-action="logout"]').forEach(button => {
        button.addEventListener('click', () => logout());
    });

    // Modal dismissal: close buttons, backdrop clicks and Escape.
    document.querySelectorAll('[data-close-modal]').forEach(button => {
        button.addEventListener('click', () => closeModal(button.dataset.closeModal));
    });
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(modal.id); });
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeTopModal();
            hideRailTip();
        }
    });

    if (onSection) document.addEventListener('section:shown', (event) => onSection(event.detail.sectionId));

    /* Restore the section named in the URL, including the record it was
       showing — but not yet.

       Every dashboard bootstraps as `initDashboard(); buildTables();
       wireForms();`, and it is wireForms that subscribes to `section:shown` to
       load a section's data. Restoring here and now would fire that event
       before anyone was listening, so a reload on #staff showed the right
       section with an empty table. A microtask runs once the caller's
       synchronous bootstrap has finished, by which time the listener exists. */
    queueMicrotask(() => {
        const route = readHashRoute();
        if (route.sectionId && document.getElementById(route.sectionId)) {
            switchSection(route.sectionId, route.param);
        } else {
            const first = document.querySelector('.nav-item')?.dataset.section;
            if (first) switchSection(first);
        }
    });

    initChangePasswordForm();
    return true;
}

/** Wire the Security section's change-password form, where a dashboard has one. */
function initChangePasswordForm() {
    const form = document.getElementById('changePasswordForm');
    if (!form) return;

    form.addEventListener('submit', async (event) => {
        event.preventDefault();

        const current = form.querySelector('#currentPassword').value;
        const next = form.querySelector('#newPassword').value;
        const confirm = form.querySelector('#confirmPassword').value;
        const submit = form.querySelector('button[type="submit"]');

        if (next !== confirm) {
            showToast('The two new passwords do not match.', 'error');
            return;
        }

        submit.disabled = true;
        const originalLabel = submit.textContent;
        submit.textContent = 'Saving…';

        try {
            const result = await apiRequest('/auth/change-password', {
                method: 'POST',
                body: { currentPassword: current, newPassword: next }
            });

            if (result.token) setToken(result.token);
            if (result.user) setUser(result.user);

            form.reset();
            showToast('Your password has been changed.', 'success');
        } catch (err) {
            showError(err);
        } finally {
            submit.disabled = false;
            submit.textContent = originalLabel;
        }
    });
}

/**
 * Wire every password reveal control on the page.
 *
 * Progressive enhancement: the field works without it, and the button is only
 * meaningful once scripting is available, so its state is kept in sync with
 * `aria-pressed` for screen-reader users.
 */
function initPasswordReveals() {
    document.querySelectorAll('.reveal-btn[data-reveal]').forEach(button => {
        const input = document.getElementById(button.dataset.reveal);
        if (!input) return;

        button.innerHTML = icon('eye', { size: 17 });

        button.addEventListener('click', () => {
            const revealed = input.type === 'text';
            input.type = revealed ? 'password' : 'text';
            button.setAttribute('aria-pressed', String(!revealed));
            button.setAttribute('aria-label', revealed ? 'Show password' : 'Hide password');
            button.innerHTML = icon(revealed ? 'eye' : 'eyeOff', { size: 17 });
            input.focus();
        });
    });
}

document.addEventListener('DOMContentLoaded', initPasswordReveals);

/** Read a form into a plain object, trimming text values. */
function readForm(formId) {
    const form = typeof formId === 'string' ? document.getElementById(formId) : formId;
    if (!form) return {};

    const out = {};
    new FormData(form).forEach((value, key) => {
        out[key] = typeof value === 'string' ? value.trim() : value;
    });

    // Checkboxes are absent from FormData when unchecked.
    form.querySelectorAll('input[type="checkbox"][name]').forEach(box => {
        out[box.name] = box.checked;
    });

    return out;
}

/** Set an element's text if it exists. */
function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

/** Populate a <select> with options. */
function fillSelect(selectId, options, { selected = null, placeholder = null } = {}) {
    const select = typeof selectId === 'string' ? document.getElementById(selectId) : selectId;
    if (!select) return;

    const parts = placeholder ? [html`<option value="">${placeholder}</option>`] : [];
    options.forEach(option => {
        const value = option.value ?? option;
        const label = option.label ?? option;
        parts.push(html`<option value="${value}" ${raw(String(value) === String(selected) ? 'selected' : '')}>${label}</option>`);
    });

    select.innerHTML = parts.join('');
}

/** Run an async action with a button in a busy state. */
async function withBusy(button, label, action) {
    if (!button) return action();

    const original = button.textContent;
    button.disabled = true;
    button.textContent = label;
    try {
        return await action();
    } finally {
        button.disabled = false;
        button.textContent = original;
    }
}
