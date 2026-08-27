import { FieldValue } from 'firebase-admin/firestore';

import { db, FieldPath } from './firebase-admin.js';

/**
 * All Firestore access lives here. The browser never touches the database —
 * every read/write goes through this module (HTTP routes + the websocket hub),
 * which is why the security rules can deny client access outright.
 */

export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_GROUP_MEMBERS = 50;
export const MAX_GROUP_NAME_LENGTH = 60;
export const MESSAGE_PAGE_SIZE = 40;
export const MAX_REACTIONS_PER_MESSAGE = 20;
/** Caps the write burst when a long-offline client comes back and acknowledges. */
export const MAX_DELIVERY_ENTRIES = 50;

/** A "family" emoji is already 7 code points — 8 leaves headroom without allowing prose. */
const MAX_EMOJI_CODE_POINTS = 8;

/** Mirrors `MENTION_EVERYONE` in types.ts, which this module cannot import at runtime. */
export const MENTION_EVERYONE = '*';

/** The uid-keyed maps on a conversation doc, all of which follow a member in and out. */
const MEMBER_MAPS = ['reads', 'delivered', 'unread', 'unreadMentions', 'muted'];

const usersCol = () => db().collection('users');
const conversationsCol = () => db().collection('conversations');
const messagesCol = (conversationId) => conversationsCol().doc(conversationId).collection('messages');

export class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Deterministic id so two people can never end up with duplicate DM threads. */
export function directConversationId(uidA, uidB) {
  return `dm__${[uidA, uidB].sort().join('__')}`;
}

function normalise(value) {
  return (value ?? '').toString().trim().toLowerCase();
}

/* ------------------------------------------------------------------ users */

/** @returns {import('../types.js').UserProfile} */
function userFromDoc(doc) {
  const data = doc.data() ?? {};
  return {
    uid: doc.id,
    email: data.email ?? null,
    displayName: data.displayName || 'Someone',
    photoURL: data.photoURL ?? null,
    avatarColor: data.avatarColor ?? null,
    createdAt: data.createdAt ?? 0,
    lastSeenAt: data.lastSeenAt ?? 0,
  };
}

function nameFromEmail(email) {
  return normalise(email).split('@')[0] || '';
}

/** Called after every sign-in so the directory stays in sync with Firebase Auth. */
export async function upsertUser({ uid, email, displayName, photoURL }) {
  const now = Date.now();
  const ref = usersCol().doc(uid);
  const snap = await ref.get();

  // The directory wins once it exists. This runs after every auth resolve carrying
  // the *Firebase Auth* name, which never changes when someone renames themselves
  // in settings — preferring it would quietly undo that rename on the next sign-in.
  const resolvedName =
    snap.data()?.displayName || (displayName ?? '').trim() || nameFromEmail(email) || 'Someone';

  await ref.set(
    {
      email: email ?? null,
      emailLower: normalise(email),
      displayName: resolvedName,
      displayNameLower: normalise(resolvedName),
      photoURL: photoURL ?? null,
      lastSeenAt: now,
      // Seeded once, never on a later sign-in: this runs after every auth resolve
      // and a plain merge would reset a colour the person chose in settings.
      ...(snap.exists ? {} : { createdAt: now, avatarColor: null }),
    },
    { merge: true }
  );

  return userFromDoc(await ref.get());
}

export async function touchUser(uid) {
  await usersCol().doc(uid).set({ lastSeenAt: Date.now() }, { merge: true });
}

export async function getUser(uid) {
  const snap = await usersCol().doc(uid).get();
  return snap.exists ? userFromDoc(snap) : null;
}

/** Batched profile lookup — used to hydrate conversation member lists. */
export async function getUsers(uids) {
  const unique = [...new Set(uids)].filter(Boolean);
  if (unique.length === 0) return [];

  const snaps = await db().getAll(...unique.map((uid) => usersCol().doc(uid)));
  return snaps.filter((snap) => snap.exists).map(userFromDoc);
}

/**
 * Prefix search over email and display name. Firestore has no substring index, so
 * this is a range scan on the lowercased fields — enough for an MVP directory.
 *
 * @param {string} term
 * @param {{ excludeUid?: string, limit?: number }} [options]
 * @returns {Promise<import('../types.js').UserProfile[]>}
 */
export async function searchUsers(term, { excludeUid, limit = 10 } = {}) {
  const q = normalise(term);
  if (q.length < 2) return [];

  // U+F8FF sorts after any ordinary character, making [q, q+U+F8FF] a prefix range.
  const end = q + '';
  const [byEmail, byName] = await Promise.all([
    usersCol().orderBy('emailLower').startAt(q).endAt(end).limit(limit).get(),
    usersCol().orderBy('displayNameLower').startAt(q).endAt(end).limit(limit).get(),
  ]);

  const merged = new Map();
  for (const doc of [...byEmail.docs, ...byName.docs]) {
    if (doc.id === excludeUid) continue;
    merged.set(doc.id, userFromDoc(doc));
  }
  return [...merged.values()].slice(0, limit);
}

/* ---------------------------------------------------------- conversations */

/**
 * Every new field is defaulted, so threads written before receipts and roles
 * existed still hydrate instead of throwing on the client.
 *
 * @returns {import('../types.js').Conversation}
 */
function conversationFromDoc(doc) {
  const data = doc.data() ?? {};
  return {
    id: doc.id,
    type: data.type ?? 'dm',
    name: data.name ?? null,
    memberIds: data.memberIds ?? [],
    admins: data.admins ?? [],
    createdBy: data.createdBy ?? '',
    createdAt: data.createdAt ?? 0,
    updatedAt: data.updatedAt ?? data.createdAt ?? 0,
    lastMessage: data.lastMessage ?? null,
    reads: data.reads ?? {},
    delivered: data.delivered ?? {},
    unread: data.unread ?? {},
    unreadMentions: data.unreadMentions ?? {},
    muted: data.muted ?? {},
  };
}

/** Zeroed counters for a fresh member set, written once at creation. */
function seedMemberMaps(memberIds) {
  const counters = {};
  const flags = {};
  for (const uid of memberIds) {
    counters[uid] = 0;
    flags[uid] = false;
  }
  return {
    reads: { ...counters },
    delivered: { ...counters },
    unread: { ...counters },
    unreadMentions: { ...counters },
    muted: flags,
  };
}

/** Groups that predate the `admins` field fall back to their creator, or they lock up. */
function adminsOf(conversation) {
  return conversation.admins.length > 0 ? conversation.admins : [conversation.createdBy];
}

function isAdminOf(conversation, uid) {
  return conversation.type === 'group' && adminsOf(conversation).includes(uid);
}

/** Mirrors the FieldValue.delete() sweep below so callers get a consistent object back. */
function withoutMember(conversation, uid, patch) {
  const stripped = {};
  for (const map of MEMBER_MAPS) {
    stripped[map] = { ...conversation[map] };
    delete stripped[map][uid];
  }
  return { ...conversation, ...stripped, ...patch };
}

export async function getConversation(conversationId) {
  const snap = await conversationsCol().doc(conversationId).get();
  return snap.exists ? conversationFromDoc(snap) : null;
}

/**
 * Sorting happens in memory on purpose: `array-contains` + `orderBy` would need a
 * composite index, and an MVP inbox is small enough that this is the cheaper trade.
 *
 * @param {string} uid
 * @param {{ limit?: number }} [options]
 * @returns {Promise<import('../types.js').Conversation[]>}
 */
export async function listConversationsForUser(uid, { limit = 200 } = {}) {
  const snap = await conversationsCol()
    .where('memberIds', 'array-contains', uid)
    .limit(limit)
    .get();

  return snap.docs.map(conversationFromDoc).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** @returns {Promise<{ conversation: import('../types.js').Conversation, created: boolean }>} */
export async function createDirectConversation(uidA, uidB) {
  if (uidA === uidB) throw new HttpError(400, 'You cannot start a chat with yourself.');

  const other = await getUser(uidB);
  if (!other) throw new HttpError(404, 'That user does not exist.');

  const id = directConversationId(uidA, uidB);
  const ref = conversationsCol().doc(id);

  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return { conversation: conversationFromDoc(snap), created: false };

    const now = Date.now();
    const members = [uidA, uidB].sort();
    const data = {
      type: 'dm',
      name: null,
      memberIds: members,
      admins: [], // DMs have no roles — both sides are equal.
      createdBy: uidA,
      createdAt: now,
      updatedAt: now,
      lastMessage: null,
      ...seedMemberMaps(members),
    };
    tx.set(ref, data);
    return { conversation: { id, ...data }, created: true };
  });
}

/** @returns {Promise<import('../types.js').Conversation>} */
export async function createGroupConversation({ name, creatorUid, memberIds }) {
  const title = (name ?? '').trim();
  if (title.length < 1) throw new HttpError(400, 'Group name is required.');
  if (title.length > MAX_GROUP_NAME_LENGTH) {
    throw new HttpError(400, `Group name must be ${MAX_GROUP_NAME_LENGTH} characters or fewer.`);
  }

  const members = [...new Set([creatorUid, ...memberIds])];
  if (members.length < 2) throw new HttpError(400, 'Add at least one other member.');
  if (members.length > MAX_GROUP_MEMBERS) {
    throw new HttpError(400, `Groups are limited to ${MAX_GROUP_MEMBERS} members.`);
  }

  // Reject ids that do not resolve to a real profile.
  const known = await getUsers(members);
  if (known.length !== members.length) throw new HttpError(400, 'One or more members do not exist.');

  const now = Date.now();
  const ref = conversationsCol().doc();
  const data = {
    type: 'group',
    name: title,
    memberIds: members,
    admins: [creatorUid],
    createdBy: creatorUid,
    createdAt: now,
    updatedAt: now,
    lastMessage: null,
    ...seedMemberMaps(members),
  };
  await ref.set(data);
  return { id: ref.id, ...data };
}

export async function addGroupMembers(conversationId, requesterUid, newMemberIds) {
  const candidates = [...new Set(newMemberIds)].filter(Boolean);
  if (candidates.length === 0) throw new HttpError(400, 'Pick at least one person to add.');

  const known = await getUsers(candidates);
  if (known.length !== candidates.length) throw new HttpError(400, 'One or more members do not exist.');

  const ref = conversationsCol().doc(conversationId);

  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError(404, 'Conversation not found.');

    const conversation = conversationFromDoc(snap);
    if (conversation.type !== 'group') throw new HttpError(400, 'Only groups can take new members.');
    if (!isAdminOf(conversation, requesterUid)) {
      throw new HttpError(403, 'Only group admins can add members.');
    }

    const added = candidates.filter((uid) => !conversation.memberIds.includes(uid));
    if (added.length === 0) return { conversation, added: [] };

    const merged = [...conversation.memberIds, ...added];
    if (merged.length > MAX_GROUP_MEMBERS) {
      throw new HttpError(400, `Groups are limited to ${MAX_GROUP_MEMBERS} members.`);
    }

    const updatedAt = Date.now();
    const seeded = seedMemberMaps(added);

    // Seed each newcomer's counters rather than rewriting the whole map, so two
    // admins adding people at once cannot clobber each other's entries.
    const updates = ['memberIds', merged, 'updatedAt', updatedAt];
    for (const map of MEMBER_MAPS) {
      for (const uid of added) updates.push(new FieldPath(map, uid), seeded[map][uid]);
    }
    tx.update(ref, ...updates);

    const patched = { ...conversation, memberIds: merged, updatedAt };
    for (const map of MEMBER_MAPS) patched[map] = { ...conversation[map], ...seeded[map] };

    return { conversation: patched, added };
  });
}

/** Groups only. Deletes the thread once the last member walks out. */
export async function leaveConversation(conversationId, uid) {
  const ref = conversationsCol().doc(conversationId);

  const result = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError(404, 'Conversation not found.');

    const conversation = conversationFromDoc(snap);
    if (conversation.type !== 'group') throw new HttpError(400, 'You can only leave group chats.');
    if (!conversation.memberIds.includes(uid)) throw new HttpError(403, 'You are not a member.');

    const remaining = conversation.memberIds.filter((id) => id !== uid);
    if (remaining.length === 0) {
      tx.delete(ref);
      return { conversation, remaining, deleted: true };
    }

    const admins = adminsOf(conversation).filter((id) => id !== uid && remaining.includes(id));
    // A group must never be left adminless. `memberIds` is append-ordered, so the
    // head of the list is the longest-standing person still in the room.
    if (admins.length === 0) admins.push(remaining[0]);

    const updatedAt = Date.now();
    const updates = ['memberIds', remaining, 'admins', admins, 'updatedAt', updatedAt];
    for (const map of MEMBER_MAPS) updates.push(new FieldPath(map, uid), FieldValue.delete());
    tx.update(ref, ...updates);

    return {
      conversation: withoutMember(conversation, uid, { memberIds: remaining, admins, updatedAt }),
      remaining,
      deleted: false,
    };
  });

  // A deleted conversation doc leaves its `messages` subcollection behind, which
  // would quietly eat free-tier storage. Sweep it up outside the transaction.
  if (result.deleted) {
    await db()
      .recursiveDelete(ref)
      .catch((error) => console.error('[repo] failed to purge messages', error));
  }

  return result;
}

/** Groups only, admins only. @returns {Promise<import('../types.js').Conversation>} */
export async function renameConversation(conversationId, uid, name) {
  const title = (name ?? '').trim();
  if (title.length < 1) throw new HttpError(400, 'Group name is required.');
  if (title.length > MAX_GROUP_NAME_LENGTH) {
    throw new HttpError(400, `Group name must be ${MAX_GROUP_NAME_LENGTH} characters or fewer.`);
  }

  const ref = conversationsCol().doc(conversationId);

  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError(404, 'Conversation not found.');

    const conversation = conversationFromDoc(snap);
    if (conversation.type !== 'group') throw new HttpError(400, 'Only group chats have a name.');
    if (!isAdminOf(conversation, uid)) throw new HttpError(403, 'Only group admins can rename this chat.');
    if (conversation.name === title) return conversation;

    const updatedAt = Date.now();
    tx.update(ref, { name: title, updatedAt });
    return { ...conversation, name: title, updatedAt };
  });
}

/** Admin kick. Leaving is `leaveConversation` — you cannot remove yourself here. */
export async function removeMember(conversationId, requesterUid, targetUid) {
  if (requesterUid === targetUid) throw new HttpError(400, 'Leave the group instead.');
  if (!targetUid) throw new HttpError(400, 'No member was named.');

  const ref = conversationsCol().doc(conversationId);

  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError(404, 'Conversation not found.');

    const conversation = conversationFromDoc(snap);
    if (conversation.type !== 'group') throw new HttpError(400, 'Only group members can be removed.');
    if (!isAdminOf(conversation, requesterUid)) {
      throw new HttpError(403, 'Only group admins can remove members.');
    }
    if (!conversation.memberIds.includes(targetUid)) {
      throw new HttpError(404, 'That person is not a member.');
    }
    // Admins are peers; only the person who made the group outranks them.
    if (isAdminOf(conversation, targetUid) && conversation.createdBy !== requesterUid) {
      throw new HttpError(403, 'Only the group creator can remove another admin.');
    }

    const remaining = conversation.memberIds.filter((id) => id !== targetUid);
    const admins = adminsOf(conversation).filter((id) => id !== targetUid && remaining.includes(id));
    if (admins.length === 0) admins.push(remaining[0]);

    const updatedAt = Date.now();
    const updates = ['memberIds', remaining, 'admins', admins, 'updatedAt', updatedAt];
    // Drop their counters so a later re-add starts from a clean slate.
    for (const map of MEMBER_MAPS) updates.push(new FieldPath(map, targetUid), FieldValue.delete());
    tx.update(ref, ...updates);

    return {
      conversation: withoutMember(conversation, targetUid, { memberIds: remaining, admins, updatedAt }),
      remaining,
      removed: targetUid,
    };
  });
}

/** @returns {Promise<import('../types.js').Conversation>} */
export async function setAdmin(conversationId, requesterUid, targetUid, isAdmin) {
  const ref = conversationsCol().doc(conversationId);

  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError(404, 'Conversation not found.');

    const conversation = conversationFromDoc(snap);
    if (conversation.type !== 'group') throw new HttpError(400, 'Only group chats have admins.');
    if (!isAdminOf(conversation, requesterUid)) {
      throw new HttpError(403, 'Only group admins can change roles.');
    }
    if (!conversation.memberIds.includes(targetUid)) {
      throw new HttpError(404, 'That person is not a member.');
    }

    const current = adminsOf(conversation);
    const admins = isAdmin
      ? [...new Set([...current, targetUid])]
      : current.filter((id) => id !== targetUid);

    if (admins.length === 0) throw new HttpError(400, 'A group needs at least one admin.');
    if (admins.length === current.length && admins.every((id) => current.includes(id))) {
      return conversation;
    }

    // `updatedAt` deliberately untouched: a role change is not new activity and
    // should not reshuffle everyone's inbox.
    tx.update(ref, { admins });
    return { ...conversation, admins };
  });
}

/** @returns {Promise<import('../types.js').Conversation>} */
export async function setMuted(conversationId, uid, muted) {
  const conversation = await getConversation(conversationId);
  if (!conversation) throw new HttpError(404, 'Conversation not found.');
  if (!conversation.memberIds.includes(uid)) throw new HttpError(403, 'You are not a member.');

  const value = Boolean(muted);
  if ((conversation.muted[uid] ?? false) === value) return conversation;

  // One field of one doc — mute is per-caller, so there is nothing to race on.
  await conversationsCol().doc(conversationId).update(new FieldPath('muted', uid), value);
  return { ...conversation, muted: { ...conversation.muted, [uid]: value } };
}

/**
 * Records how far `uid` has read and clears their badges.
 *
 * @param {string} conversationId
 * @param {string} uid
 * @param {number} upTo newest `createdAt` the client has displayed
 * @returns {Promise<import('../types.js').Conversation>}
 */
export async function markRead(conversationId, uid, upTo) {
  const conversation = await getConversation(conversationId);
  if (!conversation) throw new HttpError(404, 'Conversation not found.');
  if (!conversation.memberIds.includes(uid)) throw new HttpError(403, 'You are not a member.');

  const previous = conversation.reads[uid] ?? 0;
  // Never walk the marker backwards — receipts can arrive out of order.
  const at = Math.max(Number(upTo) || 0, previous);
  // Reading something necessarily means it was delivered.
  const delivered = Math.max(at, conversation.delivered[uid] ?? 0);

  // Clients re-announce their read position on every focus and scroll. Skipping
  // the no-op write is the largest single write saving in the app.
  const settled =
    at === previous &&
    delivered === (conversation.delivered[uid] ?? 0) &&
    !conversation.unread[uid] &&
    !conversation.unreadMentions[uid];
  if (settled) return conversation;

  await conversationsCol()
    .doc(conversationId)
    .update(
      new FieldPath('reads', uid),
      at,
      new FieldPath('delivered', uid),
      delivered,
      new FieldPath('unread', uid),
      0,
      new FieldPath('unreadMentions', uid),
      0
    );

  return {
    ...conversation,
    reads: { ...conversation.reads, [uid]: at },
    delivered: { ...conversation.delivered, [uid]: delivered },
    unread: { ...conversation.unread, [uid]: 0 },
    unreadMentions: { ...conversation.unreadMentions, [uid]: 0 },
  };
}

/* -------------------------------------------------------------- messages */

/** @returns {import('../types.js').Message} */
function messageFromDoc(conversationId, doc) {
  const data = doc.data() ?? {};
  return {
    id: doc.id,
    conversationId,
    senderId: data.senderId ?? '',
    text: data.text ?? '',
    createdAt: data.createdAt ?? 0,
    editedAt: data.editedAt ?? undefined,
    deletedAt: data.deletedAt ?? undefined,
    replyTo: data.replyTo ?? null,
    mentions: data.mentions ?? [],
    reactions: data.reactions ?? {},
  };
}

/**
 * Returns messages oldest-first. `before` is the `createdAt` of the oldest page the
 * client already holds, which keeps pagination on a single-field index.
 *
 * @param {string} conversationId
 * @param {{ limit?: number, before?: number }} [options]
 * @returns {Promise<{ messages: import('../types.js').Message[], hasMore: boolean }>}
 */
export async function listMessages(conversationId, { limit = MESSAGE_PAGE_SIZE, before } = {}) {
  const size = Math.min(Math.max(Number(limit) || MESSAGE_PAGE_SIZE, 1), 100);

  let query = messagesCol(conversationId).orderBy('createdAt', 'desc');
  if (before) query = query.where('createdAt', '<', Number(before));

  const snap = await query.limit(size + 1).get();
  const docs = snap.docs.slice(0, size);

  return {
    messages: docs.map((doc) => messageFromDoc(conversationId, doc)).reverse(),
    hasMore: snap.docs.length > size,
  };
}

const PREVIEW_LENGTH = 200;

function assertBody(text) {
  const body = (text ?? '').trim();
  if (!body) throw new HttpError(400, 'Message is empty.');
  if (body.length > MAX_MESSAGE_LENGTH) {
    throw new HttpError(400, `Messages are limited to ${MAX_MESSAGE_LENGTH} characters.`);
  }
  return body;
}

/**
 * Quotes are snapshotted, not referenced, so a later edit or delete of the parent
 * cannot rewrite history inside someone else's reply. A missing parent is not an
 * error — the reply just loses its quote.
 */
async function replySnapshot(conversationId, replyToId) {
  const snap = await messagesCol(conversationId).doc(String(replyToId)).get();
  if (!snap.exists) return null;

  const parent = messageFromDoc(conversationId, snap);
  if (parent.deletedAt) return null;
  return { id: parent.id, senderId: parent.senderId, text: parent.text.slice(0, PREVIEW_LENGTH) };
}

function normaliseMentions(conversation, mentions) {
  if (!Array.isArray(mentions) || mentions.length === 0) return [];

  const unique = [...new Set(mentions.filter((uid) => typeof uid === 'string' && uid))];
  if (unique.includes(MENTION_EVERYONE)) {
    if (conversation.type !== 'group') {
      throw new HttpError(400, 'You can only mention everyone in a group.');
    }
    // A broadcast subsumes any individual mentions alongside it.
    return [MENTION_EVERYONE];
  }

  if (unique.some((uid) => !conversation.memberIds.includes(uid))) {
    throw new HttpError(400, 'You can only mention members of this conversation.');
  }
  return unique;
}

/**
 * Writes the message and denormalises a preview onto the conversation so the inbox
 * can render without a second query per thread. Unread counters, mention counters
 * and delivery marks ride along in the same batch — one conversation write per
 * message, no matter how many members it has.
 *
 * @param {{
 *   conversationId: string,
 *   senderId: string,
 *   text: string,
 *   replyToId?: string,
 *   mentions?: string[],
 *   onlineMemberIds?: string[],
 * }} input
 */
export async function createMessage({
  conversationId,
  senderId,
  text,
  replyToId,
  mentions,
  onlineMemberIds = [],
}) {
  const body = assertBody(text);

  // The unread maps are keyed by uid, so the member list has to be known before
  // the write — one read per send, and the only one on this path.
  const conversation = await getConversation(conversationId);
  if (!conversation) throw new HttpError(404, 'Conversation not found.');
  if (!conversation.memberIds.includes(senderId)) throw new HttpError(403, 'You are not a member.');

  const replyTo = replyToId ? await replySnapshot(conversationId, replyToId) : null;
  const mentioned = normaliseMentions(conversation, mentions);

  const now = Date.now();
  const ref = messagesCol(conversationId).doc();
  const lastMessage = { id: ref.id, senderId, text: body.slice(0, PREVIEW_LENGTH), createdAt: now };

  const recipients = conversation.memberIds.filter((uid) => uid !== senderId);
  const online = new Set(onlineMemberIds);
  const pinged = new Set(mentioned.includes(MENTION_EVERYONE) ? recipients : mentioned);

  const updates = ['updatedAt', now, 'lastMessage', lastMessage];
  // The sender has read their own message by definition.
  updates.push(new FieldPath('reads', senderId), now, new FieldPath('delivered', senderId), now);

  for (const uid of recipients) {
    updates.push(new FieldPath('unread', uid), FieldValue.increment(1));
    if (pinged.has(uid)) {
      updates.push(new FieldPath('unreadMentions', uid), FieldValue.increment(1));
    }
    // An open socket means the frame is on its way, so mark it delivered now
    // rather than spending a second write when the client acknowledges.
    if (online.has(uid)) updates.push(new FieldPath('delivered', uid), now);
  }

  const message = {
    id: ref.id,
    conversationId,
    senderId,
    text: body,
    createdAt: now,
    replyTo,
    mentions: mentioned,
    reactions: {},
  };

  const batch = db().batch();
  batch.set(ref, { senderId, text: body, createdAt: now, replyTo, mentions: mentioned, reactions: {} });
  batch.update(conversationsCol().doc(conversationId), ...updates);
  await batch.commit();

  // Derived from the doc we already read, so pushing per-user badges costs no
  // extra reads. The stored increments remain the source of truth.
  const unreadByUser = {};
  for (const uid of recipients) {
    unreadByUser[uid] = {
      unread: (conversation.unread[uid] ?? 0) + 1,
      unreadMentions: (conversation.unreadMentions[uid] ?? 0) + (pinged.has(uid) ? 1 : 0),
    };
  }

  const reads = { ...conversation.reads, [senderId]: now };
  const delivered = { ...conversation.delivered, [senderId]: now };
  for (const uid of recipients) if (online.has(uid)) delivered[uid] = now;

  return { message, lastMessage, updatedAt: now, unreadByUser, reads, delivered };
}

/**
 * Author-only. `lastMessage` comes back non-null only when the inbox preview
 * changed, so callers know whether a `conversation:touch` is worth sending.
 */
export async function editMessage(conversationId, messageId, uid, text) {
  const body = assertBody(text);

  const messageRef = messagesCol(conversationId).doc(messageId);
  const conversationRef = conversationsCol().doc(conversationId);
  const now = Date.now();

  return db().runTransaction(async (tx) => {
    const [messageSnap, conversationSnap] = await tx.getAll(messageRef, conversationRef);
    if (!messageSnap.exists) throw new HttpError(404, 'Message not found.');
    if (!conversationSnap.exists) throw new HttpError(404, 'Conversation not found.');

    const message = messageFromDoc(conversationId, messageSnap);
    if (message.senderId !== uid) throw new HttpError(403, 'You can only edit your own messages.');
    if (message.deletedAt) throw new HttpError(400, 'That message was deleted.');

    tx.update(messageRef, { text: body, editedAt: now });

    const conversation = conversationFromDoc(conversationSnap);
    const isPreview = conversation.lastMessage?.id === messageId;
    const lastMessage = isPreview
      ? { ...conversation.lastMessage, text: body.slice(0, PREVIEW_LENGTH) }
      : null;

    // Only the preview text changes — `updatedAt` stays put so a typo fix does
    // not jump the thread to the top of everyone's inbox.
    if (lastMessage) tx.update(conversationRef, { lastMessage });

    return {
      message: { ...message, text: body, editedAt: now },
      lastMessage,
      updatedAt: conversation.updatedAt,
    };
  });
}

/**
 * Soft delete: the row survives so pagination and reply anchors still line up,
 * but everything the author wrote is gone.
 *
 * @param {{ isAdmin?: boolean }} [options] caller's hint; the doc is still the authority
 */
export async function deleteMessage(conversationId, messageId, uid, { isAdmin = false } = {}) {
  const messageRef = messagesCol(conversationId).doc(messageId);
  const conversationRef = conversationsCol().doc(conversationId);
  const now = Date.now();

  return db().runTransaction(async (tx) => {
    const [messageSnap, conversationSnap] = await tx.getAll(messageRef, conversationRef);
    if (!messageSnap.exists) throw new HttpError(404, 'Message not found.');
    if (!conversationSnap.exists) throw new HttpError(404, 'Conversation not found.');

    const message = messageFromDoc(conversationId, messageSnap);
    const conversation = conversationFromDoc(conversationSnap);
    if (message.deletedAt) throw new HttpError(400, 'That message is already deleted.');

    const moderator = isAdmin || isAdminOf(conversation, uid);
    if (message.senderId !== uid && !moderator) {
      throw new HttpError(403, 'You can only delete your own messages.');
    }

    tx.update(messageRef, { deletedAt: now, text: '', reactions: {}, mentions: [] });

    // `LastMessage` carries no deleted flag, so the preview has to say it in words.
    const isPreview = conversation.lastMessage?.id === messageId;
    const lastMessage = isPreview
      ? { ...conversation.lastMessage, text: 'Message deleted' }
      : null;
    if (lastMessage) tx.update(conversationRef, { lastMessage });

    return {
      message: { ...message, text: '', deletedAt: now, reactions: {}, mentions: [] },
      deletedAt: now,
      lastMessage,
      updatedAt: conversation.updatedAt,
    };
  });
}

/**
 * Advances `delivered[uid]` for several conversations at once.
 *
 * A recipient who was offline when a message was sent has no delivery stamp, so the
 * sender would sit on one tick forever. Their client calls this once it holds the
 * messages. Batched because it fires on every reconnect: N reads, one write.
 *
 * @param {string} uid
 * @param {{ conversationId: string, upTo: number }[]} entries
 * @returns {Promise<{ conversationId: string, reads: Record<string, number>, delivered: Record<string, number> }[]>}
 */
export async function markDeliveredBulk(uid, entries) {
  const wanted = entries
    .filter((entry) => entry?.conversationId && Number(entry.upTo) > 0)
    .slice(0, MAX_DELIVERY_ENTRIES);
  if (wanted.length === 0) return [];

  const refs = wanted.map((entry) => conversationsCol().doc(entry.conversationId));
  const snaps = await db().getAll(...refs);

  const batch = db().batch();
  const changed = [];

  snaps.forEach((snap, index) => {
    if (!snap.exists) return;

    const conversation = conversationFromDoc(snap);
    if (!conversation.memberIds.includes(uid)) return;

    // Never move a stamp backwards: a stale client must not undo a newer receipt.
    const upTo = Number(wanted[index].upTo);
    if ((conversation.delivered[uid] ?? 0) >= upTo) return;

    batch.update(snap.ref, new FieldPath('delivered', uid), upTo);
    changed.push({
      conversationId: conversation.id,
      reads: conversation.reads,
      delivered: { ...conversation.delivered, [uid]: upTo },
      memberIds: conversation.memberIds,
    });
  });

  if (changed.length === 0) return [];
  await batch.commit();
  return changed;
}

/**
 * Adds or removes `uid` from one emoji bucket.
 * @returns {Promise<import('../types.js').Reactions>} the whole map, ready to broadcast
 */
export async function toggleReaction(conversationId, messageId, uid, emoji) {
  const key = (emoji ?? '').toString().trim();
  if (!key) throw new HttpError(400, 'Pick an emoji to react with.');
  // Count code points, not UTF-16 units: one emoji can be several of the latter.
  if ([...key].length > MAX_EMOJI_CODE_POINTS) throw new HttpError(400, 'That is not an emoji.');

  const ref = messagesCol(conversationId).doc(messageId);

  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError(404, 'Message not found.');

    const message = messageFromDoc(conversationId, snap);
    if (message.deletedAt) throw new HttpError(400, 'That message was deleted.');

    const reactions = { ...message.reactions };
    const current = reactions[key] ?? [];

    if (current.includes(uid)) {
      const rest = current.filter((id) => id !== uid);
      // Drop the key with its last reactor, or the map grows empty buckets forever.
      if (rest.length === 0) delete reactions[key];
      else reactions[key] = rest;
    } else {
      if (!reactions[key] && Object.keys(reactions).length >= MAX_REACTIONS_PER_MESSAGE) {
        throw new HttpError(
          400,
          `A message can carry ${MAX_REACTIONS_PER_MESSAGE} different reactions.`
        );
      }
      reactions[key] = [...current, uid];
    }

    // Written whole rather than by FieldPath: removing the last reactor has to
    // delete the key, which needs the read this transaction already did.
    tx.update(ref, { reactions });
    return reactions;
  });
}

/* ---------------------------------------------------------------- account */

export const MAX_DISPLAY_NAME_LENGTH = 40;

/** Mirrors `AVATAR_COLORS` in types.ts, which this module cannot import at runtime. */
export const AVATAR_COLOR_NAMES = [
  'indigo',
  'green',
  'orange',
  'pink',
  'teal',
  'violet',
  'red',
  'amber',
];

/**
 * Settings-screen edits. Both fields are optional, but an empty patch is a caller
 * bug rather than a free no-op, so it is rejected instead of costing a write.
 *
 * @param {string} uid
 * @param {{ displayName?: string, avatarColor?: string | null }} [patch]
 * @returns {Promise<import('../types.js').UserProfile>} the profile after the write
 */
export async function updateUserProfile(uid, patch = {}) {
  const { displayName, avatarColor } = patch;
  const updates = {};

  if (displayName !== undefined) {
    const name = (displayName ?? '').toString().trim();
    if (name.length < 1) throw new HttpError(400, 'Display name is required.');
    if (name.length > MAX_DISPLAY_NAME_LENGTH) {
      throw new HttpError(
        400,
        `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`
      );
    }
    updates.displayName = name;
    // Directory search reads the lowercased mirror, never the display field, so
    // letting the two drift makes the account unfindable under its new name.
    updates.displayNameLower = normalise(name);
  }

  if (avatarColor !== undefined) {
    // `null` is meaningful — it restores the deterministic tint derived from the uid.
    if (avatarColor !== null && !AVATAR_COLOR_NAMES.includes(avatarColor)) {
      throw new HttpError(400, 'That is not one of the avatar colours.');
    }
    updates.avatarColor = avatarColor;
  }

  if (Object.keys(updates).length === 0) throw new HttpError(400, 'Nothing to update.');

  const ref = usersCol().doc(uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, 'Your profile no longer exists.');

  await ref.set(updates, { merge: true });
  return userFromDoc(await ref.get());
}

/**
 * Irreversible account cleanup. Threads first, profile last, so a failure part way
 * through leaves an account that can still sign in and retry rather than a profile
 * that has vanished from a directory its conversations still point at.
 *
 * The Firebase Auth record is *not* touched here — the route deletes it afterwards,
 * once this has succeeded.
 *
 * @param {string} uid
 * @returns {Promise<{ conversations: string[], removedFrom: string[], notify: string[] }>}
 *   every affected thread, the groups that outlived the departure, and the uids
 *   whose clients need to hear about it.
 */
export async function deleteAccount(uid) {
  const conversations = await listConversationsForUser(uid, { limit: 500 });

  const affected = [];
  const removedFrom = [];
  const notify = new Set();

  for (const conversation of conversations) {
    affected.push(conversation.id);

    if (conversation.type !== 'group') {
      // A DM with a deleted account can never be useful again: neither side can
      // write to it and one side no longer exists. Take the messages with it.
      await db()
        .recursiveDelete(conversationsCol().doc(conversation.id))
        .catch((error) => console.error('[repo] failed to purge a DM', error));

      for (const memberId of conversation.memberIds) {
        if (memberId !== uid) notify.add(memberId);
      }
      continue;
    }

    // Groups follow exactly the rules of walking out voluntarily — strip the five
    // member maps, promote the longest-standing member when the last admin goes,
    // delete the thread once it empties. Restating them here is how they drift.
    const { remaining, deleted } = await leaveConversation(conversation.id, uid);
    if (deleted) continue;

    removedFrom.push(conversation.id);
    for (const memberId of remaining) notify.add(memberId);
  }

  await usersCol().doc(uid).delete();

  return { conversations: affected, removedFrom, notify: [...notify] };
}
