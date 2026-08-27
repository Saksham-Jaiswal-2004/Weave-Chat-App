'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Avatar } from '@/components/Avatar';
import { CheckIcon, CloseIcon, SearchIcon } from '@/components/Icons';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth';
import { useChatStore } from '@/store/chat';
import type { UserProfile } from '@/types';

type Mode = 'dm' | 'group' | 'add';

interface Props {
  mode: Mode;
  /** Required for `add`: the group being extended. */
  conversationId?: string;
  existingMemberIds?: string[];
  onClose: () => void;
}

const TITLES: Record<Mode, string> = {
  dm: 'New chat',
  group: 'New group',
  add: 'Add people',
};

const SEARCH_DEBOUNCE_MS = 250;

export function NewConversationDialog({
  mode,
  conversationId,
  existingMemberIds = [],
  onClose,
}: Props) {
  const router = useRouter();
  const viewerUid = useAuthStore((state) => state.user?.uid);

  const [term, setTerm] = useState('');
  const [results, setResults] = useState<UserProfile[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<UserProfile[]>([]);
  const [groupName, setGroupName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const multi = mode !== 'dm';
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Debounced directory lookup — one request per pause, not per keystroke.
  useEffect(() => {
    const query = term.trim();
    if (query.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    let cancelled = false;

    const timer = setTimeout(async () => {
      try {
        const { users } = await api.searchUsers(query);
        if (cancelled) return;
        setResults(users);
        setSearchError(null);
      } catch (cause) {
        // A failed lookup previously rendered as "nobody matched", which reads as
        // an empty directory rather than a broken one.
        if (cancelled) return;
        setResults([]);
        setSearchError((cause as Error).message);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term]);

  function toggle(user: UserProfile) {
    setSelected((current) =>
      current.some((item) => item.uid === user.uid)
        ? current.filter((item) => item.uid !== user.uid)
        : [...current, user]
    );
  }

  async function startDirect(user: UserProfile) {
    setBusy(true);
    setError(null);
    try {
      const { conversation, users } = await api.createDirect(user.uid);
      useChatStore.getState().upsertConversation(conversation, users);
      onClose();
      router.push(`/chat/${conversation.id}`);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'group') {
        const { conversation, users } = await api.createGroup(
          groupName,
          selected.map((user) => user.uid)
        );
        useChatStore.getState().upsertConversation(conversation, users);
        onClose();
        router.push(`/chat/${conversation.id}`);
      } else if (mode === 'add' && conversationId) {
        const { conversation, users } = await api.addMembers(
          conversationId,
          selected.map((user) => user.uid)
        );
        useChatStore.getState().upsertConversation(conversation, users);
        onClose();
      }
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }

  const alreadyIn = new Set(existingMemberIds);
  const canSubmit =
    mode === 'group'
      ? groupName.trim().length > 0 && selected.length > 0
      : selected.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={TITLES[mode]}
        className="flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-2xl border border-ink-700 bg-ink-900 shadow-2xl sm:max-w-md sm:rounded-2xl"
      >
        <header className="flex items-center justify-between border-b border-ink-800 px-5 py-4">
          <h2 className="text-base font-semibold">{TITLES[mode]}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-mist-400 transition-colors hover:bg-ink-800 hover:text-mist-50"
          >
            <CloseIcon className="h-[18px] w-[18px]" />
          </button>
        </header>

        <div className="space-y-3 px-5 py-4">
          {mode === 'group' && (
            <input
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              placeholder="Group name"
              maxLength={60}
              aria-label="Group name"
              className="w-full rounded-xl border border-ink-700 bg-ink-800 px-3.5 py-2.5 text-sm placeholder:text-mist-500 focus:border-weave-500 focus:outline-none"
            />
          )}

          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-mist-500" />
            <input
              ref={inputRef}
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Search by name or email"
              aria-label="Search people"
              className="w-full rounded-xl border border-ink-700 bg-ink-800 py-2.5 pr-3 pl-9 text-sm placeholder:text-mist-500 focus:border-weave-500 focus:outline-none"
            />
          </div>

          {multi && selected.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {selected.map((user) => (
                <li key={user.uid}>
                  <button
                    type="button"
                    onClick={() => toggle(user)}
                    className="flex items-center gap-1.5 rounded-full bg-ink-750 py-1 pr-1.5 pl-2.5 text-xs text-mist-200 transition-colors hover:bg-ink-700"
                  >
                    {user.displayName}
                    <CloseIcon className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="scroll-slim min-h-24 flex-1 overflow-y-auto px-2 pb-2">
          {term.trim().length < 2 ? (
            <p className="px-3 py-8 text-center text-sm text-mist-500">
              Type at least two characters to search.
            </p>
          ) : searching ? (
            <p className="px-3 py-8 text-center text-sm text-mist-500">Searching…</p>
          ) : searchError ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm font-medium text-red-200">Search is unavailable</p>
              <p className="mt-1.5 text-xs leading-relaxed text-red-200/70">{searchError}</p>
            </div>
          ) : results.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-mist-500">Nobody matched that.</p>
          ) : (
            <ul className="space-y-0.5">
              {results.map((user) => {
                const isSelf = user.uid === viewerUid;
                const isMember = alreadyIn.has(user.uid);
                const isSelected = selected.some((item) => item.uid === user.uid);
                const disabled = isSelf || isMember || busy;

                return (
                  <li key={user.uid}>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => (multi ? toggle(user) : void startDirect(user))}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                        disabled ? 'cursor-not-allowed opacity-45' : 'hover:bg-ink-800',
                        isSelected && 'bg-ink-800'
                      )}
                    >
                      <Avatar
                        name={user.displayName}
                        seed={user.uid}
                        photoURL={user.photoURL}
                        color={user.avatarColor}
                        size="sm"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{user.displayName}</span>
                        <span className="block truncate text-xs text-mist-500">
                          {isMember ? 'Already in this group' : (user.email ?? '')}
                        </span>
                      </span>
                      {isSelected && <CheckIcon className="h-4 w-4 text-weave-400" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {error && (
          <p role="alert" className="px-5 pb-2 text-sm text-red-300">
            {error}
          </p>
        )}

        {multi && (
          <footer className="flex items-center justify-end gap-2 border-t border-ink-800 px-5 py-3.5">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3.5 py-2 text-sm text-mist-400 transition-colors hover:text-mist-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSubmit || busy}
              className="rounded-lg bg-weave-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-weave-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Working…' : mode === 'group' ? 'Create group' : 'Add'}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
