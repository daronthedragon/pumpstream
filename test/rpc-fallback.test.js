import test from 'node:test';
import assert from 'node:assert/strict';
import { HolderGate } from '../src/holders.js';

/**
 * Measured against api.mainnet-beta.solana.com: a single getTokenAccountsByOwner
 * returns 200, while the same lookups sent as one JSON-RPC batch return 429.
 * Batching — the thing meant to be efficient — was what broke the holder gate
 * on the default endpoint. The gate now detects that and falls back.
 */

function stub({ batchStatus = 200, batchAllError = false, singleStatus = 200, balances = {} }) {
  const calls = { batch: 0, single: 0 };
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const isBatch = Array.isArray(body);
    if (isBatch) {
      calls.batch++;
      if (batchStatus !== 200) return { ok: false, status: batchStatus };
      return {
        ok: true,
        json: async () =>
          body.map((r) =>
            batchAllError
              ? { id: r.id, error: { code: 429, message: 'Too many requests' } }
              : { id: r.id, result: { value: accountsFor(balances[r.params[0]]) } }
          ),
      };
    }
    calls.single++;
    if (singleStatus !== 200) return { ok: false, status: singleStatus };
    return {
      ok: true,
      json: async () => ({ id: 1, result: { value: accountsFor(balances[body.params[0]]) } }),
    };
  };
  return calls;
}

const accountsFor = (bal) =>
  bal === undefined
    ? []
    : [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: bal } } } } } }];

function gate(opts = {}) {
  const g = new HolderGate({ mint: 'mint1', spacingMs: 0, ...opts });
  g.onError = () => {};
  return g;
}

test('a batch the endpoint refuses falls back to single requests', async () => {
  const original = globalThis.fetch;
  const calls = stub({ batchStatus: 429, balances: { W1: 500, W2: 0 } });
  try {
    const g = gate();
    const [a, b] = await Promise.all([g.check('W1'), g.check('W2')]);

    assert.equal(a.holder, true, 'W1 holds 500');
    assert.equal(a.balance, 500);
    assert.equal(b.holder, false, 'W2 holds nothing');
    assert.equal(b.unknown, undefined, 'a real zero, not a failure');

    assert.equal(calls.batch, 1, 'the batch was tried once');
    assert.equal(calls.single, 2, 'then each wallet individually');
    assert.equal(g.stats.batchDisabled, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('a 200 batch where every item errored also counts as refusal', async () => {
  // Public endpoints signal rate limiting this way rather than with a status.
  const original = globalThis.fetch;
  const calls = stub({ batchAllError: true, balances: { W1: 42, W2: 7 } });
  try {
    const g = gate();
    // Two wallets, so the batch path is actually taken.
    const [a, b] = await Promise.all([g.check('W1'), g.check('W2')]);
    assert.equal(a.balance, 42, 'the single retry got the real answer');
    assert.equal(b.balance, 7);
    assert.equal(calls.batch, 1);
    assert.equal(calls.single, 2);
    assert.equal(g.stats.batchDisabled, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('once batching is off it is not retried, so nothing is wasted', async () => {
  const original = globalThis.fetch;
  const calls = stub({ batchStatus: 429, balances: { A: 1, B: 2, C: 3, D: 4 } });
  try {
    const g = gate();
    await Promise.all([g.check('A'), g.check('B')]);
    assert.equal(calls.batch, 1);

    await Promise.all([g.check('C'), g.check('D')]);
    assert.equal(calls.batch, 1, 'no second doomed batch attempt');
    assert.equal(calls.single, 4);
  } finally {
    globalThis.fetch = original;
  }
});

test('an endpoint that does support batching never falls back', async () => {
  const original = globalThis.fetch;
  const calls = stub({ balances: { A: 10, B: 20, C: 30 } });
  try {
    const g = gate();
    const out = await Promise.all([g.check('A'), g.check('B'), g.check('C')]);
    assert.deepEqual(out.map((r) => r.balance), [10, 20, 30]);
    assert.equal(calls.batch, 1);
    assert.equal(calls.single, 0, 'the fast path stayed fast');
    assert.equal(g.stats.batchDisabled, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('when singles fail too, the gate still fails closed', async () => {
  const original = globalThis.fetch;
  stub({ batchStatus: 429, singleStatus: 429 });
  try {
    const g = gate();
    const r = await g.check('W1');
    assert.equal(r.holder, false, 'never read a failure as "is a holder"');
    assert.equal(r.unknown, true, 'and mark it unknown, not a real zero');
  } finally {
    globalThis.fetch = original;
  }
});

test('a single lookup skips the batch attempt entirely', async () => {
  const original = globalThis.fetch;
  const calls = stub({ balances: { SOLO: 7 } });
  try {
    const g = gate();
    assert.equal((await g.check('SOLO')).balance, 7);
    assert.equal(calls.batch, 0, 'one wallet needs no batch');
    assert.equal(calls.single, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('spacing is applied between fallback requests', async () => {
  const original = globalThis.fetch;
  stub({ batchStatus: 429, balances: { A: 1, B: 1, C: 1 } });
  try {
    const g = new HolderGate({ mint: 'mint1', spacingMs: 40 });
    g.onError = () => {};
    const t0 = Date.now();
    await Promise.all([g.check('A'), g.check('B'), g.check('C')]);
    const ms = Date.now() - t0;
    // Serial with a 40ms gap between the three: at least two gaps.
    assert.ok(ms >= 80, `expected spacing to slow this down, took ${ms}ms`);
  } finally {
    globalThis.fetch = original;
  }
});
