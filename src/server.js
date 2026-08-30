import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { PumpComments } from './index.js';

const OVERLAY_PATH = fileURLToPath(new URL('./overlay.html', import.meta.url));
const CONFIG_PATH = fileURLToPath(new URL('./config.html', import.meta.url));

/**
 * Local fan-out server: one upstream pump.fun connection, many local
 * subscribers. Any language that speaks WebSocket or HTTP can consume it —
 * Unity, Godot, OBS, a Python bot, a shell script.
 *
 *   WS   ws://localhost:8787            every event as JSON lines
 *   GET  /overlay                       OBS browser source
 *   GET  /overlay/config                live builder for overlay options
 *   GET  /health                        liveness + upstream state
 *   GET  /comments?limit=50&mint=<m>    recent buffer (polling clients)
 *   GET  /holders?limit=20&mint=<m>     top holders, from the roster
 *   GET  /stats                         counters + holder-cache efficiency
 */
export async function startServer({
  port = 8787,
  host = '127.0.0.1',
  bufferSize = 200,
  overlayDefaults = {},
  ...feedOptions
} = {}) {
  const feed = new PumpComments(feedOptions);
  const buffer = [];
  const clients = new Set();

  const broadcast = (type, data) => {
    const line = JSON.stringify({ type, data });
    for (const ws of clients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (ws.mintFilter && data?.mint && data.mint !== ws.mintFilter) continue;
      ws.send(line);
    }
  };

  feed.on('comment', (c) => {
    buffer.push(c);
    if (buffer.length > bufferSize) buffer.shift();
    broadcast('comment', c);
  });
  feed.on('command', (c) => broadcast('command', c));
  feed.on('holderChange', (h) => broadcast('holderChange', h));
  feed.on('presence', (p) => broadcast('presence', p));
  feed.on('viewers', (v) => broadcast('viewers', v));
  feed.on('drift', (d) => broadcast('drift', d));
  feed.on('degraded', (d) => broadcast('degraded', d));
  feed.on('reconnect', (r) => broadcast('reconnect', r));
  feed.on('error', (e) =>
    broadcast('error', { scope: e.scope ?? 'unknown', message: e.message })
  );

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (code, body) => {
      res.writeHead(code, {
        'content-type': 'application/json',
        // Local dev tool: let any page or game client read it.
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify(body, null, 2));
    };

    if (url.pathname === '/overlay/config' || url.pathname === '/config') {
      try {
        const html = await readFile(CONFIG_PATH);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      } catch (err) {
        return send(500, { error: `could not read config.html: ${err.message}` });
      }
    }

    if (url.pathname === '/overlay' || url.pathname === '/overlay.html') {
      try {
        let html = await readFile(OVERLAY_PATH, 'utf8');
        // Server-configured defaults, so a look can be set once instead of in
        // every query string. A query parameter still wins over these.
        if (Object.keys(overlayDefaults).length) {
          html = html.replace(
            '<div id="feed"></div>',
            `<script>window.__pumpstreamDefaults=${JSON.stringify(overlayDefaults)}</script>
<div id="feed"></div>`
          );
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          // OBS caches browser sources aggressively; always serve the current
          // file so editing the overlay and refreshing actually shows changes.
          'cache-control': 'no-store',
        });
        return res.end(html);
      } catch (err) {
        return send(500, { error: `could not read overlay.html: ${err.message}` });
      }
    }

    if (url.pathname === '/health') {
      return send(200, {
        ok: true,
        upstreamConnected: feed.connected,
        mints: feed.mints,
        holdersOnly: feed.holdersOnly,
        subscribers: clients.size,
      });
    }

    if (url.pathname === '/comments') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, bufferSize);
      const mint = url.searchParams.get('mint');
      const items = buffer.filter((c) => !mint || c.mint === mint).slice(-limit);
      return send(200, { count: items.length, comments: items });
    }

    if (url.pathname === '/holders') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 500);
      const mint = url.searchParams.get('mint') || feed.mints[0];
      const gate = feed.gates.get(mint);
      if (!gate) return send(404, { error: `not following ${mint}`, mints: feed.mints });
      const top = await gate.top(limit);
      return send(200, {
        mint,
        holders: gate.stats.rosterHolders,
        supply: gate.rosterTotal,
        // Empty when the endpoint refuses getProgramAccounts.
        rosterAvailable: !gate.stats.rosterRefused,
        top,
      });
    }

    if (url.pathname === '/stats') {
      return send(200, {
        ...feed.stats,
        subscribers: clients.size,
        buffered: buffer.length,
        holders: feed.holderStats(),
      });
    }

    return send(404, { error: 'not found', routes: ['/overlay', '/overlay/config', '/health', '/comments', '/holders', '/stats'] });
  });

  const wss = new WebSocketServer({ server });
  // `ws` re-emits the http server's listen errors on itself. Without a
  // listener here that throws and kills the process before the friendly
  // message below can ever be printed.
  wss.on('error', () => {});
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    ws.mintFilter = url.searchParams.get('mint') || null;
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));

    const replay = Math.min(
      Math.max(0, Number(url.searchParams.get('replay') ?? 10) || 0),
      bufferSize
    );
    const recent = buffer
      .filter((c) => !ws.mintFilter || c.mint === ws.mintFilter)
      .slice(-replay);

    ws.send(
      JSON.stringify({
        type: 'hello',
        data: {
          mints: feed.mints,
          holdersOnly: feed.holdersOnly,
          buffered: buffer.length,
          replaying: recent.length,
        },
      })
    );

    // OBS tears down and reloads browser sources constantly. Without this a
    // reconnecting overlay shows an empty box until the next comment happens
    // to arrive, which reads as "chat is dead". Pass ?replay=0 to opt out.
    for (const c of recent) ws.send(JSON.stringify({ type: 'comment', data: c }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', (err) =>
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(
              `port ${port} is already in use — another pumpstream is probably ` +
                `running. Stop it, or pass --port with a free one.`
            )
          : err
      )
    );
    server.listen(port, host, resolve);
  });
  await feed.start();

  return {
    feed,
    server,
    url: `http://${host}:${port}`,
    async close() {
      feed.stop();
      for (const ws of clients) ws.close();
      wss.close();
      await new Promise((r) => server.close(r));
    },
  };
}
