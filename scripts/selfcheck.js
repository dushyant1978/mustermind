/**
 * Self-check. No test framework — `node scripts/selfcheck.js`.
 * Covers the parsing traps and the decision rules that the demo depends on.
 */

import { normalizeProduct, parseRaterCount, sanitize, safeImageUrl } from '../lib/normalize.js';
import { evaluateWearability } from '../lib/verdict.js';
import { FIXTURES, EDD_FIXTURES } from '../lib/fixtures.js';
import { isAllowedStyleCode, allowStyleCodes, clearAllowedStyleCodes } from '../lib/upstream.js';
import { applyTradeoff, state, createHandoff, consumeHandoff, resetSession, canonicalBrick, themeQuery, findOccasion } from '../lib/state.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};

// Must mirror DEFAULT_BRIEF in lib/state.js. If they drift, the tests stop
// describing the app the demo actually runs.
const brief = () => ({
  occasion: 'client-dinner',
  occasions: [
    { id: 'client-dinner', label: 'Client dinner', register: 'formal', query: 'men formal shirt', builtIn: true },
    { id: 'work', label: 'Work', register: 'smart-casual', query: 'men formal shirt', builtIn: true },
    { id: 'weekend', label: 'Weekend', register: 'casual', query: 'men casual shirt', builtIn: true },
  ],
  city: 'Bengaluru', pin: '560029',
  budgetINR: 3000, deadline: isoIn(5),
  avoid: { fits: ['Slim Fit'], colors: [] },
  wardrobe: [
    { id: 'w1', category: 'Trousers & Pants', color: 'Black', descriptor: 'Black formal trousers', recognised: true },
    { id: 'w2', category: 'Shirts', color: 'White', descriptor: 'White cotton shirt', recognised: true },
  ],
  candidates: Object.keys(FIXTURES),
});

function isoIn(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
const P = (code) => normalizeProduct(FIXTURES[code], { provenance: 'fixture', styleCode: code });
const D = (code) => ({ ...EDD_FIXTURES[code], pinCode: '560029', provenance: 'fixture' });

console.log('\nparsing');
ok('rater count "2.1K" -> 2100', parseRaterCount('2.1K') === 2100);
ok('rater count "1,059" -> 1059', parseRaterCount('1,059') === 1059);
ok('rater count garbage -> null', parseRaterCount('lots') === null);
ok('sanitize strips markup', sanitize('<b>hi</b> there') === 'hi there');
ok('sanitize caps length', sanitize('x'.repeat(500)).length === 200);
// Image URLs are seller-supplied; the check keeps trackers and data: payloads
// off the page even if the aggregator response is later manipulated.
ok('safe image url passes an assets.ajio.com HTTPS URL',
  safeImageUrl('https://assets.ajio.com/medias/x.jpg') === 'https://assets.ajio.com/medias/x.jpg');
ok('safe image url rejects http', safeImageUrl('http://assets.ajio.com/x.jpg') === null);
ok('safe image url rejects another host', safeImageUrl('https://evil.example.com/x.jpg') === null);
ok('safe image url rejects data uri', safeImageUrl('data:image/png;base64,AAAA') === null);
ok('safe image url rejects non-string', safeImageUrl(null) === null);

console.log('\nnormalizer');
const polo = P('702723511');
ok('measurement provenance read', polo.measurement.quality === 'GARMENT_MEASURED');
ok('chest is centimetres not inches', polo.sizes.find((s) => s.size === 'M')?.garmentCm.chest === 101.6,
  JSON.stringify(polo.sizes.find((s) => s.size === 'M')?.garmentCm));
ok('chart superset intersected to buyable sizes', polo.sizes.length === 5, `got ${polo.sizes.length}`);
ok('XS charted but not buyable is excluded', !polo.sizes.some((s) => s.size === 'XS'));
ok('crowd fit matched by attribute text not index', polo.crowdFit !== null);
ok('crowd verdict runs small', polo.crowdFit.verdict === 'RUNS_SMALL', polo.crowdFit.verdict);
ok('crowd skew positive', polo.crowdFit.skew > 0, String(polo.crowdFit.skew));
ok('stock level carried through', polo.sizes.find((s) => s.size === 'L')?.stockLevel === 563);

const lowRaters = normalizeProduct({
  productDetails: {
    ...FIXTURES['702723511'].productDetails,
    ratingsResponse: {
      aggregateRating: { numUserRatings: '12' },
      subRatings: [{ productAttribute: 'How was the Product fit?', attributeRatings: [{ text: 'Perfect', percentageRating: '90 %' }] }],
    },
  },
}, { styleCode: '702723511' });
ok('few raters -> insufficient data', lowRaters.crowdFit.verdict === 'INSUFFICIENT_DATA');

console.log('\nverdicts');
const v = (code) => evaluateWearability(P(code), D(code), brief());

// The shopper owns a white shirt and black trousers, so they can already
// assemble a client-dinner look. Another shirt is honestly a restyle.
ok('another shirt when one is owned -> restyle', v('701234567').decision === 'restyle', v('701234567').decision);
ok('polo at a client dinner -> skip on register', v('702723511').decision === 'skip', v('702723511').decision);
ok('register skip is not about price',
  v('702723511').factors.some((f) => f.id === 'occasion' && f.direction === '-'));
ok('avoided slim fit -> skip', v('703456789').decision === 'skip', v('703456789').decision);
ok('duplicate black trousers -> skip', v('704567890').decision === 'skip', v('704567890').decision);
ok('undeliverable shirt -> skip', v('707890123').decision === 'skip', v('707890123').decision);
ok('over budget -> wait', v('705678901').decision === 'wait', v('705678901').decision);
ok('near-duplicate navy trousers -> restyle', v('706789012').decision === 'restyle', v('706789012').decision);

const skipFit = v('703456789');
ok('skip reason attributed to the user, not the rules',
  skipFit.factors.some((f) => f.id === 'avoided-fit' && f.source === 'user'));
ok('delivery skip attributed to product facts',
  v('707890123').factors.some((f) => f.id === 'delivery' && f.source === 'product' && f.direction === '-'));
ok('every factor carries a source', v('701234567').factors.every((f) => ['user', 'product', 'rules'].includes(f.source)));
ok('runs-small product sizes up from the middle',
  polo.crowdFit.verdict === 'RUNS_SMALL' && v('702723511').recommendedSize === 'XL',
  `${polo.crowdFit.verdict} / ${v('702723511').recommendedSize}`);
ok('true-to-size product stays mid-ladder',
  P('701234567').crowdFit.verdict === 'TRUE_TO_SIZE' && v('701234567').recommendedSize === 'L',
  v('701234567').recommendedSize);

console.log('\ndelivery honesty');
const noEta = evaluateWearability(P('701234567'),
  { serviceable: true, etaText: null, etaDays: null, pinCode: '560029', provenance: 'live' }, brief());
ok('serviceable with no date claims no date',
  noEta.factors.some((f) => f.id === 'delivery' && /did not return a date/.test(f.evidence)));
const unknown = evaluateWearability(P('701234567'), null, brief());
ok('missing evidence is not treated as deliverable',
  unknown.factors.some((f) => f.id === 'delivery' && f.direction === '0'));

console.log('\ntradeoffs');
resetSession();
ok('budget raise applies', applyTradeoff({ type: 'set_budget', value: 6000 }).ok && state.brief.budgetINR === 6000);
ok('allowing a fit removes it', applyTradeoff({ type: 'allow_fit', value: 'Slim Fit' }).ok && state.brief.avoid.fits.length === 0);
ok('bad budget rejected', applyTradeoff({ type: 'set_budget', value: -5 }).ok === false);
ok('bad pin rejected', applyTradeoff({ type: 'set_pin', value: '12' }).ok === false);
ok('unknown tradeoff rejected', applyTradeoff({ type: 'nonsense', value: 1 }).ok === false);
// The occasion dropdown snapping back to client-dinner was traced to the
// occasion change handler firing set_deadline while the server had no
// set_occasion tradeoff type — the server's brief.occasion never moved.
ok('occasion change applies', applyTradeoff({ type: 'set_occasion', value: 'weekend' }).ok && state.brief.occasion === 'weekend');
ok('unknown occasion rejected', applyTradeoff({ type: 'set_occasion', value: 'brunch' }).ok === false);

console.log('\ncustom occasions');
{
  resetSession();
  const add = applyTradeoff({ type: 'add_occasion', value: { label: 'Diwali party', register: 'formal' } });
  ok('custom occasion is added and selected', add.ok && state.brief.occasion === 'diwali-party', add.error ?? state.brief.occasion);
  ok('adding an occasion makes it valid for set_occasion',
    applyTradeoff({ type: 'set_occasion', value: 'diwali-party' }).ok === true);

  // The whole point of the tier: a label nobody hand-wrote a rule for still
  // hard-stops a polo, and the ledger can say which register did it.
  const dinner = { ...brief(), occasions: state.brief.occasions, occasion: 'diwali-party' };
  const polo = evaluateWearability(P('702723511'), D('702723511'), dinner);
  ok('a formal custom occasion hard-stops a tshirt', polo.decision === 'skip', polo.decision);
  ok('the hard stop names the register it used',
    polo.register.tier === 'formal' && polo.register.occasion === 'Diwali party', JSON.stringify(polo.register));
  ok('the factor cites the shopper\'s own label',
    polo.factors.some((f) => f.id === 'occasion' && /diwali party/.test(f.evidence)));

  applyTradeoff({ type: 'add_occasion', value: { label: 'Sunday brunch', register: 'casual' } });
  const brunch = { ...brief(), occasions: state.brief.occasions, occasion: 'sunday-brunch' };
  ok('a casual custom occasion does not hard-stop a tshirt',
    evaluateWearability(P('702723511'), D('702723511'), brunch).decision !== 'skip');

  ok('missing label rejected', applyTradeoff({ type: 'add_occasion', value: { register: 'formal' } }).ok === false);
  ok('label with no letters or digits rejected',
    applyTradeoff({ type: 'add_occasion', value: { label: '!!!', register: 'formal' } }).ok === false);
  ok('unknown register rejected',
    applyTradeoff({ type: 'add_occasion', value: { label: 'Board meeting', register: 'black-tie' } }).ok === false);
  // Labels reach the occasion dropdown and the factor prose, so markup in one
  // must never survive as markup.
  const marked = applyTradeoff({ type: 'add_occasion', value: { label: '<b>Sangeet</b>', register: 'formal' } });
  ok('markup is stripped from a custom label',
    marked.ok && state.brief.occasions.at(-1).label === 'Sangeet', state.brief.occasions.at(-1)?.label);
  // A query goes to AJIO search; anything it would not accept is refused here
  // rather than silently dropped one search later.
  ok('unsearchable query rejected',
    applyTradeoff({ type: 'add_occasion', value: { label: 'Mehendi', register: 'casual', query: 'shirt?q=<x>' } }).ok === false);

  const before = state.brief.occasions.length;
  const again = applyTradeoff({ type: 'add_occasion', value: { label: 'Diwali party', register: 'casual' } });
  ok('re-adding an occasion selects it instead of duplicating',
    again.ok && state.brief.occasions.length === before && state.brief.occasion === 'diwali-party');
  ok('re-adding does not silently rewrite the register',
    state.brief.occasions.find((o) => o.id === 'diwali-party').register === 'formal');

  ok('reset restores only the built-in occasions',
    (resetSession(), state.brief.occasions.length === 3 && state.brief.occasions.every((o) => o.builtIn)));
}

// Fail-safe. verdict.js resolves an unresolvable register to smart casual,
// which has no weakBricks — so a brief with no registry cannot manufacture a
// hard stop out of nothing. Inventing one is the worst available failure.
{
  const noRegistry = { ...brief(), occasions: undefined };
  const polo = evaluateWearability(P('702723511'), D('702723511'), noRegistry);
  ok('an unresolvable occasion never invents a hard stop',
    polo.decision !== 'skip' && polo.register.tier === 'smart-casual',
    `${polo.decision} / ${polo.register.tier}`);
}

console.log('\noccasion search query');
{
  resetSession();
  // Regression. "Goa Trip" fired "men formal shirt" because the query was
  // derived from the REGISTER, and the UI defaults the register to smart
  // casual. Register answers "how dressy", not "what garment" — a beach trip
  // and a brunch are both casual and want completely different clothes.
  ok('"Goa Trip" searches beachwear, not formal shirts',
    themeQuery('Goa Trip')?.query === 'men beachwear', JSON.stringify(themeQuery('Goa Trip')));

  const add = applyTradeoff({ type: 'add_occasion', value: { label: 'Goa Trip', register: 'smart-casual' } });
  ok('and that reaches the occasion the shopper actually added',
    add.ok && findOccasion('goa-trip').query === 'men beachwear', findOccasion('goa-trip')?.query);
  ok('the inferred query and its trigger are disclosed',
    /men beachwear/.test(add.note ?? '') && /goa/.test(add.note ?? ''), add.note);

  // A specific theme must beat a general one regardless of word order.
  ok('"Manali Trip" prefers winter over the generic trip theme',
    themeQuery('Manali Trip')?.query === 'men winter jacket', themeQuery('Manali Trip')?.query);
  ok('"Trip to Manali" too — order in the label does not matter',
    themeQuery('Trip to Manali')?.query === 'men winter jacket');
  ok('"Sangeet night" is festive, not party wear',
    themeQuery('Sangeet night')?.query === 'men festive kurta');
  ok('"Morning gym session" is activewear',
    themeQuery('Morning gym session')?.query === 'men activewear');
  ok('a label matching nothing infers nothing', themeQuery('Zblorp') === null);
  ok('an empty label infers nothing', themeQuery('') === null);

  // Substring matches would make "training" hit "rain". Word-boundary only.
  ok('"training" does not match the rain theme',
    themeQuery('Training day')?.query === 'men activewear', themeQuery('Training day')?.query);

  // No theme: falls back, and says it fell back rather than implying a choice.
  const vague = applyTradeoff({ type: 'add_occasion', value: { label: 'Zblorp', register: 'formal' } });
  ok('an unmatched label falls back to the register default',
    findOccasion('zblorp').query === 'men formal shirt', findOccasion('zblorp')?.query);
  ok('and the fallback is admitted as broad', /broad/.test(vague.note ?? ''), vague.note);

  // An explicit query always wins over inference.
  const explicit = applyTradeoff({ type: 'add_occasion', value: { label: 'Goa wedding', register: 'formal', query: 'men linen shirt' } });
  ok('an explicit query overrides the theme',
    explicit.ok && findOccasion('goa-wedding').query === 'men linen shirt');

  // A guess you cannot correct is just a wrong answer.
  applyTradeoff({ type: 'set_occasion', value: 'goa-trip' });
  ok('the query can be retargeted',
    applyTradeoff({ type: 'set_occasion_query', value: 'men swimwear' }).ok
    && findOccasion('goa-trip').query === 'men swimwear');
  ok('retargeting a built-in works too',
    (applyTradeoff({ type: 'set_occasion', value: 'work' }),
      applyTradeoff({ type: 'set_occasion_query', value: 'men chinos' }).ok
      && findOccasion('work').query === 'men chinos'));
  ok('an empty query rejected', applyTradeoff({ type: 'set_occasion_query', value: '  ' }).ok === false);
  ok('an unsearchable query rejected',
    applyTradeoff({ type: 'set_occasion_query', value: 'shirt?q=<x>' }).ok === false);
  ok('markup stripped from a retargeted query',
    applyTradeoff({ type: 'set_occasion_query', value: '<b>men shorts</b>' }).ok
    && findOccasion('work').query === 'men shorts', findOccasion('work')?.query);
  resetSession();
  ok('reset restores a built-in query', findOccasion('work').query === 'men formal shirt');
}

console.log('\nwardrobe');
{
  resetSession();
  // duplicateRisk() and looksUnlocked() compare exact brick strings, so an
  // un-canonicalised category is stored but influences nothing. That silent
  // no-op is what this map exists to prevent.
  ok('"jeans" canonicalises to Jeans', canonicalBrick('jeans').brick === 'Jeans');
  ok('"T-Shirt" canonicalises to Tshirts', canonicalBrick('T-Shirt').brick === 'Tshirts');
  ok('"chinos" canonicalises to Trousers & Pants', canonicalBrick('chinos').brick === 'Trousers & Pants');
  ok('a canonical brick round-trips', canonicalBrick('Trousers & Pants').brick === 'Trousers & Pants');
  ok('"polo shirt" prefers Tshirts over Shirts', canonicalBrick('polo shirt').brick === 'Tshirts',
    canonicalBrick('polo shirt').brick);
  ok('a phrase matches on a contained word', canonicalBrick('black formal trousers').brick === 'Trousers & Pants');
  ok('a kurta is now a scored category', canonicalBrick('kurta').brick === 'Kurtas');
  ok('"kurta set" beats the bare "kurta" word', canonicalBrick('kurta set').brick === '2-Piece Ethnic Suit');
  ok('a jacket is a coat, not a blazer', canonicalBrick('jacket').brick === 'Jackets & Coats');
  ok('a suit is a suit set, not a blazer', canonicalBrick('suit').brick === 'Suit Sets');
  ok('a blazer is still a blazer', canonicalBrick('navy blazer').brick === 'Blazers & Waistcoats');
  ok('an unmatched category is reported, not guessed',
    canonicalBrick('socks').brick === null && canonicalBrick('socks').recognised === false);

  const add = applyTradeoff({ type: 'add_wardrobe_item', value: { category: 'blazer', color: 'Charcoal' } });
  ok('a typed category is filed under its brick',
    add.ok && state.brief.wardrobe.at(-1).category === 'Blazers & Waistcoats', state.brief.wardrobe.at(-1)?.category);
  ok('filing under a different brick is disclosed', /Blazers & Waistcoats/.test(add.note ?? ''), add.note);

  // The end-to-end claim: an item typed by hand actually moves a verdict.
  // The blazer is the demo's one buy once the budget is raised; owning it
  // already has to turn that into a duplicate skip.
  const owned = { ...brief(), budgetINR: 6000, wardrobe: state.brief.wardrobe };
  const blazer = evaluateWearability(P('705678901'), D('705678901'), owned);
  ok('an added item reaches the verdict', blazer.decision === 'skip', blazer.decision);
  ok('and is attributed to the shopper',
    blazer.factors.some((f) => f.id === 'duplicate' && f.source === 'user'));

  const bareString = applyTradeoff({ type: 'add_wardrobe_item', value: 'Jeans' });
  ok('a bare string is accepted as the category',
    bareString.ok && state.brief.wardrobe.at(-1).category === 'Jeans');
  ok('adding the same category and colour twice changes nothing',
    applyTradeoff({ type: 'add_wardrobe_item', value: 'Jeans' }).changed === false);

  const unknown = applyTradeoff({ type: 'add_wardrobe_item', value: { category: 'Socks', color: 'Grey' } });
  const stored = state.brief.wardrobe.at(-1);
  ok('an unscorable item is still listed', unknown.ok && stored.category === 'Socks');
  ok('and is marked as unscored rather than looking accepted',
    stored.recognised === false && /will not move any verdict/.test(unknown.note ?? ''), unknown.note);

  ok('markup is stripped from a category',
    applyTradeoff({ type: 'add_wardrobe_item', value: { category: '<i>Socks</i>', color: 'Blue' } }).ok
    && state.brief.wardrobe.at(-1).category === 'Socks', state.brief.wardrobe.at(-1)?.category);
  ok('a category with no text rejected', applyTradeoff({ type: 'add_wardrobe_item', value: { color: 'Red' } }).ok === false);

  const id = state.brief.wardrobe.at(-1).id;
  const n = state.brief.wardrobe.length;
  ok('removing by id drops exactly one item',
    applyTradeoff({ type: 'remove_wardrobe_item', value: id }).ok && state.brief.wardrobe.length === n - 1);
  ok('removing an unknown id rejected',
    applyTradeoff({ type: 'remove_wardrobe_item', value: 'nope' }).ok === false);
  ok('removing with no id rejected',
    applyTradeoff({ type: 'remove_wardrobe_item', value: '' }).ok === false);
  resetSession();
}

const raised = evaluateWearability(P('705678901'), D('705678901'), { ...brief(), budgetINR: 6000 });
ok('raising budget turns the blazer into the buy', raised.decision === 'buy', raised.decision);
ok('nothing is a buy at the starting budget',
  Object.keys(FIXTURES).every((c) => v(c).decision !== 'buy'));

console.log('\ncategory taxonomy');
{
  // Before this, a beachwear list scored mostly `buy` on price and fit alone:
  // Swimwear and Co-ord Sets were in no tier and no top/bottom list, so the
  // register factor was absent and duplicateRisk was always 0. An engine that
  // rubber-stamps a category it cannot reason about is the wrong failure for
  // an app whose argument is recommending nothing when nothing is worth it.
  const synth = (brick, color = 'Blue', price = 1200) => ({
    styleCode: '900000001', color, category: { brick },
    price: { currentINR: price, mrpINR: price },
    fit: { type: 'Regular Fit' }, measurement: { quality: 'GARMENT_MEASURED' },
    sizes: [{ size: 'M', inStock: true }, { size: 'L', inStock: true }],
    crowdFit: null, provenance: 'live',
  });
  const at = (occasionId, register, product, wardrobe = []) => evaluateWearability(
    product,
    { serviceable: true, etaText: '2-3 days', etaDays: 2, pinCode: '560029', provenance: 'live' },
    { ...brief(), wardrobe, occasion: occasionId, occasions: [{ id: occasionId, label: 'Test', register }] },
  );

  // Every category must be classified by at least ONE register — not by all
  // three. A coat over formalwear and a co-ord set at a formal dinner are
  // deliberately neutral: neither a recommendation nor a hard stop.
  for (const brick of ['Swimwear', 'Co-ord Sets', 'Kurtas', 'Track Pants', 'Shorts & 3/4ths',
    'Sweatshirt & Hoodies', 'Suit Sets', '2-Piece Ethnic Suit', 'Jackets & Coats']) {
    const classified = ['formal', 'smart-casual', 'casual']
      .filter((reg) => at('x', reg, synth(brick)).factors.some((f) => f.id === 'occasion'));
    ok(`${brick} is visible to at least one register`,
      classified.length > 0, `no register classifies ${brick}`);
  }

  ok('swimwear is a hard stop at a formal occasion',
    at('x', 'formal', synth('Swimwear')).decision === 'skip');
  ok('and the prose reads as English',
    at('x', 'formal', synth('Swimwear')).factors
      .some((f) => f.id === 'occasion' && /A swimsuit does not read as/.test(f.evidence)),
    JSON.stringify(at('x', 'formal', synth('Swimwear')).factors.find((f) => f.id === 'occasion')?.evidence));
  ok('a kurta reads right at a formal occasion',
    at('x', 'formal', synth('Kurtas')).factors
      .some((f) => f.id === 'occasion' && f.direction === '+'));
  ok('a suit is a hard stop at a casual occasion',
    at('x', 'casual', synth('Suit Sets')).decision === 'skip');
  ok('shorts read right at a casual occasion',
    at('x', 'casual', synth('Shorts & 3/4ths')).factors
      .some((f) => f.id === 'occasion' && f.direction === '+'));
  // An ethnic suit at a brunch is overdressed, not embarrassing. Deliberately
  // not a hard stop — the claim would be too strong.
  ok('an ethnic suit is not a hard stop at a casual occasion',
    at('x', 'casual', synth('2-Piece Ethnic Suit')).decision !== 'skip');

  // The smart-casual fail-safe must survive the tier expansion.
  ok('smart casual still hard-stops nothing',
    ['Swimwear', 'Tshirts', 'Suit Sets', 'Track Pants', 'Blazers & Waistcoats']
      .every((b) => at('x', 'smart-casual', synth(b)).decision !== 'skip'));

  // Duplicate detection now covers the new categories.
  const ownsTrunks = [{ id: 'w9', category: 'Swimwear', color: 'Blue', descriptor: 'Blue trunks', recognised: true }];
  ok('owning swimwear makes more swimwear a duplicate',
    at('x', 'casual', synth('Swimwear', 'Blue'), ownsTrunks).decision === 'skip');
  ok('a different colour is a near-duplicate, not a duplicate',
    at('x', 'casual', synth('Swimwear', 'Red'), ownsTrunks).duplicateRisk === 0.55);

  // A whole outfit is already the look; it unlocks nothing by pairing.
  const ownsBottoms = [{ id: 'w8', category: 'Jeans', color: 'Blue', descriptor: 'Blue jeans', recognised: true }];
  ok('a hoodie pairs with owned bottoms',
    at('x', 'casual', synth('Sweatshirt & Hoodies'), ownsBottoms).looksUnlocked === 1);
  ok('a co-ord set unlocks no pairings by design',
    at('x', 'casual', synth('Co-ord Sets'), ownsBottoms).looksUnlocked === 1);
  ok('track pants count as a bottom against owned tops',
    at('x', 'casual', synth('Track Pants'),
      [{ id: 'w7', category: 'Tshirts', color: 'Black', descriptor: 'Black tee', recognised: true },
        { id: 'w6', category: 'Kurtas', color: 'White', descriptor: 'White kurta', recognised: true }])
      .looksUnlocked === 2);
}

console.log('\nstyle-code allowlist');
{
  // Regression guard. Live search loads real style codes; if the allowlist
  // doesn't learn them, getProductTruth rejects every candidate and the app
  // renders an empty list under a confident "Live AJIO data" badge.
  const live = '999888777';
  ok('a code the server has not seen is refused', isAllowedStyleCode(live) === false);
  ok('fixture codes are always allowed', isAllowedStyleCode(Object.keys(FIXTURES)[0]) === true);
  allowStyleCodes([live]);
  ok('a code returned by AJIO search becomes fetchable', isAllowedStyleCode(live) === true);
  allowStyleCodes(['not-a-code', '12']);
  ok('malformed codes are never admitted', isAllowedStyleCode('not-a-code') === false && isAllowedStyleCode('12') === false);
  clearAllowedStyleCodes();
  ok('reset revokes search-earned codes', isAllowedStyleCode(live) === false);
}

console.log('\nhandoff gate');
resetSession();
const id = createHandoff({ styleCode: '701234567', size: 'L', pdpUrl: 'https://www.ajio.com/x/p/y' });
ok('wrong size rejected', consumeHandoff(id, { styleCode: '701234567', size: 'M' }).ok === false);
ok('correct pair accepted', consumeHandoff(id, { styleCode: '701234567', size: 'L' }).ok === true);
ok('token is single use', consumeHandoff(id, { styleCode: '701234567', size: 'L' }).ok === false);
ok('unknown token rejected', consumeHandoff('made-up-id', { styleCode: '701234567', size: 'L' }).ok === false);
// A client whose pendingHandoff got orphaned (server reset while modal was
// open) sends undefined for the id. The server must respond cleanly with
// 'no such confirmation' rather than crash — the UI shows this to the shopper
// and clears the modal so a fresh click retries.
const orphan = consumeHandoff(undefined, { styleCode: '701234567', size: 'L' });
ok('orphaned token: undefined id rejected cleanly', orphan.ok === false && orphan.error === 'no such confirmation', orphan.error);



console.log('\nlive-data edge cases');
{
  // A live product came back with a whitespace-only fittingType, which is
  // truthy — it fired a "Fit works for you" factor with blank evidence.
  const raw = structuredClone(FIXTURES['701234567']);
  raw.productDetails.featureData = raw.productDetails.featureData.filter((f) => f.name !== 'Fit');
  raw.productDetails.sizeData.fittingType = '   ';
  const p = normalizeProduct(raw, { provenance: 'fixture', styleCode: '701234567' });
  ok('whitespace-only fit type normalizes to null', p.fit.type === null, JSON.stringify(p.fit.type));
  const vv = evaluateWearability(p, D('701234567'), brief());
  ok('no factor is emitted with empty evidence', vv.factors.every((f) => String(f.evidence).trim().length > 0),
    JSON.stringify(vv.factors.filter((f) => !String(f.evidence).trim()).map((f) => f.label)));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
