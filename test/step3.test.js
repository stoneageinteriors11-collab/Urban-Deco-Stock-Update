// End-to-end test of routes/imagesync.js against a fake Shopify store + fake CFS feed.
// Nothing real is called: axios.get/post and fetch are replaced before the route loads.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

process.env.SHOPIFY_STORE = 'mock.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = 'x';

// ── Fake CFS feed + image server ─────────────────────────────────────────────
const IMG = 'https://images.example/';
const pics = {}; // url → Buffer
const pic = (name) => { const u = IMG + name; pics[u] = Buffer.from('JPEG:' + name); return u; };
const mkRec = (id, sku, colour) => ({
  iProductId: id, vSKU: sku, mainImage: pic(`Milan-${colour}.jpg`), galleryCount: 6,
  galleryImages: [1, 2, 3, 4, 5, 6].map(n => pic(`Milan-${colour}-0${n}.jpg`)),
});
const feed = { generated: 'now', totalProducts: 3, products: [mkRec(144250, 'CFSUD-069', 'White'), mkRec(601535, 'CFSUD-948', 'Grey'), mkRec(1262189, 'CFSUD-7996', 'Beige')] };

// ── Fake Shopify ─────────────────────────────────────────────────────────────
let nextId = 1000;
const files = new Map();      // mediaId → { id, alt, url, bytes, status }
const PID = 'gid://shopify/Product/1';
const product = { id: PID, handle: 'milan', title: 'Milan Dining Table', status: 'ACTIVE', vendor: 'Urban Deco', updatedAt: 't',
  options: [{ name: 'Color', position: 1, values: ['White', 'Grey', 'Beige'] }, { name: 'Size', position: 2, values: ['160', '180'] }],
  mediaIds: [], variants: [], metafield: null };
const cdn = n => `https://cdn.shopify.com/s/files/1/x/${n.replace('.jpg', '')}_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg`;
function addFile(alt, url, bytes) { const id = `gid://shopify/MediaImage/${nextId++}`; files.set(id, { id, alt, url, bytes, status: 'READY' }); pics[url] = bytes; return id; }
let vpos = 1;
for (const [colour, cfs] of [['White', 144250], ['Grey', 601535], ['Beige', 1262189]]) {
  const ids = [`Milan-${colour}.jpg`, ...[1, 2, 3, 4].map(n => `Milan-${colour}-0${n}.jpg`)].map(n => addFile(colour, cdn(n), Buffer.from('JPEG:' + n)));
  product.mediaIds.push(...ids);
  for (const size of ['160', '180']) product.variants.push({ id: `gid://shopify/ProductVariant/${vpos}`, sku: `UD-${cfs}-${vpos}`, title: `${colour} / ${size}`, position: vpos++,
    selectedOptions: [{ name: 'Color', value: colour }, { name: 'Size', value: size }], mediaIds: [ids[0]] });
}
// a manual lifestyle photo on Grey + the excluded -06 White image already live
const manualId = addFile('Grey', 'https://cdn.shopify.com/s/files/1/x/lifestyle.jpg', Buffer.from('LIFESTYLE'));
const liveExcludedId = addFile('White', cdn('Milan-White-06.jpg'), Buffer.from('JPEG:Milan-White-06.jpg'));
product.mediaIds.splice(5, 0, liveExcludedId);
product.mediaIds.push(manualId);

const productNode = () => ({
  id: product.id, handle: product.handle, title: product.title, status: product.status, vendor: product.vendor, updatedAt: product.updatedAt,
  featuredMedia: product.mediaIds[0] ? { id: product.mediaIds[0] } : null, options: product.options,
  media: { nodes: product.mediaIds.map(id => { const f = files.get(id); return { id, alt: f.alt, mediaContentType: 'IMAGE', status: 'READY', image: { url: f.url }, originalSource: { url: f.url } }; }) },
  variants: { nodes: product.variants.map(v => ({ id: v.id, sku: v.sku, title: v.title, position: v.position, selectedOptions: v.selectedOptions, media: { nodes: v.mediaIds.map(id => ({ id })) } })) },
  metafield: product.metafield,
});
const calls = [];
function shopify(query, vars) {
  const op = (query.match(/(?:query|mutation)\s+\w+[^{]*\{\s*(\w+)/) || query.match(/\{\s*(\w+)/))[1];
  calls.push(op);
  switch (op) {
    case 'currentAppInstallation': return { currentAppInstallation: { accessScopes: ['read_products', 'write_products', 'read_files', 'write_files'].map(handle => ({ handle })) } };
    case 'products':
      if (query.includes('metafield(') && !query.includes('variants')) return { products: { pageInfo: { hasNextPage: false }, nodes: [{ id: PID, handle: 'milan', title: 't', metafield: product.metafield }] } };
      return { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [productNode()] } };
    case 'product': return { product: vars.id === PID ? productNode() : null };
    case 'productByHandle': {
      const h = vars.h || vars.handle;
      if (h !== 'milan') return { productByHandle: null };
      if (query.includes('edges')) {   // routes/shopify.js shape
        const p = productNode();
        return { productByHandle: { id: p.id, title: p.title, status: product.status,
          images: { edges: p.media.nodes.map(m => ({ node: { id: m.id, altText: m.alt } })) },
          variants: { edges: product.variants.map(v => ({ node: { id: v.id, sku: v.sku, title: v.title, selectedOptions: v.selectedOptions, image: v.mediaIds[0] ? { id: v.mediaIds[0] } : null } })) } } };
      }
      return { productByHandle: productNode() };
    }
    case 'productVariantsBulkDelete':
      product.variants = product.variants.filter(v => !vars.variantsIds.includes(v.id));
      return { productVariantsBulkDelete: { product: { id: PID }, userErrors: [] } };
    case 'productVariantsBulkUpdate':
      for (const u of vars.variants) { const v = product.variants.find(x => x.id === u.id); if (v && u.sku) v.sku = u.sku; }
      return { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } };
    case 'productUpdate':
      if (vars.product?.status) product.status = vars.product.status;
      else if (/status: DRAFT/.test(query)) product.status = 'DRAFT';
      else if (/status: ACTIVE/.test(query)) product.status = 'ACTIVE';
      return { productUpdate: { product: { id: PID, status: product.status }, userErrors: [] } };
    case 'productVariants': return { productVariants: { nodes: [{ product: { id: PID } }] } };
    case 'nodes': return { nodes: vars.ids.map(id => files.has(id) ? { id, status: files.get(id).status, fileStatus: 'READY', alt: files.get(id).alt, image: { url: files.get(id).url } } : null) };
    case 'fileCreate': return { fileCreate: { userErrors: [], files: vars.files.map(f => {
      const src = f.originalSource; const bytes = pics[src] || stagedBlobs[src];
      const id = addFile(f.alt, `https://cdn.shopify.com/s/files/1/x/${f.filename.replace('.jpg', '')}_up${nextId}.jpg`, bytes);
      return { id, fileStatus: 'READY', alt: f.alt }; }) } };
    case 'fileUpdate':
      if (global.failAttachOnce && vars.files.some(f => f.referencesToAdd)) { global.failAttachOnce = false; return { fileUpdate: { userErrors: [{ message: 'simulated failure' }], files: [] } }; }
      for (const f of vars.files) {
        const file = files.get(f.id); if (!file) return { fileUpdate: { userErrors: [{ message: 'no file ' + f.id }], files: [] } };
        if (f.alt !== undefined) file.alt = f.alt;
        if (f.referencesToAdd) if (!product.mediaIds.includes(f.id)) product.mediaIds.push(f.id);
        if (f.referencesToRemove) { product.mediaIds = product.mediaIds.filter(x => x !== f.id); for (const v of product.variants) v.mediaIds = v.mediaIds.filter(x => x !== f.id); }
      }
      return { fileUpdate: { userErrors: [], files: [] } };
    case 'productReorderMedia': {
      const order = [...product.mediaIds];
      for (const m of vars.moves) { const i = order.indexOf(m.id); order.splice(i, 1); order.splice(Number(m.newPosition), 0, m.id); }
      product.mediaIds = order; return { productReorderMedia: { job: { id: 'j', done: true }, mediaUserErrors: [] } };
    }
    case 'productVariantDetachMedia': for (const vm of vars.variantMedia) product.variants.find(v => v.id === vm.variantId).mediaIds = []; return { productVariantDetachMedia: { userErrors: [] } };
    case 'productVariantAppendMedia': for (const vm of vars.variantMedia) product.variants.find(v => v.id === vm.variantId).mediaIds = vm.mediaIds; return { productVariantAppendMedia: { userErrors: [] } };
    case 'metafieldsSet': product.metafield = { id: 'mf', value: vars.metafields[0].value }; return { metafieldsSet: { userErrors: [], metafields: [{ id: 'mf' }] } };
    case 'fileDelete': for (const id of vars.fileIds) files.delete(id); return { fileDelete: { deletedFileIds: vars.fileIds, userErrors: [] } };
    case 'stagedUploadsCreate': { const r = `https://staged.example/${nextId++}`; return { stagedUploadsCreate: { userErrors: [], stagedTargets: [{ url: r + '/post', resourceUrl: r, parameters: [{ name: 'key', value: 'k' }] }] } }; }
    case 'job': return { job: { id: 'j', done: true } };
    default: throw new Error('mock: unhandled op ' + op);
  }
}
const stagedBlobs = {};
axios.post = async (url, body) => ({ data: { data: shopify(body.query, body.variables || {}) } });
axios.get = async (url) => {
  if (url.includes('productVariantStockJsonCFS')) return { data: [
    { productId: 144250, productName: 'Milan White Marble 6 Seater Dining Table' },
    { productId: 1262189, productName: 'Milan Travertine Beige Engineered Marble 6 Seater Dining Table' }] };
  if (global.slowImages && !url.includes('cronItemGalleryUrls')) await new Promise(r => setTimeout(r, 150));
  if (url.includes('cronItemGalleryUrls')) return { data: JSON.stringify(feed), headers: {} };
  const bare = url.split('?')[0];
  if (pics[url] || pics[bare]) return { data: pics[url] || pics[bare], headers: { 'content-type': 'image/jpeg' } };
  const e = new Error('404'); e.response = { status: 404 }; throw e;
};
global.fetch = async (url, opts) => { const blob = opts.body.get('file'); stagedBlobs[url.replace('/post', '')] = Buffer.from(await blob.arrayBuffer()); return { ok: true, status: 204 }; };


// Turn every placeholder into a real JPEG: same text → same picture (Shopify copies match CFS)
const sharp = require('sharp');
async function realImages() {
  const cache = new Map();
  for (const [u, b] of Object.entries(pics)) {
    const key = b.toString();
    if (!cache.has(key)) {
      const h = crypto.createHash('md5').update(key).digest();
      cache.set(key, await sharp({ create: { width: 1000, height: 1000, channels: 3, background: { r: h[0], g: h[1], b: h[2] } } })
        .composite([{ input: Buffer.from(`<svg width="1000" height="1000"><rect x="${h[3] * 2}" y="${h[4]}" width="500" height="300" fill="rgb(${h[5]},${h[6]},${h[7]})"/></svg>`) }])
        .jpeg({ quality: 85 }).toBuffer());
    }
    pics[u] = cache.get(key);
  }
  for (const f of files.values()) f.bytes = pics[f.url];
}


const express = require('express');
const app = express(); app.use(express.json({ limit: '10mb' }));
app.use('/api/images', require('../routes/imagesync'));
app.use('/api/shopify', require('../routes/shopify'));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const http = require('node:http');
function call(method, p, body, raw) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + p, { method, headers: data ? { 'Content-Type': 'application/json' } : {} }, res => {
      const c = []; res.on('data', x => c.push(x)); res.on('end', () => {
        const buf = Buffer.concat(c); if (raw) return resolve(buf);
        const t = buf.toString();
        if ((res.headers['content-type'] || '').includes('event-stream')) return resolve(t.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))));
        try { resolve({ status: res.statusCode, ...JSON.parse(t) }); } catch (_) { resolve(t); }
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const last = ev => ev[ev.length - 1];
(async () => {
  try {
    await realImages();
    // Bern-like: wipe alt texts so the old alt-text logic would have found nothing
    for (const f of files.values()) f.alt = '';
    const greySkus = product.variants.filter(v => v.title.startsWith('Grey')).map(v => v.sku);
    const greyMedia = product.mediaIds.filter(id => /Grey/.test(files.get(id).url));
    const greyCfsMediaCount = greyMedia.filter(id => !/lifestyle/.test(files.get(id).url)).length;
    const orphanRows = greySkus.map(sku => ({ handle: 'milan', variantSku: sku, title: 'Milan' }));

    // 1. photo check
    let ev = await call('POST', '/api/shopify/delete-variants-image-plan', { variants: orphanRows, cfsProductIds: [], cfsVariantAttrIds: [] });
    let d = last(ev); assert.strictEqual(d.type, 'done', JSON.stringify(d));
    console.log('PHOTO CHECK', JSON.stringify(d.summary), JSON.stringify(d.products[0].removedGroups));
    assert.strictEqual(d.summary.remove, greyCfsMediaCount, 'all Grey CFS photos found without alt text');
    assert.strictEqual(d.summary.check, 1, 'the hand-added lifestyle photo is flagged, not removed');
    const imagePlanId = d.imagePlanId;

    // 2. dry run log
    const before = [...product.mediaIds], beforeVariants = product.variants.length;
    let r = await call('POST', '/api/shopify/delete-variants-bulk', { variants: orphanRows, dryRun: true, cfsProductIds: [], cfsVariantAttrIds: [], imagePlanId });
    const rm = r.log.filter(l => l.imageVerdict === 'remove');
    assert.strictEqual(rm.length, greyCfsMediaCount);
    assert(rm.every(l => /WOULD REMOVE — Matches CFS (main|gallery) photo.* of removed Grey \(name \+ picture\)/.test(l.message)), rm[0].message);
    assert(r.log.some(l => l.imageVerdict === 'check' && /lifestyle/.test(l.message)));
    assert(!r.log.some(l => l.status === 'error'), 'dry run has no errors (scope bug fixed)');
    assert.deepStrictEqual(product.mediaIds, before); assert.strictEqual(product.variants.length, beforeVariants);
    console.log(rm[0].message);

    // 3. live without backup → refused, nothing changed
    r = await call('POST', '/api/shopify/delete-variants-bulk', { variants: orphanRows, dryRun: false, cfsProductIds: [], cfsVariantAttrIds: [], imagePlanId });
    assert.strictEqual(r.status, 400); assert.strictEqual(product.variants.length, beforeVariants);

    // 4. backup by handle → confirm → live run
    ev = await call('POST', '/api/images/backup', { handles: ['milan'], source: 'step-3' });
    d = last(ev); assert.strictEqual(d.type, 'done', JSON.stringify(d));
    const zip = await call('GET', `/api/images/backup/${d.backupId}/download`, null, true);
    assert((await call('POST', `/api/images/backup/${d.backupId}/confirm`, { sha256: crypto.createHash('sha256').update(zip).digest('hex') })).ok);
    r = await call('POST', '/api/shopify/delete-variants-bulk', { variants: orphanRows, dryRun: false, cfsProductIds: [], cfsVariantAttrIds: [], imagePlanId, backupId: d.backupId });
    console.log('LIVE', r.deleted, r.failed, r.log.filter(l => l.sku === '-').map(l => l.status + ': ' + l.message).slice(-2));
    assert.strictEqual(r.deleted, greySkus.length);
    assert.strictEqual(product.variants.length, beforeVariants - greySkus.length);
    const gone = before.filter(id => !product.mediaIds.includes(id));
    assert.strictEqual(gone.length, greyCfsMediaCount, 'Grey CFS photos detached');
    assert(gone.every(id => files.has(id)), 'detached, not deleted');
    assert(product.mediaIds.some(id => /lifestyle/.test(files.get(id).url)), 'flagged photo kept');
    const rec = JSON.parse(product.metafield.value);
    assert(rec.detached.length === greyCfsMediaCount && rec.detached.every(x => x.reason === 'step3-variant-removed'));

    // 4b. UNDO the live delete: photos come back in their old order; deleted variants are listed, not undone
    assert(r.undoId, 'live run returns an undo id');
    let u = await call('POST', `/api/shopify/undo/${r.undoId}`, { dryRun: true });
    assert(u.log.some(l => /Can't undo: 2 deleted variant/.test(l.message)));
    assert.strictEqual(u.log.filter(l => /Would re-attach photo/.test(l.message)).length, greyCfsMediaCount);
    assert.strictEqual(product.mediaIds.length, before.length - greyCfsMediaCount, 'preview changed nothing');
    u = await call('POST', `/api/shopify/undo/${r.undoId}`, { dryRun: false });
    assert.strictEqual(u.undone, 1, JSON.stringify(u.log));
    assert.deepStrictEqual(product.mediaIds, before, 'all photos back, in the old order');
    assert.strictEqual(JSON.parse(product.metafield.value).detached.length, 0, 'taken off the clean-up list');
    u = await call('POST', `/api/shopify/undo/${r.undoId}`, { dryRun: false });
    assert(u.undone === 0 && u.log.some(l => /Already undone/.test(l.message)), 'second undo does nothing');
    // undo file: download → upload again works (server restart case)
    const undoFile = (await call('GET', `/api/shopify/undo/${r.undoId}/download`, null, true)).toString();
    assert((await call('POST', '/api/shopify/undo/upload', { file: undoFile })).ok);
    const runs = (await call('GET', '/api/shopify/undo/runs')).runs;
    assert(runs.length >= 1 && runs[0].label === 'Delete Selected Orphaned');

    // 4c. UNDO a "Set to Draft" — including the "changed after the run" check
    product.status = 'ACTIVE';
    r = await call('POST', '/api/shopify/set-draft', { variants: [{ handle: 'milan', variantSku: product.variants[0].sku }], dryRun: false });
    assert.strictEqual(product.status, 'DRAFT');
    product.status = 'ARCHIVED';                                     // someone changed it after the run
    u = await call('POST', `/api/shopify/undo/${r.undoId}`, { dryRun: false });
    assert(u.skipped === 1 && product.status === 'ARCHIVED', 'conflict → skipped');
    u = await call('POST', `/api/shopify/undo/${r.undoId}`, { dryRun: false, force: true });
    assert(u.undone === 1 && product.status === 'ACTIVE', 'Overwrite → put back');

    // 5. clean-up sees them (not deletable before 7 days)
    ev = await call('POST', '/api/images/cleanup/scan', {});
    assert.strictEqual(last(ev).items.length, 0, 'photos were put back by Undo, so nothing to clean up');

    // 6. promote (CFS product match) → photos handed over to Image Sync
    r = await call('POST', '/api/shopify/publish-products', { variants: [{ handle: 'milan', variantSku: product.variants[0].sku, cfsProductStatus: 'active' }], dryRun: true });
    assert.deepStrictEqual(r.imageSyncHandles, ['milan']);
    assert(r.log.some(l => /will be updated in Image Sync/.test(l.message)));
    const mediaBefore = [...product.mediaIds];
    r = await call('POST', '/api/shopify/publish-products', { variants: [{ handle: 'milan', variantSku: product.variants[0].sku, cfsProductStatus: 'active' }], dryRun: false });
    assert.deepStrictEqual(r.imageSyncHandles, ['milan']); assert.deepStrictEqual(product.mediaIds, mediaBefore, 'promotion no longer deletes photos');
    // 7. Promote when ALL variants go and they point at 2 CFS products (White 144250 + Beige 1262189)
    const allRows = () => product.variants.map(v => ({ handle: 'milan', variantSku: v.sku, cfsProductStatus: 'active' }));
    product.title = 'Milan Dining Table';                                  // no colour in the title → unclear
    let before7 = JSON.stringify(product.variants);
    r = await call('POST', '/api/shopify/publish-products', { variants: allRows(), dryRun: false });
    assert.strictEqual(r.flagged, 1, JSON.stringify(r.log.slice(-2)));
    assert(r.log.every(l => l.status === 'flagged' && /NOT promoted — No CFS product matches the colour/.test(l.message)));
    assert.strictEqual(JSON.stringify(product.variants), before7, 'flagged product untouched on the LIVE run too');
    assert.deepStrictEqual(r.imageSyncHandles, []);
    product.title = 'Milan Dining Table - Light White Marble';           // shade word CFS doesn't have → flag
    r = await call('POST', '/api/shopify/publish-products', { variants: allRows(), dryRun: true });
    assert(r.flagged === 1 && /Title says "light"/.test(r.log[0].message), r.log[0].message);
    product.title = 'Milan Dining Table - Travertine Beige Marble';      // clear colour → keep the Beige CFS product
    r = await call('POST', '/api/shopify/publish-products', { variants: allRows(), dryRun: true });
    const keeper = r.log.find(l => /Would update SKU/.test(l.message));
    assert(keeper && keeper.sku.startsWith('UD-1262189') && /colour match: travertine beige/.test(keeper.message), JSON.stringify(r.log));
    r = await call('POST', '/api/shopify/publish-products', { variants: allRows(), dryRun: false });
    assert.strictEqual(product.variants.length, 1);
    assert.strictEqual(product.variants[0].sku, 'UD-1262189', 'kept the Beige CFS product, not the first variant');
    assert.deepStrictEqual(r.imageSyncHandles, ['milan']);
    const keptId = product.variants[0].id;
    u = await call('POST', `/api/shopify/undo/${r.undoId}`, { dryRun: false });
    assert.strictEqual(product.variants.find(v => v.id === keptId).sku.startsWith('UD-1262189-'), true, 'SKU put back');
    assert(u.log.some(l => /Can't undo: \d+ deleted variant/.test(l.message)));
    // 8. OWN-VARIANT rule: the product's own variant is not in CFS → whole product to DRAFT
    const resetVariants = () => { let n = 500; product.variants = [];
      for (const [colour, cfs] of [['White', 144250], ['Grey', 601535], ['Beige', 1262189]]) for (const size of ['160', '180'])
        product.variants.push({ id: `gid://shopify/ProductVariant/${n}`, sku: `UD-${cfs}-${n++}`, title: `${colour} / ${size}`, position: n,
          selectedOptions: [{ name: 'Color', value: colour }, { name: 'Size', value: size }], mediaIds: [] }); };
    const greyRows = () => product.variants.filter(v => v.title.startsWith('Grey')).map(v => ({ handle: 'milan', variantSku: v.sku, title: 'Milan' }));
    resetVariants(); product.status = 'ACTIVE'; product.title = 'Milan Dining Table - Grey Marble';
    r = await call('POST', '/api/shopify/delete-variants-bulk', { variants: greyRows(), dryRun: true, cfsProductIds: [], cfsVariantAttrIds: [] });
    assert(r.log.some(l => /Would set "Milan Dining Table - Grey Marble" to DRAFT — this product is "Grey"/.test(l.message)), JSON.stringify(r.log));
    assert(!r.log.some(l => /Would delete/.test(l.message) && /Grey/.test(l.message)), 'own variants are not deleted');
    r = await call('POST', '/api/shopify/delete-variants-bulk', { variants: greyRows(), dryRun: false, cfsProductIds: [], cfsVariantAttrIds: [] });
    assert.strictEqual(product.status, 'DRAFT', JSON.stringify(r.log));
    assert.strictEqual(product.variants.length, 6, 'variants kept');
    u = await call('POST', `/api/shopify/undo/${r.undoId}`, { dryRun: false });
    assert(u.undone === 1 && product.status === 'ACTIVE', 'own-variant draft can be undone');
    // sibling product (title says White) → only the Grey variants are deleted
    product.title = 'Milan Dining Table - White Marble';
    r = await call('POST', '/api/shopify/delete-variants-bulk', { variants: greyRows(), dryRun: false, cfsProductIds: [], cfsVariantAttrIds: [] });
    assert.strictEqual(product.status, 'ACTIVE'); assert.strictEqual(product.variants.length, 4, JSON.stringify(r.log));
    assert(!product.variants.some(v => v.title.startsWith('Grey')));
    console.log('OWN-VARIANT RULE OK');
    console.log('STEP 3 E2E PASSED');
  } catch (e) { console.error('STEP 3 E2E FAILED', e); process.exitCode = 1; }
  server.close();
  fs.rmSync(path.join(__dirname, '../uploads'), { recursive: true, force: true });
})();
