/**
 * In-memory session state: the style brief, the decision ledger, and pending
 * purchase handoffs. Single-process, single-user. Nothing persists — this is a
 * demo, and a database would only add deploy risk.
 */

import { randomUUID } from 'node:crypto';
import { DEMO_STYLE_CODES } from './fixtures.js';
import { searchCandidates, clearAllowedStyleCodes } from './upstream.js';

// Occasion → search query. Kept in state.js because the mapping is a product
// decision (what "matches" a client dinner vs a weekend), not an adapter one.
const OCCASION_QUERY = {
  'client-dinner': 'men formal shirt',
  work: 'men formal shirt',
  weekend: 'men casual shirt',
};

const HANDOFF_TTL_MS = 60_000;

const DEFAULT_BRIEF = {
  occasion: 'client-dinner',
  city: 'Bengaluru',
  pin: '560029',
  budgetINR: 3000,
  deadline: isoDaysFromNow(5),
  avoid: { fits: ['Slim Fit'], colors: [] },
  wardrobe: [
    { id: 'w1', category: 'Trousers & Pants', color: 'Black', descriptor: 'Black formal trousers' },
    { id: 'w2', category: 'Shirts', color: 'White', descriptor: 'White cotton shirt' },
  ],
  // Populated by refreshCandidates() on boot/reset. Starts as the demo set so
  // the app is functional if search is unreachable before the first refresh.
  candidates: [...DEMO_STYLE_CODES],
};

function isoDaysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export const state = {
  brief: structuredClone(DEFAULT_BRIEF),
  ledger: [],
  handoffs: new Map(),
};

export function logDecision({ actor, kind, summary, detail = null }) {
  const entry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    actor,
    kind,
    summary,
    detail,
  };
  state.ledger.push(entry);
  if (state.ledger.length > 200) state.ledger.shift();
  return entry;
}

export function resetSession() {
  state.brief = structuredClone(DEFAULT_BRIEF);
  state.ledger = [];
  state.handoffs.clear();
  // Codes earned by a previous search do not survive a reset.
  clearAllowedStyleCodes();
  logDecision({ actor: 'rules', kind: 'session', summary: 'Session reset to the demo brief' });
}

/**
 * Repopulates state.brief.candidates from AJIO search. Falls back to the demo
 * set if search is unreachable — the demo must never hang or hard-fail. Writes
 * a ledger entry so the source is auditable.
 */
export async function refreshCandidates({ query, pageSize = 8 } = {}) {
  const q = query ?? OCCASION_QUERY[state.brief.occasion] ?? OCCASION_QUERY['client-dinner'];
  const r = await searchCandidates(q, state.brief.pin, pageSize);
  if (r.ok && r.codes.length) {
    state.brief.candidates = r.codes;
    logDecision({
      actor: 'rules',
      kind: 'candidates',
      summary: `Loaded ${r.codes.length} live candidates from AJIO search: "${q}"`,
      detail: { query: q, codes: r.codes },
    });
    return { ok: true, count: r.codes.length, query: q };
  }
  state.brief.candidates = [...DEMO_STYLE_CODES];
  logDecision({
    actor: 'rules',
    kind: 'candidates',
    summary: `Live search failed (${r.error}); showing demo candidates`,
    detail: { query: q, error: r.error },
  });
  return { ok: false, error: r.error, fallback: 'demo', query: q };
}

/**
 * Applies a single tradeoff to the brief. Returns { ok, changed, summary }.
 * Every accepted change is written to the ledger by the caller so the source
 * attribution stays honest.
 */
export function applyTradeoff(tradeoff = {}) {
  const b = state.brief;
  const { type, value } = tradeoff;

  switch (type) {
    case 'set_budget': {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'budget must be a positive number' };
      const prev = b.budgetINR;
      b.budgetINR = Math.round(n);
      return { ok: true, changed: prev !== b.budgetINR, summary: `Budget ${prev} → ${b.budgetINR}` };
    }
    case 'avoid_fit': {
      const v = String(value ?? '').trim();
      if (!v) return { ok: false, error: 'fit is required' };
      if (b.avoid.fits.some((f) => f.toLowerCase() === v.toLowerCase())) {
        return { ok: true, changed: false, summary: `Already avoiding ${v}` };
      }
      b.avoid.fits.push(v);
      return { ok: true, changed: true, summary: `Now avoiding ${v}` };
    }
    case 'allow_fit': {
      const v = String(value ?? '').trim().toLowerCase();
      const before = b.avoid.fits.length;
      b.avoid.fits = b.avoid.fits.filter((f) => f.toLowerCase() !== v);
      return { ok: true, changed: b.avoid.fits.length !== before, summary: `No longer avoiding ${value}` };
    }
    case 'avoid_color': {
      const v = String(value ?? '').trim();
      if (!v) return { ok: false, error: 'colour is required' };
      if (b.avoid.colors.some((c) => c.toLowerCase() === v.toLowerCase())) {
        return { ok: true, changed: false, summary: `Already avoiding ${v}` };
      }
      b.avoid.colors.push(v);
      return { ok: true, changed: true, summary: `Now avoiding ${v}` };
    }
    case 'set_deadline': {
      const v = String(value ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ok: false, error: 'deadline must be YYYY-MM-DD' };
      const prev = b.deadline;
      b.deadline = v;
      return { ok: true, changed: prev !== v, summary: `Deadline ${prev} → ${v}` };
    }
    case 'set_pin': {
      const v = String(value ?? '');
      if (!/^[1-9][0-9]{5}$/.test(v)) return { ok: false, error: 'PIN must be 6 digits' };
      const prev = b.pin;
      b.pin = v;
      return { ok: true, changed: prev !== v, summary: `PIN ${prev} → ${v}` };
    }
    case 'set_occasion': {
      const v = String(value ?? '').trim();
      // Kept in sync with the <option>s in public/index.html and the keys in
      // OCCASION_RULES (verdict.js) + OCCASION_QUERY above.
      const allowed = ['client-dinner', 'work', 'weekend'];
      if (!allowed.includes(v)) {
        return { ok: false, error: `occasion must be one of ${allowed.join(', ')}` };
      }
      const prev = b.occasion;
      b.occasion = v;
      return { ok: true, changed: prev !== v, summary: `Occasion ${prev} → ${v}` };
    }
    case 'add_wardrobe_item': {
      const { category, color, descriptor } = value ?? {};
      if (!category) return { ok: false, error: 'category is required' };
      b.wardrobe.push({
        id: randomUUID().slice(0, 8),
        category: String(category).slice(0, 40),
        color: String(color ?? '').slice(0, 24),
        descriptor: String(descriptor ?? `${color ?? ''} ${category}`).trim().slice(0, 80),
      });
      return { ok: true, changed: true, summary: `Added ${color ?? ''} ${category} to your wardrobe`.trim() };
    }
    default:
      return { ok: false, error: `unknown tradeoff type: ${type}` };
  }
}

/** Phase 1 of the purchase handoff. Never returns a usable link on its own. */
export function createHandoff({ styleCode, size, pdpUrl }) {
  const id = randomUUID();
  state.handoffs.set(id, { id, styleCode, size, pdpUrl, at: Date.now(), used: false });
  return id;
}

/** Phase 2. Consumes the token. Single use, short TTL, bound to style + size. */
export function consumeHandoff(id, { styleCode, size }) {
  const h = state.handoffs.get(id);
  if (!h) return { ok: false, error: 'no such confirmation' };
  if (h.used) return { ok: false, error: 'confirmation already used' };
  if (Date.now() - h.at > HANDOFF_TTL_MS) {
    state.handoffs.delete(id);
    return { ok: false, error: 'confirmation expired' };
  }
  if (h.styleCode !== styleCode || h.size !== size) {
    return { ok: false, error: 'confirmation does not match this item and size' };
  }
  h.used = true;
  return { ok: true, handoff: h };
}
