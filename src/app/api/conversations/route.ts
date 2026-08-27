import * as hub from '@/server/hub.js';
import { json, withAuth } from '@/server/http.js';
import * as repo from '@/server/repo.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The inbox. Member profiles ride along so the sidebar can render names and
 * avatars without a follow-up request per thread.
 */
export const GET = withAuth(async ({ uid }) => {
  const conversations = await repo.listConversationsForUser(uid);
  const memberIds = conversations.flatMap((conversation) => conversation.memberIds);
  const users = await repo.getUsers(memberIds);

  return json({ conversations, users, onlineUserIds: hub.onlineUserIds() });
});

/**
 * Creates a DM (`{ type: 'dm', userId }`) or a group
 * (`{ type: 'group', name, memberIds }`), then pushes the new thread down every
 * member's open socket so it appears in their sidebar immediately.
 */
export const POST = withAuth(async ({ uid, body }) => {
  const payload = await body();

  let conversation;
  let isNew = true;

  if (payload.type === 'group') {
    conversation = await repo.createGroupConversation({
      name: payload.name,
      creatorUid: uid,
      memberIds: Array.isArray(payload.memberIds) ? payload.memberIds : [],
    });
  } else {
    const otherId = typeof payload.userId === 'string' ? payload.userId : '';
    if (!otherId) return json({ error: 'A userId is required to start a chat.' }, 400);

    const result = await repo.createDirectConversation(uid, otherId);
    conversation = result.conversation;
    isNew = result.created;
  }

  const members = await repo.getUsers(conversation.memberIds);
  hub.cacheMembers(conversation.id, conversation.memberIds);

  if (isNew) {
    hub.broadcastToUsers(conversation.memberIds, {
      type: 'conversation:upsert',
      conversation,
      members,
    });
  }

  return json({ conversation, users: members, created: isNew }, isNew ? 201 : 200);
});
