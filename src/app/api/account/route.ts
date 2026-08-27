import { auth } from '@/server/firebase-admin.js';
import * as hub from '@/server/hub.js';
import { json, withAuth } from '@/server/http.js';
import * as repo from '@/server/repo.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Irreversible account deletion: threads, then the profile, then the Firebase Auth
 * record — in that order, on purpose. Deleting the auth record first and failing
 * later would leave a profile and a pile of conversations belonging to a uid that
 * can never sign in to clean them up.
 */
export const DELETE = withAuth(async ({ uid }) => {
  const { conversations, removedFrom, notify } = await repo.deleteAccount(uid);
  const survived = new Set(removedFrom);

  for (const conversationId of conversations) {
    // A thread that did not survive is gone for its other side too. DM ids are
    // derived from the pair, so the partner is identifiable without a second read.
    const partners = survived.has(conversationId)
      ? []
      : notify.filter((other) => repo.directConversationId(uid, other) === conversationId);

    if (!survived.has(conversationId)) hub.invalidateMembers(conversationId);
    hub.broadcastToUsers([uid, ...partners], { type: 'conversation:removed', conversationId });
  }

  // Groups that outlived the departure need a fresh roster, not a removal.
  await Promise.all(
    removedFrom.map(async (conversationId) => {
      const conversation = await repo.getConversation(conversationId);
      if (!conversation) return;

      hub.cacheMembers(conversationId, conversation.memberIds);
      hub.broadcastToUsers(conversation.memberIds, {
        type: 'conversation:upsert',
        conversation,
        members: await repo.getUsers(conversation.memberIds),
      });
    })
  );

  // Last. Everything above is retryable while the account can still authenticate.
  await auth().deleteUser(uid);

  return json({ ok: true });
});
