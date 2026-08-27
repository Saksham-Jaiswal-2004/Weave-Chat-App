import * as hub from '@/server/hub.js';
import { json, withAuth } from '@/server/http.js';
import * as repo from '@/server/repo.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Add people to a group. */
export const POST = withAuth(async ({ uid, params, body }) => {
  const conversationId = params.id;
  const payload = await body();
  const memberIds = Array.isArray(payload.memberIds) ? payload.memberIds : [];

  const { conversation, added } = await repo.addGroupMembers(conversationId, uid, memberIds);
  hub.cacheMembers(conversationId, conversation.memberIds);

  if (added.length > 0) {
    const members = await repo.getUsers(conversation.memberIds);
    // Existing members get an updated roster; new members get the whole thread.
    hub.broadcastToUsers(conversation.memberIds, {
      type: 'conversation:upsert',
      conversation,
      members,
    });
    return json({ conversation, users: members, added });
  }

  return json({ conversation, users: await repo.getUsers(conversation.memberIds), added });
});

/**
 * No `?userId=` means "I am leaving"; with one, an admin is removing somebody
 * else. Either way the departing member's socket is told the thread is gone.
 */
export const DELETE = withAuth(async ({ uid, params, searchParams }) => {
  const conversationId = params.id;
  const targetUid = searchParams.get('userId') ?? '';

  if (targetUid && targetUid !== uid) {
    const { conversation, remaining, removed } = await repo.removeMember(
      conversationId,
      uid,
      targetUid
    );

    hub.cacheMembers(conversationId, remaining);
    hub.broadcastToUsers([removed], { type: 'conversation:removed', conversationId });
    hub.broadcastToUsers(remaining, {
      type: 'conversation:upsert',
      conversation,
      members: await repo.getUsers(remaining),
    });

    return json({ ok: true, removed, conversation });
  }

  const { conversation, remaining, deleted } = await repo.leaveConversation(conversationId, uid);

  hub.invalidateMembers(conversationId);
  hub.broadcastToUsers([uid], { type: 'conversation:removed', conversationId });

  if (!deleted) {
    hub.cacheMembers(conversationId, remaining);
    hub.broadcastToUsers(remaining, {
      type: 'conversation:upsert',
      conversation,
      members: await repo.getUsers(remaining),
    });
  }

  return json({ ok: true, deleted });
});
