import * as hub from '@/server/hub.js';
import { json, withAuth } from '@/server/http.js';
import * as repo from '@/server/repo.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Thread settings: `{ name }` renames a group (admins only) and `{ muted }` sets
 * the caller's own notification preference. Both may arrive together.
 */
export const PATCH = withAuth(async ({ uid, params, body }) => {
  const conversationId = params.id;
  const payload = await body();
  const wantsRename = typeof payload.name === 'string';

  let conversation = null;
  if (wantsRename) conversation = await repo.renameConversation(conversationId, uid, payload.name);
  if (typeof payload.muted === 'boolean') {
    conversation = await repo.setMuted(conversationId, uid, payload.muted);
  }
  if (!conversation) return json({ error: 'Nothing to update.' }, 400);

  const users = await repo.getUsers(conversation.memberIds);

  // A rename is everyone's business; a mute is nobody's but the caller's — the
  // narrow fan-out still reaches their other tabs.
  hub.broadcastToUsers(wantsRename ? conversation.memberIds : [uid], {
    type: 'conversation:upsert',
    conversation,
    members: users,
  });

  return json({ conversation, users });
});
