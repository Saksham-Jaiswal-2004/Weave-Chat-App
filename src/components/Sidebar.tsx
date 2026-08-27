'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { signOut } from 'firebase/auth';
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { Avatar } from '@/components/Avatar';
import { BellOffIcon, GroupIcon, LogoutIcon, PlusIcon, SearchIcon, SettingsIcon, WeaveMark } from '@/components/Icons';
import { NewConversationDialog } from '@/components/NewConversationDialog';
import { SettingsPanel } from '@/components/SettingsPanel';
import { firebaseAuth } from '@/lib/firebase';
import { loadInbox } from '@/lib/inbox';
import { registerShortcuts } from '@/lib/shortcuts';
import {
  cn,
  conversationSeed,
  conversationTitle,
  formatRelative,
  isMuted,
  otherMemberId,
  unreadFor,
  unreadMentionsFor,
} from '@/lib/utils';
import { useAuthStore } from '@/store/auth';
import { useChatStore } from '@/store/chat';
import type { Conversation } from '@/types';

/** One focus treatment for the whole sidebar; the dark theme swallows the UA default. */
const focusRing = 'focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none';
/** Icon buttons need 44px of touch even though the glyph inside is 18px. */
const iconButton = `flex h-11 w-11 shrink-0 items-center justify-center rounded-lg transition-colors ${focusRing}`;

export function Sidebar({ activeConversationId }: { activeConversationId: string | null }) {
  const user = useAuthStore((state) => state.user);
  const conversations = useChatStore((state) => state.conversations);
  const status = useChatStore((state) => state.conversationsStatus);
  const users = useChatStore((state) => state.users);

  const [filter, setFilter] = useState('');
  const [dialogMode, setDialogMode] = useState<'dm' | 'group' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const router = useRouter();

  // The sidebar owns both the conversation order and the new-chat dialog, so the
  // navigation shortcuts live here rather than in the shell.
  useEffect(() => {
    const step = (delta: number) => {
      if (conversations.length === 0) return;
      const current = conversations.findIndex((item) => item.id === activeConversationId);
      const next = current < 0 ? 0 : (current + delta + conversations.length) % conversations.length;
      router.push(`/chat/${conversations[next].id}`);
    };

    return registerShortcuts({
      onNewChat: () => setDialogMode('dm'),
      onNextChat: () => step(1),
      onPrevChat: () => step(-1),
    });
  }, [conversations, activeConversationId, router]);

  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term || !user) return conversations;
    return conversations.filter((conversation) =>
      conversationTitle(conversation, user.uid, users).toLowerCase().includes(term)
    );
  }, [conversations, filter, users, user]);

  if (!user) return null;

  return (
    <>
      <aside
        aria-label="Conversations"
        className="flex h-full w-full flex-col border-r border-ink-800 bg-ink-900 md:w-80 lg:w-88"
      >
        {/* py trimmed to absorb the taller 44px touch targets without moving the list. */}
        <header className="flex items-center gap-1.5 px-3 py-2">
          <span
            aria-hidden
            className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-weave-500 text-white"
          >
            <WeaveMark className="h-5 w-5" />
          </span>
          <h1 className="ml-1 min-w-0 flex-1 truncate text-base font-semibold tracking-tight">
            Weave
          </h1>

          <button
            type="button"
            onClick={() => setDialogMode('group')}
            title="New group"
            aria-label="New group"
            className={cn(iconButton, 'text-mist-400 hover:bg-ink-800 hover:text-mist-50')}
          >
            <GroupIcon aria-hidden className="h-[18px] w-[18px]" />
          </button>
          <button
            type="button"
            onClick={() => setDialogMode('dm')}
            title="New chat"
            aria-label="New chat"
            className={cn(iconButton, 'bg-ink-800 text-mist-200 hover:bg-ink-750 hover:text-mist-50')}
          >
            <PlusIcon aria-hidden className="h-[18px] w-[18px]" />
          </button>
        </header>

        <div className="px-3 pb-2">
          <div className="relative">
            <SearchIcon
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-mist-500"
            />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Search conversations"
              aria-label="Search conversations"
              className={cn(
                'min-h-11 w-full rounded-xl bg-ink-850 py-2 pr-3 pl-9 text-sm text-mist-50 placeholder:text-mist-500',
                focusRing
              )}
            />
          </div>
        </div>

        <nav aria-label="Conversation list" className="scroll-slim flex-1 overflow-y-auto px-2 pb-2">
          {status === 'loading' && conversations.length === 0 && (
            <>
              {/* The skeletons are aria-hidden, so without this the load was silent. */}
              <p role="status" className="sr-only">
                Loading your conversations…
              </p>
              <RowSkeletons />
            </>
          )}

          {status === 'error' && conversations.length === 0 && <InboxError />}

          {status === 'ready' && conversations.length === 0 && (
            <EmptyInbox onStart={() => setDialogMode('dm')} />
          )}

          {visible.length === 0 && conversations.length > 0 && (
            <div role="status" className="px-3 py-6 text-center">
              <p className="text-sm text-mist-400">No conversations match “{filter.trim()}”.</p>
              <p className="mt-1 text-xs text-mist-500">
                Search matches names only, not message text.
              </p>
              <button
                type="button"
                onClick={() => setFilter('')}
                className={cn(
                  'mt-3 min-h-11 rounded-lg bg-ink-800 px-3.5 text-xs font-semibold text-mist-200 transition-colors hover:bg-ink-750 hover:text-mist-50',
                  focusRing
                )}
              >
                Clear search
              </button>
            </div>
          )}

          <ul className="space-y-0.5">
            {visible.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                viewerUid={user.uid}
                active={conversation.id === activeConversationId}
              />
            ))}
          </ul>
        </nav>

        <footer className="flex items-center gap-3 border-t border-ink-800 px-3 py-2">
          <Avatar
            name={user.displayName}
            seed={user.uid}
            photoURL={user.photoURL}
            color={user.avatarColor}
            size="sm"
            ringClass="border-ink-900"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user.displayName}</p>
            <p className="truncate text-xs text-mist-500">{user.email}</p>
          </div>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Profile and account settings"
            className={cn(iconButton, 'text-mist-400 hover:bg-ink-800 hover:text-mist-50')}
          >
            <SettingsIcon aria-hidden className="h-[18px] w-[18px]" />
          </button>
          <button
            type="button"
            onClick={() => void signOut(firebaseAuth())}
            title="Sign out"
            aria-label="Sign out"
            className={cn(iconButton, 'text-mist-400 hover:bg-ink-800 hover:text-signal-danger')}
          >
            <LogoutIcon aria-hidden className="h-[18px] w-[18px]" />
          </button>
        </footer>
      </aside>

      {dialogMode && (
        <NewConversationDialog mode={dialogMode} onClose={() => setDialogMode(null)} />
      )}

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </>
  );
}

function ConversationRow({
  conversation,
  viewerUid,
  active,
}: {
  conversation: Conversation;
  viewerUid: string;
  active: boolean;
}) {
  const users = useChatStore((state) => state.users);

  // Counters are server-owned and ride along on the conversation, so they survive a
  // reload and stay consistent across devices.
  const unread = unreadFor(conversation, viewerUid);
  const mentions = unreadMentionsFor(conversation, viewerUid);
  const muted = isMuted(conversation, viewerUid);

  // A shallow-compared array keeps this row from re-rendering on unrelated typing.
  const typingIds = useChatStore(
    useShallow((state) => Object.keys(state.typing[conversation.id] ?? {}))
  );

  const isGroup = conversation.type === 'group';
  const otherId = otherMemberId(conversation, viewerUid);
  const online = useChatStore((state) => (isGroup ? false : Boolean(state.online[otherId])));

  const title = conversationTitle(conversation, viewerUid, users);
  const last = conversation.lastMessage;

  const someoneTyping = typingIds.filter((uid) => uid !== viewerUid);
  const preview = someoneTyping.length
    ? isGroup
      ? `${users[someoneTyping[0]]?.displayName ?? 'Someone'} is typing…`
      : 'typing…'
    : last
      ? `${last.senderId === viewerUid ? 'You: ' : isGroup ? `${users[last.senderId]?.displayName ?? 'Someone'}: ` : ''}${last.text}`
      : 'No messages yet';

  return (
    <li>
      <Link
        href={`/chat/${conversation.id}`}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex items-center gap-3 rounded-xl px-2.5 py-2.5 transition-colors',
          active ? 'bg-ink-750' : 'hover:bg-ink-850',
          focusRing
        )}
      >
        <Avatar
          name={title}
          seed={conversationSeed(conversation, viewerUid)}
          photoURL={isGroup ? null : users[otherId]?.photoURL}
          // Groups keep their conversation-seeded tint; only people carry a chosen colour.
          color={isGroup ? null : users[otherId]?.avatarColor}
          online={isGroup ? undefined : online}
          ringClass={active ? 'border-ink-750' : 'border-ink-900'}
        />

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cn('flex-1 truncate text-sm', unread ? 'font-semibold' : 'font-medium')}>
              {title}
            </span>
            {muted && <BellOffIcon className="h-3.5 w-3.5 shrink-0 text-mist-500" aria-label="Muted" role="img" />}
            {last && (
              <span className="shrink-0 text-[11px] text-mist-500">
                {formatRelative(last.createdAt)}
              </span>
            )}
          </span>

          <span className="mt-0.5 flex items-center gap-2">
            <span
              className={cn(
                'flex-1 truncate text-xs',
                someoneTyping.length
                  ? 'text-weave-400'
                  : unread
                    ? 'text-mist-200'
                    : 'text-mist-500'
              )}
            >
              {preview}
            </span>
            {/* A mention outranks a plain unread count — and shows even when muted. */}
            {mentions > 0 && (
              <span
                role="img"
                title={`${mentions} mention${mentions === 1 ? '' : 's'}`}
                aria-label={`${mentions} unread mention${mentions === 1 ? '' : 's'}`}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-weave-500 text-[11px] font-bold text-white"
              >
                @
              </span>
            )}
            {unread > 0 && (
              // role=img + label: a bare "3" told a screen-reader user nothing.
              <span
                role="img"
                aria-label={`${unread} unread message${unread === 1 ? '' : 's'}`}
                className={cn(
                  'min-w-5 shrink-0 rounded-full px-1.5 text-center text-[11px] leading-5 font-semibold',
                  muted ? 'bg-ink-700 text-mist-200' : 'bg-weave-500 text-white'
                )}
              >
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </span>
        </span>
      </Link>
    </li>
  );
}

function RowSkeletons() {
  return (
    <ul className="space-y-0.5" aria-hidden>
      {Array.from({ length: 6 }).map((_, index) => (
        <li key={index} className="flex items-center gap-3 px-2.5 py-2.5">
          <span className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-ink-800" />
          <span className="min-w-0 flex-1 space-y-2">
            <span className="block h-3 w-1/2 animate-pulse rounded bg-ink-800" />
            <span className="block h-2.5 w-3/4 animate-pulse rounded bg-ink-850" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A failed inbox load used to render as an empty sidebar, which is
 * indistinguishable from having no chats. Show what actually went wrong.
 */
function InboxError() {
  const message = useChatStore((state) => state.conversationsError);
  const [retrying, setRetrying] = useState(false);

  return (
    <div
      role="alert"
      className="mx-1 mt-2 rounded-xl border border-signal-danger/30 bg-signal-danger/10 px-4 py-4 text-center"
    >
      <p className="text-sm font-medium text-red-200">Could not load your chats</p>
      <p className="mt-1.5 text-xs leading-relaxed text-red-200/80">
        {message ?? 'The server did not respond.'} Check your connection, then try again.
      </p>
      <button
        type="button"
        disabled={retrying}
        onClick={async () => {
          setRetrying(true);
          await loadInbox();
          setRetrying(false);
        }}
        className={cn(
          'mt-3 min-h-11 rounded-lg bg-ink-750 px-3.5 text-xs font-semibold text-mist-50 transition-colors hover:bg-ink-700 disabled:opacity-60',
          focusRing
        )}
      >
        {retrying ? 'Retrying…' : 'Try again'}
      </button>
    </div>
  );
}

function EmptyInbox({ onStart }: { onStart: () => void }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-sm font-medium text-mist-200">No conversations yet</p>
      <p className="mt-1 text-xs leading-relaxed text-mist-500">
        Find someone by name or email to message them directly — or use the group button at the top
        of this list to gather several people at once.
      </p>
      <button
        type="button"
        onClick={onStart}
        className={cn(
          'mt-4 min-h-11 rounded-lg bg-weave-500 px-3.5 text-xs font-semibold text-white transition-colors hover:bg-weave-600',
          focusRing
        )}
      >
        Start a chat
      </button>
    </div>
  );
}
