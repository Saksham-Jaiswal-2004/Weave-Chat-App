# Weave — Technical Walkthrough Script

**Audience:** a professional developer — someone who will ask *why*, not *what*.
**Running time:** ~27 minutes of material, plus Q&A. Drop sections 6 and 7 for a
15-minute slot; drop the live demo for 10.
**Format:** speak the prose; the indented blocks are stage directions and answers to
questions you should expect to be interrupted with.

Everything numeric in this script is measured, not estimated. The commands that
produce each figure are given so you can re-run them before you present — if a
number has drifted, correct the script rather than the audience.

---

## 0. Cold open — 60 seconds

> Weave is a realtime chat application. Direct messages and group chats, text only.
> Firebase Auth for identity, Firestore for storage, and a websocket layer I wrote
> by hand rather than using socket.io or Firestore's realtime listeners.
>
> It is about ten thousand lines of application code with seven runtime
> dependencies. It runs on Firebase's free tier by design, and that constraint is
> the reason for most of the interesting decisions in it.
>
> I want to spend most of this on three things: why there are no Firestore
> listeners, how read receipts avoid a per-message write, and the two bugs that
> only showed up because the tests drive a real browser.

    Do not open with the feature list. A developer audience will assume features
    and interrogate architecture. Lead with the constraint — free tier, hand-rolled
    socket — because every design choice downstream falls out of it.

---

## 1. What it does — 3 minutes

Run through this briskly. If you are demoing, do it in two browser profiles side by
side; a single window cannot show realtime.

**Conversations**
- Direct messages, found by name or email prefix.
- Group chats with admin roles: rename, add, remove, promote, demote. A group is
  never left without an admin — if the last one leaves, the longest-standing
  remaining member is promoted.
- Typing indicators and online/offline presence.

**Messages**
- Reply with a quoted snapshot, edit, soft delete.
- Emoji reactions, with a built-in picker — 393 emoji, searchable, zero dependencies.
- `@mentions` with inline autocomplete and `@everyone` in groups.
- Read receipts: one tick sent, two ticks delivered, two blue ticks read.

**Around the edges**
- Server-owned unread counts, so they survive a reload and agree across devices.
- Browser notifications, a synthesised sound, a tab-title badge, per-conversation
  mute — which mentions deliberately pierce.
- In-thread search, keyboard shortcuts, a settings panel, account deletion.

    Demo beat worth planning: send a message with the recipient's window closed,
    then open it. The tick goes one → two → blue in front of the audience. That
    single sequence sells the receipt design better than a slide.

---

## 2. Architecture — 8 minutes

### 2.1 One process, one port

> `server.js` boots Next.js and attaches a `ws` server to the same HTTP server.
> Upgrades on `/ws` are claimed by the socket layer; everything else, including
> Next's own dev HMR socket, is handed back to Next.

```
browser ──HTTP──►  Next route handlers ──┐
   │                                     ├──► repo.js ──► Firestore (Admin SDK)
   └───WS───►  ws.js ──► hub.js ──────────┘
                  │
                  └─ fan-out to other members' sockets
```

> No second process, no reverse proxy, no CORS. The browser connects to
> `ws://<same-origin>/ws`.

**The one subtlety worth stating out loud:** `hub.js`, the live connection registry,
is pinned to `globalThis`. Next bundles route handlers into its own module graph, so
a plain module singleton would give the HTTP routes a *different* instance than the
one `server.js` created. Pinning it means an HTTP call — "group created" — can push
straight down an open socket.

    Expect: "Why not socket.io?" Answer: the protocol here is nine client events
    and sixteen server events. socket.io's value is transport fallback and room
    management; we need neither, and it is ~40 KB of client bundle plus a wire
    format I would then have to reason through when debugging. The frame log in the
    browser is currently plain readable JSON, which is how two of the bugs later in
    this script were found.

### 2.2 No Firestore listeners — the central decision

> `onSnapshot` is deliberately absent. The browser never talks to Firestore at all.
> It holds a websocket and calls our own REST endpoints.

Two consequences:

**Cost.** Firestore bills per document read. A listener re-reads on every change,
for every connected client. Here a message is one write, fanned out in memory:

| Approach | 10-person group, one message |
| --- | --- |
| `onSnapshot` per client | 1 write + 10 reads |
| This design | 1 write, 0 extra reads |

**Security.** Only the server holds credentials, so `firestore.rules` denies all
client access outright. A leaked web API key gets an attacker nothing — it is an
identifier, not a secret, and here it genuinely cannot be used to read anyone's
messages.

    Expect: "So you've rebuilt what Firebase gives you for free." Yes — knowingly.
    The trade is that we own reconnection, ordering, and fan-out — 977 lines across
    ws.js and socket-client.ts, which is real weight. In exchange the read bill
    is flat in the number of connected clients instead of linear, and the database
    is unreachable from the browser. On a paid plan with a small user base, I would
    reconsider.

### 2.3 The data model, and why receipts are cheap

```
users/{uid}
  email, emailLower, displayName, displayNameLower, photoURL, avatarColor, …

conversations/{conversationId}
  type, name, memberIds[], admins[], createdBy, createdAt, updatedAt
  lastMessage: { id, senderId, text, createdAt } | null
  reads:          { [uid]: number }   // newest createdAt they have read
  delivered:      { [uid]: number }   // newest createdAt their client received
  unread:         { [uid]: number }
  unreadMentions: { [uid]: number }
  muted:          { [uid]: boolean }

conversations/{id}/messages/{messageId}
  senderId, text, createdAt, editedAt?, deletedAt?
  replyTo?:   { id, senderId, text }   // snapshot
  mentions?:  string[]
  reactions?: { [emoji]: uid[] }
```

Four decisions in there are load-bearing:

1. **DM ids are deterministic** — `dm__<uidA>__<uidB>`, uids sorted. Two people
   cannot create duplicate threads by both hitting "new chat" at once.

2. **Receipts are per member, not per message.** One timestamp per person says
   everything older has been read. Marking a thread read is therefore a *single*
   document write no matter how many messages it holds. Ticks are derived on the
   client by comparing a message's `createdAt` against those timestamps.

3. **`replyTo` is a snapshot, not a pointer.** Editing the original cannot rewrite
   history inside the reply, and rendering a quote costs no extra read.

4. **`*Lower` fields exist** because Firestore has no case-insensitive or substring
   index. User search is a prefix range scan over them, using `U+F8FF` as the
   upper bound sentinel — it sorts after any ordinary character, which makes
   `[q, q + U+F8FF]` a prefix range.

    Expect: "Why not `serverTimestamp()`?" Because a single server owns the clock,
    and a plain epoch millisecond is directly sortable, JSON-safe, and needs no
    read-back to resolve. `serverTimestamp()` would cost a round trip to learn the
    value we just wrote.

### 2.4 Everything mutating is optimistic

Sends, edits, deletes and reactions all apply locally first and reconcile when the
server echoes. If the server refuses, an `error` frame triggers a re-read of the
open thread and the local guess is discarded.

This is not polish — it is a correctness-of-perception issue, and I have the numbers
for it in the next section.

---

## 3. KPIs — 4 minutes

These are the numbers I would actually track. Each one has the command that
produces it, so they can be re-measured rather than trusted.

### 3.1 Size and shape

| Metric | Value |
| --- | --- |
| Application code | **10,005 lines** (`src/` + `server.js`) |
| Test harnesses | **1,565 lines** (`scripts/`) |
| Source files | **58** |
| Runtime dependencies | **7** — `next`, `react`, `react-dom`, `firebase`, `firebase-admin`, `ws`, `zustand` |
| Client JS shipped | **244 KB gzipped** across all chunks (822 KB raw) |
| Largest single chunk | 70 KB gzipped — dominated by the Firebase Auth SDK |

```bash
find src server.js -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.css' \) -exec cat {} + | wc -l
cat .next/static/chunks/*.js | gzip -9 | wc -c
```

> Seven runtime dependencies is the number I am most pleased with. The emoji
> picker, the icons, the notification layer and the websocket client are all
> first-party, so there is no transitive tree to audit or upgrade.

### 3.2 Cost per action — the one that decides whether this scales

Firestore's free tier is **50,000 reads and 20,000 writes per day**.

| Action | Reads | Writes |
| --- | --- | --- |
| Send a message | 1 | 2 (message + conversation preview) |
| Send a reply | 2 | 2 (extra read resolves the quoted snapshot) |
| Mark a thread read | 1 | 1 — **skipped entirely when nothing changed** |
| Toggle a reaction | 1 | 1 |
| Load the inbox | 1 query + 1 batched profile fetch | 0 |
| Delivery acknowledgement | N | 1 batched write |

**Writes bind before reads.** At 2 writes per message, the free tier supports
roughly **10,000 messages per day** before the write quota is the limit — reads
would allow 50,000. That is the single number to watch.

    The read-receipt no-op skip is the largest single write saving in the app.
    Clients re-announce their read position on every focus and every scroll; without
    that check each one would be a write, and an idle user with the tab focused
    would burn quota doing nothing.

### 3.3 Latency

Measured against the live project, whose Firestore lives in `nam5` (US
multi-region), from India:

| Metric | Value |
| --- | --- |
| Firestore write, median | **~1.4 s** (peaks ~1.9 s) |
| Reaction appears on screen | **1 ms** |
| Delete appears on screen | **4 ms** |

> The gap between those rows is the whole argument for the optimistic layer. Before
> it, every reaction and delete blocked on that 1.4-second round trip, and the
> buttons read as broken rather than slow. That was a real bug report, not a
> hypothetical.

    Worth saying plainly: the region is wrong for this user base. `asia-south1`
    would cut it substantially. Firestore regions cannot be changed after creation,
    so fixing it means a new database and a migration — which is why the optimistic
    layer was the right first move.

### 3.4 Test coverage

| Suite | Checks | What it proves |
| --- | --- | --- |
| `npm run e2e` | **72** | The socket protocol and HTTP API against a live Firebase project |
| `npm run e2e:ui` | **31** | Real Chrome, real login form, real clicks |
| `npm run doctor` | 6 | Setup preflight, each failure naming the console screen that fixes it |

Both suites create throwaway accounts and delete everything they made.

> The split matters. The protocol suite passed at 100% while three features
> appeared broken to the user, because it speaks the socket directly and never
> touches the DOM. It proved the server right and said nothing about whether the
> buttons were wired up. That gap is why the browser suite exists.

---

## 4. Drawbacks — 4 minutes

Be direct here. A developer audience trusts a talk more when the speaker names the
weaknesses before they are asked.

### 4.1 Single instance — the blocker for real deployment

The hub is in-process memory. Two server instances means two islands of sockets:
users on instance A never see messages fanned out on instance B. It also rules out
serverless hosting entirely — this needs a long-lived Node process.

**This is the one thing standing between the project and production.**

### 4.2 Presence is broadcast to everyone

Every presence change goes to every signed-in client. Fine at small scale; it is
O(users²) in the limit and needs a contact-scoped fan-out before it grows.

### 4.3 Search is weak in two different ways

- **User search is prefix-only.** "ada" finds "Ada Lovelace"; "love" does not.
- **In-thread search only covers loaded messages.** Firestore has no full-text
  index, and scanning the subcollection costs one read per message scanned — about
  100 searches per day would exhaust the free tier. The UI states how many messages
  it is searching and offers to load more, rather than pretending to cover history.

### 4.4 Delivery semantics are approximate

`delivered` is stamped when the server fans out to an open socket, not when the
client confirms receipt. A frame lost between server and browser would show two
ticks having never arrived. A true ack would cost a write per message per recipient,
which is exactly the cost the design is avoiding.

### 4.5 Other honest gaps

- No media or attachments. Cloud Storage for Firebase requires the Blaze plan on new
  projects, so this would break the free-tier constraint.
- No push notifications to a closed tab — that needs FCM and a service worker.
- The rate limiter is per socket, in memory. It resets on reconnect and does not
  survive a restart.
- No automated accessibility regression test. The audit was manual; nothing stops it
  regressing.

---

## 5. How to improve it — 4 minutes

Ordered by value per unit of work, not by how interesting each one is.

### Tier 1 — required before production

**1. Redis pub/sub behind the hub.** Keep `hub.js`'s interface exactly as it is and
back `broadcastToUsers` with a Redis channel; each instance subscribes and delivers
to its own sockets. This is the change that unlocks horizontal scaling, and the hub
was written as a narrow module specifically so this swap stays local.

**2. Move Firestore to a region near the users.** Roughly a 4× latency improvement
for this user base. Requires a new database and a migration script — the existing
`repo.js` is the only thing that touches Firestore, so the migration surface is one
file.

**3. Persist rate limiting.** Move the token bucket to Redis alongside the hub so it
survives reconnects and restarts.

### Tier 2 — clear product wins

**4. Real message search.** Mirror messages into Typesense or Algolia on write. This
also fixes user search. Adds an external dependency and a sync path to keep correct,
which is why it is not Tier 1.

**5. True delivery acks.** Have the client confirm receipt and batch those
confirmations — one write per client per few seconds rather than per message. This
tightens 4.4 without giving up the cost model.

**6. Media sharing.** Needs Blaze. Budget for image resizing and a thumbnail
pipeline; do not just store originals.

### Tier 3 — engineering health

**7. Component and unit tests.** The two e2e suites are excellent at catching
integration failures and slow at catching logic errors. The store reducers and
`utils.ts` — receipts, mention parsing — are pure and would test fast.

**8. CI.** Both suites need live Firebase credentials, so they cannot run on a fork's
PR without a dedicated test project. Set one up and gate merges on it.

**9. Accessibility regression tests.** Add `axe-core` to the browser suite so the
audit does not quietly decay.

**10. Structured logging and error reporting.** Currently `console.error`. Anything
running unattended needs correlation ids and a sink.

---

## 6. Two war stories — 3 minutes

Keep these. They are the most persuasive part of the talk because they show the
process, not the result.

### 6.1 "Reactions and delete are not working"

They *were* working. The client sent the frame, the server answered, the data
persisted. The problem was that every one of those actions blocked on a 1.4-second
Firestore round trip before anything moved on screen. Dead-feeling, which reads as
broken.

Found by capturing websocket frames in a real Chrome over the DevTools Protocol —
the frame log showed `message:reaction` arriving perfectly, just later than the user
had given up. Fixed with the optimistic layer: 1 ms and 4 ms.

    The lesson to state: "works" and "feels like it works" are different
    properties, and only one of them was being tested.

### 6.2 The two stale-code traps

The server has two halves that reload differently, and both bit:

| Path | Loaded by | Reloads in dev? | Reloads in prod test? |
| --- | --- | --- | --- |
| `src/app/api/**` → `repo.js` | Next's bundler | **yes** | only after `next build` |
| `server.js` → `ws.js` → `repo.js` | Node, once at startup | **no** | yes — read from disk |

They are *mirror images*, and each produced a confusing failure:

- In dev, a stale `node server.js` gave a server that **read** new fields correctly
  while silently never **writing** them. Reactions vanished on reload, deleted
  messages came back, reply quotes went missing. It looks exactly like data
  corruption; it is an old process.
- In the production test harness, the opposite: the websocket layer had a fix that
  the bundled HTTP routes did not, so a suite confidently tested old route code.

Both are now closed structurally rather than by remembering:
`npm run dev` runs under `--watch-path=./src/server --watch-path=./server.js`, and
both e2e suites compare `.next` against source mtimes and rebuild before running.

    If you take one thing from this section: when a system has two loaders, the
    failure mode is not "stale code", it is "half the code is stale", and that
    presents as impossible behaviour.

---

## 7. Questions you should expect

**"Why Zustand and not Redux / Context?"**
> Socket frames arrive outside React. Zustand's `getState()` lets the socket client
> write to the store without a hook or a dispatch ceremony, and selector-level
> subscriptions mean a typing indicator does not re-render the message list. Context
> would re-render the tree on every frame.

**"How do you prevent duplicate messages with optimistic sending?"**
> Each optimistic message carries a `clientId`. The server echoes that id back to
> the sender *only* — everyone else gets the plain message. The sender reconciles in
> place instead of appending. There is also a reconciliation window on refetch, so a
> message that was persisted just as the socket dropped does not appear twice.

**"What happens when the socket drops mid-send?"**
> Outbound frames queue in memory and flush on reconnect. Unacknowledged sends time
> out after 15 seconds and render a retry affordance rather than spinning forever.
> On reconnect the client refetches the inbox and the open thread to catch anything
> missed while it was away.

**"Is the websocket authenticated per message or per connection?"**
> Per connection. The client sends a Firebase ID token as the first frame and has 10
> seconds to do it. Membership is re-checked on every conversation-scoped event
> against a 60-second membership cache, so a removed member cannot keep posting.

**"What stops someone reading a conversation they are not in?"**
> Every read path checks `memberIds` server-side, and the browser has no Firestore
> access at all. Both are covered in the e2e suite — non-members are blocked from
> reading and from posting.

**"How big is the team this was built for?"**
> As written, one instance, so realistically tens of concurrent users. The
> architecture does not prevent more; the in-memory hub does. See Tier 1.

---

## Appendix — commands for the demo

```bash
npm run doctor     # setup preflight — run this first, in front of them
npm run dev        # http://localhost:3000
npm run e2e        # 72 protocol checks against live Firebase
npm run e2e:ui     # 31 checks in a real Chrome
```

Two browser profiles are required to demo realtime — Firebase Auth persists to
`localStorage`, so two tabs in the same profile share one session. Normal plus
incognito is the quickest path.
