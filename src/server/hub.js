/**
 * In-memory registry of live websocket connections.
 *
 * Next.js bundles route handlers into its own module graph, so a plain module
 * singleton would give the HTTP routes a *different* instance than the one
 * `server.js` created. Pinning it to `globalThis` keeps both halves of the
 * process pointed at the same registry, which is how an API route (e.g. "group
 * created") can push straight down an open socket.
 */

const KEY = Symbol.for('weave.chat.hub');

function createHub() {
  return {
    /** @type {Map<string, Set<import('ws').WebSocket>>} uid -> sockets */
    sockets: new Map(),
    /** @type {Map<string, { memberIds: string[]; expiresAt: number }>} */
    membership: new Map(),
  };
}

/** @returns {ReturnType<typeof createHub>} */
function hub() {
  if (!globalThis[KEY]) globalThis[KEY] = createHub();
  return globalThis[KEY];
}

/* ------------------------------------------------------------ connections */

export function register(uid, socket) {
  const { sockets } = hub();
  let set = sockets.get(uid);
  const firstConnection = !set || set.size === 0;

  if (!set) {
    set = new Set();
    sockets.set(uid, set);
  }
  set.add(socket);

  return { firstConnection };
}

export function unregister(uid, socket) {
  const { sockets } = hub();
  const set = sockets.get(uid);
  if (!set) return { lastConnection: false };

  set.delete(socket);
  if (set.size > 0) return { lastConnection: false };

  sockets.delete(uid);
  return { lastConnection: true };
}

export function isOnline(uid) {
  return (hub().sockets.get(uid)?.size ?? 0) > 0;
}

export function onlineUserIds() {
  return [...hub().sockets.keys()];
}

export function connectionCount() {
  let total = 0;
  for (const set of hub().sockets.values()) total += set.size;
  return total;
}

/* -------------------------------------------------------------- delivery */

const OPEN = 1; // WebSocket.OPEN — avoids importing `ws` into the Next bundle.

/**
 * @param {import('ws').WebSocket} socket
 * @param {import('../types.js').ServerEvent} payload
 */
export function send(socket, payload) {
  if (!socket || socket.readyState !== OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/**
 * Fan a payload out to every live socket of every listed user.
 * @param {string[]} uids
 * @param {import('../types.js').ServerEvent} payload
 * @param {{ exceptSocket?: import('ws').WebSocket }} [options]
 */
export function broadcastToUsers(uids, payload, options = {}) {
  const { sockets } = hub();
  let delivered = 0;

  for (const uid of new Set(uids)) {
    const set = sockets.get(uid);
    if (!set) continue;
    for (const socket of set) {
      if (options.exceptSocket && socket === options.exceptSocket) continue;
      if (send(socket, payload)) delivered += 1;
    }
  }
  return delivered;
}

/** Presence is a small, low-frequency signal, so every signed-in client gets it. */
export function broadcastToAll(payload, options = {}) {
  return broadcastToUsers(onlineUserIds(), payload, options);
}

/* ----------------------------------------------------- membership caching */

const MEMBERSHIP_TTL_MS = 60_000;

/** @returns {string[] | null} */
export function cachedMembers(conversationId) {
  const entry = hub().membership.get(conversationId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    hub().membership.delete(conversationId);
    return null;
  }
  return entry.memberIds;
}

/** Saves one Firestore read per message on an active thread. */
export function cacheMembers(conversationId, memberIds) {
  hub().membership.set(conversationId, {
    memberIds: [...memberIds],
    expiresAt: Date.now() + MEMBERSHIP_TTL_MS,
  });
  return memberIds;
}

export function invalidateMembers(conversationId) {
  hub().membership.delete(conversationId);
}
