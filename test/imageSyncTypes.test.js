// Image Sync product-type filter: ticked types OR title words; dry run only takes matching products
const assert = require('assert');
const { makeTypeFilter, typeLabel } = require('../utils/imageSyncCore');

assert.strictEqual(typeLabel('Furniture > Tables > Accent Tables > Coffee Tables'), 'Coffee Tables');
assert.strictEqual(typeLabel(''), '');
assert.strictEqual(makeTypeFilter({}), null);
assert.strictEqual(makeTypeFilter({ types: [], words: [' '] }), null);

const f = makeTypeFilter({ types: ['Furniture > Sofas'], words: ['Armchairs', 'dining table'] });
const P = (title, productType = '') => ({ title, productType });
assert(f(P('Bella Sofa - Grey', 'Furniture > Sofas')));
assert(f(P('Bella Sofa', 'furniture > sofas ')));                      // case / spaces ignored
assert(f(P('Lounge Armchair - Velvet')));                               // "Armchairs" → "armchair"
assert(f(P('Milan Dining Table - White Marble', 'Furniture > Tables > Kitchen & Dining Room Tables')));
assert(!f(P('Milan Coffee Table', 'Furniture > Tables > Accent Tables > Coffee Tables')));
assert(!f(P('Chest - 3 Drawer')));
assert(/Sofas/.test(f.describe) && /title has "armchair"/.test(f.describe));
assert(makeTypeFilter({ words: ['glass'] })(P('Glass Vase')));          // "glass" not cut to "glas"… still matches
console.log('IMAGE SYNC TYPE FILTER TESTS PASSED');

// ── Route: /types and /dry-run with a filter (fake Shopify, empty CFS feed) ──
const axios = require('axios');
const http = require('node:http');
process.env.SHOPIFY_STORE = 'mock.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = 'x';
const store = [
  ['Bella Sofa', 'Furniture > Sofas'], ['Rio Coffee Table', 'Furniture > Tables > Accent Tables > Coffee Tables'],
  ['Luca Sofa', 'Furniture > Sofas'], ['Lounge Armchair', ''], ['Nova Sofa', 'Furniture > Sofas'], ['Chest', ''],
].map(([title, productType], i) => ({ id: `gid://shopify/Product/${i + 1}`, title, productType, vendor: 'Urban Deco' }));
const full = p => ({ id: p.id, handle: p.title.toLowerCase().replace(/ /g, '-'), title: p.title, status: 'ACTIVE', vendor: p.vendor, updatedAt: 't',
  featuredMedia: null, options: [], media: { nodes: [] }, variants: { nodes: [] }, metafield: null });
const seen = { light: [], nodes: [] };
axios.post = async (url, body) => {
  const q = body.query, v = body.variables || {};
  let data;
  if (/productType/.test(q)) {           // light list: page size 2 here so paging is tested
    const start = v.after ? Number(v.after) : 0, first = Math.min(v.first, 2);
    const slice = store.slice(start, start + first);
    seen.light.push(v.after || null);
    data = { products: { pageInfo: { hasNextPage: start + first < store.length, endCursor: String(start + slice.length) },
      edges: slice.map((node, i) => ({ cursor: String(start + i + 1), node })) } };
  } else if (/nodes\(ids/.test(q)) { seen.nodes.push(...v.ids); data = { nodes: v.ids.map(id => full(store.find(p => p.id === id))) }; }
  else if (/products\(/.test(q)) data = { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: store.map(full) } };
  else data = {};
  return { data: { data } };
};
axios.get = async (url) => { if (url.includes('cronItemGalleryUrls')) return { data: JSON.stringify({ generated: 'now', totalProducts: 1, products: [{ iProductId: 999, vSKU: 'X', mainImage: 'https://img.example/a.jpg', galleryCount: 0, galleryImages: [] }] }), headers: {} }; const e = new Error('404'); e.response = { status: 404 }; throw e; };

const express = require('express');
const app = express(); app.use(express.json()); app.use('/api/images', require('../routes/imagesync'));
const server = app.listen(0);
const call = (method, p, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request(`http://127.0.0.1:${server.address().port}/api/images${p}`, { method, headers: data ? { 'Content-Type': 'application/json' } : {} }, res => {
    const c = []; res.on('data', d => c.push(d)); res.on('end', () => { const t = Buffer.concat(c).toString();
      resolve((res.headers['content-type'] || '').includes('event-stream') ? t.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))) : JSON.parse(t)); });
  }); r.on('error', reject); if (data) r.write(data); r.end();
});
(async () => {
  try {
    const t = await call('GET', '/types');
    assert.strictEqual(t.total, 6); assert.strictEqual(t.blank, 2);
    assert.deepStrictEqual(t.types.map(x => [x.label, x.count]), [['Coffee Tables', 1], ['Sofas', 3]]);

    // batch of 2 sofas → Bella + Luca, next batch continues after Luca → Nova
    let ev = await call('POST', '/dry-run', { limit: 2, types: ['Furniture > Sofas'] });
    let done = ev[ev.length - 1];
    assert.strictEqual(done.type, 'done', JSON.stringify(done));
    assert.deepStrictEqual(done.plans.map(p => p.title), ['Bella Sofa', 'Luca Sofa']);
    assert.strictEqual(done.filter.matched, 2); assert(done.nextCursor);
    ev = await call('POST', '/dry-run', { limit: 2, types: ['Furniture > Sofas'], after: done.nextCursor });
    done = ev[ev.length - 1];
    assert.deepStrictEqual(done.plans.map(p => p.title), ['Nova Sofa']); assert.strictEqual(done.nextCursor, null);

    // type OR title word (armchair has no product type)
    ev = await call('POST', '/dry-run', { limit: 25, types: ['Furniture > Tables > Accent Tables > Coffee Tables'], words: ['armchairs'] });
    done = ev[ev.length - 1];
    assert.deepStrictEqual(done.plans.map(p => p.title), ['Rio Coffee Table', 'Lounge Armchair']);
    assert(!seen.nodes.includes('gid://shopify/Product/6'), 'non-matching products are never fully loaded');

    // no filter → old behaviour (all products)
    ev = await call('POST', '/dry-run', { limit: 25 });
    assert.strictEqual(ev[ev.length - 1].plans.length, 6);
    console.log('IMAGE SYNC TYPE ROUTE TESTS PASSED');
  } catch (e) { console.error('IMAGE SYNC TYPE ROUTE TESTS FAILED', e); process.exitCode = 1; }
  server.close(); setTimeout(() => process.exit(), 100);
})();
