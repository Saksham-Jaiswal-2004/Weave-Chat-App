import { WebSocketServer } from 'ws';

import { auth } from './firebase-admin.js';
import * as hub from './hub.js';
import * as repo from './repo.js';

/**
 * Hand-rolled websocket layer — no socket.io, no Firestore listeners.
 *
 * Flow: connect -> client sends { type: 'auth', token } -> server verifies the
 * Firebase ID token -> socket joins the hub -> messages are persisted through the
 * repo and fanned out to the other members' sockets.
 */

const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_FRAME_BYTES = 16 * 1024;

// Token bucket: a burst of 15, refilling at 5 messages/second.
const RATE_BURST = 15;
const RATE_REFILL_PER_MS = 5 / 1000;

const TYPING_ECHO_MS = 4_000;

/** @param {import('ws').WebSocket} socket */
function state(socket) {
  return socket._weave;
}

function fail(socket, code, message) {
  hub.send(socket, { type: 'auth:error', code, message });
  socket.close(4001, code);
}

function takeToken(socket) {
  const s = state(socket);
  const now = Date.now();
  s.tokens = Math.min(RATE_BURST, s.tokens + (now - s.lastRefill) * RATE_REFILL_PER_MS);
  s.lastRefill = now;

  if (s.tokens < 1) return false;
  s.tokens -= 1;
  return true;
}

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Resolves the member list for a conversation, preferring the short-lived cache
 * so a busy thread does not spend a Firestore read on every single message.
 */
async function membersOf(conversationId) {
  const cached = hub.cachedMembers(conversationId);
  if (cached) return cached;

  const conversation = await repo.getConversation(conversationId);
  if (!conversation) return null;
  return hub.cacheMembers(conversationId, conversation.memberIds);
}

/**
 * Membership gate shared by every conversation-scoped event. Returns the member
 * list, or null once it has already told the client why it said no.
 */
async function membersFor(socket, conversationId) {
  const memberIds = await membersOf(conversationId);
  if (!memberIds) {
    hub.send(socket, { type: 'error', message: 'Conversation not found.' });
    return null;
  }
  if (!memberIds.includes(state(socket).uid)) {
    hub.send(socket, { type: 'error', message: 'You are not a member of this conversation.' });
    return null;
  }
  return memberIds;
}

/** An HttpError carries text written for the user; anything else must not be shown. */
function reportFailure(socket, error, fallback) {
  if (error instanceof repo.HttpError) {
    return hub.send(socket, { type: 'error', message: error.message });
  }
  console.error('[ws] handler failed', error);
  hub.send(socket, { type: 'error', message: fallback });
}

/* --------------------------------------------------------- event handlers */

async function handleAuth(socket, event) {
  const s = state(socket);
  if (s.uid) return; // already signed in on this socket

  const token = typeof event.token === 'string' ? event.token.trim() : '';
  if (!token) return fail(socket, 'missing-token', 'No ID token was supplied.');

  let decoded;
  try {
    decoded = await auth().verifyIdToken(token);
  } catch (error) {
    // Surface a configuration fault in the log — from the client it is
    // indistinguishable from a bad token, and silence would be baffling.
    if (String(error?.message ?? '').startsWith('[weave]')) console.error(error.message);

    const expired = String(error?.code ?? '').includes('id-token-expired');
    return fail(
      socket,
      expired ? 'expired-token' : 'invalid-token',
      expired ? 'Your session expired.' : 'Could not verify your session.'
    );
  }

  clearTimeout(s.authTimer);
  s.uid = decoded.uid;

  const { firstConnection } = hub.register(decoded.uid, socket);

  hub.send(socket, {
    type: 'auth:ok',
    userId: decoded.uid,
    onlineUserIds: hub.onlineUserIds(),
  });

  if (firstConnection) {
    hub.broadcastToAll({ type: 'presence', userId: decoded.uid, online: true }, { exceptSocket: socket });
    repo.touchUser(decoded.uid).catch(() => {});
  }
}

async function handleSend(socket, event) {
  const { uid } = state(socket);
  const clientId = str(event.clientId);
  const conversationId = str(event.conversationId);

  const reject = (reason) =>
    hub.send(socket, { type: 'message:rejected', conversationId, clientId, reason });

  if (!conversationId || !clientId) return reject('Malformed message.');

  if (!takeToken(socket)) return reject('You are sending messages too quickly.');

  const text = str(event.text);
  if (!text) return reject('Message is empty.');
  if (text.length > repo.MAX_MESSAGE_LENGTH) {
    return reject(`Messages are limited to ${repo.MAX_MESSAGE_LENGTH} characters.`);
  }

  const memberIds = await membersOf(conversationId);
  if (!memberIds) return reject('Conversation not found.');
  if (!memberIds.includes(uid)) return reject('You are not a member of this conversation.');

  let written;
  try {
    written = await repo.createMessage({
      conversationId,
      senderId: uid,
      text,
      replyToId: str(event.replyToId) || undefined,
      mentions: Array.isArray(event.mentions) ? event.mentions : undefined,
      // Whoever holds a socket right now is about to be handed the frame, so the
      // write can mark them delivered instead of waiting for an ack round trip.
      onlineMemberIds: memberIds.filter((id) => hub.isOnline(id)),
    });
  } catch (error) {
    if (error instanceof repo.HttpError) return reject(error.message);
    console.error('[ws] failed to persist message', error);
    return reject('Could not save your message. Try again.');
  }

  // Echo the client id back to the sender only, so their optimistic bubble can be
  // reconciled instead of duplicated. Everyone else gets the plain message.
  hub.broadcastToUsers(
    memberIds,
    { type: 'message:new', message: written.message },
    { exceptSocket: socket }
  );
  hub.send(socket, { type: 'message:new', message: { ...written.message, clientId } });

  hub.broadcastToUsers(memberIds, {
    type: 'conversation:touch',
    conversationId,
    lastMessage: written.lastMessage,
    updatedAt: written.updatedAt,
  });

  // Badges are addressed to one person each: nobody needs to know how far behind
  // anybody else is.
  for (const [memberId, counts] of Object.entries(written.unreadByUser)) {
    hub.broadcastToUsers([memberId], {
      type: 'unread',
      conversationId,
      unread: counts.unread,
      unreadMentions: counts.unreadMentions,
    });
  }

  hub.broadcastToUsers(memberIds, {
    type: 'receipts',
    conversationId,
    reads: written.reads,
    delivered: written.delivered,
  });
}

async function handleEdit(socket, event) {
  const { uid } = state(socket);
  const conversationId = str(event.conversationId);
  const messageId = str(event.messageId);
  if (!conversationId || !messageId) return;

  if (!takeToken(socket)) {
    return hub.send(socket, { type: 'error', message: 'You are doing that too quickly.' });
  }

  const memberIds = await membersFor(socket, conversationId);
  if (!memberIds) return;

  let result;
  try {
    result = await repo.editMessage(conversationId, messageId, uid, event.text);
  } catch (error) {
    return reportFailure(socket, error, 'Could not edit that message.');
  }

  hub.broadcastToUsers(memberIds, { type: 'message:updated', message: result.message });

  if (result.lastMessage) {
    hub.broadcastToUsers(memberIds, {
      type: 'conversation:touch',
      conversationId,
      lastMessage: result.lastMessage,
      updatedAt: result.updatedAt,
    });
  }
}

async function handleDelete(socket, event) {
  const { uid } = state(socket);
  const conversationId = str(event.conversationId);
  const messageId = str(event.messageId);
  if (!conversationId || !messageId) return;

  if (!takeToken(socket)) {
    return hub.send(socket, { type: 'error', message: 'You are doing that too quickly.' });
  }

  const memberIds = await membersFor(socket, conversationId);
  if (!memberIds) return;

  let result;
  try {
    // The membership cache holds no roles, so the repo derives admin rights from
    // the conversation doc it has to read anyway.
    result = await repo.deleteMessage(conversationId, messageId, uid);
  } catch (error) {
    return reportFailure(socket, error, 'Could not delete that message.');
  }

  hub.broadcastToUsers(memberIds, {
    type: 'message:deleted',
    conversationId,
    messageId,
    deletedAt: result.deletedAt,
  });

  if (result.lastMessage) {
    hub.broadcastToUsers(memberIds, {
      type: 'conversation:touch',
      conversationId,
      lastMessage: result.lastMessage,
      updatedAt: result.updatedAt,
    });
  }
}

async function handleReact(socket, event) {
  const { uid } = state(socket);
  const conversationId = str(event.conversationId);
  const messageId = str(event.messageId);
  if (!conversationId || !messageId) return;

  if (!takeToken(socket)) {
    return hub.send(socket, { type: 'error', message: 'You are doing that too quickly.' });
  }

  const memberIds = await membersFor(socket, conversationId);
  if (!memberIds) return;

  let reactions;
  try {
    reactions = await repo.toggleReaction(conversationId, messageId, uid, event.emoji);
  } catch (error) {
    return reportFailure(socket, error, 'Could not save that reaction.');
  }

  hub.broadcastToUsers(memberIds, { type: 'message:reaction', conversationId, messageId, reactions });
}

/**
 * A client announcing which messages it now holds. This is what turns the sender's
 * single tick into a double tick for a recipient who was offline at send time.
 */
async function handleDelivered(socket, event) {
  const { uid } = state(socket);
  const entries = Array.isArray(event.entries) ? event.entries : [];
  if (entries.length === 0) return;

  if (!takeToken(socket)) return;

  let changed;
  try {
    changed = await repo.markDeliveredBulk(uid, entries);
  } catch (error) {
    return reportFailure(socket, error, 'Could not record delivery.');
  }

  // Only the senders care, but receipts are cheap and the whole thread stays in step.
  for (const entry of changed) {
    hub.broadcastToUsers(entry.memberIds, {
      type: 'receipts',
      conversationId: entry.conversationId,
      reads: entry.reads,
      delivered: entry.delivered,
    });
  }
}

async function handleRead(socket, event) {
  const { uid } = state(socket);
  const conversationId = str(event.conversationId);
  if (!conversationId) return;

  // Metered like the write events: a client that announces its read position in a
  // loop would otherwise burn the daily Firestore quota on its own.
  if (!takeToken(socket)) return;

  const memberIds = await membersFor(socket, conversationId);
  if (!memberIds) return;

  let conversation;
  try {
    conversation = await repo.markRead(conversationId, uid, Number(event.upTo) || 0);
  } catch (error) {
    return reportFailure(socket, error, 'Could not save your read position.');
  }

  hub.broadcastToUsers(memberIds, {
    type: 'receipts',
    conversationId,
    reads: conversation.reads,
    delivered: conversation.delivered,
  });
  // Every tab of the reader, not just the one that reported — the badge is per
  // account, so a second window must not keep showing it.
  hub.broadcastToUsers([uid], { type: 'unread', conversationId, unread: 0, unreadMentions: 0 });
}

async function handleTyping(socket, event) {
  const s = state(socket);
  const conversationId = str(event.conversationId);
  if (!conversationId) return;

  const isTyping = Boolean(event.isTyping);
  const now = Date.now();
  const startedAt = s.typingIn.get(conversationId);

  // Typing pings are chatty. Only relay a *change* of state, and re-assert an
  // ongoing one at most every few seconds — this also bounds how often the
  // membership lookup below can reach Firestore.
  if (isTyping) {
    if (startedAt && startedAt > now - TYPING_ECHO_MS) return;
    s.typingIn.set(conversationId, now);
  } else {
    if (!startedAt) return;
    s.typingIn.delete(conversationId);
  }

  const memberIds = await membersOf(conversationId);
  if (!memberIds || !memberIds.includes(s.uid)) return;

  hub.broadcastToUsers(
    memberIds,
    { type: 'typing', conversationId, userId: s.uid, isTyping },
    { exceptSocket: socket }
  );
}

/** Clear any dangling "is typing…" bubbles left behind by a dropped socket. */
function clearTyping(socket) {
  const s = state(socket);
  for (const conversationId of s.typingIn.keys()) {
    const memberIds = hub.cachedMembers(conversationId);
    if (!memberIds) continue;
    hub.broadcastToUsers(
      memberIds,
      { type: 'typing', conversationId, userId: s.uid, isTyping: false },
      { exceptSocket: socket }
    );
  }
  s.typingIn.clear();
}

/* ------------------------------------------------------------ server wiring */

/**
 * Attaches the websocket endpoint to an existing HTTP server.
 * @param {import('http').Server} server
 * @param {{ path?: string }} [options]
 */
export function attachWebsocketServer(server, { path = '/ws' } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  wss.on('connection', (socket) => {
    socket._weave = {
      uid: null,
      alive: true,
      tokens: RATE_BURST,
      lastRefill: Date.now(),
      typingIn: new Map(),
      authTimer: setTimeout(() => {
        if (!state(socket).uid) fail(socket, 'missing-token', 'Timed out waiting for authentication.');
      }, AUTH_TIMEOUT_MS),
    };

    socket.on('pong', () => {
      state(socket).alive = true;
    });

    socket.on('message', async (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return hub.send(socket, { type: 'error', message: 'Malformed frame.' });
      }
      if (!event || typeof event.type !== 'string') return;

      try {
        if (event.type === 'auth') return await handleAuth(socket, event);
        if (event.type === 'ping') return hub.send(socket, { type: 'pong' });

        if (!state(socket).uid) {
          return hub.send(socket, { type: 'error', message: 'Not authenticated.' });
        }

        if (event.type === 'message:send') return await handleSend(socket, event);
        if (event.type === 'message:edit') return await handleEdit(socket, event);
        if (event.type === 'message:delete') return await handleDelete(socket, event);
        if (event.type === 'message:react') return await handleReact(socket, event);
        if (event.type === 'read') return await handleRead(socket, event);
        if (event.type === 'delivered') return await handleDelivered(socket, event);
        if (event.type === 'typing') return handleTyping(socket, event);
      } catch (error) {
        console.error('[ws] handler error', error);
        hub.send(socket, { type: 'error', message: 'Something went wrong handling that.' });
      }
    });

    socket.on('close', () => {
      const s = state(socket);
      clearTimeout(s.authTimer);
      if (!s.uid) return;

      clearTyping(socket);
      const { lastConnection } = hub.unregister(s.uid, socket);
      if (lastConnection) {
        hub.broadcastToAll({ type: 'presence', userId: s.uid, online: false });
        repo.touchUser(s.uid).catch(() => {});
      }
    });

    socket.on('error', () => socket.terminate());
  });

  // Drop half-open connections that stopped answering pings.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const s = state(socket);
      if (!s) continue;
      if (!s.alive) {
        socket.terminate();
        continue;
      }
      s.alive = false;
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  wss.on('close', () => clearInterval(heartbeat));

  /**
   * Only claim upgrades on our own path — Next's dev HMR socket has to keep
   * reaching its own handler.
   */
  function handleUpgrade(request, socket, head) {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  }

  return { wss, path, handleUpgrade };
}
