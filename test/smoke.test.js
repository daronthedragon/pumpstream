import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME,
  normalizeMessage,
  classifyPush,
  looksLikeMessage,
  handshakeAuth,
} from '../src/adapter.js';
import { HolderGate } from '../src/holders.js';

/**
 * A real message captured from wss://livechat.pump.fun on 2026-08-22.
 * If upstream changes shape, these tests are what tells you.
 */
const REAL_MESSAGE = {
  id: '7745eda5-3b8f-4c08-b218-fd2009fdeb57',
  roomId: '2MsXjGge1F9GY2uHXaKZijreBi2zeg4ib7fjpTuKpump',
  message: 'gm holders',
  username: 'kindlycrab78735',
  userAddress: '6GtKSyfBFkuqgBbxeV1sgU847g6wZ7sZqAMij3PQywTC',
  profile_image: 'https://ipfs.io/ipfs/bafkrei...',
  timestamp: '2026-08-08T18:23:01.144Z',
  messageType: 'REGULAR',
  expiresAt: 1788805381,
  isModerator: false,
  isCreator: false,
};

test('socket.io framing round-trips', () => {
  assert.ok(FRAME.isOpen('0{"sid":"abc"}'));
  assert.ok(!FRAME.isOpen('40{"sid":"abc"}'), 'CONNECT must not read as OPEN');
  assert.ok(FRAME.isPing('2'));
  assert.ok(FRAME.isConnect('40{"sid":"abc"}'));
  assert.ok(FRAME.isEvent('42["userLeft",{"username":"x"}]'));
  assert.ok(FRAME.isAck('43[[{"id":"1"}]]'));

  const framed = FRAME.event('joinRoom', { roomId: 'mint1' });
  assert.equal(framed, '42["joinRoom",{"roomId":"mint1"}]');
  assert.deepEqual(FRAME.parseEvent(framed), {
    name: 'joinRoom',
    payload: { roomId: 'mint1' },
  });
});

test('ack frames parse with and without an id', () => {
  assert.equal(FRAME.ackId('431[[]]'), 1);
  assert.deepEqual(FRAME.parseAck('431[[{"a":1}]]'), [[{ a: 1 }]]);
});

test('handshake carries the origin pump.fun expects', () => {
  const auth = handshakeAuth(1700000000000);
  assert.equal(auth.origin, 'https://pump.fun');
  assert.equal(auth.token, null);
  assert.equal(typeof auth.timestamp, 'number');
});

test('a real message normalizes with no drift', () => {
  const { comment, missing, unknown } = normalizeMessage(REAL_MESSAGE, 'fallback');
  assert.deepEqual(missing, [], 'no required field may be missing');
  assert.deepEqual(unknown, [], 'every field in a real message must be mapped');

  assert.equal(comment.text, 'gm holders');
  assert.equal(comment.author, '6GtKSyfBFkuqgBbxeV1sgU847g6wZ7sZqAMij3PQywTC');
  assert.equal(comment.mint, REAL_MESSAGE.roomId);
  assert.equal(comment.username, 'kindlycrab78735');
  assert.equal(comment.isCreator, false);
  assert.equal(comment.holder, null, 'holder is unknown until the gate runs');
  assert.equal(comment.expiresAt, new Date(1788805381 * 1000).toISOString());
});

test('threaded replies are mapped, and absent when not a reply', () => {
  const plain = normalizeMessage(REAL_MESSAGE, 'mint1').comment;
  assert.equal(plain.replyTo, null);

  const { comment, unknown } = normalizeMessage(
    {
      ...REAL_MESSAGE,
      replyToId: '4dd4d9ad-b3d6-49a9-95bf-d28545541851',
      replyPreview: 'Because it brings more eyes',
    },
    'mint1'
  );
  assert.deepEqual(unknown, [], 'reply fields must be mapped, not drift');
  assert.deepEqual(comment.replyTo, {
    id: '4dd4d9ad-b3d6-49a9-95bf-d28545541851',
    preview: 'Because it brings more eyes',
  });
});

test('emoji reactions are mapped without inventing a total count', () => {
  const { comment, unknown } = normalizeMessage(
    {
      ...REAL_MESSAGE,
      reactionRecentAddresses: { ':fire:': ['4ua8RdMX2K7hU9eLa9JLbHMpw53a8X8XBK126drwWgsz'] },
      reactionRecentAvatarUrls: { ':fire:': ['https://pump.mypinata.cloud/ipfs/bafk…'] },
    },
    'mint1'
  );
  assert.deepEqual(unknown, [], 'reaction fields must be mapped, not drift');
  assert.deepEqual(comment.reactions[':fire:'].recent, [
    '4ua8RdMX2K7hU9eLa9JLbHMpw53a8X8XBK126drwWgsz',
  ]);
  assert.equal(comment.reactions[':fire:'].avatars.length, 1);
  // Upstream only sends *recent* reactors, so exposing a count would be a
  // sample size pretending to be a total.
  assert.equal(comment.reactions[':fire:'].count, undefined);

  assert.equal(normalizeMessage(REAL_MESSAGE, 'mint1').comment.reactions, null);
});

test('drift is reported when upstream drops a field we depend on', () => {
  const { missing } = normalizeMessage({ message: 'hi' }, 'mint1');
  assert.deepEqual(missing, ['userAddress']);
});

test('drift is reported when upstream adds a field', () => {
  const { unknown } = normalizeMessage(
    { ...REAL_MESSAGE, sentimentScore: 0.9 },
    'mint1'
  );
  assert.deepEqual(unknown, ['sentimentScore']);
});

test('messages are classified by shape, surviving an event rename', () => {
  assert.ok(looksLikeMessage(REAL_MESSAGE));
  assert.equal(classifyPush('newMessage', REAL_MESSAGE), 'message');
  // The whole point: upstream renames the event, we still classify it.
  assert.equal(classifyPush('chatMessageV2', REAL_MESSAGE), 'message');
  assert.equal(classifyPush('userLeft', { username: 'x' }), 'presence');
  assert.equal(classifyPush('viewerCount', { count: 3 }), 'viewers');
  assert.equal(classifyPush('somethingNew', { foo: 1 }), 'other');
});

test('an upstream error with no listener never throws', async () => {
  // Regression: a real pump.fun 502 crashed the process here. EventEmitter
  // throws on an unheard 'error', which must never take down a live stream.
  const { PumpComments } = await import('../src/index.js');
  const feed = new PumpComments({ mint: 'mint1' });
  assert.equal(feed.listenerCount('error'), 0);

  const errs = [];
  const realLog = console.error;
  console.error = (m) => errs.push(m);
  try {
    // Reach the same private path a socket failure takes.
    assert.doesNotThrow(() => feed.emit('close', { code: 1006 }));
  } finally {
    console.error = realLog;
    feed.stop();
  }
});

test('start() gives up with a clear message instead of hanging', async () => {
  const { PumpComments } = await import('../src/index.js');
  const feed = new PumpComments({ mint: 'mint1' });
  feed.on('error', () => {});
  // Point at a black hole so it can never connect.
  await assert.rejects(
    () => feed.start({ connectTimeoutMs: 300 }),
    /could not reach pump.fun within 300ms/
  );
  feed.stop();
});

/* ── holder gate, against a stubbed RPC ────────────────────────────────────*/

const accountsFor = (bal) =>
  bal === undefined
    ? []
    : [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: bal } } } } } }];

// The real endpoint answers both a JSON-RPC batch and a lone request, and the
// gate uses whichever the endpoint tolerates — so the stub must speak both.
function stubRpc(balancesByWallet) {
  return async (_url, opts) => {
    const body = JSON.parse(opts.body);
    stubRpc.calls++;
    const answer = (req) => ({
      id: req.id,
      result: { value: accountsFor(balancesByWallet[req.params[0]]) },
    });
    return {
      ok: true,
      json: async () =>
        Array.isArray(body) ? body.map(answer) : answer(body),
    };
  };
}

test('holder gate identifies holders and non-holders', async () => {
  const original = globalThis.fetch;
  stubRpc.calls = 0;
  globalThis.fetch = stubRpc({ WALLET_HOLDER: 4200 });
  try {
    const gate = new HolderGate({ mint: 'mint1', roster: false });
    assert.deepEqual(await gate.check('WALLET_HOLDER'), { holder: true, balance: 4200 });
    assert.deepEqual(await gate.check('WALLET_EMPTY'), { holder: false, balance: 0 });
  } finally {
    globalThis.fetch = original;
  }
});

test('minBalance threshold excludes dust holders', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = stubRpc({ DUST: 5 });
  try {
    const gate = new HolderGate({ mint: 'mint1', minBalance: 1000, roster: false });
    const r = await gate.check('DUST');
    assert.equal(r.balance, 5);
    assert.equal(r.holder, false, '5 tokens must not pass a 1000 threshold');
  } finally {
    globalThis.fetch = original;
  }
});

test('cache and batching keep RPC calls far below lookup count', async () => {
  const original = globalThis.fetch;
  stubRpc.calls = 0;
  globalThis.fetch = stubRpc({ A: 10, B: 20, C: 30 });
  try {
    const gate = new HolderGate({ mint: 'mint1', roster: false });
    // 3 distinct wallets asked 100 times each.
    const lookups = [];
    for (let i = 0; i < 100; i++) lookups.push(gate.check('A'), gate.check('B'), gate.check('C'));
    const results = await Promise.all(lookups);

    assert.equal(results.length, 300);
    assert.ok(results.every((r) => r.holder), 'all three wallets hold');
    assert.ok(
      stubRpc.calls <= 2,
      `300 lookups must collapse into <=2 RPC calls, got ${stubRpc.calls}`
    );
    // Only the 3 distinct wallets may reach the network; the rest are absorbed
    // by the in-flight dedupe or the cache.
    assert.equal(gate.stats.misses, 3, 'exactly 3 wallets should miss');
    assert.equal(
      gate.stats.hits + gate.stats.deduped,
      297,
      'every other lookup must be a cache hit or a dedupe'
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('a failing RPC raises a loud "degraded" alert, not a silent empty stream', async () => {
  const { PumpComments } = await import('../src/index.js');
  const original = globalThis.fetch;
  // Exactly how the public endpoint refuses: HTTP 200 with per-item 429s.
  globalThis.fetch = async (_u, opts) => ({
    ok: true,
    json: async () => {
      const body = JSON.parse(opts.body);
      const refuse = (r) => ({
        id: r.id,
        error: { code: 429, message: 'Too many requests for a specific RPC call' },
      });
      return Array.isArray(body) ? body.map(refuse) : refuse(body);
    },
  });

  try {
    const feed = new PumpComments({ mint: 'mint1', holdersOnly: true });
    feed.on('error', () => {});
    const alerts = [];
    feed.on('degraded', (d) => alerts.push(d));

    const gate = feed.gates.get('mint1');
    // Two failed rounds is the threshold for "this is blanking the stream".
    await gate.check('W1');
    await gate.check('W2');

    assert.equal(alerts.length, 1, 'must alert exactly once, not per comment');
    assert.equal(alerts[0].kind, 'holder-gate');
    assert.match(alerts[0].detail, /Every comment is being dropped/);
    assert.match(alerts[0].detail, /paid rpcUrl/);
    feed.stop();
  } finally {
    globalThis.fetch = original;
  }
});

test('a high RPC error rate alerts even when some lookups succeed', async () => {
  // Regression: a live run had 12 of 13 lookups refused and delivered zero
  // comments, yet stayed silent — the occasional success kept resetting the
  // consecutive-failure counter.
  const { PumpComments } = await import('../src/index.js');
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (_u, opts) => ({
    ok: true,
    json: async () => {
      const body = JSON.parse(opts.body);
      // 1 success, then all failures — never two total-failure rounds early.
      const one = (r) =>
        n++ === 0
          ? { id: r.id, result: { value: [] } }
          : { id: r.id, error: { code: 429, message: 'Too many requests' } };
      return Array.isArray(body) ? body.map(one) : one(body);
    },
  });

  try {
    const feed = new PumpComments({ mint: 'mint1', holdersOnly: true });
    feed.on('error', () => {});
    const alerts = [];
    feed.on('degraded', (d) => alerts.push(d));

    const gate = feed.gates.get('mint1');
    for (let i = 0; i < 10; i++) await gate.check(`W${i}`);

    assert.ok(gate.stats.rpcErrors >= 8, 'setup: most lookups should fail');
    assert.equal(alerts.length, 1, 'a sustained high error rate must alert');
    feed.stop();
  } finally {
    globalThis.fetch = original;
  }
});

test('gate fails closed when RPC errors, and marks the answer unknown', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429 });
  try {
    const gate = new HolderGate({ mint: 'mint1', roster: false });
    const r = await gate.check('ANY');
    assert.equal(r.holder, false, 'an RPC failure must never be read as "is a holder"');
    assert.equal(r.unknown, true, 'a failure is "unknown", not a real zero balance');
    assert.equal(gate.stats.rpcErrors, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('a rate-limited lookup is not cached as a real zero balance', async () => {
  // Regression: a 429 used to be cached like a genuine 0, pinning a real
  // holder to "non-holder" for the full 60s TTL.
  const original = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (_u, opts) => {
    call++;
    if (call === 1) return { ok: false, status: 429 }; // rate limited
    return {
      ok: true,
      json: async () => {
        const body = JSON.parse(opts.body);
        const hit = (r) => ({
          id: r.id,
          result: { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: 5000 } } } } } }] },
        });
        return Array.isArray(body) ? body.map(hit) : hit(body);
      },
    };
  };

  try {
    const gate = new HolderGate({ mint: 'mint1', unknownTtlMs: 0, roster: false });
    const first = await gate.check('REAL_HOLDER');
    assert.deepEqual(first, { holder: false, balance: 0, unknown: true });

    // The very next check must retry rather than serve the poisoned entry.
    const second = await gate.check('REAL_HOLDER');
    assert.equal(second.holder, true, 'the retry must find the real balance');
    assert.equal(second.balance, 5000);
    assert.equal(second.unknown, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test('balances across multiple token accounts are summed', async () => {
  const original = globalThis.fetch;
  const split = {
    value: [
      { account: { data: { parsed: { info: { tokenAmount: { uiAmount: 100 } } } } } },
      { account: { data: { parsed: { info: { tokenAmount: { uiAmount: 250 } } } } } },
    ],
  };
  globalThis.fetch = async (_u, opts) => ({
    ok: true,
    json: async () => {
      const body = JSON.parse(opts.body);
      return Array.isArray(body)
        ? body.map((r) => ({ id: r.id, result: split }))
        : { id: body.id, result: split };
    },
  });
  try {
    const gate = new HolderGate({ mint: 'mint1', roster: false });
    assert.equal((await gate.check('SPLIT')).balance, 350);
  } finally {
    globalThis.fetch = original;
  }
});
