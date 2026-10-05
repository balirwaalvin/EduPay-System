/* EduPay sign-in. Extracted from an inline <script> so the page needs no
   script-src 'unsafe-inline' allowance in the content security policy. */
'use strict';

(function initLogin() {
    // Already signed in? Go straight to the right dashboard.
    const existingUser = getUser();
    if (existingUser && getToken()) {
        window.location.replace(dashboardPathFor(existingUser.role));
        return;
    }

    const loginForm = document.getElementById('loginForm');
    const mfaForm = document.getElementById('mfaForm');
    const noticeEl = document.getElementById('loginNotice');
    const errorEl = document.getElementById('loginError');
    const loginBtn = document.getElementById('loginBtn');
    const verifyBtn = document.getElementById('verifyBtn');
    const resendBtn = document.getElementById('resendBtn');
    const backBtn = document.getElementById('backToLoginBtn');
    const otpInput = document.getElementById('otpCode');
    const countdownEl = document.getElementById('mfaCountdown');

    let pendingMfa = null;
    let countdownId = null;

    // A sign-out triggered by the server arrives as ?notice=…
    const notice = new URLSearchParams(window.location.search).get('notice');
    if (notice) {
        showMessage(noticeEl, notice);
        history.replaceState(null, '', '/');
    }

    function showMessage(el, text) {
        el.textContent = text;
        el.hidden = false;
    }

    function hide(el) {
        el.hidden = true;
        el.textContent = '';
    }

    function setBusy(button, busy, busyLabel, idleLabel) {
        button.disabled = busy;
        button.textContent = busy ? busyLabel : idleLabel;
        button.setAttribute('aria-busy', String(busy));
    }

    function startCountdown(seconds) {
        clearInterval(countdownId);
        let remaining = Number(seconds) || 0;

        const tick = () => {
            if (remaining <= 0) {
                clearInterval(countdownId);
                countdownEl.textContent = 'Your code has expired. Request a new one.';
                return;
            }
            const mins = Math.floor(remaining / 60);
            const secs = String(remaining % 60).padStart(2, '0');
            countdownEl.textContent = `Code expires in ${mins}:${secs}`;
            remaining -= 1;
        };

        tick();
        countdownId = setInterval(tick, 1000);
    }

    function showMfaStep(data, username) {
        pendingMfa = { username, token: data.mfaToken, method: data.mfaMethod };

        loginForm.hidden = true;
        mfaForm.hidden = false;
        resendBtn.hidden = data.mfaMethod !== 'email';

        showMessage(noticeEl, data.message || 'Enter your verification code.');
        startCountdown(data.expiresInSeconds);
        otpInput.value = '';
        otpInput.focus();
    }

    function resetToSignIn(message) {
        pendingMfa = null;
        clearInterval(countdownId);
        countdownEl.textContent = '';

        mfaForm.hidden = true;
        loginForm.hidden = false;
        document.getElementById('password').value = '';
        otpInput.value = '';
        hide(noticeEl);

        if (message) showMessage(errorEl, message);
        else hide(errorEl);

        setBusy(loginBtn, false, '', 'Sign in');
    }

    function completeSignIn(data) {
        setToken(data.token);
        setUser(data.user);
        window.location.replace(dashboardPathFor(data.user.role));
    }

    loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        hide(errorEl);
        hide(noticeEl);

        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;

        if (!username || !password) {
            showMessage(errorEl, 'Enter both your username and password.');
            return;
        }

        setBusy(loginBtn, true, 'Signing in…', 'Sign in');

        try {
            const data = await apiRequest('/auth/login', {
                method: 'POST',
                body: { username, password }
            });

            if (data.mfaRequired) {
                showMfaStep(data, username);
                setBusy(loginBtn, false, '', 'Sign in');
                return;
            }

            completeSignIn(data);
        } catch (err) {
            showMessage(errorEl, err.message || 'Sign-in failed. Please try again.');
            setBusy(loginBtn, false, '', 'Sign in');
        }
    });

    mfaForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        hide(errorEl);

        if (!pendingMfa) {
            resetToSignIn('That sign-in session expired. Please start again.');
            return;
        }

        const otp = otpInput.value.trim();
        if (!/^\d{6}$/.test(otp)) {
            showMessage(errorEl, 'Enter the 6-digit code from your email.');
            return;
        }

        setBusy(verifyBtn, true, 'Verifying…', 'Verify and continue');

        try {
            const data = await apiRequest('/auth/verify-mfa', {
                method: 'POST',
                body: { username: pendingMfa.username, mfaToken: pendingMfa.token, otp }
            });
            completeSignIn(data);
        } catch (err) {
            showMessage(errorEl, err.message || 'Verification failed.');
            setBusy(verifyBtn, false, '', 'Verify and continue');

            // Codes that end the challenge send the user back to the start.
            if (['MFA_ATTEMPTS_EXCEEDED', 'MFA_EXPIRED', 'MFA_TOKEN_INVALID'].includes(err.code)) {
                setTimeout(() => resetToSignIn(err.message), 2200);
            }
        }
    });

    resendBtn.addEventListener('click', async () => {
        hide(errorEl);
        if (!pendingMfa) {
            resetToSignIn('That sign-in session expired. Please start again.');
            return;
        }

        setBusy(resendBtn, true, 'Sending…', 'Send a new code');

        try {
            const data = await apiRequest('/auth/resend-mfa', {
                method: 'POST',
                body: { username: pendingMfa.username, mfaToken: pendingMfa.token }
            });
            showMessage(noticeEl, data.message || 'A new code has been sent.');
            startCountdown(data.expiresInSeconds);
        } catch (err) {
            showMessage(errorEl, err.message || 'Could not send a new code.');
        } finally {
            setBusy(resendBtn, false, '', 'Send a new code');
        }
    });

    backBtn.addEventListener('click', () => resetToSignIn());

    // Accept only digits in the code field, and submit automatically at six.
    otpInput.addEventListener('input', () => {
        otpInput.value = otpInput.value.replace(/\D/g, '').slice(0, 6);
        if (otpInput.value.length === 6) mfaForm.requestSubmit();
    });
}());
