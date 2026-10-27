// Product code step — product_code comes from the product's OWN CFS product (iproductid)
const assert = require('assert');
process.env.SHOPIFY_STORE = 'mock.myshopify.com'; process.env.SHOPIFY_ACCESS_TOKEN = 'x';
const { chooseProductCode } = require('../routes/brandsync')._codes;
const { buildBrandCodes } = require('../utils/brands');
const feed = [   // Jesper 230cm: Natural 1276461 = 13860, Black 1276463 = 13866; Chestnut 1276462 is gone from CFS
  { productId: 1276461, productCode: '13860', variants: [] },
  { productId: 1276463, productCode: '13866', variants: [] },
  { productId: 641922, productCode: 'MIR-C-LHF-MO', variants: [] },
  { productId: 1243978, productCode: 'MIR-C-LHF-GR', variants: [] },
];
const codes = buildBrandCodes(feed);
const byId = new Map(feed.map(x => [String(x.productId), x.productCode]));
const prod = (cur, iid, skus) => ({ metafield: cur ? { value: cur } : null, iid: iid ? { value: iid } : null, variants: { nodes: skus.map(sku => ({ sku })) } });
const jesper = ['UD-1276462', 'UD-1276461', 'UD-1276463'];

// Chestnut: own product gone → keep 31021, never 13860
let r = chooseProductCode(prod('31021', '1276462', jesper), codes, byId);
assert.strictEqual(r.code, null); assert(/not in the CFS feed/.test(r.note) && /"31021"/.test(r.note));
// Black: own product in CFS → its own code, even if first variant is another colour
r = chooseProductCode(prod('31018', '1276463', jesper), codes, byId);
assert.strictEqual(r.code, '13866');
// Mariah Mocha: already right → same code (no change written by caller)
r = chooseProductCode(prod('MIR-C-LHF-MO', '641922', ['UD-1243978', 'UD-641922']), codes, byId);
assert.strictEqual(r.code, 'MIR-C-LHF-MO'); assert(!r.flag);
// no iproductid, one CFS product → that code (copied as-is)
r = chooseProductCode(prod('OLD', null, ['UD-641922']), codes, byId);
assert.strictEqual(r.code, 'MIR-C-LHF-MO');
// no iproductid, several CFS products → keep current if it's one of them, flag
r = chooseProductCode(prod('MIR-C-LHF-GR', null, ['UD-641922', 'UD-1243978']), codes, byId);
assert.strictEqual(r.code, null); assert(/kept as "MIR-C-LHF-GR"/.test(r.flag));
r = chooseProductCode(prod('XYZ', null, ['UD-641922', 'UD-1243978']), codes, byId);
assert.strictEqual(r.code, null); assert(/please check/.test(r.flag));
// own product gone and no other CFS SKUs → nothing to say
r = chooseProductCode(prod('31021', '1276462', ['UD-1276462']), codes, byId);
assert.deepStrictEqual(r, { code: null, note: null });
console.log('BRAND CODES TESTS PASSED');
