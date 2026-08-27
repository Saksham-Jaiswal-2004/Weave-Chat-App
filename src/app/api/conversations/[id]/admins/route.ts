import * as hub from '@/server/hub.js';
import { json, withAuth } from '@/server/http.js';
import * as repo from '@/server/repo.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Promote or demote a group member: `{ userId, admin }`. Admins only. */
export const POST = withAuth(async ({ uid, params, body }) => {
  const conversationId = params.id;
  const payload = await body();

  const userId = typeof payload.userId === 'string' ? payload.userId : '';
  if (!userId) return json({ error: 'A userId is required.' }, 400);
  if (typeof payload.admin !== 'boolean') return json({ error: 'An admin flag is required.' }, 400);

  const conversation = await repo.setAdmin(conversationId, uid, userId, payload.admin);
  const users = await repo.getUsers(conversation.memberIds);

  hub.broadcastToUsers(conversation.memberIds, {
    type: 'conversation:upsert',
    conversation,
    members: users,
  });

  return json({ conversation, users });
});
