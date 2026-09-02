/**
 * Normalizes a raw AJIO PDP-aggregator payload into ProductTruth.
 *
 * Every field read here was verified against a live AJIO PDP preloaded state.
 * Fixtures are stored in raw shape deliberately so this code path runs in
 * fallback mode too — a normalizer that only executes against live data is a
 * normalizer that breaks on the first live call.
 */

const CM = 'convertedAttributeValue';

/** Seller-supplied strings are untrusted input. Never let them reach a tool result raw. */
export function sanitize(value, max = 200) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Seller-supplied URLs are untrusted. Only accept HTTPS URLs on AJIO's asset
 * CDN — anything else could ferry a tracker or a data-uri payload into the UI.
 * Returns null on anything that fails the check.
 */
export function safeImageUrl(u) {
  if (typeof u !== 'string' || u.length > 500) return null;
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return null;
    if (!/^assets\.ajio\.com$/i.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

/** Pick a card-appropriate image out of the aggregator's image array. */
function pickCardImage(images, fallback) {
  const prefer = ['mobileProductListingImage', 'listingImage', 'mediumProductImage'];
  if (Array.isArray(images)) {
    for (const fmt of prefer) {
      const hit = images.find((im) => im?.format === fmt && typeof im?.url === 'string');
      if (hit) { const u = safeImageUrl(hit.url); if (u) return u; }
    }
    for (const im of images) {
      if (typeof im?.url === 'string') { const u = safeImageUrl(im.url); if (u) return u; }
    }
  }
  return safeImageUrl(fallback);
}

/** "2.1K" / "1,059" / 2100 -> 2100. Returns null when it cannot be trusted. */
export function parseRaterCount(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.round(raw);
  if (typeof raw !== 'string') return null;
  const m = raw.trim().replace(/,/g, '').match(/^([\d.]+)\s*([KLkl])?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = m[2] ? (m[2].toUpperCase() === 'K' ? 1e3 : 1e5) : 1;
  return Math.round(n * mult);
}

/** "15 %" -> 15. The space before the percent sign is real AJIO formatting. */
function parsePct(raw) {
  if (typeof raw === 'number') return raw;
  const n = parseInt(String(raw ?? '').replace(/\s/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function attrMap(sizeChartAttributes = []) {
  const out = {};
  for (const a of sizeChartAttributes) {
    const key = String(a.attributeName || '').replace(/_attribute$/i, '').trim().toLowerCase();
    if (key) out[key] = a[CM] ?? a.attributeValue;
  }
  return out;
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : undefined;
}

/**
 * Chart lists more sizes than are purchasable (verified: 8 charted, 5 buyable).
 * Only sizes present in BOTH are ever returned.
 */
function buildSizes(sizeData, variantOptions = []) {
  const chart = sizeData?.sizechart?.[0];
  const rows = chart?.brickBrandSizes ?? [];

  const buyable = new Map();
  for (const v of variantOptions) {
    const q = Object.fromEntries((v.variantOptionQualifiers ?? []).map((x) => [x.qualifier, x.value]));
    const label = v.scDisplaySize || q.standardSize || q.size;
    if (!label) continue;
    buyable.set(String(label), {
      sku: v.code,
      inStock: v.stock?.stockLevelStatus === 'inStock',
      stockLevel: Number(v.stock?.stockLevel ?? 0),
      priceINR: Number(v.priceData?.value ?? 0) || undefined,
    });
  }

  const sizes = [];
  for (const row of rows) {
    const label = String(row.sizeName ?? '');
    const stock = buyable.get(label);
    if (!stock) continue;
    const a = attrMap(row.sizeChartAttributes);
    sizes.push({
      size: label,
      brandSize: a['brand size'] ?? label,
      priority: Number(row.sizePriority ?? 0),
      garmentCm: {
        chest: num(a.chest),
        shoulder: num(a.shoulder),
        length: num(a.length),
        waist: num(a.waist),
        hip: num(a.hip),
        inseam: num(a.inseam),
        rise: num(a.rise),
        sleeve: num(a.sleeve),
      },
      ...stock,
    });
  }

  // Charts with no measurement rows still have buyable variants worth surfacing.
  if (sizes.length === 0) {
    for (const [label, stock] of buyable) {
      sizes.push({ size: label, brandSize: label, priority: 0, garmentCm: {}, ...stock });
    }
  }

  sizes.sort((a, b) => a.priority - b.priority);
  return sizes;
}

function buildCrowdFit(ratingsResponse) {
  const sub = ratingsResponse?.subRatings ?? [];
  // Match on the attribute text, never on index — order is not guaranteed.
  const fit = sub.find((s) => /fit/i.test(String(s.productAttribute ?? '')));
  if (!fit) return null;

  const pct = {};
  for (const r of fit.attributeRatings ?? []) pct[String(r.text ?? '').trim()] = parsePct(r.percentageRating);

  const perfect = pct['Perfect'] ?? 0;
  const tight = pct['Tight'] ?? 0;
  const tooTight = pct['Too Tight'] ?? 0;
  const loose = pct['Loose'] ?? 0;
  const tooLoose = pct['Too Loose'] ?? 0;

  // Too Tight / Too Loose weight double: a full size off, not a preference.
  const tightScore = tight + 2 * tooTight;
  const looseScore = loose + 2 * tooLoose;
  const raters = parseRaterCount(ratingsResponse?.aggregateRating?.numUserRatings);

  // Threshold of 6 on the weighted scores. At the rater counts these products
  // carry (hundreds to thousands), the standard error on a ~20% proportion is
  // around one point, so a 6-point weighted gap is several standard errors —
  // a real signal, not noise. Below 50 raters we refuse to call it at all.
  const THRESHOLD = 6;

  let verdict;
  if (raters === null || raters < 50) verdict = 'INSUFFICIENT_DATA';
  else if (tightScore > looseScore + THRESHOLD) verdict = 'RUNS_SMALL';
  else if (looseScore > tightScore + THRESHOLD) verdict = 'RUNS_LARGE';
  else verdict = 'TRUE_TO_SIZE';

  return {
    perfect, tight, tooTight, loose, tooLoose,
    raters,
    skew: Math.round(((tightScore - looseScore) / 100) * 100) / 100,
    verdict,
  };
}

function featureValue(featureData = [], name) {
  const f = featureData.find((x) => String(x.name ?? '').toLowerCase() === name.toLowerCase());
  return sanitize(f?.featureValues?.[0]?.value ?? '', 60) || null;
}

export function normalizeProduct(raw, { provenance = 'fixture', styleCode = null } = {}) {
  const p = raw?.productDetails ?? raw ?? {};
  const sizeData = p.sizeData ?? safeParse(p.fnlColorVariantData?.sizeGuideDesktop);
  const chart = sizeData?.sizechart?.[0];

  const measurementType = chart?.measurementType ?? null;
  const provenanceOfMeasurement =
    measurementType === 'Garment Measurement' ? 'GARMENT_MEASURED'
      : measurementType === 'Body Measurement' ? 'BODY_MEASURED'
        : 'INFERRED';

  const price = Number(p.price?.value ?? p.baseOptions?.[0]?.selected?.priceData?.value ?? 0) || null;
  const mrp = Number(p.wasPriceData?.value ?? 0) || null;

  return {
    styleCode: styleCode ?? p.baseProduct ?? null,
    code: p.code ?? null,
    brand: sanitize(p.brandName ?? p.fnlColorVariantData?.brandName ?? '', 60) || null,
    name: sanitize(p.name ?? '', 120) || null,
    color: sanitize(p.fnlColorVariantData?.color ?? '', 40) || null,
    pdpUrl: p.url ? `https://www.ajio.com${p.url}` : null,
    imageUrl: pickCardImage(p.images, p.fnlColorVariantData?.outfitPictureURL),

    price: {
      currentINR: price,
      mrpINR: mrp,
      discountPct: p.price?.discountValue ?? null,
    },

    category: {
      segment: sanitize(p.brickCategory ?? '', 40) || null,
      vertical: sanitize(p.brickSubCategory ?? '', 40) || null,
      brick: sanitize(p.brickName ?? '', 40) || null,
      brickCode: p.brickCode ?? null,
    },

    fit: {
      // Live products sometimes carry a whitespace-only fittingType. Treat it
      // as absent — otherwise it is truthy and renders an empty factor row.
      type: featureValue(p.featureData, 'Fit') ?? blankToNull(sizeData?.fittingType),
      fabricLabel: featureValue(p.featureData, 'Fabric'),
      styleType: featureValue(p.featureData, 'Style Type'),
    },

    measurement: { type: measurementType, quality: provenanceOfMeasurement },
    sizes: buildSizes(sizeData, p.variantOptions),
    crowdFit: buildCrowdFit(p.ratingsResponse),

    returns: {
      isReturnable: p.isReturnable === true || p.isReturnable === 'true',
      windowDays: Number(p.returnWindow ?? 0) || null,
      isExchangeable: p.baseOptions?.[0]?.selected?.isExchangeable === 'true',
    },

    provenance,
  };
}

function blankToNull(v) {
  const t = typeof v === 'string' ? v.trim() : '';
  return t.length ? t : null;
}

function safeParse(s) {
  if (typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch { return null; }
}
