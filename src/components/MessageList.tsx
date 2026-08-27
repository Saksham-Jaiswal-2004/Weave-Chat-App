'use client';

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Ref } from 'react';

import { MessageBubble, messageRowId } from '@/components/MessageBubble';
import { api } from '@/lib/api';
import { cn, formatDayLabel, sameDay } from '@/lib/utils';
import { useChatStore } from '@/store/chat';
import type { Conversation, Message, UserProfile } from '@/types';

/** Messages closer together than this from one person render as a single block. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;
/** How close to the top counts as "load the previous page". */
const LOAD_MORE_THRESHOLD_PX = 120;
const STICK_THRESHOLD_PX = 80;
/** Long enough to catch the eye after a jump, short enough not to nag. */
const FLASH_MS = 1400;

/** Lets a parent — search, a notification — drive the same jump a reply quote does. */
export interface MessageListHandle {
  jumpTo: (messageId: string) => void;
}

interface Props {
  conversation: Conversation;
  viewerUid: string;
  onReply: (message: Message) => void;
  ref?: Ref<MessageListHandle>;
}

function reducedMotion() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function MessageList({ conversation, viewerUid, onReply, ref }: Props) {
  const messages = useChatStore((state) => state.messages[conversation.id]);
  const users = useChatStore((state) => state.users);
  const thread = useChatStore((state) => state.threads[conversation.id]);
  const readMarker = useChatStore((state) => state.readMarkers[conversation.id] ?? 0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [flashId, setFlashId] = useState<string | null>(null);

  /** Height snapshot taken before a page of older messages is spliced in. */
  const restoreRef = useRef<number | null>(null);
  const lastIdRef = useRef<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const list = messages ?? [];
  const loading = !thread || thread.status === 'loading' || thread.status === 'idle';

  // `mentionSegments` matches on display names, so it needs the profiles, not the uids.
  const members = useMemo(
    () =>
      conversation.memberIds
        .map((uid) => users[uid])
        .filter((member): member is UserProfile => Boolean(member)),
    [conversation.memberIds, users]
  );

  /**
   * The first message the viewer had not read when the thread was opened. Index 0 is
   * skipped deliberately: a rule pinned to the very top of the loaded window reads as
   * a header rather than a boundary, and says nothing useful.
   */
  const dividerIndex = useMemo(() => {
    if (!readMarker) return -1;
    const index = list.findIndex(
      (message) => message.createdAt > readMarker && message.senderId !== viewerUid
    );
    return index > 0 ? index : -1;
  }, [list, readMarker, viewerUid]);

  const loadOlder = useCallback(async () => {
    const state = useChatStore.getState();
    const current = state.threads[conversation.id];
    const oldest = state.messages[conversation.id]?.[0];
    if (!current?.hasMore || current.loadingMore || !oldest) return;

    state.setThreadStatus(conversation.id, { loadingMore: true });
    const element = scrollRef.current;
    restoreRef.current = element ? element.scrollHeight - element.scrollTop : null;

    try {
      const page = await api.listMessages(conversation.id, oldest.createdAt);
      useChatStore.getState().prependMessages(conversation.id, page.messages, page.hasMore);
    } catch {
      useChatStore.getState().setThreadStatus(conversation.id, { loadingMore: false });
    }
  }, [conversation.id]);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    setPinned(distanceFromBottom < STICK_THRESHOLD_PX);

    if (element.scrollTop < LOAD_MORE_THRESHOLD_PX) void loadOlder();
  }, [loadOlder]);

  /** Reply quotes point at a snapshot, so the original may have scrolled out of the page. */
  const jumpTo = useCallback(
    (messageId: string) => {
      const target = document.getElementById(messageRowId(conversation.id, messageId));
      if (!target) return;

      target.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
      target.focus({ preventScroll: true });

      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      setFlashId(messageId);
      flashTimerRef.current = setTimeout(() => setFlashId(null), FLASH_MS);
    },
    [conversation.id]
  );

  useImperativeHandle(ref, () => ({ jumpTo }), [jumpTo]);

  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
  }, []);

  // Keep the viewport anchored: hold position when older messages are prepended,
  // follow along when new ones arrive at the bottom.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    if (restoreRef.current !== null) {
      element.scrollTop = element.scrollHeight - restoreRef.current;
      restoreRef.current = null;
      return;
    }

    const newest = list.at(-1);
    const isNew = newest?.id !== lastIdRef.current;
    lastIdRef.current = newest?.id ?? null;

    if (isNew && (pinned || newest?.senderId === viewerUid)) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [list, pinned, viewerUid]);

  // Jump to the bottom whenever a different thread is opened.
  useEffect(() => {
    lastIdRef.current = null;
    setFlashId(null);
    setPinned(true);
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }));
  }, [conversation.id]);

  if (loading && list.length === 0) {
    return (
      <div className="flex-1 space-y-4 overflow-hidden px-4 py-6" aria-hidden>
        {Array.from({ length: 7 }).map((_, index) => (
          <div key={index} className={cn('flex gap-3', index % 3 === 0 && 'justify-end')}>
            <div
              className="h-10 animate-pulse rounded-2xl bg-ink-800"
              style={{ width: `${35 + ((index * 13) % 40)}%` }}
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="scroll-slim h-full overflow-y-auto px-3 py-4 sm:px-6"
      >
        {thread?.loadingMore && (
          <p className="pb-4 text-center text-xs text-mist-500">Loading earlier messages…</p>
        )}

        {!thread?.hasMore && list.length > 0 && (
          <p className="pb-6 text-center text-xs text-mist-500">
            This is the beginning of your conversation.
          </p>
        )}

        {list.length === 0 && (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <p className="text-sm text-mist-500">
              No messages yet — say hello and get things started.
            </p>
          </div>
        )}

        <ol className="space-y-0.5">
          {list.map((message, index) => {
            const previous = list[index - 1];
            const showDay = !previous || !sameDay(previous.createdAt, message.createdAt);
            const grouped =
              !showDay &&
              index !== dividerIndex &&
              // A quoted reply needs its own headroom, so it never joins a run.
              !message.replyTo &&
              previous?.senderId === message.senderId &&
              message.createdAt - previous.createdAt < GROUP_WINDOW_MS;

            return (
              <li key={message.id}>
                {showDay && <DaySeparator timestamp={message.createdAt} />}
                {index === dividerIndex && <UnreadDivider />}
                <MessageBubble
                  conversation={conversation}
                  message={message}
                  viewerUid={viewerUid}
                  users={users}
                  members={members}
                  mine={message.senderId === viewerUid}
                  grouped={grouped}
                  showAuthor={conversation.type === 'group'}
                  flashing={flashId === message.id}
                  onReply={onReply}
                  onJumpTo={jumpTo}
                />
              </li>
            );
          })}
        </ol>

        <div ref={bottomRef} />
      </div>

      {!pinned && list.length > 0 && (
        <button
          type="button"
          onClick={() =>
            bottomRef.current?.scrollIntoView({
              behavior: reducedMotion() ? 'auto' : 'smooth',
              block: 'end',
            })
          }
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-ink-700 bg-ink-800/95 px-3.5 py-1.5 text-xs font-medium text-mist-200 shadow-lg backdrop-blur transition-colors hover:bg-ink-750 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none motion-reduce:transition-none"
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}

function DaySeparator({ timestamp }: { timestamp: number }) {
  return (
    <div className="my-4 flex items-center gap-3">
      <span className="h-px flex-1 bg-ink-800" />
      <span className="text-[11px] font-medium tracking-wide text-mist-500 uppercase">
        {formatDayLabel(timestamp)}
      </span>
      <span className="h-px flex-1 bg-ink-800" />
    </div>
  );
}

function UnreadDivider() {
  return (
    <div className="my-3 flex items-center gap-3" role="separator" aria-label="New messages">
      <span className="h-px flex-1 bg-weave-500/40" />
      <span className="text-[11px] font-medium tracking-wide text-weave-400 uppercase">
        New messages
      </span>
      <span className="h-px flex-1 bg-weave-500/40" />
    </div>
  );
}
