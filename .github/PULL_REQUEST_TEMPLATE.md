<!--
  Thanks for sending this. Keep it to one change per pull request, and tell us
  what you observed — for upstream fixes, the payload you saw is worth more
  than the diff.
-->

## What this changes

<!-- One or two sentences. -->

## What you observed

<!--
  Especially for upstream fixes: what did pump.fun actually send? Paste the
  payload. "The field moved" is much easier to review with the object next to
  it.
-->

## Testing

- [ ] `npm test` passes
- [ ] Added a test for new behaviour, or a test that fails without this fix
- [ ] Ran `npm run test:live` <!-- needs a busy room; fine to skip -->
- [ ] Ran `npm run test:transparency` <!-- needs OBS + obs-websocket; fine to skip -->

<!-- If you skipped either, say so here. That is useful information, not a failing. -->

## Invariants

These fail silently on someone's live stream, so they are worth a second look
before merging. Tick what applies, or write "n/a".

- [ ] The overlay page still paints no background in any theme or preset
- [ ] Chat still reaches the DOM via `textContent`, never `innerHTML`
- [ ] The holder gate still fails closed (a failed lookup is `unknown`, never a real zero)
- [ ] Breakage is still loud — `drift` / `degraded` rather than going quiet
- [ ] No new runtime dependency
