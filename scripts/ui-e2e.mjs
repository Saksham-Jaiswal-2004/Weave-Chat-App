/**
 * Drives the real UI in a real Chrome via the DevTools Protocol.
 *
 * The e2e suite speaks the socket protocol directly, so it proves the server is
 * right but says nothing about whether the buttons are wired up. This clicks them.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import WebSocket from 'ws';

import { ensureFreshBuild } from './ensure-build.mjs';

const EXTERNAL = process.env.WEAVE_BASE_URL ?? null;
const PORT = EXTERNAL ? Number(new URL(EXTERNAL).port || 80) : 3310;
const CDP_PORT = 9333;
const BASE = EXTERNAL ?? `http://localhost:${PORT}`;
const PASSWORD = 'ui-check-password-123';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const { auth, db } = await import('../src/server/firebase-admin.js');

if (!EXTERNAL) ensureFreshBuild();

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${detail}`}`);
};

/* ------------------------------------------------------------- CDP client */

class Cdp {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.waiting = new Map();
  }
  async open() {
    this.ws = new WebSocket(this.url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
    this.events = [];
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (!msg.id && msg.method) this.events.push(msg);
      const pending = this.waiting.get(msg.id);
      if (!pending) return;
      this.waiting.delete(msg.id);
      msg.error ? pending.reject(new Error(JSON.stringify(msg.error))) : pending.resolve(msg.result);
    });
    return this;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
  }
  close() {
    this.ws?.close();
  }
}

/** Runs an expression in the page and returns its value. */
async function evaluate(cdp, session, expression) {
  const res = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    session
  );
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? 'evaluate failed');
  }
  return res.result?.value;
}

/** Polls an expression until it is truthy. */
async function waitUntil(cdp, session, expression, timeoutMs = 12000, label = expression) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(cdp, session, expression);
      if (value) return value;
    } catch {
      /* page may be mid-navigation */
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/** React ignores a bare `.value =`, so go through the native setter. */
const TYPE_HELPER = `
window.__type = (selector, text) => {
  const el = document.querySelector(selector);
  if (!el) return false;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
  setter.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
};
window.__click = (selector) => {
  const el = document.querySelector(selector);
  if (!el) return false;
  el.click();
  return true;
};
window.__rowSel = (text) => {
  const rows = [...document.querySelectorAll('[id^="weave-msg-"]')];
  const row = rows.find((r) => r.textContent.includes(text));
  return row ? '#' + CSS.escape(row.id) : null;
};
true;
`;

/* ------------------------------------------------------------------ setup */

const made = { uids: [], conversations: [] };
let server;
let chrome;
const profile = mkdtempSync(join(tmpdir(), 'weave-ui-'));

async function makeUser(email, displayName) {
  const existing = await auth().getUserByEmail(email).catch(() => null);
  if (existing) await auth().deleteUser(existing.uid);
  const user = await auth().createUser({ email, password: PASSWORD, displayName });
  made.uids.push(user.uid);
  return user;
}

async function idTokenFor(uid) {
  const customToken = await auth().createCustomToken(uid);
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    }
  );
  return (await res.json()).idToken;
}

try {
  if (EXTERNAL) {
    const probe = await fetch(BASE + '/login').catch(() => null);
    check('reusing the already-running server at ' + BASE, probe?.ok === true, 'not reachable');
  } else {
  server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, NODE_ENV: process.env.WEAVE_MODE ?? 'production', PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (c) => { log += c; globalThis.__serverLog = log; });
  server.stderr.on('data', (c) => { log += c; globalThis.__serverLog = log; });
  for (let i = 0; i < 480 && !log.includes('Weave ready'); i += 1) await sleep(250);
  check('server boots', log.includes('Weave ready'), log.slice(0, 300));
  }

  const alice = await makeUser('ui-alice@example.invalid', 'UI Alice');
  const bob = await makeUser('ui-bob@example.invalid', 'UI Bob');

  const aliceToken = await idTokenFor(alice.uid);
  const bobToken = await idTokenFor(bob.uid);

  const api = (token) => async (path, init = {}) => {
    const res = await fetch(BASE + path, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const aliceApi = api(aliceToken);
  const bobApi = api(bobToken);

  await aliceApi('/api/session', { method: 'POST', body: '{}' });
  await bobApi('/api/session', { method: 'POST', body: '{}' });

  const dm = await aliceApi('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ type: 'dm', userId: bob.uid }),
  });
  const dmId = dm.body.conversation.id;
  made.conversations.push(dmId);

  // Bob speaks over a plain socket so alice has somebody else's message to act on.
  const bobWs = new WebSocket(`ws://localhost:${PORT}/ws`);
  await new Promise((res, rej) => {
    bobWs.once('open', res);
    bobWs.once('error', rej);
  });
  bobWs.send(JSON.stringify({ type: 'auth', token: bobToken }));
  await sleep(1200);
  bobWs.send(
    JSON.stringify({ type: 'message:send', conversationId: dmId, text: 'message from bob', clientId: 'b-1' })
  );
  await sleep(1200);

  /* ------------------------------------------------------------ browser */

  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let version;
  for (let i = 0; i < 60; i += 1) {
    try {
      version = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
      break;
    } catch {
      await sleep(250);
    }
  }
  check('chrome launches', Boolean(version?.webSocketDebuggerUrl), 'no CDP endpoint');

  const cdp = await new Cdp(version.webSocketDebuggerUrl).open();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);

  const since = () => cdp.events.length;
  const framesSince = (mark, dir) =>
    cdp.events
      .slice(mark)
      .filter((e) => e.method === 'Network.webSocketFrame' + dir)
      .map((e) => e.params.response?.payloadData)
      .filter(Boolean);
  const errorsSince = (mark) =>
    cdp.events
      .slice(mark)
      .filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
      .map((e) => e.params.entry.text);

  const goto = async (url) => {
    await cdp.send('Page.navigate', { url }, sessionId);
    await sleep(1500);
    await evaluate(cdp, sessionId, TYPE_HELPER);
  };

  /* -------------------------------------------------------------- log in */

  await goto(`${BASE}/login`);
  await waitUntil(cdp, sessionId, `!!document.querySelector('input[type=email]')`, 12000, 'login form');

  await evaluate(cdp, sessionId, `window.__type('input[type=email]', 'ui-alice@example.invalid')`);
  await evaluate(cdp, sessionId, `window.__type('input[type=password]', ${JSON.stringify(PASSWORD)})`);
  await evaluate(cdp, sessionId, `window.__click('button[type=submit]')`);

  await waitUntil(cdp, sessionId, `location.pathname.startsWith('/chat')`, 20000, 'redirect to /chat');
  check('sign-in works in the real UI', true);

  await goto(`${BASE}/chat/${dmId}`);
  await evaluate(cdp, sessionId, TYPE_HELPER);
  await waitUntil(cdp, sessionId, `window.__rowSel('message from bob')`, 20000, "bob's message rendered");
  check("other person's message renders", true);

  const rowSel = await evaluate(cdp, sessionId, `window.__rowSel('message from bob')`);

  /* ------------------------------------------------------ toolbar exists */

  const toolbarProbe = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const row = document.querySelector(${JSON.stringify(rowSel)});
      if (!row) return { found: false };
      const reply = row.querySelector('[aria-label="Reply to this message"]');
      const react = row.querySelector('[aria-label="Add a reaction"]');
      const del = row.querySelector('[aria-label="Delete this message"]');
      const bar = reply?.closest('div.flex.items-center');
      return {
        found: true,
        hasReply: !!reply,
        hasReact: !!react,
        hasDelete: !!del,
        opacity: bar ? getComputedStyle(bar).opacity : null,
      };
    })()`
  );
  check('reply button exists in the DOM', toolbarProbe.hasReply, JSON.stringify(toolbarProbe));
  check('react button exists in the DOM', toolbarProbe.hasReact, JSON.stringify(toolbarProbe));

  /* ---------------------------------------------------------- reactions */

  await evaluate(cdp, sessionId, `window.__click(${JSON.stringify(rowSel)} + ' [aria-label="Add a reaction"]')`);
  await sleep(600);

  const pickerOpen = await evaluate(
    cdp,
    sessionId,
    `!!document.querySelector('input[placeholder*="Search" i]') && document.querySelectorAll('button[aria-label]').length > 20`
  );
  check('reaction picker opens', pickerOpen, 'no picker after clicking react');

  const reactMark = since();
  // Click the first emoji offered.
  const clickedEmoji = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const row = document.querySelector(${JSON.stringify(rowSel)});
      const btns = [...row.querySelectorAll('button')].filter((b) => /^\\p{Extended_Pictographic}/u.test(b.textContent.trim()));
      if (!btns.length) return null;
      btns[0].click();
      return btns[0].textContent.trim();
    })()`
  );
  check('an emoji can be clicked', Boolean(clickedEmoji), 'no emoji buttons inside the row');

  // How long until the click is reflected on screen? This is what "not working"
  // actually meant: the round trip is seconds, so it must not be waited on.
  const pillSelector = `document.querySelector(${JSON.stringify(rowSel)})?.querySelector('button[aria-pressed]')`;
  const reactStarted = Date.now();
  await waitUntil(cdp, sessionId, `!!(${pillSelector})`, 25000, 'reaction pill').catch(() => {});
  const reactMs = Date.now() - reactStarted;
  check(`reaction appears immediately (${reactMs}ms)`, reactMs < 1000, `took ${reactMs}ms`);

  console.log('\n  [react] sent :', JSON.stringify(framesSince(reactMark, 'Sent')));
  console.log('  [react] recvd:', JSON.stringify(framesSince(reactMark, 'Received')).slice(0, 400));
  const reactErrors = errorsSince(reactMark);
  if (reactErrors.length) console.log('  [react] page errors:', JSON.stringify(reactErrors).slice(0, 500));

  const reactionShown = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const row = document.querySelector(${JSON.stringify(rowSel)});
      if (!row) return null;
      const pill = [...row.querySelectorAll('button[aria-pressed]')];
      return pill.map((p) => p.textContent.trim());
    })()`
  );
  check('reaction pill appears on the message', (reactionShown ?? []).length > 0, JSON.stringify(reactionShown));

  /* --------------------------------------------------------------- reply */

  await evaluate(cdp, sessionId, `window.__click(${JSON.stringify(rowSel)} + ' [aria-label="Reply to this message"]')`);
  await sleep(600);

  const bannerShown = await evaluate(
    cdp,
    sessionId,
    `!!([...document.querySelectorAll('p')].find((p) => /Replying to/i.test(p.textContent)))`
  );
  check('composer shows the "Replying to" banner', bannerShown, 'no reply banner');

  await evaluate(cdp, sessionId, `window.__type('textarea[aria-label="Message"]', 'my reply text')`);
  await sleep(300);
  await evaluate(cdp, sessionId, `window.__click('button[aria-label="Send message"]')`);

  // Wait for the server echo to settle the optimistic bubble — the toolbar is
  // deliberately withheld until a message has a real server id.
  await waitUntil(
    cdp,
    sessionId,
    `(() => {
      const rows = [...document.querySelectorAll('[id^="weave-msg-"]')];
      const row = rows.find((r) => r.textContent.includes('my reply text'));
      return !!row && !row.textContent.includes('Sending');
    })()`,
    30000,
    'reply acknowledged by the server'
  ).catch(() => {});

  const quoteShown = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const rows = [...document.querySelectorAll('[id^="weave-msg-"]')];
      const row = rows.find((r) => r.textContent.includes('my reply text'));
      if (!row) return { sent: false };
      return { sent: true, quotesOriginal: row.textContent.includes('message from bob') };
    })()`
  );
  check('reply message is sent', quoteShown.sent, JSON.stringify(quoteShown));
  check('reply renders the quoted original', quoteShown.quotesOriginal, JSON.stringify(quoteShown));

  /* --------------------------------------------------------------- ticks */

  const tickState = async () =>
    evaluate(
      cdp,
      sessionId,
      `(() => {
        const rows = [...document.querySelectorAll('[id^="weave-msg-"]')];
        const row = rows.find((r) => r.textContent.includes('my reply text'));
        const tick = row?.querySelector('[role="img"][title]');
        if (!tick) return null;
        return { title: tick.getAttribute('title'), blue: tick.className.includes('text-signal-read') };
      })()`
    );

  // Bob's socket is open, so the message should already be delivered, not just sent.
  await waitUntil(
    cdp,
    sessionId,
    `(() => {
      const rows = [...document.querySelectorAll('[id^="weave-msg-"]')];
      const row = rows.find((r) => r.textContent.includes('my reply text'));
      const tick = row?.querySelector('[role="img"][title]');
      return tick && tick.getAttribute('title') !== 'Sent';
    })()`,
    25000,
    'delivered tick'
  ).catch(() => {});

  const delivered = await tickState();
  check(`two ticks when the recipient is online (${delivered?.title})`, delivered?.title === 'Delivered', JSON.stringify(delivered));
  check('delivered ticks are not blue yet', delivered?.blue === false, JSON.stringify(delivered));

  // Bob reads it.
  const replyRow = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const rows = [...document.querySelectorAll('[id^="weave-msg-"]')];
      const row = rows.find((r) => r.textContent.includes('my reply text'));
      return row ? row.id.replace(/^weave-msg-.*?-/, '') : null;
    })()`
  );
  bobWs.send(JSON.stringify({ type: 'read', conversationId: dmId, upTo: Date.now() }));

  await waitUntil(
    cdp,
    sessionId,
    `(() => {
      const rows = [...document.querySelectorAll('[id^="weave-msg-"]')];
      const row = rows.find((r) => r.textContent.includes('my reply text'));
      const tick = row?.querySelector('[role="img"][title]');
      return tick && tick.getAttribute('title') === 'Seen';
    })()`,
    25000,
    'seen tick'
  ).catch(() => {});

  const seen = await tickState();
  check(`ticks turn blue once read (${seen?.title})`, seen?.title === 'Seen', JSON.stringify(seen));
  check('read ticks render in the read colour', seen?.blue === true, JSON.stringify({ seen, replyRow }));

  /* -------------------------------------------------------------- delete */

  // Delete a throwaway message so the reply above survives for the reload checks.
  await evaluate(cdp, sessionId, `window.__type('textarea[aria-label="Message"]', 'doomed message')`);
  await sleep(200);
  await evaluate(cdp, sessionId, `window.__click('button[aria-label="Send message"]')`);

  await waitUntil(
    cdp,
    sessionId,
    `(() => {
      const rows = [...document.querySelectorAll('[id^="weave-msg-"]')];
      const row = rows.find((r) => r.textContent.includes('doomed message'));
      return !!row && !!row.querySelector('[aria-label="Delete this message"]');
    })()`,
    30000,
    'doomed message acknowledged'
  );

  const ownRow = await evaluate(cdp, sessionId, `window.__rowSel('doomed message')`);
  await evaluate(cdp, sessionId, `window.__click(${JSON.stringify(ownRow)} + ' [aria-label="Delete this message"]')`);
  await sleep(500);

  const confirmShown = await evaluate(
    cdp,
    sessionId,
    `!!([...document.querySelectorAll('span')].find((s) => /Delete this message\\?/i.test(s.textContent)))`
  );
  check('delete confirmation appears', confirmShown, 'no confirm bar');

  await evaluate(
    cdp,
    sessionId,
    `(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Delete');
      if (btn) btn.click();
      return !!btn;
    })()`
  );

  const deleteStarted = Date.now();
  await waitUntil(
    cdp,
    sessionId,
    `document.body.textContent.includes('This message was deleted.')`,
    25000,
    'tombstone'
  ).catch(() => {});
  const deleteMs = Date.now() - deleteStarted;
  check(`delete appears immediately (${deleteMs}ms)`, deleteMs < 1000, `took ${deleteMs}ms`);

  const deletedShown = await evaluate(
    cdp,
    sessionId,
    `document.body.textContent.includes('This message was deleted.')`
  );
  check('deleted message shows a tombstone', deletedShown, 'tombstone not rendered');

  /* -------------------------------------------------------------- reload */

  // The UI is optimistic, so "it looks done" does not mean the write landed. Reloading
  // before it does would test a race rather than persistence.
  const settled = async (label, predicate, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const thread = await aliceApi(`/api/conversations/${dmId}/messages`);
      const inbox = await aliceApi('/api/conversations');
      const conversation = inbox.body.conversations?.find((c) => c.id === dmId);
      if (predicate(thread.body.messages ?? [], conversation)) return true;
      await sleep(500);
    }
    console.log(`  [reload] gave up waiting for ${label} to persist`);
    return false;
  };

  check(
    'reaction is persisted server-side',
    await settled('reaction', (messages) =>
      messages.some((m) => Object.keys(m.reactions ?? {}).length > 0)
    ),
    'no message ever gained a reaction'
  );
  check(
    'delete is persisted server-side',
    await settled('delete', (messages) => messages.some((m) => m.deletedAt)),
    'no message was ever marked deleted'
  );

  // Everything above arrived over the socket. A reload rebuilds the thread from the
  // history endpoint instead, which is a completely separate path.
  await evaluate(cdp, sessionId, `window.__beforeReload = 'stale-marker'; true`);
  await goto(`${BASE}/chat/${dmId}`);
  const survived = await evaluate(cdp, sessionId, `window.__beforeReload ?? null`);
  console.log('\n  [reload] page actually reloaded:', survived === null, `(marker=${survived})`);

  await waitUntil(cdp, sessionId, `window.__rowSel('message from bob')`, 25000, 'thread after reload');
  await sleep(2500);

  const afterReload = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const rows = [...document.querySelectorAll('[id^="weave-msg-"]')];
      const find = (t) => rows.find((r) => r.textContent.includes(t));

      const original = find('message from bob');
      const reply = find('my reply text');

      return {
        rowCount: rows.length,
        reactionPill: original ? !!original.querySelector('button[aria-pressed]') : null,
        replyQuotesOriginal: reply ? reply.textContent.includes('message from bob') : null,
        tombstone: document.body.textContent.includes('This message was deleted.'),
        doomedTextBack: document.body.textContent.includes('doomed message'),
        // Where the stale text lives says which endpoint served it.
        doomedIn: [...document.querySelectorAll('*')]
          .filter(
            (el) =>
              el.textContent.includes('doomed message') &&
              ![...el.children].some((c) => c.textContent.includes('doomed message'))
          )
          .map((el) => (el.tagName + ' :: ' + el.textContent).slice(0, 120)),
      };
    })()`
  );
  console.log('\n  [reload] state:', JSON.stringify(afterReload));

  const inboxNow = await aliceApi('/api/conversations');
  console.log(
    '  [reload] server preview:',
    JSON.stringify(inboxNow.body.conversations?.find((c) => c.id === dmId)?.lastMessage)
  );

  check('reaction survives a reload', afterReload.reactionPill === true, JSON.stringify(afterReload));
  check(
    'reply still quotes the original after a reload',
    afterReload.replyQuotesOriginal === true,
    JSON.stringify(afterReload)
  );
  check('deleted message stays deleted after a reload', afterReload.tombstone === true, JSON.stringify(afterReload));
  check(
    'deleted message does not come back',
    afterReload.doomedTextBack === false,
    JSON.stringify(afterReload)
  );

  /* ------------------------------------------------------- search & settings */

  // Ctrl+F is a browser shortcut too — if the handler does not claim it, nothing
  // in the page opens.
  await cdp.send(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 2 },
    sessionId
  );
  await sleep(700);

  const searchOpen = await evaluate(
    cdp,
    sessionId,
    `!!document.querySelector('input[placeholder*="Search this conversation" i], [role="dialog"] input[type="search"], input[aria-label*="Search messages" i]')`
  );
  check('Ctrl+F opens in-thread search', searchOpen, 'no search input appeared');

  if (searchOpen) {
    await evaluate(
      cdp,
      sessionId,
      `(() => {
        const input = document.querySelector('input[placeholder*="Search this conversation" i], [role="dialog"] input[type="search"], input[aria-label*="Search messages" i]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'from bob');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`
    );
    await sleep(900);

    const hits = await evaluate(
      cdp,
      sessionId,
      `document.querySelectorAll('[role="option"]').length`
    );
    check(`search finds the message (${hits} result(s))`, hits > 0, 'no results rendered');
  }

  await evaluate(cdp, sessionId, `window.__click('[aria-label="Profile and account settings"]')`);
  await sleep(900);

  const settings = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')];
      // Pick the settings panel by content, not by position — the search panel is
      // also a dialog and may still be mounted.
      const panel =
        dialogs.find((d) => /sign out everywhere|delete account/i.test(d.textContent)) ??
        dialogs.pop();
      if (!panel) return { dialogs: 0 };
      return {
        dialogs: dialogs.length,
        label: panel.getAttribute('aria-label'),
        hasNameInput: !!panel.querySelector('input'),
        swatches: panel.querySelectorAll('[aria-pressed]').length,
        mentionsDelete: /delete account/i.test(panel.textContent),
      };
    })()`
  );
  console.log('\n  [settings] probe:', JSON.stringify(settings));
  check('settings panel opens', Boolean(settings?.hasNameInput), JSON.stringify(settings));
  check('avatar colour swatches render', (settings?.swatches ?? 0) >= 8, JSON.stringify(settings));
  check('delete account is offered', settings?.mentionsDelete === true, JSON.stringify(settings));

  const consoleErrors = await evaluate(cdp, sessionId, `window.__weaveErrors || []`);
  if (consoleErrors?.length) console.log('\npage errors:', JSON.stringify(consoleErrors).slice(0, 600));

  bobWs.close();
  cdp.close();
} catch (error) {
  check('ui run', false, String(error?.stack ?? error).slice(0, 900));
} finally {
  try {
    for (const id of made.conversations) {
      await db().recursiveDelete(db().collection('conversations').doc(id));
    }
    for (const uid of made.uids) await db().collection('users').doc(uid).delete().catch(() => {});
    if (made.uids.length) await auth().deleteUsers(made.uids);
    console.log('\ncleaned up test data');
  } catch (error) {
    console.log('cleanup problem:', String(error).slice(0, 200));
  }
  console.log('\n  === server log tail ===');
  console.log(
    (globalThis.__serverLog ?? '')
      .split('\n')
      .filter((line) => line.trim())
      .slice(-25)
      .map((line) => '    ' + line)
      .join('\n')
  );

  chrome?.kill('SIGKILL');
  server?.kill('SIGTERM');
  await sleep(400);
  server?.kill('SIGKILL');
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? '\nALL UI CHECKS PASSED' : `\n${failed.length} UI FAILURE(S)`);
process.exit(failed.length === 0 ? 0 : 1);
