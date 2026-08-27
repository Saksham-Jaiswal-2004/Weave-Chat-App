import { createPrivateKey } from 'node:crypto';

/**
 * Preflight check for the Firebase setup.
 *
 * Most first-run failures are console steps that were never taken rather than code
 * problems, and the errors they produce ("CONFIGURATION_NOT_FOUND", a bare
 * "NOT_FOUND") say nothing about which switch is off. This says.
 *
 *   npm run doctor
 */

const results = [];

function record(name, ok, fix = '') {
  results.push({ name, ok, fix });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && fix) console.log(`      ${fix.split('\n').join('\n      ')}\n`);
}

/* ---------------------------------------------------------------- env vars */

const CLIENT_VARS = [
  'NEXT_PUBLIC_FIREBASE_API_KEY',
  'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
];
const SERVER_VARS = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];

const missing = [...CLIENT_VARS, ...SERVER_VARS].filter((name) => !process.env[name]);

record(
  'environment variables present',
  missing.length === 0,
  `Missing: ${missing.join(', ')}\nCopy .env.example to .env.local and fill it in.`
);

if (missing.length > 0) process.exit(1);

const webProject = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
const adminProject = process.env.FIREBASE_PROJECT_ID;

record(
  'web config and service account target the same project',
  webProject === adminProject,
  `NEXT_PUBLIC_FIREBASE_PROJECT_ID is "${webProject}" but FIREBASE_PROJECT_ID is "${adminProject}".`
);

/* -------------------------------------------------------------- private key */

const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
let keyOk = false;
try {
  createPrivateKey(privateKey);
  keyOk = true;
} catch {
  /* reported below */
}

record(
  'service-account private key parses',
  keyOk,
  'The key must stay on one line, wrapped in double quotes, with its \\n escapes\n' +
    'intact exactly as they appear in the downloaded service-account JSON.'
);

/* ------------------------------------------------------ Authentication (client) */

const configProbe = await fetch(
  `https://identitytoolkit.googleapis.com/v1/projects?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`
).catch(() => null);

const configBody = configProbe ? await configProbe.json().catch(() => ({})) : {};
const configMessage = configBody?.error?.message ?? '';

record(
  'Firebase Authentication is provisioned',
  configProbe?.ok === true,
  configMessage === 'CONFIGURATION_NOT_FOUND'
    ? 'Firebase console -> Authentication -> Get started, then enable the\n' +
      'Email/Password provider under Sign-in method.'
    : `Identity Toolkit replied: ${configMessage || 'no response'}`
);

// Which providers are switched on is not exposed on this endpoint, so it is not
// asserted here. A disabled provider surfaces at sign-in as
// `auth/operation-not-allowed`, which the login screen explains in place.

/* -------------------------------------------------- Admin SDK + Firestore */

if (keyOk) {
  const { auth, db } = await import('../src/server/firebase-admin.js');

  let adminOk = false;
  let adminDetail = '';
  try {
    await auth().getUserByEmail('preflight-probe@example.invalid');
    adminOk = true;
  } catch (error) {
    // "user-not-found" is a successful round trip: the credential was accepted.
    adminOk = error.code === 'auth/user-not-found';
    adminDetail = `${error.code ?? ''} ${error.message ?? ''}`.trim();
  }

  record(
    'service account is accepted by Firebase',
    adminOk,
    `Admin SDK replied: ${adminDetail}\nCheck that the service-account JSON belongs to project "${adminProject}".`
  );

  let firestoreOk = false;
  let firestoreDetail = '';
  try {
    await db().collection('users').limit(1).get();
    firestoreOk = true;
  } catch (error) {
    firestoreDetail = `${error.code ?? ''} ${error.message ?? ''}`.trim();
  }

  record(
    'Firestore database exists and is reachable',
    firestoreOk,
    firestoreDetail.startsWith('5')
      ? 'No Firestore database in this project yet.\n' +
        'Firebase console -> Firestore Database -> Create database -> production mode.'
      : `Firestore replied: ${firestoreDetail}`
  );
}

/* --------------------------------------------------------------- summary */

const failed = results.filter((result) => !result.ok);
console.log(
  failed.length === 0
    ? '\nAll checks passed — you are ready to run npm run dev.'
    : `\n${failed.length} check(s) need attention before the app will work.`
);

process.exit(failed.length === 0 ? 0 : 1);
