// Other Brands — stock update, against a fake CFS feed + fake Shopify (nothing real is called)
const assert = require('assert');
const axios = require('axios');
process.env.SHOPIFY_STORE = 'mock.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = 'x';
const { applyRule, getBrand } = require('../utils/brands');

// ── rules ──
const jl = getBrand(363), gs = getBrand(366), bh = getBrand(315);
assert.deepStrictEqual([applyRule(jl, { stockStatus: 'IN STOCK', onHand: 0 }).qty, applyRule(jl, { stockStatus: 'IN STOCK', onHand: 0 }).stockStatus], [5, 'IN STOCK']);
assert.deepStrictEqual([applyRule(jl, { stockStatus: 'OUT OF STOCK', onHand: 7 }).qty, applyRule(jl, { stockStatus: 'OUT OF STOCK', onHand: 7 }).stockStatus], [0, 'OUT OF STOCK']);
assert.deepStrictEqual([applyRule(gs, { stockStatus: '', onHand: 0 }).qty, applyRule(gs, { stockStatus: '', onHand: 0 }).stockStatus], [5, 'IN STOCK']);
const asis = applyRule(bh, { stockStatus: 'OUT OF STOCK', onHand: 3, deliveryTime: '6-8 Weeks', dueDate: '2026-12-11' });
assert.deepStrictEqual([asis.qty, asis.stockStatus, asis.deliveryTime, asis.dueDate], [3, 'OUT OF STOCK', '6-8 Weeks', '2026-12-11'], 'copied as-is');
assert.deepStrictEqual(applyRule(bh, { stockStatus: 'IN STOCK', onHand: 0 }).flags, ['IN STOCK but 0 on hand']);

// ── fake feed (J-Line) ──
const feed = [
  { productId: 1, brandName: 'J-Line', productName: 'Lamp', deliveryTime: '3-5 Days', stockStatus: 'IN STOCK', onHand: 0, dueDate: 'NA', variants: [] },
  { productId: 2, brandName: 'J-Line', productName: 'Vase', deliveryTime: '6-8 Weeks', stockStatus: 'OUT OF STOCK', onHand: 4, dueDate: '2026-12-01',
    variants: [{ variantId: 21, variantOption: 'Small', stockStatus: 'IN STOCK', onHand: 0, deliveryTime: '1-2 Weeks', dueDate: 'NA' },
               { variantId: 22, variantOption: 'Large' }] },
];
const mf = o => ({ nodes: Object.entries(o).map(([key, value]) => ({ key, value })) });
const inv = (id, q) => ({ id, tracked: true, inventoryLevel: { quantities: [{ name: 'available', quantity: q }] } });
const products = [
  { id: 'P1', handle: 'lamp', title: 'Lamp', vendor: 'J-Line', status: 'ACTIVE', metafields: mf({ inoutstock: 'OUT OF STOCK' }),
    variants: { nodes: [{ id: 'V1', sku: 'UD-1', title: 'Default', metafields: mf({ inoutstock: 'OUT OF STOCK', vnotificationtitle: '3-5 Days', duedate: 'NA' }), inventoryItem: inv('I1', 0) }] } },
  { id: 'P2', handle: 'vase', title: 'Vase', vendor: 'J-Line', status: 'ACTIVE', metafields: mf({}),
    variants: { nodes: [
      { id: 'V21', sku: 'UD-2-21', title: 'Small', metafields: mf({ inoutstock: 'IN STOCK', vnotificationtitle: '1-2 Weeks', duedate: 'NA' }), inventoryItem: inv('I21', 5) },
      { id: 'V22', sku: 'UD-2-22', title: 'Large', metafields: mf({}), inventoryItem: inv('I22', 9) },
      { id: 'V23', sku: 'UD-2-99', title: 'Gone', metafields: mf({}), inventoryItem: inv('I23', 1) }] } },
  { id: 'P3', handle: 'old', title: 'Old', vendor: 'J-Line', status: 'DRAFT', metafields: mf({}), variants: { nodes: [] } },
  { id: 'P4', handle: 'other', title: 'Other', vendor: 'J-Line Extra', status: 'ACTIVE', metafields: mf({}), variants: { nodes: [{ id: 'X', sku: 'UD-1', metafields: mf({}), inventoryItem: inv('IX', 0) }] } },
];
const writes = { mf: [], inv: [] };
axios.get = async url => { assert(url.endsWith('brandId=363'), url); return { data: feed }; };
axios.post = async (url, body) => {
  const q = body.query, v = body.variables;
  let data;
  if (/locations/.test(q)) data = { locations: { edges: [{ node: { id: 'L1', name: 'Shop' } }] } };
  else if (/productsCount/.test(q)) data = { productsCount: { count: 3 } };
  else if (/products\(/.test(q)) data = { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: products } };
  else if (/metafieldsSet/.test(q)) { writes.mf.push(...v.metafields); data = { metafieldsSet: { userErrors: [] } }; }
  else if (/inventorySetQuantities/.test(q)) { writes.inv.push(...v.input.quantities); data = { inventorySetQuantities: { userErrors: [] } }; }
  else throw new Error('unhandled ' + q.slice(0, 60));
  return { data: { data } };
};

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/brands', require('../routes/brandsync'));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const sse = async body => {
  const t = await (await fetch(base + '/api/brands/stock-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).text();
  return t.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))).pop();
};

(async () => {
  try {
    assert.strictEqual((await (await fetch(base + '/api/brands/list')).json()).brands.length, 14);
    assert.strictEqual((await (await fetch(base + '/api/brands/363/count')).json()).count, 3);

    let r = await sse({ brandId: 363, dryRun: true });
    console.log(r.counts); r.log.forEach(l => console.log(' ', l.status, l.sku, l.message));
    assert.strictEqual(writes.mf.length + writes.inv.length, 0, 'dry run writes nothing');
    assert.deepStrictEqual(r.counts, { products: 2, variants: 4, updated: 2, unchanged: 1, notInCfs: 1, flagged: 0, skippedDraft: 1, failed: 0 });
    assert(r.log.some(l => l.sku === 'UD-1' && /stock status: "OUT OF STOCK" → "IN STOCK".*quantity: 0 → 5/.test(l.message)));
    assert(r.log.some(l => l.sku === 'UD-2-22' && /stock status: "" → "OUT OF STOCK".*delivery: "" → "6-8 Weeks".*due date: "" → "2026-12-01".*quantity: 9 → 0/.test(l.message)), 'variant falls back to product values');
    assert(r.log.some(l => l.sku === 'UD-2-21' && l.status === 'unchanged'));
    assert(r.log.some(l => l.sku === 'UD-2-99' && l.status === 'not_in_cfs'));
    assert(!r.log.some(l => l.handle === 'other'), 'vendor must match exactly');

    r = await sse({ brandId: 363, dryRun: false });
    assert.strictEqual(r.counts.failed, 0);
    assert.deepStrictEqual(writes.inv.map(x => [x.inventoryItemId, x.quantity]), [['I1', 5], ['I22', 0]]);
    const keys = writes.mf.map(m => `${m.ownerId}.${m.key}=${m.value}`);
    assert(keys.includes('V1.inoutstock=IN STOCK') && keys.includes('P1.inoutstock=IN STOCK'));
    assert(keys.includes('P2.inoutstock=IN STOCK'), 'product IN STOCK when any variant is');
    assert(keys.includes('V22.duedate=2026-12-01') && keys.includes('V22.vnotificationtitle=6-8 Weeks'));
    console.log('BRAND STOCK TESTS PASSED');
  } catch (e) { console.error('BRAND STOCK TESTS FAILED', e); process.exitCode = 1; }
  server.close();
})();
