// Batilda (Actona): Black/Anthracite variants carry Cream's variant numbers → SKU typo with the right SKU.
const assert = require('assert');
const { buildCompareData } = require('../utils/cfsApi');
const { compareVariants } = require('../utils/matchVariants');
const { runChecks } = require('../utils/storeHealth');

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

// Option removed in CFS (Limelight Jarvis Bed: 6ft Queen gone, 4ft 6in + 5ft King left) → orphaned, not "CFS Product Match"
{
  const f2 = [{ productId: 1276958, productName: 'Jarvis Bed - Oak', variants: [{ variantId: 17469345, variantOption: '4ft 6in Double' }, { variantId: 17469346, variantOption: '5ft King Size' }] },
              { productId: 1276999, productName: 'Single item, no options', variants: [] }];
  const d2 = buildCompareData(f2);
  const run = rows => compareVariants(rows, d2.validVariantSKUs, d2.validProductSKUs, d2.cfsProductIds, d2.cfsVariantAttrIds,
    d2.productCodesBySku, d2.productCodesByProdId, d2.variantCodesBySku, d2.variantCodesByAttrId, d2.cfsVarCodeSet, d2.cfsProductCodeToStatus, d2.cfsVarInfo).results;
  const r2 = run([row('UD-1276958-17469345', 'Oak', '4ft 6in Double'), row('UD-1276958-17469347', 'Oak', '6ft Queen Size'), row('UD-1276999-123', 'Oak', 'One')]);
  assert.strictEqual(r2[0].matchStatus, 'ok');
  assert.strictEqual(r2[1].matchStatus, 'orphaned', JSON.stringify(r2[1]));
  assert(/now only has: 4ft 6in Double, 5ft King Size/.test(r2[1].codeOnlyNote), r2[1].codeOnlyNote);
  assert.strictEqual(r2[2].matchStatus, 'cfs-product');   // CFS product with no options → still "CFS Product Match"

  const bp2 = new Map(f2.map(p => [String(p.productId), { brandId: 28, vendor: 'Limelight', name: p.productName, vars: p.variants.map(v => ({ varId: String(v.variantId), option: v.variantOption })) }]));
  const bv2 = new Map(f2.flatMap(p => p.variants.map(v => [String(v.variantId), { brandId: 28, vendor: 'Limelight', prodId: String(p.productId), option: v.variantOption }])));
  const ch = runChecks([{ id: 'j', handle: 'jarvis', title: 'Jarvis Bed - Oak', vendor: 'Limelight', status: 'ACTIVE', iid: '1276958', pcode: 'J20', options: [],
    variants: [{ id: 'a', sku: 'UD-1276958-17469345' }, { id: 'b', sku: 'UD-1276958-17469347' }] }], { byProd: bp2, byVar: bv2, knownVendors: ['Limelight'] });
  const ni = ch.find(c => c.id === 'not-in-cfs');
  assert.strictEqual(ni.count, 1); assert.deepStrictEqual(ni.rows[0].skus, ['UD-1276958-17469347']);
  console.log('OPTION REMOVED TESTS PASSED');
}

// Delete flow: option-removed rows are deleted (variant only); a product made ONLY of removed options goes to draft
{
  const { decideDeletion, removedOptionSkus } = require('../routes/shopify')._delete;
  const note = 'Option removed from CFS — CFS product 1276958 now only has: 4ft 6in Double, 5ft King Size';
  const pIds = new Map([['1276958', 'active']]), vIds = new Set(['17469345', '17469346']);
  const all = [{ id: 'a', sku: 'UD-1276958-17469345' }, { id: 'b', sku: 'UD-1276958-17469346' }, { id: 'c', sku: 'UD-1276958-17469347' }];
  const gone = removedOptionSkus([{ variantSku: 'UD-1276958-17469347', codeOnlyNote: note }]);
  const d1 = decideDeletion(all, new Set(['UD-1276958-17469347']), pIds, vIds, null, '', new Map(), null, null, null, gone);
  assert.strictEqual(d1.mode, 'variants'); assert.deepStrictEqual(d1.toDelete.map(v => v.sku), ['UD-1276958-17469347']);
  const only = [{ id: 'c', sku: 'UD-1276958-17469347' }];
  assert.strictEqual(decideDeletion(only, new Set(['UD-1276958-17469347']), pIds, vIds, null, '', new Map(), null, null, null, gone).mode, 'draft');
  assert.strictEqual(decideDeletion(only, new Set(['UD-1276958-17469347']), pIds, vIds).mode, 'keep');   // old behaviour without the note
  console.log('DELETE OPTION-REMOVED TESTS PASSED');
}
