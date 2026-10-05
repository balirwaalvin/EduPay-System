require('dotenv').config();
const admin = require('firebase-admin');

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'edupay-ug';

// Resolve server credentials. The Firebase *web* config (apiKey/authDomain/...) is a
// browser artefact and cannot authenticate a server, so we look for a service account:
//   1. FIREBASE_SERVICE_ACCOUNT        - the service-account JSON inline (best for PaaS env vars)
//   2. FIREBASE_SERVICE_ACCOUNT_BASE64 - the same JSON, base64-encoded (avoids newline mangling)
//   3. GOOGLE_APPLICATION_CREDENTIALS  - path to the JSON file (handled natively by the SDK)
//   4. Application Default Credentials - automatic on Cloud Run / GCE / Cloud Functions
function resolveCredential() {
    const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (inline && inline.trim()) {
        try {
            const parsed = JSON.parse(inline);
            if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
            return { credential: admin.credential.cert(parsed), source: 'FIREBASE_SERVICE_ACCOUNT' };
        } catch (err) {
            throw new Error(`FIREBASE_SERVICE_ACCOUNT is not valid JSON: ${err.message}`);
        }
    }

    const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (encoded && encoded.trim()) {
        try {
            const parsed = JSON.parse(Buffer.from(encoded.trim(), 'base64').toString('utf8'));
            return { credential: admin.credential.cert(parsed), source: 'FIREBASE_SERVICE_ACCOUNT_BASE64' };
        } catch (err) {
            throw new Error(`FIREBASE_SERVICE_ACCOUNT_BASE64 could not be decoded: ${err.message}`);
        }
    }

    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        return { credential: admin.credential.applicationDefault(), source: 'GOOGLE_APPLICATION_CREDENTIALS' };
    }

    if (process.env.FIRESTORE_EMULATOR_HOST) {
        return { credential: null, source: 'FIRESTORE_EMULATOR_HOST' };
    }

    return { credential: admin.credential.applicationDefault(), source: 'application-default' };
}

let app;
function getApp() {
    if (app) return app;
    if (admin.apps.length) {
        app = admin.apps[0];
        return app;
    }

    const { credential, source } = resolveCredential();
    const options = { projectId: PROJECT_ID };
    if (credential) options.credential = credential;

    app = admin.initializeApp(options);
    console.log(`[Firebase] Initialised project "${PROJECT_ID}" using ${source}.`);
    return app;
}

let firestore;
function getDb() {
    if (firestore) return firestore;
    firestore = getApp().firestore();
    firestore.settings({ ignoreUndefinedProperties: true });
    return firestore;
}

// ---------------------------------------------------------------------------
// Collections. Several use a natural document id so that uniqueness is enforced
// by Firestore itself rather than by an application-level check that can race:
//   salaryStructures/{scale}      one structure per scale
//   payroll/{year}-{month}        one payroll run per period
//   usernames/{username}          one account per username
//   systemConfig/{key}            one value per config key
// ---------------------------------------------------------------------------
const COLLECTIONS = {
    users: 'users',
    usernames: 'usernames',
    teachers: 'teachers',
    accountants: 'accountants',
    salaryStructures: 'salaryStructures',
    payroll: 'payroll',
    payrollItems: 'payrollItems',
    leaveRequests: 'leaveRequests',
    advanceRequests: 'advanceRequests',
    notifications: 'notifications',
    auditLog: 'auditLog',
    systemConfig: 'systemConfig',
    counters: 'counters',
    passwordResets: 'passwordResets'
};

const col = (name) => getDb().collection(name);

const users = () => col(COLLECTIONS.users);
const usernames = () => col(COLLECTIONS.usernames);
const teachers = () => col(COLLECTIONS.teachers);
const accountants = () => col(COLLECTIONS.accountants);
const salaryStructures = () => col(COLLECTIONS.salaryStructures);
const payroll = () => col(COLLECTIONS.payroll);
const payrollItems = () => col(COLLECTIONS.payrollItems);
const leaveRequests = () => col(COLLECTIONS.leaveRequests);
const advanceRequests = () => col(COLLECTIONS.advanceRequests);
const notifications = () => col(COLLECTIONS.notifications);
const auditLog = () => col(COLLECTIONS.auditLog);
const systemConfig = () => col(COLLECTIONS.systemConfig);
const counters = () => col(COLLECTIONS.counters);
const passwordResets = () => col(COLLECTIONS.passwordResets);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

const serverTimestamp = () => FieldValue.serverTimestamp();

/** Firestore snapshot -> plain object with its id folded in. */
function docData(snap) {
    if (!snap || !snap.exists) return null;
    return { id: snap.id, ...normaliseTimestamps(snap.data()) };
}

/** Query snapshot -> array of plain objects. */
function docsData(snap) {
    return snap.docs.map(d => ({ id: d.id, ...normaliseTimestamps(d.data()) }));
}

/** Convert Firestore Timestamps to ISO strings so JSON responses stay stable. */
function normaliseTimestamps(value) {
    if (value === null || value === undefined) return value;
    if (value instanceof Timestamp) return value.toDate().toISOString();
    if (Array.isArray(value)) return value.map(normaliseTimestamps);
    if (typeof value === 'object' && value.constructor === Object) {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = normaliseTimestamps(v);
        return out;
    }
    return value;
}

/**
 * Atomically increment a named counter and return the new value.
 * Used for employee-id sequences, which must never collide.
 */
async function nextSequence(name, startAt = 1) {
    const ref = counters().doc(name);
    return getDb().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const next = snap.exists ? Number(snap.data().value || 0) + 1 : startAt;
        tx.set(ref, { value: next, updatedAt: serverTimestamp() }, { merge: true });
        return next;
    });
}

/** Normalise a username into the form used as the reservation document id. */
function normaliseUsername(raw) {
    return String(raw || '').trim().toLowerCase();
}

/**
 * Create a user document and claim its username in a single transaction, so two
 * concurrent sign-ups can never end up sharing a username.
 * Throws an error tagged `code = 'USERNAME_TAKEN'` when the name is in use.
 */
async function createUserWithUsername(userData) {
    const username = normaliseUsername(userData.username);
    if (!username) throw new Error('Username is required.');

    const userRef = users().doc();
    const nameRef = usernames().doc(username);

    await getDb().runTransaction(async (tx) => {
        const existing = await tx.get(nameRef);
        if (existing.exists) {
            const err = new Error(`Username "${username}" is already taken.`);
            err.code = 'USERNAME_TAKEN';
            throw err;
        }
        tx.set(nameRef, { userId: userRef.id, createdAt: serverTimestamp() });
        tx.set(userRef, {
            ...userData,
            username,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });
    });

    return userRef.id;
}

/** Release a username reservation (used when an account is hard-deleted). */
async function releaseUsername(username) {
    const key = normaliseUsername(username);
    if (!key) return;
    await usernames().doc(key).delete().catch(() => { });
}

/** Look a user up by username via the reservation index (a single point read). */
async function findUserByUsername(rawUsername) {
    const key = normaliseUsername(rawUsername);
    if (!key) return null;

    const nameSnap = await usernames().doc(key).get();
    if (nameSnap.exists) {
        const userSnap = await users().doc(nameSnap.data().userId).get();
        if (userSnap.exists) return docData(userSnap);
    }

    // Fall back to a query so accounts created before the index existed still resolve.
    const q = await users().where('username', '==', key).limit(1).get();
    return q.empty ? null : docData(q.docs[0]);
}

/**
 * Firestore `in` queries accept at most 30 values, so batch lookups by id.
 * Returns a Map of id -> document.
 */
async function getManyByIds(collection, ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    const out = new Map();
    if (!unique.length) return out;

    const refs = unique.map(id => collection.doc(id));
    for (let i = 0; i < refs.length; i += 300) {
        const chunk = refs.slice(i, i + 300);
        const snaps = await getDb().getAll(...chunk);
        snaps.forEach(snap => { if (snap.exists) out.set(snap.id, docData(snap)); });
    }
    return out;
}

/**
 * Delete every document matched by a query, in chunks, so cleanup of a parent
 * record cannot exceed the 500-write batch ceiling.
 */
async function deleteQueryBatched(query, chunkSize = 400) {
    let deleted = 0;
    for (;;) {
        const snap = await query.limit(chunkSize).get();
        if (snap.empty) return deleted;
        const batch = getDb().batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        deleted += snap.size;
        if (snap.size < chunkSize) return deleted;
    }
}

/** Apply many writes without tripping the 500-operations-per-batch limit. */
async function commitInChunks(writes, chunkSize = 400) {
    for (let i = 0; i < writes.length; i += chunkSize) {
        const batch = getDb().batch();
        writes.slice(i, i + chunkSize).forEach(apply => apply(batch));
        await batch.commit();
    }
}

/** Verify the credentials actually work, so startup fails loudly rather than on first request. */
async function verifyConnection() {
    await systemConfig().limit(1).get();
}

module.exports = {
    admin,
    getApp,
    getDb,
    COLLECTIONS,
    col,
    users,
    usernames,
    teachers,
    accountants,
    salaryStructures,
    payroll,
    payrollItems,
    leaveRequests,
    advanceRequests,
    notifications,
    auditLog,
    systemConfig,
    counters,
    passwordResets,
    FieldValue,
    Timestamp,
    serverTimestamp,
    docData,
    docsData,
    normaliseTimestamps,
    nextSequence,
    normaliseUsername,
    createUserWithUsername,
    releaseUsername,
    findUserByUsername,
    getManyByIds,
    deleteQueryBatched,
    commitInChunks,
    verifyConnection,
    PROJECT_ID
};
