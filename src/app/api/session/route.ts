import { json, withAuth } from '@/server/http.js';
import * as repo from '@/server/repo.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Called right after Firebase Auth resolves. Mirrors the auth record into the
 * `users` collection so other people can find this account in search.
 */
export const POST = withAuth(async ({ user, uid, body }) => {
  const payload = await body();

  const profile = await repo.upsertUser({
    uid,
    email: user.email ?? payload.email ?? null,
    displayName: payload.displayName ?? user.name ?? null,
    photoURL: payload.photoURL ?? user.picture ?? null,
  });

  return json({ user: profile });
});
