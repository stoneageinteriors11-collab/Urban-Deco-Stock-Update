// Store health route — fake CFS feeds + fake Shopify, end to end (read-only)
const assert = require('assert');
const axios = require('axios');
process.env.SHOPIFY_STORE = 'mock.myshopify.com'; process.env.SHOPIFY_ACCESS_TOKEN = 'x';
const feeds = { 215: [{ productId: 100, brandName: 'Humz', productName: 'Milan White', variants: [] }], 364: [{ productId: 300, brandName: 'Livingfurn', productName: 'Noor Natural', variants: [] }] };
axios.get = async url => ({ data: /brandId=(\d+)/.test(url) ? (feeds[Number(url.match(/brandId=(\d+)/)[1])] || []) : feeds[215] });
const updates = [];
const prods = [
  { id: 'gid://shopify/Product/1', handle: 'milan-white', title: 'Milan - White', vendor: 'Urban Deco', status: 'ACTIVE', sku: 'UD-100', iid: '100' },
  { id: 'gid://shopify/Product/2', handle: 'noor-medium-brown', title: 'Noor - Natural', vendor: 'Urban Deco', status: 'ACTIVE', sku: 'UD-300', iid: '300' },
  { id: 'gid://shopify/Product/3', handle: 'old-draft', title: 'Old Draft', vendor: 'Urban Deco', status: 'DRAFT', sku: 'UD-999', iid: '999' },
];
axios.post = async (url, body) => {
  const q = body.query;
  if (/productVariants\(/.test(q)) return { data: { data: { productVariants: { pageInfo: { hasNextPage: false }, nodes:
    prods.map(p => ({ sku: p.sku, selectedOptions: [{ name: 'Color', value: 'White' }], product: { id: p.id, handle: p.handle, title: p.title, vendor: p.vendor, status: p.status } })) } } } };
  if (/products\(first: 250/.test(q)) return { data: { data: { products: { pageInfo: { hasNextPage: false }, nodes:
    prods.map(p => ({ id: p.id, handle: p.handle, status: p.status, iid: { value: p.iid }, pcode: { value: 'C' }, options: [{ id: 'o', name: 'Color', optionValues: [{ id: 'v', name: 'White' }] }] })) } } } };
  const vars = body.variables || {};
  if (/productByHandle/.test(q)) { const p = prods.find(x => x.handle === vars.h); return { data: { data: { productByHandle: p ? { id: p.id, title: p.title, status: p.status } : null } } }; }
  if (/productUpdate/.test(q)) { updates.push(vars.product); const p = prods.find(x => x.id === vars.product.id); if (vars.product.handle) p.handle = vars.product.handle;
    return { data: { data: { productUpdate: { product: { id: p.id, handle: p.handle, status: p.status }, userErrors: [] } } } }; }
  if (/product\(id/.test(q)) { const p = prods.find(x => x.id === vars.id); return { data: { data: { product: { id: p.id, title: p.title, handle: p.handle, status: p.status, vendor: p.vendor, variants: { nodes: [] } } } } }; }
  throw new Error('unexpected ' + q.slice(0, 60));
};
const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/store-health', require('../routes/storehealth'));
app.use('/api/shopify', require('../routes/shopify'));
const server = app.listen(0);
const run = async body => { const t = await (await fetch(`http://127.0.0.1:${server.address().port}/api/store-health/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).text();
  return t.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))).pop(); };
(async () => {
  try {
    let d = await run({});
    assert.strictEqual(d.type, 'done', JSON.stringify(d));
    assert.strictEqual(d.products, 2, 'drafts left out by default');
    const by = Object.fromEntries(d.checks.map(c => [c.id, c]));
    assert.deepStrictEqual(by['wrong-vendor'].rows.map(r => r.handle), ['noor-medium-brown']);
    assert.strictEqual(by['wrong-vendor'].rows[0].shouldBe, 'Livingfurn');
    assert.deepStrictEqual(by['url-title'].rows.map(r => r.handle), ['noor-medium-brown']);
    assert.strictEqual(by['not-in-cfs'].count, 0);
    d = await run({ includeDrafts: true });
    assert.strictEqual(d.products, 3);
    assert.deepStrictEqual(d.checks.find(c => c.id === 'not-in-cfs').rows.map(r => r.handle), ['old-draft']);
    // ── Fix URL ──
    const P = path => `http://127.0.0.1:${server.address().port}${path}`;
    const sse = async (path, body) => { const t = await (await fetch(P(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).text();
      return t.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))).pop(); };
    const row = by['url-title'].rows[0];
    assert.strictEqual(row.newHandle, 'noor-natural');
    let f = await sse('/api/store-health/fix-url', { items: [{ productId: row.productId, handle: row.handle }], dryRun: true });
    assert(/Would change URL \/noor-medium-brown → \/noor-natural/.test(f.log[0].message), JSON.stringify(f)); assert.strictEqual(updates.length, 0);
    // new URL taken by another product → refused
    prods.push({ id: 'gid://shopify/Product/9', handle: 'noor-natural', title: 'Other', vendor: 'Urban Deco', status: 'DRAFT', sku: 'UD-1', iid: '1' });
    f = await sse('/api/store-health/fix-url', { items: [{ productId: row.productId, handle: row.handle }], dryRun: false });
    assert.strictEqual(f.failed, 1); assert(/already used by "Other"/.test(f.log[0].message)); assert.strictEqual(updates.length, 0);
    prods.pop();
    f = await sse('/api/store-health/fix-url', { items: [{ productId: row.productId, handle: row.handle }], dryRun: false });
    assert.strictEqual(f.changed, 1, JSON.stringify(f)); assert.deepStrictEqual(updates[0], { id: row.productId, handle: 'noor-natural', redirectNewHandle: true });
    // again → already matches
    f = await sse('/api/store-health/fix-url', { items: [{ productId: row.productId }], dryRun: false });
    assert.strictEqual(f.skipped, 1);
    // undo puts the old URL back
    let u;
    const runs = (await (await fetch(P('/api/shopify/undo/runs'))).json()).runs;
    const urun = runs.find(x => x.kind === 'fix-url');
    u = await (await fetch(P(`/api/shopify/undo/${urun.id}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dryRun: false }) })).json();
    assert.strictEqual(u.undone, 1, JSON.stringify(u)); assert(/URL put back: \/noor-natural → \/noor-medium-brown/.test(u.log[0].message), JSON.stringify(u.log));
    assert.strictEqual(prods[1].handle, 'noor-medium-brown');
    require('fs').unlinkSync(require('../utils/undoLog').file(urun.id));
    console.log('STORE HEALTH ROUTE TESTS PASSED');
  } catch (e) { console.error('STORE HEALTH ROUTE TESTS FAILED', e); process.exitCode = 1; }
  server.close(); setTimeout(() => process.exit(), 100);
})();
