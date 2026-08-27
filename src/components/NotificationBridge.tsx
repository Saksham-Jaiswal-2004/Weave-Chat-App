'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { onNotificationClick, updateTitleBadge } from '@/lib/notifications';
import { useAuthStore } from '@/store/auth';
import { useChatStore, selectTotalUnread } from '@/store/chat';

/**
 * Connects the notification layer to the router and the tab title. Rendered once
 * inside the chat shell; it draws nothing.
 */
export function NotificationBridge() {
  const router = useRouter();
  const viewerUid = useAuthStore((state) => state.user?.uid);

  useEffect(() => onNotificationClick((conversationId) => router.push(`/chat/${conversationId}`)), [
    router,
  ]);

  // Subscribed rather than rendered, so the badge tracks every unread change
  // without re-rendering the shell on each frame.
  useEffect(() => {
    if (!viewerUid) return;

    const total = selectTotalUnread(viewerUid);
    updateTitleBadge(total(useChatStore.getState()));

    return useChatStore.subscribe((state) => updateTitleBadge(total(state)));
  }, [viewerUid]);

  useEffect(() => () => updateTitleBadge(0), []);

  return null;
}
