/**
 * Demo fixtures, stored in RAW AJIO aggregator shape.
 *
 * These are NOT live AJIO values. Anything served from here is tagged
 * provenance:'fixture' and the UI must label it as demo data.
 *
 * Only the first entry (702723511) mirrors measurements observed on a real
 * public AJIO PDP. The rest are invented for the demo scenario and are
 * plausible rather than real.
 */

const GRADE = (baseChest, sizes) =>
  sizes.map((s, i) => ({
    sizeName: s,
    sizePriority: String(440 + i),
    sizeChartAttributes: [
      { attributeName: 'Chest_attribute', attributeValue: String(36 + i * 2), convertedAttributeValue: (baseChest + i * 5.08).toFixed(2) },
      { attributeName: 'Shoulder_attribute', attributeValue: String(16.5 + i * 0.5), convertedAttributeValue: (41.91 + i * 1.27).toFixed(2) },
      { attributeName: 'Length_attribute', attributeValue: String(25 + i), convertedAttributeValue: (63.5 + i * 2.54).toFixed(2) },
      { attributeName: 'Brand Size_attribute', attributeValue: s, convertedAttributeValue: s },
    ],
    sizeChartInternationalConversions: [],
    sizeChartBrandComparisions: [],
  }));

const WAIST = (baseWaist, sizes) =>
  sizes.map((s, i) => ({
    sizeName: s,
    sizePriority: String(440 + i),
    sizeChartAttributes: [
      { attributeName: 'Waist_attribute', attributeValue: String(30 + i * 2), convertedAttributeValue: (baseWaist + i * 5.08).toFixed(2) },
      { attributeName: 'Inseam_attribute', attributeValue: '31', convertedAttributeValue: '78.74' },
      { attributeName: 'Hip_attribute', attributeValue: String(38 + i * 2), convertedAttributeValue: (96.5 + i * 5.08).toFixed(2) },
      { attributeName: 'Brand Size_attribute', attributeValue: s, convertedAttributeValue: s },
    ],
    sizeChartInternationalConversions: [],
    sizeChartBrandComparisions: [],
  }));

const variants = (styleCode, sizes, stockBySize, priceINR) =>
  sizes.map((s, i) => ({
    code: `${styleCode}${String(i + 1).padStart(3, '0')}`,
    scDisplaySize: s,
    variantOptionQualifiers: [
      { qualifier: 'size', value: s },
      { qualifier: 'standardSize', value: s },
    ],
    stock: {
      stockLevelStatus: (stockBySize[s] ?? 0) > 0 ? 'inStock' : 'outOfStock',
      stockLevel: stockBySize[s] ?? 0,
    },
    priceData: { value: priceINR, currencyIso: 'INR' },
  }));

const ratings = (perfect, tight, tooTight, loose, tooLoose, raters) => ({
  aggregateRating: { averageRating: 4.0, numUserRatings: raters },
  subRatings: [
    {
      productAttribute: 'How was the Product Quality?',
      attributeRatings: [{ text: 'Excellent', percentageRating: '30 %' }],
    },
    {
      productAttribute: 'How was the Product fit?',
      attributeRatings: [
        { text: 'Perfect', percentageRating: `${perfect} %` },
        { text: 'Loose', percentageRating: `${loose} %` },
        { text: 'Tight', percentageRating: `${tight} %` },
        { text: 'Too Loose', percentageRating: `${tooLoose} %` },
        { text: 'Too Tight', percentageRating: `${tooTight} %` },
      ],
    },
  ],
});

const product = ({
  styleCode, code, brand, name, color, price, mrp, brick, vertical,
  fit, fabric, styleType, sizes, chart, stock, rating, urlSlug,
}) => ({
  productDetails: {
    baseProduct: styleCode,
    code,
    name,
    brandName: brand,
    brickCategory: 'Men',
    brickSubCategory: vertical,
    brickName: brick,
    brickCode: '830216013',
    url: `/${urlSlug}/p/${code}`,
    isReturnable: true,
    returnWindow: 10,
    price: { value: price, currencyIso: 'INR', discountValue: mrp ? Math.round((1 - price / mrp) * 100) : null },
    wasPriceData: { value: mrp },
    baseOptions: [{ selected: { isExchangeable: 'true', priceData: { value: price } } }],
    fnlColorVariantData: { brandName: brand, color },
    featureData: [
      { name: 'Fabric', featureValues: [{ value: fabric }] },
      { name: 'Fit', featureValues: [{ value: fit }] },
      { name: 'Style Type', featureValues: [{ value: styleType }] },
    ],
    sizeData: {
      brickCode: '830216013',
      brandCode: brand.toLowerCase().replace(/[^a-z]+/g, '-'),
      vendorCode: '',
      fittingType: fit,
      sizechart: [{
        measurementType: 'Garment Measurement',
        gender: 'Men',
        brickName: brick,
        brandName: brand,
        brickBrandSizes: chart,
      }],
    },
    variantOptions: variants(styleCode, sizes, stock, price),
    ratingsResponse: rating,
  },
});

export const FIXTURES = {
  // Measurements here mirror a real public AJIO PDP (Buda Jeans Co polo).
  '702723511': product({
    styleCode: '703376663', code: '703376663_navy', brand: 'Buda Jeans Co',
    name: 'Men Regular Fit Polo T-Shirt', color: 'Blue', price: 320, mrp: 999,
    brick: 'Tshirts', vertical: 'Western Wear', fit: 'Regular Fit',
    fabric: 'Cotton', styleType: 'Polo', urlSlug: 'buda-jeans-co-men-regular-fit-polo-t-shirt',
    sizes: ['S', 'M', 'L', 'XL', 'XXL'],
    chart: GRADE(91.44, ['XS', 'S', 'M', 'L', 'XL', 'XXL', '5XL', '6XL']),
    stock: { S: 294, M: 276, L: 563, XL: 614, XXL: 301 },
    rating: ratings(64, 15, 5, 11, 3, '2.1K'),
  }),

  '701234567': product({
    styleCode: '469704951', code: '469704951_green', brand: 'Arrow',
    name: 'Men Regular Fit Cotton Polo T-Shirt', color: 'Navy', price: 1799, mrp: 2999,
    brick: 'Shirts', vertical: 'Western Wear', fit: 'Regular Fit',
    fabric: 'Cotton Blend', styleType: 'Formal', urlSlug: 'arrow-men-regular-fit-textured-shirt',
    sizes: ['S', 'M', 'L', 'XL', 'XXL'],
    chart: GRADE(96.52, ['S', 'M', 'L', 'XL', 'XXL']),
    stock: { S: 40, M: 120, L: 210, XL: 95, XXL: 30 },
    rating: ratings(78, 9, 3, 8, 2, '1.4K'),
  }),

  '703456789': product({
    styleCode: '700823829', code: '700823829_white', brand: 'Louis Philippe',
    name: 'Men Slim Fit Solid Shirt', color: 'White', price: 2199, mrp: 3299,
    brick: 'Shirts', vertical: 'Western Wear', fit: 'Slim Fit',
    fabric: 'Cotton', styleType: 'Formal', urlSlug: 'louis-philippe-men-slim-fit-solid-shirt',
    sizes: ['S', 'M', 'L', 'XL'],
    chart: GRADE(94.0, ['S', 'M', 'L', 'XL']),
    stock: { S: 22, M: 60, L: 44, XL: 12 },
    rating: ratings(52, 26, 9, 10, 3, '860'),
  }),

  '704567890': product({
    styleCode: '704567890', code: '704567890_black', brand: 'Van Heusen',
    name: 'Men Regular Fit Formal Trousers', color: 'Black', price: 2499, mrp: 3499,
    brick: 'Trousers & Pants', vertical: 'Western Wear', fit: 'Regular Fit',
    fabric: 'Poly Viscose', styleType: 'Formal', urlSlug: 'van-heusen-men-regular-fit-formal-trousers',
    sizes: ['30', '32', '34', '36'],
    chart: WAIST(76.2, ['30', '32', '34', '36']),
    stock: { 30: 18, 32: 90, 34: 70, 36: 25 },
    rating: ratings(71, 12, 4, 10, 3, '540'),
  }),

  '705678901': product({
    styleCode: '705678901', code: '705678901_charcoal', brand: 'Blackberrys',
    name: 'Men Regular Fit Single-Breasted Blazer', color: 'Charcoal', price: 4999, mrp: 8999,
    brick: 'Blazers & Waistcoats', vertical: 'Western Wear', fit: 'Regular Fit',
    fabric: 'Poly Wool', styleType: 'Formal', urlSlug: 'blackberrys-men-regular-fit-blazer',
    sizes: ['38', '40', '42', '44'],
    chart: GRADE(96.52, ['38', '40', '42', '44']),
    stock: { 38: 8, 40: 30, 42: 22, 44: 6 },
    rating: ratings(69, 14, 5, 9, 3, '310'),
  }),

  '706789012': product({
    styleCode: '706789012', code: '706789012_navy', brand: 'Netplay',
    name: 'Men Regular Fit Formal Trousers', color: 'Navy', price: 2299, mrp: 2999,
    brick: 'Trousers & Pants', vertical: 'Western Wear', fit: 'Regular Fit',
    fabric: 'Poly Viscose', styleType: 'Formal', urlSlug: 'netplay-men-regular-fit-formal-trousers',
    sizes: ['30', '32', '34', '36'],
    chart: WAIST(76.2, ['30', '32', '34', '36']),
    stock: { 30: 12, 32: 55, 34: 48, 36: 20 },
    rating: ratings(74, 11, 3, 9, 3, '420'),
  }),

  // In budget, right fit, not a duplicate. The only thing wrong with it is that
  // it cannot reach the PIN code — so it isolates the delivery rule.
  '707890123': product({
    styleCode: '707890123', code: '707890123_olive', brand: 'The Bear House',
    name: 'Men Regular Fit Mandarin Collar Shirt', color: 'Olive', price: 1649, mrp: 2499,
    brick: 'Shirts', vertical: 'Western Wear', fit: 'Regular Fit',
    fabric: 'Cotton', styleType: 'Formal', urlSlug: 'the-bear-house-men-regular-fit-mandarin-collar-shirt',
    sizes: ['S', 'M', 'L', 'XL'],
    chart: GRADE(96.52, ['S', 'M', 'L', 'XL']),
    stock: { S: 30, M: 80, L: 65, XL: 40 },
    rating: ratings(76, 10, 3, 8, 3, '690'),
  }),
};

/**
 * Delivery fixtures, per style code. Each one isolates a different rule so the
 * demo can show all four verdicts and both distinct skip reasons.
 *
 *   701234567  serviceable, in time      -> buy
 *   702723511  serviceable, in time      -> weak for the occasion
 *   703456789  serviceable               -> skip on avoided fit
 *   704567890  serviceable               -> skip on duplicate
 *   705678901  serviceable, in time      -> wait on budget
 *   706789012  serviceable, in time      -> restyle on near-duplicate
 *   707890123  NOT serviceable           -> skip on delivery
 */
export const EDD_FIXTURES = {
  '701234567': { serviceable: true, codEligible: true, etaText: '2-3 days', etaDays: 3 },
  '702723511': { serviceable: true, codEligible: true, etaText: '3-4 days', etaDays: 4 },
  '703456789': { serviceable: true, codEligible: false, etaText: '3-4 days', etaDays: 4 },
  '704567890': { serviceable: true, codEligible: true, etaText: '2-3 days', etaDays: 3 },
  '705678901': { serviceable: true, codEligible: true, etaText: '3-4 days', etaDays: 4 },
  '706789012': { serviceable: true, codEligible: true, etaText: '2-3 days', etaDays: 3 },
  '707890123': { serviceable: false, codEligible: false, etaText: null, etaDays: null, reason: 'Not serviceable at this PIN code' },
};

export const DEMO_STYLE_CODES = Object.keys(FIXTURES);
