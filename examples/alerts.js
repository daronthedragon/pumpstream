/**
 * Buy and sell alerts, for no extra RPC calls.
 *
 *   node examples/alerts.js <mint>
 *
 * The holder gate already pulls every balance to answer "is this commenter a
 * holder". Diffing two of those snapshots shows whose bag grew or shrank.
 *
 * IMPORTANT: this is inferred from balances, not read from transactions.
 * A wallet that bought and sold the same amount between refreshes shows up as
 * nothing, and one alert can be several trades. It is "their bag changed",
 * not "they placed a trade".
 */
import { PumpComments } from '../src/index.js';

const mint = process.argv[2];
if (!mint) {
  console.error('usage: node examples/alerts.js <mint>   (find one with: npm run discover)');
  process.exit(1);
}

const feed = new PumpComments({
  mint,
  rosterTtlMs: 30_000, // how often the snapshot is taken
  minDelta: 1000,      // ignore dust movement
});

const fmt = (n) => {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
};

feed.on('holderChange', (c) => {
  const who = c.owner.slice(0, 6);
  const rank = c.rank ? ` #${c.rank}` : '';

  if (c.first) {
    console.log(`  NEW HOLDER  ${who}${rank} bought ${fmt(c.delta)}`);
  } else if (c.exit) {
    console.log(`  EXIT        ${who} sold their whole ${fmt(c.before)} bag`);
  } else if (c.type === 'buy') {
    console.log(`  BUY         ${who}${rank} +${fmt(c.delta)} -> ${fmt(c.after)}`);
  } else {
    console.log(`  SELL        ${who}${rank} ${fmt(c.delta)} -> ${fmt(c.after)}`);
  }
});

// Comments still flow as normal; the alerts are a bonus on the same data.
feed.on('comment', (c) => console.log(`  ${c.username}: ${c.text}`));

feed.on('error', (e) => {
  // A refused roster means no alerts — the per-wallet fallback cannot diff.
  if (e.scope === 'roster') console.error('no roster, so no alerts:', e.message);
});

await feed.start();
console.log(`watching ${mint}\n`);

process.on('SIGINT', () => {
  feed.stop();
  process.exit(0);
});
