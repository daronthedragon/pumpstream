#!/usr/bin/env node
import { startServer } from './server.js';
import { fetchLiveCoins } from './adapter.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

// Flags that consume the next argument — needed so `--port 8787` does not
// leave 8787 looking like a mint.
const TAKES_VALUE = new Set(['port', 'min-balance', 'rpc', 'history', 'prefix', 'top']);

function positionals() {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (TAKES_VALUE.has(a.slice(2))) i++;
      continue;
    }
    out.push(...a.split(',').map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

if (has('help') || (!argv.length && !has('discover'))) {
  console.log(`
pumpstream — live pump.fun comments, gated to token holders

  pumpstream <mint> [<mint> ...] [options]
  pumpstream --discover                 list live tokens and their mints

Options
  --port <n>          local server port            (default 8787)
  --holders-only      drop comments from non-holders
  --min-balance <n>   tokens required to count as a holder   (default 0)
  --top <n>           only the n largest holders may appear
  --rpc <url>         Solana RPC (use a paid one for real traffic)
  --history <n>       replay the last n comments on connect  (default 0)
  --prefix <s>        command prefix, '' to disable          (default !)
  --quiet             do not print comments to stdout

Commands
  Holders typing !something emit a 'command' event, for driving a game
  or a scene. Replayed history never re-fires them.

Consume it
  ws://localhost:8787            JSON events
  GET /overlay  /overlay/config  /health  /comments  /stats
`);
  process.exit(0);
}

if (has('discover')) {
  const coins = await fetchLiveCoins(15);
  console.log('\nLive on pump.fun right now:\n');
  for (const c of coins) {
    console.log(
      `  ${c.mint}  ${String(c.symbol).padEnd(12)} replies:${String(c.replyCount).padEnd(6)} mcap:$${c.marketCap.toLocaleString()}`
    );
  }
  console.log('');
  process.exit(0);
}

const port = Number(flag('port', 8787));
const holdersOnly = has('holders-only');
const mints = positionals();

if (!mints.length) {
  console.error('\npumpstream needs at least one mint. Find one with --discover.\n');
  process.exit(1);
}

let app;
try {
  app = await startServer({
    port,
    mints,
    holdersOnly,
    minBalance: Number(flag('min-balance', 0)),
    rpcUrl: flag('rpc', undefined),
    history: Number(flag('history', 0)),
    commandPrefix: flag('prefix', '!'),
    topHolders: Number(flag('top', 0)),
  });
} catch (err) {
  // A startup failure is a user-facing message, not a stack trace.
  console.error(`\npumpstream could not start: ${err.message}\n`);
  process.exit(1);
}

console.log(`\npumpstream listening on ${app.url}`);
console.log(`  mint         ${app.feed.mints.join(', ')}`);
console.log(`  holders-only ${holdersOnly}`);
console.log(`  websocket    ws://127.0.0.1:${port}\n`);

if (!has('quiet')) {
  app.feed.on('comment', (c) => {
    const who = c.username || c.author.slice(0, 6);
    const bal = c.balance ? ` [${Math.round(c.balance).toLocaleString()}]` : '';
    console.log(`${c.holder ? '✓' : ' '} ${who}${bal}: ${c.text}`);
  });
}

app.feed.on('drift', (d) => console.error('[drift]', d.kind, '-', d.detail));
app.feed.on('degraded', (d) => console.error(`\n[DEGRADED] ${d.detail}\n`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('\nshutting down…');
    await app.close();
    process.exit(0);
  });
}
