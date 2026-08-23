import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  UPSTREAM,
  EVENTS,
  FRAME,
  socketHeaders,
  handshakeAuth,
  joinPayload,
  historyPayload,
  classifyPush,
  normalizeMessage,
} from './adapter.js';
import { HolderGate } from './holders.js';

export { HolderGate };
export { fetchLiveCoins } from './adapter.js';

/**
 * Live pump.fun comments as a Node event stream, optionally gated to wallets
 * that actually hold the token.
 *
 *   const feed = new PumpComments({ mints: ['<mint>'], holdersOnly: true });
 *   feed.on('comment', c => console.log(c.username, c.text, c.balance));
 *   feed.on('drift',   d => console.error('upstream changed:', d));
 *   await feed.start();
 */
export class PumpComments extends EventEmitter {
  constructor({
    mints = [],
    mint,
    holdersOnly = false,
    minBalance = 0,
    rpcUrl,
    holderTtlMs = 60_000,
    history = 0,
    maxBackoffMs = 30_000,
    seenLimit = 5_000,
    commandPrefix = '!',
  } = {}) {
    super();
    this.mints = (mint ? [mint] : mints).filter(Boolean);
    if (!this.mints.length) throw new Error('PumpComments requires at least one mint');

    this.holdersOnly = holdersOnly;
    this.history = history;
    this.commandPrefix = commandPrefix;
    this.maxBackoffMs = maxBackoffMs;
    this.seenLimit = seenLimit;

    this.gates = new Map(
      this.mints.map((m) => [
        m,
        new HolderGate({ mint: m, rpcUrl, minBalance, ttlMs: holderTtlMs }),
      ])
    );
    for (const gate of this.gates.values()) {
      // A refused roster is expected on some endpoints, not a failure — the
      // gate just falls back to per-wallet lookups. Surface it, don't alarm.
      gate.onRosterError = (err) =>
        this.#emitError(wrap('roster', err, { fallback: 'per-wallet lookups' }));

      gate.onError = (err) => {
        this.#emitError(wrap('rpc', err));
        // A dead RPC + holdersOnly = an empty stream that looks like "nobody
        // is chatting". Never let that pass quietly.
        if (err.blankingStream && this.holdersOnly) {
          this.#alert(
            'degraded',
            'holder-gate',
            `Solana RPC is failing (${err.message}). Every comment is being ` +
              `dropped as a non-holder. Pass a paid rpcUrl — the public ` +
              `endpoint rate-limits getTokenAccountsByOwner.`
          );
        }
      };
    }

    this.ws = null;
    this.connected = false;
    this.stopped = false;
    this.attempt = 0;
    this.seen = new Set();
    this.reported = new Set();
    this.stats = { comments: 0, filtered: 0, commands: 0, reconnects: 0 };
  }

  /**
   * Resolves once the socket is connected and rooms are joined.
   *
   * Transient upstream failures do NOT reject — pump.fun returns 502s
   * routinely, and a stream integration must ride through them rather than
   * die on startup. We keep retrying with backoff and only give up if nothing
   * connects within `connectTimeoutMs`.
   */
  start({ connectTimeoutMs = 60_000 } = {}) {
    this.stopped = false;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('open', ok);
        this.stop();
        reject(
          new Error(
            `could not reach pump.fun within ${connectTimeoutMs}ms after ${this.attempt} attempts`
          )
        );
      }, connectTimeoutMs);

      const ok = () => {
        clearTimeout(timer);
        resolve(this);
      };
      this.once('open', ok);
      this.#connect();
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  /**
   * Feed a raw upstream message straight in, bypassing the socket.
   *
   * Same path a live message takes: normalise, dedupe, gate, emit. Useful for
   * replaying captured traffic against a change, and it is how the tests
   * exercise the pipeline without a network.
   *
   * @param {object} raw upstream message, as pump.fun sends it
   * @param {{historical?: boolean}} [opts] historical messages never fire commands
   */
  ingest(raw, { historical = false } = {}) {
    return this.#handleMessage(raw, historical);
  }

  holderStats() {
    return Object.fromEntries(
      [...this.gates].map(([m, g]) => [m, { ...g.stats, cached: g.cache.size }])
    );
  }

  /* ── internals ──────────────────────────────────────────────────────────*/

  #connect() {
    if (this.stopped) return;

    const ws = new WebSocket(UPSTREAM.socketUrl, { headers: socketHeaders() });
    this.ws = ws;

    ws.on('message', (buf) => this.#onFrame(buf.toString()));

    ws.on('error', (err) => this.#emitError(wrap('socket', err)));

    ws.on('close', (code, reason) => {
      const was = this.connected;
      this.connected = false;
      if (was) this.emit('close', { code, reason: reason?.toString() || '' });
      this.#scheduleRetry();
    });
  }

  #onFrame(d) {
    try {
      if (FRAME.isPing(d)) return this.ws.send(FRAME.pong);

      if (FRAME.isOpen(d)) {
        return this.ws.send(FRAME.connect(handshakeAuth(Date.now())));
      }

      if (FRAME.isConnect(d)) {
        this.connected = true;
        this.attempt = 0;
        for (const mint of this.mints) {
          this.ws.send(FRAME.event(EVENTS.join, joinPayload(mint)));
          if (this.history > 0) {
            this.ws.send(
              FRAME.event(EVENTS.history, historyPayload(mint, this.history), 1)
            );
          }
        }
        return this.emit('open', { mints: this.mints });
      }

      if (FRAME.isAck(d)) return this.#onHistory(FRAME.parseAck(d));

      if (FRAME.isEvent(d)) {
        const { name, payload } = FRAME.parseEvent(d);
        return this.#onPush(name, payload);
      }
    } catch (err) {
      this.#emitError(wrap('frame', err, { frame: d.slice(0, 200) }));
    }
  }

  #onHistory(ack) {
    // Observed shape: [[ {msg}, {msg}, ... ]]
    const list = Array.isArray(ack?.[0]) ? ack[0] : ack;
    if (!Array.isArray(list)) {
      return this.#drift('history-shape', {
        detail: 'history ack was not an array',
        got: typeof list,
      });
    }
    // Oldest first, so consumers see chronological order.
    for (const raw of [...list].reverse()) this.#handleMessage(raw, true);
  }

  #onPush(name, payload) {
    switch (classifyPush(name, payload)) {
      case 'message':
        return this.#handleMessage(payload, false);
      case 'viewers':
        return this.emit('viewers', payload);
      case 'presence':
        return this.emit('presence', { event: name, ...payload });
      default:
        return this.emit('unknown', { event: name, payload });
    }
  }

  async #handleMessage(raw, historical) {
    const mint = raw?.roomId || this.mints[0];
    const { comment, missing, unknown } = normalizeMessage(raw, mint);

    if (missing.length) {
      this.#drift('missing-fields', {
        detail: `upstream message is missing ${missing.join(', ')} — the gate cannot work without them`,
        missing,
        sample: raw,
      });
      return;
    }
    if (unknown.length) {
      this.#drift('new-fields', {
        detail: 'upstream added fields (not fatal, may be worth mapping)',
        unknown,
      });
    }

    // History and live pushes overlap; never emit the same comment twice.
    const key = comment.id || `${comment.author}:${comment.timestamp}:${comment.text}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > this.seenLimit) {
      this.seen.delete(this.seen.values().next().value);
    }

    comment.historical = historical;

    const gate = this.gates.get(mint);
    if (gate) {
      const { holder, balance, unknown } = await gate.check(comment.author);
      comment.holder = holder;
      comment.balance = balance;
      // holder:false + holderUnknown:true means "the RPC would not answer",
      // which is a very different claim from "this wallet holds nothing".
      comment.holderUnknown = Boolean(unknown);
    }

    if (this.holdersOnly && !comment.holder) {
      this.stats.filtered++;
      return this.emit('filtered', comment);
    }

    this.stats.comments++;
    this.emit('comment', comment);

    const command = this.#parseCommand(comment);
    if (command) {
      this.stats.commands++;
      this.emit('command', command);
    }
  }

  /**
   * `!vote blue` -> { name: 'vote', args: ['blue'] }
   *
   * The point of this is driving something outside the chat — a game, a scene
   * change, a sound. Deliberately NOT fired for replayed history: a
   * reconnecting overlay would otherwise re-trigger every command in the
   * buffer, and OBS reloads browser sources constantly.
   */
  #parseCommand(comment) {
    if (!this.commandPrefix || comment.historical) return null;

    const text = comment.text.trim();
    if (!text.startsWith(this.commandPrefix)) return null;

    const rest = text.slice(this.commandPrefix.length);
    const match = rest.match(/^([a-z0-9_-]{1,32})(?:\s+([\s\S]*))?$/i);
    if (!match) return null;

    const argText = (match[2] ?? '').trim();
    return {
      name: match[1].toLowerCase(),
      args: argText ? argText.split(/\s+/) : [],
      text: argText,
      mint: comment.mint,
      author: comment.author,
      username: comment.username,
      // Carried through so a game can weight a command by stake.
      holder: comment.holder,
      balance: comment.balance,
      isCreator: comment.isCreator,
      comment,
    };
  }

  /**
   * EventEmitter throws on an 'error' event with no listener, which would take
   * down the host process over a routine upstream 502. This feed sits under
   * live streams — it degrades and retries, it never crashes its caller.
   */
  #emitError(err) {
    if (this.listenerCount('error') > 0) return this.emit('error', err);
    console.error(`[pumpstream] ${err.scope ?? 'error'}: ${err.message}`);
  }

  /**
   * Loud, once per distinct problem. Silent degradation is the failure mode
   * that matters here: a stream that quietly shows nothing is worse than one
   * that errors, so if nobody is listening we still print.
   */
  #alert(event, kind, detail, extra = {}) {
    const key = `${event}:${kind}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    if (this.listenerCount(event) === 0) {
      const hint =
        event === 'drift'
          ? '  pump.fun has no stable API. Fix src/adapter.js.\n'
          : '';
      console.error(`\n[pumpstream] ${event.toUpperCase()} (${kind}): ${detail}\n${hint}`);
    }
    this.emit(event, { kind, detail, ...extra });
  }

  #drift(kind, { detail, ...extra }) {
    this.#alert('drift', kind, detail, extra);
  }

  #scheduleRetry() {
    if (this.stopped) return;
    const base = Math.min(1000 * 2 ** this.attempt++, this.maxBackoffMs);
    const delay = Math.round(base * (0.5 + Math.random() / 2)); // jitter
    this.stats.reconnects++;
    this.emit('reconnect', { attempt: this.attempt, delay });
    this.retryTimer = setTimeout(() => this.#connect(), delay);
  }
}

function wrap(scope, err, extra = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  e.scope = scope;
  Object.assign(e, extra);
  return e;
}

export default PumpComments;
