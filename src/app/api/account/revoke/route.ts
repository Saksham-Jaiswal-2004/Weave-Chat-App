import { auth } from '@/server/firebase-admin.js';
import { json, withAuth } from '@/server/http.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * "Sign out everywhere". Revoking the refresh tokens means no device can mint a
 * new ID token, so every other session dies at its next refresh.
 *
 * Note what this does *not* do: an ID token already in a browser's hands stays
 * valid until it expires, which is up to an hour away. Firebase verifies ID tokens
 * offline against the signing keys — there is no revocation list to consult — so a
 * device that already holds one keeps working until it asks for the next. That is
 * how the platform works, not a bug in this handler, and it applies to the caller
 * too: their own tab carries on until its token runs out.
 */
export const POST = withAuth(async ({ uid }) => {
  await auth().revokeRefreshTokens(uid);
  return json({ ok: true });
});
