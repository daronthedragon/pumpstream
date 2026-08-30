import test from 'node:test';
import assert from 'node:assert/strict';
import { HolderGate } from '../src/holders.js';

/**
 * The roster strategy: one getProgramAccounts call returns every token account
 * for the mint, and holder checks become a map lookup. Measured on a live
 * pump.fun token — 4,838 accounts in 271ms, then 500 lookups in 0ms.
 */

const MINT = 'DDVUsN8sDFxbaX6gNBoD44kjZhFETWJnwAn4EX1dpump';
const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** Build the base64 blob the RPC returns for a dataSlice(32, 40). */
function account(ownerBytes, rawAmount) {
  const buf = Buffer.alloc(40);
  Buffer.from(ownerBytes).copy(buf, 0);
  buf.writeBigUInt64LE(BigInt(rawAmount), 32);
  return { account: { data: [buf.toString('base64'), 'base64'] } };
}

/** A deterministic 32-byte pubkey, plus the base58 the gate should produce. */
function pubkey(seed) {
  const bytes = Buffer.alloc(32, seed);
  return bytes;
}

// Mirror of the gate's encoder, so the test states the expected address.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}

function stubRoster({ decimals = 6, accounts = [], programError = null, mintMissing = false }) {
  const calls = { getAccountInfo: 0, getProgramAccounts: 0, getTokenAccountsByOwner: 0 };
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const one = Array.isArray(body) ? body[0] : body;
    calls[one.method] = (calls[one.method] ?? 0) + 1;

    if (one.method === 'getAccountInfo') {
      if (mintMissing) return { ok: true, json: async () => ({ result: { value: null } }) };
      return {
        ok: true,
        json: async () => ({
          result: { value: { owner: T22, data: { parsed: { info: { decimals } } } } },
        }),
      };
    }
    if (one.method === 'getProgramAccounts') {
      if (programError) return { ok: false, status: programError };
      return { ok: true, json: async () => ({ result: accounts }) };
    }
    // Per-wallet fallback.
    return {
      ok: true,
      json: async () => ({ id: 1, result: { value: [] } }),
    };
  };
  return calls;
}

test('one roster call answers every lookup, with no further requests', async () => {
  const original = globalThis.fetch;
  const whale = pubkey(1);
  const small = pubkey(2);
  const calls = stubRoster({
    decimals: 6,
    accounts: [account(whale, 5_000_000_000n), account(small, 1_500_000n)],
  });

  try {
    const g = new HolderGate({ mint: MINT });
    g.onRosterError = (e) => assert.fail(`roster should not error: ${e.message}`);

    const a = await g.check(base58(whale));
    assert.equal(a.holder, true);
    assert.equal(a.balance, 5000, '5e9 raw at 6 decimals');

    const b = await g.check(base58(small));
    assert.equal(b.balance, 1.5);

    // A wallet absent from the roster genuinely holds nothing — this is a
    // definitive zero, not the "unknown" a failed lookup produces.
    const c = await g.check(base58(pubkey(9)));
    assert.equal(c.holder, false);
    assert.equal(c.unknown, undefined);

    assert.equal(calls.getProgramAccounts, 1, 'one roster fetch total');
    assert.equal(calls.getTokenAccountsByOwner ?? 0, 0, 'no per-wallet calls at all');
    assert.equal(g.stats.rosterHolders, 2);
    assert.equal(g.stats.rosterHits, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test('a wallet holding several token accounts is summed', async () => {
  const original = globalThis.fetch;
  const w = pubkey(3);
  stubRoster({ decimals: 6, accounts: [account(w, 1_000_000n), account(w, 2_500_000n)] });
  try {
    const g = new HolderGate({ mint: MINT });
    assert.equal((await g.check(base58(w))).balance, 3.5);
  } finally {
    globalThis.fetch = original;
  }
});

test('zero-balance accounts are left out of the roster', async () => {
  const original = globalThis.fetch;
  stubRoster({ accounts: [account(pubkey(4), 0n), account(pubkey(5), 100n)] });
  try {
    const g = new HolderGate({ mint: MINT });
    await g.check(base58(pubkey(5)));
    assert.equal(g.stats.rosterHolders, 1, 'empty accounts are not holders');
  } finally {
    globalThis.fetch = original;
  }
});

test('an endpoint that refuses getProgramAccounts falls back to per-wallet', async () => {
  // Plenty of endpoints disable it because it is expensive to serve. That is
  // not a failure, just a different strategy.
  const original = globalThis.fetch;
  const calls = stubRoster({ programError: 410, accounts: [] });
  try {
    const g = new HolderGate({ mint: MINT, roster: true });
    const errs = [];
    g.onRosterError = (e) => errs.push(e.message);
    g.onError = () => {};

    const r = await g.check(base58(pubkey(6)));
    assert.equal(r.holder, false);
    assert.equal(calls.getTokenAccountsByOwner, 1, 'it fell back to per-wallet');
    assert.equal(g.stats.rosterRefused, true);
    assert.equal(errs.length, 1, 'the refusal is surfaced, not swallowed');

    // And it does not keep retrying the doomed call.
    await g.check(base58(pubkey(7)));
    assert.equal(calls.getProgramAccounts, 1, 'no second doomed roster fetch');
  } finally {
    globalThis.fetch = original;
  }
});

test('a missing mint is reported rather than treated as zero holders', async () => {
  const original = globalThis.fetch;
  stubRoster({ mintMissing: true });
  try {
    const g = new HolderGate({ mint: MINT });
    const errs = [];
    g.onRosterError = (e) => errs.push(e.message);
    g.onError = () => {};
    await g.check(base58(pubkey(8)));
    assert.match(errs[0] ?? '', /not found/);
  } finally {
    globalThis.fetch = original;
  }
});

test('a stale roster is served immediately while it refreshes', async () => {
  const original = globalThis.fetch;
  const w = pubkey(10);
  const calls = stubRoster({ accounts: [account(w, 7_000_000n)] });
  try {
    const g = new HolderGate({ mint: MINT, rosterTtlMs: 1 });
    assert.equal((await g.check(base58(w))).balance, 7);
    assert.equal(calls.getProgramAccounts, 1);

    await new Promise((r) => setTimeout(r, 10)); // now stale

    const t0 = Date.now();
    const again = await g.check(base58(w));
    const ms = Date.now() - t0;
    assert.equal(again.balance, 7, 'answered from the stale copy');
    assert.ok(ms < 20, `should not block on the refresh, took ${ms}ms`);

    await new Promise((r) => setTimeout(r, 30));
    assert.ok(calls.getProgramAccounts >= 2, 'and refreshed in the background');
  } finally {
    globalThis.fetch = original;
  }
});

test('roster:false keeps the old per-wallet behaviour', async () => {
  const original = globalThis.fetch;
  const calls = stubRoster({ accounts: [account(pubkey(11), 1n)] });
  try {
    const g = new HolderGate({ mint: MINT, roster: false });
    g.onError = () => {};
    await g.check(base58(pubkey(11)));
    assert.equal(calls.getProgramAccounts ?? 0, 0, 'no roster fetch when disabled');
    assert.equal(calls.getTokenAccountsByOwner, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('concurrent first lookups share a single roster fetch', async () => {
  const original = globalThis.fetch;
  const w = pubkey(12);
  const calls = stubRoster({ accounts: [account(w, 1_000_000n)] });
  try {
    const g = new HolderGate({ mint: MINT });
    const out = await Promise.all(
      Array.from({ length: 25 }, () => g.check(base58(w)))
    );
    assert.ok(out.every((r) => r.balance === 1));
    assert.equal(calls.getProgramAccounts, 1, '25 lookups, one fetch');
  } finally {
    globalThis.fetch = original;
  }
});

/* ── rank and share ───────────────────────────────────────────────────────
 * Free once the roster exists: one sort per refresh instead of a query per
 * commenter.
 */

test('rank is 1-based by size, and share sums to the whole', async () => {
  const original = globalThis.fetch;
  const big = pubkey(20), mid = pubkey(21), small = pubkey(22);
  stubRoster({
    decimals: 0,
    accounts: [account(small, 10n), account(big, 70n), account(mid, 20n)],
  });
  try {
    const g = new HolderGate({ mint: MINT });
    const a = await g.check(base58(big));
    const b = await g.check(base58(mid));
    const c = await g.check(base58(small));

    assert.deepEqual([a.rank, b.rank, c.rank], [1, 2, 3], 'biggest bag is #1');
    assert.equal(a.share, 0.7);
    assert.equal(b.share, 0.2);
    assert.equal(c.share, 0.1);
    // Float sums are float sums: 0.7 + 0.2 + 0.1 is 0.9999999999999999.
    assert.ok(Math.abs(a.share + b.share + c.share - 1) < 1e-9);
    assert.equal(g.rosterTotal, 100);
  } finally {
    globalThis.fetch = original;
  }
});

test('a non-holder has no rank rather than a misleading one', async () => {
  const original = globalThis.fetch;
  stubRoster({ decimals: 0, accounts: [account(pubkey(23), 5n)] });
  try {
    const g = new HolderGate({ mint: MINT });
    const r = await g.check(base58(pubkey(99)));
    assert.equal(r.rank, null, 'null, not 0 and not last place');
    assert.equal(r.share, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('topHolders gates the feed to the largest bags', async () => {
  const { PumpComments } = await import('../src/index.js');
  const original = globalThis.fetch;
  const big = pubkey(30), small = pubkey(31);
  stubRoster({ decimals: 0, accounts: [account(big, 100n), account(small, 1n)] });
  try {
    const feed = new PumpComments({ mint: MINT, topHolders: 1 });
    feed.on('error', () => {});
    const shown = [];
    feed.on('comment', (c) => shown.push(c.text));

    const msg = (text, owner) => ({
      id: text, roomId: MINT, username: 'u', userAddress: base58(owner),
      message: text, timestamp: '2026-08-08T18:23:01.144Z', messageType: 'REGULAR',
    });
    await feed.ingest(msg('from #1', big));
    await feed.ingest(msg('from #2', small));

    assert.deepEqual(shown, ['from #1'], 'only the top holder got through');
    feed.stop();
  } finally {
    globalThis.fetch = original;
  }
});

/* ── balance changes between snapshots ────────────────────────────────────
 * Two roster snapshots are enough to see whose bag grew or shrank, for no
 * extra requests. It is inferred, not a transaction feed.
 */

/** A stub whose roster contents can be swapped between refreshes. */
function mutableRoster(initial) {
  let current = initial;
  const calls = { getProgramAccounts: 0 };
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const one = Array.isArray(body) ? body[0] : body;
    if (one.method === 'getAccountInfo') {
      return { ok: true, json: async () => ({
        result: { value: { owner: T22, data: { parsed: { info: { decimals: 0 } } } } } }) };
    }
    if (one.method === 'getProgramAccounts') {
      calls.getProgramAccounts++;
      return { ok: true, json: async () => ({ result: current }) };
    }
    return { ok: true, json: async () => ({ id: 1, result: { value: [] } }) };
  };
  return { calls, set: (next) => { current = next; } };
}

async function refresh(gate, wallet) {
  await new Promise((r) => setTimeout(r, 5)); // let the TTL lapse
  await gate.check(base58(wallet));
  await new Promise((r) => setTimeout(r, 25)); // background refresh lands
}

test('the first snapshot emits nothing — there is no baseline to compare', async () => {
  const original = globalThis.fetch;
  mutableRoster([account(pubkey(40), 100n), account(pubkey(41), 50n)]);
  try {
    const g = new HolderGate({ mint: MINT });
    const seen = [];
    g.onHolderChanges = (c) => seen.push(...c);
    await g.check(base58(pubkey(40)));
    assert.equal(seen.length, 0, 'startup must not report 2,000 fake buys');
  } finally {
    globalThis.fetch = original;
  }
});

test('a bigger bag reads as a buy, a smaller one as a sell', async () => {
  const original = globalThis.fetch;
  const buyer = pubkey(42), seller = pubkey(43);
  const roster = mutableRoster([account(buyer, 100n), account(seller, 100n)]);
  try {
    const g = new HolderGate({ mint: MINT, rosterTtlMs: 1 });
    const seen = [];
    g.onHolderChanges = (c) => seen.push(...c);
    await g.check(base58(buyer));

    roster.set([account(buyer, 250n), account(seller, 40n)]);
    await refresh(g, buyer);

    const byOwner = Object.fromEntries(seen.map((c) => [c.owner, c]));
    assert.equal(byOwner[base58(buyer)].type, 'buy');
    assert.equal(byOwner[base58(buyer)].delta, 150);
    assert.equal(byOwner[base58(seller)].type, 'sell');
    assert.equal(byOwner[base58(seller)].delta, -60);
  } finally {
    globalThis.fetch = original;
  }
});

test('a wallet that appears is flagged first, one that vanishes is an exit', async () => {
  const original = globalThis.fetch;
  const staying = pubkey(44), arriving = pubkey(45), leaving = pubkey(46);
  const roster = mutableRoster([account(staying, 100n), account(leaving, 80n)]);
  try {
    const g = new HolderGate({ mint: MINT, rosterTtlMs: 1 });
    const seen = [];
    g.onHolderChanges = (c) => seen.push(...c);
    await g.check(base58(staying));

    roster.set([account(staying, 100n), account(arriving, 30n)]);
    await refresh(g, staying);

    const arrived = seen.find((c) => c.owner === base58(arriving));
    assert.equal(arrived.type, 'buy');
    assert.equal(arrived.first, true, 'brand new holder');
    assert.equal(arrived.before, 0);

    const left = seen.find((c) => c.owner === base58(leaving));
    assert.equal(left.type, 'sell');
    assert.equal(left.exit, true, 'sold the lot');
    assert.equal(left.after, 0);

    assert.ok(!seen.some((c) => c.owner === base58(staying)), 'unchanged bags are silent');
  } finally {
    globalThis.fetch = original;
  }
});

test('changes arrive biggest first', async () => {
  const original = globalThis.fetch;
  const a = pubkey(47), b = pubkey(48), c = pubkey(49);
  const roster = mutableRoster([account(a, 100n), account(b, 100n), account(c, 100n)]);
  try {
    const g = new HolderGate({ mint: MINT, rosterTtlMs: 1 });
    let seen = [];
    g.onHolderChanges = (ch) => { seen = ch; };
    await g.check(base58(a));

    roster.set([account(a, 105n), account(b, 900n), account(c, 50n)]);
    await refresh(g, a);

    const deltas = seen.map((x) => Math.abs(x.delta));
    assert.deepEqual(deltas, [...deltas].sort((x, y) => y - x), 'sorted by size');
    assert.equal(seen[0].owner, base58(b), 'the 800 move leads');
  } finally {
    globalThis.fetch = original;
  }
});

test('minDelta filters out dust movement', async () => {
  const original = globalThis.fetch;
  const dust = pubkey(50), real = pubkey(51);
  const roster = mutableRoster([account(dust, 100n), account(real, 100n)]);
  try {
    const g = new HolderGate({ mint: MINT, rosterTtlMs: 1, minDelta: 10 });
    const seen = [];
    g.onHolderChanges = (c) => seen.push(...c);
    await g.check(base58(dust));

    roster.set([account(dust, 103n), account(real, 400n)]);
    await refresh(g, dust);

    assert.deepEqual(seen.map((c) => c.owner), [base58(real)], 'the 3-token move is ignored');
  } finally {
    globalThis.fetch = original;
  }
});

test('the feed re-emits changes as holderChange events with the mint', async () => {
  const { PumpComments } = await import('../src/index.js');
  const original = globalThis.fetch;
  const w = pubkey(52);
  const roster = mutableRoster([account(w, 100n)]);
  try {
    const feed = new PumpComments({ mint: MINT, rosterTtlMs: 1 });
    feed.on('error', () => {});
    const seen = [];
    feed.on('holderChange', (h) => seen.push(h));

    const gate = feed.gates.get(MINT);
    await gate.check(base58(w));
    roster.set([account(w, 500n)]);
    await refresh(gate, w);

    assert.equal(seen.length, 1);
    assert.equal(seen[0].mint, MINT, 'tagged so multi-mint consumers can route it');
    assert.equal(seen[0].type, 'buy');
    assert.equal(feed.stats.holderChanges, 1);
    feed.stop();
  } finally {
    globalThis.fetch = original;
  }
});

/* ── keeping the roster warm ──────────────────────────────────────────────
 * The roster used to refresh only when a comment arrived, so balance-change
 * alerts went silent in a quiet room — exactly when a big buy matters most.
 */

test('without watching, a silent room produces no refreshes', async () => {
  const original = globalThis.fetch;
  const calls = stubRoster({ accounts: [account(pubkey(60), 1n)] });
  try {
    const g = new HolderGate({ mint: MINT, rosterTtlMs: 20 });
    await g.check(base58(pubkey(60)));
    assert.equal(calls.getProgramAccounts, 1);
    await new Promise((r) => setTimeout(r, 120)); // several TTLs of silence
    assert.equal(calls.getProgramAccounts, 1, 'nothing drives a refresh on its own');
  } finally {
    globalThis.fetch = original;
  }
});

test('watch() keeps refreshing with no chat at all', async () => {
  const original = globalThis.fetch;
  const calls = stubRoster({ accounts: [account(pubkey(61), 1n)] });
  try {
    const g = new HolderGate({ mint: MINT, rosterTtlMs: 25 });
    g.onRosterError = () => {};
    g.watch();
    await new Promise((r) => setTimeout(r, 140));
    g.unwatch();
    assert.ok(calls.getProgramAccounts >= 3, `expected repeated refreshes, got ${calls.getProgramAccounts}`);

    const settled = calls.getProgramAccounts;
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(calls.getProgramAccounts, settled, 'unwatch() actually stops it');
  } finally {
    globalThis.fetch = original;
  }
});

test('watching stops by itself if the endpoint refuses the roster', async () => {
  const original = globalThis.fetch;
  const calls = stubRoster({ programError: 410 });
  try {
    const g = new HolderGate({ mint: MINT, rosterTtlMs: 15 });
    g.onRosterError = () => {};
    g.onError = () => {};
    await g.check(base58(pubkey(62)));           // marks it refused
    g.watch();
    const after = calls.getProgramAccounts;
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(calls.getProgramAccounts, after, 'no point polling a refused call');
    assert.equal(g.watchTimer, null, 'and it cleaned up its own timer');
  } finally {
    globalThis.fetch = original;
  }
});

test('the feed only polls while something listens for holderChange', async () => {
  const { PumpComments } = await import('../src/index.js');
  const original = globalThis.fetch;
  const calls = stubRoster({ accounts: [account(pubkey(63), 1n)] });
  try {
    const feed = new PumpComments({ mint: MINT, rosterTtlMs: 25 });
    feed.on('error', () => {});
    const gate = feed.gates.get(MINT);
    assert.equal(gate.watchTimer, null, 'idle until someone cares');

    const handler = () => {};
    feed.on('holderChange', handler);
    assert.ok(gate.watchTimer, 'a listener starts the polling');

    feed.off('holderChange', handler);
    assert.equal(gate.watchTimer, null, 'the last listener leaving stops it');

    feed.on('holderChange', handler);
    feed.stop();
    assert.equal(gate.watchTimer, null, 'stop() always stops it');
    void calls;
  } finally {
    globalThis.fetch = original;
  }
});
