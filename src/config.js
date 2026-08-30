/**
 * One place that decides what the server actually runs with.
 *
 * Four sources, lowest priority first:
 *
 *   1. the defaults below
 *   2. a config file  (pumpstream.config.json, or --config <path>)
 *   3. environment    (PUMPSTREAM_RPC, PUMPSTREAM_TOP_HOLDERS, …)
 *   4. command line   (--rpc, --top, …)
 *
 * Every resolved value remembers where it came from, so `--print-config`
 * can answer "why is it doing that" without anyone reading source.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The whole surface, in one table. `env` and `flag` are the names each option
 * answers to; `overlay` marks the ones that are defaults for the browser
 * source rather than server behaviour.
 */
export const SCHEMA = {
  // ── feed ────────────────────────────────────────────────────────────────
  mints: { type: 'list', default: [], flag: 'mint', env: 'MINTS', help: 'token mint(s) to follow' },
  holdersOnly: { type: 'bool', default: false, flag: 'holders-only', env: 'HOLDERS_ONLY', help: 'drop comments from non-holders' },
  minBalance: { type: 'number', default: 0, min: 0, flag: 'min-balance', env: 'MIN_BALANCE', help: 'tokens required to count as a holder' },
  topHolders: { type: 'number', default: 0, min: 0, flag: 'top', env: 'TOP_HOLDERS', help: 'only the N largest holders may appear' },
  history: { type: 'number', default: 0, min: 0, max: 200, flag: 'history', env: 'HISTORY', help: 'replay the last N comments on connect' },
  commandPrefix: { type: 'string', default: '!', flag: 'prefix', env: 'COMMAND_PREFIX', help: "command prefix, '' to disable" },

  // ── holder gate ─────────────────────────────────────────────────────────
  rpcUrl: { type: 'string', default: '', flag: 'rpc', env: 'RPC', help: 'Solana RPC (use a paid one for real traffic)' },
  roster: { type: 'bool', default: true, flag: 'roster', env: 'ROSTER', help: 'fetch every holder in one call' },
  rosterTtlMs: { type: 'number', default: 120_000, min: 1000, flag: 'roster-ttl', env: 'ROSTER_TTL_MS', help: 'how often the holder roster refreshes' },
  holderTtlMs: { type: 'number', default: 60_000, min: 1000, flag: 'holder-ttl', env: 'HOLDER_TTL_MS', help: 'how long a per-wallet balance stays fresh' },
  minDelta: { type: 'number', default: 0, min: 0, flag: 'min-delta', env: 'MIN_DELTA', help: 'ignore balance moves smaller than this' },

  // ── server ──────────────────────────────────────────────────────────────
  port: { type: 'number', default: 8787, min: 1, max: 65535, flag: 'port', env: 'PORT', help: 'local server port' },
  host: { type: 'string', default: '127.0.0.1', flag: 'host', env: 'HOST', help: 'interface to bind (localhost by default, on purpose)' },
  bufferSize: { type: 'number', default: 200, min: 1, max: 10_000, flag: 'buffer', env: 'BUFFER', help: 'how many recent comments to keep' },
  quiet: { type: 'bool', default: false, flag: 'quiet', env: 'QUIET', help: 'do not print comments to stdout' },

  // ── overlay defaults ────────────────────────────────────────────────────
  // Set your look once here instead of in a query string every time. A query
  // parameter still wins, so a second browser source can differ.
  overlay: { type: 'object', default: {}, env: 'OVERLAY', overlay: true, help: 'default overlay options (see the overlay table)' },
};

export const CONFIG_FILES = [
  'pumpstream.config.json',
  '.pumpstreamrc.json',
  '.pumpstreamrc',
];

class ConfigError extends Error {}

/* ── coercion ───────────────────────────────────────────────────────────── */

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

function coerce(key, raw, spec, where) {
  const fail = (why) => {
    throw new ConfigError(`${key} (${where}): ${why}, got ${JSON.stringify(raw)}`);
  };

  switch (spec.type) {
    case 'bool': {
      if (typeof raw === 'boolean') return raw;
      const v = String(raw).toLowerCase();
      if (TRUE.has(v)) return true;
      if (FALSE.has(v)) return false;
      return fail('expected true or false');
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return fail('expected a number');
      if (spec.min !== undefined && n < spec.min) return fail(`must be at least ${spec.min}`);
      if (spec.max !== undefined && n > spec.max) return fail(`must be at most ${spec.max}`);
      return n;
    }
    case 'list': {
      const items = Array.isArray(raw) ? raw : String(raw).split(',');
      return items.map((s) => String(s).trim()).filter(Boolean);
    }
    case 'object': {
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
      try {
        const parsed = JSON.parse(String(raw));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {
        /* fall through */
      }
      return fail('expected an object');
    }
    default:
      return String(raw);
  }
}

/* ── sources ────────────────────────────────────────────────────────────── */

/** Flags that consume the next argument, derived from the schema. */
export function valueFlags() {
  const set = new Set();
  for (const spec of Object.values(SCHEMA)) {
    if (spec.flag && spec.type !== 'bool') set.add(spec.flag);
  }
  set.add('config');
  return set;
}

function fromArgv(argv) {
  const takesValue = valueFlags();
  const found = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(...arg.split(',').map((s) => s.trim()).filter(Boolean));
      continue;
    }
    let name = arg.slice(2);
    let value = true;

    // --no-roster reads better than --roster false.
    if (name.startsWith('no-')) {
      name = name.slice(3);
      value = false;
    } else if (takesValue.has(name)) {
      value = argv[++i];
      if (value === undefined) {
        throw new ConfigError(`--${name} needs a value`);
      }
    }
    found[name] = value;
  }
  return { found, positionals };
}

function fromEnv(env) {
  const found = {};
  for (const [key, spec] of Object.entries(SCHEMA)) {
    if (!spec.env) continue;
    const value = env[`PUMPSTREAM_${spec.env}`];
    if (value !== undefined && value !== '') found[key] = value;
  }
  return found;
}

async function fromFile(explicitPath, cwd) {
  const candidates = explicitPath
    ? [path.resolve(cwd, explicitPath)]
    : CONFIG_FILES.map((f) => path.resolve(cwd, f));

  for (const file of candidates) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue; // absent is fine, unless it was asked for by name
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ConfigError(`${file}: expected a JSON object`);
      }
      return { file, values: parsed };
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      throw new ConfigError(`${file}: not valid JSON — ${err.message}`);
    }
  }

  if (explicitPath) throw new ConfigError(`config file not found: ${explicitPath}`);
  return { file: null, values: {} };
}

/* ── resolution ─────────────────────────────────────────────────────────── */

/**
 * @returns {Promise<{config: object, sources: object, file: string|null, unknown: string[]}>}
 */
export async function loadConfig({ argv = [], env = {}, cwd = process.cwd() } = {}) {
  const { found: flags, positionals } = fromArgv(argv);
  const { file, values: fileValues } = await fromFile(flags.config, cwd);
  const envValues = fromEnv(env);

  const config = {};
  const sources = {};

  for (const [key, spec] of Object.entries(SCHEMA)) {
    config[key] = Array.isArray(spec.default) ? [...spec.default] : spec.default;
    sources[key] = 'default';

    if (key in fileValues) {
      config[key] = coerce(key, fileValues[key], spec, file);
      sources[key] = `file:${path.basename(file)}`;
    }
    if (key in envValues) {
      config[key] = coerce(key, envValues[key], spec, 'env');
      sources[key] = `env:PUMPSTREAM_${spec.env}`;
    }
    if (spec.flag && spec.flag in flags) {
      config[key] = coerce(key, flags[spec.flag], spec, 'flag');
      sources[key] = `flag:--${spec.flag}`;
    }
  }

  // Bare mints on the command line beat everything — it is what you typed.
  if (positionals.length) {
    config.mints = positionals;
    sources.mints = 'argument';
  }

  // Anything that looks like a flag but is not one is almost always a typo,
  // and silently ignoring it means the setting just does not apply.
  const known = new Set([...valueFlags(), 'help', 'discover', 'print-config', 'version']);
  for (const spec of Object.values(SCHEMA)) if (spec.flag) known.add(spec.flag);
  const unknown = Object.keys(flags).filter((f) => !known.has(f));

  return { config, sources, file, unknown };
}

/** A human-readable table of what is set and where it came from. */
export function describeConfig(config, sources) {
  const rows = Object.keys(SCHEMA).map((key) => {
    const value = config[key];
    const shown =
      Array.isArray(value) ? (value.length ? value.join(', ') : '—')
      : typeof value === 'object' ? JSON.stringify(value)
      : value === '' ? '—'
      : String(value);
    return [key, shown, sources[key]];
  });

  const w = (i) => Math.max(...rows.map((r) => r[i].length));
  const [a, b] = [w(0), w(1)];
  return rows
    .map(([k, v, s]) => `  ${k.padEnd(a)}  ${v.padEnd(b)}  ${s === 'default' ? '' : s}`.trimEnd())
    .join('\n');
}

export { ConfigError };
