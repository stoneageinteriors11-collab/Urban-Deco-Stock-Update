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
    case 'productByHandle': return { productByHandle: vars.h === 'milan' ? productNode() : null };
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
  if (url.includes('cronItemGalleryUrls')) return { data: feed, headers: {} };
  if (pics[url]) return { data: pics[url], headers: { 'content-type': 'image/jpeg' } };
  const e = new Error('404'); e.response = { status: 404 }; throw e;
};
global.fetch = async (url, opts) => { const blob = opts.body.get('file'); stagedBlobs[url.replace('/post', '')] = Buffer.from(await blob.arrayBuffer()); return { ok: true, status: 204 }; };

// ── Boot the app ─────────────────────────────────────────────────────────────
const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/images', require('../routes/imagesync'));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/images`;
const realFetch = require('node:http');

function req(method, p, body, raw) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = realFetch.request(base + p, { method, headers: data ? { 'Content-Type': 'application/json' } : {} }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (raw) return resolve(buf);
        const txt = buf.toString();
        if ((res.headers['content-type'] || '').includes('event-stream')) {
          const events = txt.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
          return resolve(events);
        }
        try { resolve(JSON.parse(txt)); } catch (_) { resolve(txt); }
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const last = ev => ev[ev.length - 1];
const media = () => product.mediaIds.map(id => `${files.get(id).alt}:${files.get(id).url.split('/').pop().replace(/(_[a-z0-9-]+)?\.jpg$/, '')}`);

(async () => {
  try {
    const st = await req('GET', '/status'); assert(st.connected && st.missing.length === 0);

    // 1. Dry run
    const before = [...product.mediaIds];
    let ev = await req('POST', '/dry-run', { tokens: ['milan'] });
    let d = last(ev); assert.strictEqual(d.type, 'done', JSON.stringify(d));
    const p = d.plans[0];
    console.log('DRY RUN counts', JSON.stringify(p.counts), 'errors', p.errors);
    assert(p.ok && p.counts.upload === 3 && p.counts.reuse === 15 && p.counts.detach === 1 && p.counts.manual === 1);
    assert.deepStrictEqual(product.mediaIds, before, 'dry run must not change anything');
    assert(!calls.some(c => /fileCreate|fileUpdate|productReorderMedia|metafieldsSet|Append|Detach/.test(c)), 'no writes in dry run');
    const planId = d.planId;
    const csv = await req('GET', `/plan/${planId}/csv`, null, true); assert(csv.toString().includes('CFSUD rule'));

    // 2. Apply without backup is refused
    ev = await req('POST', '/apply', { planId, backupId: 'backup-20260101000000-abcdef', productIds: [PID] });
    assert.strictEqual(last(ev).type, 'error');

    // 3. Backup → download → confirm
    ev = await req('POST', '/backup', { planId, productIds: [PID] });
    d = last(ev); assert.strictEqual(d.type, 'done', JSON.stringify(d)); assert.strictEqual(d.photos, 17);
    const zip = await req('GET', `/backup/${d.backupId}/download`, null, true);
    assert((await req('POST', `/backup/${d.backupId}/confirm`, { sha256: 'bad' })).error);
    assert((await req('POST', `/backup/${d.backupId}/confirm`, { sha256: crypto.createHash('sha256').update(zip).digest('hex') })).ok);
    const backupId = d.backupId;

    // 4a. Apply fails half-way (after upload) …
    global.failAttachOnce = true;
    ev = await req('POST', '/apply', { planId, backupId, productIds: [PID] });
    assert.strictEqual(ev.find(e => e.type === 'product').state, 'failed');
    const jobId = ev.find(e => e.type === 'job').jobId;
    const creates1 = calls.filter(c => c === 'fileCreate').length;
    // 4b. … then resume the same job: must NOT upload again
    ev = await req('POST', '/apply', { planId, backupId, productIds: [PID], jobId });
    assert.strictEqual(calls.filter(c => c === 'fileCreate').length, creates1, 'retry must not re-upload');
    d = last(ev); console.log('APPLY', JSON.stringify(d), ev.filter(e => e.type === 'log').map(e => e.message));
    assert(d.type === 'done' && d.states.done === 1);
    const after = media();
    console.log(after.join('\n'));
    assert.strictEqual(product.mediaIds.length, 19);
    assert.deepStrictEqual(after.slice(0, 6).map(x => x.split(':')[1]), ['Milan-White', 'Milan-White-01', 'Milan-White-02', 'Milan-White-03', 'Milan-White-04', 'Milan-White-05']);
    assert(after[12] === 'Grey:lifestyle', 'manual photo kept at end of Grey');
    assert(!product.mediaIds.includes(liveExcludedId) && files.has(liveExcludedId), 'excluded -06 detached but not deleted');
    for (const v of product.variants) assert.strictEqual(files.get(v.mediaIds[0]).url.includes(v.title.split(' / ')[0]), true);
    const rec = JSON.parse(product.metafield.value);
    assert(rec.images.length === 18 && rec.detached.length === 1 && rec.lastApply.backupId === backupId && !rec.pending);

    // 5. Second dry run = no change; re-apply impossible without new backup
    ev = await req('POST', '/dry-run', { tokens: ['UD-144250'] });
    d = last(ev); assert(d.plans[0].noChange, JSON.stringify(d.plans[0].counts));

    // 6. Clean-up refuses (less than 7 days)
    ev = await req('POST', '/cleanup/scan', {}); d = last(ev);
    assert(d.items.length === 1 && d.items[0].deletable === false);
    let cl = await req('POST', '/cleanup/delete', { items: [{ productId: PID, mediaId: liveExcludedId }] });
    assert(cl.deleted.length === 0 && cl.refused.length === 1);

    // 7. Conflict: someone edits after the sync → restore refuses without force
    const restoreUp = await new Promise((resolve, reject) => {
      const boundary = 'XYZ';
      const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="zip"; filename="b.zip"\r\nContent-Type: application/zip\r\n\r\n`), zip, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const r = realFetch.request(base + '/restore/upload', { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } },
        res => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString()))); });
      r.on('error', reject); r.write(body); r.end();
    });
    assert(restoreUp.restoreId && restoreUp.photos === 17, JSON.stringify(restoreUp));
    const edited = [...product.mediaIds]; product.mediaIds.reverse();
    ev = await req('POST', '/restore', { restoreId: restoreUp.restoreId, productIds: [PID] });
    assert.strictEqual(ev.find(e => e.type === 'product').state, 'conflict');
    product.mediaIds = edited;

    // 8. Restore — simulate the week passing: the detached file was deleted, so it must be re-uploaded from the zip
    files.delete(liveExcludedId);
    ev = await req('POST', '/restore', { restoreId: restoreUp.restoreId, productIds: [PID] });
    const pr = ev.find(e => e.type === 'product'); console.log('RESTORE', JSON.stringify(pr));
    assert.strictEqual(pr.state, 'done');
    assert.strictEqual(product.mediaIds.length, 17);
    const restored = media();
    assert(restored[5].startsWith('White:Milan-White-06'), restored[5]);          // re-uploaded from zip, back in place
    assert.deepStrictEqual(restored.filter((_, i) => i !== 5), before.filter(id => id !== liveExcludedId).map(id => `${files.get(id).alt}:${files.get(id).url.split('/').pop().replace(/(_[a-z0-9-]+)?\.jpg$/, '')}`));
    for (const v of product.variants) assert(v.mediaIds[0] === before[0] || files.get(v.mediaIds[0]).url.includes(v.title.split(' / ')[0]));
    const rec2 = JSON.parse(product.metafield.value);
    assert(rec2.detached.length === 3, 'the 3 uploads are now detached (kept), ready for clean-up later');

    console.log('\nE2E PASSED. Shopify calls:', calls.length);
  } catch (e) { console.error('E2E FAILED', e); process.exitCode = 1; }
  server.close();
  fs.rmSync(path.join(__dirname, '../uploads'), { recursive: true, force: true });
})();
