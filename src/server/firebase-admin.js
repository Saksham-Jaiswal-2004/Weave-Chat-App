import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';

/** @type {import('firebase-admin/app').App | null} */
let cachedApp = null;
/** @type {import('firebase-admin/firestore').Firestore | null} */
let cachedDb = null;

function missing(name) {
  return new Error(
    `[weave] Missing ${name}. Copy .env.example to .env.local and fill in your ` +
      `Firebase service-account credentials before starting the server.`
  );
}

/**
 * Initialised lazily so that `next build` (and any import-time analysis) does not
 * require credentials to be present.
 * @returns {import('firebase-admin/app').App}
 */
function adminApp() {
  if (cachedApp) return cachedApp;

  const existing = getApps();
  if (existing.length > 0) {
    cachedApp = existing[0];
    return cachedApp;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // Service-account keys are stored single-line in .env with literal "\n" escapes,
  // so turn those two characters back into real newlines. A key that already has
  // real newlines passes through untouched.
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId) throw missing('FIREBASE_PROJECT_ID');
  if (!clientEmail) throw missing('FIREBASE_CLIENT_EMAIL');
  if (!privateKey) throw missing('FIREBASE_PRIVATE_KEY');

  cachedApp = initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
    projectId,
  });
  return cachedApp;
}

/** @returns {import('firebase-admin/firestore').Firestore} */
export function db() {
  if (cachedDb) return cachedDb;
  cachedDb = getFirestore(adminApp());
  // Must be called before the first read/write, and only once per instance.
  cachedDb.settings({ ignoreUndefinedProperties: true });
  return cachedDb;
}

/** @returns {import('firebase-admin/auth').Auth} */
export function auth() {
  return getAuth(adminApp());
}

export { FieldPath };
