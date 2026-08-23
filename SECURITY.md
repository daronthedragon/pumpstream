# Security policy

## Reporting a vulnerability

Please report privately through GitHub, not in a public issue:

**[Open a private security advisory →](https://github.com/daronthedragon/pumpstream/security/advisories/new)**

Private vulnerability reporting is enabled on this repository, so that form goes straight to the maintainer and stays private until a fix is out. Expect a first response within a week. If you would rather not use GitHub, reach out via [@daronthedragon on X](https://x.com/daronthedragon) and we can find another channel — please do not put details in a public post.

## Supported versions

| Version | Supported |
|---|---|
| `main` | yes |
| tagged releases | not yet — nothing is published to npm |

This is pre-1.0 and unreleased. Fixes land on `main`.

## What this project does and does not touch

Worth stating plainly, because of the ecosystem it sits in:

- **It never handles private keys, seed phrases, or wallets.** It does not sign, send, or construct transactions. There is no code path that could move funds.
- **It is read-only on-chain.** The only Solana call it makes is `getTokenAccountsByOwner`, to read a balance.
- **It reads public data.** pump.fun chat and token balances are already public. It stores nothing beyond an in-memory ring buffer of recent comments.

## Where the real risk is

The interesting surface is not the chain, it is the fact that **untrusted text from strangers gets rendered on a live broadcast**.

- **Overlay injection.** Chat reaches the DOM via `textContent`, never `innerHTML`. Anything that gets markup or script to execute in the overlay is the highest-severity bug this project can have, and is very much in scope.
- **Query parameters that reach CSS.** Overlay options are validated before use — a colour that is not plainly hex is rejected rather than written into the stylesheet. A bypass is in scope.
- **Denial of the overlay.** Input that freezes, blanks, or unboundedly grows the browser source is in scope; it takes down a live stream. This has happened once already — a trim loop that spun forever under fast chat.

## Known and accepted design tradeoffs

These are deliberate, documented, and **not** vulnerabilities. Please do not report them as such — though an argument that one is worse than assumed is welcome as a normal issue.

- **The local server has no authentication** and sends `access-control-allow-origin: *`. It binds `127.0.0.1` by default, so it is reachable only from your machine — but that does mean any page open in your browser can connect to `ws://localhost:8787` and read the comment feed. What it would learn is public pump.fun chat. Do not bind it to a public interface, and do not put anything private through it.
- **No rate limiting on the local server.** It is a single-user local tool.
- **The opt-in OBS check takes a password as a command-line argument** (`npm run test:transparency -- <ws-password>`), which puts it in your shell history and process list. It is a local obs-websocket password on a developer machine; treat it accordingly.
- **Upstream breakage is not a vulnerability.** pump.fun has no public API and changes without notice. That is expected — file it as an issue with the payload instead.

## Dependencies

One runtime dependency (`ws`), two dev dependencies (`jsdom`, `pngjs`). Keeping that number near zero is deliberate. If you find a vulnerable transitive dependency, a normal issue or pull request is fine — no need for a private report.
