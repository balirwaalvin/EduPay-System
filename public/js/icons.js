/* ==========================================================================
   EduPay icon set

   Line icons drawn on a 24×24 grid at a 1.8 stroke, with round caps and joins,
   so they sit at one optical weight beside the type. They inherit `currentColor`,
   which emoji cannot do — an emoji is a coloured image and ignores the brand.

   Markup only ever comes from this registry; a name is never interpolated into
   the output, so nothing user-supplied can reach innerHTML through here.
   ========================================================================== */
'use strict';

const ICON_PATHS = {
    // Navigation
    dashboard: '<rect x="3" y="3" width="7.5" height="9" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="5.5" rx="1.6"/><rect x="13.5" y="12" width="7.5" height="9" rx="1.6"/><rect x="3" y="15.5" width="7.5" height="5.5" rx="1.6"/>',
    users: '<path d="M16 20v-1.8a3.6 3.6 0 0 0-3.6-3.6H6.6A3.6 3.6 0 0 0 3 18.2V20"/><circle cx="9.5" cy="7.4" r="3.4"/><path d="M21 20v-1.8a3.6 3.6 0 0 0-2.7-3.5"/><path d="M15.4 4.2a3.6 3.6 0 0 1 0 6.6"/>',
    user: '<path d="M19 20v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="3.6"/>',
    teacher: '<path d="M3 8.6 12 4l9 4.6-9 4.6z"/><path d="M7 10.8v4.4c0 1.6 2.2 2.9 5 2.9s5-1.3 5-2.9v-4.4"/><path d="M21 8.6v5.2"/>',
    shield: '<path d="M12 3.2 5 6v5.6c0 4.2 2.9 7.4 7 9.2 4.1-1.8 7-5 7-9.2V6z"/><path d="m9.3 12 1.9 1.9 3.6-3.7"/>',
    building: '<rect x="4" y="3.5" width="12" height="17" rx="1.6"/><path d="M16 9.5h3.2a.8.8 0 0 1 .8.8v9.4a.8.8 0 0 1-.8.8H16"/><path d="M7.5 7.5h2M7.5 11h2M7.5 14.5h2M12.5 7.5h1M12.5 11h1M12.5 14.5h1"/>',
    receipt: '<path d="M6 3h12a1 1 0 0 1 1 1v17l-2.6-1.6-2.6 1.6-2.6-1.6-2.6 1.6L5 21V4a1 1 0 0 1 1-1z"/><path d="M8.6 8h6.8M8.6 12h6.8M8.6 16h3.6"/>',
    wallet: '<path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h12.5a1.5 1.5 0 0 1 1.5 1.5v2"/><path d="M3.5 7.5v9A2.5 2.5 0 0 0 6 19h13a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 19 9H6a2.5 2.5 0 0 1-2.5-1.5z"/><circle cx="16.5" cy="14" r="1.1" fill="currentColor" stroke="none"/>',
    banknote: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 10v4M18 10v4"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.8h17M8.2 3v4M15.8 3v4"/>',
    checkCircle: '<circle cx="12" cy="12" r="8.8"/><path d="m8.4 12.2 2.5 2.5 4.7-5"/>',
    clock: '<circle cx="12" cy="12" r="8.8"/><path d="M12 7.2V12l3.1 1.9"/>',
    mail: '<rect x="2.8" y="5" width="18.4" height="14" rx="2.2"/><path d="m3.4 7 7.5 5.4a2 2 0 0 0 2.2 0L20.6 7"/>',
    bank: '<path d="M3.4 9.6 12 4.2l8.6 5.4"/><path d="M5.6 10.6v7.6M10 10.6v7.6M14 10.6v7.6M18.4 10.6v7.6"/><path d="M3.2 20.4h17.6"/>',
    trendingUp: '<path d="m3.5 16.5 5.4-5.4 3.4 3.4 7-7"/><path d="M14.4 7.5h5v5"/>',
    lock: '<rect x="4.6" y="10.4" width="14.8" height="10" rx="2.2"/><path d="M8.2 10.4V7.6a3.8 3.8 0 0 1 7.6 0v2.8"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.2 14.4a1.5 1.5 0 0 0 .3 1.7l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.5 1.5 0 0 0-2.5 1v.2a1.9 1.9 0 1 1-3.7 0v-.1a1.5 1.5 0 0 0-2.6-1l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.5 1.5 0 0 0-1-2.5h-.2a1.9 1.9 0 1 1 0-3.7h.1a1.5 1.5 0 0 0 1-2.6l-.1-.1A1.9 1.9 0 1 1 7.8 4.6l.1.1a1.5 1.5 0 0 0 1.7.3h.1a1.5 1.5 0 0 0 .9-1.4v-.2a1.9 1.9 0 1 1 3.7 0v.1a1.5 1.5 0 0 0 2.5 1l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.5 1.5 0 0 0-.3 1.7v.1a1.5 1.5 0 0 0 1.4.9h.2a1.9 1.9 0 1 1 0 3.7h-.1a1.5 1.5 0 0 0-1.4.9z"/>',
    fileText: '<path d="M14 3.2H7.4A2.2 2.2 0 0 0 5.2 5.4v13.2a2.2 2.2 0 0 0 2.2 2.2h9.2a2.2 2.2 0 0 0 2.2-2.2V8.2z"/><path d="M14 3.2v5h4.8"/><path d="M8.8 13.2h6.4M8.8 16.8h4.4"/>',
    clipboard: '<rect x="7" y="4.4" width="10" height="3.6" rx="1.2"/><path d="M9.4 6H6.8a1.8 1.8 0 0 0-1.8 1.8v11a1.8 1.8 0 0 0 1.8 1.8h10.4a1.8 1.8 0 0 0 1.8-1.8v-11A1.8 1.8 0 0 0 17.2 6h-2.6"/><path d="M8.8 11.6h6.4M8.8 15.2h4.4"/>',
    key: '<circle cx="8" cy="15.6" r="3.8"/><path d="m10.8 12.9 8-8"/><path d="m16.4 7.3 2 2M19 4.7l2 2"/>',
    download: '<path d="M20 15.2v3.4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3.4"/><path d="m7.8 10.6 4.2 4.2 4.2-4.2"/><path d="M12 14.4V3.4"/>',
    bell: '<path d="M17.6 10.2a5.6 5.6 0 1 0-11.2 0c0 6.1-2.4 7.8-2.4 7.8h16s-2.4-1.7-2.4-7.8"/><path d="M13.6 21a1.9 1.9 0 0 1-3.2 0"/>',
    eye: '<path d="M2.4 12S5.8 5.6 12 5.6 21.6 12 21.6 12 18.2 18.4 12 18.4 2.4 12 2.4 12z"/><circle cx="12" cy="12" r="2.9"/>',
    eyeOff: '<path d="M10 5.9a8.5 8.5 0 0 1 2-.3c6.2 0 9.6 6.4 9.6 6.4a15 15 0 0 1-2.4 3.3"/><path d="M6.2 6.5A15.4 15.4 0 0 0 2.4 12S5.8 18.4 12 18.4a8.9 8.9 0 0 0 4-.9"/><path d="M9.9 9.9a2.9 2.9 0 0 0 4.1 4.1"/><path d="m3.5 3.5 17 17"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20.4 20.4-4.4-4.4"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    close: '<path d="m6.4 6.4 11.2 11.2M17.6 6.4 6.4 17.6"/>',
    alert: '<path d="M12 4.2 2.6 20.2h18.8z"/><path d="M12 10v4.2M12 17.4h.01"/>',
    info: '<circle cx="12" cy="12" r="8.8"/><path d="M12 11.2v4.8M12 8.2h.01"/>',
    check: '<path d="m5 12.6 4.6 4.6L19 7.4"/>',
    history: '<path d="M3.4 12a8.6 8.6 0 1 0 2.6-6.1L3.2 8.6"/><path d="M3.2 4.2v4.4h4.4"/><path d="M12 7.8V12l3 1.8"/>',
    calculator: '<rect x="5" y="3" width="14" height="18" rx="2.2"/><path d="M8.4 7.2h7.2"/><path d="M8.6 11.6h.01M12 11.6h.01M15.4 11.6h.01M8.6 15.2h.01M12 15.2h.01M15.4 15.2h.01M8.6 18.2h.01M12 18.2h.01M15.4 18.2h.01"/>',
    creditCard: '<rect x="2.5" y="5" width="19" height="14" rx="2.2"/><path d="M2.5 9.8h19"/><path d="M6.4 14.8h3"/>',
    logout: '<path d="M9.4 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.4"/><path d="m15.2 16.4 4.4-4.4-4.4-4.4"/><path d="M19.6 12H9.4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    refresh: '<path d="M20.6 11a8.6 8.6 0 0 0-14.7-4.6L3.4 8.8"/><path d="M3.4 13a8.6 8.6 0 0 0 14.7 4.6l2.5-2.4"/><path d="M3.4 4.4v4.4h4.4M20.6 19.6v-4.4h-4.4"/>',

    // Chrome. `panelLeft` is the sidebar-collapse control: a panel outline with
    // the rail picked out, so the button depicts the thing it acts on. It is
    // drawn symmetrically about the rail line, which lets CSS flip it with a
    // 180deg rotation to mean "expand" without a second icon.
    panelLeft: '<rect x="3.2" y="4.2" width="17.6" height="15.6" rx="2.4"/><path d="M9.4 4.2v15.6"/><path d="m16.8 9.6-2.4 2.4 2.4 2.4"/>',
    chevronLeft: '<path d="m14.4 7.2-4.8 4.8 4.8 4.8"/>',
    chevronRight: '<path d="m9.6 7.2 4.8 4.8-4.8 4.8"/>'
};

// Friendlier aliases, so markup can say what it means.
const ICON_ALIASES = {
    staff: 'users', accounts: 'users', admin: 'shield', hr: 'building',
    accountant: 'receipt', teachers: 'teacher', payroll: 'banknote',
    money: 'wallet', leave: 'calendar', approve: 'checkCircle',
    pending: 'clock', email: 'mail', payments: 'bank', reports: 'trendingUp',
    security: 'lock', config: 'settings', statement: 'fileText',
    audit: 'clipboard', mfa: 'key', backup: 'download', profile: 'user',
    payslips: 'receipt', advances: 'banknote', success: 'check',
    warning: 'alert', error: 'close', danger: 'close'
};

const resolve = (name) => ICON_ALIASES[name] || name;

/**
 * Inline SVG markup for an icon.
 * Returns an empty string for an unknown name rather than throwing, so a typo
 * in markup degrades to a blank space instead of breaking the page.
 */
function icon(name, { size = 20, className = 'icon' } = {}) {
    const paths = ICON_PATHS[resolve(name)];
    if (!paths) return '';

    return `<svg class="${className}" viewBox="0 0 24 24" width="${size}" height="${size}"`
        + ' fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"'
        + ` stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

/**
 * Replace every `[data-icon]` placeholder in a subtree with its icon.
 *
 * Elements are marked `data-icon-done` once filled, so this is safe to call
 * again after new rows are rendered.
 */
function hydrateIcons(root = document) {
    root.querySelectorAll('[data-icon]:not([data-icon-done])').forEach(el => {
        const markup = icon(el.dataset.icon, { size: Number(el.dataset.iconSize) || 20 });
        if (!markup) return;

        // A stat tile wants the icon in its own chip, ahead of the label.
        if (el.classList.contains('stat-card')) {
            const chip = document.createElement('span');
            chip.className = 'stat-icon';
            chip.innerHTML = markup;
            el.prepend(chip);
        } else {
            el.innerHTML = markup;
        }

        el.setAttribute('data-icon-done', '');
    });
}

document.addEventListener('DOMContentLoaded', () => hydrateIcons());
