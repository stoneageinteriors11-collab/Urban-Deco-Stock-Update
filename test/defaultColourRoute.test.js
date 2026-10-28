// "Default" colours page — scan → dry run → live rename → undo (fake CFS feeds + fake Shopify)
const assert = require('assert');
const axios = require('axios');
process.env.SHOPIFY_STORE = 'mock.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = 'x';

const feeds = {
  80: [ // Birlea
    { productId: 1258290, brandName: 'Birlea', productName: 'Herringford Oak 2 Drawer Bedside Cabinet', variants: [] },
    { productId: 1274063, brandName: 'Birlea', productName: 'Herringford Walnut 2 Drawer Bedside Cabinet', variants: [] },
  ],
};
axios.get = async url => ({ data: feeds[Number((url.match(/brandId=(\d+)/) || [])[1])] || [] });

const P = {
  id: 'gid://shopify/Product/1', handle: 'herringford-bedside-cabinet-2-drawer-walnut', title: 'Herringford Bedside Cabinet - 2 Drawer - Walnut',
  vendor: 'Birlea', status: 'ACTIVE', iid: { value: '1274063' },
  options: [{ id: 'gid://shopify/ProductOption/9', name: 'Color', optionValues: [{ id: 'gid://shopify/ProductOptionValue/1', name: 'Brown' }, { id: 'gid://shopify/ProductOptionValue/2', name: 'Default' }] }],
  variants: { nodes: [
    { id: 'v1', sku: 'UD-1274063', selectedOptions: [{ name: 'Color', value: 'Brown' }] },
    { id: 'v2', sku: 'UD-1258290', selectedOptions: [{ name: 'Color', value: 'Default' }] },
  ] },
};
const SIMPLE = { id: 'gid://shopify/Product/2', handle: 'simple', title: 'Simple', vendor: 'Birlea', status: 'ACTIVE', iid: null,
  options: [{ id: 'o2', name: 'Title', optionValues: [{ id: 'ov2', name: 'Default Title' }] }], variants: { nodes: [{ id: 'v3', sku: 'UD-5', selectedOptions: [{ name: 'Title', value: 'Default Title' }] }] } };
const renames = [];
axios.post = async (url, body) => {
  const q = body.query, vars = body.variables || {};
  if (/productVariants\(/.test(q)) return { data: { data: { productVariants: { pageInfo: { hasNextPage: false }, nodes: [
    ...P.variants.nodes.map(v => ({ ...v, product: { id: P.id, handle: P.handle, title: P.title, vendor: P.vendor, status: P.status } })),
    { sku: 'UD-1258290', selectedOptions: [{ name: 'Color', value: 'Oak' }], product: { id: 'p9', handle: 'herringford-oak', title: 'Herringford Bedside Cabinet - 2 Drawer - Oak', vendor: 'Birlea', status: 'ACTIVE' } },
  ] } } } };
  if (/productOptionUpdate/.test(q)) {
    renames.push(vars);
    const ov = P.options[0].optionValues.find(x => x.id === vars.values[0].id); ov.name = vars.values[0].name;
    return { data: { data: { productOptionUpdate: { product: { id: P.id }, userErrors: [] } } } };
  }
  if (/products\(first/.test(q)) {
    assert(/variant_title:Default\*/.test(vars.q) && /status:active/.test(vars.q), vars.q);
    return { data: { data: { products: { pageInfo: { hasNextPage: false }, nodes: [P, SIMPLE] } } } };
  }
  if (/product\(id/.test(q)) return { data: { data: { product: { ...P, variants: { nodes: P.variants.nodes.map(v => ({ id: v.id, sku: v.sku })) } } } } };
  throw new Error('unexpected query ' + q.slice(0, 80));
};

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/default-colours', require('../routes/defaultcolours'));
app.use('/api/shopify', require('../routes/shopify'));
const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}`;
const applySse = async body => { const t = await (await post('/api/default-colours/apply', body)).text();
  const evs = t.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  assert(evs.some(e => e.type === 'progress'), 'progress events'); return evs.pop(); };
const post = async (path, body) => (await fetch(base() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
(async () => {
  try {
    // scan
    const t = await (await post('/api/default-colours/scan', { vendor: 'Birlea' })).text();
    const done = t.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))).pop();
    assert.strictEqual(done.type, 'done', JSON.stringify(done));
    assert.strictEqual(done.rows.length, 1, 'simple product left out');
    const r = done.rows[0];
    console.log(r);
    assert.strictEqual(r.suggestion, 'Oak'); assert.strictEqual(r.confidence, 'high'); assert.strictEqual(r.type, 'A');
    const item = { productId: r.productId, optionId: r.optionId, valueId: r.valueId, current: r.current, newName: r.suggestion, handle: r.handle, title: r.title };
    // dry run
    let d = await applySse({ items: [item], dryRun: true });
    assert.strictEqual(renames.length, 0); assert(/Would rename Color: "Default" → "Oak"/.test(d.log[0].message), JSON.stringify(d));
    // clash is refused
    d = await applySse({ items: [{ ...item, newName: 'brown' }], dryRun: false });
    assert.strictEqual(d.failed, 1); assert.strictEqual(renames.length, 0);
    // live
    d = await applySse({ items: [item], dryRun: false });
    assert.strictEqual(d.changed, 1); assert(d.undoId);
    assert.strictEqual(P.options[0].optionValues[1].name, 'Oak');
    // second time → already done
    d = await applySse({ items: [{ ...item, current: 'Oak' }], dryRun: false });
    assert.strictEqual(d.skipped, 1);
    // undo puts "Default" back
    let u;
    const runs = (await (await fetch(base() + '/api/shopify/undo/runs')).json()).runs;
    const run = runs.find(x => x.kind === 'default-colour');
    assert(run && run.counts['option-value'] === 1, JSON.stringify(runs.slice(0, 2)));
    u = await (await post(`/api/shopify/undo/${run.id}`, { dryRun: true })).json();
    assert(/Would put Color back: "Oak" → "Default"/.test(u.log[0].message), JSON.stringify(u.log));
    u = await (await post(`/api/shopify/undo/${run.id}`, { dryRun: false })).json();
    assert.strictEqual(u.undone, 1, JSON.stringify(u)); assert.strictEqual(P.options[0].optionValues[1].name, 'Default');
    require('fs').unlinkSync(require('../utils/undoLog').file(run.id));
    console.log('DEFAULT COLOUR ROUTE TESTS PASSED');
  } catch (e) { console.error('DEFAULT COLOUR ROUTE TESTS FAILED', e); process.exitCode = 1; }
  server.close(); setTimeout(() => process.exit(), 100);
})();
