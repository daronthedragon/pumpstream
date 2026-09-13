/**
 * A synthetic pump.fun, so nothing is blocked on finding a busy live token.
 *
 * Setting up OBS, positioning sources, tuning the overlay, or judging whether
 * this project is worth using all used to require a real mint with real chat
 * happening right now. That is a bad precondition for every one of those jobs.
 *
 * This drives the REAL pipeline: messages go through `feed.ingest()`, so they
 * are normalised, deduped, gated, turned into commands and rendered exactly as
 * live traffic is. Balances go through `gate.applyBalances()`, so ranks, share
 * and the buy/sell diff are the same code too. Nothing here reimplements the
 * product — it only supplies the input, and makes no network calls at all.
 */

// Shaped like real pump.fun handles, and deliberately longer than the speaker
// list: with 22 speakers and 20 names the fallback produced 'poshcrab723292'
// beside 'poshcrab72329', so a whale and a non-holder still read as one person.
const NAMES = [
  'poshcrab72329', 'fawkinsends', 'idekkkkkkkkkk', 'lazyorca26889', 'tumors',
  'DonkeyDonki', 'wrylobster64739', 'Chinogordo', 'meredolphin0639', 'sumsum85',
  'AkaDeekae1', 'projeeterbob', 'soresharking', 'futurehive', 'twinotter08507',
  'goldolphin4534', 'alertkraken6489', 'busycrab72253', 'Hendrixonchain', 'Marson',
  'zoomerbaghold', 'nervousmoose11', 'Tendiesblanco', 'kwikflipkid', 'oiledsardine',
  'MrExitLiquidity', 'gm_only_gm', 'slowrugwatcher', 'velvetgoblin8', 'JPEGjanitor',
  'roundtripjeet', 'candlewicky', 'feralbagholder', 'onlyupsteve', 'quietwhale404',
];

const LINES = [
  'gm holders', 'lets go', 'this is going to millions', 'holding forever',
  'when airdrop', 'dev based', 'chart looking clean', 'wen moon',
  'just bought more', 'top 100 holder here', 'send it', 'we early af',
  'been here since 30k', 'volume picking up', 'diamond hands only',
  'who else holding', 'lfg', 'bullish', 'this chart is beautiful',
  'i am never selling', 'up only from here', 'accumulating quietly',
];

const COMMANDS = ['!vote blue', '!vote red', '!spawn boss', '!skip', '!hype'];

/** Deterministic PRNG, so a demo run can be reproduced exactly. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0xffffffff;
  };
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** A plausible-looking wallet. Not a real key, and never used as one. */
function fakeWallet(rand) {
  let out = '';
  for (let i = 0; i < 43; i++) out += B58[Math.floor(rand() * B58.length)];
  return out;
}

/**
 * @param {import('./index.js').PumpComments} feed
 * @param {object} [opts]
 * @param {number} [opts.holders]   how many synthetic holders to invent
 * @param {number} [opts.rate]      comments per minute
 * @param {number} [opts.churn]     balance moves per roster tick
 * @param {number} [opts.seed]      PRNG seed, for a reproducible run
 * @returns {{stop: () => void, wallets: string[]}}
 */
export function installDemo(feed, { holders = 60, rate = 40, churn = 4, seed = 7 } = {}) {
  const rand = rng(seed);
  const mint = feed.mints[0];
  const gate = feed.gates.get(mint);

  // Shaped to match what real pump.fun tokens actually look like: the top
  // wallet measured 23-33% of supply on live tokens, not 80%. A demo used for
  // tuning a layout has to produce numbers the layout will really face.
  const wallets = Array.from({ length: holders }, () => fakeWallet(rand));
  const balances = new Map();
  wallets.forEach((w, i) => {
    const scale = i === 0 ? 30_000_000 : 40_000_000 / (i + 1) ** 1.4;
    balances.set(w, Math.round(scale * (0.6 + rand() * 0.8)));
  });

  // Some chatters hold nothing, so `--holders-only` visibly does something.
  const nonHolders = Array.from({ length: 8 }, () => fakeWallet(rand));
  const speakers = [...wallets.slice(0, 14), ...nonHolders];

  // One name per wallet. Wrapping the list with % would hand the same name to
  // both a whale and a non-holder, which looks like the name lookup is broken.
  const names = new Map(
    speakers.map((w, i) => [
      w,
      // The list covers every speaker; the fallback is a guard, and keeps the
      // two apart properly rather than tacking a digit onto a real handle.
      i < NAMES.length ? NAMES[i] : `anon_${w.slice(0, 4).toLowerCase()}`,
    ])
  );

  // Never let the demo hit the network: pin the roster and stop refreshes.
  gate.rosterEnabled = true;
  gate.rosterRefused = false;
  gate.rosterTtlMs = Number.MAX_SAFE_INTEGER;
  gate.unwatch();
  gate.applyBalances(new Map(balances));

  const pick = (list) => list[Math.floor(rand() * list.length)];
  let n = 0;

  const say = () => {
    const wallet = pick(speakers);
    const isCommand = rand() < 0.12;
    feed.ingest({
      id: `demo-${++n}`,
      roomId: mint,
      username: names.get(wallet) ?? 'demo_user',
      userAddress: wallet,
      message: isCommand ? pick(COMMANDS) : pick(LINES),
      timestamp: new Date().toISOString(),
      messageType: 'REGULAR',
      // Occasionally reply to something, so that layout gets exercised too.
      ...(rand() < 0.15 && n > 1
        ? { replyToId: `demo-${n - 1}`, replyPreview: pick(LINES) }
        : {}),
    });
  };

  /** Move some balances, which produces buy/sell alerts through the real diff. */
  const trade = () => {
    for (let i = 0; i < churn; i++) {
      const w = pick(wallets);
      const before = balances.get(w) ?? 0;
      const swing = before * (rand() * 0.4 + 0.05) * (rand() < 0.5 ? -1 : 1);
      const after = Math.max(0, Math.round(before + swing));
      if (after === 0) balances.delete(w);
      else balances.set(w, after);
    }
    // And occasionally somebody brand new turns up.
    if (rand() < 0.4) {
      const fresh = fakeWallet(rand);
      wallets.push(fresh);
      balances.set(fresh, Math.round(500_000 * (0.2 + rand())));
    }
    gate.applyBalances(new Map(balances));
  };

  const chatTimer = setInterval(say, Math.max(200, 60_000 / Math.max(1, rate)));
  const tradeTimer = setInterval(trade, 12_000);
  chatTimer.unref?.();
  tradeTimer.unref?.();

  // Something on screen immediately, rather than an empty box for 2 seconds.
  for (let i = 0; i < 6; i++) say();

  return {
    wallets,
    stop() {
      clearInterval(chatTimer);
      clearInterval(tradeTimer);
    },
  };
}
