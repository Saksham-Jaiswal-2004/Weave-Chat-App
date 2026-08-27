import * as hub from '@/server/hub.js';
import { json, withAuth } from '@/server/http.js';
import * as repo from '@/server/repo.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Settings screen: `{ displayName?, avatarColor? }`. Either may arrive alone, and
 * `avatarColor: null` is a real value meaning "go back to the automatic tint" —
 * hence the `!== undefined` checks rather than truthiness.
 */
export const PATCH = withAuth(async ({ uid, body }) => {
  const payload = await body();

  const patch: { displayName?: string; avatarColor?: string | null } = {};
  if (payload.displayName !== undefined) patch.displayName = payload.displayName;
  if (payload.avatarColor !== undefined) patch.avatarColor = payload.avatarColor;

  const user = await repo.updateUserProfile(uid, patch);

  // Every other client renders this person's name and colour from the member list
  // cached against each conversation, so without a push the old name sits there
  // until a reload. One `conversation:upsert` per shared thread carries the fresh
  // roster to exactly the people entitled to see it — and to the caller's own
  // other tabs, which are in `memberIds` too.
  const conversations = await repo.listConversationsForUser(uid);
  await Promise.all(
    conversations.map(async (conversation) => {
      hub.broadcastToUsers(conversation.memberIds, {
        type: 'conversation:upsert',
        conversation,
        members: await repo.getUsers(conversation.memberIds),
      });
    })
  );

  return json({ user });
});
