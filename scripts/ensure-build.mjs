import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Rebuilds when `.next` is older than the source.
 *
 * The test harnesses run `NODE_ENV=production node server.js`, which serves the
 * last `next build`. The websocket layer is read from disk and is therefore always
 * current, but the HTTP routes are bundled — so a server-side fix can be live on
 * one half of the app and stale on the other, and the suite quietly tests old code.
 * That is confusing enough to be worth a few seconds of mtime checking.
 */

function newestMtime(dir, newest = 0) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = newestMtime(path, newest);
    } else {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}

export function ensureFreshBuild() {
  let builtAt = 0;
  try {
    builtAt = statSync('.next/BUILD_ID').mtimeMs;
  } catch {
    /* never built */
  }

  const sourceAt = Math.max(newestMtime('src'), statSync('server.js').mtimeMs);
  if (builtAt > sourceAt) return false;

  console.log(builtAt ? '  source is newer than .next — rebuilding…' : '  no build found — building…');
  const build = spawnSync('npx', ['next', 'build'], { stdio: 'inherit', shell: true });
  if (build.status !== 0) throw new Error('next build failed; cannot run against a stale bundle');

  console.log('  build complete\n');
  return true;
}
