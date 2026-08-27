# Weave

A small, fast chat app — direct messages and group chats, text only.

Built as an MVP: Firebase Auth for identity, Firestore (free tier) for storage, a
hand-rolled WebSocket server for realtime, and Zustand for the client cache.

---

## What it does

**Conversations**
- **Direct messages** — find someone by name or email, start a 1:1 thread
- **Group chats** with admin roles: rename, add and remove members, promote and
  demote admins. A group is never left without an admin.
- **Realtime delivery** over a custom WebSocket connection
- **Typing indicators** and **online/offline presence**

**Messages**
- **Read receipts** — one tick sent, two ticks delivered, two blue ticks read, with
  "seen by" detail in groups
- **Reply** with a quoted snapshot, **edit**, and **soft delete**
- **Emoji reactions**, plus a built-in emoji picker with search (no dependency)
- **@mentions** with inline autocomplete, `@everyone` in groups, and highlighting
- **Optimistic sending** with pending / failed states and a retry affordance
- Message grouping, day separators, an unread divider, paginated history

**Your account**
- **Settings** — change your display name, pick an avatar colour (or leave it
  derived from your id), sign out everywhere, delete your account
- Deleting an account removes its DMs outright, drops it from every group it was in
  along with all of its per-member state, and deletes the Firebase Auth record last

**Finding things**
- **In-thread search** over the loaded messages, with a control to widen the range
- **Keyboard shortcuts** — search, new chat, move between conversations, and `?`
  for the full list

**Staying on top of it**
- **Unread counts** maintained server-side, so they survive a reload and follow you
  between devices
- **Browser notifications** with a synthesised sound and a tab-title badge
- **Per-conversation mute** — which mentions deliberately pierce
- **Offline queue** — messages typed while disconnected send on reconnect

Not in this release: media and attachments, avatar upload, push notifications to a
closed tab (that needs FCM and a service worker), and full-history message search.

---

## Stack and the decisions behind it

| Piece | Choice | Why |
| --- | --- | --- |
| Framework | Next.js 16 (App Router) + React 19 | One process serves the UI and the API |
| Styling | Tailwind CSS v4 | Theme tokens live in `globals.css`, no config file |
| Auth | Firebase Auth (email/password + Google) | Identity without running an auth service |
| Database | Firestore, Admin SDK only | Free tier, and no client SDK in the bundle |
| Realtime | `ws` — hand-written protocol | Explicitly requested; also cheaper than listeners |
| Client state | Zustand | Socket frames land in the store, components re-render |

### No Firestore listeners

`onSnapshot` is deliberately absent. The browser never talks to Firestore at all —
it holds a WebSocket and calls our own REST endpoints. Two consequences worth
knowing:

1. **Cost.** Firestore bills per document read. A listener re-reads on every
   change, for every connected client. Here a message costs one write and is then
   fanned out in memory, so a 10-person group chat costs 1 write instead of 1 write
   + 10 reads.
2. **Security.** Since only the server holds credentials, `firestore.rules` denies
   all client access outright. A leaked web API key gets an attacker nothing.

### One process, one port

`server.js` boots Next and attaches a `ws` server to the same HTTP server. `/ws`
upgrades are claimed by the socket layer; everything else — including Next's dev
HMR socket — is handed back to Next. No second process, no proxy, no CORS.

```
browser ──HTTP──►  Next route handlers ──┐
   │                                     ├──► repo.js ──► Firestore (Admin SDK)
   └───WS───►  ws.js ──► hub.js ──────────┘
                  │
                  └─ fan-out to other members' sockets
```

`hub.js` — the live connection registry — is pinned to `globalThis` so the Next
route handlers and the socket server share one instance. That is how "group
created" (an HTTP call) can push straight down an open socket.

---

## Setup

### 1. Create the Firebase project

1. Go to the [Firebase console](https://console.firebase.google.com/) and create a
   project (the free **Spark** plan is enough).
2. **Build → Authentication → Get started.** Enable **Email/Password**. Enable
   **Google** too if you want the Google button to work.
3. **Build → Firestore Database → Create database.** Start in **production mode**
   and pick a region.

### 2. Grab the two sets of credentials

**Web app config** — Project settings → General → Your apps → Web app (create one
if there is none). Copy the `firebaseConfig` values.

**Service account** — Project settings → Service accounts → *Generate new private
key*. This downloads a JSON file. You need three fields from it: `project_id`,
`client_email`, `private_key`.

### 3. Configure the environment

```bash
cp .env.example .env.local
```

Fill it in. The private key has to stay on one line with its `\n` escapes intact,
exactly as it appears in the downloaded JSON:

```
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n"
```

### 4. Install and run

```bash
npm install
npm run doctor       # verifies the setup above before you start
npm run dev          # http://localhost:3000
```

`npm run doctor` checks the env vars, that the web config and service account point
at the same project, that the private key parses, that Authentication is
provisioned, and that the Firestore database exists — each failure naming the
console screen that fixes it.

For production:

```bash
npm run build
npm start
```

### 5. Lock down Firestore (recommended)

`firestore.rules` denies all direct client access, which is correct here because
everything goes through the Admin SDK. Deploy it with:

```bash
npx firebase deploy --only firestore:rules
```

No composite indexes are required — see *Free-tier notes* below.

### Troubleshooting

**`CONFIGURATION_NOT_FOUND` (400) on sign-up or sign-in**

Firebase Authentication has not been provisioned for the project. Creating a
Firebase project does *not* create the auth config — someone has to open
**Authentication** in the console and click **Get started** once, then enable the
**Email/Password** provider under *Sign-in method*.

You can confirm it from the terminal — this returns the project's auth config once
it exists, and `CONFIGURATION_NOT_FOUND` until then:

```bash
curl "https://identitytoolkit.googleapis.com/v1/projects?key=$NEXT_PUBLIC_FIREBASE_API_KEY"
```

Note that an invalid key fails differently (`API_KEY_INVALID`), so this error means
the key is fine and the config is missing.

**User search finds nobody, even though the accounts exist**

Search reads the `users` collection in Firestore, which is *not* the same thing as
the Firebase Auth account list. A profile is written there by `POST /api/session`
on every sign-in. If Firestore was missing or unreachable at the time someone
signed in, that write failed and the account is invisible to search even though it
can log in perfectly well.

Run `npm run doctor`. Once Firestore is reachable, **each account has to sign in or
reload once** to register itself in the directory — then it becomes findable.

**`auth/operation-not-allowed`** — the provider you used is switched off.
Authentication → Sign-in method → enable Email/Password (and Google, if you want
that button to work).

**`auth/unauthorized-domain`** on Google sign-in — add the host under
Authentication → Settings → Authorized domains. `localhost` is allowed by default.

**`Server is not configured. Check the Firebase env vars.` (500)** — the service
account is missing or malformed. Most often the private key lost its `\n` escapes;
it must stay on one line exactly as it appears in the downloaded JSON.

### Trying it out with two accounts

Realtime needs two signed-in users. They must be in **separate browser profiles** —
Firebase Auth persists to `localStorage`, so two tabs in the same profile share one
session and signing in as the second user just signs the first one out.

What works:

- Chrome window + an **incognito** window
- Chrome + Firefox/Edge
- Two Chrome profiles (`⋮` → Profile → Add)

Then:

1. `npm run dev`, open <http://localhost:3000> in both windows.
2. Sign up as a different account in each — any email works, it is never verified.
3. In one window: **+** → search for the other by name or email → send a message.
4. Watch the other window. The thread appears in the sidebar, the message lands
   without a refresh, the presence dot is green, and typing in one shows "… is
   typing" in the other.

For a group, use the people icon next to **+**, name it, and add both other
accounts. A third profile makes group fan-out more obvious.

Worth trying deliberately:

- **Offline queue** — stop the dev server, send a message (it greys out), restart.
  It sends on reconnect and the banner clears.
- **Multi-tab** — open a second tab as the *same* user; both receive the message,
  and presence only flips offline when the last tab closes.

---

## Data model

```
users/{uid}
  email, emailLower, displayName, displayNameLower, photoURL, createdAt, lastSeenAt

conversations/{conversationId}
  type: 'dm' | 'group'
  name: string | null            // groups only
  memberIds: string[]
  admins: string[]               // groups only
  createdBy, createdAt, updatedAt
  lastMessage: { id, senderId, text, createdAt } | null

  // per-member maps, all keyed by uid
  reads:          { [uid]: number }   // newest createdAt they have read
  delivered:      { [uid]: number }   // newest createdAt their client received
  unread:         { [uid]: number }
  unreadMentions: { [uid]: number }
  muted:          { [uid]: boolean }

conversations/{conversationId}/messages/{messageId}
  senderId, text, createdAt
  editedAt?, deletedAt?
  replyTo?:   { id, senderId, text }   // snapshot
  mentions?:  string[]                 // uids, or ['*'] for everyone
  reactions?: { [emoji]: uid[] }
```

A few things that are load-bearing:

- **DM ids are deterministic** — `dm__<uidA>__<uidB>` with the uids sorted. Two
  people cannot end up with duplicate threads even if they both hit "new chat" at
  the same moment.
- **`lastMessage` is denormalised** onto the conversation so the sidebar renders
  from one query instead of one query per thread.
- **`createdAt` is a server-assigned epoch millisecond**, not a Firestore
  `serverTimestamp()`. A single server owns the clock, and the value is directly
  sortable and JSON-safe, so pagination needs no extra read to resolve it.
- **`*Lower` fields** exist because Firestore has no case-insensitive or substring
  search. User search is a prefix range scan over these.
- **Receipts are per member, not per message.** One timestamp per person says
  everything older has been read, so marking a thread read is a single document
  write no matter how many messages it contains. Ticks are derived client-side by
  comparing a message's `createdAt` against those timestamps:

  | Ticks | Meaning | Source |
  | --- | --- | --- |
  | one | stored on the server | the message exists |
  | two | on the recipient's device | `delivered[uid] >= createdAt` |
  | two, blue | they opened the thread | `reads[uid] >= createdAt` |

  `delivered` is stamped at send time for anyone holding an open socket. A recipient
  who was **offline** then has no stamp, so their client acknowledges on its next
  inbox load — otherwise the sender would sit on one tick forever even after the
  message arrived. That acknowledgement is batched (N reads, one write), capped, and
  never moves a stamp backwards, so a stale client cannot undo a newer receipt.
- **Unread counters are server-owned**, incremented in the same batch that writes
  the message. The client never counts, so a reload or a second device agrees.
- **`replyTo` is a snapshot, not a pointer** — editing the original cannot rewrite
  history in the reply, and rendering a quote costs no extra read.

---

## The WebSocket protocol

Connect to `/ws`, then authenticate within 10 seconds or the socket is closed.

**Client → server**

| Event | Payload |
| --- | --- |
| `auth` | `{ token }` — a Firebase ID token |
| `ping` | keepalive for idle proxies |
| `message:send` | `{ conversationId, text, clientId, replyToId?, mentions? }` |
| `message:edit` | `{ conversationId, messageId, text }` |
| `message:delete` | `{ conversationId, messageId }` |
| `message:react` | `{ conversationId, messageId, emoji }` — toggles |
| `read` | `{ conversationId, upTo }` — turns the ticks blue |
| `delivered` | `{ entries: [{ conversationId, upTo }] }` — the second tick |
| `typing` | `{ conversationId, isTyping }` |

**Server → client**

| Event | Meaning |
| --- | --- |
| `auth:ok` | `{ userId, onlineUserIds }` — you are live |
| `auth:error` | `{ code, message }` — `expired-token` triggers one silent retry |
| `message:new` | a message; carries `clientId` back to its sender only |
| `message:rejected` | `{ clientId, reason }` — the optimistic bubble goes red |
| `message:updated` | an edit; carries `editedAt` |
| `message:deleted` | `{ messageId, deletedAt }` — the text is already gone |
| `message:reaction` | `{ messageId, reactions }` — the whole map, not a delta |
| `receipts` | `{ reads, delivered }` — drives every tick in the thread |
| `unread` | `{ unread, unreadMentions }` — sent to one member at a time |
| `conversation:upsert` | new or updated thread, with member profiles |
| `conversation:touch` | `lastMessage` + `updatedAt` for sidebar reordering |
| `conversation:removed` | you left, or the group was deleted |
| `typing` / `presence` | live indicators |

Sending is **socket-only** — there is no HTTP endpoint that writes a message. One
owner for ordering and fan-out means no split-brain between transports.

Guardrails on the server: 16 KB max frame, 4000 characters max message, a token
bucket of 15 messages with a 5/sec refill, membership checked on every send, and a
30-second ping/pong sweep that terminates half-open connections.

---

## HTTP API

All routes require `Authorization: Bearer <firebase-id-token>`. The client
refreshes the token and retries once on a 401.

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/session` | Mirror the auth record into the user directory |
| `GET` | `/api/users/search?q=` | Prefix search by name or email |
| `GET` | `/api/conversations` | Inbox + member profiles + who is online |
| `POST` | `/api/conversations` | Create a DM or a group |
| `GET` | `/api/conversations/:id/messages` | History; `?before=<createdAt>` paginates |
| `POST` | `/api/conversations/:id/members` | Add people to a group |
| `DELETE` | `/api/conversations/:id/members` | Leave a group |

---

## Project layout

```
server.js                  Next + ws on one HTTP server
src/
  server/                  server-only, plain ESM (shared by Node and Next)
    firebase-admin.js      lazy Admin SDK bootstrap
    repo.js                every Firestore read and write
    hub.js                 live socket registry (pinned to globalThis)
    ws.js                  the websocket protocol
    http.js                bearer auth + error handling for routes
  app/
    api/                   route handlers
    login/                 sign in / sign up
    chat/                  the shell, the inbox, one thread
  components/              UI
  lib/
    firebase.ts            client Auth only
    api.ts                 fetch wrapper with token refresh
    socket-client.ts       reconnect, queue, store dispatch
  store/                   Zustand: auth, chat, socket
  types.ts                 shared models + the wire protocol
```

`src/server/*` is plain JavaScript with JSDoc types on purpose: `server.js` runs it
directly under Node while Next bundles the same files for its route handlers. One
copy, no build step, still type-checked.

### The one trap in this layout

Those two consumers reload differently, and the asymmetry bites:

| Path | Loaded by | Hot reloads in dev? |
| --- | --- | --- |
| `src/app/api/**` → `repo.js` | Next's bundler | **yes** |
| `server.js` → `ws.js` → `repo.js` | Node, once at startup | **no** |

The websocket layer owns every write for reactions, edits, deletes and replies.
So a stale `node server.js` gives you a server that *reads* new fields correctly
while silently never *writing* them — reactions vanish on reload, deleted messages
come back, reply quotes go missing. It looks like data corruption; it is just an old
process.

`npm run dev` therefore runs under `--watch-path=./src/server --watch-path=./server.js`,
which restarts Node whenever that layer changes. If you ever start the server by hand,
restart it after touching `src/server/**` or `server.js` — editing and refreshing the
browser is not enough.

---

## Free-tier notes

Spark gives you 50k document reads, 20k writes and 1 GiB of storage per day.

What this app does to stay well inside that:

- **No listeners.** The single largest read multiplier is simply absent.
- **Membership cache.** The socket layer caches `conversationId → memberIds` for 60
  seconds, so a busy thread spends one read per minute instead of one per message.
  It is warmed whenever a thread is opened and invalidated when membership changes.
- **In-memory inbox sort.** `array-contains` + `orderBy` would need a composite
  index; the inbox is small, so it is sorted after the fetch. **No indexes to
  deploy.**
- **Batched profile lookups** via `getAll` instead of a read per member.
- **Debounced search** — one request per pause, not per keystroke.
- **Throttled typing events** — relayed on state change, re-asserted at most every
  few seconds.
- Leaving a group as its last member `recursiveDelete`s the message subcollection
  so storage is not orphaned.

---

## Latency

Every write costs one Firestore round trip, and that trip is only as short as the
distance to your database's region. Check yours:

```bash
npm run doctor      # confirms setup
```

A database in `nam5` (the US multi-region default) answers a write from India in
roughly **1.4 s**. That is why **every mutation is applied optimistically** — a
reaction, an edit and a delete all land on screen immediately and are reconciled
when the server echo arrives. If the server refuses one, the open thread is re-read
and the local guess is discarded.

Without that, the buttons appear dead: you click a reaction and nothing happens for
a second and a half, which reads as broken rather than slow.

**A Firestore region cannot be changed after creation.** Moving closer means
creating a new database and migrating, so it is only worth it if the latency is
actually hurting; the optimistic layer hides most of it. The one place it still
shows is sending a message, which displays "Sending…" until the write lands,
because a message needs a real server id before it can be edited, deleted or
replied to.

## Known limitations

Honest list of what an MVP leaves on the table:

- **Presence is broadcast to every signed-in client**, not just your contacts. Fine
  for a small user base; it needs a contact-scoped fan-out before it scales.
- **Single instance only.** The hub is in-process memory. Running two servers means
  two islands of sockets — that needs Redis pub/sub (or similar) to bridge.
  It also rules out serverless hosting; this needs a long-lived Node process.
- **User search is prefix-only.** "ada" finds "Ada Lovelace"; "love" does not.
  Real substring search needs a search index.
- **In-thread search only covers loaded messages.** Firestore has no full-text
  index, and scanning the subcollection would cost one read per message scanned —
  unaffordable on the free tier. The search panel says how many messages it is
  searching and offers to load more, rather than pretending to cover the history.
- **Unread counts are per-session**, held in memory, not persisted per device.
- **No read receipts, editing, deletion, or media** — all out of scope by design.

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Next + websocket server on one port, restarting on server-code edits |
| `npm run build` / `npm start` | production build and run |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run doctor` | preflight the Firebase setup, naming the console fix for each failure |
| `npm run backfill` | mirror every Auth account into the Firestore user directory |
| `npm run e2e` | end-to-end test of the live stack, over the socket protocol |
| `npm run e2e:ui` | drives the real UI in a real Chrome and clicks the buttons (31 checks) |

**`npm run backfill`** exists because a profile is written to the directory on
sign-in. An account that signed in while Firestore was unreachable can still log in
but is invisible to search. This re-syncs them. It is idempotent.

**`npm run e2e`** runs against your real Firebase project: it creates three
throwaway accounts, exercises DMs, groups, realtime delivery, typing, presence,
access control and persistence, then deletes everything it made. Do not point it at
a project holding data you care about.

**`npm run e2e:ui`** launches headless Chrome via the DevTools Protocol, signs in
through the real login form, and clicks the real buttons. It exists because the
socket-level suite can pass completely while a button is unwired — it speaks the
protocol directly and never touches the DOM. It also asserts that reactions and
deletes appear in under a second, which is a correctness property here, not a
nicety: see *Latency* below. Requires Chrome at the default Windows install path.

## Verified

- `npm run build` — clean
- `npm run typecheck` — clean
- Boot smoke test: server starts, `/login` renders, unauthenticated API returns
  401, `/ws` upgrade is accepted, a bogus token is rejected cleanly, and sending
  before authenticating is refused.
- `npm run e2e` — 72 checks against a live Firebase project, covering:
  - profile sync, search by name and by email prefix, self-exclusion
  - DM creation, deterministic reuse of an existing DM, socket push to the other member
  - realtime delivery, the sender's `clientId` echo, inbox preview updates
  - typing indicators and presence broadcast
  - group creation, fan-out, adding a member, and that member receiving later traffic
  - unread counters, and that they are addressed to one member at a time
  - delivered-but-unread state, seen receipts, and reading clearing the counter
  - reply snapshots, reactions toggling on and off, edit and soft delete
  - mentions on the message and the separate mention counter
  - group admin: rename, promote, demote, remove, mute, and leaving
  - the tick lifecycle: one tick offline, two once the recipient is back without
    opening the chat, blue once read, and that a stale receipt cannot undo a newer one
  - renaming, avatar colour, and that both survive the next sign-in sync
  - account deletion: DMs gone, dropped from groups, per-member state swept, Auth
    record removed
  - authorisation: non-members cannot read or post, non-authors cannot edit,
    non-admins cannot rename or remove anyone
