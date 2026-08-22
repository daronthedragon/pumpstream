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

    this.cache = new Map(); // wallet -> { balance, at }
    this.inflight = new Map(); // wallet -> Promise
    this.queue = []; // [{ wallet, resolve, reject }]
    this.timer = null;
    // `deduped` = asked again while the first answer was still in flight.
    // Counting those as misses would make /stats badly understate efficiency.
    this.stats = { hits: 0, deduped: 0, misses: 0, rpcCalls: 0, rpcErrors: 0, ok: 0 };
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

    const body = batch.map((item, i) => ({
      jsonrpc: '2.0',
      id: i,
      method: 'getTokenAccountsByOwner',
      params: [item.wallet, { mint: this.mint }, { encoding: 'jsonParsed' }],
    }));

    try {
      this.stats.rpcCalls++;
      const res = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
      const out = await res.json();
      const byId = new Map(
        (Array.isArray(out) ? out : [out]).map((r) => [r.id, r])
      );

      // A 200 can still carry per-item JSON-RPC errors (public endpoints
      // return 429 this way), so inspect every entry, not just the status.
      let failed = 0;
      batch.forEach((item, i) => {
        const r = byId.get(i);
        if (!r || r.error) {
          failed++;
          this.stats.rpcErrors++;
          // null = "could not determine", which the caller renders as
          // non-holder but does not cache as a real zero balance.
          return item.resolve(null);
        }
        this.stats.ok++;
        item.resolve(sumBalance(r.result?.value));
      });

      if (failed === batch.length) this.consecutiveErrors++;
      else this.consecutiveErrors = 0;

      if (failed) {
        const detail = [...byId.values()].find((r) => r.error)?.error?.message ?? 'unknown RPC error';
        this.#report(new Error(`${failed}/${batch.length} holder lookups failed: ${detail}`));
      }
    } catch (err) {
      this.stats.rpcErrors += batch.length;
      this.consecutiveErrors++;
      batch.forEach((item) => item.resolve(null));
      this.#report(err);
    }
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

/** A wallet can hold the same mint across several token accounts. */
function sumBalance(accounts) {
  if (!Array.isArray(accounts)) return 0;
  return accounts.reduce((total, acc) => {
    const amt = acc?.account?.data?.parsed?.info?.tokenAmount;
    return total + Number(amt?.uiAmount ?? 0);
  }, 0);
}
