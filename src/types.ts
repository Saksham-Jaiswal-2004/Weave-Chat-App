export type ConversationType = 'dm' | 'group';

/** The avatar palette. Stored by name so the rendered colour can change safely. */
export const AVATAR_COLORS = [
  'indigo',
  'green',
  'orange',
  'pink',
  'teal',
  'violet',
  'red',
  'amber',
] as const;

export type AvatarColor = (typeof AVATAR_COLORS)[number];

export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string;
  photoURL: string | null;
  /** Null means "derive one from the uid", which is the default. */
  avatarColor: AvatarColor | null;
  createdAt: number;
  lastSeenAt: number;
}

export interface LastMessage {
  id: string;
  senderId: string;
  text: string;
  createdAt: number;
}

/** uid -> value. Kept as maps on the conversation so a read costs one doc write. */
export type MemberMap<T> = Record<string, T>;

export interface Conversation {
  id: string;
  type: ConversationType;
  /** null for DMs — the title is derived from the other member. */
  name: string | null;
  memberIds: string[];
  /** Groups only. The creator starts as the sole admin. */
  admins: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  lastMessage: LastMessage | null;

  /** Newest message timestamp each member has read. */
  reads: MemberMap<number>;
  /** Newest message timestamp each member's client has received. */
  delivered: MemberMap<number>;
  /** Unread counters, maintained server-side so they survive a reload. */
  unread: MemberMap<number>;
  /** Unread messages that mention the member — these pierce a mute. */
  unreadMentions: MemberMap<number>;
  /** Members who have muted notifications for this thread. */
  muted: MemberMap<boolean>;
}

export type MessageStatus = 'sent' | 'pending' | 'failed';

/** What a message quotes when it is a reply — snapshotted so edits cannot rewrite it. */
export interface ReplySnapshot {
  id: string;
  senderId: string;
  text: string;
}

/** emoji -> the uids who reacted with it. */
export type Reactions = Record<string, string[]>;

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  createdAt: number;

  editedAt?: number;
  /** Soft delete: the row stays so ordering holds, but the text is gone. */
  deletedAt?: number;
  replyTo?: ReplySnapshot | null;
  /** uids, or MENTION_EVERYONE for a broadcast to the whole group. */
  mentions?: string[];
  reactions?: Reactions;

  /** Present on optimistic messages so the server echo can be reconciled. */
  clientId?: string;
  status?: MessageStatus;
}

export const MENTION_EVERYONE = '*';

/* ---------- websocket protocol ---------- */

export type ClientEvent =
  | { type: 'auth'; token: string }
  | { type: 'ping' }
  | {
      type: 'message:send';
      conversationId: string;
      text: string;
      clientId: string;
      replyToId?: string;
      mentions?: string[];
    }
  | { type: 'message:edit'; conversationId: string; messageId: string; text: string }
  | { type: 'message:delete'; conversationId: string; messageId: string }
  | { type: 'message:react'; conversationId: string; messageId: string; emoji: string }
  | { type: 'read'; conversationId: string; upTo: number }
  /** "My client now holds these messages" — drives the second tick. */
  | { type: 'delivered'; entries: { conversationId: string; upTo: number }[] }
  | { type: 'typing'; conversationId: string; isTyping: boolean };

export type ServerEvent =
  | { type: 'auth:ok'; userId: string; onlineUserIds: string[] }
  | { type: 'auth:error'; code: 'invalid-token' | 'expired-token' | 'missing-token'; message: string }
  | { type: 'pong' }
  | { type: 'error'; message: string; clientId?: string }
  | { type: 'message:new'; message: Message }
  | { type: 'message:rejected'; conversationId: string; clientId: string; reason: string }
  | { type: 'message:updated'; message: Message }
  | { type: 'message:deleted'; conversationId: string; messageId: string; deletedAt: number }
  | { type: 'message:reaction'; conversationId: string; messageId: string; reactions: Reactions }
  | {
      type: 'receipts';
      conversationId: string;
      reads: MemberMap<number>;
      delivered: MemberMap<number>;
    }
  | { type: 'unread'; conversationId: string; unread: number; unreadMentions: number }
  | { type: 'conversation:upsert'; conversation: Conversation; members: UserProfile[] }
  | {
      type: 'conversation:touch';
      conversationId: string;
      lastMessage: LastMessage;
      updatedAt: number;
    }
  | { type: 'conversation:removed'; conversationId: string }
  | { type: 'typing'; conversationId: string; userId: string; isTyping: boolean }
  | { type: 'presence'; userId: string; online: boolean };
