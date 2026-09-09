import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

/**
 * The top-holders widget at /overlay/leaderboard. It polls /holders rather
 * than holding a socket open, because a leaderboard changes on the roster's
 * schedule, not chat's.
 */

const HTML = await readFile(
  fileURLToPath(new URL('../src/leaderboard.html', import.meta.url)),
  'utf8'
);

const holder = (rank, over = {}) => ({
  owner: 'W'.repeat(6) + rank + 'xxxx',
  balance: 1_000_000 / rank,
  rank,
  share: 0.4 / rank,
  ...over,
});

function mount(query = '', payload = null, serverDefaults = null) {
  const html =
    serverDefaults === null
      ? HTML
      : HTML.replace(
          '<div id="board"></div>',
          `<script>window.__pumpstreamDefaults=${JSON.stringify(serverDefaults)}</script>\n<div id="board"></div>`
        );

  const requests = [];
  const dom = new JSDOM(html, {
    url: `http://localhost:8787/overlay/leaderboard${query}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async (url) => {
        requests.push(String(url));
        const body = payload ?? {
          mint: 'mint1',
          holders: 3,
          supply: 1_000_000,
          rosterAvailable: true,
          top: [holder(1), holder(2), holder(3)],
        };
        return { ok: true, status: 200, json: async () => body };
      };
    },
  });
  return {
    doc: dom.window.document,
    window: dom.window,
    requests,
    board: () => dom.window.__pumpstreamBoard,
    rows: () => [...dom.window.document.querySelectorAll('.row')],
    close: () => dom.window.close(),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 25));

test('the page never paints a background, in either theme', async () => {
  for (const query of ['', '?theme=light', '?bubble=1', '?demo=scene']) {
    const app = mount(query);
    await settle();
    for (const el of [app.doc.documentElement, app.doc.body]) {
      const bg = app.window.getComputedStyle(el).backgroundColor;
      assert.ok(
        ['transparent', 'rgba(0, 0, 0, 0)', ''].includes(bg),
        `${el.tagName} painted "${bg}" for "${query}"`
      );
    }
    app.close();
  }
});

test('it renders a row per holder, ranked', async () => {
  const app = mount();
  await settle();
  const rows = app.rows();
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.querySelector('.rank').textContent),
    ['#1', '#2', '#3']
  );
  assert.equal(app.doc.querySelector('h1').textContent, 'Top holders');
  app.close();
});

test('it asks for exactly as many holders as it shows', async () => {
  const app = mount('?top=25');
  await settle();
  assert.match(app.requests[0], /\/holders\?limit=25/);
  app.close();
});

test('a named wallet shows its name, an unknown one shows a short address', async () => {
  const app = mount('', {
    rosterAvailable: true,
    top: [holder(1, { username: 'poshcrab72329' }), holder(2)],
  });
  await settle();
  const [named, anon] = app.rows();
  assert.equal(named.querySelector('.who').textContent, 'poshcrab72329');
  assert.ok(!named.querySelector('.who').classList.contains('anon'));
  assert.match(anon.querySelector('.who').textContent, /^WWWW…xxxx$/, 'first four, last four');
  assert.ok(anon.querySelector('.who').classList.contains('anon'));
  app.close();
});

test('a username is text, never markup', async () => {
  const app = mount('', {
    rosterAvailable: true,
    top: [holder(1, { username: '<img src=x onerror=alert(1)>' })],
  });
  await settle();
  const who = app.doc.querySelector('.who');
  assert.equal(who.querySelector('img'), null);
  assert.equal(who.textContent, '<img src=x onerror=alert(1)>');
  app.close();
});

test('share bars are drawn relative to the biggest holder', async () => {
  // Absolute share makes every bar invisible when one wallet owns most of it.
  const app = mount('', {
    rosterAvailable: true,
    top: [holder(1, { share: 0.5 }), holder(2, { share: 0.25 })],
  });
  await settle();
  const bars = [...app.doc.querySelectorAll('.bar')];
  // The browser normalises "100.0%" to "100%".
  assert.equal(parseFloat(bars[0].style.width), 100);
  assert.equal(parseFloat(bars[1].style.width), 50);
  app.close();
});

test('movement between polls is shown with a direction, not just colour', async () => {
  const app = mount('', {
    rosterAvailable: true,
    top: [holder(1, { owner: 'A' }), holder(2, { owner: 'B' })],
  });
  await settle();
  // First render has no history, so nothing is marked as moved.
  assert.deepEqual(
    app.rows().map((r) => r.querySelector('.move').textContent),
    ['', '']
  );

  // B overtakes A.
  app.board().render({
    top: [
      { owner: 'B', balance: 5, rank: 1, share: 0.5 },
      { owner: 'A', balance: 4, rank: 2, share: 0.4 },
    ],
  });
  const moves = app.rows().map((r) => r.querySelector('.move'));
  assert.equal(moves[0].textContent, '▲1');
  assert.ok(moves[0].classList.contains('up'));
  assert.equal(moves[1].textContent, '▼1');
  assert.ok(moves[1].classList.contains('down'));
  app.close();
});

test('a wallet appearing later is marked new, not on the first render', async () => {
  const app = mount('', { rosterAvailable: true, top: [holder(1, { owner: 'A' })] });
  await settle();
  assert.equal(app.rows()[0].querySelector('.move').textContent, '', 'no history yet');

  app.board().render({
    top: [
      { owner: 'A', balance: 5, rank: 1, share: 0.5 },
      { owner: 'NEWCOMER', balance: 4, rank: 2, share: 0.4 },
    ],
  });
  assert.equal(app.rows()[1].querySelector('.move').textContent, 'new');
  app.close();
});

test('every element can be switched off', async () => {
  const app = mount('?names=0&avatars=0&share=0&bars=0&movement=0&title=');
  await settle();
  const row = app.rows()[0];
  assert.equal(app.doc.querySelector('h1'), null, 'an empty title adds no heading');
  assert.equal(row.querySelector('.share'), null);
  assert.equal(row.querySelector('.bar'), null);
  assert.equal(row.querySelector('.move'), null);
  assert.equal(row.querySelector('.avatar'), null);
  // The essentials survive.
  assert.ok(row.querySelector('.rank'));
  assert.ok(row.querySelector('.amount'));
  app.close();
});

test('server defaults apply, and a query parameter still wins', async () => {
  const seeded = mount('', null, { font: 28, top: 5, align: 'right' });
  await settle();
  assert.equal(seeded.board().opt.font, 28);
  assert.equal(seeded.board().opt.top, 5);
  assert.ok(seeded.doc.body.classList.contains('align-right'));
  seeded.close();

  const overridden = mount('?font=14', null, { font: 28 });
  await settle();
  assert.equal(overridden.board().opt.font, 14);
  overridden.close();
});

test('no roster means a clear message rather than an empty board', async () => {
  const app = mount('', { rosterAvailable: false, top: [] });
  await settle();
  assert.equal(app.rows().length, 0);
  assert.match(app.doc.getElementById('status').textContent, /no holder roster/);
  assert.ok(app.doc.getElementById('status').classList.contains('show'));
  app.close();
});

test('a colour that is not hex is rejected rather than injected', async () => {
  const app = mount('?accent=red;background:url(http://evil/x)');
  await settle();
  assert.equal(app.doc.documentElement.style.getPropertyValue('--accent'), '#7ee787');
  app.close();
});
