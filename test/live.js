/**
 * Opt-in live check against real pump.fun traffic. Not part of `npm test` —
 * it depends on a room actually being busy, so it must never gate CI.
 *
 *   npm run test:live                 picks the liveliest room automatically
 *   npm run test:live -- <mint>       check a specific token
 *
 * Verifies the whole path: pump.fun socket -> normalize -> holder gate ->
 * local server -> WebSocket subscriber.
 */
import WS from 'ws';
import { startServer } from '../src/server.js';
import { fetchLiveCoins } from '../src/adapter.js';
import { PumpComments } from '../src/index.js';

const PORT = 8899;
const WINDOW_MS = 25_000;

let mint = process.argv[2];
if (!mint) {
  // "Currently live" includes brand-new tokens nobody has spoken in yet, so
  // pick by most recent actual chat instead of by listing order — otherwise
  // the check fails on a silent room and tells you nothing.
  const coins = await fetchLiveCoins(12);
  if (!coins.length) {
    console.error('no live tokens returned by pump.fun — cannot run live check');
    process.exit(1);
  }

  const probed = [];
  for (const c of coins.slice(0, 6)) {
    const probe = new PumpComments({ mint: c.mint, history: 5 });
    probe.on('error', () => {});
    probe.on('drift', () => {});
    let newest = 0;
    probe.on('comment', (m) => (newest = Math.max(newest, Date.parse(m.timestamp) || 0)));
    try {
      await probe.start({ connectTimeoutMs: 15_000 });
      await new Promise((r) => setTimeout(r, 3500));
    } catch {}
    probe.stop();
    if (newest) probed.push({ ...c, newest });
    await new Promise((r) => setTimeout(r, 400)); // upstream throttles bursts
  }

  if (!probed.length) {
    console.error('no live room had any chat history — nothing to check against');
    process.exit(1);
  }
  probed.sort((a, b) => b.newest - a.newest);
  mint = probed[0].mint;
  const ageMin = ((Date.now() - probed[0].newest) / 60000).toFixed(1);
  console.log(`picked liveliest room: ${probed[0].symbol} (${mint}), last message ${ageMin}m ago`);
}

const app = await startServer({ port: PORT, mint, holdersOnly: true, history: 25 });
const { feed } = app;

const drift = [];
const degraded = [];
const delivered = [];
let filtered = 0;

feed.on('drift', (d) => drift.push(d.kind));
feed.on('degraded', (d) => degraded.push(d.detail));
feed.on('filtered', () => filtered++);

const sub = new WS(`ws://127.0.0.1:${PORT}?mint=${mint}`);
sub.on('message', (buf) => {
  const { type, data } = JSON.parse(buf.toString());
  if (type === 'comment') delivered.push(data);
});

console.log(`listening to ${mint} for ${WINDOW_MS / 1000}s…\n`);
await new Promise((r) => setTimeout(r, WINDOW_MS));

const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
const stats = await (await fetch(`http://127.0.0.1:${PORT}/stats`)).json();

for (const c of delivered.slice(0, 5)) {
  console.log(`  ✓ ${c.username} [${Math.round(c.balance).toLocaleString()}] ${c.text.slice(0, 50)}`);
}

console.log(`
delivered to subscriber : ${delivered.length}
filtered (non-holders)  : ${filtered}
upstream connected      : ${health.upstreamConnected}
subscribers             : ${health.subscribers}
drift                   : ${drift.length ? drift.join(', ') : 'none'}
degraded                : ${degraded.length ? degraded.join(' | ') : 'none'}
holder cache            : ${JSON.stringify(stats.holders[mint])}`);

await app.close();

// Fail only on things that are genuinely our bug. A quiet room is not a bug;
// upstream changing shape, or nothing arriving at all, is.
const problems = [];
if (!health.upstreamConnected) problems.push('never connected to pump.fun');
if (health.subscribers !== 1) problems.push('local subscriber did not register');
if (drift.length) problems.push(`upstream drift: ${drift.join(', ')}`);
if (delivered.length + filtered === 0) {
  problems.push('no comments seen at all — room was silent, or the feed is broken');
}

if (problems.length) {
  console.error('\nFAIL:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('\nPASS');
process.exit(0);
