import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

/**
 * The overlay builder at /overlay/config. It has to agree with what the server
 * already applies, or its controls quietly lie about what is in effect.
 */

const HTML = await readFile(
  fileURLToPath(new URL('../src/config.html', import.meta.url)),
  'utf8'
);

function mount(serverDefaults = null) {
  const html =
    serverDefaults === null
      ? HTML
      : HTML.replace(
          '<aside>',
          `<script>window.__pumpstreamDefaults=${JSON.stringify(serverDefaults)}</script>\n<aside>`
        );

  const copied = [];
  const dom = new JSDOM(html, {
    url: 'http://localhost:8787/overlay/config',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.navigator.clipboard = { writeText: async (t) => copied.push(t) };
    },
  });
  return {
    doc: dom.window.document,
    window: dom.window,
    copied,
    field: (key) =>
      [...dom.window.document.querySelectorAll('label')].find(
        (l) => l.querySelector('span')?.textContent === key
      ),
    close: () => dom.window.close(),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('with no server config the controls show the built-in defaults', async () => {
  const app = mount();
  await settle();
  const font = app.field('font').querySelector('input');
  assert.equal(font.value, '20');
  assert.equal(app.doc.getElementById('url').value, 'http://localhost:8787/overlay');
  app.close();
});

test('controls start where the server actually has them', async () => {
  const app = mount({ font: 26, alerts: true, align: 'right' });
  await settle();

  assert.equal(app.field('font').querySelector('input').value, '26');
  assert.equal(app.field('alerts').querySelector('input').checked, true);
  assert.equal(app.field('align').querySelector('select').value, 'right');
  app.close();
});

test('server-set options are marked so you can tell them apart', async () => {
  const app = mount({ font: 26 });
  await settle();
  const fontLabel = app.field('font').querySelector('span');
  const maxLabel = app.field('max').querySelector('span');
  assert.match(fontLabel.title, /server/i, 'the seeded one is flagged');
  assert.equal(maxLabel.title, '', 'an untouched one is not');
  app.close();
});

test('the copied URL carries what differs from the built-in defaults', async () => {
  const app = mount({ font: 26, alerts: true });
  await settle();
  const url = app.doc.getElementById('url').value;
  assert.match(url, /font=26/);
  assert.match(url, /alerts=(1|true)/);
  app.close();
});

test('Copy config emits a pasteable overlay block with real JSON types', async () => {
  const app = mount({ font: 26, alerts: true, align: 'right' });
  await settle();
  app.doc.getElementById('copycfg').click();
  await settle();

  assert.equal(app.copied.length, 1);
  const parsed = JSON.parse(app.copied[0]);
  assert.ok(parsed.overlay, 'shaped for pumpstream.config.json');
  assert.equal(parsed.overlay.font, 26);
  assert.equal(typeof parsed.overlay.font, 'number', 'a number, not "26"');
  assert.equal(parsed.overlay.alerts, true);
  assert.equal(typeof parsed.overlay.alerts, 'boolean', 'a boolean, not "true"');
  assert.equal(parsed.overlay.align, 'right');
  assert.equal(parsed.overlay.max, undefined, 'untouched options are left out');
  app.close();
});

test('Copy config on an untouched builder emits an empty block', async () => {
  const app = mount();
  await settle();
  app.doc.getElementById('copycfg').click();
  await settle();
  assert.deepEqual(JSON.parse(app.copied[0]), { overlay: {} });
  app.close();
});

test('the preview is pointed at the overlay with a backdrop', async () => {
  const app = mount({ font: 26 });
  await settle();
  await new Promise((r) => setTimeout(r, 200)); // the preview is debounced
  const src = app.doc.getElementById('preview').src;
  assert.match(src, /\/overlay\?/);
  assert.match(src, /demo=grid/, 'so transparency is visible rather than assumed');
  app.close();
});

test('every builder control maps to a real overlay option', async () => {
  // The builder is written by hand, so a typo here would silently produce a
  // URL parameter the overlay ignores.
  const overlay = await readFile(
    fileURLToPath(new URL('../src/overlay.html', import.meta.url)),
    'utf8'
  );
  const app = mount();
  await settle();

  const keys = [...app.doc.querySelectorAll('label > span:first-child')].map((s) => s.textContent);
  assert.ok(keys.length > 20, `expected a lot of controls, found ${keys.length}`);

  for (const key of keys) {
    const referenced =
      overlay.includes(`'${key}'`) || overlay.includes(`"${key}"`);
    assert.ok(referenced, `builder exposes "${key}" but the overlay never reads it`);
  }
  app.close();
});
