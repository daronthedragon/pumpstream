import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScene } from '../src/obs.js';

/**
 * The importable OBS scene. Verified by importing generated files into real
 * OBS 31 and screenshotting the result, which is how both bugs below were
 * found — neither showed up as a bad JSON shape.
 */

const scene = (opts = {}) => buildScene({ base: 'http://127.0.0.1:8787', ...opts });

const sources = (s) => s.sources.filter((x) => x.id === 'browser_source');
const items = (s) => s.sources.find((x) => x.id === 'scene').settings.items;
const sized = (s, name) => s.sources.find((x) => x.name === name).settings;

test('it produces a collection OBS recognises', () => {
  const s = scene();
  assert.equal(s.version, 2);
  assert.equal(s.current_scene, 'pumpstream');
  assert.equal(s.current_program_scene, 'pumpstream');
  assert.deepEqual(s.scene_order, [{ name: 'pumpstream' }]);
  // A collection missing these gets silently "repaired" on load.
  for (const key of ['groups', 'transitions', 'saved_projectors', 'canvases', 'modules']) {
    assert.ok(key in s, `missing ${key}`);
  }
});

test('both browser sources point at this server', () => {
  const s = scene();
  const urls = sources(s).map((x) => x.settings.url);
  assert.equal(urls.length, 2);
  assert.ok(urls.some((u) => u.startsWith('http://127.0.0.1:8787/overlay?')), urls.join(' '));
  assert.ok(urls.some((u) => u.includes('/overlay/leaderboard')), urls.join(' '));
});

test('every source is transparent out of the box', () => {
  for (const src of sources(scene())) {
    assert.match(
      src.settings.css,
      /background-color:\s*rgba\(0,\s*0,\s*0,\s*0\)/,
      `${src.name} would render an opaque slab over the scene`
    );
  }
});

test('scale_ref is the canvas, not the source', () => {
  // Regression, found by importing into OBS: setting scale_ref to the source
  // size made OBS believe the canvas was 410x396 and scale the browser source
  // up ~3x — text enormous, every name truncated.
  const s = scene({ width: 1280, height: 720 });
  for (const item of items(s)) {
    assert.deepEqual(
      item.scale_ref,
      { x: 1280, y: 720 },
      `${item.name} scale_ref must be the canvas`
    );
    assert.deepEqual(item.scale, { x: 1.0, y: 1.0 }, 'and the scale itself 1:1');
  }
});

for (const [width, height] of [
  [1280, 720],
  [1920, 1080],
  [2560, 1440],
  [3840, 2160],
]) {
  test(`every source lands on screen at ${width}x${height}`, () => {
    // Regression: the endpoint defaulted to 1920x1080 while OBS takes the
    // canvas from the *profile*, so on a 1280-wide canvas the leaderboard was
    // positioned at x=1383 — entirely off the right edge.
    const s = scene({ width, height });
    for (const item of items(s)) {
      const { width: w, height: h } = sized(s, item.name);
      assert.ok(item.pos.x >= 0 && item.pos.y >= 0, `${item.name} starts off-canvas`);
      assert.ok(
        item.pos.x + w <= width,
        `${item.name} runs off the right: ${item.pos.x}+${w} > ${width}`
      );
      assert.ok(
        item.pos.y + h <= height,
        `${item.name} runs off the bottom: ${item.pos.y}+${h} > ${height}`
      );
    }
  });
}

test('the two sources do not overlap', () => {
  const s = scene({ width: 1920, height: 1080 });
  const boxes = items(s).map((it) => {
    const { width: w, height: h } = sized(s, it.name);
    return { x1: it.pos.x, y1: it.pos.y, x2: it.pos.x + w, y2: it.pos.y + h };
  });
  const [a, b] = boxes;
  const overlaps = a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
  assert.equal(overlaps, false, 'chat and leaderboard would sit on top of each other');
});

test('font size follows the canvas', () => {
  // A fixed size truncates every name at 720p and looks like a postage stamp
  // at 4K, so it is derived from the canvas height.
  const small = scene({ width: 1280, height: 720 });
  const big = scene({ width: 3840, height: 2160 });

  const fontOf = (s, part) => {
    const url = sources(s).find((x) => x.settings.url.includes(part)).settings.url;
    return Number(new URL(url).searchParams.get('font'));
  };

  assert.ok(fontOf(small, '/overlay?') < fontOf(big, '/overlay?'), 'chat scales');
  assert.ok(fontOf(small, 'leaderboard') < fontOf(big, 'leaderboard'), 'board scales');
  assert.ok(fontOf(small, '/overlay?') >= 10, 'never unreadably small');
});

test('configured overlay defaults are baked into the URL, and win over the derived font', () => {
  const s = scene({ overlay: { preset: 'minimal', alerts: true, font: 40 } });
  const url = new URL(sources(s).find((x) => x.settings.url.includes('/overlay?')).settings.url);
  assert.equal(url.searchParams.get('preset'), 'minimal');
  assert.equal(url.searchParams.get('alerts'), '1', 'booleans are written as 1/0');
  assert.equal(url.searchParams.get('font'), '40', 'an explicit font beats the derived one');
});

test('each build gets fresh uuids, so importing twice does not collide', () => {
  const a = scene();
  const b = scene();
  const ids = (s) => s.sources.map((x) => x.uuid);
  assert.equal(new Set([...ids(a), ...ids(b)]).size, 6, 'all six are distinct');
});

test('scene items reference their source by uuid', () => {
  const s = scene();
  const byName = new Map(s.sources.map((x) => [x.name, x.uuid]));
  for (const item of items(s)) {
    assert.equal(item.source_uuid, byName.get(item.name), `${item.name} points elsewhere`);
    assert.equal(item.visible, true);
  }
});
