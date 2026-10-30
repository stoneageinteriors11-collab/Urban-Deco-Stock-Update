// Other Brands — Step 4 clean-up comparison (fake feeds + fake Shopify)
const assert = require('assert');
const axios = require('axios');
process.env.SHOPIFY_STORE = 'mock.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = 'x';

const feeds = {
  363: [ // J-Line
    { productId: 10, brandName: 'J-Line', productName: 'Lamp', productCode: 'L1', stockStatus: 'IN STOCK', variants: [] },
    { productId: 11, brandName: 'J-Line', productName: 'Vase', productCode: 'V1', stockStatus: 'IN STOCK',
      variants: [{ variantId: 111, productCode: 'V1-S' }] },
    { productId: 20, brandName: 'J-Line', productName: 'Clock', productCode: 'C1', stockStatus: 'IN STOCK', variants: [] },
  ],
  315: [{ productId: 55, brandName: 'Beehive', productName: 'Sofa', productCode: 'S1', variants: [] }], // Beehive
  215: [{ productId: 77, brandName: 'Urban Deco', productName: 'Table', productCode: 'T1', variants: [] }],
};
let feedCalls = 0;
axios.get = async url => {
  feedCalls++;
  const id = Number((url.match(/brandId=(\d+)/) || [])[1]);
  return { data: feeds[id] || [] };
};
const v = (sku, extra = {}) => ({ sku, price: '10', inventoryQuantity: 1, barcode: '', selectedOptions: [{ name: 'Title', value: 'Default Title' }], metafield: null, ...extra });
const shop = [
  { handle: 'lamp', title: 'Lamp', vendor: 'J-Line', status: 'ACTIVE', metafield: null, variants: { nodes: [v('UD-10')] } },
  { handle: 'vase', title: 'Vase', vendor: 'J-Line', status: 'ACTIVE', metafield: null, variants: { nodes: [v('UD-11-111'), v('UD-11-999')] } },
  { handle: 'gone', title: 'Gone', vendor: 'J-Line', status: 'ACTIVE', metafield: null, variants: { nodes: [v('UD-12')] } },
  { handle: 'sofa', title: 'Sofa (wrong vendor)', vendor: 'J-Line', status: 'ACTIVE', metafield: null, variants: { nodes: [v('UD-55')] } },
  { handle: 'table', title: 'Table', vendor: 'J-Line', status: 'ACTIVE', metafield: null, variants: { nodes: [v('UD-77')] } },
  { handle: 'old', title: 'Old', vendor: 'J-Line', status: 'DRAFT', metafield: null, variants: { nodes: [v('UD-13')] } },
  // Jesper-style: product code L1 belongs to its own variant UD-10 (iproductid 10); the extra UD-15 isn't in CFS
  { handle: 'lamp-set', title: 'Lamp Set', vendor: 'J-Line', status: 'ACTIVE', metafield: { value: 'L1' }, iid: { value: '10' }, variants: { nodes: [v('UD-15')] } },
  { handle: 'lamp-own', title: 'Lamp Own', vendor: 'J-Line', status: 'ACTIVE', metafield: { value: 'L1' }, iid: { value: '16' }, variants: { nodes: [v('UD-16')] } },
  { handle: 'x', title: 'Not J-Line', vendor: 'J-Line Extra', status: 'ACTIVE', metafield: null, variants: { nodes: [v('UD-14')] } },
];
// whole-store variant list (reverse vendor check): the J-Line products above + products with other vendors
const storeExtra = [
  { handle: 'clock', title: 'Clock', vendor: 'Birlea', status: 'ACTIVE', variants: { nodes: [v('UD-20')] } },          // J-Line SKU, wrong vendor
  { handle: 'mixed', title: 'Mixed', vendor: 'Urban Deco', status: 'ACTIVE', variants: { nodes: [v('UD-20'), v('UD-77')] } }, // J-Line + Urban Deco
  { handle: 'clock-draft', title: 'Clock (draft)', vendor: 'Birlea', status: 'DRAFT', variants: { nodes: [v('UD-20')] } },  // draft → skipped
  { handle: 'clock-arch', title: 'Clock (archived)', vendor: 'Birlea', status: 'ARCHIVED', variants: { nodes: [v('UD-20')] } }, // archived → skipped
  { handle: 'ud', title: 'UD Table', vendor: 'Urban Deco', status: 'ACTIVE', variants: { nodes: [v('UD-77')] } },        // not J-Line
];
const storeNodes = [...shop, ...storeExtra].flatMap(p => p.variants.nodes.map(x => ({ ...x, product: { id: 'gid://' + p.handle, handle: p.handle, title: p.title, vendor: p.vendor, status: p.status } })));
let storeCalls = 0;
axios.post = async (url, body) => {
  if (/productVariants\(/.test(body.query)) { storeCalls++; return { data: { data: { productVariants: { pageInfo: { hasNextPage: false }, nodes: storeNodes } } } }; }
  return { data: { data: { products: { pageInfo: { hasNextPage: false }, nodes: shop } } } };
};

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/brands', require('../routes/brandsync'));
const server = app.listen(0);
(async () => {
  try {
    const r = await (await fetch(`http://127.0.0.1:${server.address().port}/api/brands/compare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brandId: 363 }) })).json();
    assert(r.success, JSON.stringify(r));
    const st = Object.fromEntries(r.results.filter(x => x.matchStatus !== 'wrong-vendor').map(x => [x.variantSku, x.matchStatus]));
    // reverse vendor check
    const wv = r.results.filter(x => x.matchStatus === 'wrong-vendor');
    assert.deepStrictEqual(wv.map(x => `${x.handle}:${x.variantSku}:${x.wrongVendorMixed}`).sort(), ['clock:UD-20:false', 'mixed:UD-20:true']);
    assert.strictEqual(wv[0].otherBrandVendor, 'J-Line');
    assert.strictEqual(wv.find(x => x.handle === 'clock').currentVendor, 'Birlea');
    assert(wv.find(x => x.handle === 'mixed').otherBrandNote.includes('UD-77 (Urban Deco)'), wv.find(x => x.handle === 'mixed').otherBrandNote);
    assert.strictEqual(r.summary.wrongVendor, 2); assert.strictEqual(r.summary.wrongVendorProducts, 2);
    console.log(st, r.summary);
    assert.deepStrictEqual(st, { 'UD-10': 'ok', 'UD-11-111': 'ok', 'UD-11-999': 'orphaned', 'UD-12': 'orphaned', 'UD-55': 'other-brand', 'UD-77': 'other-brand', 'UD-13': 'draft',
      'UD-15': 'orphaned', 'UD-16': 'code-only' });
    assert(r.results.find(x => x.variantSku === 'UD-55').otherBrandNote.includes('Beehive (brand 315)'));
    assert(r.results.find(x => x.variantSku === 'UD-77').otherBrandNote.includes('Urban Deco'));
    assert.strictEqual(r.summary.orphaned, 3); assert.strictEqual(r.summary.otherBrand, 2); assert.strictEqual(r.summary.codeOnly, 1);
    assert(!r.results.some(x => x.handle === 'x'), 'exact vendor only');
    // second run reuses the cross-brand index (only this brand's feed is fetched again)
    const before = feedCalls;
    await (await fetch(`http://127.0.0.1:${server.address().port}/api/brands/compare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brandId: 363 }) })).json();
    assert.strictEqual(feedCalls - before, 1);
    assert.strictEqual(storeCalls, 1, 'store list is kept 30 minutes');
    require('../routes/brandsync').clearStoreCache();
    await (await fetch(`http://127.0.0.1:${server.address().port}/api/brands/compare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brandId: 363 }) })).json();
    assert.strictEqual(storeCalls, 2, 're-read after a vendor change');
    console.log('BRAND COMPARE TESTS PASSED');
  } catch (e) { console.error('BRAND COMPARE TESTS FAILED', e); process.exitCode = 1; }
  server.close();
})();
