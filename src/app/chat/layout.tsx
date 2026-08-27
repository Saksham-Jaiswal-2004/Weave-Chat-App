'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { ConnectionBanner } from '@/components/ConnectionBanner';
import { NotificationBridge } from '@/components/NotificationBridge';
import { NotificationPrompt } from '@/components/NotificationPrompt';
import { Sidebar } from '@/components/Sidebar';
import { Spinner } from '@/components/Spinner';
import { loadInbox } from '@/lib/inbox';
import { socket } from '@/lib/socket-client';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth';

/**
 * Chat shell: auth guard, one-time inbox fetch, and the two-pane layout.
 *
 * On small screens the panes swap rather than stack — the list is the "page"
 * until a conversation is open, which is what WhatsApp does on mobile.
 */
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const params = useParams<{ conversationId?: string }>();
  const status = useAuthStore((state) => state.status);
  const uid = useAuthStore((state) => state.user?.uid);

  const activeConversationId = params?.conversationId ?? null;

  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login');
  }, [status, router]);

  useEffect(() => {
    if (!uid) return;
    // Acknowledging here covers the case where the inbox lands after the socket has
    // already authenticated; the socket handles the other ordering itself.
    void loadInbox().then(() => socket.acknowledgeDelivery());
  }, [uid]);

  if (status !== 'authenticated') {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-ink-950">
        {/* "Signing you in" would be a lie once the guard above has given up on us. */}
        <Spinner
          label={status === 'unauthenticated' ? 'Taking you to sign in' : 'Signing you in'}
        />
      </main>
    );
  }

  return (
    // overflow-hidden pins the document: the message list and the conversation
    // list are the only things allowed to scroll, so the composer stays put.
    <div className="flex h-dvh flex-col overflow-hidden bg-ink-950">
      <a
        href="#conversation"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-weave-500 focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-mist-50"
      >
        Skip to conversation
      </a>

      <NotificationBridge />
      <ConnectionBanner />
      <NotificationPrompt />

      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            'h-full w-full md:block md:w-auto md:shrink-0',
            activeConversationId && 'hidden'
          )}
        >
          <Sidebar activeConversationId={activeConversationId} />
        </div>

        <main
          id="conversation"
          tabIndex={-1}
          aria-label="Conversation"
          className={cn(
            'h-full min-w-0 flex-1 bg-ink-850 focus:outline-none',
            !activeConversationId && 'hidden md:block'
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
