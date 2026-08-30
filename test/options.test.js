import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HTML = await readFile(
  fileURLToPath(new URL('../src/overlay.html', import.meta.url)),
  'utf8'
);

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
    get opt() {
      return dom.window.__pumpstream.opt;
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
  isModerator: false,
  replyTo: null,
  timestamp: '2026-08-08T18:23:01.144Z',
  ...over,
});

const settle = () => new Promise((r) => setTimeout(r, 10));

/* ── transparency ──────────────────────────────────────────────────────────
 * The one property OBS depends on. If any theme or preset ever paints the
 * page, it shows on stream as an opaque slab over the whole scene.
 */

const TRANSPARENT = ['transparent', 'rgba(0, 0, 0, 0)', ''];

const SURFACES = [
  '',
  '?preset=dark',
  '?preset=light',
  '?preset=minimal',
  '?preset=solid',
  '?preset=ghost',
  '?theme=light',
  '?theme=light&bubble=1',
  '?bubble=1&blur=0&shadow=0',
  '?preset=light&align=center&grow=down&radius=0',
];

for (const query of SURFACES) {
  test(`page stays transparent with "${query || '(defaults)'}"`, async () => {
    const app = mount(query);
    await settle();
    app.push('comment', comment());

    for (const el of [app.doc.documentElement, app.doc.body]) {
      const style = app.window.getComputedStyle(el);
      assert.ok(
        TRANSPARENT.includes(style.backgroundColor),
        `${el.tagName} must never paint a background, got "${style.backgroundColor}" for "${query}"`
      );
      assert.ok(
        ['none', ''].includes(style.backgroundImage),
        `${el.tagName} must not paint a background image, got "${style.backgroundImage}"`
      );
    }
    app.close();
  });
}

test('an opaque bubble does not become a full-page fill', async () => {
  const app = mount('?preset=solid');
  await settle();
  app.push('comment', comment());
  assert.ok(
    TRANSPARENT.includes(app.window.getComputedStyle(app.doc.body).backgroundColor)
  );
  assert.equal(app.doc.documentElement.style.getPropertyValue('--bubble-a'), '1');
  app.close();
});

test('the transparency rule is enforced with !important', async () => {
  // A preset or theme adding `body { background: ... }` later would silently
  // break every stream using this. Keep the guard in the stylesheet itself.
  assert.match(HTML, /background:\s*transparent\s*!important/);
});

/* ── toggles ──────────────────────────────────────────────────────────────*/

test('every visual element can be switched off', async () => {
  const app = mount('?avatars=0&balance=0&names=0&replies=0&badges=0');
  await settle();
  app.push('comment', comment({ isCreator: true, replyTo: { id: 'p', preview: 'x' } }));

  const msg = app.doc.querySelector('.msg');
  assert.equal(msg.querySelector('.avatar'), null, 'avatars off');
  assert.equal(msg.querySelector('.bal'), null, 'balance off');
  assert.equal(msg.querySelector('.name'), null, 'names off');
  assert.equal(msg.querySelector('.reply'), null, 'replies off');
  assert.equal(msg.querySelector('.tag'), null, 'badges off');
  // The message itself must survive having everything else stripped.
  assert.equal(msg.querySelector('.text').textContent, 'gm holders');
  app.close();
});

test('booleans accept 1/0, true/false, yes/no, on/off', async () => {
  for (const off of ['0', 'false', 'no', 'off', 'OFF']) {
    const app = mount(`?avatars=${off}`);
    await settle();
    app.push('comment', comment());
    assert.equal(app.doc.querySelector('.avatar'), null, `avatars=${off} should disable`);
    app.close();
  }
  for (const on of ['1', 'true', 'yes', 'on']) {
    const app = mount(`?avatars=${on}`);
    await settle();
    app.push('comment', comment());
    assert.ok(app.doc.querySelector('.avatar'), `avatars=${on} should enable`);
    app.close();
  }
});

test('a moderator badge reads mod, a creator badge reads dev', async () => {
  const app = mount();
  await settle();
  app.push('comment', comment({ isModerator: true }));
  assert.equal(app.doc.querySelector('.tag').textContent, 'mod');
  app.close();

  const dev = mount();
  await settle();
  dev.push('comment', comment({ isCreator: true, isModerator: true }));
  assert.equal(dev.doc.querySelector('.tag').textContent, 'dev', 'creator wins');
  dev.close();
});

test('timestamps are opt-in and render as HH:MM', async () => {
  const off = mount();
  await settle();
  off.push('comment', comment());
  assert.equal(off.doc.querySelector('.time'), null, 'off by default');
  off.close();

  const on = mount('?time=1');
  await settle();
  on.push('comment', comment());
  assert.match(on.doc.querySelector('.time').textContent, /^\d{2}:\d{2}$/);
  on.close();
});

test('holders and minbal filter on the client', async () => {
  const h = mount('?holders=1');
  await settle();
  h.push('comment', comment({ holder: false, balance: 0, text: 'non holder' }));
  h.push('comment', comment({ id: 'c2', holder: true, balance: 500, text: 'holder' }));
  assert.deepEqual(
    [...h.doc.querySelectorAll('.text')].map((t) => t.textContent),
    ['holder'],
    'holders=1 drops non-holders'
  );
  h.close();

  const m = mount('?minbal=1000');
  await settle();
  m.push('comment', comment({ balance: 999, text: 'dust' }));
  m.push('comment', comment({ id: 'c2', balance: 1000, text: 'enough' }));
  assert.deepEqual(
    [...m.doc.querySelectorAll('.text')].map((t) => t.textContent),
    ['enough'],
    'minbal excludes anything below the threshold'
  );
  m.close();
});

test('layout switches drive real computed style', async () => {
  const cases = [
    ['?align=left', 'alignItems', 'flex-start'],
    ['?align=right', 'alignItems', 'flex-end'],
    ['?align=center', 'alignItems', 'center'],
    ['?grow=down', 'justifyContent', 'flex-start'],
    ['?grow=up', 'justifyContent', 'flex-end'],
  ];
  for (const [query, prop, expected] of cases) {
    const app = mount(query);
    await settle();
    const feed = app.window.getComputedStyle(app.doc.getElementById('feed'));
    assert.equal(feed[prop], expected, `${query} -> ${prop}`);
    app.close();
  }
});

test('numeric options land in CSS variables', async () => {
  const app = mount('?font=28&gap=4&pad=40&width=50&radius=0&bar=6');
  await settle();
  const s = app.doc.documentElement.style;
  assert.equal(s.getPropertyValue('--font'), '28px');
  assert.equal(s.getPropertyValue('--gap'), '4px');
  assert.equal(s.getPropertyValue('--pad'), '40px');
  assert.equal(s.getPropertyValue('--maxw'), '50%');
  assert.equal(s.getPropertyValue('--radius'), '0px');
  assert.equal(s.getPropertyValue('--bar'), '6px');
  app.close();
});

test('out-of-range and junk values never produce broken CSS', async () => {
  const clamped = mount('?font=9999&max=0&bubble=5&width=-20');
  await settle();
  assert.equal(clamped.doc.documentElement.style.getPropertyValue('--font'), '96px');
  assert.equal(clamped.opt.max, 1, 'max clamps to at least 1');
  assert.equal(clamped.opt.bubble, 1);
  assert.equal(clamped.opt.width, 10);
  clamped.close();

  const junk = mount('?font=abc&max=nope&align=sideways&preset=nonsense');
  await settle();
  assert.equal(junk.opt.font, 20, 'junk falls back to the default');
  assert.equal(junk.opt.max, 8);
  assert.equal(junk.opt.align, 'left', 'unknown enum falls back');
  junk.close();
});

test('a colour that is not hex is rejected rather than injected into CSS', async () => {
  const bad = mount('?accent=red;background:url(http://evil/x)');
  await settle();
  assert.equal(
    bad.doc.documentElement.style.getPropertyValue('--accent'),
    '#7ee787',
    'a non-hex accent must fall back to the default'
  );
  bad.close();

  const good = mount('?accent=ff0000');
  await settle();
  assert.equal(
    good.doc.documentElement.style.getPropertyValue('--accent'),
    '#ff0000',
    'a bare hex without a hash is accepted'
  );
  good.close();
});

test('presets set defaults but explicit parameters still win', async () => {
  const p = mount('?preset=minimal');
  await settle();
  assert.equal(p.opt.bubble, 0, 'minimal removes the bubble');
  assert.equal(p.opt.avatars, false);
  assert.ok(p.doc.body.classList.contains('no-bubble'));
  p.close();

  const override = mount('?preset=minimal&avatars=1&bubble=0.9');
  await settle();
  assert.equal(override.opt.avatars, true, 'explicit beats preset');
  assert.equal(override.opt.bubble, 0.9);
  assert.ok(!override.doc.body.classList.contains('no-bubble'));
  override.close();
});

test('switching effects off adds the classes that disable them', async () => {
  const app = mount('?shadow=0&blur=0&anim=0&bar=0');
  await settle();
  const cl = app.doc.body.classList;
  for (const c of ['no-shadow', 'no-blur', 'no-anim', 'no-bar']) {
    assert.ok(cl.contains(c), `expected body.${c}`);
  }
  app.close();
});

test('replay and mint preferences are sent to the server', async () => {
  const app = mount('?replay=25&mint=ABC');
  await settle();
  assert.match(app.socket.url, /replay=25/);
  assert.match(app.socket.url, /mint=ABC/);
  app.close();
});

/* ── preview backdrop ─────────────────────────────────────────────────────
 * ?demo exists so the overlay can be judged in a normal browser. It must
 * never be able to compromise the OBS transparency guarantee.
 */

test('no backdrop element exists unless demo is asked for', async () => {
  const app = mount();
  await settle();
  assert.equal(app.doc.getElementById('demo'), null);
  app.close();
});

test('demo paints its own element, never html or body', async () => {
  for (const kind of ['grid', 'scene']) {
    const app = mount(`?demo=${kind}`);
    await settle();
    const el = app.doc.getElementById('demo');
    assert.ok(el, `demo=${kind} should insert a backdrop element`);
    assert.ok(el.classList.contains(kind));

    // The guarantee: even with a backdrop showing, the page stays transparent.
    for (const node of [app.doc.documentElement, app.doc.body]) {
      const style = app.window.getComputedStyle(node);
      assert.ok(
        TRANSPARENT.includes(style.backgroundColor),
        `${node.tagName} painted "${style.backgroundColor}" with demo=${kind}`
      );
      assert.ok(['none', ''].includes(style.backgroundImage));
    }
    // It sits behind the chat, not over it.
    assert.equal(app.window.getComputedStyle(el).zIndex, '-1');
    app.close();
  }
});

test('an unknown demo value is ignored', async () => {
  const app = mount('?demo=url(http://evil/x)');
  await settle();
  assert.equal(app.doc.getElementById('demo'), null, 'only known kinds are honoured');
  app.close();
});

/* ── word filter ──────────────────────────────────────────────────────────
 * Off by default: rewriting someone's chat must be a deliberate choice.
 */

test('chat is never altered unless censoring is asked for', async () => {
  const app = mount();
  await settle();
  app.push('comment', comment({ text: 'this shit is going up' }));
  assert.equal(app.doc.querySelector('.text').textContent, 'this shit is going up');
  app.close();
});

test('censor=mask stars out the word but keeps the message', async () => {
  const app = mount('?censor=mask');
  await settle();
  app.push('comment', comment({ text: 'this shit is going up' }));
  assert.equal(app.doc.querySelector('.text').textContent, 'this s*** is going up');
  app.close();
});

test('censor=1 is accepted as mask', async () => {
  const app = mount('?censor=1');
  await settle();
  app.push('comment', comment({ text: 'holy shit' }));
  assert.equal(app.doc.querySelector('.text').textContent, 'holy s***');
  app.close();
});

test('censor=drop hides the whole comment', async () => {
  const app = mount('?censor=drop');
  await settle();
  app.push('comment', comment({ text: 'this shit is going up' }));
  app.push('comment', comment({ id: 'c2', text: 'clean message' }));
  assert.deepEqual(
    [...app.doc.querySelectorAll('.text')].map((t) => t.textContent),
    ['clean message']
  );
  app.close();
});

test('suffixes are caught but innocent words are left alone', async () => {
  const app = mount('?censor=mask');
  await settle();
  // "class" and "assist" contain a blocked stem but are not matches.
  app.push('comment', comment({ text: 'the classic assist was a fucking masterclass' }));
  assert.equal(
    app.doc.querySelector('.text').textContent,
    'the classic assist was a f****** masterclass'
  );
  app.close();
});

test('block= adds custom terms, and they can be dropped too', async () => {
  const app = mount('?censor=mask&block=scam,rugpull');
  await settle();
  app.push('comment', comment({ text: 'this is a scam and a rugpull' }));
  assert.equal(app.doc.querySelector('.text').textContent, 'this is a s*** and a r******');
  app.close();

  const dropped = mount('?censor=drop&block=airdrop');
  await settle();
  dropped.push('comment', comment({ text: 'when airdrop' }));
  dropped.push('comment', comment({ id: 'c2', text: 'gm' }));
  assert.deepEqual(
    [...dropped.doc.querySelectorAll('.text')].map((t) => t.textContent),
    ['gm']
  );
  dropped.close();
});

test('a custom block term containing regex characters cannot break the filter', async () => {
  const app = mount('?censor=mask&block=' + encodeURIComponent('a(b'));
  await settle();
  app.push('comment', comment({ text: 'harmless message' }));
  assert.equal(
    app.doc.querySelector('.text').textContent,
    'harmless message',
    'a malformed term must not throw or swallow the message'
  );
  app.close();
});

/* ── buy / sell alerts in the overlay ─────────────────────────────────────*/

const change = (over = {}) => ({
  mint: 'mint1', type: 'buy', first: false, exit: false,
  owner: 'FYNWkGx9f1PLtdtvVw3bnty5bDbGKZ3UirJMcU25VX7c',
  before: 100, after: 1600, delta: 1500, rank: 12, share: 0.01, ...over,
});

test('alerts are off by default, so an existing overlay is unchanged', async () => {
  const app = mount();
  await settle();
  app.push('holderChange', change());
  assert.equal(app.doc.querySelector('.alert'), null);
  app.close();
});

test('a buy and a sell render distinguishably without relying on colour', async () => {
  const app = mount('?alerts=1');
  await settle();
  app.push('holderChange', change());
  app.push('holderChange', change({ type: 'sell', delta: -2500, after: 0 }));

  const alerts = [...app.doc.querySelectorAll('.alert')];
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].querySelector('.arrow').textContent, '▲');
  assert.equal(alerts[0].querySelector('.amount').textContent, '+1.5K');
  assert.ok(alerts[1].classList.contains('sell'));
  assert.equal(alerts[1].querySelector('.arrow').textContent, '▼');
  assert.equal(alerts[1].querySelector('.amount').textContent, '−2.5K');
  app.close();
});

test('new holders and full exits are labelled', async () => {
  const app = mount('?alerts=1');
  await settle();
  app.push('holderChange', change({ first: true, before: 0 }));
  app.push('holderChange', change({ type: 'sell', exit: true, after: 0, delta: -900 }));

  const labels = [...app.doc.querySelectorAll('.alert .label')].map((l) => l.textContent);
  assert.deepEqual(labels, ['new holder', 'exit']);
  app.close();
});

test('the wallet is shortened, never shown in full', async () => {
  const app = mount('?alerts=1');
  await settle();
  app.push('holderChange', change());
  const who = app.doc.querySelector('.alert .who').textContent;
  assert.equal(who, 'FYNW…VX7c', 'first four, last four');
  assert.ok(who.length < 20, 'a full pubkey would blow the layout out');
  app.close();
});

test('alertmin hides small movement', async () => {
  const app = mount('?alerts=1&alertmin=1000');
  await settle();
  app.push('holderChange', change({ delta: 500 }));
  app.push('holderChange', change({ delta: -5000, type: 'sell' }));
  const amounts = [...app.doc.querySelectorAll('.alert .amount')].map((a) => a.textContent);
  assert.deepEqual(amounts, ['−5K'], 'only the big move survived');
  app.close();
});

test('alerts share the trim budget with comments', async () => {
  const app = mount('?alerts=1&max=3');
  await settle();
  for (let i = 0; i < 4; i++) app.push('comment', comment({ id: 'c' + i, text: 'm' + i }));
  for (let i = 0; i < 4; i++) app.push('holderChange', change({ delta: 100 + i }));
  await settle();

  const live = [...app.doc.querySelectorAll('.msg')].filter(
    (m) => !m.classList.contains('leaving')
  );
  assert.equal(live.length, 3, 'one feed, one max');
  app.close();
});

test('an alert never injects markup', async () => {
  const app = mount('?alerts=1');
  await settle();
  app.push('holderChange', change({ owner: '<img src=x onerror=alert(1)>abcd' }));
  const who = app.doc.querySelector('.alert .who');
  assert.equal(who.querySelector('img'), null);
  assert.match(who.textContent, /^<img…/);
  app.close();
});

/* ── server-supplied overlay defaults ─────────────────────────────────────
 * A streamer sets their look once in the config file instead of in every
 * query string. A query parameter still wins, so a second browser source can
 * differ from the first.
 */

function mountWithServer(defaults, query = '') {
  const injected = HTML.replace(
    '<div id="feed"></div>',
    `<script>window.__pumpstreamDefaults=${JSON.stringify(defaults)}</script>\n<div id="feed"></div>`
  );
  let socket;
  const dom = new JSDOM(injected, {
    url: `http://localhost:8787/overlay${query}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.WebSocket = class {
        constructor(url) { this.url = url; socket = this; setTimeout(() => this.onopen?.(), 0); }
        close() { this.onclose?.(); }
      };
    },
  });
  return {
    doc: dom.window.document,
    window: dom.window,
    opt: () => dom.window.__pumpstream.opt,
    push: (type, data) => socket.onmessage({ data: JSON.stringify({ type, data }) }),
    close: () => dom.window.close(),
  };
}

test('server defaults apply with no query string at all', async () => {
  const app = mountWithServer({ font: 26, alerts: true, align: 'right', accent: 'ffd479' });
  await settle();
  assert.equal(app.opt().font, 26);
  assert.equal(app.opt().alerts, true);
  assert.equal(app.opt().align, 'right');
  assert.equal(app.doc.documentElement.style.getPropertyValue('--accent'), '#ffd479');
  assert.ok(app.doc.body.classList.contains('align-right'));
  app.close();
});

test('a query parameter still beats a server default', async () => {
  const app = mountWithServer({ font: 26, align: 'right' }, '?font=12&align=left');
  await settle();
  assert.equal(app.opt().font, 12, 'the URL wins');
  assert.equal(app.opt().align, 'left');
  app.close();
});

test('a server default is validated exactly like a query parameter', async () => {
  // Nothing from the server is trusted straight into CSS either.
  const app = mountWithServer({ accent: 'red;background:url(http://evil/x)', font: 9999 });
  await settle();
  assert.equal(app.doc.documentElement.style.getPropertyValue('--accent'), '#7ee787');
  assert.equal(app.opt().font, 96, 'still clamped');
  app.close();
});

test('a server preset can be overridden per source', async () => {
  const app = mountWithServer({ preset: 'minimal' }, '?bubble=0.9&avatars=1');
  await settle();
  assert.equal(app.opt().bubble, 0.9);
  assert.equal(app.opt().avatars, true);
  app.close();
});

test('with no server defaults the overlay behaves exactly as before', async () => {
  const app = mountWithServer({});
  await settle();
  assert.equal(app.opt().font, 20);
  assert.equal(app.opt().alerts, false);
  app.close();
});

test('real JSON types from a config file are handled, not just strings', async () => {
  // Regression: a query string is always text, so `bool()` assumed a string
  // and threw on the real booleans a JSON config file produces.
  const app = mountWithServer({ alerts: true, avatars: false, font: 24, ranktop: 5 });
  await settle();
  assert.equal(app.opt().alerts, true);
  assert.equal(app.opt().avatars, false);
  assert.equal(app.opt().font, 24);
  assert.equal(app.opt().ranktop, 5);
  app.close();
});
