'use client';

import { useEffect, useRef, useState } from 'react';

import { Avatar } from '@/components/Avatar';
import { EmojiPicker } from '@/components/EmojiPicker';
import {
  CheckIcon,
  DoubleCheckIcon,
  PencilIcon,
  ReactionIcon,
  ReplyIcon,
  RetryIcon,
  TrashIcon,
} from '@/components/Icons';
import { emojiName } from '@/lib/emoji';
import { socket } from '@/lib/socket-client';
import {
  cn,
  formatTime,
  isGroupAdmin,
  mentionSegments,
  mentionsViewer,
  receiptFor,
  seenBy,
} from '@/lib/utils';
import type { Conversation, Message, UserProfile } from '@/types';

/** Stable per message so a reply can find its target with `getElementById`. */
export function messageRowId(conversationId: string, messageId: string) {
  return `weave-msg-${conversationId}-${messageId}`;
}

export interface MessageBubbleProps {
  conversation: Conversation;
  message: Message;
  viewerUid: string;
  /** Profile cache — reply authors and reactors are named from it. */
  users: Record<string, UserProfile>;
  /** Member profiles, for resolving "@Name" back into a chip. */
  members: UserProfile[];
  mine: boolean;
  /** Part of a run from the same sender: no avatar, no name, tighter spacing. */
  grouped: boolean;
  /** Groups label every run; DMs never need to. */
  showAuthor: boolean;
  /** A reply just jumped here — flash so the eye can find it. */
  flashing: boolean;
  onReply: (message: Message) => void;
  onJumpTo: (messageId: string) => void;
}

const TOOLBAR_BUTTON =
  'flex h-7 w-7 items-center justify-center rounded-lg text-mist-400 transition-colors hover:bg-ink-750 hover:text-mist-50 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none motion-reduce:transition-none';

export function MessageBubble({
  conversation,
  message,
  viewerUid,
  users,
  members,
  mine,
  grouped,
  showAuthor,
  flashing,
  onReply,
  onJumpTo,
}: MessageBubbleProps) {
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const author = users[message.senderId];
  const name = author?.displayName ?? 'Someone';

  const deleted = Boolean(message.deletedAt);
  const pending = message.status === 'pending';
  const failed = message.status === 'failed';

  // An unacknowledged message has no server id yet, so nothing can act on it.
  const settled = !deleted && !pending && !failed;
  const canDelete = settled && (mine || isGroupAdmin(conversation, viewerUid));
  const highlighted = !mine && !deleted && mentionsViewer(message, viewerUid);

  // A menu left open on a message that just got deleted elsewhere would strand the UI.
  useEffect(() => {
    if (deleted) {
      setEditing(false);
      setPicking(false);
      setConfirmingDelete(false);
    }
  }, [deleted]);

  function react(emoji: string) {
    setPicking(false);
    socket.toggleReaction(conversation.id, message.id, emoji);
  }

  const toolbar = settled && !editing && (
    <div
      className={cn(
        'flex items-center gap-0.5 self-center rounded-xl border border-ink-700 bg-ink-800/95 p-0.5 shadow-lg backdrop-blur transition-opacity motion-reduce:transition-none',
        // Hover is a convenience; focus-within is what keeps it keyboard reachable.
        'opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100',
        (picking || confirmingDelete) && 'opacity-100',
        mine ? 'order-first' : 'order-last'
      )}
    >
      <div className="relative">
        <button
          type="button"
          aria-label="Add a reaction"
          aria-expanded={picking}
          title="React"
          onClick={() => setPicking((open) => !open)}
          className={cn(TOOLBAR_BUTTON, picking && 'bg-ink-750 text-mist-50')}
        >
          <ReactionIcon className="h-4 w-4" />
        </button>
        {picking && (
          <EmojiPicker
            onSelect={react}
            onClose={() => setPicking(false)}
            align={mine ? 'right' : 'left'}
          />
        )}
      </div>

      <button
        type="button"
        aria-label="Reply to this message"
        title="Reply"
        onClick={() => onReply(message)}
        className={TOOLBAR_BUTTON}
      >
        <ReplyIcon className="h-4 w-4" />
      </button>

      {mine && (
        <button
          type="button"
          aria-label="Edit this message"
          title="Edit"
          onClick={() => setEditing(true)}
          className={TOOLBAR_BUTTON}
        >
          <PencilIcon className="h-4 w-4" />
        </button>
      )}

      {canDelete && (
        <button
          type="button"
          aria-label="Delete this message"
          title="Delete"
          onClick={() => setConfirmingDelete(true)}
          className={cn(TOOLBAR_BUTTON, 'hover:text-red-300')}
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      )}
    </div>
  );

  return (
    <div
      id={messageRowId(conversation.id, message.id)}
      tabIndex={-1}
      className={cn(
        'message-enter group/message flex items-end gap-2 focus:outline-none',
        mine ? 'justify-end' : 'justify-start',
        grouped ? 'mt-0.5' : 'mt-3'
      )}
    >
      {!mine &&
        (grouped ? (
          <span className="w-8 shrink-0" aria-hidden />
        ) : (
          <Avatar
            name={name}
            seed={message.senderId}
            photoURL={author?.photoURL}
            color={author?.avatarColor}
            size="sm"
          />
        ))}

      <div className={cn('flex min-w-0 max-w-[min(85%,42rem)] flex-col', mine && 'items-end')}>
        {!mine && !grouped && showAuthor && (
          <span className="mb-1 ml-1 text-xs font-medium text-mist-400">{name}</span>
        )}

        {!deleted && message.replyTo && (
          <button
            type="button"
            onClick={() => onJumpTo(message.replyTo?.id ?? '')}
            className="mb-1 max-w-full rounded-lg rounded-l-sm border-l-2 border-weave-500/70 bg-ink-750/70 py-1 pr-2.5 pl-2 text-left transition-colors hover:bg-ink-700 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none motion-reduce:transition-none"
          >
            <span className="block text-[11px] font-medium text-weave-400">
              {users[message.replyTo.senderId]?.displayName ?? 'Someone'}
            </span>
            <span className="block truncate text-xs text-mist-400">
              {message.replyTo.text || 'Message unavailable'}
            </span>
          </button>
        )}

        {editing ? (
          <MessageEditor
            message={message}
            onDone={() => setEditing(false)}
          />
        ) : (
          <div
            className={cn(
              'rounded-bubble px-3.5 py-2 text-[15px] leading-relaxed break-words whitespace-pre-wrap',
              mine ? 'rounded-br-md' : 'rounded-bl-md',
              deleted
                ? 'bg-ink-850 text-mist-500 italic ring-1 ring-ink-750'
                : mine
                  ? 'bg-weave-500 text-white'
                  : 'bg-ink-800 text-mist-50',
              // A mention in a busy group has to survive a fast scroll.
              highlighted && 'bg-ink-750 ring-1 ring-weave-500/40',
              pending && 'opacity-70',
              failed && 'bg-signal-danger/20 text-red-100 ring-1 ring-signal-danger/40',
              flashing && 'ring-2 ring-weave-400/70'
            )}
          >
            {deleted ? (
              'This message was deleted.'
            ) : (
              <MessageText text={message.text} members={members} mine={mine} />
            )}
          </div>
        )}

        {!deleted && !editing && (
          <ReactionRow
            conversation={conversation}
            message={message}
            viewerUid={viewerUid}
            users={users}
            mine={mine}
          />
        )}

        {confirmingDelete && (
          <DeleteConfirm
            onConfirm={() => {
              setConfirmingDelete(false);
              socket.deleteMessage(conversation.id, message.id);
            }}
            onCancel={() => setConfirmingDelete(false)}
          />
        )}

        <div
          className={cn(
            'mt-1 flex items-center gap-1.5 px-1 text-[11px] text-mist-500',
            mine && 'flex-row-reverse'
          )}
        >
          <time dateTime={new Date(message.createdAt).toISOString()}>
            {formatTime(message.createdAt)}
          </time>

          {!deleted && message.editedAt && <span title="This message was edited">(edited)</span>}

          {mine && !deleted && !pending && !failed && (
            <ReadReceipt
              conversation={conversation}
              message={message}
              viewerUid={viewerUid}
              users={users}
            />
          )}

          {pending && <span>Sending…</span>}
          {failed && (
            <button
              type="button"
              onClick={() => socket.retryMessage(message)}
              className="flex items-center gap-1 font-medium text-red-300 hover:text-red-200 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none"
            >
              <RetryIcon className="h-3 w-3" />
              Retry
            </button>
          )}
        </div>
      </div>

      {toolbar}
    </div>
  );
}

/* ------------------------------------------------------------------- text */

/** Body text with "@Name" lifted out into chips. */
function MessageText({
  text,
  members,
  mine,
}: {
  text: string;
  members: UserProfile[];
  mine: boolean;
}) {
  return (
    <>
      {mentionSegments(text, members).map((segment, index) =>
        segment.type === 'mention' ? (
          <span
            key={index}
            className={cn(
              'rounded px-1 font-medium',
              mine ? 'bg-white/20 text-white' : 'bg-weave-500/20 text-weave-400'
            )}
          >
            {segment.value}
          </span>
        ) : (
          <span key={index}>{segment.value}</span>
        )
      )}
    </>
  );
}

/* --------------------------------------------------------------- receipts */

function ReadReceipt({
  conversation,
  message,
  viewerUid,
  users,
}: {
  conversation: Conversation;
  message: Message;
  viewerUid: string;
  users: Record<string, UserProfile>;
}) {
  // One tick sent, two ticks delivered, two blue ticks read.
  const state = receiptFor(conversation, message, viewerUid);
  const Icon = state === 'sent' ? CheckIcon : DoubleCheckIcon;

  // One tick means little in a group, so name the readers rather than the state.
  const readers = conversation.type === 'group' ? seenBy(conversation, message, viewerUid) : [];
  const label = readers.length
    ? `Seen by ${readers.map((uid) => users[uid]?.displayName ?? 'Someone').join(', ')}`
    : state === 'sent'
      ? 'Sent'
      : state === 'delivered'
        ? 'Delivered'
        : 'Seen';

  return (
    <span
      role="img"
      title={label}
      aria-label={label}
      className={cn('inline-flex', state === 'seen' ? 'text-signal-read' : 'text-mist-500')}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
    </span>
  );
}

/* -------------------------------------------------------------- reactions */

function ReactionRow({
  conversation,
  message,
  viewerUid,
  users,
  mine,
}: {
  conversation: Conversation;
  message: Message;
  viewerUid: string;
  users: Record<string, UserProfile>;
  mine: boolean;
}) {
  const entries = Object.entries(message.reactions ?? {}).filter(([, uids]) => uids.length > 0);
  if (entries.length === 0) return null;

  return (
    <div className={cn('mt-1 flex flex-wrap gap-1', mine && 'justify-end')}>
      {entries.map(([emoji, uids]) => {
        const active = uids.includes(viewerUid);
        const who = uids.map((uid) => users[uid]?.displayName ?? 'Someone').join(', ');
        const label = emojiName(emoji) || emoji;

        return (
          <button
            key={emoji}
            type="button"
            title={`${who} reacted with ${label}`}
            aria-label={`${active ? 'Remove' : 'Add'} ${label} reaction`}
            aria-pressed={active}
            onClick={() => socket.toggleReaction(conversation.id, message.id, emoji)}
            className={cn(
              'flex items-center gap-1 rounded-full px-2 py-0.5 text-xs leading-5 transition-colors focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none motion-reduce:transition-none',
              active
                ? 'bg-weave-500/20 text-mist-50 ring-1 ring-weave-500/40'
                : 'bg-ink-800 text-mist-400 hover:bg-ink-750'
            )}
          >
            <span aria-hidden>{emoji}</span>
            <span className="tabular-nums">{uids.length}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ edit */

function MessageEditor({ message, onDone }: { message: Message; onDone: () => void }) {
  const [draft, setDraft] = useState(message.text);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);

  function save() {
    const body = draft.trim();
    // An unchanged or emptied draft is a cancel — deleting is its own action.
    if (body && body !== message.text) {
      socket.editMessage(message.conversationId, message.id, body);
    }
    onDone();
  }

  return (
    <div className="w-full min-w-[16rem]">
      <textarea
        ref={ref}
        value={draft}
        rows={1}
        aria-label="Edit message"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onDone();
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            save();
          }
        }}
        className="composer-input scroll-slim max-h-40 w-full resize-none rounded-bubble border border-weave-500 bg-ink-850 px-3.5 py-2 text-[15px] leading-relaxed text-mist-50 focus:outline-none"
      />
      <p className="mt-1 px-1 text-[11px] text-mist-500">
        Enter to save · Escape to cancel ·{' '}
        <button
          type="button"
          onClick={onDone}
          className="font-medium text-mist-400 underline underline-offset-2 hover:text-mist-200 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none"
        >
          cancel
        </button>
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- delete */

function DeleteConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div
      role="group"
      aria-label="Confirm delete"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
      className="mt-1.5 flex items-center gap-2 rounded-xl border border-ink-700 bg-ink-800 px-2.5 py-1.5 text-xs"
    >
      <span className="text-mist-400">Delete this message?</span>
      <button
        ref={ref}
        type="button"
        onClick={onConfirm}
        className="rounded-md bg-signal-danger/20 px-2 py-0.5 font-medium text-red-200 transition-colors hover:bg-signal-danger/30 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none motion-reduce:transition-none"
      >
        Delete
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md px-2 py-0.5 font-medium text-mist-400 transition-colors hover:bg-ink-750 hover:text-mist-200 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none motion-reduce:transition-none"
      >
        Cancel
      </button>
    </div>
  );
}
