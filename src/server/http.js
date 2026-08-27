import { auth } from './firebase-admin.js';
import { HttpError } from './repo.js';

/**
 * Shared plumbing for the route handlers: bearer-token auth, JSON replies and a
 * single place where thrown `HttpError`s become status codes.
 */

/**
 * Every response here is per-user, mutable state. Without an explicit directive a
 * browser is free to reuse one heuristically, which shows up as reactions vanishing
 * and deleted messages returning after a reload — a stale copy from before the edit.
 */
export function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store, max-age=0' },
  });
}

async function verifyBearer(request) {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'You are not signed in.');

  try {
    return await auth().verifyIdToken(token);
  } catch (error) {
    // A missing service account is a server fault, not a bad token — let it through
    // to the handler below so it is reported as a 500 rather than a confusing 401.
    if (String(error?.message ?? '').startsWith('[weave]')) throw error;

    const expired = String(error?.code ?? '').includes('id-token-expired');
    throw new HttpError(401, expired ? 'Your session expired.' : 'Invalid session.');
  }
}

/**
 * gRPC status 5 (NOT_FOUND) from Firestore means the *database* is missing, not the
 * document — the single most confusing first-run failure. 7 is PERMISSION_DENIED.
 * @returns {string | null} a human explanation, or null if this is not that error
 */
function firestoreSetupMessage(error) {
  const code = error?.code;
  if (code === 5) {
    return (
      'No Firestore database exists in this Firebase project yet. ' +
      'Create one in the Firebase console under Firestore Database, then restart the server.'
    );
  }
  if (code === 7) {
    return (
      'Firestore denied the service account. Check that the service-account key ' +
      'belongs to this project and still has access.'
    );
  }
  return null;
}

async function readJson(request) {
  try {
    return (await request.json()) ?? {};
  } catch {
    throw new HttpError(400, 'Expected a JSON body.');
  }
}

/**
 * Wraps a route handler so it receives a verified user.
 *
 * @param {(ctx: {
 *   request: Request;
 *   user: import('firebase-admin/auth').DecodedIdToken;
 *   uid: string;
 *   params: Record<string, string>;
 *   body: () => Promise<any>;
 *   searchParams: URLSearchParams;
 * }) => Promise<Response>} handler
 */
export function withAuth(handler) {
  return async (request, context = {}) => {
    try {
      const user = await verifyBearer(request);
      // Next 15+ hands route params over as a promise.
      const params = (await context.params) ?? {};

      return await handler({
        request,
        user,
        uid: user.uid,
        params,
        body: () => readJson(request),
        searchParams: new URL(request.url).searchParams,
      });
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);

      // A missing service account surfaces here on the very first request — make it
      // obvious rather than burying it in a generic 500.
      if (String(error?.message ?? '').startsWith('[weave]')) {
        console.error(error.message);
        return json({ error: 'Server is not configured. Check the Firebase env vars.' }, 500);
      }

      // Firestore reports setup problems as bare gRPC status codes, which say
      // nothing on their own. Translate the two that actually mean "you skipped a
      // step in the console".
      const setupFault = firestoreSetupMessage(error);
      if (setupFault) {
        console.error(`[api] ${setupFault}`);
        return json({ error: setupFault }, 503);
      }

      console.error('[api] unhandled error', error);
      return json({ error: 'Something went wrong.' }, 500);
    }
  };
}
