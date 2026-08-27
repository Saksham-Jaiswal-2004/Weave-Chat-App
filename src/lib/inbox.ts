'use client';

import { api } from './api';
import { useChatStore } from '@/store/chat';

/**
 * Loads the conversation list into the store.
 *
 * Shared by the initial mount, the sidebar's retry button and the socket's
 * post-reconnect catch-up so all three report failure the same way instead of one
 * of them swallowing it.
 */
export async function loadInbox(): Promise<boolean> {
  useChatStore.getState().setConversationsStatus('loading');

  try {
    const inbox = await api.listConversations();
    useChatStore.getState().setConversations(inbox);
    return true;
  } catch (error) {
    useChatStore.getState().setConversationsStatus('error', (error as Error).message);
    return false;
  }
}
