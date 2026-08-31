/**
 * Self-check. No test framework — `node scripts/selfcheck.js`.
 * Covers the parsing traps and the decision rules that the demo depends on.
 */

import { normalizeProduct, parseRaterCount, sanitize, safeImageUrl } from '../lib/normalize.js';
import { evaluateWearability } from '../lib/verdict.js';
import { FIXTURES, EDD_FIXTURES } from '../lib/fixtures.js';
import { isAllowedStyleCode, allowStyleCodes, clearAllowedStyleCodes } from '../lib/upstream.js';
import { applyTradeoff, state, createHandoff, consumeHandoff, resetSession } from '../lib/state.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};

// Must mirror DEFAULT_BRIEF in lib/state.js. If they drift, the tests stop
// describing the app the demo actually runs.
const brief = () => ({
  occasion: 'client-dinner', city: 'Bengaluru', pin: '560029',
  budgetINR: 3000, deadline: isoIn(5),
  avoid: { fits: ['Slim Fit'], colors: [] },
  wardrobe: [
    { id: 'w1', category: 'Trousers & Pants', color: 'Black', descriptor: 'Black formal trousers' },
    { id: 'w2', category: 'Shirts', color: 'White', descriptor: 'White cotton shirt' },
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

const raised = evaluateWearability(P('705678901'), D('705678901'), { ...brief(), budgetINR: 6000 });
ok('raising budget turns the blazer into the buy', raised.decision === 'buy', raised.decision);
ok('nothing is a buy at the starting budget',
  Object.keys(FIXTURES).every((c) => v(c).decision !== 'buy'));

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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
