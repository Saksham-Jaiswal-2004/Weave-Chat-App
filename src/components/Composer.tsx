'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { Avatar } from '@/components/Avatar';
import { EmojiPicker } from '@/components/EmojiPicker';
import { CloseIcon, SendIcon, SmileyIcon } from '@/components/Icons';
import { socket } from '@/lib/socket-client';
import { cn, parseMentions } from '@/lib/utils';
import { useChatStore } from '@/store/chat';
import { useSocketStore } from '@/store/socket';
import { MENTION_EVERYONE, type Conversation, type ReplySnapshot, type UserProfile } from '@/types';

const MAX_LENGTH = 4000;
/** Stop broadcasting "typing" once the keyboard goes quiet for this long. */
const TYPING_IDLE_MS = 2_500;

/** Everything after an "@" up to the caret, as long as it still looks like a name. */
const MENTION_QUERY = /(?:^|\s)@([^@\n]{0,24})$/;

interface ComposerProps {
  conversation: Conversation;
  viewerUid: string;
  replyTo: ReplySnapshot | null;
  onCancelReply: () => void;
  placeholder: string;
}

/** A mention candidate — either a real member or the group-wide broadcast. */
interface MentionOption {
  uid: string;
  label: string;
  hint: string;
  user?: UserProfile;
}

export function Composer({
  conversation,
  viewerUid,
  replyTo,
  onCancelReply,
  placeholder,
}: ComposerProps) {
  const conversationId = conversation.id;
  const users = useChatStore((state) => state.users);
  const status = useSocketStore((state) => state.status);

  const [draft, setDraft] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<{ at: number; term: string } | null>(null);
  const [highlighted, setHighlighted] = useState(0);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const offline = status !== 'ready';
  const isGroup = conversation.type === 'group';

  const members = useMemo(
    () => conversation.memberIds.map((uid) => users[uid]).filter(Boolean) as UserProfile[],
    [conversation.memberIds, users]
  );

  const mentionOptions = useMemo<MentionOption[]>(() => {
    if (!mentionQuery) return [];
    const term = mentionQuery.term.toLowerCase();

    const people = members
      .filter((member) => member.uid !== viewerUid)
      .filter((member) => member.displayName.toLowerCase().startsWith(term))
      .map((member) => ({
        uid: member.uid,
        label: member.displayName,
        hint: member.email ?? '',
        user: member,
      }));

    const everyone =
      isGroup && 'everyone'.startsWith(term)
        ? [{ uid: MENTION_EVERYONE, label: 'everyone', hint: 'Notify the whole group' }]
        : [];

    return [...everyone, ...people].slice(0, 6);
  }, [mentionQuery, members, viewerUid, isGroup]);

  const mentionOpen = mentionOptions.length > 0;

  // A fresh thread gets a fresh draft, and the caret lands in the box.
  useEffect(() => {
    setDraft('');
    setMentionQuery(null);
    setEmojiOpen(false);
    inputRef.current?.focus();
  }, [conversationId]);

  // Starting a reply should put the caret where the user is about to type.
  useEffect(() => {
    if (replyTo) inputRef.current?.focus();
  }, [replyTo]);

  // Never leave a stale "is typing…" behind when switching or unmounting.
  useEffect(() => {
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      socket.setTyping(conversationId, false);
    };
  }, [conversationId]);

  useEffect(() => setHighlighted(0), [mentionQuery?.term]);

  function detectMention(value: string, caret: number) {
    const match = value.slice(0, caret).match(MENTION_QUERY);
    if (!match) {
      setMentionQuery(null);
      return;
    }
    // Index of the "@" itself, so the whole token can be replaced on select.
    setMentionQuery({ at: caret - match[1].length - 1, term: match[1] });
  }

  function handleChange(value: string, caret: number) {
    const next = value.slice(0, MAX_LENGTH);
    setDraft(next);
    detectMention(next, Math.min(caret, next.length));

    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (next.trim()) {
      socket.setTyping(conversationId, true);
      idleTimer.current = setTimeout(() => socket.setTyping(conversationId, false), TYPING_IDLE_MS);
    } else {
      socket.setTyping(conversationId, false);
    }
  }

  function insertAtCaret(text: string) {
    const input = inputRef.current;
    const caret = input?.selectionStart ?? draft.length;
    const next = `${draft.slice(0, caret)}${text}${draft.slice(caret)}`.slice(0, MAX_LENGTH);

    setDraft(next);
    requestAnimationFrame(() => {
      input?.focus();
      const position = Math.min(caret + text.length, next.length);
      input?.setSelectionRange(position, position);
    });
  }

  function applyMention(option: MentionOption) {
    if (!mentionQuery) return;

    const before = draft.slice(0, mentionQuery.at);
    const after = draft.slice(mentionQuery.at + 1 + mentionQuery.term.length);
    const next = `${before}@${option.label} ${after}`.slice(0, MAX_LENGTH);
    const caret = (before + '@' + option.label + ' ').length;

    setDraft(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(caret, caret);
    });
  }

  function send() {
    const text = draft.trim();
    if (!text) return;

    // Mentions are re-derived from the final text, so deleting an "@Name" while
    // editing the draft correctly revokes it.
    const mentions = parseMentions(text, members, { allowEveryone: isGroup });

    socket.sendMessage(conversationId, text, { replyTo, mentions });

    setDraft('');
    setMentionQuery(null);
    onCancelReply();
    if (idleTimer.current) clearTimeout(idleTimer.current);
    inputRef.current?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlighted((index) => (index + 1) % mentionOptions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlighted((index) => (index - 1 + mentionOptions.length) % mentionOptions.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        applyMention(mentionOptions[highlighted]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMentionQuery(null);
        return;
      }
    }

    if (event.key === 'Escape' && replyTo) {
      event.preventDefault();
      onCancelReply();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  const remaining = MAX_LENGTH - draft.length;
  const replyAuthor = replyTo ? (users[replyTo.senderId]?.displayName ?? 'Someone') : '';

  return (
    <div className="border-t border-ink-800 bg-ink-900 px-3 py-3 sm:px-6 sm:py-4">
      {replyTo && (
        <div className="mb-2 flex items-start gap-2 rounded-xl border-l-2 border-weave-500 bg-ink-850 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-weave-400">Replying to {replyAuthor}</p>
            <p className="truncate text-xs text-mist-400">{replyTo.text || 'Deleted message'}</p>
          </div>
          <button
            type="button"
            onClick={onCancelReply}
            aria-label="Cancel reply"
            className="rounded-md p-1 text-mist-500 transition-colors hover:bg-ink-800 hover:text-mist-100"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="relative flex items-end gap-2">
        {mentionOpen && (
          <ul
            role="listbox"
            aria-label="Mention someone"
            className="absolute bottom-full left-0 z-30 mb-2 w-72 overflow-hidden rounded-xl border border-ink-700 bg-ink-800 py-1 shadow-2xl"
          >
            {mentionOptions.map((option, index) => (
              <li key={option.uid}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === highlighted}
                  onMouseDown={(event) => {
                    // mousedown, not click — the textarea must not lose the caret.
                    event.preventDefault();
                    applyMention(option);
                  }}
                  onMouseEnter={() => setHighlighted(index)}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors',
                    index === highlighted ? 'bg-ink-750' : 'hover:bg-ink-750'
                  )}
                >
                  {option.user ? (
                    <Avatar
                      name={option.user.displayName}
                      seed={option.uid}
                      photoURL={option.user.photoURL}
                      color={option.user.avatarColor}
                      size="sm"
                    />
                  ) : (
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-weave-500/20 text-xs font-semibold text-weave-400">
                      @
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{option.label}</span>
                    {option.hint && (
                      <span className="block truncate text-xs text-mist-500">{option.hint}</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="relative">
          <button
            type="button"
            onClick={() => setEmojiOpen((open) => !open)}
            aria-label="Insert emoji"
            aria-expanded={emojiOpen}
            className={cn(
              'flex h-11 w-11 items-center justify-center rounded-2xl transition-colors',
              emojiOpen ? 'bg-ink-750 text-mist-50' : 'text-mist-400 hover:bg-ink-800 hover:text-mist-100'
            )}
          >
            <SmileyIcon className="h-5 w-5" />
          </button>

          {emojiOpen && (
            <EmojiPicker
              align="left"
              onSelect={(char) => insertAtCaret(char)}
              onClose={() => setEmojiOpen(false)}
            />
          )}
        </div>

        <div className="flex-1 rounded-2xl border border-ink-700 bg-ink-800 focus-within:border-weave-500/70">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(event) => handleChange(event.target.value, event.target.selectionStart)}
            onKeyUp={(event) => detectMention(draft, event.currentTarget.selectionStart)}
            onClick={(event) => detectMention(draft, event.currentTarget.selectionStart)}
            onBlur={() => socket.setTyping(conversationId, false)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={placeholder}
            aria-label="Message"
            className="composer-input scroll-slim max-h-40 w-full resize-none bg-transparent px-4 py-3 text-[15px] leading-relaxed text-mist-50 placeholder:text-mist-500 focus:outline-none"
          />
        </div>

        <button
          type="button"
          onClick={send}
          disabled={!draft.trim()}
          aria-label="Send message"
          className={cn(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl transition-colors',
            draft.trim() ? 'bg-weave-500 text-white hover:bg-weave-600' : 'bg-ink-800 text-mist-500'
          )}
        >
          <SendIcon className="h-[18px] w-[18px]" />
        </button>
      </div>

      <div className="mt-1.5 flex h-4 items-center justify-between px-1 text-[11px] text-mist-500">
        <span>
          {offline
            ? 'Offline — your message will send once you reconnect.'
            : isGroup
              ? 'Enter to send · @ to mention · Shift + Enter for a new line'
              : 'Enter to send · Shift + Enter for a new line'}
        </span>
        {remaining < 200 && <span>{remaining}</span>}
      </div>
    </div>
  );
}
