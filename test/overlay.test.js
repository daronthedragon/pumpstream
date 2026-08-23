import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HTML = await readFile(
  fileURLToPath(new URL('../src/overlay.html', import.meta.url)),
  'utf8'
);

/**
 * Boot the overlay with a fake WebSocket so we can drive it deterministically.
 * Returns the window plus a `push(type, data)` that delivers a server event.
 */
function mount(query = '') {
  let socket;
  const dom = new JSDOM(HTML, {
    url: `http://localhost:8787/overlay${query}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.WebSocket = class {
        constructor(url) {
          this.url = url;
          socket = this;
          // The overlay calls connect() during parse; open on a later tick.
          setTimeout(() => this.onopen?.(), 0);
        }
        close() {
          this.onclose?.();
        }
      };
    },
  });

  return {
    window: dom.window,
    doc: dom.window.document,
    get socket() {
      return socket;
    },
    push(type, data) {
      socket.onmessage({ data: JSON.stringify({ type, data }) });
    },
    close: () => dom.window.close(),
  };
}

const comment = (over = {}) => ({
  id: 'c1',
  mint: 'mint1',
  text: 'gm holders',
  author: '6GtKSyfBFkuqgBbxeV1sgU847g6wZ7sZqAMij3PQywTC',
  username: 'kindlycrab78735',
  avatar: 'https://example.test/a.png',
  balance: 412900,
  holder: true,
  isCreator: false,
  replyTo: null,
  ...over,
});

const settle = () => new Promise((r) => setTimeout(r, 10));

test('a comment renders with name, balance badge and text', async () => {
  const app = mount();
  await settle();
  app.push('comment', comment());

  const msg = app.doc.querySelector('.msg');
  assert.ok(msg, 'a message element must be rendered');
  assert.equal(msg.querySelector('.name').textContent, 'kindlycrab78735');
  assert.equal(msg.querySelector('.text').textContent, 'gm holders');
  assert.equal(msg.querySelector('.bal').textContent, '412.9K');
  assert.ok(msg.querySelector('.avatar'), 'avatar should render when present');
  app.close();
});

test('comment text is never interpreted as HTML', async () => {
  // Chat is untrusted: a scripted overlay running arbitrary markup on stream
  // would be a genuine security hole.
  const app = mount();
  await settle();
  app.push('comment', comment({ text: '<img src=x onerror=alert(1)>hi' }));

  const text = app.doc.querySelector('.text');
  assert.equal(text.querySelector('img'), null, 'no element may be created');
  assert.equal(text.textContent, '<img src=x onerror=alert(1)>hi');
  app.close();
});

test('the on-screen count is capped by ?max, even under a burst', async () => {
  // Regression: trimming counted elements that were still animating out, so
  // this loop could never make progress and spun forever — freezing the whole
  // browser source the moment chat outpaced the exit animation.
  const app = mount('?max=3');
  await settle();
  for (let i = 0; i < 200; i++) app.push('comment', comment({ id: `c${i}`, text: `m${i}` }));
  await settle();

  const live = [...app.doc.querySelectorAll('.msg')].filter(
    (m) => !m.classList.contains('leaving')
  );
  assert.equal(live.length, 3, 'only max messages stay on screen');
  assert.equal(live.at(-1).querySelector('.text').textContent, 'm199', 'newest is kept');
  app.close();
});

test('a mint filter is passed through to the socket url', async () => {
  const app = mount('?mint=ABC123');
  await settle();
  assert.match(app.socket.url, /mint=ABC123/);
  app.close();
});

test('creator messages get a dev tag, and dust balances no badge', async () => {
  const app = mount();
  await settle();
  app.push('comment', comment({ isCreator: true, balance: 0 }));

  const msg = app.doc.querySelector('.msg');
  assert.equal(msg.querySelector('.tag').textContent, 'dev');
  assert.equal(msg.querySelector('.bal'), null, 'no badge for a zero balance');
  app.close();
});

test('replies show the quoted parent', async () => {
  const app = mount();
  await settle();
  app.push('comment', comment({ replyTo: { id: 'p1', preview: 'why though' } }));

  assert.equal(app.doc.querySelector('.reply').textContent, '↳ why though');
  app.close();
});

test('a broken feed shows a status badge instead of looking quiet', async () => {
  // The whole point: an overlay that silently stops is worse than one that
  // says something is wrong.
  const app = mount();
  await settle();
  const status = app.doc.getElementById('status');
  assert.ok(!status.classList.contains('show'), 'hidden while healthy');

  app.push('degraded', { kind: 'holder-gate', detail: 'rpc failing' });
  assert.ok(status.classList.contains('show'));
  assert.match(status.textContent, /holder checks failing/);

  app.push('drift', { kind: 'new-fields', detail: 'changed' });
  assert.match(status.textContent, /upstream changed/);
  app.close();
});

test('?status=0 keeps the badge off the stream', async () => {
  const app = mount('?status=0');
  await settle();
  app.push('degraded', { kind: 'holder-gate', detail: 'rpc failing' });

  const status = app.doc.getElementById('status');
  assert.ok(!status.classList.contains('show'), 'opted out, so stay hidden');
  app.close();
});

test('losing the connection schedules a reconnect', async () => {
  const app = mount();
  await settle();
  const first = app.socket;
  first.close();

  assert.match(app.doc.getElementById('status').textContent, /disconnected/);
  await new Promise((r) => setTimeout(r, 1100)); // first backoff is 1s
  assert.notEqual(app.socket, first, 'a new socket must be created');
  app.close();
});


