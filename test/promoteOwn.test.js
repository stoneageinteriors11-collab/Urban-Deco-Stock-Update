// Step 3 "Publish Selected as Main Product" — the own-variant rule (London case).
//   Brown product: own variant Brown → CFS product inactive/missing → whole product DRAFT
//   Grey product:  own variant Grey  → UD-1239265; Brown kept if its CFS product exists, deleted if not in CFS
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
      data = { productByHandle: p ? { id: p.id, title: p.title, status: p.status, vendor: p.vendor || 'Urban Deco', images: { edges: [] },
        variants: { edges: p.variants.map(n => ({ node: { ...n, image: null } })) } } : null }; break;
    }
    case 'productVariantsBulkDelete': { const p = byId(v.productId); p.variants = p.variants.filter(n => !v.variantsIds.includes(n.id)); data = { productVariantsBulkDelete: { userErrors: [] } }; break; }
    case 'productVariantsBulkUpdate': { const p = byId(v.productId); for (const u of v.variants) p.variants.find(n => n.id === u.id).sku = u.sku; data = { productVariantsBulkUpdate: { userErrors: [] } }; break; }
    case 'productUpdate': {
      const p = byId(v.productId || v.product?.id || v.input?.id);
      if (v.product?.vendor) p.vendor = v.product.vendor;
      else p.status = v.product?.status || (/DRAFT/.test(q) ? 'DRAFT' : 'ACTIVE');
      data = { productUpdate: { product: { id: p.id }, userErrors: [] } }; break;
    }
    case 'product': { const p = byId(v.id); data = { product: p ? { id: p.id, title: p.title, status: p.status, vendor: p.vendor || 'Urban Deco', variants: { nodes: p.variants } } : null }; break; }
    default: throw new Error('mock: unhandled ' + op);
  }
  return { data: { data } };
};
axios.get = async (url) => {
  if (url.includes('productVariantStockJsonCFS')) return { data: [
    { productId: 1239265, productName: 'London Recliner Sofa 3 Seater Grey Leather' },
    { productId: 1239270, productName: 'London Recliner Sofa 3 Seater Brown Leather' },
    { productId: 1244789, productName: 'Posey Emerald Green Fabric Ottoman Bed - 4ft 6in Double', productCode: 'P75' }] };
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
      assert(msgs.some(m => m.startsWith(H_G) && (brownStatus === 'orphaned' ? /Would delete variant "Brown \/ Manual Recliner" \(not in CFS\)/ : /Would leave variant "Brown \/ Manual Recliner" as it is/).test(m)), msgs.join('\n'));
      assert(msgs.some(m => m.startsWith(H_G) && /Would update SKU "UD-1239265-17200080" → "UD-1239265" \(own variant/.test(m)), msgs.join('\n'));
      assert.deepStrictEqual(r.imageSyncHandles, [H_G], 'only the Grey product goes to Image Sync');
      r = await call('/api/shopify/publish-products', { variants: selected, related, dryRun: false });
      const b = products[H_B], g = products[H_G];
      assert.strictEqual(b.status, 'DRAFT'); assert.strictEqual(b.variants.length, 2, 'Brown product keeps its variants');
      assert.strictEqual(g.status, 'ACTIVE');
      if (brownStatus === 'orphaned') assert.deepStrictEqual(g.variants.map(n => n.sku), ['UD-1239265'], 'Brown (not in CFS) removed from Grey product');
      else assert.deepStrictEqual(g.variants.map(n => n.sku), [BROWN, 'UD-1239265'], 'Brown (CFS product inactive) left as it is');
      console.log(msgs.join('\n'));
    }
    // B. CFS Brown product ACTIVE → both products keep Brown + Grey, SKUs shortened to the CFS products
    reset();
    const related = rows('cfs-product').map(r => r.variantSku === BROWN ? { ...r, cfsProductStatus: 'active' } : r);
    const selected = related.filter(r => r.handle === H_B);
    const rr = await call('/api/shopify/publish-products', { variants: selected, related, dryRun: true });
    console.log(rr.log.map(l => `${l.handle}: ${l.message}`).join('\n'));
    await call('/api/shopify/publish-products', { variants: selected, related, dryRun: false });
    assert.deepStrictEqual(products[H_B].variants.map(n => n.sku), ['UD-1239270', 'UD-1239265'], 'Brown product: own Brown + Grey sibling kept, both shortened');
    assert.deepStrictEqual(products[H_G].variants.map(n => n.sku), ['UD-1239270', 'UD-1239265'], 'Grey product: Brown sibling kept too');
    assert(products[H_B].status === 'ACTIVE' && products[H_G].status === 'ACTIVE');
    // C. Unclear title → nothing changed
    reset(); products[H_B].title = 'London Recliner Sofa - 3 Seater - Brown and Grey Leather';
    const r = await call('/api/shopify/publish-products', { variants: rows('orphaned').filter(x => x.handle === H_B && x.variantSku === BROWN), related: rows('orphaned').filter(x => x.handle === H_B), dryRun: false });
    assert(r.flagged >= 1 && products[H_B].variants.length === 2 && products[H_B].status === 'ACTIVE', JSON.stringify(r.log));
    // D. CFS turned two Green sizes into ONE product "… Emerald Green … – 4ft 6in Double" (no variants)
    const H_P = 'posey-green';
    const posey = (codes) => {
      const mv = (id, sku, colour, size, code) => ({ id: `gid://shopify/ProductVariant/${id}`, sku, title: `${colour} / ${size}`, code,
        selectedOptions: [{ name: 'Color', value: colour }, { name: 'Size', value: size }] });
      products[H_P] = { id: 'gid://shopify/Product/9', handle: H_P, title: 'Posey Emerald Green Fabric Ottoman Bed - Sizes Available', status: 'ACTIVE', variants: [
        mv(91, 'UD-1244789-17221692', 'Green', '4ft 6in Double', codes[0]), mv(92, 'UD-1244789-17221693', 'Green', '5ft King Size', codes[1]),
        mv(93, 'UD-1244790-17221694', 'Blue', '4ft 6in Double', 'P77')] };
      const rel = products[H_P].variants.map(n => ({ handle: H_P, variantSku: n.sku, shopifyVariantCode: n.code,
        matchStatus: n.sku.startsWith('UD-1244789') ? 'cfs-product' : 'ok', cfsProductStatus: 'active' }));
      return { rel, sel: rel.filter(r => r.matchStatus === 'cfs-product') };
    };
    // D1. code + name agree (4ft = P75) → keep 4ft as UD-1244789, delete 5ft, Blue untouched
    reset(); let pz = posey(['P75', 'P76']);
    let rd = await call('/api/shopify/publish-products', { variants: pz.sel, related: pz.rel, dryRun: true });
    const ml = rd.log.map(l => l.message).join('\n'); console.log(ml);
    assert(/Would update SKU "UD-1244789-17221692" → "UD-1244789"/.test(ml) && /Would delete variant "Green \/ 5ft King Size" \(CFS product UD-1244789 is now only "Green \/ 4ft 6in Double" — product code P75/.test(ml), ml);
    await call('/api/shopify/publish-products', { variants: pz.sel, related: pz.rel, dryRun: false });
    assert.deepStrictEqual(products[H_P].variants.map(n => n.sku), ['UD-1244789', 'UD-1244790-17221694']);
    // D2. no saved codes → the CFS name decides
    reset(); pz = posey(['', '']);
    await call('/api/shopify/publish-products', { variants: pz.sel, related: pz.rel, dryRun: false });
    assert.deepStrictEqual(products[H_P].variants.map(n => n.sku), ['UD-1244789', 'UD-1244790-17221694'], 'name picks 4ft 6in');
    // D3. code says 5ft but name says 4ft → flag, nothing changed
    reset(); pz = posey(['P76', 'P75']);
    rd = await call('/api/shopify/publish-products', { variants: pz.sel, related: pz.rel, dryRun: false });
    assert(rd.flagged >= 1 && /product code P75 says "Green \/ 5ft King Size" but the CFS name/.test(rd.log[0].message), JSON.stringify(rd.log));
    assert.strictEqual(products[H_P].variants.length, 3);
    // D4. "Needs your decision": the flag comes with options; choosing 4ft applies only to that product
    const dec = rd.decisions.find(x => x.handle === H_P);
    assert(dec && dec.options.some(o => o.value === 'keep:gid://shopify/ProductVariant/91') && dec.options.some(o => o.value === 'draft'), JSON.stringify(rd.decisions));
    rd = await call('/api/shopify/publish-products', { variants: pz.sel, related: pz.rel, decisions: { [H_P]: { keep: ['gid://shopify/ProductVariant/91'] } }, onlyHandles: [H_P], dryRun: false });
    assert.deepStrictEqual(products[H_P].variants.map(n => n.sku), ['UD-1244789', 'UD-1244790-17221694'], JSON.stringify(rd.log));
    assert(rd.log.some(l => /your choice/.test(l.message)));
    // D5. decision "draft"
    reset(); pz = posey(['P76', 'P75']);
    rd = await call('/api/shopify/publish-products', { variants: [], related: pz.rel, decisions: { [H_P]: { draft: true } }, onlyHandles: [H_P], dryRun: false });
    assert(products[H_P].status === 'DRAFT' && products[H_P].variants.length === 3, JSON.stringify(rd.log));

    // E. Fix Selected SKUs
    reset(); products[H_B].variants[1].sku = 'UD-1239265- 17200080';
    let fx = await call('/api/shopify/fix-skus', { variants: [{ handle: H_B, variantSku: 'UD-1239265- 17200080', fixedSku: 'UD-1239265-17200080' }], dryRun: true });
    assert(/Would fix SKU "UD-1239265- 17200080" → "UD-1239265-17200080"/.test(fx.log[0].message) && products[H_B].variants[1].sku === 'UD-1239265- 17200080');
    fx = await call('/api/shopify/fix-skus', { variants: [{ handle: H_B, variantSku: 'UD-1239265- 17200080', fixedSku: 'UD-1239265-17200080' }], dryRun: false });
    assert(fx.fixed === 1 && products[H_B].variants[1].sku === 'UD-1239265-17200080' && fx.undoId);
    products[H_B].variants[0].sku = 'UD-1239265- 17200080';   // clean SKU already used on this product → not fixed
    fx = await call('/api/shopify/fix-skus', { variants: [{ handle: H_B, variantSku: 'UD-1239265- 17200080' }], dryRun: false });
    assert(fx.fixed === 0 && /already has SKU/.test(fx.log[0].message));
    assert(fx.decisions[0].options.some(o => o.value === 'delete-duplicate'));
    fx = await call('/api/shopify/fix-skus', { variants: [{ handle: H_B, variantSku: 'UD-1239265- 17200080', action: 'delete-duplicate' }], dryRun: false });
    assert(fx.fixed === 1 && products[H_B].variants.length === 1 && products[H_B].variants[0].sku === 'UD-1239265-17200080', JSON.stringify(fx.log));

    // F. Change vendor (Other brand tab) + Undo
    let vd = await call('/api/shopify/set-vendor', { items: [{ handle: H_G, vendor: 'Beehive' }], dryRun: false });
    assert(vd.changed === 1 && products[H_G].vendor === 'Beehive' && vd.undoId);
    const uv = await call(`/api/shopify/undo/${vd.undoId}`, { dryRun: false });
    assert(uv.undone === 1 && products[H_G].vendor === 'Urban Deco', JSON.stringify(uv.log));
    console.log('PROMOTE OWN-VARIANT TESTS PASSED');
  } catch (e) { console.error('PROMOTE OWN-VARIANT TESTS FAILED', e); process.exitCode = 1; }
  server.close();
  fs.rmSync(path.join(__dirname, '../uploads/step3-undo'), { recursive: true, force: true });
})();
