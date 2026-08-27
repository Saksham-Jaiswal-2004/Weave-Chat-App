'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import { CloseIcon, SearchIcon } from '@/components/Icons';
import { api } from '@/lib/api';
import { cn, formatRelative } from '@/lib/utils';
import { useChatStore } from '@/store/chat';
import type { Conversation, Message } from '@/types';

/**
 * Search runs over the messages already in the store, never on the server: Firestore
 * has no full-text index, so a server-side scan would bill one document read per
 * message examined — unaffordable on the free tier. The window is therefore whatever
 * the thread has paged in, and "Load older messages" lets the user widen it knowingly.
 */

const DEBOUNCE_MS = 150;
/** Context kept either side of the hit, so a snippet stays about one line. */
const LEAD_CHARS = 28;
const TRAIL_CHARS = 90;
/** A busy thread can match hundreds of times; nobody scrolls past the first screenful. */
const MAX_RESULTS = 50;

interface MessageSearchProps {
  conversation: Conversation;
  viewerUid: string;
  onJumpTo: (messageId: string) => void;
  onClose: () => void;
}

interface Hit {
  message: Message;
  before: string;
  match: string;
  after: string;
}

function snippetAround(text: string, at: number, length: number): Omit<Hit, 'message'> {
  const start = Math.max(0, at - LEAD_CHARS);
  const end = Math.min(text.length, at + length + TRAIL_CHARS);

  return {
    before: (start > 0 ? '…' : '') + text.slice(start, at),
    match: text.slice(at, at + length),
    after: text.slice(at + length, end) + (end < text.length ? '…' : ''),
  };
}

const optionId = (index: number) => `weave-search-option-${index}`;

export function MessageSearch({ conversation, viewerUid, onJumpTo, onClose }: MessageSearchProps) {
  const messages = useChatStore((state) => state.messages[conversation.id]);
  const users = useChatStore((state) => state.users);
  const thread = useChatStore((state) => state.threads[conversation.id]);

  const [term, setTerm] = useState('');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const list = messages ?? [];
  const hasMore = Boolean(thread?.hasMore);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // One pass per pause rather than per keystroke — the scan is O(loaded messages).
  useEffect(() => {
    const timer = setTimeout(() => setQuery(term), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term]);

  const hits = useMemo<Hit[]>(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];

    const found: Hit[] = [];
    // Newest first: what you are hunting for is usually what you just saw scroll past.
    for (let index = list.length - 1; index >= 0 && found.length < MAX_RESULTS; index -= 1) {
      const message = list[index];
      if (message.deletedAt || !message.text) continue;

      const at = message.text.toLowerCase().indexOf(needle);
      if (at === -1) continue;

      found.push({ message, ...snippetAround(message.text, at, needle.length) });
    }
    return found;
  }, [list, query]);

  useEffect(() => setActive(0), [query]);

  // Keep the highlighted row in view while the arrow keys walk the list.
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active, hits.length]);

  const choose = useCallback(
    (messageId: string) => {
      onJumpTo(messageId);
      onClose();
    },
    [onJumpTo, onClose]
  );

  const loadOlder = useCallback(async () => {
    const oldest = useChatStore.getState().messages[conversation.id]?.[0];
    if (!oldest || loadingOlder) return;

    setLoadingOlder(true);
    setLoadError(null);
    try {
      const page = await api.listMessages(conversation.id, oldest.createdAt);
      useChatStore.getState().prependMessages(conversation.id, page.messages, page.hasMore);
    } catch (cause) {
      setLoadError((cause as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  }, [conversation.id, loadingOlder]);

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (hits.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (index + 1) % hits.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (index - 1 + hits.length) % hits.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const hit = hits[active];
      if (hit) choose(hit.message.id);
    }
  }

  const searched = query.trim().length > 0;

  return (
    <div
      role="dialog"
      aria-label="Search this conversation"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          // Stop it here so the global handler does not also close the thread.
          event.stopPropagation();
          onClose();
        }
      }}
      className="relative z-20 shrink-0 border-b border-ink-800 bg-ink-900 shadow-lg"
    >
      <div className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-mist-500" />
          <input
            ref={inputRef}
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search this conversation"
            aria-label="Search this conversation"
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls="weave-search-results"
            aria-autocomplete="list"
            aria-activedescendant={hits.length > 0 ? optionId(active) : undefined}
            className="w-full rounded-xl border border-ink-700 bg-ink-800 py-2.5 pr-3 pl-9 text-sm placeholder:text-mist-500 focus:border-weave-500 focus:outline-none"
          />
        </div>

        <p aria-live="polite" className="shrink-0 text-xs tabular-nums text-mist-500">
          {searched ? `${hits.length}${hits.length === MAX_RESULTS ? '+' : ''} found` : ''}
        </p>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close search"
          className="rounded-lg p-1.5 text-mist-400 transition-colors hover:bg-ink-800 hover:text-mist-50 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none motion-reduce:transition-none"
        >
          <CloseIcon className="h-[18px] w-[18px]" />
        </button>
      </div>

      {list.length === 0 ? (
        <p className="px-4 pb-4 text-center text-sm text-mist-500">
          No messages loaded yet — there is nothing to search here.
        </p>
      ) : !searched ? (
        <p className="px-4 pb-4 text-center text-sm text-mist-500">
          Type to search the messages loaded in this thread.
        </p>
      ) : hits.length === 0 ? (
        <p className="px-4 pb-4 text-center text-sm text-mist-500">
          Nothing loaded here matches &ldquo;{query.trim()}&rdquo;.
        </p>
      ) : (
        <ul
          ref={listRef}
          id="weave-search-results"
          role="listbox"
          aria-label="Search results"
          className="scroll-slim max-h-72 overflow-y-auto px-2 pb-2"
        >
          {hits.map((hit, index) => {
            const mine = hit.message.senderId === viewerUid;
            const name = mine ? 'You' : (users[hit.message.senderId]?.displayName ?? 'Someone');
            const selected = index === active;

            return (
              <li key={hit.message.id} id={optionId(index)} role="option" aria-selected={selected}>
                <button
                  type="button"
                  // Focus stays in the input: this is a listbox, not a set of stops.
                  tabIndex={-1}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(hit.message.id)}
                  className={cn(
                    'block w-full rounded-xl px-3 py-2 text-left transition-colors hover:bg-ink-800 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none motion-reduce:transition-none',
                    selected && 'bg-ink-800 ring-1 ring-weave-500/40'
                  )}
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-xs font-medium text-weave-400">{name}</span>
                    <span className="shrink-0 text-[11px] text-mist-500">
                      {formatRelative(hit.message.createdAt)}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-sm text-mist-200">
                    {hit.before}
                    <span className="rounded bg-weave-500/25 px-0.5 font-medium text-mist-50">
                      {hit.match}
                    </span>
                    {hit.after}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-ink-800 px-4 py-2">
        <p className="text-[11px] text-mist-500">
          {list.length === 0
            ? 'Nothing loaded to search yet.'
            : `Searching the last ${list.length} message${list.length === 1 ? '' : 's'} loaded in this thread.`}
        </p>

        {hasMore && (
          <button
            type="button"
            onClick={() => void loadOlder()}
            disabled={loadingOlder}
            className="rounded-lg px-2 py-1 text-[11px] font-medium text-weave-400 transition-colors hover:bg-ink-800 hover:text-mist-50 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
          >
            {loadingOlder ? 'Loading…' : 'Load older messages'}
          </button>
        )}
      </footer>

      {loadError && (
        <p role="alert" className="px-4 pb-2 text-[11px] text-red-300">
          {loadError}
        </p>
      )}
    </div>
  );
}
