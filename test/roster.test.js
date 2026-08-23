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
