import test from 'node:test';
import assert from 'node:assert/strict';
import { PumpComments } from '../src/index.js';
import { installDemo } from '../src/demo.js';

/**
 * Demo mode exists to remove one precondition: needing a live token with real
 * chat happening right now, just to set up OBS or judge the project.
 *
 * The point of these tests is that it drives the REAL pipeline rather than a
 * parallel fake, and that it never touches the network.
 */

const MINT = 'DEMOxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump';

function demoFeed(opts = {}) {
  const feed = new PumpComments({ mint: MINT, demo: true, ...opts.feed });
  feed.on('error', () => {});
  feed.on('drift', () => {});
  return feed;
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test('demo mode makes no network calls at all', async () => {
  // The strongest thing to assert: not "few requests", none.
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    throw new Error('demo mode must not reach the network');
  };
  try {
    const feed = demoFeed();
    const comments = [];
    feed.on('comment', (c) => comments.push(c));

    await feed.start();
    const demo = installDemo(feed, { rate: 600, holders: 20 });
    await settle(120);
    demo.stop();
    feed.stop();

    assert.deepEqual(calls, [], 'nothing was fetched');
    assert.ok(comments.length >= 6, `expected chat, got ${comments.length}`);
  } finally {
    globalThis.fetch = original;
  }
});

test('start() resolves without opening a socket', async () => {
  const feed = demoFeed();
  await feed.start({ connectTimeoutMs: 50 });
  assert.equal(feed.connected, true, 'reports connected without a socket');
  assert.equal(feed.ws, null, 'and never made one');
  feed.stop();
});

test('comments arrive already gated, with balance rank and share', async () => {
  const feed = demoFeed();
  const seen = [];
  feed.on('comment', (c) => seen.push(c));
  await feed.start();
  const demo = installDemo(feed, { rate: 600, holders: 30 });
  await settle(120);
  demo.stop();
  feed.stop();

  const holders = seen.filter((c) => c.holder);
  assert.ok(holders.length, 'some chatters hold the token');
  const h = holders[0];
  assert.ok(h.balance > 0, 'with a real balance');
  assert.ok(h.rank >= 1, 'ranked by the same code as live data');
  assert.ok(h.share > 0 && h.share <= 1, `share should be a fraction, got ${h.share}`);
  assert.equal(h.mint, MINT);
});

test('some demo chatters hold nothing, so --holders-only visibly does something', async () => {
  const feed = demoFeed();
  const shown = [];
  const dropped = [];
  feed.on('comment', (c) => shown.push(c));
  feed.on('filtered', (c) => dropped.push(c));
  await feed.start();
  const demo = installDemo(feed, { rate: 600, holders: 30 });
  await settle(200);
  demo.stop();
  feed.stop();

  const nonHolders = shown.filter((c) => !c.holder);
  assert.ok(
    nonHolders.length,
    'a demo where everyone holds would make the gate look like it does nothing'
  );
});

test('holdersOnly filters the demo feed too', async () => {
  const feed = demoFeed({ feed: { holdersOnly: true } });
  const shown = [];
  const dropped = [];
  feed.on('comment', (c) => shown.push(c));
  feed.on('filtered', (c) => dropped.push(c));
  await feed.start();
  const demo = installDemo(feed, { rate: 600, holders: 30 });
  await settle(200);
  demo.stop();
  feed.stop();

  assert.ok(dropped.length, 'non-holders were dropped');
  assert.ok(shown.every((c) => c.holder), 'and nothing that got through is a non-holder');
});

test('demo chat produces commands through the real parser', async () => {
  const feed = demoFeed();
  const commands = [];
  feed.on('command', (c) => commands.push(c));
  await feed.start();
  const demo = installDemo(feed, { rate: 600, holders: 20 });
  await settle(400);
  demo.stop();
  feed.stop();

  assert.ok(commands.length, 'expected at least one !command in 400ms of chat');
  assert.ok(
    commands.every((c) => /^[a-z]+$/.test(c.name)),
    `command names should be parsed, got ${JSON.stringify(commands.map((c) => c.name))}`
  );
});

test('balances move, producing buy and sell alerts through the real diff', async () => {
  const feed = demoFeed();
  const alerts = [];
  feed.on('holderChange', (h) => alerts.push(h));
  await feed.start();
  const demo = installDemo(feed, { rate: 600, holders: 25 });

  // The demo's own churn runs on a 12s timer; drive it directly rather than
  // making the test wait for wall-clock time.
  const gate = feed.gates.get(MINT);
  const moved = new Map(
    [...gate.roster].map(([owner, e], i) => [owner, i === 0 ? e.balance * 2 : e.balance])
  );
  gate.applyBalances(moved);
  await settle(30);

  demo.stop();
  feed.stop();

  assert.ok(alerts.length, 'a balance change produced an alert');
  assert.equal(alerts[0].type, 'buy');
  assert.ok(alerts[0].delta > 0);
  assert.equal(alerts[0].mint, MINT);
});

test('the roster is populated and ranked, so /holders and the board work', async () => {
  const feed = demoFeed();
  await feed.start();
  const demo = installDemo(feed, { rate: 60, holders: 40 });

  const gate = feed.gates.get(MINT);
  const top = await gate.top(5);
  assert.equal(top.length, 5);
  assert.deepEqual(top.map((h) => h.rank), [1, 2, 3, 4, 5]);
  // Ranked biggest first, and shares are a fraction of the whole.
  assert.ok(top[0].balance > top[4].balance);
  assert.ok(top[0].share > 0 && top[0].share < 1);
  assert.equal(gate.stats.rosterHolders, 40);
  assert.equal(gate.stats.rosterRefused, false);

  demo.stop();
  feed.stop();
});

test('the same seed replays the same demo', async () => {
  // A reproducible run makes a layout bug reproducible too.
  const run = async () => {
    const feed = demoFeed();
    const texts = [];
    feed.on('comment', (c) => texts.push(`${c.username}:${c.text}`));
    await feed.start();
    const demo = installDemo(feed, { rate: 600, holders: 20, seed: 42 });
    await settle(80);
    demo.stop();
    feed.stop();
    return texts;
  };

  const a = await run();
  const b = await run();
  assert.ok(a.length >= 6);
  assert.deepEqual(a.slice(0, 6), b.slice(0, 6), 'same seed, same opening');
});

test('a different seed gives a different demo', async () => {
  const run = async (seed) => {
    const feed = demoFeed();
    const texts = [];
    feed.on('comment', (c) => texts.push(`${c.username}:${c.text}`));
    await feed.start();
    const demo = installDemo(feed, { rate: 600, holders: 20, seed });
    await settle(80);
    demo.stop();
    feed.stop();
    return texts.slice(0, 6).join('|');
  };
  assert.notEqual(await run(1), await run(999));
});

test('stopping the demo stops the chat', async () => {
  const feed = demoFeed();
  let count = 0;
  feed.on('comment', () => count++);
  await feed.start();
  const demo = installDemo(feed, { rate: 600, holders: 20 });
  await settle(120);
  const atStop = count;
  demo.stop();
  await settle(150);
  assert.equal(count, atStop, 'no comments after stop()');
  feed.stop();
});

test('each demo wallet has its own name', async () => {
  // Regression: 22 speakers wrapped around 20 names, so a whale and a
  // non-holder shared a username and the name lookup looked broken.
  const feed = demoFeed();
  const byName = new Map();
  feed.on('comment', (c) => {
    const seen = byName.get(c.username);
    assert.ok(
      !seen || seen === c.author,
      `"${c.username}" was used by two different wallets`
    );
    byName.set(c.username, c.author);
  });
  await feed.start();
  const demo = installDemo(feed, { rate: 600, holders: 40 });
  await settle(400);
  demo.stop();
  feed.stop();
  assert.ok(byName.size >= 5, `expected several speakers, saw ${byName.size}`);

  // Distinct is not enough: 'poshcrab723292' beside 'poshcrab72329' still
  // reads as one person, which was the whole point of the fix.
  const names = [...byName.keys()];
  for (const a of names) {
    for (const b of names) {
      if (a === b) continue;
      assert.ok(
        !b.startsWith(a),
        `"${b}" is "${a}" with something appended — they read as the same wallet`
      );
    }
  }
});

test('the synthetic distribution resembles a real token', async () => {
  // The demo is used to tune a layout, so it has to produce numbers the
  // layout will really face. Measured on live tokens: top wallet 23-33%.
  const feed = demoFeed();
  await feed.start();
  const demo = installDemo(feed, { holders: 60, rate: 1 });
  const top = await feed.gates.get(MINT).top(1);
  demo.stop();
  feed.stop();

  assert.ok(
    top[0].share > 0.15 && top[0].share < 0.45,
    `top holder should look plausible, got ${(top[0].share * 100).toFixed(1)}%`
  );
});
