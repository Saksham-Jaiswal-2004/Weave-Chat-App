'use client';

import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';

/**
 * Browser-side Firebase. This app only ever uses Firebase **Auth** on the client —
 * Firestore is reached exclusively through our own API routes, so there is no
 * Firestore SDK (and no `onSnapshot` listener) anywhere in the bundle.
 */

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export const firebaseConfigured = Boolean(config.apiKey && config.authDomain && config.projectId);

let app: FirebaseApp | null = null;

export function firebaseApp(): FirebaseApp {
  if (!firebaseConfigured) {
    throw new Error(
      'Firebase is not configured. Copy .env.example to .env.local and fill in the NEXT_PUBLIC_FIREBASE_* values.'
    );
  }
  if (!app) app = getApps().length ? getApp() : initializeApp(config);
  return app;
}

export function firebaseAuth(): Auth {
  return getAuth(firebaseApp());
}

/** Fresh ID token for the current user, or null when signed out. */
export async function currentIdToken(forceRefresh = false): Promise<string | null> {
  if (!firebaseConfigured) return null;
  const user = firebaseAuth().currentUser;
  if (!user) return null;
  return user.getIdToken(forceRefresh);
}

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  'auth/invalid-email': 'That email address does not look right.',
  'auth/invalid-credential': 'Wrong email or password.',
  'auth/user-not-found': 'Wrong email or password.',
  'auth/wrong-password': 'Wrong email or password.',
  'auth/missing-password': 'Enter your password.',
  'auth/email-already-in-use': 'That email is already registered. Try signing in.',
  'auth/weak-password': 'Passwords need to be at least 6 characters.',
  'auth/user-disabled': 'This account has been disabled.',
  'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
  'auth/popup-closed-by-user': 'The sign-in window was closed.',
  'auth/popup-blocked': 'Your browser blocked the sign-in popup.',
  'auth/network-request-failed': 'Network error — check your connection.',
  'auth/invalid-api-key': 'The Firebase API key in .env.local is not valid.',

  // Setup faults. These are the developer's problem, not the user's, so they say
  // exactly which console switch is still off.
  'auth/configuration-not-found':
    'Firebase Authentication is not set up for this project yet. In the Firebase console open Authentication, click "Get started", then enable the Email/Password provider.',
  'auth/operation-not-allowed':
    'That sign-in method is not enabled. Turn it on under Authentication → Sign-in method in the Firebase console.',
  'auth/admin-restricted-operation':
    'Sign-ups are disabled for this project. Enable the Email/Password provider under Authentication → Sign-in method.',
  'auth/unauthorized-domain':
    'This domain is not authorised for sign-in. Add it under Authentication → Settings → Authorized domains.',
};

export function authErrorMessage(error: unknown): string {
  const code = (error as { code?: string })?.code ?? '';
  const known = AUTH_ERROR_MESSAGES[code];
  if (known) return known;

  // Anything unmapped still surfaces its code — a searchable string beats a dead end.
  console.error('[auth] unhandled error', error);
  return code
    ? `Sign-in failed (${code}). Please try again.`
    : 'Something went wrong. Please try again.';
}
