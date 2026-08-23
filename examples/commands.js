/**
 * Drive something from chat — the "integrate it into my game" case.
 *
 *   node examples/commands.js <mint>
 *
 * Holders type `!vote blue`, `!spawn boss`, `!skip`. Non-holders are ignored
 * before your handler ever sees them, so the gate is stake, not moderation.
 */
import { PumpComments } from '../src/index.js';

const mint = process.argv[2];
if (!mint) {
  console.error('usage: node examples/commands.js <mint>   (find one with: npm run discover)');
  process.exit(1);
}

const feed = new PumpComments({
  mint,
  holdersOnly: true, // commands inherit this gate
  // rpcUrl: 'https://your-paid-endpoint',  ← do this for real traffic
});

/** Simple weighted vote: a bigger bag counts for more. */
const votes = new Map();

const handlers = {
  vote(cmd) {
    const choice = cmd.args[0]?.toLowerCase();
    if (!choice) return;
    votes.set(choice, (votes.get(choice) ?? 0) + Math.sqrt(cmd.balance || 1));
    const board = [...votes]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${Math.round(v)}`)
      .join('  ');
    console.log(`  vote: ${cmd.username} -> ${choice}   [${board}]`);
  },

  spawn(cmd) {
    // Where you would poke your game: a websocket, a file, an HTTP call…
    console.log(`  spawn: ${cmd.args[0] ?? 'something'} (asked by ${cmd.username})`);
  },

  skip(cmd) {
    console.log(`  skip requested by ${cmd.username} holding ${Math.round(cmd.balance)}`);
  },
};

feed.on('command', (cmd) => {
  const handler = handlers[cmd.name];
  if (!handler) return console.log(`  (unknown command !${cmd.name})`);
  handler(cmd);
});

// Commands never fire for replayed history, so a restart will not re-run
// everything in the buffer.
feed.on('drift', (d) => console.error('upstream changed:', d.kind, d.detail));
feed.on('degraded', (d) => console.error('DEGRADED:', d.detail));

await feed.start();
console.log(`listening for !commands from holders of ${mint}\n`);

process.on('SIGINT', () => {
  feed.stop();
  process.exit(0);
});
