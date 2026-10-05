/**
 * HTTP smoke tests.
 *
 * These exercise the real Express app — security headers, validation, the
 * authentication gate, static pages and the error handler — without needing
 * Firestore, so they run anywhere.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-definitely-long-enough-32';

const { app } = require('../server/server');

let server;
let base;

test.before(async () => {
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise(resolve => server.close(resolve)));

const get = (path, options) => fetch(`${base}${path}`, options);
const postJson = (path, body) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
});

test('the liveness endpoint responds without touching the database', async () => {
    const res = await get('/healthz');
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptimeSeconds, 'number');
});

test('security headers are present', async () => {
    const res = await get('/healthz');

    // A content security policy is the backstop behind output escaping.
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, 'a content security policy must be set');
    assert.ok(csp.includes("default-src 'self'"));
    assert.ok(csp.includes("object-src 'none'"));
    assert.ok(csp.includes("frame-ancestors 'none'"));
    assert.ok(!csp.includes("'unsafe-inline'"), 'scripts must not need an inline allowance');

    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(res.headers.get('x-powered-by'), null, 'the server banner must be suppressed');
});

test('the login page is served', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);

    const body = await res.text();
    assert.ok(body.includes('id="loginForm"'));
    assert.ok(body.includes('/js/login.js'), 'the login script must be external, not inline');
});

test('the password setup page exists', async () => {
    // This page was referenced by the account-creation email but never existed,
    // so every teacher created by an administrator was locked out.
    const res = await get('/setup-password.html');
    assert.equal(res.status, 200);

    const body = await res.text();
    assert.ok(body.includes('id="passwordForm"'));
    assert.ok(body.includes('data-flow="setup"'));
});

test('the password reset and forgot-password pages exist', async () => {
    for (const [path, flow] of [['/reset-password.html', 'reset'], ['/forgot-password.html', 'forgot']]) {
        const res = await get(path);
        assert.equal(res.status, 200, `${path} should be served`);
        assert.ok((await res.text()).includes(`data-flow="${flow}"`));
    }
});

test('every dashboard page is served', async () => {
    for (const path of ['/admin', '/hr', '/accountant', '/teacher-portal']) {
        const res = await get(path);
        assert.equal(res.status, 200, `${path} should be served`);
        assert.ok((await res.text()).includes('id="pageTitle"'));
    }
});

test('an unknown API path returns a JSON 404, not an HTML page', async () => {
    const res = await get('/api/does-not-exist');
    assert.equal(res.status, 404);

    const body = await res.json();
    assert.equal(body.code, 'NOT_FOUND');
    assert.ok(body.error.includes('/api/does-not-exist'));
});

test('protected routes reject a request with no token', async () => {
    for (const path of ['/api/admin/users', '/api/hr/teachers', '/api/accountant/payroll',
        '/api/teacher/profile', '/api/notifications']) {
        const res = await get(path);
        assert.equal(res.status, 401, `${path} must require authentication`);
        assert.equal((await res.json()).code, 'NO_TOKEN');
    }
});

test('protected routes reject a malformed token', async () => {
    const res = await get('/api/admin/users', {
        headers: { Authorization: 'Bearer not-a-real-token' }
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, 'TOKEN_INVALID');
});

test('login validates its input before any database work', async () => {
    const missing = await postJson('/api/auth/login', {});
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /Username is required/);

    const noPassword = await postJson('/api/auth/login', { username: 'someone' });
    assert.equal(noPassword.status, 400);
    assert.match((await noPassword.json()).error, /Password is required/);
});

test('MFA verification rejects a code that is not six digits', async () => {
    const res = await postJson('/api/auth/verify-mfa', {
        username: 'someone', mfaToken: 'abc', otp: '123'
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /6 digits/);
});

test('the password policy is enforced on the setup endpoint', async () => {
    const res = await postJson('/api/auth/setup-password/complete', {
        token: 'x'.repeat(64), newPassword: 'teacher123'
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /too common/i);
});

test('an oversized JSON body is rejected', async () => {
    const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'a'.repeat(400000), password: 'b' })
    });
    assert.ok(res.status === 413 || res.status === 400, `expected a rejection, got ${res.status}`);
});

test('the stylesheet and shared script are served', async () => {
    for (const path of ['/css/styles.css', '/js/app.js', '/js/firebase-client.js']) {
        const res = await get(path);
        assert.equal(res.status, 200, `${path} should be served`);
    }
});
