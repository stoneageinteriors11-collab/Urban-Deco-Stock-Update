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
        iid: p.iid ? { value: p.iid } : null, pcode: p.pcode ? { value: p.pcode } : null,
        variants: { edges: p.variants.map(n => ({ node: { ...n, image: null } })) } } : null }; break;
    }
    case 'productVariantsBulkDelete': { const p = byId(v.productId); p.variants = p.variants.filter(n => !v.variantsIds.includes(n.id)); data = { productVariantsBulkDelete: { userErrors: [] } }; break; }
    case 'productVariantsBulkUpdate': { const p = byId(v.productId); for (const u of v.variants) { if (u.sku !== undefined) throw new Error("Field sku is not defined by type ProductVariantsBulkInput"); p.variants.find(n => n.id === u.id).sku = (u.inventoryItem ? u.inventoryItem.sku : u.sku); } data = { productVariantsBulkUpdate: { userErrors: [] } }; break; }
    case 'productUpdate': {
      const p = byId(v.productId || v.product?.id || v.input?.id);
      if (v.product?.vendor) p.vendor = v.product.vendor;
      else if (v.product?.title) { p.title = v.product.title; if (v.product.handle) { products[v.product.handle] = p; if (v.product.handle !== p.handle) delete products[p.handle]; p.handle = v.product.handle; } }
      else p.status = v.product?.status || (/DRAFT/.test(q) ? 'DRAFT' : 'ACTIVE');
      data = { productUpdate: { product: { id: p.id, title: p.title, handle: p.handle }, userErrors: [] } }; break;
    }
    case 'product': { const p = byId(v.id); data = { product: p ? { id: p.id, title: p.title, handle: p.handle, status: p.status, vendor: p.vendor || 'Urban Deco', variants: { nodes: p.variants } } : null }; break; }
    default: throw new Error('mock: unhandled ' + op);
  }
  return { data: { data } };
};
axios.get = async (url) => {
  if (url.includes('productVariantStockJsonCFS')) return { data: [
    { productId: 1239265, productName: 'London Recliner Sofa 3 Seater Grey Leather' },
    { productId: 1239270, productName: 'London Recliner Sofa 3 Seater Brown Leather' },
    { productId: 1244789, productName: 'Posey Emerald Green Fabric Ottoman Bed - 4ft 6in Double', productCode: 'P75' },
    { productId: 1276461, productName: 'Jesper Natural Mango Wood 230cm Dining Table', productCode: '13860' },
    { productId: 1276463, productName: 'Jesper Black Mango Wood 230cm Dining Table', productCode: '13866' }] };
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
    // G. Own variant gone, others only sold here (Vernal) → ask; keep as Grey → delete White + rename
    const H_V = 'vernal-coffee-table-white-sintered-stone';
    const vernal = () => { products[H_V] = { id: 'gid://shopify/Product/77', handle: H_V, title: 'Vernal Coffee Table - White Sintered Stone', status: 'ACTIVE', variants: [
      { id: 'gid://shopify/ProductVariant/771', sku: 'UD-650809', title: 'White', selectedOptions: [{ name: 'Color', value: 'White' }] },
      { id: 'gid://shopify/ProductVariant/772', sku: 'UD-650824', title: 'Grey', selectedOptions: [{ name: 'Color', value: 'Grey' }] }] }; };
    const delBody = extra => ({ variants: [{ handle: H_V, variantSku: 'UD-650809', title: 'Vernal' }], cfsProductIds: [['650824', 'active']], cfsVariantAttrIds: [],
      skuHomes: { 'UD-650809': [H_V], 'UD-650824': [H_V] }, ...extra });
    reset(); vernal();
    let dv = await call('/api/shopify/delete-variants-bulk', delBody({ dryRun: true }));
    assert(dv.log.some(l => l.status === 'flagged' && /"Grey" is only sold on this product/.test(l.message)), JSON.stringify(dv.log));
    const dvo = dv.decisions[0].options.map(o => o.value + ' | ' + o.label);
    console.log(dvo.join('\n'));
    assert(/keepas:gid:\/\/shopify\/ProductVariant\/772 \| Keep as the "Grey" product — delete "White", title → "Vernal Coffee Table - Grey Sintered Stone", URL → \/vernal-coffee-table-grey-sintered-stone/.test(dvo[0]), dvo[0]);
    dv = await call('/api/shopify/delete-variants-bulk', delBody({ dryRun: false }));
    assert(products[H_V].variants.length === 2 && products[H_V].status === 'ACTIVE', 'no decision → nothing changed live');
    dv = await call('/api/shopify/delete-variants-bulk', delBody({ dryRun: true, decisions: { [H_V]: { keepAs: 'gid://shopify/ProductVariant/772' } } }));
    assert(dv.log.some(l => /would rename the title "Vernal Coffee Table - White Sintered Stone" → "Vernal Coffee Table - Grey Sintered Stone", URL \/vernal-coffee-table-white-sintered-stone → \/vernal-coffee-table-grey-sintered-stone/.test(l.message)), JSON.stringify(dv.log));
    dv = await call('/api/shopify/delete-variants-bulk', delBody({ dryRun: false, decisions: { [H_V]: { keepAs: 'gid://shopify/ProductVariant/772' } } }));
    const pv = products['vernal-coffee-table-grey-sintered-stone'];
    assert(pv && pv.title === 'Vernal Coffee Table - Grey Sintered Stone' && pv.variants.map(n => n.sku).join() === 'UD-650824', JSON.stringify(dv.log));
    assert(dv.log.some(l => /Title renamed .* \(old URL redirects\) — you can change the title manually later/.test(l.message)));
    const uu = await call(`/api/shopify/undo/${dv.undoId}`, { dryRun: false });
    assert(products[H_V] && products[H_V].title === 'Vernal Coffee Table - White Sintered Stone', 'Undo puts title + URL back: ' + JSON.stringify(uu.log));
    // G2. Same, but Grey also sold on its own product (Carrera case) → Draft as before
    reset(); vernal();
    dv = await call('/api/shopify/delete-variants-bulk', { ...delBody({ dryRun: false }), skuHomes: { 'UD-650809': [H_V], 'UD-650824': [H_V, 'vernal-grey'] } });
    assert(products[H_V].status === 'DRAFT' && products[H_V].variants.length === 2, JSON.stringify(dv.log));
    // G3. Publish: own variant not in CFS, other only sold here → ask with keep-as options
    reset(); vernal();
    const rel = [{ handle: H_V, variantSku: 'UD-650809', matchStatus: 'orphaned' }, { handle: H_V, variantSku: 'UD-650824', matchStatus: 'cfs-product', cfsProductStatus: 'active' }];
    let pb = await call('/api/shopify/publish-products', { variants: [rel[1]], related: rel, dryRun: true, skuHomes: { 'UD-650809': [H_V], 'UD-650824': [H_V] } });
    assert(pb.decisions[0].options.some(o => o.value === 'keepas:gid://shopify/ProductVariant/772'), JSON.stringify(pb.decisions));
    pb = await call('/api/shopify/publish-products', { variants: [rel[1]], related: rel, dryRun: false, skuHomes: { 'UD-650809': [H_V], 'UD-650824': [H_V] },
      decisions: { [H_V]: { keepAs: 'gid://shopify/ProductVariant/772' } }, onlyHandles: [H_V] });
    const pv2 = products['vernal-coffee-table-grey-sintered-stone'];
    assert(pv2 && pv2.variants.map(n => n.sku).join() === 'UD-650824' && pv2.status === 'ACTIVE', JSON.stringify(pb.log));
    // H. Other brands: own variant by iproductid / product code (Jesper — title says "Chestnut", variant says "Brown")
    const jv = (n, sku, col) => ({ id: `gid://shopify/ProductVariant/${n}`, sku, title: col, selectedOptions: [{ name: 'Color', value: col }] });
    const jesper = () => {
      products['jesper-chestnut'] = { id: 'gid://shopify/Product/81', handle: 'jesper-chestnut', title: 'Jesper Dining Table - 230cm - 10 Seater - Star Base - Chestnut - Mango Wood', status: 'ACTIVE', iid: '1276462', pcode: '31021',
        variants: [jv(811, 'UD-1276462', 'Brown'), jv(812, 'UD-1276461', 'Natural'), jv(813, 'UD-1276463', 'Black')] };
      products['jesper-natural'] = { id: 'gid://shopify/Product/82', handle: 'jesper-natural', title: 'Jesper Dining Table - 230cm - 10 Seater - Star Base - Natural - Mango Wood', status: 'ACTIVE', iid: '1276461', pcode: '13860',
        variants: [jv(821, 'UD-1276461', 'Natural'), jv(822, 'UD-1276463', 'Black'), jv(823, 'UD-1276462', 'Brown')] };
    };
    const homes = { 'UD-1276462': ['jesper-chestnut', 'jesper-natural'], 'UD-1276461': ['jesper-chestnut', 'jesper-natural'], 'UD-1276463': ['jesper-chestnut', 'jesper-natural'] };
    const jrows = [{ handle: 'jesper-chestnut', variantSku: 'UD-1276462' }, { handle: 'jesper-natural', variantSku: 'UD-1276462' }];
    const jbody = extra => ({ variants: jrows, cfsProductIds: [['1276461', 'active'], ['1276463', 'active']], cfsVariantAttrIds: [], skuHomes: homes, brandId: 364, ...extra });
    reset(); jesper();
    let jd = await call('/api/shopify/delete-variants-bulk', jbody({ dryRun: true }));
    const jm = jd.log.map(l => `${l.handle}: ${l.message}`).join('\n'); console.log(jm);
    assert(/jesper-chestnut: Would set .*Chestnut.* to DRAFT — this product is "Brown" \(UD-1276462\) and that is not in CFS — the other colours are sold on their own products/.test(jm), jm);
    assert(/jesper-natural: Would delete variant "Brown"/.test(jm), jm);
    jd = await call('/api/shopify/delete-variants-bulk', jbody({ dryRun: false }));
    assert(products['jesper-chestnut'].status === 'DRAFT' && products['jesper-chestnut'].variants.length === 3, 'Chestnut drafted, variants kept');
    assert.deepStrictEqual(products['jesper-natural'].variants.map(v => v.sku), ['UD-1276461', 'UD-1276463'], 'Brown deleted from Natural');
    // Urban Deco (no brandId) keeps the title rule: can't tell → only the missing variant is deleted
    reset(); jesper();
    jd = await call('/api/shopify/delete-variants-bulk', { ...jbody({ dryRun: true }), brandId: null });
    assert(/jesper-chestnut: Would delete variant "Brown"/.test(jd.log.map(l => `${l.handle}: ${l.message}`).join('\n')), 'UD unchanged');
    // iproductid and product code disagree → flagged, nothing changed
    reset(); jesper(); products['jesper-chestnut'].pcode = '13866';
    jd = await call('/api/shopify/delete-variants-bulk', jbody({ dryRun: false }));
    assert(products['jesper-chestnut'].status === 'ACTIVE' && products['jesper-chestnut'].variants.length === 3, JSON.stringify(jd.log));
    assert(jd.log.some(l => l.status === 'flagged' && /iproductid 1276462 says "Brown" but product code 13866 says "Black"/.test(l.message)), JSON.stringify(jd.log));
    console.log('PROMOTE OWN-VARIANT TESTS PASSED');
  } catch (e) { console.error('PROMOTE OWN-VARIANT TESTS FAILED', e); process.exitCode = 1; }
  server.close();
  fs.rmSync(path.join(__dirname, '../uploads/step3-undo'), { recursive: true, force: true });
})();
