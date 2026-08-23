import test from 'node:test';
import assert from 'node:assert/strict';
import { PumpComments } from '../src/index.js';

/**
 * Commands are the "drive my game from chat" primitive. They ride on the same
 * gate as comments, so a holders-only feed yields holders-only commands.
 *
 * Everything here goes through `ingest()`, which is the exact path a live
 * message takes minus the socket.
 */

let seq = 0;
const msg = (message, over = {}) => ({
  id: `m${++seq}`,
  roomId: 'mint1',
  username: 'holder1',
  userAddress: 'W1',
  message,
  timestamp: '2026-08-08T18:23:01.144Z',
  messageType: 'REGULAR',
  ...over,
});

function feed(opts = {}) {
  const f = new PumpComments({ mint: 'mint1', ...opts });
  f.on('error', () => {});
  f.on('drift', () => {});
  // No RPC in unit tests: everyone holds unless a test says otherwise.
  f.gates.get('mint1').check = async () => ({ holder: true, balance: 100 });
  return f;
}

test('a holder typing !vote emits a command with args', async () => {
  const f = feed();
  const got = [];
  f.on('command', (c) => got.push(c));

  await f.ingest(msg('!vote blue please'));

  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'vote');
  assert.deepEqual(got[0].args, ['blue', 'please']);
  assert.equal(got[0].text, 'blue please');
  assert.equal(got[0].author, 'W1');
  assert.equal(got[0].comment.text, '!vote blue please', 'the comment is attached');
  f.stop();
});

test('a command with no arguments still fires', async () => {
  const f = feed();
  const got = [];
  f.on('command', (c) => got.push(c));

  await f.ingest(msg('!skip'));

  assert.equal(got[0].name, 'skip');
  assert.deepEqual(got[0].args, []);
  assert.equal(got[0].text, '');
  f.stop();
});

test('a plain comment is not a command', async () => {
  const f = feed();
  const got = [];
  f.on('command', (c) => got.push(c));

  await f.ingest(msg('gm holders'));
  assert.equal(got.length, 0);
  f.stop();
});

test('replayed history never re-fires commands', async () => {
  // OBS reloads browser sources constantly. Re-running every buffered
  // !command on each reconnect would be chaos in a game.
  const f = feed();
  const got = [];
  f.on('command', (c) => got.push(c));

  await f.ingest(msg('!spawn boss'), { historical: true });
  assert.equal(got.length, 0, 'history must not trigger commands');

  await f.ingest(msg('!spawn boss'));
  assert.equal(got.length, 1, 'the live one still fires');
  f.stop();
});

test('commands respect holdersOnly, and carry stake', async () => {
  const f = feed({ holdersOnly: true });
  f.gates.get('mint1').check = async (w) =>
    w === 'W1' ? { holder: true, balance: 4200 } : { holder: false, balance: 0 };

  const got = [];
  f.on('command', (c) => got.push(c));

  await f.ingest(msg('!vote yes', { userAddress: 'W2' }));
  await f.ingest(msg('!vote no', { userAddress: 'W1' }));

  assert.deepEqual(got.map((c) => c.text), ['no'], 'only the holder got through');
  assert.equal(got[0].balance, 4200, 'stake is carried so a game can weight it');
  f.stop();
});

test('the prefix is configurable, and empty disables commands', async () => {
  const slash = feed({ commandPrefix: '/' });
  const a = [];
  slash.on('command', (c) => a.push(c.name));
  await slash.ingest(msg('/attack'));
  await slash.ingest(msg('!attack'));
  assert.deepEqual(a, ['attack'], 'only the configured prefix counts');
  slash.stop();

  const off = feed({ commandPrefix: '' });
  const b = [];
  off.on('command', (c) => b.push(c));
  await off.ingest(msg('!attack'));
  assert.equal(b.length, 0, 'empty prefix disables commands entirely');
  off.stop();
});

test('malformed commands are ignored rather than emitted', async () => {
  const f = feed();
  const got = [];
  f.on('command', (c) => got.push(c));

  for (const text of ['!', '!  ', '!@#$', '! spaced', '!!', '!' + 'x'.repeat(40)]) {
    await f.ingest(msg(text));
  }
  assert.equal(
    got.length,
    0,
    `expected none, got ${JSON.stringify(got.map((c) => c.name))}`
  );
  f.stop();
});

test('command names are lowercased', async () => {
  const f = feed();
  const got = [];
  f.on('command', (c) => got.push(c.name));

  await f.ingest(msg('!SHOUT hello'));
  assert.deepEqual(got, ['shout']);
  f.stop();
});

test('a command is still delivered as a comment', async () => {
  const f = feed();
  const comments = [];
  f.on('comment', (c) => comments.push(c.text));
  f.on('command', () => {});

  await f.ingest(msg('just talking'));
  await f.ingest(msg('!go'));

  assert.deepEqual(comments, ['just talking', '!go'], 'the overlay still shows it');
  assert.equal(f.stats.comments, 2);
  assert.equal(f.stats.commands, 1);
  f.stop();
});

test('command text is not trusted — it is raw chat', async () => {
  const f = feed();
  const got = [];
  f.on('command', (c) => got.push(c));

  await f.ingest(msg('!say <img src=x onerror=alert(1)>'));

  assert.equal(got[0].name, 'say');
  assert.equal(
    got[0].text,
    '<img src=x onerror=alert(1)>',
    'passed through verbatim; consumers must escape it themselves'
  );
  f.stop();
});

/* ── multi-mint ───────────────────────────────────────────────────────────*/

test('one feed can follow several mints and tags each event', async () => {
  const f = new PumpComments({ mints: ['mintA', 'mintB'] });
  f.on('error', () => {});
  for (const g of f.gates.values()) g.check = async () => ({ holder: true, balance: 1 });

  const seen = [];
  f.on('comment', (c) => seen.push([c.mint, c.text]));

  await f.ingest({ ...msg('from A'), roomId: 'mintA' });
  await f.ingest({ ...msg('from B'), roomId: 'mintB' });

  assert.deepEqual(seen, [['mintA', 'from A'], ['mintB', 'from B']]);
  assert.equal(f.gates.size, 2, 'each mint gets its own holder gate');
  f.stop();
});
