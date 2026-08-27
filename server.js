import { createServer } from 'node:http';

import next from 'next';

import { attachWebsocketServer } from './src/server/ws.js';

/**
 * Custom Next.js server.
 *
 * Next and the websocket endpoint share one HTTP server and one port, so the
 * browser talks to `ws://<same-origin>/ws` with no extra process, no proxy and no
 * CORS. `/ws` upgrades are claimed by us; everything else (including Next's dev
 * HMR socket) is handed back to Next.
 */

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);

const app = next({ dev, hostname, port, turbopack: dev });

// Handlers are only available once the app has booted.
await app.prepare();

const handle = app.getRequestHandler();
const upgrade = app.getUpgradeHandler();

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error('[http] request failed', error);
    res.statusCode = 500;
    res.end('Internal Server Error');
  });
});

const ws = attachWebsocketServer(server);

server.on('upgrade', (req, socket, head) => {
  // `req.url` is origin-relative here; the base only exists to satisfy the parser.
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  if (pathname === ws.path) {
    ws.handleUpgrade(req, socket, head);
    return;
  }
  upgrade(req, socket, head).catch(() => socket.destroy());
});

server.listen(port, hostname, () => {
  const shown = hostname === '0.0.0.0' ? 'localhost' : hostname;
  console.log(`  Weave ready on http://${shown}:${port}`);
  console.log(`  websocket listening on ws://${shown}:${port}${ws.path}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    ws.wss.close();
    server.close(() => process.exit(0));
    // Do not let a lingering socket hold the process open.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
