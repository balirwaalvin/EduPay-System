/* Password setup, reset-request and reset-complete flows.
   One script serves all three pages, selected by body[data-flow]. */
'use strict';

(function initPasswordFlow() {
    const flow = document.body.dataset.flow;

    const errorEl = document.getElementById('flowError');
    const noticeEl = document.getElementById('flowNotice');

    function fail(message) {
        errorEl.textContent = message;
        errorEl.hidden = false;
    }

    function note(message) {
        noticeEl.textContent = message;
        noticeEl.hidden = false;
    }

    function clearMessages() {
        errorEl.hidden = true;
        noticeEl.hidden = true;
    }

    function tokenFromUrl() {
        return new URLSearchParams(window.location.search).get('token') || '';
    }

    /** Live password strength feedback, matching the server's policy. */
    function attachStrengthMeter(input, meter) {
        if (!input || !meter) return;

        input.addEventListener('input', () => {
            const value = input.value;
            const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(value)).length;
            const longEnough = value.length >= 10;

            let level = 'weak';
            let label = 'Too short';

            if (longEnough && classes >= 4) { level = 'strong'; label = 'Strong'; }
            else if (longEnough && classes === 3) { level = 'good'; label = 'Good'; }
            else if (longEnough) { level = 'fair'; label = 'Add another character type'; }
            else if (value.length === 0) { level = ''; label = ''; }

            meter.className = `strength-meter ${level}`;
            meter.textContent = label;
        });
    }

    /** Shared handler for the two "choose a password" pages. */
    function initChoosePassword({ validateEndpoint, completeEndpoint, successMessage }) {
        const token = tokenFromUrl();
        const form = document.getElementById('passwordForm');
        const loading = document.getElementById('flowLoading');
        const invalid = document.getElementById('flowInvalid');
        const greeting = document.getElementById('flowGreeting');
        const submit = document.getElementById('flowSubmit');

        attachStrengthMeter(document.getElementById('newPassword'), document.getElementById('strengthMeter'));

        if (!token) {
            loading.hidden = true;
            invalid.hidden = false;
            fail('This link is missing its token. Open the link from your email exactly as it was sent.');
            return;
        }

        // Confirm the token before showing the form, so an expired link says so
        // up front rather than after the person has typed a password.
        apiRequest(validateEndpoint, { method: 'POST', body: { token } })
            .then(data => {
                loading.hidden = true;
                form.hidden = false;
                if (greeting && data.fullName) {
                    greeting.textContent = `Hello ${data.fullName}, choose a password for your account.`;
                } else if (greeting && data.username) {
                    greeting.textContent = `Choose a new password for ${data.username}.`;
                }
                document.getElementById('newPassword').focus();
            })
            .catch(err => {
                loading.hidden = true;
                invalid.hidden = false;
                fail(err.message || 'This link is no longer valid.');
            });

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            clearMessages();

            const next = document.getElementById('newPassword').value;
            const confirm = document.getElementById('confirmPassword').value;

            if (next !== confirm) {
                fail('The two passwords do not match.');
                return;
            }

            submit.disabled = true;
            submit.textContent = 'Saving…';

            try {
                await apiRequest(completeEndpoint, { method: 'POST', body: { token, newPassword: next } });

                form.hidden = true;
                note(successMessage);
                setTimeout(() => window.location.replace('/'), 2600);
            } catch (err) {
                fail(err.message || 'Could not set your password.');
                submit.disabled = false;
                submit.textContent = 'Set my password';
            }
        });
    }

    if (flow === 'setup') {
        initChoosePassword({
            validateEndpoint: '/auth/setup-password/validate',
            completeEndpoint: '/auth/setup-password/complete',
            successMessage: 'Your password has been set. Taking you to the sign-in page…'
        });
        return;
    }

    if (flow === 'reset') {
        initChoosePassword({
            validateEndpoint: '/auth/reset-password/validate',
            completeEndpoint: '/auth/reset-password/complete',
            successMessage: 'Your password has been changed. Taking you to the sign-in page…'
        });
        return;
    }

    if (flow === 'forgot') {
        const form = document.getElementById('forgotForm');
        const submit = document.getElementById('flowSubmit');

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            clearMessages();

            const identifier = document.getElementById('identifier').value.trim();
            if (!identifier) {
                fail('Enter your username or email address.');
                return;
            }

            submit.disabled = true;
            submit.textContent = 'Sending…';

            try {
                const data = await apiRequest('/auth/forgot-password', {
                    method: 'POST',
                    body: { identifier }
                });

                // The server answers identically whether or not the account
                // exists, so this page cannot be used to discover usernames.
                form.hidden = true;
                note(data.message);
            } catch (err) {
                fail(err.message || 'Could not send the reset link.');
                submit.disabled = false;
                submit.textContent = 'Send reset link';
            }
        });
    }
}());
