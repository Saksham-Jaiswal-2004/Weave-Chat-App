'use client';

import { api } from './api';
import { currentIdToken } from './firebase';
import { loadInbox } from './inbox';
import { notifyMessage } from './notifications';
import { conversationTitle, mentionsViewer } from './utils';
import { useAuthStore } from '@/store/auth';
import { useChatStore } from '@/store/chat';
import { useSocketStore } from '@/store/socket';
import type { ClientEvent, Message, ReplySnapshot, ServerEvent } from '@/types';

/**
 * Hand-rolled websocket client: one connection per tab, backoff reconnects, an
 * outbound queue for anything typed while offline, and a catch-up refetch after a
 * drop. Incoming frames are written straight into the Zustand stores, which is
 * what makes the UI update the instant a message lands.
 */

const PING_INTERVAL_MS = 25_000;
const ACK_TIMEOUT_MS = 15_000;
const TYPING_REPEAT_MS = 3_000;
const MAX_BACKOFF_MS = 15_000;

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function socketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

class WeaveSocket {
  private ws: WebSocket | null = null;
  private wanted = false;
  private attempt = 0;
  private hasConnectedBefore = false;
  private refreshedForThisAttempt = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /** Frames typed while the socket was down, replayed once it is ready. */
  private queue: ClientEvent[] = [];
  /** clientId -> timer that gives up on an unacknowledged message. */
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  /** conversationId -> last time we told the server "still typing". */
  private typingSentAt = new Map<string, number>();

  /* ------------------------------------------------------------ lifecycle */

  connect() {
    this.wanted = true;
    this.open();
  }

  disconnect() {
    this.wanted = false;
    this.clearTimers();
    this.queue = [];
    this.typingSentAt.clear();

    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();

    this.ws?.close(1000, 'client-signout');
    this.ws = null;
    useSocketStore.getState().setStatus('idle');
  }

  private open() {
    if (!this.wanted || typeof window === 'undefined') return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    useSocketStore.getState().setStatus(this.hasConnectedBefore ? 'reconnecting' : 'connecting');

    const ws = new WebSocket(socketUrl());
    this.ws = ws;

    ws.onopen = () => void this.authenticate();
    ws.onmessage = (event) => this.receive(event);
    ws.onerror = () => {
      /* the close handler owns recovery */
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.stopPing();
      if (!this.wanted) return;

      useSocketStore.getState().setStatus('offline');
      this.scheduleReconnect();
    };
  }

  private async authenticate(forceRefresh = false) {
    const token = await currentIdToken(forceRefresh);
    if (!token) {
      // Signed out between opening the socket and authenticating.
      this.disconnect();
      return;
    }
    this.rawSend({ type: 'auth', token });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;

    // Exponential backoff with jitter so a server restart does not get stampeded.
    const base = Math.min(1000 * 2 ** this.attempt, MAX_BACKOFF_MS);
    const delay = base / 2 + Math.random() * (base / 2);
    this.attempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPing();
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => this.rawSend({ type: 'ping' }), PING_INTERVAL_MS);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /* -------------------------------------------------------------- sending */

  private rawSend(event: ClientEvent): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(event));
    return true;
  }

  private send(event: ClientEvent) {
    if (useSocketStore.getState().status === 'ready' && this.rawSend(event)) return;
    // Typing pings and read receipts are worthless once stale — never queue them.
    if (event.type !== 'typing' && event.type !== 'read') this.queue.push(event);
  }

  private flushQueue() {
    const queued = this.queue;
    this.queue = [];
    for (const event of queued) {
      if (!this.rawSend(event)) this.queue.push(event);
    }
  }

  /** Optimistically renders the message, then puts it on the wire. */
  sendMessage(
    conversationId: string,
    text: string,
    options: { replyTo?: ReplySnapshot | null; mentions?: string[] } = {}
  ): Message | null {
    const body = text.trim();
    const uid = useAuthStore.getState().user?.uid;
    if (!body || !uid) return null;

    const clientId = newId();
    const optimistic: Message = {
      id: `local:${clientId}`,
      conversationId,
      senderId: uid,
      text: body,
      createdAt: Date.now(),
      replyTo: options.replyTo ?? null,
      mentions: options.mentions ?? [],
      reactions: {},
      clientId,
      status: 'pending',
    };

    useChatStore.getState().addOptimisticMessage(optimistic);
    this.dispatchMessage(conversationId, body, clientId, options);
    this.setTyping(conversationId, false);

    return optimistic;
  }

  retryMessage(message: Message) {
    if (!message.clientId) return;
    useChatStore.getState().removeMessage(message.conversationId, message.id);

    const clientId = newId();
    useChatStore
      .getState()
      .addOptimisticMessage({ ...message, clientId, id: `local:${clientId}`, status: 'pending' });

    this.dispatchMessage(message.conversationId, message.text, clientId, {
      replyTo: message.replyTo ?? null,
      mentions: message.mentions,
    });
  }

  private dispatchMessage(
    conversationId: string,
    text: string,
    clientId: string,
    options: { replyTo?: ReplySnapshot | null; mentions?: string[] } = {}
  ) {
    this.send({
      type: 'message:send',
      conversationId,
      text,
      clientId,
      replyToId: options.replyTo?.id,
      mentions: options.mentions,
    });

    // If nothing acknowledges it, surface a retry affordance rather than leaving a
    // bubble spinning forever.
    this.pending.set(
      clientId,
      setTimeout(() => {
        this.pending.delete(clientId);
        useChatStore.getState().failMessage(conversationId, clientId);
      }, ACK_TIMEOUT_MS)
    );
  }

  /*
   * Edit, delete and react all apply locally first. The server is authoritative and
   * its echo overwrites these moments later, but waiting on a Firestore round trip
   * before anything moves on screen makes the buttons feel dead. If the server does
   * refuse, `resyncActiveThread` puts the truth back.
   */

  editMessage(conversationId: string, messageId: string, text: string) {
    const body = text.trim();
    if (!body) return;

    useChatStore.getState().applyEditLocal(conversationId, messageId, body);
    this.send({ type: 'message:edit', conversationId, messageId, text: body });
  }

  deleteMessage(conversationId: string, messageId: string) {
    useChatStore.getState().markMessageDeleted(conversationId, messageId, Date.now());
    this.send({ type: 'message:delete', conversationId, messageId });
  }

  toggleReaction(conversationId: string, messageId: string, emoji: string) {
    const uid = useAuthStore.getState().user?.uid;
    if (!uid) return;

    useChatStore.getState().toggleReactionLocal(conversationId, messageId, uid, emoji);
    this.send({ type: 'message:react', conversationId, messageId, emoji });
  }

  /** Tells the server how far the viewer has read, which drives everyone's ticks. */
  markRead(conversationId: string, upTo: number) {
    if (!upTo) return;
    this.send({ type: 'read', conversationId, upTo });
  }

  /**
   * Acknowledges everything this client now holds, so senders get their second tick
   * even for messages that arrived while the viewer was offline. Only conversations
   * whose newest message is ahead of our stamp are reported, so a settled inbox
   * sends nothing at all.
   */
  acknowledgeDelivery() {
    const uid = useAuthStore.getState().user?.uid;
    if (!uid) return;

    const entries = useChatStore
      .getState()
      .conversations.filter((conversation) => {
        const newest = conversation.lastMessage?.createdAt ?? 0;
        return newest > 0 && newest > (conversation.delivered?.[uid] ?? 0);
      })
      .map((conversation) => ({
        conversationId: conversation.id,
        upTo: conversation.lastMessage?.createdAt ?? 0,
      }));

    if (entries.length > 0) this.send({ type: 'delivered', entries });
  }

  private settle(clientId?: string) {
    if (!clientId) return;
    const timer = this.pending.get(clientId);
    if (timer) clearTimeout(timer);
    this.pending.delete(clientId);
  }

  /** Throttled so a fast typist does not produce a frame per keystroke. */
  setTyping(conversationId: string, isTyping: boolean) {
    const now = Date.now();
    const lastSent = this.typingSentAt.get(conversationId) ?? 0;

    if (isTyping) {
      if (now - lastSent < TYPING_REPEAT_MS) return;
      this.typingSentAt.set(conversationId, now);
    } else {
      if (lastSent === 0) return;
      this.typingSentAt.delete(conversationId);
    }

    this.send({ type: 'typing', conversationId, isTyping });
  }

  /* ------------------------------------------------------------ receiving */

  private receive(raw: MessageEvent) {
    let event: ServerEvent;
    try {
      event = JSON.parse(raw.data as string);
    } catch {
      return;
    }

    const chat = useChatStore.getState();

    switch (event.type) {
      case 'auth:ok': {
        this.attempt = 0;
        this.refreshedForThisAttempt = false;
        useSocketStore.getState().setStatus('ready');
        chat.resetPresence(event.onlineUserIds);
        this.startPing();
        this.flushQueue();
        this.acknowledgeDelivery();

        // A reconnect may have missed frames; reconcile against the source of truth.
        if (this.hasConnectedBefore) void this.resync();
        this.hasConnectedBefore = true;
        break;
      }

      case 'auth:error': {
        if (event.code === 'expired-token' && !this.refreshedForThisAttempt) {
          this.refreshedForThisAttempt = true;
          void this.authenticate(true);
          return;
        }
        useSocketStore.getState().setStatus('offline', event.message);
        break;
      }

      case 'message:new': {
        this.settle(event.message.clientId);
        chat.commitMessage(event.message);
        this.announce(event.message);
        break;
      }

      case 'message:rejected': {
        this.settle(event.clientId);
        chat.failMessage(event.conversationId, event.clientId);
        useSocketStore.getState().setStatus('ready', event.reason);
        break;
      }

      case 'message:updated':
        chat.updateMessage(event.message);
        break;

      case 'message:deleted':
        chat.markMessageDeleted(event.conversationId, event.messageId, event.deletedAt);
        break;

      case 'message:reaction':
        chat.setReactions(event.conversationId, event.messageId, event.reactions);
        break;

      case 'receipts':
        chat.applyReceipts(event.conversationId, event.reads, event.delivered);
        break;

      case 'unread': {
        const uid = useAuthStore.getState().user?.uid;
        if (uid) chat.applyUnread(event.conversationId, uid, event.unread, event.unreadMentions);
        break;
      }

      case 'conversation:touch':
        chat.touchConversation(event.conversationId, event.lastMessage, event.updatedAt);
        break;

      case 'conversation:upsert':
        chat.upsertConversation(event.conversation, event.members);
        break;

      case 'conversation:removed':
        chat.removeConversation(event.conversationId);
        break;

      case 'typing':
        chat.setTyping(event.conversationId, event.userId, event.isTyping);
        break;

      case 'presence':
        chat.setPresence(event.userId, event.online);
        break;

      case 'error': {
        // An optimistic edit/delete/reaction the server refused is now a lie on
        // screen, so pull the thread back to the truth.
        useSocketStore.getState().setStatus('ready', event.message);
        void this.resyncActiveThread();
        break;
      }

      default:
        break;
    }
  }

  /**
   * Hands an incoming message to the notifier. Only the "is this mine?" test lives
   * here — muting, the active-thread check and the sound are all owned by
   * `notifyMessage`, so the rules stay in one place.
   */
  private announce(message: Message) {
    const viewer = useAuthStore.getState().user;
    if (!viewer || message.senderId === viewer.uid) return;

    const state = useChatStore.getState();
    const conversation = state.conversations.find((item) => item.id === message.conversationId);
    if (!conversation) return;

    const sender = state.users[message.senderId]?.displayName ?? 'Someone';

    notifyMessage({
      conversationId: message.conversationId,
      title:
        conversation.type === 'group'
          ? `${sender} in ${conversationTitle(conversation, viewer.uid, state.users)}`
          : sender,
      body: message.text.slice(0, 180),
      isMention: mentionsViewer(message, viewer.uid),
      muted: Boolean(conversation.muted?.[viewer.uid]),
      tag: message.conversationId,
    });
  }

  /** Re-reads the open thread from the server, discarding any local guesses. */
  private async resyncActiveThread() {
    const activeId = useChatStore.getState().activeConversationId;
    if (!activeId) return;

    try {
      const thread = await api.listMessages(activeId);
      useChatStore.getState().setMessages(activeId, thread.messages, thread.hasMore);
    } catch {
      // Nothing better to do; the next reconnect reconciles.
    }
  }

  /** Pull the inbox and the open thread back into sync after a dropped connection. */
  private async resync() {
    try {
      await loadInbox();
      this.acknowledgeDelivery();
      await this.resyncActiveThread();
    } catch {
      // A failed catch-up is not fatal; the next reconnect will try again.
    }
  }
}

export const socket = new WeaveSocket();
