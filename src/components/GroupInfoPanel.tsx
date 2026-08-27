'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Avatar } from '@/components/Avatar';
import {
  BellIcon,
  BellOffIcon,
  CheckIcon,
  CloseIcon,
  LogoutIcon,
  MoreIcon,
  PencilIcon,
  UserPlusIcon,
} from '@/components/Icons';
import { NewConversationDialog } from '@/components/NewConversationDialog';
import { SoundToggle } from '@/components/NotificationPrompt';
import { api } from '@/lib/api';
import { cn, conversationSeed, conversationTitle, isGroupAdmin, isMuted } from '@/lib/utils';
import { useChatStore } from '@/store/chat';
import type { Conversation } from '@/types';

export interface GroupInfoPanelProps {
  conversation: Conversation;
  viewerUid: string;
  onClose: () => void;
}

const NAME_MAX = 60;

const createdFormat = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : 'Something went wrong.';

const rowButton =
  'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-ink-800 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60';

/**
 * Slide-over on the right; on phones it simply covers the pane, so the chat layout
 * underneath is never reflowed.
 */
export function GroupInfoPanel({ conversation, viewerUid, onClose }: GroupInfoPanelProps) {
  const router = useRouter();
  const users = useChatStore((state) => state.users);
  const online = useChatStore((state) => state.online);

  const viewerIsAdmin = isGroupAdmin(conversation, viewerUid);
  const muted = isMuted(conversation, viewerUid);
  const title = conversationTitle(conversation, viewerUid, users);

  // Mounted, then shown, so the panel animates in rather than snapping into place.
  const [shown, setShown] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [muteBusy, setMuteBusy] = useState(false);
  const [muteError, setMuteError] = useState<string | null>(null);

  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [memberBusy, setMemberBusy] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<{ uid: string; text: string } | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    panelRef.current?.focus();
    return () => cancelAnimationFrame(frame);
  }, []);

  // Escape from anywhere in the panel closes it; the name field intercepts its own.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (editing) nameInputRef.current?.select();
  }, [editing]);

  // One member menu at a time, dismissed by any click outside a menu.
  useEffect(() => {
    if (!menuFor) return;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('[data-member-menu]')) setMenuFor(null);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [menuFor]);

  const members = useMemo(() => {
    const admins = new Set(conversation.admins ?? []);
    return conversation.memberIds
      .map((uid) => ({
        uid,
        admin: admins.has(uid),
        name: users[uid]?.displayName ?? 'Someone',
        photoURL: users[uid]?.photoURL ?? null,
        avatarColor: users[uid]?.avatarColor ?? null,
        email: users[uid]?.email ?? null,
      }))
      // Admins float to the top; everyone else falls into alphabetical order.
      .sort((a, b) =>
        a.admin === b.admin ? a.name.localeCompare(b.name) : Number(b.admin) - Number(a.admin)
      );
  }, [conversation.admins, conversation.memberIds, users]);

  const trimmed = draft.trim();
  const canSaveName = trimmed.length > 0 && trimmed.length <= NAME_MAX && trimmed !== title;

  function cancelRename() {
    setEditing(false);
    setDraft(title);
    setRenameError(null);
  }

  async function saveName() {
    if (!canSaveName || renameBusy) return;
    setRenameBusy(true);
    setRenameError(null);
    try {
      const { conversation: next } = await api.renameConversation(conversation.id, trimmed);
      useChatStore.getState().upsertConversation(next);
      setEditing(false);
    } catch (cause) {
      setRenameError(message(cause));
    } finally {
      setRenameBusy(false);
    }
  }

  async function toggleMute() {
    if (muteBusy) return;
    setMuteBusy(true);
    setMuteError(null);
    try {
      const { conversation: next } = await api.setMuted(conversation.id, !muted);
      useChatStore.getState().upsertConversation(next);
    } catch (cause) {
      setMuteError(message(cause));
    } finally {
      setMuteBusy(false);
    }
  }

  async function toggleAdmin(uid: string, admin: boolean) {
    if (memberBusy) return;
    setMenuFor(null);
    setMemberBusy(uid);
    setMemberError(null);
    try {
      const { conversation: next } = await api.setAdmin(conversation.id, uid, admin);
      useChatStore.getState().upsertConversation(next);
    } catch (cause) {
      setMemberError({ uid, text: message(cause) });
    } finally {
      setMemberBusy(null);
    }
  }

  async function removeMember(uid: string) {
    if (memberBusy) return;
    setMemberBusy(uid);
    setMemberError(null);
    try {
      const { conversation: next, users: fresh } = await api.removeMember(conversation.id, uid);
      useChatStore.getState().upsertConversation(next, fresh);
      setConfirmRemove(null);
    } catch (cause) {
      setMemberError({ uid, text: message(cause) });
    } finally {
      setMemberBusy(null);
    }
  }

  async function leave() {
    if (leaveBusy) return;
    setLeaveBusy(true);
    setLeaveError(null);
    try {
      await api.leaveConversation(conversation.id);
      useChatStore.getState().removeConversation(conversation.id);
      router.replace('/chat');
    } catch (cause) {
      setLeaveError(message(cause));
      setLeaveBusy(false);
    }
  }

  const memberCount = conversation.memberIds.length;

  return (
    <>
      <div
        className="fixed inset-0 z-40 flex justify-end bg-black/60 backdrop-blur-sm"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <aside
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label="Group info"
          className={cn(
            'flex h-full w-full flex-col border-l border-ink-700 bg-ink-900 shadow-2xl outline-none',
            'transition-transform duration-200 ease-out motion-reduce:transition-none sm:max-w-sm',
            shown ? 'translate-x-0' : 'translate-x-full'
          )}
        >
          <header className="flex items-center justify-between border-b border-ink-800 px-5 py-4">
            <h2 className="text-base font-semibold">Group info</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close group info"
              className="rounded-lg p-1.5 text-mist-400 transition-colors hover:bg-ink-800 hover:text-mist-50 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none"
            >
              <CloseIcon className="h-[18px] w-[18px]" />
            </button>
          </header>

          <div className="scroll-slim flex-1 overflow-y-auto">
            <section className="flex flex-col items-center gap-3 px-5 py-6 text-center">
              <Avatar
                name={title}
                seed={conversationSeed(conversation, viewerUid)}
                size="lg"
                ringClass="border-ink-900"
              />

              {editing ? (
                <div className="w-full">
                  <div className="flex items-center gap-2">
                    <input
                      ref={nameInputRef}
                      value={draft}
                      maxLength={NAME_MAX}
                      aria-label="Group name"
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void saveName();
                        if (event.key === 'Escape') {
                          // Keep Escape local: it cancels the edit, not the panel.
                          event.stopPropagation();
                          cancelRename();
                        }
                      }}
                      className="min-w-0 flex-1 rounded-xl border border-ink-700 bg-ink-800 px-3.5 py-2 text-sm focus:border-weave-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void saveName()}
                      disabled={!canSaveName || renameBusy}
                      aria-label="Save group name"
                      className="rounded-lg bg-weave-500 p-2 text-white transition-colors hover:bg-weave-600 focus-visible:ring-2 focus-visible:ring-weave-400 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <CheckIcon className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={cancelRename}
                      disabled={renameBusy}
                      aria-label="Cancel rename"
                      className="rounded-lg p-2 text-mist-400 transition-colors hover:bg-ink-800 hover:text-mist-50 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none"
                    >
                      <CloseIcon className="h-4 w-4" />
                    </button>
                  </div>
                  <p className="mt-1.5 text-left text-xs text-mist-500">
                    {trimmed.length === 0
                      ? 'A group needs a name.'
                      : `${trimmed.length}/${NAME_MAX}`}
                  </p>
                  {renameError && (
                    <p role="alert" className="mt-1 text-left text-xs text-red-300">
                      {renameError}
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex max-w-full items-center gap-1.5">
                  <h3 className="truncate text-lg font-semibold">{title}</h3>
                  {viewerIsAdmin && (
                    <button
                      type="button"
                      onClick={() => {
                        setDraft(title);
                        setEditing(true);
                      }}
                      aria-label="Rename group"
                      className="shrink-0 rounded-lg p-1.5 text-mist-400 transition-colors hover:bg-ink-800 hover:text-mist-50 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none"
                    >
                      <PencilIcon className="h-4 w-4" />
                    </button>
                  )}
                </div>
              )}

              <p className="text-xs text-mist-500">
                {memberCount} {memberCount === 1 ? 'member' : 'members'} · Created{' '}
                {createdFormat.format(conversation.createdAt)}
              </p>
            </section>

            <section className="border-t border-ink-800 px-2 py-2">
              <button
                type="button"
                onClick={() => void toggleMute()}
                disabled={muteBusy}
                aria-pressed={muted}
                className={cn(rowButton, 'text-mist-200')}
              >
                {muted ? (
                  <BellOffIcon className="h-[18px] w-[18px] shrink-0 text-mist-400" />
                ) : (
                  <BellIcon className="h-[18px] w-[18px] shrink-0 text-mist-400" />
                )}
                <span className="flex-1">
                  {muted ? 'Notifications muted' : 'Mute notifications'}
                </span>
                {muteBusy && <span className="text-xs text-mist-500">Saving…</span>}
              </button>
              {muteError && (
                <p role="alert" className="px-3 pb-1 text-xs text-red-300">
                  {muteError}
                </p>
              )}

              <div className="flex items-center gap-3 rounded-xl px-3 py-1.5 text-sm text-mist-200">
                <span className="flex-1">Message sound</span>
                <SoundToggle className="-mr-1" />
              </div>
            </section>

            <section className="border-t border-ink-800 px-2 py-3">
              <h4 className="px-3 pb-2 text-xs font-semibold tracking-wide text-mist-500 uppercase">
                {memberCount} {memberCount === 1 ? 'member' : 'members'}
              </h4>

              {viewerIsAdmin && (
                <button
                  type="button"
                  onClick={() => setAddOpen(true)}
                  className={cn(rowButton, 'text-weave-400')}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-weave-500/15">
                    <UserPlusIcon className="h-4 w-4" />
                  </span>
                  Add people
                </button>
              )}

              <ul>
                {members.map((member) => {
                  const isSelf = member.uid === viewerUid;
                  const canManage = viewerIsAdmin && !isSelf;
                  const busy = memberBusy === member.uid;
                  const error = memberError?.uid === member.uid ? memberError.text : null;

                  return (
                    <li key={member.uid}>
                      <div className="flex items-center gap-3 rounded-xl px-3 py-2">
                        <Avatar
                          name={member.name}
                          seed={member.uid}
                          photoURL={member.photoURL}
                          color={member.avatarColor}
                          size="sm"
                          online={Boolean(online[member.uid])}
                          ringClass="border-ink-900"
                        />

                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-1.5">
                            <span className="truncate text-sm font-medium">{member.name}</span>
                            {isSelf && <span className="text-xs text-mist-500">You</span>}
                          </span>
                          <span className="block truncate text-xs text-mist-500">
                            {member.email ?? ''}
                          </span>
                        </span>

                        {member.admin && (
                          <span className="shrink-0 rounded-full bg-weave-500/15 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-weave-400 uppercase">
                            Admin
                          </span>
                        )}

                        {canManage && (
                          <div className="relative shrink-0" data-member-menu>
                            <button
                              type="button"
                              onClick={() =>
                                setMenuFor((open) => (open === member.uid ? null : member.uid))
                              }
                              disabled={busy}
                              aria-haspopup="menu"
                              aria-expanded={menuFor === member.uid}
                              aria-label={`Options for ${member.name}`}
                              className="rounded-lg p-1.5 text-mist-400 transition-colors hover:bg-ink-800 hover:text-mist-50 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none disabled:opacity-60"
                            >
                              <MoreIcon className="h-4 w-4" />
                            </button>

                            {menuFor === member.uid && (
                              <div
                                role="menu"
                                className="absolute top-full right-0 z-10 mt-1 w-48 overflow-hidden rounded-xl border border-ink-700 bg-ink-800 py-1 shadow-2xl"
                              >
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => void toggleAdmin(member.uid, !member.admin)}
                                  className="block w-full px-4 py-2.5 text-left text-sm text-mist-200 transition-colors hover:bg-ink-750 focus-visible:bg-ink-750 focus-visible:outline-none"
                                >
                                  {member.admin ? 'Remove admin' : 'Make admin'}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => {
                                    setMenuFor(null);
                                    setConfirmRemove(member.uid);
                                  }}
                                  className="block w-full px-4 py-2.5 text-left text-sm text-red-300 transition-colors hover:bg-ink-750 focus-visible:bg-ink-750 focus-visible:outline-none"
                                >
                                  Remove from group
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {confirmRemove === member.uid && (
                        <div className="mx-3 mb-2 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2.5">
                          <p className="text-xs text-mist-200">
                            Remove {member.name} from this group?
                          </p>
                          <div className="mt-2 flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setConfirmRemove(null)}
                              className="rounded-lg px-2.5 py-1.5 text-xs text-mist-400 transition-colors hover:text-mist-50 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => void removeMember(member.uid)}
                              disabled={busy}
                              className="rounded-lg bg-signal-danger px-2.5 py-1.5 text-xs font-semibold text-white transition-colors hover:brightness-110 focus-visible:ring-2 focus-visible:ring-signal-danger focus-visible:outline-none disabled:opacity-60"
                            >
                              {busy ? 'Removing…' : 'Remove'}
                            </button>
                          </div>
                        </div>
                      )}

                      {error && (
                        <p role="alert" className="px-3 pb-2 text-xs text-red-300">
                          {error}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          </div>

          <footer className="border-t border-ink-800 px-2 py-2">
            {confirmLeave ? (
              <div className="rounded-xl border border-ink-700 bg-ink-850 px-3 py-2.5">
                <p className="text-xs text-mist-200">
                  Leave this group? You will stop receiving its messages.
                </p>
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmLeave(false)}
                    className="rounded-lg px-2.5 py-1.5 text-xs text-mist-400 transition-colors hover:text-mist-50 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void leave()}
                    disabled={leaveBusy}
                    className="rounded-lg bg-signal-danger px-2.5 py-1.5 text-xs font-semibold text-white transition-colors hover:brightness-110 focus-visible:ring-2 focus-visible:ring-signal-danger focus-visible:outline-none disabled:opacity-60"
                  >
                    {leaveBusy ? 'Leaving…' : 'Leave group'}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmLeave(true)}
                className={cn(rowButton, 'text-red-300')}
              >
                <LogoutIcon className="h-[18px] w-[18px] shrink-0" />
                Leave group
              </button>
            )}

            {leaveError && (
              <p role="alert" className="px-3 pt-2 text-xs text-red-300">
                {leaveError}
              </p>
            )}
          </footer>
        </aside>
      </div>

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
