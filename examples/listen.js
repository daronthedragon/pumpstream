/**
 * Library usage: consume holder-gated comments directly in Node.
 *
 *   node examples/listen.js <mint>
 */
import { PumpComments } from '../src/index.js';

const mint = process.argv[2];
if (!mint) {
  console.error('usage: node examples/listen.js <mint>   (find one with: npm run discover)');
  process.exit(1);
}

const feed = new PumpComments({
  mint,
  holdersOnly: true, // drop everyone who does not hold the token
  minBalance: 0, // raise this to require a meaningful bag
  history: 10, // replay the last 10 on connect
});

feed.on('comment', (c) => {
  console.log(`[holder ${Math.round(c.balance).toLocaleString()}] ${c.username}: ${c.text}`);
});

feed.on('filtered', (c) => {
  console.log(`  (dropped non-holder ${c.username}: ${c.text.slice(0, 40)})`);
});

// pump.fun has no stable API — always handle this.
feed.on('drift', (d) => console.error('UPSTREAM CHANGED:', d.kind, d.detail));
feed.on('error', (e) => console.error('error:', e.scope, e.message));
feed.on('reconnect', (r) => console.error(`reconnecting (attempt ${r.attempt}) in ${r.delay}ms`));

await feed.start();
console.log(`listening to ${mint}\n`);

process.on('SIGINT', () => {
  console.log('\nholder cache:', JSON.stringify(feed.holderStats(), null, 2));
  feed.stop();
  process.exit(0);
});
