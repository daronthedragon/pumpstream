# pumpstream

Live pump.fun comments as an event stream, gated to wallets that **actually hold the token**.

Point it at a mint, get a clean feed of comments where every author has been balance-checked on-chain. Drop it straight into OBS as a browser source, consume it as a Node library, or subscribe from any language or engine over the local server.

```bash
npx pumpstream <mint> --holders-only
```

```
pumpstream listening on http://127.0.0.1:8787
  mint         DDVUsN8sDFxbaX6gNBoD44kjZhFETWJnwAn4EX1dpump
  holders-only true
  websocket    ws://127.0.0.1:8787

✓ vukasle [412,900]: exited at 30k back at it in 100k
```

## Why holder-gating

Open token chat is mostly bots, shills, and scams. The first message this project ever pulled from a live room was a suicide-framed giveaway scam from a wallet holding **zero** of the token. A holder gate deletes that entire class of noise for free, and turns "who gets to appear on my stream" into something backed by on-chain stake rather than moderation effort.

It is a spam filter, **not a safety layer** — see [Moderation](#moderation).

## Install

```bash
npm install pumpstream
```

Node 18+. One dependency (`ws`).

## Library

```js
import { PumpComments } from 'pumpstream';

const feed = new PumpComments({
  mint: '<token mint>',
  holdersOnly: true,
  minBalance: 1000,   // require a real bag, not dust
  history: 20,        // replay recent comments on connect
});

feed.on('comment', (c) => {
  console.log(c.username, c.text, c.balance);
});

feed.on('drift', (d) => console.error('upstream changed:', d.kind, d.detail));

await feed.start();
```

### Comment shape

```js
{
  id: '7745eda5-…',
  mint: 'DDVUsN8s…pump',
  text: 'gm holders',
  author: '6GtKSyfB…ywTC',      // wallet address
  username: 'kindlycrab78735',
  avatar: 'https://ipfs.io/ipfs/…',
  timestamp: '2026-08-08T18:23:01.144Z',
  expiresAt: '2026-09-08T…',     // pump.fun expires chat history — persist what you need
  isCreator: false,
  isModerator: false,
  type: 'REGULAR',
  replyTo: { id: '4dd4…', preview: 'Because it brings…' },  // null if not a reply
  reactions: { ':fire:': { recent: ['4ua8…'], avatars: ['https://…'] } },  // null if none
  holder: true,                  // filled in by the gate
  balance: 412900,               // UI amount, summed across token accounts
  holderUnknown: false,          // true = the lookup FAILED, not "holds nothing"
  historical: false,             // true if from the replay buffer
  raw: { … }                     // untouched upstream object
}
```

### Options

| Option | Default | |
|---|---|---|
| `mint` / `mints` | — | token(s) to follow |
| `holdersOnly` | `false` | drop non-holders instead of just labelling them |
| `minBalance` | `0` | UI-amount required to count as a holder |
| `rpcUrl` | public mainnet | **use a paid RPC for real traffic** |
| `holderTtlMs` | `60000` | how long a balance stays fresh |
| `history` | `0` | replay the last N comments on connect |

### Events

`comment` · `filtered` (failed the gate) · `presence` · `viewers` · `drift` · `degraded` · `reconnect` · `error` · `open` · `close`

`drift` fires when pump.fun's message shape changes. `degraded` fires when the holder gate itself is broken — see [Rate limits](#rate-limits). Handle both: they are how you find out the feed is lying to you.

## Local server

One upstream connection, many local subscribers.

```bash
npx pumpstream <mint> --holders-only --min-balance 1000 --port 8787
npx pumpstream --discover      # list live tokens and their mints
```

| | |
|---|---|
| `ws://localhost:8787` | every event as JSON `{type, data}` |
| `GET /overlay` | the OBS browser source |
| `GET /health` | liveness + upstream connection state |
| `GET /comments?limit=50` | recent buffer, for polling clients |
| `GET /stats` | counters + holder-cache efficiency |

Filter a socket to one mint with `ws://localhost:8787?mint=<mint>`. CORS is open, so a browser page or game client can read it directly. See `examples/consume.html`.

Because it fans out locally, **run one server per mint, not one connection per viewer** — see [Rate limits](#rate-limits).

## OBS overlay

Start the server, then add a **Browser Source** in OBS pointing at:

```
http://localhost:8787/overlay
```

Set the width and height to the area you want chat to occupy. The background is transparent, so it composites straight over your scene — no chroma key, no window capture.

Newest comments slide in at the bottom, each with the commenter's name, avatar, and holder balance. Everything is tuned by query string:

| Option | Default | |
|---|---|---|
| `max` | `8` | how many comments stay on screen |
| `fade` | `0` | seconds before a comment fades out (`0` = never) |
| `font` | `20` | base font size in px |
| `align` | `left` | `left` or `right` |
| `accent` | `#7ee787` | highlight colour for names and the bar |
| `avatars` | `1` | show profile pictures |
| `balance` | `1` | show the holder balance badge |
| `replies` | `1` | show the quoted parent of a reply |
| `status` | `1` | corner badge when the feed breaks |
| `mint` | — | pin to one token if the server follows several |

```
http://localhost:8787/overlay?max=5&fade=25&font=24&align=right&accent=%23ff7b72
```

Two details worth knowing:

- **It tells you when it is broken.** If the upstream shape changes or holder checks start failing, a small red badge appears in the corner — because an overlay that silently shows nothing is indistinguishable from a quiet chat. Pass `status=0` to suppress it.
- **It reconnects on its own.** OBS suspends and reloads browser sources constantly; the overlay retries with backoff and picks the feed back up.

Comment text is rendered with `textContent`, never `innerHTML` — chat is untrusted input and this is on your stream.

---

## Read this before you depend on it

### pump.fun has no public API

Everything here is reverse-engineered from live traffic and can break without a changelog. That is not a hypothetical:

- `GET https://frontend-api-v3.pump.fun/replies/{mint}` — the comments endpoint in every community spec — now returns `404 Cannot GET /replies/…`
- `frontend-api-v2.pump.fun` returns `503`; `frontend-api.pump.fun` returns Cloudflare `1016`

Comments moved to a Socket.IO service at `wss://livechat.pump.fun`, which is what this library speaks.

**Every pump.fun-specific detail lives in [`src/adapter.js`](src/adapter.js).** URLs, handshake, event names, and field mapping are all in that one file, so a breaking change is a small edit rather than a rewrite.

### It tells you when it breaks

Silent failure is the real danger — a stream overlay that quietly stops is worse than one that errors. So:

- Messages are classified **by shape, not by event name**, so an upstream rename doesn't stop the feed
- Losing a field the gate depends on emits a loud `drift` event (and prints to stderr if nothing is listening)
- New upstream fields also raise `drift`, so you find out that something changed before it bites

`drift` earned its place during development: it caught two real unmapped fields on live traffic (`expiresAt`, threaded replies via `replyToId`/`replyPreview`, and emoji reactions via `reactionRecent*`) — all now mapped. Each was found by the detector rather than by noticing something looked wrong.

### Rate limits

Opening many sockets quickly gets you throttled — measured, not guessed: 10 sequential connections produced **20 socket errors and 0 comments**, while a single connection worked immediately. One upstream connection fanned out locally is the supported pattern.

Holder checks are batched into single JSON-RPC calls and cached per wallet — in testing, 300 lookups across 3 wallets collapsed into **1 RPC call**.

**Use a paid RPC.** The public Solana endpoint rate-limits this method hard, and it is not subtle:

```
{"error":{"code":429,"message":"Too many requests for a specific RPC call"}}
```

A live 25-second run on the public endpoint produced 12 lookups, **10 of which were refused**. Failed lookups fail closed, so on a throttled RPC real holders get dropped. Two things keep that honest rather than silent:

- a refused lookup is recorded as `holderUnknown: true`, never cached as a genuine zero balance, and retried within seconds
- if *every* lookup fails twice running, the feed emits a loud `degraded` event, because "holders-only" plus a dead RPC otherwise looks exactly like "nobody is chatting"

Pass `--rpc` with a Helius/QuickNode/Triton endpoint before going live and none of this bites.

### Moderation

The gate filters by stake, not by content. A determined holder can still say anything, and **you are broadcasting it**. If comments go on screen, add a content filter and a manual kill switch. Consider `minBalance` high enough that abuse has a cost.

`comment.text` is untrusted input — never inject it as HTML.

### Not affiliated

Not affiliated with, endorsed by, or supported by pump.fun. Read-only: it never touches keys, signs, or trades.

## Tests

```bash
npm test
```

29 tests. The library half covers framing, normalization, drift detection, and the holder gate (against a stubbed RPC), built on a message captured from a live room — so upstream shape changes surface as failures rather than silence. The overlay half runs in jsdom against a fake socket, so rendering, escaping, trimming, and reconnect are all verified without a browser.

Includes regressions for every bug found while building this: a transient pump.fun `502` crashing the host process, a rate-limited lookup cached as a real zero balance, a high error rate failing to raise an alert, and an overlay trim loop that spun forever once chat outpaced the exit animation.

```bash
npm run test:live            # opt-in, hits real pump.fun traffic
```

The live check runs the whole path — socket, normalize, holder gate, local server, WebSocket subscriber — and is deliberately kept out of `npm test`, since whether a room is busy is not something your CI should depend on.

## License

MIT
