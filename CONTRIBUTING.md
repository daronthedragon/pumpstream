# Contributing to pumpstream

Issues and pull requests are welcome. This is a small codebase — five source files, one runtime dependency — and the fastest way in is to run it against a room that is live right now.

```bash
git clone https://github.com/daronthedragon/pumpstream
cd pumpstream
npm install
npm run discover                 # find a token with live chat
npm start -- <mint> --history 20
```

Then open `http://localhost:8787/overlay/config` to watch the overlay fill with real comments.

## The codebase

| | |
|---|---|
| [`src/adapter.js`](src/adapter.js) | **the only file that knows what pump.fun looks like** — URLs, handshake, event names, field mapping, drift detection |
| [`src/index.js`](src/index.js) | `PumpComments`, the event emitter: connection, reconnect, dedupe, gating |
| [`src/holders.js`](src/holders.js) | `HolderGate` — Solana RPC balance lookups, batching, caching |
| [`src/server.js`](src/server.js) | local WebSocket + HTTP fan-out, and the routes |
| [`src/overlay.html`](src/overlay.html) | the OBS browser source, self-contained |
| [`src/config.html`](src/config.html) | the overlay builder at `/overlay/config` |

Plain ES modules, no build step, no transpiler. Run the source directly.

## If pump.fun broke it

This is the most likely reason you are here, and it is expected rather than surprising: pump.fun has no public API and changes without notice. The documented REST endpoint every community spec lists was already dead before this project was written.

**Everything upstream-specific lives in [`src/adapter.js`](src/adapter.js).** A breaking change should be a small edit to that one file. If a fix needs to reach beyond it, that is a design problem worth raising in the issue rather than working around.

The feed is built to say what broke instead of going quiet:

```
[pumpstream] UPSTREAM DRIFT (new-fields): upstream added fields …
```

`drift` fires when the message shape changes; `degraded` fires when the holder gate itself is failing. Both print to stderr when nothing is listening.

## Reporting an issue

The single most useful thing you can include is the raw payload, not a description of it. Every comment carries the untouched upstream object on `comment.raw`:

```js
feed.on('drift', (d) => console.error(JSON.stringify(d, null, 2)));
feed.on('comment', (c) => console.error(JSON.stringify(c.raw, null, 2)));
```

Also worth stating:

- what `npm run test:live` printed — it exercises the whole path and reports drift
- whether you were on the public Solana RPC (it rate-limits hard; see the README)
- for overlay problems, the full URL including its query string

## Things to keep true

These are invariants, not style preferences. Each one exists because breaking it fails **silently**, on someone's live stream, in front of an audience.

- **The overlay page never paints a background.** Not in a theme, not in a preset, not with a preview backdrop active. `html` and `body` stay transparent or the overlay covers the scene instead of composing over it. Asserted across every preset in `test/options.test.js`, and against real OBS output by `npm run test:transparency`.
- **Chat is untrusted input.** `textContent`, never `innerHTML`. Anything derived from a query parameter that reaches CSS is validated first — that is why a non-hex colour is rejected rather than written into the stylesheet.
- **The holder gate fails closed.** A failed RPC lookup is `unknown`. Never a cached zero balance, and never "is a holder".
- **Breakage is loud.** If the feed cannot do its job it emits `drift` or `degraded` and prints when nobody is listening. An overlay that silently shows nothing is indistinguishable from a quiet chat, which is the worst possible failure here.
- **Dependencies stay near zero.** One runtime dependency (`ws`) is a feature of this project, not an accident. Please make the case in an issue before adding another.

## Tests

```bash
npm test                                    # offline, deterministic, safe for CI
npm run test:live                           # real pump.fun traffic, end to end
npm run test:transparency -- <ws-password>  # real OBS output, alpha channel
```

`npm test` runs against captured fixtures and a stubbed RPC. It must stay that way: no live network, no real RPC, no dependency on a busy chat room.

What a change is expected to bring:

- **New behaviour needs a test in `npm test`.**
- **A bug fix needs a test that fails without it.** Every regression test in there came from something that actually broke in practice, which is why they earn their place.
- **Changing how the overlay looks?** Run `npm run test:transparency` if you can. It needs OBS running with obs-websocket enabled and a scene containing the overlay as a browser source, so it is fine to skip — just say so in the pull request.

## Pull requests

- One change per pull request.
- Explain what you **observed**, not only what you changed. For upstream fixes the payload you saw is worth more than the diff.
- Run `npm test` before opening, and say plainly if you could not run the live or OBS checks. "I could not test this against OBS" is useful information, not a failing.
- Match the surrounding style: the comments here explain *why* something is the way it is, usually because the obvious alternative broke. Keep that.

## Code of conduct

Be decent to each other. Bad-faith participation, harassment, or using the issue tracker to promote a token will be closed without discussion.
