'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Avatar } from '@/components/Avatar';
import {
  BackIcon,
  BellIcon,
  BellOffIcon,
  InfoIcon,
  MoreIcon,
  UserPlusIcon,
} from '@/components/Icons';
import { GroupInfoPanel } from '@/components/GroupInfoPanel';
import { NewConversationDialog } from '@/components/NewConversationDialog';
import { api } from '@/lib/api';
import {
  cn,
  conversationSeed,
  conversationTitle,
  isGroupAdmin,
  isMuted,
  otherMemberId,
} from '@/lib/utils';
import { useChatStore } from '@/store/chat';
import type { Conversation } from '@/types';

const focusRing = 'focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none';
/** Icon buttons need 44px of touch even though the glyph inside is 18–20px. */
const iconButton = `flex h-11 w-11 shrink-0 items-center justify-center rounded-lg transition-colors ${focusRing}`;

const menuItem =
  'flex min-h-11 w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-mist-200 transition-colors hover:bg-ink-750 focus-visible:bg-ink-750 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60';

const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : 'Something went wrong.';

export function ChatHeader({
  conversation,
  viewerUid,
}: {
  conversation: Conversation;
  viewerUid: string;
}) {
  const router = useRouter();
  const users = useChatStore((state) => state.users);

  const isGroup = conversation.type === 'group';
  const otherId = otherMemberId(conversation, viewerUid);
  const online = useChatStore((state) => Boolean(state.online[otherId]));

  const muted = isMuted(conversation, viewerUid);
  const canManage = isGroupAdmin(conversation, viewerUid);

  const [menuOpen, setMenuOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [muteBusy, setMuteBusy] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // A closed menu should not keep a half-finished confirmation or a stale error.
  useEffect(() => {
    if (!menuOpen) {
      setConfirmLeave(false);
      setError(null);
    }
  }, [menuOpen]);

  const title = conversationTitle(conversation, viewerUid, users);
  const memberCount = conversation.memberIds.length;

  async function toggleMute() {
    if (muteBusy) return;
    setMuteBusy(true);
    setError(null);
    try {
      const { conversation: next } = await api.setMuted(conversation.id, !muted);
      useChatStore.getState().upsertConversation(next);
      setMenuOpen(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setMuteBusy(false);
    }
  }

  async function leave() {
    if (leaving) return;
    setLeaving(true);
    setError(null);
    try {
      await api.leaveConversation(conversation.id);
      useChatStore.getState().removeConversation(conversation.id);
      router.replace('/chat');
    } catch (cause) {
      setError(errorText(cause));
      setLeaving(false);
    }
  }

  return (
    <>
      {/* gap trimmed to 2 so back + avatar + title + menu still fit at 320px. */}
      <header className="flex min-h-15 items-center gap-2 border-b border-ink-800 bg-ink-900 px-2 py-2 sm:gap-3 sm:px-5">
        <Link
          href="/chat"
          aria-label="Back to conversations"
          className={cn(iconButton, '-ml-1 text-mist-400 hover:bg-ink-800 hover:text-mist-50 md:hidden')}
        >
          <BackIcon aria-hidden className="h-5 w-5" />
        </Link>

        <Avatar
          name={title}
          seed={conversationSeed(conversation, viewerUid)}
          photoURL={isGroup ? null : users[otherId]?.photoURL}
          // Groups keep their conversation-seeded tint; only people carry a chosen colour.
          color={isGroup ? null : users[otherId]?.avatarColor}
          online={isGroup ? undefined : online}
          ringClass="border-ink-900"
        />

        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <span className="truncate">{title}</span>
            {muted && (
              <BellOffIcon
                className="h-3.5 w-3.5 shrink-0 text-mist-500"
                role="img"
                aria-label="Notifications muted"
              />
            )}
          </h2>

          {isGroup ? (
            // The old inline roster overflowed on anything but a tiny group.
            <button
              type="button"
              onClick={() => setInfoOpen(true)}
              aria-label={`Group info — ${memberCount} ${memberCount === 1 ? 'member' : 'members'}`}
              className={cn(
                'block max-w-full truncate rounded py-1 text-xs text-mist-500 transition-colors hover:text-mist-200',
                focusRing
              )}
            >
              {memberCount} {memberCount === 1 ? 'member' : 'members'}
            </button>
          ) : (
            <p className={cn('truncate text-xs', online ? 'text-signal-online' : 'text-mist-500')}>
              {online ? 'Online' : 'Offline'}
            </p>
          )}
        </div>

        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={isGroup ? 'Group options' : 'Conversation options'}
            className={cn(iconButton, 'text-mist-400 hover:bg-ink-800 hover:text-mist-50')}
          >
            <MoreIcon aria-hidden className="h-[18px] w-[18px]" />
          </button>

          {menuOpen && (
            <div
              role="menu"
              aria-label={isGroup ? 'Group options' : 'Conversation options'}
              className="absolute top-full right-0 z-30 mt-1 w-52 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-ink-700 bg-ink-800 py-1 shadow-2xl"
            >
              {isGroup && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setInfoOpen(true);
                  }}
                  className={menuItem}
                >
                  <InfoIcon aria-hidden className="h-4 w-4 shrink-0 text-mist-400" />
                  Group info
                </button>
              )}

              <button
                type="button"
                role="menuitem"
                onClick={() => void toggleMute()}
                disabled={muteBusy}
                className={menuItem}
              >
                {muted ? (
                  <BellIcon aria-hidden className="h-4 w-4 shrink-0 text-mist-400" />
                ) : (
                  <BellOffIcon aria-hidden className="h-4 w-4 shrink-0 text-mist-400" />
                )}
                {muteBusy ? 'Saving…' : muted ? 'Unmute notifications' : 'Mute notifications'}
              </button>

              {isGroup && canManage && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setAddOpen(true);
                  }}
                  className={menuItem}
                >
                  <UserPlusIcon aria-hidden className="h-4 w-4 shrink-0 text-mist-400" />
                  Add people
                </button>
              )}

              {isGroup &&
                (confirmLeave ? (
                  <div className="border-t border-ink-700 px-4 py-2.5">
                    <p className="text-xs leading-relaxed text-mist-400">
                      Leave this group? You will stop receiving its messages, and only a member can
                      add you back.
                    </p>
                    <div className="mt-2 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirmLeave(false)}
                        className={cn(
                          'min-h-11 rounded-lg px-3 text-xs text-mist-400 transition-colors hover:text-mist-50',
                          focusRing
                        )}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => void leave()}
                        disabled={leaving}
                        className="min-h-11 rounded-lg bg-signal-danger px-3 text-xs font-semibold text-white transition-colors hover:brightness-110 focus-visible:ring-2 focus-visible:ring-signal-danger focus-visible:outline-none disabled:opacity-60"
                      >
                        {leaving ? 'Leaving…' : 'Leave'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => setConfirmLeave(true)}
                    className={cn(menuItem, 'text-red-300')}
                  >
                    Leave group
                  </button>
                ))}

              {error && (
                <p role="alert" className="px-4 pt-1 pb-2 text-xs leading-relaxed text-red-300">
                  {error} Nothing changed — try again.
                </p>
              )}
            </div>
          )}
        </div>
      </header>

      {infoOpen && (
        <GroupInfoPanel
          conversation={conversation}
          viewerUid={viewerUid}
          onClose={() => setInfoOpen(false)}
        />
      )}

      {addOpen && (
        <NewConversationDialog
          mode="add"
          conversationId={conversation.id}
          existingMemberIds={conversation.memberIds}
          onClose={() => setAddOpen(false)}
        />
      )}
    </>
  );
}
