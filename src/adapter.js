/**
 * ── THE ONLY FILE THAT KNOWS WHAT PUMP.FUN LOOKS LIKE ──────────────────────
 *
 * pump.fun has no official/public API. Everything here was reverse-engineered
 * from live traffic and WILL break without a changelog. When it does, the fix
 * belongs in this file and nowhere else.
 *
 * Verified live on 2026-08-22 against wss://livechat.pump.fun.
 *
 * Known drift already: the widely-documented REST route
 *   GET https://frontend-api-v3.pump.fun/replies/{mint}
 * is dead (404 "Cannot GET /replies/..."), as are frontend-api-v2 (503) and
 * frontend-api.pump.fun (Cloudflare 1016). Comments now live on the socket.
 */

export const UPSTREAM = {
  socketUrl: 'wss://livechat.pump.fun/socket.io/?EIO=4&transport=websocket',
  healthUrl: 'https://livechat.pump.fun/health',
  coinsUrl: 'https://frontend-api-v3.pump.fun/coins',
  origin: 'https://pump.fun',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
};

/** Server-accepted event names. Rename here if upstream renames them. */
export const EVENTS = {
  join: 'joinRoom',
  leave: 'leaveRoom',
  history: 'getMessageHistory',
  // Inbound pushes we care about. `message` is confirmed by shape, not by name
  // alone — see classifyPush().
  presence: ['userLeft', 'userJoined'],
  viewers: 'viewerCount',
};

export function socketHeaders() {
  return { Origin: UPSTREAM.origin, 'User-Agent': UPSTREAM.userAgent };
}

/** Sent immediately after the engine.io OPEN frame. `token: null` = anonymous. */
export function handshakeAuth(now) {
  return { origin: UPSTREAM.origin, timestamp: now, token: null };
}

export function joinPayload(mint) {
  return { roomId: mint, username: null };
}

export function historyPayload(mint, limit) {
  return { roomId: mint, limit, before: null };
}

/* ── Socket.IO v4 framing over a raw WebSocket ──────────────────────────────
 * engine.io: "0"=open "2"=ping "3"=pong "4"=message
 * socket.io (inside a "4"): "0"=connect "2"=event "3"=ack
 * So an event frame is "42<optional-ack-id>[name, payload].
 */
export const FRAME = {
  isOpen: (d) => d.startsWith('0') && !d.startsWith('40'),
  isPing: (d) => d === '2',
  pong: '3',
  isConnect: (d) => d.startsWith('40'),
  isEvent: (d) => /^42\d*\[/.test(d),
  isAck: (d) => /^43\d*\[/.test(d),
  connect: (auth) => '40' + JSON.stringify(auth),
  event: (name, payload, ackId) =>
    `42${ackId ?? ''}` + JSON.stringify([name, payload]),
  parseEvent(d) {
    const [name, payload] = JSON.parse(d.replace(/^4[23]\d*/, ''));
    return { name, payload };
  },
  ackId: (d) => Number((d.match(/^43(\d+)/) || [])[1]),
  parseAck: (d) => JSON.parse(d.replace(/^43\d*/, '')),
};

/* ── Message normalisation + drift detection ───────────────────────────────*/

/** Fields we depend on. Losing any of these is a breaking upstream change. */
const REQUIRED = ['message', 'userAddress'];
const OPTIONAL = [
  'id',
  'roomId',
  'username',
  'profile_image',
  'timestamp',
  'messageType',
  'isModerator',
  'isCreator',
  // Unix seconds. Pump.fun expires chat history, so a comment you saw once is
  // not guaranteed to be re-fetchable later — persist anything you need.
  'expiresAt',
  // Threaded replies. Only present when a message is a reply to another;
  // `replyPreview` is a truncated copy of the parent's text.
  'replyToId',
  'replyPreview',
  // Emoji reactions, keyed by shortcode (":fire:"). Upstream calls these
  // "Recent", so they are a sample of reactors — NOT a total count.
  'reactionRecentAddresses',
  'reactionRecentAvatarUrls',
];

/**
 * A push frame is a chat message if it carries the fields we need — we detect
 * by shape rather than trusting an event name, so a rename upstream does not
 * silently stop the stream.
 */
export function looksLikeMessage(payload) {
  return (
    payload &&
    typeof payload === 'object' &&
    typeof payload.message === 'string' &&
    typeof payload.userAddress === 'string'
  );
}

export function classifyPush(name, payload) {
  if (looksLikeMessage(payload)) return 'message';
  if (name === EVENTS.viewers) return 'viewers';
  if (EVENTS.presence.includes(name)) return 'presence';
  return 'other';
}

/**
 * Upstream shape -> our stable shape. Consumers only ever see this. Returns
 * `{ comment, missing }`; `missing` is non-empty when upstream dropped a field
 * we rely on, which the caller surfaces as a loud `drift` event.
 */
export function normalizeMessage(raw, mint) {
  const missing = REQUIRED.filter((f) => raw?.[f] === undefined);
  const unknown = Object.keys(raw || {}).filter(
    (k) => !REQUIRED.includes(k) && !OPTIONAL.includes(k)
  );

  const comment = {
    id: raw.id ?? null,
    mint: raw.roomId ?? mint,
    text: raw.message ?? '',
    author: raw.userAddress ?? null,
    username: raw.username || null,
    avatar: raw.profile_image || null,
    // Upstream sends ISO strings; fall back to arrival time if it stops.
    timestamp: raw.timestamp ?? new Date().toISOString(),
    isCreator: Boolean(raw.isCreator),
    isModerator: Boolean(raw.isModerator),
    type: raw.messageType ?? 'REGULAR',
    expiresAt: raw.expiresAt ? new Date(raw.expiresAt * 1000).toISOString() : null,
    replyTo: raw.replyToId
      ? { id: raw.replyToId, preview: raw.replyPreview ?? null }
      : null,
    reactions: buildReactions(raw),
    // Filled in by the holder gate downstream.
    holder: null,
    balance: null,
    raw,
  };

  return { comment, missing, unknown };
}

/**
 * `{ ':fire:': { recent: ['wallet…'], avatars: ['https://…'] } }`
 *
 * Deliberately no `count` field: upstream only sends *recent* reactors, so a
 * length here would be a sample size masquerading as a total.
 */
function buildReactions(raw) {
  const addrs = raw.reactionRecentAddresses;
  if (!addrs || typeof addrs !== 'object') return null;
  const avatars = raw.reactionRecentAvatarUrls ?? {};
  const out = {};
  for (const [emoji, list] of Object.entries(addrs)) {
    out[emoji] = {
      recent: Array.isArray(list) ? list : [],
      avatars: Array.isArray(avatars[emoji]) ? avatars[emoji] : [],
    };
  }
  return Object.keys(out).length ? out : null;
}

/** Live tokens, used by the CLI's `--discover` helper. */
export async function fetchLiveCoins(limit = 10) {
  const url = `${UPSTREAM.coinsUrl}/currently-live?offset=0&limit=${limit}&sort=currently_live&order=DESC`;
  const res = await fetch(url, {
    headers: {
      accept: '*/*',
      origin: UPSTREAM.origin,
      referer: UPSTREAM.origin + '/',
      'user-agent': UPSTREAM.userAgent,
    },
  });
  if (!res.ok) throw new Error(`pump.fun coins list failed: HTTP ${res.status}`);
  const coins = await res.json();
  return coins.map((c) => ({
    mint: c.mint,
    symbol: c.symbol,
    name: c.name,
    replyCount: c.reply_count ?? 0,
    marketCap: Math.round(c.usd_market_cap ?? 0),
  }));
}
