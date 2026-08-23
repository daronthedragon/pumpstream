/**
 * Holder gate: does this commenter's wallet actually hold the token?
 *
 * Solana RPC, not pump.fun — this half of the stack is a documented public API
 * and is the stable part of the system.
 *
 * Two strategies, preferred in this order:
 *
 *  1. ROSTER. Pull every token account for the mint in a single
 *     getProgramAccounts call and answer from memory. Measured on a live
 *     pump.fun token: 4,838 accounts in 271ms, which is 2,341 real holders
 *     for one request. Lookups then cost nothing and cannot be rate-limited,
 *     and a wallet that is absent is a definitive zero rather than a guess.
 *
 *  2. PER-WALLET. getTokenAccountsByOwner, batched where the endpoint allows
 *     it and one at a time where it does not. Used when the roster call is
 *     refused, which some endpoints do because it is expensive to serve.
 */

const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Encode a 32-byte pubkey. Avoids a dependency for the one thing we need. */
function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export class HolderGate {
  /**
   * @param {object}  opts
   * @param {string}  opts.mint        token whose holders we care about
   * @param {string} [opts.rpcUrl]     use a paid endpoint for real traffic
   * @param {number} [opts.ttlMs]      how long a balance stays fresh (60s)
   * @param {number} [opts.minBalance] UI-amount required to count as a holder
   * @param {number} [opts.batchWindowMs] coalescing window (25ms)
   * @param {number} [opts.maxBatch]   max wallets per JSON-RPC batch (100)
   */
  constructor({
    mint,
    rpcUrl = DEFAULT_RPC,
    ttlMs = 60_000,
    minBalance = 0,
    batchWindowMs = 25,
    maxBatch = 100,
    unknownTtlMs = 5_000,
    concurrency = 1,
    spacingMs = 120,
    roster = true,
    rosterTtlMs = 120_000,
  }) {
    if (!mint) throw new Error('HolderGate requires a mint');
    this.mint = mint;
    this.rpcUrl = rpcUrl;
    this.ttlMs = ttlMs;
    this.minBalance = minBalance;
    this.batchWindowMs = batchWindowMs;
    this.maxBatch = maxBatch;
    // A failed lookup is "unknown", never "holds nothing" — and it expires
    // fast so a rate-limit blip cannot pin a real holder to non-holder for a
    // full TTL. Short, not zero, so we don't hammer an RPC that is refusing.
    this.unknownTtlMs = unknownTtlMs;
    // Batching is tried first, then switched off permanently for this gate if
    // the endpoint refuses it. `concurrency` caps the fallback's parallelism.
    this.batchSupported = true;
    // Measured against api.mainnet-beta.solana.com: single lookups return 200
    // steadily, but four at once trips the limiter. Serial with a small gap
    // beats a burst, and the cache means most comments never get here at all.
    this.concurrency = Math.max(1, concurrency);
    this.spacingMs = Math.max(0, spacingMs);

    // Roster strategy: one call for every holder, then answer from memory.
    this.rosterEnabled = roster;
    this.rosterTtlMs = rosterTtlMs;
    this.roster = null;      // Map<owner, uiBalance>
    this.rosterAt = 0;
    this.rosterPromise = null;
    this.rosterRefused = false;
    this.tokenProgram = null;
    this.decimals = null;

    this.cache = new Map(); // wallet -> { balance, at }
    this.inflight = new Map(); // wallet -> Promise
    this.queue = []; // [{ wallet, resolve, reject }]
    this.timer = null;
    // `deduped` = asked again while the first answer was still in flight.
    // Counting those as misses would make /stats badly understate efficiency.
    this.stats = {
      hits: 0, deduped: 0, misses: 0,
      rpcCalls: 0, singleCalls: 0, rpcErrors: 0, ok: 0,
      batchDisabled: false,
      rosterHits: 0, rosterHolders: 0, rosterFetches: 0, rosterRefused: false,
    };
    this.consecutiveErrors = 0;
  }

  /**
   * `unknown: true` means the lookup FAILED — not that the wallet holds
   * nothing. Treating unknown as non-holder is the safe call, but reporting it
   * as fact would be wrong, so callers that care can tell the two apart.
   *
   * @returns {Promise<{holder: boolean, balance: number, unknown?: boolean}>}
   */
  async check(wallet) {
    if (!wallet) return { holder: false, balance: 0 };

    // Fast path: one roster covers everybody, so this costs nothing and
    // cannot be rate-limited. Absent from the roster is a definitive zero.
    const roster = await this.#ensureRoster();
    if (roster) {
      this.stats.rosterHits++;
      return this.#result(roster.get(wallet) ?? 0, false);
    }

    const hit = this.cache.get(wallet);
    const ttl = hit?.unknown ? this.unknownTtlMs : this.ttlMs;
    if (hit && Date.now() - hit.at < ttl) {
      this.stats.hits++;
      return this.#result(hit.balance, hit.unknown);
    }
    // Same wallet asked again before the first answer lands -> one RPC call.
    if (this.inflight.has(wallet)) {
      this.stats.deduped++;
      return this.#result(await this.inflight.get(wallet));
    }

    this.stats.misses++;
    const p = this.#enqueue(wallet);
    this.inflight.set(wallet, p);
    try {
      const balance = await p;
      const unknown = balance === null;
      this.cache.set(wallet, { balance: unknown ? 0 : balance, at: Date.now(), unknown });
      return this.#result(balance, unknown);
    } finally {
      this.inflight.delete(wallet);
    }
  }

  /**
   * The roster, if we can have one. Serves a stale copy while refreshing in
   * the background — a slightly old balance beats blocking every comment on
   * a network round trip.
   *
   * @returns {Promise<Map<string, number>|null>} null means fall back
   */
  async #ensureRoster() {
    if (!this.rosterEnabled || this.rosterRefused) return null;

    const fresh = this.roster && Date.now() - this.rosterAt < this.rosterTtlMs;
    if (fresh) return this.roster;

    if (this.roster) {
      // Stale but usable: refresh behind the scenes, answer now.
      this.rosterPromise ??= this.#refreshRoster().finally(() => {
        this.rosterPromise = null;
      });
      return this.roster;
    }

    this.rosterPromise ??= this.#refreshRoster().finally(() => {
      this.rosterPromise = null;
    });
    await this.rosterPromise;
    return this.roster;
  }

  async #refreshRoster() {
    try {
      // The mint account tells us both the decimals and which token program
      // owns it — pump.fun mints are Token-2022, not the legacy program.
      if (!this.tokenProgram || this.decimals === null) {
        const info = await this.#rpc('getAccountInfo', [
          this.mint,
          { encoding: 'jsonParsed' },
        ]);
        const value = info?.value;
        if (!value) throw new Error(`mint ${this.mint} not found`);
        this.tokenProgram = value.owner;
        this.decimals = value.data?.parsed?.info?.decimals ?? 0;
      }

      const accounts = await this.#rpc('getProgramAccounts', [
        this.tokenProgram,
        {
          encoding: 'base64',
          // Only owner (32 bytes at 32) and amount (u64 at 64) are needed;
          // slicing keeps a few thousand accounts down to a small response.
          dataSlice: { offset: 32, length: 40 },
          filters: [{ memcmp: { offset: 0, bytes: this.mint } }],
        },
      ]);

      const scale = 10 ** this.decimals;
      const roster = new Map();
      for (const a of accounts) {
        const buf = Buffer.from(a.account.data[0], 'base64');
        if (buf.length < 40) continue;
        const amount = buf.readBigUInt64LE(32);
        if (amount === 0n) continue;
        const owner = base58(buf.subarray(0, 32));
        // A wallet can hold the same mint across several token accounts.
        roster.set(owner, (roster.get(owner) ?? 0) + Number(amount) / scale);
      }

      this.roster = roster;
      this.rosterAt = Date.now();
      this.stats.rosterFetches++;
      this.stats.rosterHolders = roster.size;
      this.consecutiveErrors = 0;
    } catch (err) {
      // Plenty of endpoints refuse getProgramAccounts because it is expensive
      // to serve. That is not a failure — it just means per-wallet lookups.
      if (!this.roster) {
        this.rosterRefused = true;
        this.stats.rosterRefused = true;
      }
      this.onRosterError?.(err);
    }
  }

  async #rpc(method, params) {
    this.stats.rpcCalls++;
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status} on ${method}`);
    const out = await res.json();
    if (out.error) throw new Error(out.error.message ?? `RPC error on ${method}`);
    return out.result;
  }

  #result(balance, unknown = balance === null) {
    if (unknown) return { holder: false, balance: 0, unknown: true };
    return { holder: balance > this.minBalance, balance };
  }

  #enqueue(wallet) {
    return new Promise((resolve, reject) => {
      this.queue.push({ wallet, resolve, reject });
      if (this.queue.length >= this.maxBatch) return this.#flush();
      this.timer ??= setTimeout(() => this.#flush(), this.batchWindowMs);
    });
  }

  async #flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const batch = this.queue.splice(0, this.maxBatch);
    if (!batch.length) return;

    // Batching is the fast path and paid endpoints handle it happily. The
    // public one does not: measured against api.mainnet-beta.solana.com, a
    // single lookup returns 200 while the same lookups batched return 429.
    // So try the batch, and if the endpoint refuses it wholesale, stop
    // batching for this gate and fall back to individual requests.
    if (this.batchSupported && batch.length > 1) {
      if (await this.#tryBatch(batch)) return;
      this.batchSupported = false;
      this.stats.batchDisabled = true;
    }

    await this.#resolveIndividually(batch);
  }

  /**
   * @returns {Promise<boolean>} true if the batch produced usable answers and
   * every item has been resolved; false if the endpoint refused it, in which
   * case NOTHING is resolved and the caller retries one at a time.
   */
  async #tryBatch(batch) {
    const body = batch.map((item, i) => ({
      jsonrpc: '2.0',
      id: i,
      method: 'getTokenAccountsByOwner',
      params: [item.wallet, { mint: this.mint }, { encoding: 'jsonParsed' }],
    }));

    let byId;
    try {
      this.stats.rpcCalls++;
      const res = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return false; // 429/400 on the batch itself
      const out = await res.json();
      byId = new Map((Array.isArray(out) ? out : [out]).map((r) => [r.id, r]));
    } catch {
      return false;
    }

    // A 200 can still carry per-item errors; if every one failed, treat it as
    // the endpoint refusing batches rather than as N real failures.
    const failed = batch.filter((_, i) => !byId.get(i) || byId.get(i).error).length;
    if (failed === batch.length) return false;

    batch.forEach((item, i) => {
      const r = byId.get(i);
      if (!r || r.error) {
        this.stats.rpcErrors++;
        return item.resolve(null);
      }
      this.stats.ok++;
      item.resolve(sumBalance(r.result?.value));
    });

    this.consecutiveErrors = 0;
    if (failed) {
      const detail = [...byId.values()].find((r) => r.error)?.error?.message ?? 'unknown RPC error';
      this.#report(new Error(`${failed}/${batch.length} holder lookups failed: ${detail}`));
    }
    return true;
  }

  /** One request per wallet, a few at a time so we do not trip the limiter. */
  async #resolveIndividually(batch) {
    let failed = 0;
    let lastError = null;
    const queue = [...batch];

    const worker = async (lane) => {
      // Stagger lanes so concurrency > 1 does not become a burst.
      if (lane && this.spacingMs) await sleep(lane * this.spacingMs);
      for (let item = queue.shift(); item; item = queue.shift()) {
        try {
          this.stats.rpcCalls++;
          this.stats.singleCalls++;
          const res = await fetch(this.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'getTokenAccountsByOwner',
              params: [item.wallet, { mint: this.mint }, { encoding: 'jsonParsed' }],
            }),
          });
          if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
          const out = await res.json();
          if (out.error) throw new Error(out.error.message ?? `RPC error ${out.error.code}`);

          this.stats.ok++;
          item.answer = sumBalance(out.result?.value);
        } catch (err) {
          failed++;
          lastError = err;
          this.stats.rpcErrors++;
          // null = "could not determine", which the caller renders as
          // non-holder but does not cache as a real zero balance.
          item.answer = null;
        }
        if (queue.length && this.spacingMs) await sleep(this.spacingMs);
      }
    };

    const lanes = Math.min(this.concurrency, batch.length);
    await Promise.all(Array.from({ length: lanes }, (_, i) => worker(i)));

    if (failed === batch.length) this.consecutiveErrors++;
    else this.consecutiveErrors = 0;

    // Report BEFORE handing back answers. A caller that is about to be told
    // "not a holder" should already know the gate is broken, rather than
    // learning a tick later once it has acted on the wrong answer.
    if (failed) {
      this.#report(
        new Error(`${failed}/${batch.length} holder lookups failed: ${lastError?.message ?? 'unknown RPC error'}`)
      );
    }

    for (const item of batch) item.resolve(item.answer ?? null);
  }

  #report(err) {
    err.consecutive = this.consecutiveErrors;
    // Fail-closed means a broken RPC reads as "nobody holds anything", which
    // silently empties a holders-only stream. The caller must be told.
    //
    // Two separate symptoms count as "this is blanking the stream": a total
    // outage (every lookup in a row failing), and a persistently high error
    // rate. The second matters because a trickle of successes resets any
    // consecutive-failure counter while still dropping most real holders.
    const seen = this.stats.ok + this.stats.rpcErrors;
    const errorRate = seen ? this.stats.rpcErrors / seen : 0;
    err.errorRate = errorRate;
    err.blankingStream =
      this.consecutiveErrors >= 2 || (seen >= 8 && errorRate >= 0.5);
    this.onError?.(err);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A wallet can hold the same mint across several token accounts. */
function sumBalance(accounts) {
  if (!Array.isArray(accounts)) return 0;
  return accounts.reduce((total, acc) => {
    const amt = acc?.account?.data?.parsed?.info?.tokenAmount;
    return total + Number(amt?.uiAmount ?? 0);
  }, 0);
}
