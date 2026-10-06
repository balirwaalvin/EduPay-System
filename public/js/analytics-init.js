/**
 * Start Firebase Analytics on the sign-in page.
 *
 * In its own file rather than an inline <script type="module">, because the
 * content security policy sets script-src without 'unsafe-inline' — an inline
 * block is blocked outright and logs an error on every page load.
 */
import { initFirebaseAnalytics } from '/js/firebase-client.js';

initFirebaseAnalytics();
