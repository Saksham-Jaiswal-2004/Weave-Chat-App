import * as hub from '@/server/hub.js';
import { json, withAuth } from '@/server/http.js';
import * as repo from '@/server/repo.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Message history. Live messages arrive over the websocket — this endpoint only
 * serves the backlog, including older pages via `?before=<createdAt>`.
 *
 * Sending is deliberately *not* exposed over HTTP: writes go through the socket
 * so ordering and fan-out have a single owner.
 */
export const GET = withAuth(async ({ uid, params, searchParams }) => {
  const conversationId = params.id;

  const conversation = await repo.getConversation(conversationId);
  if (!conversation) return json({ error: 'Conversation not found.' }, 404);
  if (!conversation.memberIds.includes(uid)) {
    return json({ error: 'You are not a member of this conversation.' }, 403);
  }

  // Opening a thread warms the membership cache the socket layer reads from.
  hub.cacheMembers(conversationId, conversation.memberIds);

  const before = searchParams.get('before');
  const { messages, hasMore } = await repo.listMessages(conversationId, {
    limit: Number(searchParams.get('limit')) || repo.MESSAGE_PAGE_SIZE,
    before: before ? Number(before) : undefined,
  });

  return json({ conversation, messages, hasMore });
});
