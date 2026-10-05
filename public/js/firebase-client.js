/**
 * Firebase web SDK, in the browser.
 *
 * Scope note: this is used for Analytics only. All data access goes through the
 * EduPay API, which talks to Firestore with a service account and enforces the
 * payroll approval chain; the published Firestore rules deny direct client
 * access. These values are the project's public web configuration — Firebase
 * ships them in client bundles by design, and the API key is an identifier, not
 * a credential.
 *
 * Analytics is off unless `data-analytics="on"` is set on the <html> element, so
 * no measurement calls are made from the authenticated dashboards.
 */
const firebaseConfig = {
    apiKey: 'AIzaSyBLSb9weBQ8XNM5wSl6mJcJOMoHn3I1m3M',
    authDomain: 'edupay-ug.firebaseapp.com',
    projectId: 'edupay-ug',
    storageBucket: 'edupay-ug.firebasestorage.app',
    messagingSenderId: '854029972559',
    appId: '1:854029972559:web:c7188726150f338949663a',
    measurementId: 'G-PW08X3G9MZ'
};

const SDK_VERSION = '12.4.0';
const CDN = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;

/** Load the SDK and start Analytics. Resolves to null when disabled or blocked. */
async function initFirebaseAnalytics() {
    if (document.documentElement.dataset.analytics !== 'on') return null;

    // Respect Do Not Track rather than measuring regardless.
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return null;

    try {
        const [{ initializeApp }, analyticsModule] = await Promise.all([
            import(`${CDN}/firebase-app.js`),
            import(`${CDN}/firebase-analytics.js`)
        ]);

        const supported = await analyticsModule.isSupported().catch(() => false);
        if (!supported) return null;

        return analyticsModule.getAnalytics(initializeApp(firebaseConfig));
    } catch {
        // A blocked CDN or an ad blocker must never stop the page working.
        return null;
    }
}

export { firebaseConfig, initFirebaseAnalytics };
