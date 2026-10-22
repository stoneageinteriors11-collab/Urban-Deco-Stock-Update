// Step 3 "Publish Selected as Main Product" — the own-variant rule (London case).
//   Brown product: own variant Brown → CFS product inactive/missing → whole product DRAFT
//   Grey product:  own variant Grey  → promoted (UD-1239265), Brown variant removed
// Fake Shopify + fake CFS feed; nothing real is called.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
process.env.SHOPIFY_STORE = 'mock.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = 'x';

const BROWN = 'UD-1239270-17200085', GREY = 'UD-1239265-17200080';
let products;
function reset() {
  const mk = (n, handle, title) => ({ id: `gid://shopify/Product/${n}`, handle, title, status: 'ACTIVE', variants: [
    { id: `gid://shopify/ProductVariant/${n}1`, sku: BROWN, title: 'Brown / Manual Recliner', selectedOptions: [{ name: 'Colour', value: 'Brown' }, { name: 'Type', value: 'Manual Recliner' }] },
    { id: `gid://shopify/ProductVariant/${n}2`, sku: GREY, title: 'Grey / One Size', selectedOptions: [{ name: 'Colour', value: 'Grey' }, { name: 'Type', value: 'One Size' }] }] });
  products = {
    'london-recliner-sofa-3-seater-brown-leather': mk(1, 'london-recliner-sofa-3-seater-brown-leather', 'London Recliner Sofa - 3 Seater - Brown Leather'),
    'london-recliner-sofa-3-seater-grey-leather': mk(2, 'london-recliner-sofa-3-seater-grey-leather', 'London Recliner Sofa - 3 Seater - Grey Leather'),
  };
}
const byId = id => Object.values(products).find(p => p.id === id);
axios.post = async (url, body) => {
  const q = body.query, v = body.variables || {};
  const op = (q.match(/(?:query|mutation)\s+\w+[^{]*\{\s*(\w+)/) || q.match(/\{\s*(\w+)/))[1];
  let data;
  switch (op) {
    case 'productByHandle': {
      const p = products[v.handle || v.h];
      data = { productByHandle: p ? { id: p.id, title: p.title, status: p.status, images: { edges: [] },
        variants: { edges: p.variants.map(n => ({ node: { ...n, image: null } })) } } : null }; break;
    }
    case 'productVariantsBulkDelete': { const p = byId(v.productId); p.variants = p.variants.filter(n => !v.variantsIds.includes(n.id)); data = { productVariantsBulkDelete: { userErrors: [] } }; break; }
    case 'productVariantsBulkUpdate': { const p = byId(v.productId); for (const u of v.variants) p.variants.find(n => n.id === u.id).sku = u.sku; data = { productVariantsBulkUpdate: { userErrors: [] } }; break; }
    case 'productUpdate': {
      const p = byId(v.productId || v.product?.id || v.input?.id);
      p.status = v.product?.status || (/DRAFT/.test(q) ? 'DRAFT' : 'ACTIVE'); data = { productUpdate: { product: { id: p.id }, userErrors: [] } }; break;
    }
    default: throw new Error('mock: unhandled ' + op);
  }
  return { data: { data } };
};
axios.get = async (url) => {
  if (url.includes('productVariantStockJsonCFS')) return { data: [
    { productId: 1239265, productName: 'London Recliner Sofa 3 Seater Grey Leather' },
    { productId: 1239270, productName: 'London Recliner Sofa 3 Seater Brown Leather' }] };
  throw new Error('404');
};

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/shopify', require('../routes/shopify'));
const server = app.listen(0);
const call = (p, body) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

const H_B = 'london-recliner-sofa-3-seater-brown-leather', H_G = 'london-recliner-sofa-3-seater-grey-leather';
// comparison rows: both SKUs are "CFS product match"; Brown's CFS product is the one in question
const rows = (brownStatus) => [H_B, H_G].flatMap(h => [
  { handle: h, variantSku: BROWN, matchStatus: brownStatus, cfsProductStatus: brownStatus === 'cfs-product' ? 'inactive' : undefined, sharedSkuHandles: [h === H_B ? H_G : H_B] },
  { handle: h, variantSku: GREY, matchStatus: 'cfs-product', cfsProductStatus: 'active', sharedSkuHandles: [h === H_B ? H_G : H_B] }]);

(async () => {
  try {
    // A. Only the Brown product's Brown row ticked (what happened live). CFS Brown product inactive.
    for (const brownStatus of ['cfs-product', 'orphaned']) {
      reset();
      const related = rows(brownStatus);
      const selected = related.filter(r => r.handle === H_B && r.variantSku === BROWN).map(r => ({ ...r, matchStatus: 'cfs-product', cfsProductStatus: 'inactive' }));
      let r = await call('/api/shopify/publish-products', { variants: selected, related, dryRun: true });
      const msgs = r.log.map(l => `${l.handle}: ${l.message}`);
      assert(msgs.some(m => m.startsWith(H_B) && /Would set "London Recliner Sofa - 3 Seater - Brown Leather" to DRAFT — this product is "Brown"/.test(m)), msgs.join('\n'));
      assert(msgs.some(m => m.startsWith(H_G) && /Would delete variant "Brown \/ Manual Recliner" \(not this product's own variant\)/.test(m)), msgs.join('\n'));
      assert(msgs.some(m => m.startsWith(H_G) && /Would update SKU "UD-1239265-17200080" → "UD-1239265" & set product to ACTIVE/.test(m)), msgs.join('\n'));
      assert.deepStrictEqual(r.imageSyncHandles, [H_G], 'only the Grey product goes to Image Sync');
      r = await call('/api/shopify/publish-products', { variants: selected, related, dryRun: false });
      const b = products[H_B], g = products[H_G];
      assert.strictEqual(b.status, 'DRAFT'); assert.strictEqual(b.variants.length, 2, 'Brown product keeps its variants');
      assert.strictEqual(g.status, 'ACTIVE'); assert.deepStrictEqual(g.variants.map(n => n.sku), ['UD-1239265'], 'Grey product = main product');
      if (brownStatus === 'cfs-product') console.log(msgs.join('\n'));
    }
    // B. CFS Brown product ACTIVE → Brown product becomes its own main product (Grey removed)
    reset();
    const related = rows('cfs-product').map(r => r.variantSku === BROWN ? { ...r, cfsProductStatus: 'active' } : r);
    const selected = related.filter(r => r.handle === H_B);
    await call('/api/shopify/publish-products', { variants: selected, related, dryRun: false });
    assert.deepStrictEqual(products[H_B].variants.map(n => n.sku), ['UD-1239270']);
    assert.deepStrictEqual(products[H_G].variants.map(n => n.sku), ['UD-1239265']);
    // C. Unclear title → nothing changed
    reset(); products[H_B].title = 'London Recliner Sofa - 3 Seater - Brown and Grey Leather';
    const r = await call('/api/shopify/publish-products', { variants: rows('orphaned').filter(x => x.handle === H_B && x.variantSku === BROWN), related: rows('orphaned').filter(x => x.handle === H_B), dryRun: false });
    assert(r.flagged >= 1 && products[H_B].variants.length === 2 && products[H_B].status === 'ACTIVE', JSON.stringify(r.log));
    console.log('PROMOTE OWN-VARIANT TESTS PASSED');
  } catch (e) { console.error('PROMOTE OWN-VARIANT TESTS FAILED', e); process.exitCode = 1; }
  server.close();
  fs.rmSync(path.join(__dirname, '../uploads/step3-undo'), { recursive: true, force: true });
})();
