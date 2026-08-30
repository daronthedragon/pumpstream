#!/usr/bin/env node
import { startServer } from './server.js';
import { fetchLiveCoins } from './adapter.js';
import { loadConfig, describeConfig, SCHEMA, CONFIG_FILES, ConfigError } from './config.js';

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);

function usage() {
  const flags = Object.entries(SCHEMA)
    .filter(([, s]) => s.flag)
    .map(([, s]) => {
      const arg = s.type === 'bool' ? '' : s.type === 'number' ? ' <n>' : ' <s>';
      return `  --${(s.flag + arg).padEnd(20)}${s.help}${
        s.default !== '' && s.default !== false && !Array.isArray(s.default)
          ? `  (${s.default})`
          : ''
      }`;
    })
    .join('\n');

  return `
pumpstream — live pump.fun comments, gated to token holders

  pumpstream <mint> [<mint> ...] [options]
  pumpstream --discover                 list live tokens and their mints
  pumpstream --print-config             show the resolved config and where each value came from

Options
${flags}
  --config <path>       config file to read
  --print-config        resolve everything, print it, exit
  --help                this

Every option can also come from a config file (${CONFIG_FILES[0]}) or the
environment (PUMPSTREAM_RPC, PUMPSTREAM_TOP_HOLDERS, …). Flags beat env,
env beats the file, the file beats defaults. Booleans accept --no-<flag>.

Commands
  Holders typing !something emit a 'command' event, for driving a game
  or a scene. Replayed history never re-fires them.

Consume it
  ws://localhost:8787            JSON events
  GET /overlay  /overlay/config  /health  /comments  /holders  /stats
`;
}

if (has('help') || (!argv.length && !has('discover') && !has('print-config'))) {
  console.log(usage());
  process.exit(0);
}

let config, sources, file, unknown;
try {
  ({ config, sources, file, unknown } = await loadConfig({ argv, env: process.env }));
} catch (err) {
  console.error(`\n${err instanceof ConfigError ? err.message : err}\n`);
  process.exit(1);
}

if (unknown.length) {
  // Ignoring a typo silently means the setting just never applies.
  console.error(`\nunknown option${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => '--' + u).join(', ')}`);
  console.error(`run with --help to see what is available\n`);
  process.exit(1);
}

if (has('print-config')) {
  console.log(`\nresolved config${file ? ` (file: ${file})` : ''}:\n`);
  console.log(describeConfig(config, sources));
  console.log('');
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

if (!config.mints.length) {
  console.error('\npumpstream needs at least one mint. Find one with --discover.\n');
  process.exit(1);
}

let app;
try {
  app = await startServer({
    port: config.port,
    host: config.host,
    bufferSize: config.bufferSize,
    mints: config.mints,
    holdersOnly: config.holdersOnly,
    minBalance: config.minBalance,
    topHolders: config.topHolders,
    history: config.history,
    commandPrefix: config.commandPrefix,
    rpcUrl: config.rpcUrl || undefined,
    roster: config.roster,
    rosterTtlMs: config.rosterTtlMs,
    holderTtlMs: config.holderTtlMs,
    minDelta: config.minDelta,
    overlayDefaults: config.overlay,
  });
} catch (err) {
  // A startup failure is a user-facing message, not a stack trace.
  console.error(`\npumpstream could not start: ${err.message}\n`);
  process.exit(1);
}

console.log(`\npumpstream listening on ${app.url}`);
console.log(`  mint         ${app.feed.mints.join(', ')}`);
console.log(`  holders-only ${config.holdersOnly}`);
if (config.topHolders) console.log(`  top holders  ${config.topHolders}`);
if (file) console.log(`  config       ${file}`);
if (Object.keys(config.overlay).length) {
  console.log(`  overlay      ${Object.entries(config.overlay).map(([k, v]) => `${k}=${v}`).join(' ')}`);
}
console.log(`  websocket    ws://${config.host}:${config.port}\n`);

if (!config.quiet) {
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
