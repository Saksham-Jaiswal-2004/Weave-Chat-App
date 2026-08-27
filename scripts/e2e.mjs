/**
 * End-to-end check against the real stack: real Firebase Auth users, real ID
 * tokens, the real HTTP API and two real websocket connections.
 *
 * Creates two throwaway accounts, exercises DM + group conversations, then deletes
 * everything it made.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import WebSocket from 'ws';

import { ensureFreshBuild } from './ensure-build.mjs';

const PORT = 3210;
const BASE = `http://localhost:${PORT}`;
const API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;

const { auth, db } = await import('../src/server/firebase-admin.js');

ensureFreshBuild();

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${detail}`}`);
};

/* ---------------------------------------------------------------- helpers */

/** Admin-minted custom token -> real ID token, the same one a browser would hold. */
async function idTokenFor(uid) {
  const customToken = await auth().createCustomToken(uid);
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    }
  );
  const body = await res.json();
  if (!body.idToken) throw new Error('custom token exchange failed: ' + JSON.stringify(body));
  return body.idToken;
}

function apiFor(token) {
  return async (path, init = {}) => {
    const res = await fetch(BASE + path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  };
}

/** A websocket that authenticates and records every frame it receives. */
async function connect(token, label) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  ws.frames = [];
  ws.label = label;

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  ws.on('message', (raw) => ws.frames.push(JSON.parse(raw.toString())));
  ws.send(JSON.stringify({ type: 'auth', token }));

  const ok = await waitFor(ws, (f) => f.type === 'auth:ok', 8000);
  if (!ok) throw new Error(`${label} failed to authenticate: ${JSON.stringify(ws.frames)}`);
  return ws;
}

/** Poll a socket's frame log for a matching event. */
async function waitFor(ws, predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = ws.frames.find(predicate);
    if (hit) return hit;
    await sleep(60);
  }
  return null;
}

/* ------------------------------------------------------------------ setup */

const made = { uids: [], conversations: [] };
let server;

async function makeUser(email, displayName) {
  const existing = await auth().getUserByEmail(email).catch(() => null);
  if (existing) await auth().deleteUser(existing.uid);

  const user = await auth().createUser({ email, password: 'e2e-password-123', displayName });
  made.uids.push(user.uid);
  return user;
}

try {
  server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (c) => (log += c));
  server.stderr.on('data', (c) => (log += c));
  for (let i = 0; i < 80 && !log.includes('Weave ready'); i += 1) await sleep(250);
  check('server boots', log.includes('Weave ready'), log.slice(0, 300));

  const alice = await makeUser('weave-e2e-alice@example.invalid', 'E2E Alice');
  const bob = await makeUser('weave-e2e-bob@example.invalid', 'E2E Bob');
  const carol = await makeUser('weave-e2e-carol@example.invalid', 'E2E Carol');

  const aliceApi = apiFor(await idTokenFor(alice.uid));
  const bobApi = apiFor(await idTokenFor(bob.uid));
  const carolApi = apiFor(await idTokenFor(carol.uid));

  /* ------------------------------------------------- directory + search */

  const sync = await aliceApi('/api/session', { method: 'POST', body: '{}' });
  check('profile sync writes to the directory', sync.status === 200, JSON.stringify(sync.body));
  await bobApi('/api/session', { method: 'POST', body: '{}' });
  await carolApi('/api/session', { method: 'POST', body: '{}' });

  const byName = await aliceApi('/api/users/search?q=e2e%20bob');
  check(
    'search finds a user by display name',
    byName.body.users?.some((u) => u.uid === bob.uid),
    JSON.stringify(byName.body)
  );

  const byEmail = await aliceApi('/api/users/search?q=weave-e2e-bob');
  check(
    'search finds a user by email prefix',
    byEmail.body.users?.some((u) => u.uid === bob.uid),
    JSON.stringify(byEmail.body)
  );

  const self = await aliceApi('/api/users/search?q=e2e%20alice');
  check(
    'search excludes the searcher',
    !self.body.users?.some((u) => u.uid === alice.uid),
    JSON.stringify(self.body)
  );

  /* --------------------------------------------------------- sockets up */

  const aliceWs = await connect(await idTokenFor(alice.uid), 'alice');
  const bobWs = await connect(await idTokenFor(bob.uid), 'bob');
  const carolWs = await connect(await idTokenFor(carol.uid), 'carol');
  check('three clients authenticate over the socket', true);

  const presence = await waitFor(bobWs, (f) => f.type === 'presence' && f.online, 4000);
  check('presence is broadcast when someone connects', Boolean(presence), JSON.stringify(bobWs.frames));

  /* ------------------------------------------------------------ direct */

  const dm = await aliceApi('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ type: 'dm', userId: bob.uid }),
  });
  const dmId = dm.body.conversation?.id;
  if (dmId) made.conversations.push(dmId);
  check('DM is created', dm.status === 201 && Boolean(dmId), JSON.stringify(dm.body));

  const pushed = await waitFor(bobWs, (f) => f.type === 'conversation:upsert' && f.conversation?.id === dmId);
  check('new DM is pushed to the other member over the socket', Boolean(pushed));

  const again = await aliceApi('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ type: 'dm', userId: bob.uid }),
  });
  check(
    'starting the same DM twice reuses the thread',
    again.body.conversation?.id === dmId && again.body.created === false,
    JSON.stringify(again.body)
  );

  aliceWs.send(
    JSON.stringify({ type: 'message:send', conversationId: dmId, text: 'hello from alice', clientId: 'c-1' })
  );

  const delivered = await waitFor(bobWs, (f) => f.type === 'message:new' && f.message?.text === 'hello from alice');
  check('message is delivered to the recipient in realtime', Boolean(delivered));

  const echo = await waitFor(aliceWs, (f) => f.type === 'message:new' && f.message?.clientId === 'c-1');
  check('sender gets an echo carrying its clientId', Boolean(echo), JSON.stringify(aliceWs.frames.slice(-3)));

  check(
    'the recipient echo carries no clientId',
    delivered && delivered.message.clientId === undefined,
    JSON.stringify(delivered)
  );

  const touch = await waitFor(bobWs, (f) => f.type === 'conversation:touch' && f.conversationId === dmId);
  check('inbox preview is updated for both members', Boolean(touch));

  check('carol never sees the private DM', !carolWs.frames.some((f) => JSON.stringify(f).includes('hello from alice')));

  /* ------------------------------------------------------------ typing */

  aliceWs.send(JSON.stringify({ type: 'typing', conversationId: dmId, isTyping: true }));
  const typing = await waitFor(bobWs, (f) => f.type === 'typing' && f.isTyping === true);
  check('typing indicator reaches the other member', Boolean(typing));

  /* ------------------------------------------------------------- group */

  const group = await aliceApi('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ type: 'group', name: 'E2E Group', memberIds: [bob.uid] }),
  });
  const groupId = group.body.conversation?.id;
  if (groupId) made.conversations.push(groupId);
  check('group is created', group.status === 201 && Boolean(groupId), JSON.stringify(group.body));

  bobWs.frames = [];
  aliceWs.send(
    JSON.stringify({ type: 'message:send', conversationId: groupId, text: 'hi group', clientId: 'g-1' })
  );
  check('group message reaches every member', Boolean(await waitFor(bobWs, (f) => f.type === 'message:new' && f.message?.text === 'hi group')));

  // Add carol, then confirm she receives subsequent traffic.
  carolWs.frames = [];
  const added = await aliceApi(`/api/conversations/${groupId}/members`, {
    method: 'POST',
    body: JSON.stringify({ memberIds: [carol.uid] }),
  });
  check('member is added to the group', added.status === 200 && added.body.added?.includes(carol.uid), JSON.stringify(added.body));
  check('added member is notified over the socket', Boolean(await waitFor(carolWs, (f) => f.type === 'conversation:upsert' && f.conversation?.id === groupId)));

  carolWs.frames = [];
  aliceWs.send(JSON.stringify({ type: 'message:send', conversationId: groupId, text: 'welcome carol', clientId: 'g-2' }));
  check('new member receives group messages', Boolean(await waitFor(carolWs, (f) => f.type === 'message:new' && f.message?.text === 'welcome carol')));

  /* -------------------------------------------------- access control */

  const intruder = await carolApi(`/api/conversations/${dmId}/messages`);
  check('non-members cannot read a private thread', intruder.status === 403, JSON.stringify(intruder.body));

  carolWs.frames = [];
  carolWs.send(JSON.stringify({ type: 'message:send', conversationId: dmId, text: 'intruding', clientId: 'x-1' }));
  const refused = await waitFor(carolWs, (f) => f.type === 'message:rejected');
  check('non-members cannot post into a private thread', Boolean(refused), JSON.stringify(carolWs.frames));

  /* ------------------------------------------------------- persistence */

  const history = await bobApi(`/api/conversations/${dmId}/messages`);
  check(
    'messages persist and reload in order',
    history.body.messages?.length === 1 && history.body.messages[0].text === 'hello from alice',
    JSON.stringify(history.body.messages)
  );

  const inbox = await bobApi('/api/conversations');
  check(
    'inbox lists both threads with member profiles',
    inbox.body.conversations?.length === 2 && inbox.body.users?.length >= 2,
    JSON.stringify(inbox.body.conversations?.map((c) => c.type))
  );

  /* ------------------------------------------- receipts and unread counts */

  // Watch a fresh send: earlier frames were drained by the group section above.
  bobWs.frames = [];
  carolWs.frames = [];
  aliceWs.send(
    JSON.stringify({ type: 'message:send', conversationId: dmId, text: 'unread probe', clientId: 'u-1' })
  );
  const probe = await waitFor(bobWs, (f) => f.type === 'message:new' && f.message?.text === 'unread probe');
  check('probe message reaches the recipient', Boolean(probe));

  const unreadPush = await waitFor(bobWs, (f) => f.type === 'unread' && f.conversationId === dmId);
  check('recipient gets an unread count', (unreadPush?.unread ?? 0) >= 1, JSON.stringify(unreadPush));
  check(
    'unread counts are addressed to one member only',
    !carolWs.frames.some((f) => f.type === 'unread' && f.conversationId === dmId),
    JSON.stringify(carolWs.frames.filter((f) => f.type === 'unread'))
  );

  const beforeRead = await aliceApi('/api/conversations');
  const dmBefore = beforeRead.body.conversations?.find((c) => c.id === dmId);
  check(
    'message is marked delivered but not yet read',
    (dmBefore?.delivered?.[bob.uid] ?? 0) > 0 && (dmBefore?.reads?.[bob.uid] ?? 0) === 0,
    JSON.stringify({ delivered: dmBefore?.delivered, reads: dmBefore?.reads })
  );

  aliceWs.frames = [];
  const sentAt = probe.message.createdAt;
  bobWs.send(JSON.stringify({ type: 'read', conversationId: dmId, upTo: sentAt }));

  const receipt = await waitFor(
    aliceWs,
    (f) => f.type === 'receipts' && f.conversationId === dmId && (f.reads?.[bob.uid] ?? 0) >= sentAt
  );
  check('reading a thread reports a seen receipt to the sender', Boolean(receipt));

  const afterRead = await bobApi('/api/conversations');
  const dmAfter = afterRead.body.conversations?.find((c) => c.id === dmId);
  check('reading clears the unread counter', (dmAfter?.unread?.[bob.uid] ?? -1) === 0, JSON.stringify(dmAfter?.unread));

  /* -------------------------------------------------------------- reply */

  bobWs.frames = [];
  const originalId = delivered.message.id;
  bobWs.send(
    JSON.stringify({
      type: 'message:send',
      conversationId: dmId,
      text: 'replying to that',
      clientId: 'r-1',
      replyToId: originalId,
    })
  );
  const replied = await waitFor(aliceWs, (f) => f.type === 'message:new' && f.message?.text === 'replying to that');
  check(
    'reply carries a snapshot of the original',
    replied?.message?.replyTo?.id === originalId && replied.message.replyTo.text === 'hello from alice',
    JSON.stringify(replied?.message?.replyTo)
  );

  /* ----------------------------------------------------------- reactions */

  aliceWs.frames = [];
  bobWs.send(JSON.stringify({ type: 'message:react', conversationId: dmId, messageId: originalId, emoji: '🎉' }));
  const reacted = await waitFor(aliceWs, (f) => f.type === 'message:reaction' && f.messageId === originalId);
  check('reaction is broadcast', reacted?.reactions?.['🎉']?.includes(bob.uid), JSON.stringify(reacted?.reactions));

  aliceWs.frames = [];
  bobWs.send(JSON.stringify({ type: 'message:react', conversationId: dmId, messageId: originalId, emoji: '🎉' }));
  const unreacted = await waitFor(aliceWs, (f) => f.type === 'message:reaction' && f.messageId === originalId);
  check('reacting twice removes the reaction', !unreacted?.reactions?.['🎉'], JSON.stringify(unreacted?.reactions));

  /* --------------------------------------------------------- edit/delete */

  bobWs.frames = [];
  aliceWs.send(
    JSON.stringify({ type: 'message:edit', conversationId: dmId, messageId: originalId, text: 'hello from alice (fixed)' })
  );
  const edited = await waitFor(bobWs, (f) => f.type === 'message:updated' && f.message?.id === originalId);
  check(
    'author can edit their message',
    edited?.message?.text === 'hello from alice (fixed)' && Boolean(edited.message.editedAt),
    JSON.stringify(edited?.message)
  );

  aliceWs.frames = [];
  bobWs.send(
    JSON.stringify({ type: 'message:edit', conversationId: dmId, messageId: originalId, text: 'bob rewriting history' })
  );
  const blockedEdit = await waitFor(aliceWs, (f) => f.type === 'message:updated', 2500);
  check('a non-author cannot edit someone else’s message', !blockedEdit);

  bobWs.frames = [];
  aliceWs.send(JSON.stringify({ type: 'message:delete', conversationId: dmId, messageId: originalId }));
  const deleted2 = await waitFor(bobWs, (f) => f.type === 'message:deleted' && f.messageId === originalId);
  check('author can delete their message', Boolean(deleted2?.deletedAt));

  const afterDelete = await bobApi(`/api/conversations/${dmId}/messages`);
  const tombstone = afterDelete.body.messages?.find((m) => m.id === originalId);
  check(
    'deleted message keeps its slot but loses its text',
    Boolean(tombstone?.deletedAt) && !tombstone?.text,
    JSON.stringify(tombstone)
  );

  /* ------------------------------------------------------------ mentions */

  carolWs.frames = [];
  aliceWs.send(
    JSON.stringify({
      type: 'message:send',
      conversationId: groupId,
      text: `hey @${carol.displayName}, look at this`,
      clientId: 'm-1',
      mentions: [carol.uid],
    })
  );
  const mentioned = await waitFor(carolWs, (f) => f.type === 'message:new' && f.message?.clientId === undefined && f.message?.mentions?.length);
  check('mention is delivered on the message', mentioned?.message?.mentions?.includes(carol.uid), JSON.stringify(mentioned?.message?.mentions));

  const mentionBadge = await waitFor(carolWs, (f) => f.type === 'unread' && f.conversationId === groupId && f.unreadMentions > 0);
  check('mention raises a separate mention counter', Boolean(mentionBadge), JSON.stringify(mentionBadge));

  /* --------------------------------------------------------- group admin */

  const renamed = await aliceApi(`/api/conversations/${groupId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Renamed Group' }),
  });
  check('admin can rename the group', renamed.body.conversation?.name === 'Renamed Group', JSON.stringify(renamed.body));

  const renameByNonAdmin = await bobApi(`/api/conversations/${groupId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Bob Was Here' }),
  });
  check('a non-admin cannot rename the group', renameByNonAdmin.status === 403, JSON.stringify(renameByNonAdmin.body));

  const promoted = await aliceApi(`/api/conversations/${groupId}/admins`, {
    method: 'POST',
    body: JSON.stringify({ userId: bob.uid, admin: true }),
  });
  check('admin can promote another member', promoted.body.conversation?.admins?.includes(bob.uid), JSON.stringify(promoted.body.conversation?.admins));

  const demoted = await aliceApi(`/api/conversations/${groupId}/admins`, {
    method: 'POST',
    body: JSON.stringify({ userId: bob.uid, admin: false }),
  });
  check('admin can demote another member', !demoted.body.conversation?.admins?.includes(bob.uid), JSON.stringify(demoted.body.conversation?.admins));

  const muteRes = await bobApi(`/api/conversations/${groupId}`, {
    method: 'PATCH',
    body: JSON.stringify({ muted: true }),
  });
  check('a member can mute a thread', muteRes.body.conversation?.muted?.[bob.uid] === true, JSON.stringify(muteRes.body.conversation?.muted));

  carolWs.frames = [];
  const removal = await aliceApi(`/api/conversations/${groupId}/members?userId=${carol.uid}`, { method: 'DELETE' });
  check('admin can remove a member', removal.status === 200, JSON.stringify(removal.body));
  check('removed member is told the thread is gone', Boolean(await waitFor(carolWs, (f) => f.type === 'conversation:removed' && f.conversationId === groupId)));

  const removeByNonAdmin = await bobApi(`/api/conversations/${groupId}/members?userId=${alice.uid}`, { method: 'DELETE' });
  check('a non-admin cannot remove anyone', removeByNonAdmin.status === 403, JSON.stringify(removeByNonAdmin.body));

  // Restore membership so the leave test below still has someone to leave.
  await aliceApi(`/api/conversations/${groupId}/members`, {
    method: 'POST',
    body: JSON.stringify({ memberIds: [carol.uid] }),
  });

  /* ------------------------------------------------------ tick lifecycle */

  // A dedicated conversation so other traffic cannot move these stamps.
  const tickDm = await aliceApi('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ type: 'dm', userId: carol.uid }),
  });
  const tickId = tickDm.body.conversation.id;
  if (tickId) made.conversations.push(tickId);

  // Carol is deliberately offline for this send.
  carolWs.close();
  await sleep(600);

  aliceWs.send(
    JSON.stringify({ type: 'message:send', conversationId: tickId, text: 'tick probe', clientId: 't-1' })
  );
  const tickMsg = (await waitFor(aliceWs, (f) => f.type === 'message:new' && f.message?.text === 'tick probe'))
    ?.message;
  check('tick probe was sent', Boolean(tickMsg), 'no echo');

  const stateOf = async () => {
    const inbox = await aliceApi('/api/conversations');
    const conversation = inbox.body.conversations?.find((c) => c.id === tickId);
    const delivered = conversation?.delivered?.[carol.uid] ?? 0;
    const read = conversation?.reads?.[carol.uid] ?? 0;
    if (read >= tickMsg.createdAt) return 'seen';
    if (delivered >= tickMsg.createdAt) return 'delivered';
    return 'sent';
  };

  check(`one tick while the recipient is offline (${await stateOf()})`, (await stateOf()) === 'sent');

  // Carol comes back but does NOT open the thread — this is the case that used to
  // leave the sender on one tick forever.
  const carolBack = await connect(await idTokenFor(carol.uid), 'carol-2');
  carolBack.send(
    JSON.stringify({ type: 'delivered', entries: [{ conversationId: tickId, upTo: tickMsg.createdAt }] })
  );

  const deliveredReceipt = await waitFor(
    aliceWs,
    (f) => f.type === 'receipts' && f.conversationId === tickId && (f.delivered?.[carol.uid] ?? 0) >= tickMsg.createdAt
  );
  check('two ticks once the recipient is back, without opening the chat', Boolean(deliveredReceipt));
  check(`state is delivered (${await stateOf()})`, (await stateOf()) === 'delivered');

  // Now she reads it.
  carolBack.send(JSON.stringify({ type: 'read', conversationId: tickId, upTo: tickMsg.createdAt }));
  const readReceipt = await waitFor(
    aliceWs,
    (f) => f.type === 'receipts' && f.conversationId === tickId && (f.reads?.[carol.uid] ?? 0) >= tickMsg.createdAt
  );
  check('blue ticks once the recipient reads', Boolean(readReceipt));
  check(`state is seen (${await stateOf()})`, (await stateOf()) === 'seen');

  // A stale acknowledgement must not drag a newer stamp backwards.
  carolBack.send(JSON.stringify({ type: 'delivered', entries: [{ conversationId: tickId, upTo: 1 }] }));
  await sleep(2000);
  check(`a stale receipt cannot undo a newer one (${await stateOf()})`, (await stateOf()) === 'seen');

  carolBack.close();

  /* ---------------------------------------------------- profile & account */

  const rename = await bobApi('/api/profile', {
    method: 'PATCH',
    body: JSON.stringify({ displayName: 'Renamed Bob' }),
  });
  check('display name can be changed', rename.body.user?.displayName === 'Renamed Bob', JSON.stringify(rename.body));

  // The lowercase mirror drives search; if it drifts the account becomes unfindable.
  const foundByNewName = await aliceApi('/api/users/search?q=renamed');
  check(
    'search follows a renamed account',
    foundByNewName.body.users?.some((u) => u.uid === bob.uid),
    JSON.stringify(foundByNewName.body.users?.map((u) => u.displayName))
  );

  const colour = await bobApi('/api/profile', {
    method: 'PATCH',
    body: JSON.stringify({ avatarColor: 'teal' }),
  });
  check('avatar colour can be set', colour.body.user?.avatarColor === 'teal', JSON.stringify(colour.body.user));

  const clearedColour = await bobApi('/api/profile', {
    method: 'PATCH',
    body: JSON.stringify({ avatarColor: null }),
  });
  check('avatar colour can be reset to automatic', clearedColour.body.user?.avatarColor === null, JSON.stringify(clearedColour.body.user));

  const badColour = await bobApi('/api/profile', {
    method: 'PATCH',
    body: JSON.stringify({ avatarColor: 'chartreuse' }),
  });
  check('an unknown avatar colour is rejected', badColour.status === 400, JSON.stringify(badColour.body));

  const emptyName = await bobApi('/api/profile', {
    method: 'PATCH',
    body: JSON.stringify({ displayName: '   ' }),
  });
  check('a blank display name is rejected', emptyName.status === 400, JSON.stringify(emptyName.body));

  // The colour must survive the profile sync that runs on every sign-in.
  await bobApi('/api/profile', { method: 'PATCH', body: JSON.stringify({ avatarColor: 'violet' }) });
  await bobApi('/api/session', { method: 'POST', body: '{}' });
  const afterResync = await aliceApi('/api/users/search?q=renamed');
  check(
    'a rename survives the next sign-in sync',
    afterResync.body.users?.some((u) => u.uid === bob.uid && u.displayName === 'Renamed Bob'),
    JSON.stringify(afterResync.body.users?.map((u) => u.displayName))
  );
  check(
    'a chosen colour survives the next sign-in sync',
    afterResync.body.users?.find((u) => u.uid === bob.uid)?.avatarColor === 'violet',
    JSON.stringify(afterResync.body.users?.map((u) => [u.displayName, u.avatarColor]))
  );

  const revoked = await bobApi('/api/account/revoke', { method: 'POST', body: '{}' });
  check('sign out everywhere succeeds', revoked.status === 200, JSON.stringify(revoked.body));

  /* --------------------------------------------------------- delete account */

  const dave = await makeUser('weave-e2e-dave@example.invalid', 'E2E Dave');
  const daveApi = apiFor(await idTokenFor(dave.uid));
  await daveApi('/api/session', { method: 'POST', body: '{}' });

  const daveDm = await daveApi('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ type: 'dm', userId: alice.uid }),
  });
  const daveDmId = daveDm.body.conversation.id;

  const daveGroup = await aliceApi('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ type: 'group', name: 'Dave Group', memberIds: [dave.uid] }),
  });
  const daveGroupId = daveGroup.body.conversation.id;
  if (daveGroupId) made.conversations.push(daveGroupId);

  const deleted = await daveApi('/api/account', { method: 'DELETE' });
  check('account can be deleted', deleted.status === 200, JSON.stringify(deleted.body));

  const gone = await aliceApi('/api/users/search?q=e2e%20dave');
  check('a deleted account leaves the directory', !gone.body.users?.some((u) => u.uid === dave.uid), JSON.stringify(gone.body.users));

  const aliceInbox = await aliceApi('/api/conversations');
  const daveDmStill = aliceInbox.body.conversations?.some((c) => c.id === daveDmId);
  check('the deleted account’s DMs are removed', !daveDmStill, `dm ${daveDmId} still listed`);

  const groupNow = aliceInbox.body.conversations?.find((c) => c.id === daveGroupId);
  check('the deleted account is dropped from groups', groupNow && !groupNow.memberIds.includes(dave.uid), JSON.stringify(groupNow?.memberIds));
  check(
    'the deleted account leaves no per-member state behind',
    groupNow && !(dave.uid in (groupNow.unread ?? {})) && !(dave.uid in (groupNow.reads ?? {})),
    JSON.stringify({ unread: groupNow?.unread, reads: groupNow?.reads })
  );

  const daveAuthGone = await auth().getUser(dave.uid).then(() => false).catch(() => true);
  check('the Firebase Auth record is deleted too', daveAuthGone);

  /* -------------------------------------------------------------- leave */

  const left = await carolApi(`/api/conversations/${groupId}/members`, { method: 'DELETE' });
  check('member can leave a group', left.status === 200 && left.body.deleted === false, JSON.stringify(left.body));

  for (const ws of [aliceWs, bobWs, carolWs]) ws.close();
} catch (error) {
  check('e2e run', false, String(error?.stack ?? error));
} finally {
  /* ----------------------------------------------------------- cleanup */
  try {
    for (const id of made.conversations) {
      await db().recursiveDelete(db().collection('conversations').doc(id));
    }
    for (const uid of made.uids) {
      await db().collection('users').doc(uid).delete().catch(() => {});
    }
    if (made.uids.length) await auth().deleteUsers(made.uids);
    console.log('\ncleaned up ' + made.uids.length + ' test accounts and ' + made.conversations.length + ' conversations');
  } catch (error) {
    console.log('\ncleanup problem:', String(error).slice(0, 200));
  }

  server?.kill('SIGTERM');
  await sleep(500);
  server?.kill('SIGKILL');
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? '\nALL E2E CHECKS PASSED' : `\n${failed.length} FAILURE(S)`);
process.exit(failed.length === 0 ? 0 : 1);
