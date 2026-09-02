/**
 * In-memory session state: the style brief, the decision ledger, and pending
 * purchase handoffs. Single-process, single-user. Nothing persists — this is a
 * demo, and a database would only add deploy risk.
 */

import { randomUUID } from 'node:crypto';
import { DEMO_STYLE_CODES } from './fixtures.js';
import { searchCandidates, clearAllowedStyleCodes, isValidSearchQuery } from './upstream.js';
import { sanitize } from './normalize.js';
import { REGISTER_TIERS, DEFAULT_REGISTER } from './verdict.js';

/**
 * Occasions are data, not code. Each carries the register it reads at (the
 * rules for which live in verdict.js) and the AJIO search query it pulls
 * candidates from. Kept here rather than in verdict.js because "what a client
 * dinner means" is a product decision; "what formal implies" is a rule.
 *
 * A shopper can add to this list at runtime — see the add_occasion tradeoff.
 * The three below are the ones the demo boots with.
 */
const BUILT_IN_OCCASIONS = [
  { id: 'client-dinner', label: 'Client dinner', register: 'formal', query: 'men formal shirt', builtIn: true },
  { id: 'work', label: 'Work', register: 'smart-casual', query: 'men formal shirt', builtIn: true },
  { id: 'weekend', label: 'Weekend', register: 'casual', query: 'men casual shirt', builtIn: true },
];

// Fallback query when a shopper adds an occasion without supplying one. Broad
// on purpose: a query guessed from an arbitrary label ("men diwali party
// shirt") returns worse candidates than the register's honest default.
const REGISTER_QUERY = {
  'formal': 'men formal shirt',
  'smart-casual': 'men formal shirt',
  'casual': 'men casual shirt',
};

// Bounded so a looping agent cannot grow session state without limit.
const MAX_OCCASIONS = 24;
const MAX_WARDROBE = 30;

/**
 * The AJIO category bricks the rules can actually reason about, and the words
 * a shopper is likely to type for each.
 *
 * This map is load-bearing, not a nicety: duplicateRisk() and looksUnlocked()
 * in verdict.js match on the exact brick string, so a wardrobe item stored as
 * "trousers" would sit in the brief looking accepted while influencing no
 * verdict at all. Silently-inert input is worse than rejected input.
 */
const WARDROBE_BRICKS = ['Shirts', 'Tshirts', 'Trousers & Pants', 'Jeans', 'Blazers & Waistcoats'];

const BRICK_ALIASES = {
  'shirt': 'Shirts', 'formal shirt': 'Shirts', 'casual shirt': 'Shirts', 'dress shirt': 'Shirts',
  'tshirt': 'Tshirts', 't shirt': 'Tshirts', 'tee': 'Tshirts', 'tees': 'Tshirts',
  'polo': 'Tshirts', 'polos': 'Tshirts', 'polo shirt': 'Tshirts',
  'trouser': 'Trousers & Pants', 'trousers': 'Trousers & Pants', 'pant': 'Trousers & Pants',
  'pants': 'Trousers & Pants', 'chino': 'Trousers & Pants', 'chinos': 'Trousers & Pants',
  'slacks': 'Trousers & Pants', 'formal trousers': 'Trousers & Pants',
  'jean': 'Jeans', 'denim': 'Jeans', 'denims': 'Jeans',
  'blazer': 'Blazers & Waistcoats', 'blazers': 'Blazers & Waistcoats',
  'jacket': 'Blazers & Waistcoats', 'jackets': 'Blazers & Waistcoats',
  'waistcoat': 'Blazers & Waistcoats', 'waistcoats': 'Blazers & Waistcoats',
  'suit': 'Blazers & Waistcoats', 'sport coat': 'Blazers & Waistcoats',
};

const normWords = (s) =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

// Canonical brick names normalise onto themselves, so the UI's datalist values
// round-trip without needing an alias entry each.
const BRICK_LOOKUP = new Map([
  ...WARDROBE_BRICKS.map((b) => [normWords(b), b]),
  ...Object.entries(BRICK_ALIASES).map(([k, v]) => [normWords(k), v]),
]);

/**
 * Maps free text onto a brick the rules understand.
 * @returns {{brick: string|null, recognised: boolean}} brick is null when the
 *   text matches nothing — the caller stores it anyway and says so.
 */
export function canonicalBrick(input) {
  const n = normWords(input);
  if (!n) return { brick: null, recognised: false };

  const exact = BRICK_LOOKUP.get(n);
  if (exact) return { brick: exact, recognised: true };

  // "black formal trousers" / "levis jeans" — match on any word, longest first
  // so "polo shirt" resolves to Tshirts rather than Shirts.
  const words = n.split(' ');
  for (const [key, brick] of [...BRICK_LOOKUP].sort((a, b) => b[0].length - a[0].length)) {
    if (key.includes(' ') ? n.includes(key) : words.includes(key)) return { brick, recognised: true };
  }
  return { brick: null, recognised: false };
}

export { WARDROBE_BRICKS };

const HANDOFF_TTL_MS = 60_000;

const DEFAULT_BRIEF = {
  occasion: 'client-dinner',
  // The registry travels with the brief so the UI can render the dropdown and
  // an agent can see the valid ids without a second endpoint.
  occasions: structuredClone(BUILT_IN_OCCASIONS),
  city: 'Bengaluru',
  pin: '560029',
  budgetINR: 3000,
  deadline: isoDaysFromNow(5),
  avoid: { fits: ['Slim Fit'], colors: [] },
  wardrobe: [
    { id: 'w1', category: 'Trousers & Pants', color: 'Black', descriptor: 'Black formal trousers', recognised: true },
    { id: 'w2', category: 'Shirts', color: 'White', descriptor: 'White cotton shirt', recognised: true },
  ],
  // Populated by refreshCandidates() on boot/reset. Starts as the demo set so
  // the app is functional if search is unreachable before the first refresh.
  candidates: [...DEMO_STYLE_CODES],
};

/** Slug for a user-supplied occasion label. Returns '' if nothing usable. */
function slugify(label) {
  return normWords(label).replace(/ /g, '-').slice(0, 40).replace(/^-+|-+$/g, '');
}

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

/** Registry lookup by id. */
export function findOccasion(id) {
  return (state.brief.occasions ?? []).find((o) => o.id === id) ?? null;
}

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
  const entry = findOccasion(state.brief.occasion);
  const q = query ?? entry?.query ?? REGISTER_QUERY[entry?.register] ?? REGISTER_QUERY[DEFAULT_REGISTER];
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
      // Validated against the live registry, not a literal list — the whole
      // point of add_occasion is that the valid set grows at runtime.
      const v = String(value ?? '').trim();
      const entry = findOccasion(v);
      if (!entry) {
        const ids = (b.occasions ?? []).map((o) => o.id).join(', ');
        return { ok: false, error: `occasion must be one of ${ids}` };
      }
      const prev = b.occasion;
      b.occasion = v;
      return { ok: true, changed: prev !== v, summary: `Occasion ${prev} → ${v}` };
    }
    case 'add_occasion': {
      // Accept a bare string as the label — agents routinely send one.
      const raw = typeof value === 'string' ? { label: value } : (value ?? {});
      const label = sanitize(raw.label, 40);
      if (!label) return { ok: false, error: 'label is required' };

      const id = slugify(label);
      if (!id) return { ok: false, error: 'label must contain letters or digits' };

      const register = String(raw.register ?? DEFAULT_REGISTER).trim();
      if (!REGISTER_TIERS[register]) {
        return { ok: false, error: `register must be one of ${Object.keys(REGISTER_TIERS).join(', ')}` };
      }

      // Optional. Rejected rather than silently dropped, so a shopper who
      // typed a query that cannot be searched finds out immediately.
      let query = null;
      if (raw.query != null && String(raw.query).trim()) {
        query = sanitize(raw.query, 80);
        if (!isValidSearchQuery(query)) {
          return { ok: false, error: 'query may only contain letters, digits, spaces and - & , . \'' };
        }
      }

      const existing = findOccasion(id);
      if (existing) {
        const prev = b.occasion;
        b.occasion = id;
        return {
          ok: true,
          changed: prev !== id,
          summary: `Occasion ${prev} → ${id}`,
          note: `“${existing.label}” was already in your list, so it was selected rather than added again.`,
        };
      }
      if ((b.occasions ?? []).length >= MAX_OCCASIONS) {
        return { ok: false, error: `you already have ${MAX_OCCASIONS} occasions; reset to start over` };
      }

      b.occasions.push({ id, label, register, query, builtIn: false });
      const prev = b.occasion;
      b.occasion = id;
      return {
        ok: true,
        changed: true,
        summary: `Added occasion “${label}” (${REGISTER_TIERS[register].label} register) and switched to it`,
        note: query
          ? null
          : `No search query given, so candidates come from the ${REGISTER_TIERS[register].label.toLowerCase()} default: “${REGISTER_QUERY[register]}”.`,
      };
    }
    case 'add_wardrobe_item': {
      // A bare string is treated as the category — the common agent shape.
      const raw = typeof value === 'string' ? { category: value } : (value ?? {});
      const category = sanitize(raw.category, 40);
      if (!category) return { ok: false, error: 'category is required' };
      if (b.wardrobe.length >= MAX_WARDROBE) {
        return { ok: false, error: `your wardrobe already lists ${MAX_WARDROBE} items` };
      }

      const color = sanitize(raw.color, 24);
      const { brick, recognised } = canonicalBrick(category);
      const descriptor = sanitize(raw.descriptor, 80) || `${color} ${category}`.trim();

      const item = {
        id: randomUUID().slice(0, 8),
        // Stored canonicalised when we can, because that is the form the rules
        // compare against. The original wording survives in descriptor.
        category: brick ?? category,
        color,
        descriptor,
        recognised,
      };
      if (b.wardrobe.some((w) => w.category === item.category
        && normWords(w.color) === normWords(item.color))) {
        return { ok: true, changed: false, summary: `${descriptor} is already in your wardrobe` };
      }
      b.wardrobe.push(item);

      return {
        ok: true,
        changed: true,
        summary: `Added ${descriptor} to your wardrobe`,
        note: recognised
          ? (brick && normWords(brick) !== normWords(category) ? `Filed under ${brick}.` : null)
          : `Filed as “${category}”. Duplicate and rewear scoring only covers ${WARDROBE_BRICKS.join(', ')}, `
            + 'so this item is listed but will not move any verdict.',
      };
    }
    case 'remove_wardrobe_item': {
      const v = String(typeof value === 'object' ? (value?.id ?? '') : (value ?? '')).trim();
      if (!v) return { ok: false, error: 'wardrobe item id is required' };
      const i = b.wardrobe.findIndex((w) => w.id === v);
      if (i < 0) return { ok: false, error: `no wardrobe item with id ${v}` };
      const [gone] = b.wardrobe.splice(i, 1);
      return { ok: true, changed: true, summary: `Removed ${gone.descriptor || gone.category} from your wardrobe` };
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
