// "Default" colours page — scan → dry run → live rename / merge → undo (fake CFS feeds + fake Shopify)
const assert = require('assert');
const axios = require('axios');
process.env.SHOPIFY_STORE = 'mock.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = 'x';

const feeds = {
  80: [ // Birlea
    { productId: 1258290, brandName: 'Birlea', productName: 'Herringford Oak 2 Drawer Bedside Cabinet', variants: [] },
    { productId: 1274063, brandName: 'Birlea', productName: 'Herringford Walnut 2 Drawer Bedside Cabinet', variants: [] },
    { productId: 1276316, brandName: 'Birlea', productName: '2 x Tommy Swivel Dining Fabric and Metal Bisque Oasis Armchair', variants: [] },
  ],
};
axios.get = async url => ({ data: feeds[Number((url.match(/brandId=(\d+)/) || [])[1])] || [] });

const ov = (id, name) => ({ id: 'gid://shopify/ProductOptionValue/' + id, name });
const P = {
  id: 'gid://shopify/Product/1', handle: 'herringford-bedside-cabinet-2-drawer-walnut', title: 'Herringford Bedside Cabinet - 2 Drawer - Walnut',
  vendor: 'Birlea', status: 'ACTIVE', iid: { value: '1274063' },
  options: [{ id: 'gid://shopify/ProductOption/9', name: 'Color', optionValues: [ov(1, 'Brown'), ov(2, 'Default')] }],
  variants: { nodes: [
    { id: 'v1', sku: 'UD-1274063', title: 'Brown', selectedOptions: [{ name: 'Color', value: 'Brown' }] },
    { id: 'v2', sku: 'UD-1258290', title: 'Default', selectedOptions: [{ name: 'Color', value: 'Default' }] },
  ] },
};
// Tommy: Bisque Oasis 2 Chairs + Default Title 4/6 Chairs — all UD-1276316 → merge
const sizes = ['2 Chairs', '4 Chairs', '6 Chairs'];
const T = {
  id: 'gid://shopify/Product/3', handle: 'tommy', title: 'Tommy Swivel Dining Armchair - Set of 2 - Bisque Oasis - Fabric and Metal',
  vendor: 'Birlea', status: 'ACTIVE', iid: { value: '1276316' },
  options: [{ id: 'gid://shopify/ProductOption/30', name: 'Color', optionValues: [ov(31, 'Bisque Oasis'), ov(32, 'Default Title')] },
    { id: 'gid://shopify/ProductOption/40', name: 'Size', optionValues: sizes.map((z, i) => ov(41 + i, z)) }],
  variants: { nodes: sizes.map((z, i) => ({ id: 'tv' + i, sku: `UD-1276316-${708 + i}`, title: `${i ? 'Default Title' : 'Bisque Oasis'} / ${z}`,
    selectedOptions: [{ name: 'Color', value: i ? 'Default Title' : 'Bisque Oasis' }, { name: 'Size', value: z }] })) },
};
const SIMPLE = { id: 'gid://shopify/Product/2', handle: 'simple', title: 'Simple', vendor: 'Birlea', status: 'ACTIVE', iid: null,
  options: [{ id: 'o2', name: 'Title', optionValues: [ov(99, 'Default Title')] }], variants: { nodes: [{ id: 'v3', sku: 'UD-5', selectedOptions: [{ name: 'Title', value: 'Default Title' }] }] } };
const ALL = [P, T, SIMPLE];
const byId = id => ALL.find(x => x.id === id);
const withHas = p => ({ ...p, options: p.options.map(o => ({ ...o, optionValues: o.optionValues.map(v => ({ ...v,
  hasVariants: p.variants.nodes.some(x => x.selectedOptions.some(s => s.name === o.name && s.value === v.name)) })) })) });
const writes = [];
let nextId = 500;
axios.post = async (url, body) => {
  const q = body.query, vars = body.variables || {};
  if (/productVariants\(/.test(q)) return { data: { data: { productVariants: { pageInfo: { hasNextPage: false }, nodes: [
    ...[P, T].flatMap(p => p.variants.nodes.map(v => ({ ...v, product: { id: p.id, handle: p.handle, title: p.title, vendor: p.vendor, status: p.status } }))),
    { sku: 'UD-1258290', selectedOptions: [{ name: 'Color', value: 'Oak' }], product: { id: 'p9', handle: 'herringford-oak', title: 'Herringford Bedside Cabinet - 2 Drawer - Oak', vendor: 'Birlea', status: 'ACTIVE' } },
  ] } } } };
  if (/productVariantsBulkUpdate/.test(q)) {
    writes.push({ move: vars });
    const p = byId(vars.productId);
    for (const vin of vars.variants) {
      const v = p.variants.nodes.find(x => x.id === vin.id);
      for (const o of vin.optionValues) {
        v.selectedOptions.find(s => s.name === o.optionName).value = o.name;
        const opt = p.options.find(x => x.name === o.optionName);
        if (!opt.optionValues.some(x => x.name === o.name)) opt.optionValues.push(ov(nextId++, o.name));   // Shopify creates a new value
      }
    }
    return { data: { data: { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } } } };
  }
  if (/productOptionUpdate/.test(q)) {
    writes.push({ option: vars });
    const p = byId(vars.productId), o = p.options.find(x => x.id === vars.option.id);
    if (vars.del) o.optionValues = o.optionValues.filter(x => !vars.del.includes(x.id));
    for (const v of (vars.values || [])) o.optionValues.find(x => x.id === v.id).name = v.name;
    return { data: { data: { productOptionUpdate: { product: { id: p.id }, userErrors: [] } } } };
  }
  if (/products\(first/.test(q)) {
    assert(/variant_title:Default\*/.test(vars.q) && /status:active/.test(vars.q), vars.q);
    return { data: { data: { products: { pageInfo: { hasNextPage: false }, nodes: ALL } } } };
  }
  if (/product\(id/.test(q)) return { data: { data: { product: withHas(byId(vars.id)) } } };
  throw new Error('unexpected query ' + q.slice(0, 80));
};

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/default-colours', require('../routes/defaultcolours'));
app.use('/api/shopify', require('../routes/shopify'));
const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}`;
const post = async (path, body) => (await fetch(base() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const applySse = async body => { const t = await (await post('/api/default-colours/apply', body)).text();
  const evs = t.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  assert(evs.some(e => e.type === 'progress'), 'progress events'); return evs.pop(); };
const toItem = r => ({ productId: r.productId, optionId: r.optionId, valueId: r.valueId, current: r.current, newName: r.suggestion,
  handle: r.handle, title: r.title, action: r.action, mergeInto: r.mergeInto });
const colours = p => p.variants.nodes.map(v => v.selectedOptions[0].value);
(async () => {
  try {
    // scan
    const t = await (await post('/api/default-colours/scan', { vendor: 'Birlea' })).text();
    const done = t.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))).pop();
    assert.strictEqual(done.type, 'done', JSON.stringify(done));
    assert.strictEqual(done.rows.length, 2, 'simple product left out');
    const r = done.rows.find(x => x.handle === P.handle), m = done.rows.find(x => x.handle === 'tommy');
    assert.strictEqual(r.action, 'rename'); assert.strictEqual(r.suggestion, 'Oak'); assert.strictEqual(r.confidence, 'high');
    assert.strictEqual(m.action, 'merge'); assert.strictEqual(m.mergeInto, 'Bisque Oasis'); assert.strictEqual(m.confidence, 'merge');
    const item = toItem(r), mitem = toItem(m);

    // ── rename ──
    let d = await applySse({ items: [item], dryRun: true });
    assert.strictEqual(writes.length, 0); assert(/Would rename Color: "Default" → "Oak"/.test(d.log[0].message), JSON.stringify(d));
    d = await applySse({ items: [{ ...item, newName: 'brown' }], dryRun: false });
    assert.strictEqual(d.failed, 1); assert.strictEqual(writes.length, 0);

    // ── merge: dry run ──
    d = await applySse({ items: [mitem], dryRun: true });
    assert(/Would move 4 Chairs, 6 Chairs from "Default Title" → "Bisque Oasis" and remove "Default Title"/.test(d.log[0].message), d.log[0].message);
    assert.strictEqual(writes.length, 0);

    // ── both live ──
    d = await applySse({ items: [item, mitem], dryRun: false });
    assert.strictEqual(d.changed, 2, JSON.stringify(d.log)); assert(d.undoId);
    assert.strictEqual(P.options[0].optionValues[1].name, 'Oak');
    assert.deepStrictEqual(colours(T), ['Bisque Oasis', 'Bisque Oasis', 'Bisque Oasis'], 'all sizes under Bisque Oasis');
    assert.deepStrictEqual(T.options[0].optionValues.map(v => v.name), ['Bisque Oasis'], 'Default Title removed');
    assert.deepStrictEqual(T.variants.nodes.map(v => v.sku), ['UD-1276316-708', 'UD-1276316-709', 'UD-1276316-710'], 'SKUs unchanged');
    assert(/Moved 4 Chairs, 6 Chairs from "Default Title" → "Bisque Oasis" and "Default Title" removed/.test(d.log[1].message), d.log[1].message);
    // again → nothing to merge
    d = await applySse({ items: [mitem], dryRun: false });
    assert.strictEqual(d.skipped, 1);

    // ── undo both ──
    const runs = (await (await fetch(base() + '/api/shopify/undo/runs')).json()).runs;
    const run = runs.find(x => x.kind === 'default-colour');
    assert(run && run.counts['option-value'] === 1 && run.counts['variant-merge'] === 1, JSON.stringify(runs.slice(0, 2)));
    let u = await (await post(`/api/shopify/undo/${run.id}`, { dryRun: true })).json();
    assert(u.log.some(l => /Would move 4 Chairs, 6 Chairs back from "Bisque Oasis" → "Default Title"/.test(l.message)), JSON.stringify(u.log));
    assert(u.log.some(l => /Would put Color back: "Oak" → "Default"/.test(l.message)), JSON.stringify(u.log));
    u = await (await post(`/api/shopify/undo/${run.id}`, { dryRun: false })).json();
    assert.strictEqual(u.undone, 2, JSON.stringify(u));
    assert.strictEqual(P.options[0].optionValues[1].name, 'Default');
    assert.deepStrictEqual(colours(T), ['Bisque Oasis', 'Default Title', 'Default Title']);
    require('fs').unlinkSync(require('../utils/undoLog').file(run.id));
    console.log('DEFAULT COLOUR ROUTE TESTS PASSED');
  } catch (e) { console.error('DEFAULT COLOUR ROUTE TESTS FAILED', e); process.exitCode = 1; }
  server.close(); setTimeout(() => process.exit(), 100);
})();
