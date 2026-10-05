const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../server/services/validate');

const rejects = (fn, code) => assert.throws(fn, err => err.code === code || err.status === 400);

test('required strings are trimmed and enforced', () => {
    assert.equal(v.str('  Grace  ', 'Name'), 'Grace');
    rejects(() => v.str('', 'Name'));
    rejects(() => v.str('   ', 'Name'));
    assert.equal(v.str('', 'Name', { required: false }), null);
});

test('email addresses are validated and lowercased', () => {
    assert.equal(v.email('Grace@School.UG', 'Email'), 'grace@school.ug');
    rejects(() => v.email('not-an-email', 'Email', { required: true }));
    rejects(() => v.email('missing@domain', 'Email', { required: true }));
});

test('usernames are restricted to a safe character set', () => {
    assert.equal(v.username('Grace.Nakato'), 'grace.nakato');
    rejects(() => v.username('ab'));                  // too short
    rejects(() => v.username('.leadingdot'));         // must start alphanumeric
    rejects(() => v.username('has spaces'));
    rejects(() => v.username('has/slash'));
});

test('numbers honour bounds and integer constraints', () => {
    assert.equal(v.num('42', 'Count', { min: 0, max: 100 }), 42);
    rejects(() => v.num('abc', 'Count'));
    rejects(() => v.num('-1', 'Count', { min: 0 }));
    rejects(() => v.num('101', 'Count', { max: 100 }));
    rejects(() => v.num('1.5', 'Count', { integer: true }));
});

test('dates must be real calendar dates', () => {
    assert.equal(v.isoDate('2026-06-15', 'Date'), '2026-06-15');
    rejects(() => v.isoDate('15/06/2026', 'Date'));
    rejects(() => v.isoDate('2026-02-30', 'Date'));   // February has no 30th
    rejects(() => v.isoDate('2026-13-01', 'Date'));
});

test('payroll periods reject impossible months and years', () => {
    const current = new Date().getFullYear();
    assert.deepEqual(v.period(6, current), { month: 6, year: current });

    rejects(() => v.period(47, current));             // the old code accepted this
    rejects(() => v.period(0, current));
    rejects(() => v.period(6, 1823));
    rejects(() => v.period(6, current + 5));
});

test('the password policy rejects the old shared defaults', () => {
    ['teacher123', 'accountant123', 'hr123', 'admin123', 'password123'].forEach(weak => {
        rejects(() => v.password(weak));
    });
});

test('the password policy requires length and character variety', () => {
    rejects(() => v.password('Shor7!'));              // too short
    rejects(() => v.password('alllowercaseletters')); // only one class
    assert.equal(v.password('Kampala-2026!x'), 'Kampala-2026!x');
});

test('one-time codes must be exactly six digits', () => {
    assert.equal(v.otp(' 123456 '), '123456');
    rejects(() => v.otp('12345'));
    rejects(() => v.otp('1234567'));
    rejects(() => v.otp('12345a'));
});

test('document ids reject path separators', () => {
    assert.equal(v.docId('abc123', 'Id'), 'abc123');
    rejects(() => v.docId('a/b', 'Id'));
    rejects(() => v.docId('', 'Id'));
});

test('oneOf restricts to the allowed set', () => {
    assert.equal(v.oneOf('bank', ['bank', 'mobile_money'], 'Method'), 'bank');
    rejects(() => v.oneOf('cheque', ['bank', 'mobile_money'], 'Method'));
});
