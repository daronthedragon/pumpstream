import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

/**
 * The dashboard at /. Opening the server used to answer 404 with a route
 * list; this is the control panel — is it working, what goes into OBS, and is
 * anything wrong.
 */

const HTML = await readFile(
  fileURLToPath(new URL('../src/dashboard.html', import.meta.url)),
  'utf8'
);

function mount({ health = {}, stats = {} } = {}) {
  const copied = [];
  const fetched = [];
  const sockets = [];
  const dom = new JSDOM(HTML, {
    url: 'http://localhost:8787/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.navigator.clipboard = { writeText: async (t) => copied.push(t) };
      window.WebSocket = class {
        constructor(url) {
          this.url = url;
          sockets.push(this);
          setTimeout(() => this.onopen?.(), 0);
        }
        close() {}
      };
      window.fetch = async (url) => {
        fetched.push(String(url));
        const body = String(url).includes('/health')
          ? { ok: true, upstreamConnected: true, mints: ['mint1'], demo: false, subscribers: 1, ...health }
          : { comments: 42, filtered: 7, holderChanges: 3, subscribers: 1, holders: { mint1: { rosterHolders: 1888, ok: 5, rpcErrors: 0, rosterRefused: false } }, ...stats };
        return { ok: true, status: 200, json: async () => body, blob: async () => ({}) };
      };
    },
  });
  return {
    doc: dom.window.document,
    window: dom.window,
    copied,
    fetched,
    send: (type, data) => sockets.at(-1).onmessage({ data: JSON.stringify({ type, data }) }),
    lines: () => [...dom.window.document.querySelectorAll('#feed .line')],
    val: (id) => dom.window.document.getElementById(id).value,
    close: () => dom.window.close(),
  };
}

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

test('it offers every URL a streamer needs, built from the current origin', async () => {
  const app = mount();
  await settle();
  assert.equal(app.val('chatUrl'), 'http://localhost:8787/overlay');
  assert.equal(app.val('boardUrl'), 'http://localhost:8787/overlay/leaderboard');
  assert.equal(app.val('builderUrl'), 'http://localhost:8787/overlay/config');
  assert.match(app.val('sceneUrl'), /\/obs\/scene\.json\?width=1920&height=1080$/);
  app.close();
});

test('the scene URL follows the chosen canvas size', async () => {
  // OBS takes the canvas from the profile, not the scene file, so getting
  // this wrong puts the sources off-screen.
  const app = mount();
  await settle();
  const select = app.doc.getElementById('canvas');
  select.value = '1280x720';
  select.dispatchEvent(new app.window.Event('change'));
  assert.match(app.val('sceneUrl'), /width=1280&height=720$/);
  app.close();
});

test('copy buttons put the URL on the clipboard', async () => {
  const app = mount();
  await settle();
  app.doc.querySelector('[data-copy="chatUrl"]').click();
  await settle();
  assert.deepEqual(app.copied, ['http://localhost:8787/overlay']);
  app.close();
});

test('status cards reflect health and stats', async () => {
  const app = mount();
  await settle(80);
  const text = app.doc.getElementById('cards').textContent;
  assert.match(text, /connected/);
  assert.match(text, /1\.9K/, '1888 holders is shown compactly');
  assert.match(text, /42/, 'comment count');
  app.close();
});

test('demo mode is called out, and is absent otherwise', async () => {
  const live = mount();
  await settle(80);
  assert.ok(!live.doc.getElementById('demoBanner').classList.contains('show'));
  live.close();

  const demo = mount({ health: { demo: true } });
  await settle(80);
  const banner = demo.doc.getElementById('demoBanner');
  assert.ok(banner.classList.contains('show'));
  assert.match(banner.textContent, /None of this data is real/i);
  demo.close();
});

test('a refused roster is explained rather than left as an empty board', async () => {
  const app = mount({
    stats: { holders: { mint1: { rosterHolders: 0, ok: 0, rpcErrors: 0, rosterRefused: true } } },
  });
  await settle(80);
  const err = app.doc.getElementById('errBanner');
  assert.ok(err.classList.contains('show'));
  assert.match(err.textContent, /will not serve the holder roster/i);
  assert.match(err.textContent, /--rpc/, 'and says what to do about it');
  app.close();
});

test('failing holder lookups are surfaced, since they look like a quiet chat', async () => {
  const app = mount({
    stats: { holders: { mint1: { rosterHolders: 0, ok: 0, rpcErrors: 12, rosterRefused: false } } },
  });
  await settle(80);
  const err = app.doc.getElementById('errBanner');
  assert.ok(err.classList.contains('show'));
  assert.match(err.textContent, /Holder lookups are failing/i);
  app.close();
});

test('a healthy server shows no error banner', async () => {
  const app = mount();
  await settle(80);
  assert.ok(!app.doc.getElementById('errBanner').classList.contains('show'));
  app.close();
});

test('chat reaches the live feed as text, never markup', async () => {
  const app = mount();
  await settle();
  // The dashboard shows chat, so the same escaping rule applies here.
  assert.match(HTML, /textContent/);
  assert.ok(!/\.innerHTML\s*=\s*[^'"`]*data\./.test(HTML), 'no event data is written as HTML');
  app.close();
});

test('the feed socket asks for a replay so the panel is not empty on open', async () => {
  const app = mount();
  await settle();
  // A dashboard that shows nothing until the next comment reads as broken.
  assert.match(HTML, /replay=\d+/);
  app.close();
});

test('a command marks its own chat line instead of repeating it', async () => {
  // The feed showed '!skip from DonkeyDonki' directly above
  // 'DonkeyDonki [1.2M #13] !skip' — the same message, twice.
  const app = mount();
  await settle();
  app.send('comment', {
    id: 'c1', text: '!skip', author: 'Wallet1111', username: 'donk',
    holder: true, balance: 1_200_000, rank: 13,
  });
  app.send('command', { name: 'skip', args: [], text: '', author: 'Wallet1111', username: 'donk', comment: { id: 'c1' } });

  const lines = app.lines();
  assert.equal(lines.length, 1, 'one message, one line');
  assert.ok(lines[0].classList.contains('cmd'), 'and it is marked as a command');
  assert.match(lines[0].textContent, /!skip/);
  assert.match(lines[0].textContent, /donk/);
  app.close();
});

test('an orphaned command still shows, rather than vanishing', async () => {
  const app = mount();
  await settle();
  app.send('comment', { id: 'c1', text: 'gm', author: 'W1', username: 'a', holder: true, balance: 5 });
  // No matching comment reached the feed — show it on its own rather than
  // silently marking the wrong line.
  app.send('command', { name: 'vote', args: ['red'], text: 'red', author: 'W9', username: 'z', comment: { id: 'nope' } });

  const lines = app.lines();
  assert.equal(lines.length, 2);
  assert.match(lines[0].textContent, /!vote/);
  assert.match(lines[0].textContent, /z/);
  app.close();
});

test('plain comments are not marked as commands', async () => {
  const app = mount();
  await settle();
  app.send('comment', { id: 'c1', text: 'gm holders', author: 'W1', username: 'a', holder: true, balance: 5, rank: 2 });
  const [line] = app.lines();
  assert.ok(!line.classList.contains('cmd'));
  assert.match(line.textContent, /gm holders/);
  app.close();
});
