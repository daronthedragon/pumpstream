import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, describeConfig, SCHEMA } from '../src/config.js';

/**
 * Four sources, and the order between them is the whole point: defaults, then
 * a config file, then the environment, then the command line.
 */

async function withDir(files, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pumpstream-cfg-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      await writeFile(path.join(dir, name), body);
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const load = (opts) => loadConfig({ argv: [], env: {}, cwd: tmpdir(), ...opts });

test('defaults apply when nothing else says otherwise', async () => {
  const { config, sources } = await load();
  assert.equal(config.port, 8787);
  assert.equal(config.holdersOnly, false);
  assert.equal(config.roster, true);
  assert.equal(config.host, '127.0.0.1', 'localhost by default, deliberately');
  assert.equal(sources.port, 'default');
});

test('a config file is picked up without being named', async () => {
  await withDir(
    { 'pumpstream.config.json': JSON.stringify({ port: 9000, holdersOnly: true }) },
    async (dir) => {
      const { config, sources, file } = await load({ cwd: dir });
      assert.equal(config.port, 9000);
      assert.equal(config.holdersOnly, true);
      assert.match(sources.port, /^file:/);
      assert.match(file, /pumpstream\.config\.json$/);
    }
  );
});

test('env beats the file, and a flag beats env', async () => {
  await withDir({ 'pumpstream.config.json': JSON.stringify({ port: 9000 }) }, async (dir) => {
    const viaEnv = await load({ cwd: dir, env: { PUMPSTREAM_PORT: '9100' } });
    assert.equal(viaEnv.config.port, 9100);
    assert.equal(viaEnv.sources.port, 'env:PUMPSTREAM_PORT');

    const viaFlag = await load({
      cwd: dir,
      env: { PUMPSTREAM_PORT: '9100' },
      argv: ['--port', '9200'],
    });
    assert.equal(viaFlag.config.port, 9200);
    assert.equal(viaFlag.sources.port, 'flag:--port');
  });
});

test('bare arguments are the mints, and beat every other source', async () => {
  await withDir({ 'pumpstream.config.json': JSON.stringify({ mints: ['FROMFILE'] }) }, async (dir) => {
    const fromFile = await load({ cwd: dir });
    assert.deepEqual(fromFile.config.mints, ['FROMFILE']);

    const typed = await load({ cwd: dir, argv: ['MINT_A', 'MINT_B,MINT_C', '--port', '9000'] });
    assert.deepEqual(typed.config.mints, ['MINT_A', 'MINT_B', 'MINT_C']);
    assert.equal(typed.sources.mints, 'argument');
    assert.equal(typed.config.port, 9000, 'a flag value is not mistaken for a mint');
  });
});

test('--no-<flag> turns a boolean off', async () => {
  const { config, sources } = await load({ argv: ['--no-roster'] });
  assert.equal(config.roster, false);
  assert.equal(sources.roster, 'flag:--roster');
});

test('booleans accept the usual spellings from env and file', async () => {
  for (const raw of ['1', 'true', 'yes', 'on']) {
    const { config } = await load({ env: { PUMPSTREAM_HOLDERS_ONLY: raw } });
    assert.equal(config.holdersOnly, true, `${raw} should be true`);
  }
  for (const raw of ['0', 'false', 'no', 'off']) {
    const { config } = await load({ env: { PUMPSTREAM_HOLDERS_ONLY: raw } });
    assert.equal(config.holdersOnly, false, `${raw} should be false`);
  }
});

test('a bad value is rejected with the key, the source and the value', async () => {
  await assert.rejects(
    () => load({ argv: ['--port', 'banana'] }),
    /port \(flag\): expected a number, got "banana"/
  );
  await assert.rejects(
    () => load({ argv: ['--port', '99999'] }),
    /must be at most 65535/
  );
  await assert.rejects(
    () => load({ env: { PUMPSTREAM_ROSTER_TTL_MS: '5' } }),
    /must be at least 1000/
  );
});

test('a flag with no value is an error, not a silent true', async () => {
  await assert.rejects(() => load({ argv: ['--port'] }), /--port needs a value/);
});

test('an unknown flag is reported rather than ignored', async () => {
  const { unknown } = await load({ argv: ['--holdrs-only', '--port', '9000'] });
  assert.deepEqual(unknown, ['holdrs-only'], 'a typo must not silently do nothing');
});

test('a named config file that does not exist is an error', async () => {
  await assert.rejects(
    () => load({ argv: ['--config', 'nope.json'] }),
    /config file not found: nope\.json/
  );
});

test('a malformed config file says so instead of being skipped', async () => {
  await withDir({ 'pumpstream.config.json': '{ not json' }, async (dir) => {
    await assert.rejects(() => load({ cwd: dir }), /not valid JSON/);
  });
});

test('overlay defaults come through as an object', async () => {
  await withDir(
    {
      'pumpstream.config.json': JSON.stringify({
        overlay: { preset: 'minimal', font: 26, alerts: true },
      }),
    },
    async (dir) => {
      const { config } = await load({ cwd: dir });
      assert.deepEqual(config.overlay, { preset: 'minimal', font: 26, alerts: true });
    }
  );

  // And as JSON from the environment, for a container.
  const { config } = await load({ env: { PUMPSTREAM_OVERLAY: '{"align":"right"}' } });
  assert.deepEqual(config.overlay, { align: 'right' });
});

test('a list can be given as a string or an array', async () => {
  const viaEnv = await load({ env: { PUMPSTREAM_MINTS: 'A, B ,C' } });
  assert.deepEqual(viaEnv.config.mints, ['A', 'B', 'C']);

  await withDir({ 'pumpstream.config.json': JSON.stringify({ mints: ['X', 'Y'] }) }, async (dir) => {
    const { config } = await load({ cwd: dir });
    assert.deepEqual(config.mints, ['X', 'Y']);
  });
});

test('every schema entry is reachable from at least one source', async () => {
  for (const [key, spec] of Object.entries(SCHEMA)) {
    assert.ok(spec.env || spec.flag, `${key} has no env var and no flag — it cannot be set`);
    assert.ok(spec.help, `${key} has no help text`);
  }
});

test('--print-config explains where each value came from', async () => {
  const { config, sources } = await load({
    argv: ['--port', '9000'],
    env: { PUMPSTREAM_HOLDERS_ONLY: 'true' },
  });
  const table = describeConfig(config, sources);
  assert.match(table, /port\s+9000\s+flag:--port/);
  assert.match(table, /holdersOnly\s+true\s+env:PUMPSTREAM_HOLDERS_ONLY/);
  assert.match(table, /roster\s+true$/m, 'defaults are shown with no source');
});
