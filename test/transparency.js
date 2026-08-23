/**
 * Proves the overlay is genuinely transparent by decoding the alpha channel
 * of what OBS actually renders — not by looking at a screenshot and deciding
 * it seems fine.
 *
 * Opt-in; needs OBS running with obs-websocket enabled and a scene containing
 * the overlay as a browser source.
 *
 *   node test/transparency.js <websocket-password> [browserSourceName]
 *
 * OBS renders a source to RGBA. Any pixel the page does not paint comes back
 * with alpha 0. If the page ever painted a background — a theme, a preset, a
 * stray `body { background }` — every pixel would come back opaque and the
 * overlay would show on stream as a slab covering the scene.
 */
import WS from 'ws';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';

const PASSWORD = process.argv[2];
const SOURCE = process.argv[3] || 'pumpstream chat';

if (!PASSWORD) {
  console.error('usage: node test/transparency.js <obs-websocket-password> [sourceName]');
  process.exit(1);
}

const shot = await capture(SOURCE);
const png = PNG.sync.read(shot);
const { width, height, data } = png;

let clear = 0, opaque = 0, partial = 0;
for (let i = 3; i < data.length; i += 4) {
  const a = data[i];
  if (a === 0) clear++;
  else if (a === 255) opaque++;
  else partial++;
}
const total = width * height;
const pct = (n) => ((n / total) * 100).toFixed(1) + '%';

// The top strip is above the chat, which grows from the bottom — it must be
// completely untouched. This is the sharpest signal: a painted page shows up
// here immediately.
const stripRows = Math.floor(height * 0.15);
let stripOpaque = 0;
for (let y = 0; y < stripRows; y++) {
  for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] !== 0) stripOpaque++;
  }
}

console.log(`source        : ${SOURCE}`);
console.log(`size          : ${width}x${height}`);
console.log(`fully clear   : ${clear} px (${pct(clear)})`);
console.log(`semi          : ${partial} px (${pct(partial)})`);
console.log(`fully opaque  : ${opaque} px (${pct(opaque)})`);
console.log(`top 15% strip : ${stripOpaque} non-transparent px`);

const problems = [];
if (clear === 0) {
  problems.push('NO transparent pixels at all — the page is painting a background');
}
if (stripOpaque > 0) {
  problems.push(`${stripOpaque} painted pixels in the empty top strip`);
}
if (clear / total < 0.25) {
  problems.push(`only ${pct(clear)} of the frame is transparent; expected the majority`);
}

if (problems.length) {
  console.error('\nFAIL:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('\nPASS — the overlay composites over the scene rather than covering it.');
process.exit(0);

/* ── obs-websocket v5 ──────────────────────────────────────────────────────*/
function capture(sourceName) {
  return new Promise((resolve, reject) => {
    const ws = new WS('ws://127.0.0.1:4455');
    const send = (op, d) => ws.send(JSON.stringify({ op, d }));
    const timer = setTimeout(() => reject(new Error('obs-websocket timed out')), 30000);

    ws.on('message', (buf) => {
      const { op, d } = JSON.parse(buf.toString());

      if (op === 0) {
        const { challenge, salt } = d.authentication ?? {};
        const auth = challenge
          ? createHash('sha256')
              .update(
                createHash('sha256').update(PASSWORD + salt).digest('base64') + challenge
              )
              .digest('base64')
          : undefined;
        return send(1, { rpcVersion: d.rpcVersion, eventSubscriptions: 0, authentication: auth });
      }

      if (op === 2) {
        // NOTE: GetCurrentProgramScene segfaults obs-websocket 5.6.2 (null
        // deref in RequestHandler::GetCurrentProgramScene), so the source is
        // always named explicitly.
        return send(6, {
          requestType: 'GetSourceScreenshot',
          requestId: 'shot',
          requestData: { sourceName, imageFormat: 'png' },
        });
      }

      if (op === 7) {
        clearTimeout(timer);
        if (!d.requestStatus?.result) {
          return reject(new Error(d.requestStatus?.comment ?? 'screenshot failed'));
        }
        const b64 = d.responseData.imageData.replace(/^data:image\/png;base64,/, '');
        ws.close();
        resolve(Buffer.from(b64, 'base64'));
      }
    });

    ws.on('error', reject);
  });
}
