/**
 * Holder gate: does this commenter's wallet actually hold the token?
 *
 * Solana RPC, not pump.fun — this half of the stack is a documented public API
 * and is the stable part of the system.
 *
 * A busy room is mostly the same people talking repeatedly, so the TTL cache
 * does the heavy lifting. Requests for distinct wallets inside one tick are
 * coalesced into a single JSON-RPC batch; without that, a public RPC endpoint
 * will rate-limit you within minutes.
 */

const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

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
