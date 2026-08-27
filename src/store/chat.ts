'use client';

import { create } from 'zustand';

import type { Conversation, LastMessage, MemberMap, Message, Reactions, UserProfile } from '@/types';

/**
 * The single client-side cache. Every render path reads from here, so a socket
 * frame lands in the store and the affected components re-render immediately —
 * no refetch, no revalidation round trip.
 *
 * Read state (reads / delivered / unread) lives on the conversation objects rather
 * than in a parallel structure, so there is exactly one source of truth and the
 * server stays authoritative over counts.
 */

export type ThreadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ThreadState {
  status: ThreadStatus;
  hasMore: boolean;
  loadingMore: boolean;
  error: string | null;
}

const EMPTY_THREAD: ThreadState = { status: 'idle', hasMore: false, loadingMore: false, error: null };

export const TYPING_TTL_MS = 6_000;

interface ChatState {
  conversations: Conversation[];
  conversationsStatus: ThreadStatus;
  conversationsError: string | null;

  users: Record<string, UserProfile>;
  online: Record<string, boolean>;

  messages: Record<string, Message[]>;
  threads: Record<string, ThreadState>;

  /** conversationId -> uid -> expiry timestamp */
  typing: Record<string, Record<string, number>>;

  /**
   * Snapshot of the viewer's read position taken when a thread is opened, so the
   * "new messages" divider stays put instead of sliding as the thread is read.
   */
  readMarkers: Record<string, number>;

  activeConversationId: string | null;

  reset: () => void;
  cacheUsers: (users: UserProfile[]) => void;

  setConversations: (input: {
    conversations: Conversation[];
    users: UserProfile[];
    onlineUserIds: string[];
  }) => void;
  setConversationsStatus: (status: ThreadStatus, error?: string | null) => void;
  upsertConversation: (conversation: Conversation, users?: UserProfile[]) => void;
  patchConversation: (conversationId: string, patch: Partial<Conversation>) => void;
  removeConversation: (conversationId: string) => void;
  touchConversation: (conversationId: string, lastMessage: LastMessage, updatedAt: number) => void;

  applyReceipts: (
    conversationId: string,
    reads: MemberMap<number>,
    delivered: MemberMap<number>
  ) => void;
  applyUnread: (
    conversationId: string,
    viewerUid: string,
    unread: number,
    unreadMentions: number
  ) => void;

  setPresence: (userId: string, online: boolean) => void;
  resetPresence: (userIds: string[]) => void;

  setActiveConversation: (conversationId: string | null) => void;
  captureReadMarker: (conversationId: string, viewerUid: string) => void;
  setThreadStatus: (conversationId: string, patch: Partial<ThreadState>) => void;
  setMessages: (conversationId: string, messages: Message[], hasMore: boolean) => void;
  prependMessages: (conversationId: string, messages: Message[], hasMore: boolean) => void;

  addOptimisticMessage: (message: Message) => void;
  commitMessage: (message: Message) => void;
  updateMessage: (message: Message) => void;
  markMessageDeleted: (conversationId: string, messageId: string, deletedAt: number) => void;
  setReactions: (conversationId: string, messageId: string, reactions: Reactions) => void;
  toggleReactionLocal: (
    conversationId: string,
    messageId: string,
    uid: string,
    emoji: string
  ) => void;
  applyEditLocal: (conversationId: string, messageId: string, text: string) => void;
  failMessage: (conversationId: string, clientId: string) => void;
  removeMessage: (conversationId: string, messageId: string) => void;

  setTyping: (conversationId: string, userId: string, isTyping: boolean) => void;
  pruneTyping: () => void;
}

function byNewest(a: Conversation, b: Conversation) {
  return b.updatedAt - a.updatedAt;
}

function indexUsers(users: UserProfile[]) {
  const next: Record<string, UserProfile> = {};
  for (const user of users) next[user.uid] = user;
  return next;
}

/** Keeps a thread ordered even if a socket frame and a fetch page interleave. */
function sortMessages(messages: Message[]) {
  return [...messages].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/**
 * An optimistic message and its persisted twin share a sender and a body but not an
 * id, and their timestamps differ by the send latency plus any clock skew — hence a
 * generous window rather than an equality check.
 */
const RECONCILE_WINDOW_MS = 120_000;

function reconcileIndex(messages: Message[]) {
  const index = new Map<string, number[]>();
  for (const message of messages) {
    const key = `${message.senderId} ${message.text}`;
    const bucket = index.get(key);
    if (bucket) bucket.push(message.createdAt);
    else index.set(key, [message.createdAt]);
  }
  return index;
}

function alreadyLanded(index: Map<string, number[]>, message: Message) {
  const bucket = index.get(`${message.senderId} ${message.text}`);
  return Boolean(bucket?.some((at) => Math.abs(at - message.createdAt) < RECONCILE_WINDOW_MS));
}

/** Applies a change to one message in one thread, leaving other threads untouched. */
function mapThread(
  state: ChatState,
  conversationId: string,
  messageId: string,
  change: (message: Message) => Message
) {
  const existing = state.messages[conversationId];
  if (!existing) return null;

  let touched = false;
  const next = existing.map((message) => {
    if (message.id !== messageId) return message;
    touched = true;
    return change(message);
  });

  return touched ? next : null;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  conversationsStatus: 'idle',
  conversationsError: null,
  users: {},
  online: {},
  messages: {},
  threads: {},
  typing: {},
  readMarkers: {},
  activeConversationId: null,

  reset: () =>
    set({
      conversations: [],
      conversationsStatus: 'idle',
      conversationsError: null,
      users: {},
      online: {},
      messages: {},
      threads: {},
      typing: {},
      readMarkers: {},
      activeConversationId: null,
    }),

  cacheUsers: (users) =>
    set((state) => (users.length ? { users: { ...state.users, ...indexUsers(users) } } : state)),

  setConversations: ({ conversations, users, onlineUserIds }) =>
    set((state) => ({
      conversations: [...conversations].sort(byNewest),
      conversationsStatus: 'ready',
      conversationsError: null,
      users: { ...state.users, ...indexUsers(users) },
      online: Object.fromEntries(onlineUserIds.map((uid) => [uid, true])),
    })),

  setConversationsStatus: (status, error = null) =>
    set({ conversationsStatus: status, conversationsError: error }),

  upsertConversation: (conversation, users = []) =>
    set((state) => {
      const rest = state.conversations.filter((item) => item.id !== conversation.id);
      return {
        conversations: [...rest, conversation].sort(byNewest),
        users: users.length ? { ...state.users, ...indexUsers(users) } : state.users,
      };
    }),

  patchConversation: (conversationId, patch) =>
    set((state) => {
      const existing = state.conversations.find((item) => item.id === conversationId);
      if (!existing) return state;

      return {
        conversations: [
          ...state.conversations.filter((item) => item.id !== conversationId),
          { ...existing, ...patch },
        ].sort(byNewest),
      };
    }),

  removeConversation: (conversationId) =>
    set((state) => {
      const { [conversationId]: _messages, ...messages } = state.messages;
      const { [conversationId]: _thread, ...threads } = state.threads;
      const { [conversationId]: _typing, ...typing } = state.typing;
      const { [conversationId]: _marker, ...readMarkers } = state.readMarkers;

      return {
        conversations: state.conversations.filter((item) => item.id !== conversationId),
        messages,
        threads,
        typing,
        readMarkers,
        activeConversationId:
          state.activeConversationId === conversationId ? null : state.activeConversationId,
      };
    }),

  touchConversation: (conversationId, lastMessage, updatedAt) =>
    get().patchConversation(conversationId, { lastMessage, updatedAt }),

  applyReceipts: (conversationId, reads, delivered) =>
    set((state) => {
      const existing = state.conversations.find((item) => item.id === conversationId);
      if (!existing) return state;

      return {
        conversations: state.conversations.map((item) =>
          item.id === conversationId ? { ...item, reads, delivered } : item
        ),
      };
    }),

  applyUnread: (conversationId, viewerUid, unread, unreadMentions) =>
    set((state) => {
      const existing = state.conversations.find((item) => item.id === conversationId);
      if (!existing) return state;

      return {
        conversations: state.conversations.map((item) =>
          item.id === conversationId
            ? {
                ...item,
                unread: { ...item.unread, [viewerUid]: unread },
                unreadMentions: { ...item.unreadMentions, [viewerUid]: unreadMentions },
              }
            : item
        ),
      };
    }),

  setPresence: (userId, online) =>
    set((state) =>
      Boolean(state.online[userId]) === online
        ? state
        : { online: { ...state.online, [userId]: online } }
    ),

  resetPresence: (userIds) => set({ online: Object.fromEntries(userIds.map((uid) => [uid, true])) }),

  setActiveConversation: (conversationId) => set({ activeConversationId: conversationId }),

  captureReadMarker: (conversationId, viewerUid) =>
    set((state) => {
      const conversation = state.conversations.find((item) => item.id === conversationId);
      return {
        readMarkers: {
          ...state.readMarkers,
          [conversationId]: conversation?.reads?.[viewerUid] ?? 0,
        },
      };
    }),

  setThreadStatus: (conversationId, patch) =>
    set((state) => ({
      threads: {
        ...state.threads,
        [conversationId]: { ...EMPTY_THREAD, ...state.threads[conversationId], ...patch },
      },
    })),

  setMessages: (conversationId, messages, hasMore) =>
    set((state) => {
      // Preserve optimistic bubbles that have not been acknowledged — but drop any
      // whose message clearly did land. A send that was persisted just as the socket
      // dropped has no ack, so without this the reconnect refetch would show it
      // twice: once for real, once as a phantom "failed" bubble.
      const landed = reconcileIndex(messages);

      const pending = (state.messages[conversationId] ?? []).filter(
        (message) =>
          (message.status === 'pending' || message.status === 'failed') &&
          !alreadyLanded(landed, message)
      );

      return {
        messages: { ...state.messages, [conversationId]: sortMessages([...messages, ...pending]) },
        threads: {
          ...state.threads,
          [conversationId]: { ...EMPTY_THREAD, status: 'ready', hasMore },
        },
      };
    }),

  prependMessages: (conversationId, messages, hasMore) =>
    set((state) => {
      const existing = state.messages[conversationId] ?? [];
      const known = new Set(existing.map((message) => message.id));
      const fresh = messages.filter((message) => !known.has(message.id));

      return {
        messages: { ...state.messages, [conversationId]: sortMessages([...fresh, ...existing]) },
        threads: {
          ...state.threads,
          [conversationId]: {
            ...EMPTY_THREAD,
            ...state.threads[conversationId],
            hasMore,
            loadingMore: false,
          },
        },
      };
    }),

  addOptimisticMessage: (message) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [message.conversationId]: [...(state.messages[message.conversationId] ?? []), message],
      },
    })),

  /**
   * Reconciles a server message with the local list. The sender's own echo carries
   * `clientId`, so the optimistic bubble is replaced in place rather than doubled.
   * Unread counting is deliberately NOT done here — the server owns those numbers.
   */
  commitMessage: (message) =>
    set((state) => {
      const existing = state.messages[message.conversationId] ?? [];
      const confirmed: Message = { ...message, status: 'sent' };

      let next: Message[];
      const optimisticIndex = message.clientId
        ? existing.findIndex((item) => item.clientId === message.clientId)
        : -1;

      if (optimisticIndex >= 0) {
        next = [...existing];
        next[optimisticIndex] = confirmed;
      } else if (existing.some((item) => item.id === message.id)) {
        return state;
      } else {
        next = sortMessages([...existing, confirmed]);
      }

      return {
        messages: { ...state.messages, [message.conversationId]: next },
        // A message implies its sender stopped typing.
        typing: state.typing[message.conversationId]?.[message.senderId]
          ? {
              ...state.typing,
              [message.conversationId]: Object.fromEntries(
                Object.entries(state.typing[message.conversationId]).filter(
                  ([uid]) => uid !== message.senderId
                )
              ),
            }
          : state.typing,
      };
    }),

  updateMessage: (message) =>
    set((state) => {
      const next = mapThread(state, message.conversationId, message.id, (existing) => ({
        ...existing,
        ...message,
        status: 'sent',
      }));
      if (!next) return state;
      return { messages: { ...state.messages, [message.conversationId]: next } };
    }),

  markMessageDeleted: (conversationId, messageId, deletedAt) =>
    set((state) => {
      const next = mapThread(state, conversationId, messageId, (message) => ({
        ...message,
        deletedAt,
        text: '',
        reactions: {},
        mentions: [],
      }));
      if (!next) return state;
      return { messages: { ...state.messages, [conversationId]: next } };
    }),

  setReactions: (conversationId, messageId, reactions) =>
    set((state) => {
      const next = mapThread(state, conversationId, messageId, (message) => ({
        ...message,
        reactions,
      }));
      if (!next) return state;
      return { messages: { ...state.messages, [conversationId]: next } };
    }),

  /**
   * Applies a reaction locally before the server has confirmed it. A round trip to
   * Firestore is several hundred milliseconds at best, and a reaction that does not
   * light up the instant you click it reads as broken. The server's echo overwrites
   * this with the authoritative map moments later.
   */
  toggleReactionLocal: (conversationId, messageId, uid, emoji) =>
    set((state) => {
      const next = mapThread(state, conversationId, messageId, (message) => {
        const reactions = { ...(message.reactions ?? {}) };
        const reactors = reactions[emoji] ?? [];

        if (reactors.includes(uid)) {
          const remaining = reactors.filter((id) => id !== uid);
          if (remaining.length > 0) reactions[emoji] = remaining;
          else delete reactions[emoji];
        } else {
          reactions[emoji] = [...reactors, uid];
        }

        return { ...message, reactions };
      });

      if (!next) return state;
      return { messages: { ...state.messages, [conversationId]: next } };
    }),

  applyEditLocal: (conversationId, messageId, text) =>
    set((state) => {
      const next = mapThread(state, conversationId, messageId, (message) => ({
        ...message,
        text,
        editedAt: Date.now(),
      }));
      if (!next) return state;
      return { messages: { ...state.messages, [conversationId]: next } };
    }),

  failMessage: (conversationId, clientId) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: (state.messages[conversationId] ?? []).map((message) =>
          message.clientId === clientId ? { ...message, status: 'failed' } : message
        ),
      },
    })),

  removeMessage: (conversationId, messageId) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: (state.messages[conversationId] ?? []).filter(
          (message) => message.id !== messageId
        ),
      },
    })),

  setTyping: (conversationId, userId, isTyping) =>
    set((state) => {
      const forConversation = { ...(state.typing[conversationId] ?? {}) };

      if (isTyping) forConversation[userId] = Date.now() + TYPING_TTL_MS;
      else delete forConversation[userId];

      return { typing: { ...state.typing, [conversationId]: forConversation } };
    }),

  /** Typing state self-heals: a client that vanishes mid-keystroke times out here. */
  pruneTyping: () => {
    const now = Date.now();
    const { typing } = get();
    let changed = false;
    const next: ChatState['typing'] = {};

    for (const [conversationId, entries] of Object.entries(typing)) {
      const live = Object.entries(entries).filter(([, expiresAt]) => expiresAt > now);
      if (live.length !== Object.keys(entries).length) changed = true;
      if (live.length > 0) next[conversationId] = Object.fromEntries(live);
      else if (Object.keys(entries).length > 0) changed = true;
    }

    if (changed) set({ typing: next });
  },
}));

/* -------------------------------------------------------------- selectors */

export const selectConversation = (conversationId: string | null) => (state: ChatState) =>
  conversationId ? (state.conversations.find((item) => item.id === conversationId) ?? null) : null;

export const selectThread = (conversationId: string | null) => (state: ChatState) =>
  (conversationId ? state.threads[conversationId] : undefined) ?? EMPTY_THREAD;

export const selectUnread = (conversationId: string, viewerUid: string) => (state: ChatState) =>
  state.conversations.find((item) => item.id === conversationId)?.unread?.[viewerUid] ?? 0;

export const selectTotalUnread = (viewerUid: string | undefined) => (state: ChatState) =>
  viewerUid
    ? state.conversations.reduce((total, item) => total + (item.unread?.[viewerUid] ?? 0), 0)
    : 0;
