/**
 * Mirrors every Firebase Auth account into the Firestore `users` directory.
 *
 * The app does this automatically on each sign-in (POST /api/session), but an
 * account that signed in while Firestore was unreachable never got written — it
 * can log in yet is invisible to user search. This backfills those.
 *
 *   npm run backfill
 *
 * Idempotent: re-running it just refreshes existing entries.
 */
import { auth } from '../src/server/firebase-admin.js';
import { getUsers, upsertUser } from '../src/server/repo.js';

const accounts = [];
let pageToken;

do {
  const page = await auth().listUsers(1000, pageToken);
  accounts.push(...page.users);
  pageToken = page.pageToken;
} while (pageToken);

console.log(`found ${accounts.length} auth account(s)`);

const before = new Set((await getUsers(accounts.map((a) => a.uid))).map((u) => u.uid));

for (const account of accounts) {
  const profile = await upsertUser({
    uid: account.uid,
    email: account.email ?? null,
    displayName: account.displayName ?? null,
    photoURL: account.photoURL ?? null,
  });

  const state = before.has(account.uid) ? 'refreshed' : 'ADDED';
  console.log(`  ${state.padEnd(9)} ${profile.displayName}  <${profile.email ?? 'no email'}>`);
}

console.log('\ndirectory is in sync — these accounts are now findable in search');
