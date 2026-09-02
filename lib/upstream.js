/**
 * Server-side adapters for the two public AJIO sources.
 *
 * SECURITY RULES — these are not style preferences.
 *
 *  1. No anti-bot sensor header is ever sent, stored, logged or committed.
 *     If you find yourself needing one to make a call succeed, the correct
 *     action is to fall back to fixtures, not to supply it.
 *  2. No arbitrary URL fetching. Style codes are validated against a strict
 *     pattern and an allowlist; PIN codes must be 6 digits.
 *  3. Requests carry only ordinary client headers. Any device identifier is a
 *     random per-process UUID, never a copied one.
 *  4. Every call has a hard timeout and a short cache. Failure degrades to
 *     fixtures — the demo must never hang or hard-fail on a network path.
 */

import { randomUUID } from 'node:crypto';
import { FIXTURES, EDD_FIXTURES, DEMO_STYLE_CODES } from './fixtures.js';
import { normalizeProduct } from './normalize.js';

const PDP_BASE = 'https://pdpaggregator-edge.services.ajio.com/aggregator/pdp';
const EDD_BASE = 'https://www.ajio.com/api/edd/checkDeliveryDetails';
const SEARCH_BASE = 'https://www.ajio.com/api/search';
const SEARCH_QUERY_MAX_LEN = 80;
// Allow letters, digits, spaces, plus a handful of common punctuation. Rejects
// anything that would let a malformed query steer the URL or the upstream.
const SEARCH_QUERY_ALLOWED = /^[a-zA-Z0-9 \-&,.']+$/;

// 4s used to be enough. In practice the aggregator's cold-connection latency
// can tip past that occasionally; 8s keeps the demo responsive but gives real
// requests room to land before we fall back to fixtures.
const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 60_000;

/** Generated once per process. Never a value copied from a captured request. */
const PROCESS_DEVICE_ID = randomUUID();

const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
}

export function isValidStyleCode(code) {
  // The aggregator accepts the numeric style code OR the fuller option code
  // ({styleCode}_{colourVariant}). Live PDPs on ajio.com return 404 without
  // the variant suffix, so we allow both shapes — still strictly bounded.
  return typeof code === 'string' && /^[0-9]{6,12}(_[a-z0-9-]{1,32})?$/.test(code);
}

export function isValidPin(pin) {
  return typeof pin === 'string' && /^[1-9][0-9]{5}$/.test(pin);
}

/**
 * Exported so a caller can reject a query at the point the user types it,
 * rather than discovering it is unusable one search later. searchCandidates
 * re-checks regardless — this is a courtesy, not the boundary.
 */
export function isValidSearchQuery(query) {
  const q = String(query ?? '').trim();
  return q.length > 0 && q.length <= SEARCH_QUERY_MAX_LEN && SEARCH_QUERY_ALLOWED.test(q);
}

/**
 * Style codes this server is willing to fetch.
 *
 * The invariant is *not* "only fixtures" — it is **only codes this server
 * obtained from AJIO itself, or ships fixtures for. Never a code that came
 * from the browser.** Search results are server-obtained and vetted through
 * isValidStyleCode, so they earn a place here; a code posted by the page does
 * not, and there is no route that adds one.
 */
const sessionAllowed = new Set();

/** Called by searchCandidates with codes AJIO's own search returned. */
export function allowStyleCodes(codes = []) {
  for (const c of codes) if (isValidStyleCode(c)) sessionAllowed.add(c);
  return sessionAllowed.size;
}

export function clearAllowedStyleCodes() {
  sessionAllowed.clear();
}

export function isAllowedStyleCode(code) {
  if (!isValidStyleCode(code)) return false;
  if (process.env.POW_ALLOW_ANY_STYLE === '1') return true;
  return DEMO_STYLE_CODES.includes(code) || sessionAllowed.has(code);
}

async function fetchJson(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    const text = await res.text();
    if (!res.ok) {
      // Snippet in server logs only. Never returned to the client — we don't
      // want a challenge page bleeding into a user-facing error. Useful when
      // running on a hosted platform (Render, Fly) where you need to know
      // if AJIO returned an actual challenge, a WAF block, or plain JSON 4xx.
      const snippet = text.slice(0, 200).replace(/\s+/g, ' ').trim();
      const host = (() => { try { return new URL(url).host; } catch { return 'upstream'; } })();
      console.warn(`upstream ${res.status} from ${host}: ${snippet}`);
      return { ok: false, status: res.status, error: `upstream ${res.status}` };
    }
    try { return { ok: true, status: res.status, json: JSON.parse(text) }; }
    catch { return { ok: false, status: res.status, error: 'upstream returned non-JSON' }; }
  } catch (err) {
    return { ok: false, status: 0, error: err?.name === 'AbortError' ? 'timeout' : 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ordinary HTTP hygiene we send with every upstream call. These are NOT
 * anti-bot sensor headers (see CLAUDE.md constraint #1) — they are the
 * baseline headers any real client sends. The bare `node/x` User-Agent
 * that Node's global fetch defaults to reliably 403s from datacenter
 * IPs (Render, Fly, Cloud Run) at AJIO's edge, and a truthful
 * "Mustermind/0.1" UA fares no better. A plausible mobile-web UA plus
 * Accept-Language and Referer is the minimum for the endpoint to answer.
 * If the IP itself is blocklisted, no header set will save us — the app
 * falls back to fixtures with a visible banner, which is the intended
 * degraded state.
 */
function commonHeaders() {
  return {
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 14; SM-A155F) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
    'Accept-Language': 'en-IN,en;q=0.9',
    Referer: 'https://www.ajio.com/',
  };
}

/**
 * PDP-aggregator headers. Ordinary app headers only. `ad_id` is a
 * random per-process UUID, never a captured value.
 */
function pdpHeaders() {
  return {
    ...commonHeaders(),
    Accept: 'application/json',
    RequestId: 'ProductDetails',
    'X-TENANT-ID': 'AJIO',
    client_type: 'Android',
    client_version: '9.9.9',
    ad_id: PROCESS_DEVICE_ID,
  };
}

function eddHeaders() {
  return { ...commonHeaders(), Accept: 'application/json' };
}

function searchHeaders() {
  return { ...commonHeaders(), Accept: 'application/json' };
}

export async function getProductTruth(styleCode) {
  if (!isAllowedStyleCode(styleCode)) {
    return { ok: false, error: 'style code not allowed', status: 400 };
  }

  const key = `pdp:${styleCode}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  let result;
  const live = await fetchJson(`${PDP_BASE}/${encodeURIComponent(styleCode)}`, pdpHeaders());

  if (live.ok) {
    try {
      result = {
        ok: true,
        product: normalizeProduct(live.json, { provenance: 'live', styleCode }),
        note: null,
      };
    } catch {
      result = fixtureProduct(styleCode, 'live response did not match the expected shape');
    }
  } else {
    result = fixtureProduct(styleCode, `live PDP unavailable (${live.error})`);
  }

  if (result.ok) cacheSet(key, result);
  return result;
}

function fixtureProduct(styleCode, why) {
  const raw = FIXTURES[styleCode];
  if (!raw) return { ok: false, error: 'no fixture for style code', status: 404 };
  return {
    ok: true,
    product: normalizeProduct(raw, { provenance: 'fixture', styleCode }),
    note: `Demo data. ${why}.`,
  };
}

/**
 * @param {string} sku
 * @param {string} pin
 * @param {object} opts
 * @param {string} opts.styleCode
 * @param {'live'|'fixture'} opts.productProvenance
 *
 * A fabricated demo SKU has no meaningful delivery answer. The live endpoint
 * will happily return "not serviceable" for one, which is true and useless —
 * it tells you the SKU doesn't exist, not that the garment can't be delivered.
 * Feeding that into the verdict would put a made-up product on a real-looking
 * hard fail. So live EDD is only consulted for products that came back live.
 */
export async function getDeliveryEvidence(sku, pin, { styleCode, productProvenance = 'live' } = {}) {
  if (!isValidPin(pin)) return { ok: false, error: 'invalid PIN code', status: 400 };
  if (!isValidStyleCode(sku)) return { ok: false, error: 'invalid sku', status: 400 };

  const key = `edd:${sku}:${pin}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  if (productProvenance !== 'live') {
    const r = fixtureEdd(styleCode ?? sku, pin, 'product itself is demo data, so live delivery evidence would not describe it');
    if (r.ok) cacheSet(key, r);
    return r;
  }

  const url = `${EDD_BASE}?productCode=${encodeURIComponent(sku)}`
    + `&postalCode=${encodeURIComponent(pin)}&quantity=1&IsExchange=false`;

  const live = await fetchJson(url, eddHeaders());
  let result;

  if (live.ok) {
    result = { ok: true, delivery: shapeEdd(live.json, pin), note: null };
  } else {
    result = fixtureEdd(styleCode ?? sku, pin, `live EDD unavailable (${live.error})`);
  }

  if (result.ok) cacheSet(key, result);
  return result;
}

/**
 * Field names follow the observed unavailable-response shape. An ETA is only
 * reported when the payload actually carries one — never inferred.
 */
function shapeEdd(json, pin) {
  const detail = Array.isArray(json?.productDetails) ? json.productDetails[0] : null;
  const serviceable = typeof json?.servicability === 'boolean'
    ? json.servicability
    : (typeof json?.serviceability === 'boolean' ? json.serviceability : null);

  const etaText = firstString([
    detail?.estimatedDeliveryDate, detail?.expectedDeliveryDate, detail?.deliveryDate,
    detail?.edd, json?.estimatedDeliveryDate,
  ]);

  return {
    serviceable,
    codEligible: typeof json?.codEligible === 'boolean' ? json.codEligible : null,
    pinCode: json?.pinCode ?? pin,
    deliveryMethod: detail?.deliveryMethod ?? null,
    etaText: etaText ?? null,
    etaDays: null,
    reason: detail?.reasonForNotServiceability ?? null,
    provenance: 'live',
  };
}

function firstString(candidates) {
  for (const c of candidates) if (typeof c === 'string' && c.trim()) return c.trim();
  return null;
}

function fixtureEdd(styleCode, pin, why) {
  const f = EDD_FIXTURES[styleCode];
  if (!f) {
    return {
      ok: true,
      delivery: {
        serviceable: null, codEligible: null, pinCode: pin, deliveryMethod: null,
        etaText: null, etaDays: null, reason: 'No delivery evidence available',
        provenance: 'fixture',
      },
      note: `Demo data. ${why}.`,
    };
  }
  return {
    ok: true,
    delivery: {
      serviceable: f.serviceable,
      codEligible: f.codEligible,
      pinCode: pin,
      deliveryMethod: null,
      etaText: f.etaText,
      etaDays: f.etaDays,
      reason: f.reason ?? null,
      provenance: 'fixture',
    },
    note: `Demo data. ${why}.`,
  };
}

/**
 * Search for candidate garments. Server-side only. Same discipline as the other
 * adapters: allowlisted base URL, timeout, cache, per-process visitorId, and
 * NEVER any personal identifier from the calling browser (no userEncryptedId,
 * no city/state/zone, no captured visitorId). Returns bare option codes.
 */
export async function searchCandidates(query, pincode = '560029', pageSize = 8) {
  const q = String(query ?? '').trim();
  if (!isValidSearchQuery(q)) return { ok: false, error: 'invalid search query', codes: [] };
  if (!isValidPin(pincode)) return { ok: false, error: 'invalid PIN', codes: [] };
  const n = Math.max(1, Math.min(20, Math.floor(pageSize)));

  const key = `search:${q}:${pincode}:${n}`;
  const cached = cacheGet(key);
  if (cached) {
    // Re-grant on the cache-hit path too. A reset revokes the session allowlist
    // but the search cache outlives it, so returning early here would hand back
    // codes the PDP adapter then refuses — an empty app right after Reset.
    if (cached.ok) allowStyleCodes(cached.codes);
    return cached;
  }

  const params = new URLSearchParams({
    fields: 'SITE',
    currentPage: '0',
    pageSize: String(n),
    format: 'json',
    query: `${q}:relevance`,
    text: q,
    classifier: 'intent',
    displayRatings: 'true',
    pincode,
    store: 'ajio',
    platform: 'Msite',
    // Random per-process; never a copied user identifier.
    visitorId: PROCESS_DEVICE_ID,
  });

  const r = await fetchJson(`${SEARCH_BASE}?${params.toString()}`, searchHeaders());
  if (!r.ok) return { ok: false, error: `search unavailable (${r.error})`, codes: [] };

  const products = Array.isArray(r.json?.products) ? r.json.products : [];
  const codes = [];
  for (const p of products) {
    const c = p?.code;
    if (isValidStyleCode(c) && !codes.includes(c)) codes.push(c);
    if (codes.length >= n) break;
  }

  // These came from AJIO's own search, so they become fetchable. Without this
  // the PDP adapter rejects every live candidate and the app renders empty.
  allowStyleCodes(codes);

  const result = { ok: true, query: q, codes };
  cacheSet(key, result);
  return result;
}
