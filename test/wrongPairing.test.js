// Batilda (Actona): Black/Anthracite variants carry Cream's variant numbers → SKU typo with the right SKU.
const assert = require('assert');
const { buildCompareData } = require('../Claude outputs/fix-wrong-variant-no/new/utils/cfsApi');
const { compareVariants } = require('../Claude outputs/fix-wrong-variant-no/new/utils/matchVariants');
const { runChecks } = require('../Claude outputs/fix-wrong-variant-no/new/utils/storeHealth');

const packs = ['2 x Chairs', '4 x Chairs', '6 x Chairs', '8 x Chairs', '10 x Chairs', '12 x Chairs'];
const feed = [
  { productId: 1271925, productName: '2 x Batilda Swivel Anthracite', variants: packs.map((o, i) => ({ variantId: 17373736 + i, variantOption: o })) },
  { productId: 1271926, productName: '2 x Batilda Swivel Cream', variants: packs.map((o, i) => ({ variantId: 17373742 + i, variantOption: o })) },
  { productId: 999, productName: 'Other', variants: [{ variantId: 555, variantOption: 'Big' }] },
];
const d = buildCompareData(feed);
const cmp = rows => compareVariants(rows, d.validVariantSKUs, d.validProductSKUs, d.cfsProductIds, d.cfsVariantAttrIds,
  d.productCodesBySku, d.productCodesByProdId, d.variantCodesBySku, d.variantCodesByAttrId, d.cfsVarCodeSet, d.cfsProductCodeToStatus, d.cfsVarInfo).results;
const row = (sku, o1 = '', o2 = '') => ({ handle: 'batilda', title: 'Batilda', variantSku: sku, option1: o1, option2: o2, status: 'active' });

const r = cmp([
  row('UD-1271926-17373742', 'Cream', '2 x Chairs'),   // correct
  row('UD-1271925-17373742', 'Black', '2 x Chairs'),   // Cream's number on Anthracite
  row('UD-1271925-17373747'),                           // no Shopify options → use the option of the number's owner (12 x Chairs)
  row('UD-1271925-555', 'Black', 'Big'),               // number from another product, no matching option → orphaned
]);
assert.strictEqual(r[0].matchStatus, 'ok');
assert.strictEqual(r[1].matchStatus, 'sku-typo'); assert.strictEqual(r[1].fixedSku, 'UD-1271925-17373736');
assert(/belongs to another CFS product \(1271926 "2 x Chairs"\)/.test(r[1].codeOnlyNote), r[1].codeOnlyNote);
assert.strictEqual(r[2].matchStatus, 'sku-typo'); assert.strictEqual(r[2].fixedSku, 'UD-1271925-17373741');
assert.strictEqual(r[3].matchStatus, 'orphaned');

// Without the extra info (old callers) nothing changes
const old = compareVariants([row('UD-1271925-17373742')], d.validVariantSKUs, d.validProductSKUs, d.cfsProductIds, d.cfsVariantAttrIds).results;
assert.strictEqual(old[0].matchStatus, 'ok');

// Store health: same SKU → SKU typos tile
const byProd = new Map(feed.map(p => [String(p.productId), { brandId: 236, vendor: 'Actona', name: p.productName, vars: p.variants.map(v => ({ varId: String(v.variantId), option: v.variantOption })) }]));
const byVar = new Map(feed.flatMap(p => p.variants.map(v => [String(v.variantId), { brandId: 236, vendor: 'Actona', prodId: String(p.productId), option: v.variantOption }])));
const checks = runChecks([{ id: 'p1', handle: 'batilda', title: 'Batilda', vendor: 'Actona', status: 'ACTIVE', iid: '1271926', pcode: 'x', options: [],
  variants: [{ id: 'v1', sku: 'UD-1271926-17373742', selectedOptions: [{ name: 'Colour', value: 'Cream' }, { name: 'Size', value: '2 x Chairs' }] },
             { id: 'v2', sku: 'UD-1271925-17373742', selectedOptions: [{ name: 'Colour', value: 'Black' }, { name: 'Size', value: '2 x Chairs' }] }] }],
  { byProd, byVar, knownVendors: ['Actona'] });
const typo = checks.find(c => c.id === 'sku-typo');
assert.strictEqual(typo.count, 1); assert(/UD-1271925-17373742" → UD-1271925-17373736/.test(typo.rows[0].detail), typo.rows[0].detail);
assert.strictEqual(checks.find(c => c.id === 'not-in-cfs').count, 0);
console.log('WRONG PAIRING TESTS PASSED');
