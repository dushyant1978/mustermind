/**
 * Wearability verdict engine.
 *
 * Produces one of: buy | restyle | wait | skip, together with the factors that
 * produced it. Every factor carries a `source` so the Decision Ledger can show
 * whether an outcome came from the user, from product facts, or from the rules.
 *
 * Deliberately a rule engine, not a model. The agent has to narrate why the
 * verdict is what it is, and a scorer you cannot read gives it nothing to say.
 */

/**
 * Register tiers — how formally a garment has to read.
 *
 * Occasions are *data* (see lib/state.js); this table is the rule content, and
 * it is what an occasion resolves to. Splitting them is what lets a shopper add
 * "Diwali party" without anyone hand-writing a rule for it: they pick the tier
 * it reads at, and the hard stop below still has a stated basis the ledger can
 * cite. The three tiers are exactly the three the demo shipped with.
 */
const REGISTER_TIERS = {
  'formal': {
    label: 'Formal',
    preferredBricks: ['Shirts', 'Blazers & Waistcoats', 'Trousers & Pants',
      'Kurtas', '2-Piece Ethnic Suit', 'Suit Sets'],
    weakBricks: ['Tshirts', 'Shorts & 3/4ths', 'Swimwear', 'Track Pants', 'Sweatshirt & Hoodies'],
    preferredStyleTypes: ['Formal'],
  },
  'smart-casual': {
    label: 'Smart casual',
    preferredBricks: ['Shirts', 'Trousers & Pants', 'Blazers & Waistcoats',
      'Kurtas', 'Co-ord Sets', 'Jackets & Coats'],
    // Deliberately empty — see DEFAULT_REGISTER below. Nothing may be added
    // here without breaking the fail-safe that an unresolvable register can
    // never produce a hard stop.
    weakBricks: [],
    preferredStyleTypes: ['Formal', 'Casual'],
  },
  'casual': {
    label: 'Casual',
    preferredBricks: ['Tshirts', 'Jeans', 'Shirts', 'Shorts & 3/4ths',
      'Co-ord Sets', 'Track Pants', 'Sweatshirt & Hoodies'],
    // A suit at a weekend is the same register error as a blazer. An ethnic
    // suit is not — overdressed for a brunch, but not embarrassing, and a
    // hard stop is too strong a claim to make about it.
    weakBricks: ['Blazers & Waistcoats', 'Suit Sets'],
    preferredStyleTypes: ['Casual', 'Polo'],
  },
};
/**
 * Smart casual is the fallback on purpose: it is the only tier with no
 * weakBricks, so a brief that arrives without a resolvable register can never
 * produce a wrong-register hard stop. Inventing one would be the worst
 * available failure — see the decision block at the bottom of this file.
 */
const DEFAULT_REGISTER = 'smart-casual';

/**
 * Resolves brief.occasion against brief.occasions (the registry state.js owns)
 * into the tier rules plus a display label for the prose.
 */
function resolveRegister(brief) {
  const entry = (brief.occasions ?? []).find((o) => o.id === brief.occasion) ?? null;
  const tierId = REGISTER_TIERS[entry?.register] ? entry.register : DEFAULT_REGISTER;
  return { ...REGISTER_TIERS[tierId], tierId, occasionLabel: entry?.label ?? 'this occasion' };
}

/**
 * Catalogue bricks are plurals ("Blazers & Waistcoats"), and the register
 * factor reads as prose in the UI and in what the agent says out loud.
 * Trimming a trailing "s" gives "blazers & waistcoat", so name the singulars.
 */
const BRICK_SINGULAR = {
  'Shirts': 'shirt',
  'Tshirts': 'tshirt',
  'Trousers & Pants': 'pair of trousers',
  'Jeans': 'pair of jeans',
  'Blazers & Waistcoats': 'blazer',
  'Shorts & 3/4ths': 'pair of shorts',
  'Swimwear': 'swimsuit',
  'Track Pants': 'pair of track pants',
  'Sweatshirt & Hoodies': 'hoodie',
  'Kurtas': 'kurta',
  '2-Piece Ethnic Suit': 'two-piece ethnic suit',
  'Suit Sets': 'suit',
  'Co-ord Sets': 'co-ord set',
  'Jackets & Coats': 'jacket',
  'Rainwear and Windcheaters': 'windcheater',
}
const singularBrick = (b) => BRICK_SINGULAR[b] ?? String(b).toLowerCase().replace(/s$/, '');

const factor = (id, label, direction, evidence, source, weight = 1) =>
  ({ id, label, direction, evidence, source, weight });

function normColor(c) {
  return String(c ?? '').trim().toLowerCase();
}

function normBrick(b) {
  return String(b ?? '').trim().toLowerCase();
}

/**
 * How much this garment overlaps what the user already owns.
 * 1.0 = same category and colour. 0.55 = same category, different colour.
 */
function duplicateRisk(product, wardrobe = []) {
  const brick = normBrick(product.category?.brick);
  const color = normColor(product.color);
  let worst = 0;
  let match = null;

  for (const item of wardrobe) {
    if (normBrick(item.category) !== brick) continue;
    const sameColor = normColor(item.color) === color;
    const score = sameColor ? 1.0 : 0.55;
    if (score > worst) { worst = score; match = item; }
  }
  return { risk: worst, match };
}

/**
 * Rough count of distinct looks this unlocks against the existing wardrobe.
 *
 * A whole outfit unlocks nothing by pairing — a co-ord set or a swimsuit is
 * already the look. Returning 1 for those is the intended answer, not the
 * default that falls out of an unlisted brick.
 */
function looksUnlocked(product, wardrobe = []) {
  const brick = normBrick(product.category?.brick);
  const tops = ['shirts', 'tshirts', 'blazers & waistcoats', 'sweatshirt & hoodies',
    'kurtas', 'jackets & coats', 'rainwear and windcheaters'];
  const bottoms = ['trousers & pants', 'jeans', 'shorts & 3/4ths', 'track pants'];

  const isTop = tops.includes(brick);
  const isBottom = bottoms.includes(brick);
  if (!isTop && !isBottom) return 1;

  const counterpart = isTop ? bottoms : tops;
  const n = wardrobe.filter((i) => counterpart.includes(normBrick(i.category))).length;
  return Math.max(1, n);
}

/**
 * Recommended size from the crowd fit skew.
 * With no personal history this is the honest ceiling: a directional nudge off
 * the middle of the ladder, not a claim about the shopper's body.
 */
function recommendSize(product) {
  const inStock = (product.sizes ?? []).filter((s) => s.inStock);
  if (inStock.length === 0) return { size: null, why: 'No size is in stock' };

  const mid = inStock[Math.floor((inStock.length - 1) / 2)];
  const crowd = product.crowdFit;

  if (!crowd || crowd.verdict === 'INSUFFICIENT_DATA') {
    return { size: mid.size, why: 'Middle of the available range; not enough fit ratings to adjust' };
  }
  if (crowd.verdict === 'RUNS_SMALL') {
    const idx = inStock.indexOf(mid);
    const up = inStock[Math.min(idx + 1, inStock.length - 1)];
    return {
      size: up.size,
      why: `${crowd.tight + crowd.tooTight}% of ${crowd.raters} raters found this tight vs ${crowd.loose + crowd.tooLoose}% loose, so one size up`,
    };
  }
  if (crowd.verdict === 'RUNS_LARGE') {
    const idx = inStock.indexOf(mid);
    const down = inStock[Math.max(idx - 1, 0)];
    return {
      size: down.size,
      why: `${crowd.loose + crowd.tooLoose}% of ${crowd.raters} raters found this loose vs ${crowd.tight + crowd.tooTight}% tight, so one size down`,
    };
  }
  return { size: mid.size, why: `${crowd.perfect}% of ${crowd.raters} raters found this true to size` };
}

function fitConfidence(product) {
  let score = 0.5;
  const notes = [];

  if (product.measurement?.quality === 'GARMENT_MEASURED') { score += 0.2; notes.push('garment measurements published'); }
  else if (product.measurement?.quality === 'BODY_MEASURED') { score += 0.05; notes.push('body measurements only'); }
  else { score -= 0.1; notes.push('no measurement provenance'); }

  const crowd = product.crowdFit;
  if (crowd && crowd.verdict !== 'INSUFFICIENT_DATA') {
    score += 0.2;
    notes.push(`${crowd.raters} fit ratings`);
    if (Math.abs(crowd.skew) > 0.15) { score -= 0.1; notes.push('sizing runs off-standard'); }
  } else {
    notes.push('too few fit ratings to rely on');
  }

  const inStock = (product.sizes ?? []).filter((s) => s.inStock).length;
  if (inStock <= 1) { score -= 0.15; notes.push('almost no size choice left'); }

  return { score: Math.max(0, Math.min(1, Math.round(score * 100) / 100)), notes };
}

/**
 * @param {object} product     ProductTruth
 * @param {object} delivery    DeliveryEvidence (may have null fields)
 * @param {object} brief       StyleBrief
 */
export function evaluateWearability(product, delivery, brief) {
  const factors = [];
  const occasion = resolveRegister(brief);

  // --- user constraints -------------------------------------------------
  const price = product.price?.currentINR ?? null;
  const budget = brief.budgetINR ?? null;
  let overBudget = false;

  if (price !== null && budget !== null) {
    if (price <= budget) {
      factors.push(factor('budget', 'Within budget', '+',
        `₹${price.toLocaleString('en-IN')} against a ₹${budget.toLocaleString('en-IN')} ceiling`, 'user', 1));
    } else {
      overBudget = true;
      const over = price - budget;
      factors.push(factor('budget', 'Over budget', '-',
        `₹${price.toLocaleString('en-IN')} is ₹${over.toLocaleString('en-IN')} over your ₹${budget.toLocaleString('en-IN')} ceiling`, 'user', 3));
    }
  }

  const avoidedFits = (brief.avoid?.fits ?? []).map((f) => f.toLowerCase());
  const fitType = String(product.fit?.type ?? '').trim().toLowerCase();
  const fitAvoided = fitType && avoidedFits.some((a) => fitType.includes(a.toLowerCase()));
  if (fitAvoided) {
    factors.push(factor('avoided-fit', 'Fit you avoid', '-',
      `This is a ${product.fit.type} and you asked to avoid that`, 'user', 4));
  } else if (fitType) {
    factors.push(factor('fit-type', 'Fit works for you', '+', `${product.fit.type}`, 'product', 1));
  }

  const avoidedColors = (brief.avoid?.colors ?? []).map(normColor);
  const colorAvoided = avoidedColors.includes(normColor(product.color));
  if (colorAvoided) {
    factors.push(factor('avoided-color', 'Colour you avoid', '-',
      `You asked to avoid ${product.color}`, 'user', 3));
  }

  // --- wardrobe ---------------------------------------------------------
  const dup = duplicateRisk(product, brief.wardrobe);
  const looks = looksUnlocked(product, brief.wardrobe);

  if (dup.risk >= 1.0) {
    factors.push(factor('duplicate', 'You already own this', '-',
      `You listed ${dup.match.color} ${dup.match.category} already`, 'user', 4));
  } else if (dup.risk >= 0.5) {
    factors.push(factor('near-duplicate', 'Close to something you own', '-',
      `You already have ${dup.match.color} ${dup.match.category}; this adds a colour, not a category`, 'rules', 2));
  } else {
    factors.push(factor('fills-gap', 'Fills a gap', '+',
      `Nothing in your listed wardrobe covers ${product.category?.brick}`, 'rules', 2));
  }

  factors.push(factor('rewear', 'Rewear value', looks >= 2 ? '+' : '0',
    `Pairs with ${looks} item${looks === 1 ? '' : 's'} you already own`, 'rules', looks >= 2 ? 2 : 1));

  // --- occasion ---------------------------------------------------------
  const brick = product.category?.brick ?? '';
  const wrongRegister = occasion.weakBricks.includes(brick);
  if (wrongRegister) {
    factors.push(factor('occasion', 'Wrong register', '-',
      `A ${singularBrick(brick)} does not read as ${occasion.occasionLabel.toLowerCase()}, whatever it costs`, 'rules', 4));
  } else if (occasion.preferredBricks.includes(brick)) {
    factors.push(factor('occasion', 'Right register', '+',
      `A ${singularBrick(brick)} reads as ${occasion.occasionLabel.toLowerCase()} (${occasion.label.toLowerCase()} register)`, 'rules', 1));
  }

  // --- product truth ----------------------------------------------------
  const conf = fitConfidence(product);
  factors.push(factor('fit-confidence', 'Fit confidence', conf.score >= 0.65 ? '+' : conf.score >= 0.45 ? '0' : '-',
    `${Math.round(conf.score * 100)}% — ${conf.notes.join(', ')}`, 'product', 2));

  const size = recommendSize(product);
  if (size.size) {
    factors.push(factor('size', `Suggested size ${size.size}`, '+', size.why, 'product', 1));
  } else {
    factors.push(factor('size', 'No size available', '-', size.why, 'product', 4));
  }

  // --- delivery ---------------------------------------------------------
  let deliveryBlocked = false;
  let deliveryLate = false;

  if (delivery?.serviceable === false) {
    deliveryBlocked = true;
    factors.push(factor('delivery', 'Not deliverable', '-',
      delivery.reason || `Not serviceable at ${delivery.pinCode}`, 'product', 4));
  } else if (delivery?.serviceable === true) {
    // Only ever state an ETA the payload actually supplied.
    if (delivery.etaText) {
      const days = delivery.etaDays;
      const deadlineDays = daysUntil(brief.deadline);
      if (days !== null && deadlineDays !== null && days > deadlineDays) {
        deliveryLate = true;
        factors.push(factor('delivery', 'Arrives after you need it', '-',
          `${delivery.etaText} against a deadline ${deadlineDays} day${deadlineDays === 1 ? '' : 's'} away`, 'product', 3));
      } else {
        factors.push(factor('delivery', 'Delivers in time', '+',
          `${delivery.etaText} to ${delivery.pinCode}`, 'product', 1));
      }
    } else {
      factors.push(factor('delivery', 'Deliverable, no date given', '0',
        `Serviceable at ${delivery.pinCode}; the delivery API did not return a date`, 'product', 1));
    }
  } else {
    factors.push(factor('delivery', 'Delivery unknown', '0',
      'No delivery evidence available for this PIN', 'product', 1));
  }

  // --- decision ---------------------------------------------------------
  let decision;
  let headline;

  // Wrong register is a hard stop, not a deduction. A polo does not become
  // client-dinner appropriate because it is cheap and in stock, and letting
  // price pull it up the ranking is how these systems lose trust.
  if (fitAvoided || colorAvoided || dup.risk >= 1.0 || deliveryBlocked || wrongRegister || !size.size) {
    decision = 'skip';
    headline = fitAvoided ? 'A fit you told me to avoid'
      : colorAvoided ? 'A colour you told me to avoid'
        : dup.risk >= 1.0 ? 'You already own this'
          : deliveryBlocked ? 'It cannot reach your PIN code'
            : wrongRegister ? `Wrong register for ${occasion.occasionLabel}`
              : 'Nothing left in a wearable size';
  } else if (overBudget || deliveryLate) {
    decision = 'wait';
    headline = overBudget
      ? 'Right piece, wrong price today'
      : 'Right piece, arrives too late';
  } else if (dup.risk >= 0.5 && looks <= 2) {
    decision = 'restyle';
    headline = 'You can get this look from what you own';
  } else {
    decision = 'buy';
    headline = 'Worth buying for this occasion';
  }

  const negatives = factors.filter((f) => f.direction === '-').reduce((a, f) => a + f.weight, 0);
  const positives = factors.filter((f) => f.direction === '+').reduce((a, f) => a + f.weight, 0);
  const confidence = Math.max(0.2, Math.min(0.95,
    Math.round((0.5 + (positives - negatives) / 20) * 100) / 100));

  return {
    styleCode: product.styleCode,
    decision,
    headline,
    confidence,
    recommendedSize: size.size,
    sizeRationale: size.why,
    fitConfidence: conf.score,
    duplicateRisk: Math.round(dup.risk * 100) / 100,
    looksUnlocked: looks,
    factors,
    // Which register the occasion resolved to. Stated explicitly because a
    // wrong-register skip is a hard stop, and "why was this a hard stop" has
    // to be answerable without reading this file.
    register: { occasion: occasion.occasionLabel, tier: occasion.tierId, tierLabel: occasion.label },
    provenance: { product: product.provenance, delivery: delivery?.provenance ?? 'none' },
  };
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const then = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(then.getTime())) return null;
  const now = new Date();
  return Math.max(0, Math.ceil((then - now) / 86_400_000));
}

export { REGISTER_TIERS, DEFAULT_REGISTER };
