import { json, withAuth } from '@/server/http.js';
import * as repo from '@/server/repo.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Prefix search over display name / email, used by the new-chat pickers. */
export const GET = withAuth(async ({ uid, searchParams }) => {
  const term = searchParams.get('q') ?? '';
  const users = await repo.searchUsers(term, { excludeUid: uid, limit: 12 });
  return json({ users });
});
