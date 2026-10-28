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
{ const z = applyRule(bh, { stockStatus: 'IN STOCK', onHand: 0 });   // IN STOCK + 0 on hand → 5, no flag
  assert.deepStrictEqual(z.flags, []); assert.strictEqual(z.qty, 5); assert.strictEqual(z.stockStatus, 'IN STOCK'); assert(/0 on hand → 5/.test(z.qtyNote)); }
assert.strictEqual(applyRule(bh, { stockStatus: 'OUT OF STOCK', onHand: 0 }).qty, 0);   // out of stock stays 0
assert.strictEqual(applyRule(bh, { stockStatus: 'IN STOCK', onHand: 7 }).qty, 7);       // real numbers copied as they are

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
feed[0].productCode = 'LMP-01'; feed[1].productCode = 'VAS'; feed[1].variants[0].productCode = 'VAS-S'; feed[1].variants[1].productCode = 'VAS-L';
const codeProducts = [
  { id: 'P1', handle: 'lamp', title: 'Lamp', vendor: 'J-Line', status: 'ACTIVE', metafield: null,
    variants: { nodes: [{ id: 'V1', sku: 'UD-1', title: 'Default', metafield: null }] } },
  { id: 'P2', handle: 'vase', title: 'Vase', vendor: 'J-Line', status: 'DRAFT', metafield: { value: 'VAS' },
    variants: { nodes: [{ id: 'V21', sku: 'UD-2-21', metafield: { value: 'VAS-S' } }, { id: 'V22', sku: 'UD-2-22', metafield: { value: 'OLD' } },
      { id: 'V2', sku: 'UD-2', metafield: { value: 'keep' } }, { id: 'V23', sku: 'UD-2-99', metafield: null }] } },
];
axios.get = async url => { assert(url.endsWith('brandId=363'), url); return { data: feed }; };
axios.post = async (url, body) => {
  const q = body.query, v = body.variables;
  let data;
  if (/locations/.test(q)) data = { locations: { edges: [{ node: { id: 'L1', name: 'Shop' } }] } };
  else if (/variantsCount/.test(q)) data = { products: { pageInfo: { hasNextPage: false }, nodes: [
    { vendor: 'J-Line', status: 'ACTIVE', variantsCount: { count: 1 } }, { vendor: 'J-Line', status: 'DRAFT', variantsCount: { count: 3 } },
    { vendor: 'J-Line Extra', status: 'ACTIVE', variantsCount: { count: 9 } }] } };
  else if (/key: "product_code"/.test(q)) data = { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: codeProducts } };
  else if (/products\(/.test(q)) data = { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: products } };
  else if (/metafieldsSet/.test(q)) { writes.mf.push(...v.metafields); data = { metafieldsSet: { userErrors: [] } }; }
  else if (/metafieldsDelete/.test(q)) { writes.del = (writes.del || []).concat(v.metafields); data = { metafieldsDelete: { userErrors: [] } }; }
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
    const cnt = await (await fetch(base + '/api/brands/363/count')).json();
    assert.deepStrictEqual([cnt.count, cnt.active, cnt.variants, cnt.cfsProducts, cnt.cfsSkus], [2, 1, 4, 2, 3], JSON.stringify(cnt));

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
    // ── Step 2: product codes ──
    writes.mf.length = 0;
    r = await (async () => { const t = await (await fetch(base + '/api/brands/codes-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brandId: 363, dryRun: true }) })).text();
      return t.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))).pop(); })();
    r.log.forEach(l => console.log(' ', l.status, l.sku, l.message));
    assert.strictEqual(writes.mf.length, 0, 'codes dry run writes nothing');
    // the draft Vase product is skipped entirely — counted, not listed, nothing written
    assert.deepStrictEqual(r.counts, { products: 1, productCodes: 1, variants: 1, updated: 1, unchanged: 0, notInCfs: 0, flagged: 0, failed: 0, skippedDraft: 1 });
    assert(!r.log.some(l => l.handle === 'vase'), 'draft product not in the log');
    const t2 = await (await fetch(base + '/api/brands/codes-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brandId: 363, dryRun: false }) })).text();
    const k = writes.mf.map(m => `${m.ownerId}.${m.key}=${m.value}`).sort();
    assert.deepStrictEqual(k, ['P1.product_code=LMP-01', 'V1.variant_code=LMP-01']);
    // codes for several brands in one run (brandIds); log rows carry the brand
    const multi = await (async () => { const t = await (await fetch(base + '/api/brands/codes-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brandIds: [363, 212], dryRun: true }) })).text();
      return t.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))).pop(); })();
    assert.strictEqual(multi.brand, '2 brands', JSON.stringify(multi).slice(0, 300));
    assert(multi.log.some(l => l.brand === 'J-Line'));
    // ── Order-ahead (pre-Christmas) ──
    const sseAt = async (path, body) => { const t = await (await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).text();
      return t.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))).pop(); };
    writes.mf.length = 0; writes.inv.length = 0; writes.del = [];
    r = await sseAt('/api/brands/order-ahead', { brandIds: [363], cutoff: '2026-12-12', dryRun: true });
    r.log.forEach(l => console.log(' ', l.status, l.sku, l.message));
    assert.strictEqual(writes.mf.length + writes.inv.length, 0, 'dry run writes nothing');
    assert.strictEqual(r.counts.newAhead, 1, JSON.stringify(r.counts));
    assert(r.log.some(l => l.sku === 'UD-2-22' && /OUT OF STOCK, due 2026-12-01 \(before 2026-12-12\): override IN STOCK · quantity 9 → 5/.test(l.message)));
    r = await sseAt('/api/brands/order-ahead', { brandIds: [363], cutoff: '2026-12-12', dryRun: false });
    const k2 = writes.mf.map(m => `${m.ownerId}.${m.key}=${m.value}`).sort();
    assert.deepStrictEqual(k2, ['P2.stock_status_override=IN STOCK', 'V22.override_cutoff=2026-12-12', 'V22.stock_status_override=IN STOCK'], k2.join(' | '));
    assert.deepStrictEqual(writes.inv.map(x => [x.inventoryItemId, x.quantity]), [['I22', 5]]);
    // cut-off before the due date → not orderable, "due after cut-off"
    r = await sseAt('/api/brands/order-ahead', { brandIds: [363], cutoff: '2026-11-15', dryRun: true });
    assert.strictEqual(r.counts.oosLater, 1); assert.strictEqual(r.counts.newAhead, 0);

    // Step 1 keeps an active override at 5 …
    const v22 = products[1].variants.nodes[1];
    v22.metafields = mf({ inoutstock: 'OUT OF STOCK', vnotificationtitle: '6-8 Weeks', duedate: '2026-12-01', stock_status_override: 'IN STOCK', override_cutoff: '2026-12-12' });
    v22.inventoryItem = inv('I22', 5);
    products[1].metafields = mf({ inoutstock: 'IN STOCK', duedate: '2026-12-01', stock_status_override: 'IN STOCK' });
    writes.mf.length = 0; writes.inv.length = 0; writes.del = [];
    r = await sse({ brandId: 363, dryRun: false });
    assert(!writes.inv.some(x => x.inventoryItemId === 'I22'), 'quantity stays 5, not reset to 0');
    assert.strictEqual(writes.del.length, 0);
    // … and switches it off once it no longer qualifies (stored cut-off before the due date)
    v22.metafields = mf({ inoutstock: 'OUT OF STOCK', vnotificationtitle: '6-8 Weeks', duedate: '2026-12-01', stock_status_override: 'IN STOCK', override_cutoff: '2026-11-15' });
    r = await sse({ brandId: 363, dryRun: false });
    assert.deepStrictEqual(writes.inv.filter(x => x.inventoryItemId === 'I22').map(x => x.quantity), [0]);
    assert.deepStrictEqual(writes.del.map(d => `${d.ownerId}.${d.key}`).sort(), ['P2.stock_status_override', 'V22.override_cutoff', 'V22.stock_status_override']);
    assert(r.log.some(l => l.sku === 'UD-2-22' && /order-ahead switched off/.test(l.message)));

    // Due date already passed (Rhianna case): never turned on; an active one is switched off
    const { _orderAhead: oa } = require('../routes/brandsync');
    assert.strictEqual(oa.dueDay('2026-10-21 00:00:00 +0100'), '2026-10-21');
    assert.strictEqual(oa.dueDay('2026-02-30'), null, 'impossible date = no date');
    assert.strictEqual(oa.orderAheadCheck({ stockStatus: 'OUT OF STOCK', dueDate: '2026-10-21 00:00:00 +0100' }, '2026-12-12', '2026-10-24').code, 'passed');
    assert.strictEqual(oa.orderAheadCheck({ stockStatus: 'OUT OF STOCK', dueDate: '2026-10-24' }, '2026-12-12', '2026-10-24').ok, true, 'due today still counts');
    const past = (() => { const d = new Date(Date.now() - 3 * 864e5); return d.toISOString().slice(0, 10) + ' 00:00:00 +0100'; })();
    const oldDue = feed[1].dueDate; feed[1].dueDate = past;
    v22.metafields = mf({ inoutstock: 'OUT OF STOCK', duedate: past, stock_status_override: 'IN STOCK', override_cutoff: '2099-12-12' });
    writes.mf.length = 0; writes.inv.length = 0; writes.del = [];
    r = await sseAt('/api/brands/order-ahead', { brandIds: [363], cutoff: '2099-12-12', dryRun: true });
    assert.strictEqual(r.counts.clearedPassed, 1, JSON.stringify(r.counts));
    const sw = r.log.find(l => l.sku === 'UD-2-22');
    assert(sw.reason === 'passed' && /Would switch off order-ahead – due date passed — due date passed \(/.test(sw.message) && /quantity 5 → 0/.test(sw.message), sw.message);
    assert.strictEqual(writes.mf.length + writes.inv.length + writes.del.length, 0, 'dry run writes nothing');
    v22.metafields = mf({ inoutstock: 'OUT OF STOCK', duedate: past });   // no override yet → must not be turned on
    r = await sseAt('/api/brands/order-ahead', { brandIds: [363], cutoff: '2099-12-12', dryRun: true });
    assert(r.counts.newAhead === 0 && r.counts.oosPassed === 1, JSON.stringify(r.counts));
    v22.metafields = mf({ inoutstock: 'OUT OF STOCK', duedate: past, stock_status_override: 'IN STOCK', override_cutoff: '2099-12-12' });
    r = await sse({ brandId: 363, dryRun: false });   // Step 1 also switches it off
    assert(r.counts.aheadPassed === 1 && writes.del.some(d => d.ownerId === 'V22' && d.key === 'stock_status_override'), JSON.stringify(r.counts));
    feed[1].dueDate = oldDue;
    console.log('BRAND STOCK TESTS PASSED');
  } catch (e) { console.error('BRAND STOCK TESTS FAILED', e); process.exitCode = 1; }
  server.close();
})();
