import {
  AVATAR_COLORS,
  MENTION_EVERYONE,
  type AvatarColor,
  type Conversation,
  type Message,
  type UserProfile,
} from '@/types';

export function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((part) => part[0] ?? '').join('');
  return (letters || name[0] || '?').toUpperCase();
}

/** The avatar palette, keyed by the name stored on the profile. */
export const AVATAR_TINTS: Record<AvatarColor, string> = {
  indigo: 'bg-[#5865f2]',
  green: 'bg-[#3ba55d]',
  orange: 'bg-[#e0713c]',
  pink: 'bg-[#c0428f]',
  teal: 'bg-[#0f8a8a]',
  violet: 'bg-[#8b5cf6]',
  red: 'bg-[#d83c3e]',
  amber: 'bg-[#b58a24]',
};

/** Deterministic fallback so the same person keeps the same colour everywhere. */
export function tintFor(seed: string, chosen?: AvatarColor | null) {
  if (chosen && AVATAR_TINTS[chosen]) return AVATAR_TINTS[chosen];

  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[AVATAR_COLORS[hash % AVATAR_COLORS.length]];
}

/* ----------------------------------------------------------- conversations */

export function otherMemberId(conversation: Conversation, viewerUid: string) {
  return conversation.memberIds.find((uid) => uid !== viewerUid) ?? viewerUid;
}

/** DMs borrow the other person's name; groups carry their own. */
export function conversationTitle(
  conversation: Conversation,
  viewerUid: string,
  users: Record<string, UserProfile>
) {
  if (conversation.type === 'group') return conversation.name ?? 'Group';
  const other = users[otherMemberId(conversation, viewerUid)];
  return other?.displayName ?? 'Direct message';
}

export function conversationSeed(conversation: Conversation, viewerUid: string) {
  return conversation.type === 'group'
    ? conversation.id
    : otherMemberId(conversation, viewerUid);
}

export function isGroupAdmin(conversation: Conversation, uid: string) {
  return conversation.type === 'group' && (conversation.admins ?? []).includes(uid);
}

export function isMuted(conversation: Conversation, uid: string) {
  return Boolean(conversation.muted?.[uid]);
}

export function unreadFor(conversation: Conversation, uid: string) {
  return conversation.unread?.[uid] ?? 0;
}

export function unreadMentionsFor(conversation: Conversation, uid: string) {
  return conversation.unreadMentions?.[uid] ?? 0;
}

/* --------------------------------------------------------------- receipts */

export type Receipt = 'sent' | 'delivered' | 'seen';

/**
 * Derived rather than stored per message: the conversation carries one timestamp
 * per member, and any message older than that timestamp has been read. That keeps
 * receipts to a single document write per read instead of one per message.
 */
export function receiptFor(
  conversation: Conversation,
  message: Message,
  viewerUid: string
): Receipt {
  const others = conversation.memberIds.filter((uid) => uid !== viewerUid);
  if (others.length === 0) return 'sent';

  const readBy = (uid: string) => (conversation.reads?.[uid] ?? 0) >= message.createdAt;
  const gotBy = (uid: string) => (conversation.delivered?.[uid] ?? 0) >= message.createdAt;

  if (others.every(readBy)) return 'seen';
  // In a group, one member receiving it is enough to call it delivered.
  if (others.some((uid) => gotBy(uid) || readBy(uid))) return 'delivered';
  return 'sent';
}

/** Who has read a given message — used for the "seen by" detail in groups. */
export function seenBy(conversation: Conversation, message: Message, viewerUid: string) {
  return conversation.memberIds.filter(
    (uid) => uid !== viewerUid && (conversation.reads?.[uid] ?? 0) >= message.createdAt
  );
}

/* --------------------------------------------------------------- mentions */

const EVERYONE_ALIASES = ['everyone', 'all', 'channel'];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Mentions are derived from the message text rather than tracked as the user types,
 * so editing or deleting the "@Name" naturally revokes the mention.
 */
function mentionPattern(names: string[]) {
  const alternatives = [...names]
    .filter(Boolean)
    // Longest first so "@Ada Lovelace" wins over a member also called "@Ada".
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);

  return new RegExp(`@(${[...EVERYONE_ALIASES, ...alternatives].join('|')})\\b`, 'gi');
}

/** Resolves "@Name" text into member uids. Groups also accept "@everyone". */
export function parseMentions(
  text: string,
  members: UserProfile[],
  { allowEveryone }: { allowEveryone: boolean }
): string[] {
  if (!text.includes('@')) return [];

  const byName = new Map(members.map((member) => [member.displayName.toLowerCase(), member.uid]));
  const found = new Set<string>();

  for (const match of text.matchAll(mentionPattern([...byName.keys()]))) {
    const label = match[1].toLowerCase();

    if (EVERYONE_ALIASES.includes(label)) {
      if (allowEveryone) found.add(MENTION_EVERYONE);
      continue;
    }
    const uid = byName.get(label);
    if (uid) found.add(uid);
  }

  return [...found];
}

export type TextSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; value: string; uid: string | null };

/** Splits body text so mentions can be rendered as chips. */
export function mentionSegments(text: string, members: UserProfile[]): TextSegment[] {
  if (!text.includes('@')) return [{ type: 'text', value: text }];

  const byName = new Map(members.map((member) => [member.displayName.toLowerCase(), member.uid]));
  const pattern = mentionPattern([...byName.keys()]);

  const segments: TextSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ type: 'text', value: text.slice(cursor, start) });

    const label = match[1].toLowerCase();
    segments.push({
      type: 'mention',
      value: match[0],
      uid: EVERYONE_ALIASES.includes(label) ? MENTION_EVERYONE : (byName.get(label) ?? null),
    });
    cursor = start + match[0].length;
  }

  if (cursor < text.length) segments.push({ type: 'text', value: text.slice(cursor) });
  return segments;
}

/** True when the viewer is personally addressed — these pierce a muted thread. */
export function mentionsViewer(message: Message, viewerUid: string) {
  const mentions = message.mentions ?? [];
  return mentions.includes(viewerUid) || mentions.includes(MENTION_EVERYONE);
}

/* ------------------------------------------------------------------ dates */

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const dateFormat = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function startOfDay(value: number) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function formatTime(timestamp: number) {
  return timeFormat.format(timestamp);
}

export function sameDay(a: number, b: number) {
  return startOfDay(a) === startOfDay(b);
}

/** "Today" / "Yesterday" / weekday within the last week / absolute date. */
export function formatDayLabel(timestamp: number) {
  const today = startOfDay(Date.now());
  const day = startOfDay(timestamp);
  const daysAgo = Math.round((today - day) / 86_400_000);

  if (daysAgo === 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';
  if (daysAgo < 7) return weekdayFormat.format(timestamp);
  return dateFormat.format(timestamp);
}

/** Compact stamp for the sidebar preview. */
export function formatRelative(timestamp: number) {
  if (!timestamp) return '';
  const daysAgo = Math.round((startOfDay(Date.now()) - startOfDay(timestamp)) / 86_400_000);

  if (daysAgo === 0) return timeFormat.format(timestamp);
  if (daysAgo === 1) return 'Yesterday';
  if (daysAgo < 7) return weekdayFormat.format(timestamp);
  return dateFormat.format(timestamp);
}
