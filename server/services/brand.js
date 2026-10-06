/**
 * Brand palette for everything the server renders.
 *
 * PDFs, Excel workbooks and email templates cannot read CSS custom properties,
 * so without this the brand hexes end up copied across three files and drift the
 * first time anyone retouches the colour. These values mirror the `--primary-*`
 * and `--secondary-*` ramps in public/css/styles.css; change both together.
 *
 *   PRIMARY    jade  #0E7F76   the system's voice
 *   SECONDARY  amber #F59E0B   attention — the net-pay line, anything waiting
 */

const PRIMARY = {
    50: '#EDFAF8',
    100: '#D2F3EE',
    200: '#A6E6DD',
    300: '#70D2C6',
    500: '#1E9C90',
    600: '#0E7F76',
    700: '#0B655F',
    800: '#0A4F4B',
    900: '#073A38'
};

const SECONDARY = {
    50: '#FFFBEB',
    100: '#FEF0C7',
    400: '#FBBF24',
    500: '#F59E0B',
    600: '#D97706',
    700: '#B45309'
};

// Warning is its own hue, deliberately not the secondary ramp — see the note in
// styles.css. Kept here so a report or email can use it consistently.
const WARNING = {
    50: '#FFF4ED',
    100: '#FFE3D0',
    600: '#EA580C',
    700: '#C2410C'
};

const INK = {
    900: '#0C1522',
    800: '#17233A',
    500: '#697389',
    200: '#E1E7F1',
    100: '#EFF3F9',
    50: '#F7F9FC'
};

/** Hex without the leading hash, as ExcelJS wants ARGB. */
const argb = (hex) => `FF${hex.replace('#', '').toUpperCase()}`;

module.exports = {
    PRIMARY,
    SECONDARY,
    WARNING,
    INK,
    argb,

    // Named roles, so callers say what they mean rather than picking a step.
    brand: PRIMARY[600],
    brandDeep: PRIMARY[800],
    brandTint: PRIMARY[50],
    accent: SECONDARY[500],
    accentDeep: SECONDARY[700],
    accentTint: SECONDARY[50],
    warning: WARNING[700],
    warningTint: WARNING[50],
    text: INK[800],
    textMuted: INK[500],
    rule: INK[200],
    canvas: '#F2F5FA'
};
