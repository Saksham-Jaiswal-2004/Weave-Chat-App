'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ChatHeader } from '@/components/ChatHeader';
import { Composer } from '@/components/Composer';
import { MessageList, type MessageListHandle } from '@/components/MessageList';
import { MessageSearch } from '@/components/MessageSearch';
import { ShortcutsDialog } from '@/components/ShortcutsDialog';
import { TypingIndicator } from '@/components/TypingIndicator';
import { api } from '@/lib/api';
import { registerShortcuts } from '@/lib/shortcuts';
import { socket } from '@/lib/socket-client';
import { conversationTitle } from '@/lib/utils';
import { useAuthStore } from '@/store/auth';
import { useChatStore } from '@/store/chat';
import type { Message, ReplySnapshot } from '@/types';

/**
 * One open conversation. Owns the backlog fetch, the reply draft and the read
 * bookkeeping; everything live arrives through the socket and lands in the store.
 */
export function ChatPane({ conversationId }: { conversationId: string }) {
  const viewerUid = useAuthStore((state) => state.user?.uid);
  const conversation = useChatStore((state) =>
    state.conversations.find((item) => item.id === conversationId)
  );
  const users = useChatStore((state) => state.users);

  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<ReplySnapshot | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const listRef = useRef<MessageListHandle>(null);

  /** The newest message in view — what a read receipt is reported against. */
  const newestAt = useChatStore(
    (state) => state.messages[conversationId]?.at(-1)?.createdAt ?? 0
  );

  // Opening a thread makes it active and freezes the "new messages" divider at
  // wherever the viewer had previously read up to.
  useEffect(() => {
    if (!viewerUid) return;

    const chat = useChatStore.getState();
    chat.setActiveConversation(conversationId);
    chat.captureReadMarker(conversationId, viewerUid);

    return () => {
      if (useChatStore.getState().activeConversationId === conversationId) {
        useChatStore.getState().setActiveConversation(null);
      }
    };
  }, [conversationId, viewerUid]);

  // Reading is reported to the server, which owns the counters and drives
  // everyone else's ticks. Only count it as read while the tab is actually visible.
  useEffect(() => {
    if (!newestAt) return;

    const report = () => {
      if (!document.hidden) socket.markRead(conversationId, newestAt);
    };

    report();
    document.addEventListener('visibilitychange', report);
    return () => document.removeEventListener('visibilitychange', report);
  }, [conversationId, newestAt]);

  useEffect(
    () =>
      registerShortcuts({
        onSearch: () => setSearchOpen(true),
        onHelp: () => setShortcutsOpen(true),
        onEscape: () => {
          setSearchOpen(false);
          setShortcutsOpen(false);
        },
      }),
    []
  );

  // A search panel left open across threads would be searching the wrong messages.
  useEffect(() => setSearchOpen(false), [conversationId]);

  // Drop a stale reply draft when switching threads.
  useEffect(() => setReplyTo(null), [conversationId]);

  useEffect(() => {
    if (!viewerUid) return;

    const chat = useChatStore.getState();
    if (chat.threads[conversationId]?.status === 'ready') return;

    let cancelled = false;
    setError(null);
    chat.setThreadStatus(conversationId, { status: 'loading' });

    api
      .listMessages(conversationId)
      .then((payload) => {
        if (cancelled) return;
        const store = useChatStore.getState();
        store.upsertConversation(payload.conversation);
        store.setMessages(conversationId, payload.messages, payload.hasMore);
        store.captureReadMarker(conversationId, viewerUid);
      })
      .catch((cause: Error) => {
        if (cancelled) return;
        useChatStore.getState().setThreadStatus(conversationId, { status: 'error' });
        setError(cause.message);
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId, viewerUid]);

  const handleReply = useCallback((message: Message) => {
    setReplyTo({ id: message.id, senderId: message.senderId, text: message.text });
  }, []);

  if (!viewerUid) return null;

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm font-medium text-mist-200">{error}</p>
        <Link
          href="/chat"
          className="rounded-lg bg-ink-800 px-3.5 py-2 text-xs font-medium text-mist-200 transition-colors hover:bg-ink-750"
        >
          Back to conversations
        </Link>
      </div>
    );
  }

  if (!conversation) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-mist-500">Opening conversation…</p>
      </div>
    );
  }

  return (
    <section className="flex h-full flex-col bg-ink-850">
      <ChatHeader conversation={conversation} viewerUid={viewerUid} />

      {searchOpen && (
        <MessageSearch
          conversation={conversation}
          viewerUid={viewerUid}
          onJumpTo={(messageId) => listRef.current?.jumpTo(messageId)}
          onClose={() => setSearchOpen(false)}
        />
      )}

      <MessageList
        ref={listRef}
        conversation={conversation}
        viewerUid={viewerUid}
        onReply={handleReply}
      />
      <TypingIndicator conversationId={conversationId} viewerUid={viewerUid} />
      <Composer
        conversation={conversation}
        viewerUid={viewerUid}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        placeholder={`Message ${conversationTitle(conversation, viewerUid, users)}`}
      />

      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
    </section>
  );
}
