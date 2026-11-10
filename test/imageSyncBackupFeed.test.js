// Image Sync backup gallery file: used only when both CFS feed pages fail
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('node:http');
const axios = require('axios');
process.env.SHOPIFY_STORE = 'mock.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = 'x';

let livePages = 'down';
const LIVE = JSON.stringify({ generated: 'live', totalProducts: 1, products: [{ iProductId: 88, vSKU: 'X', mainImage: 'https://img/live.jpg', galleryCount: 0, galleryImages: [] }] });
axios.get = async (url) => {
  if (/cronItemGalleryUrls/.test(url)) { if (livePages === 'up' && /_Json/.test(url)) return { data: LIVE, headers: {} }; const e = new Error('Request failed with status code 404'); e.response = { status: 404 }; throw e; }
  const e = new Error('404'); e.response = { status: 404 }; throw e;
};
const product = { id: 'gid://shopify/Product/1', handle: 'martin', title: 'Martin Bookcase', status: 'ACTIVE', vendor: 'Urban Deco', updatedAt: 't', featuredMedia: null,
  options: [], media: { nodes: [] }, variants: { nodes: [{ id: 'gid://shopify/ProductVariant/1', sku: 'UD-88', title: 'Default', position: 1, selectedOptions: [], media: { nodes: [] } }] }, metafield: null };
axios.post = async () => ({ data: { data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [product] } } } });

const express = require('express');
const app = express(); app.use(express.json()); app.use('/api/images', require('../routes/imagesync'));
const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}/api/images`;
const call = (method, p, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request(base() + p, { method, headers: data ? { 'Content-Type': 'application/json' } : {} }, res => {
    const c = []; res.on('data', d => c.push(d)); res.on('end', () => { const t = Buffer.concat(c).toString();
      resolve((res.headers['content-type'] || '').includes('event-stream') ? t.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))) : JSON.parse(t)); });
  }); r.on('error', reject); if (data) r.write(data); r.end();
});
const upload = async (name, buf) => { const fd = new FormData(); fd.append('file', new Blob([buf]), name); return (await fetch(base() + '/feed/upload', { method: 'POST', body: fd })).json(); };
const sample = fs.readFileSync(path.join(__dirname, 'gallery-sample.txt'));

(async () => {
  try {
    await call('POST', '/feed/clear');
    // 1. both pages down, nothing uploaded → stops with a clear message
    let ev = await call('POST', '/dry-run', { limit: 5, refreshFeed: true });
    assert.strictEqual(ev[ev.length - 1].type, 'error');
    assert(/upload a backup gallery CSV/.test(ev[ev.length - 1].message), ev[ev.length - 1].message);

    // 2. bad files are refused
    let j = await upload('wrong.csv', Buffer.from('sku,qty\nUD-1,5\n'));
    assert(/unexpected columns/.test(j.error), JSON.stringify(j));
    j = await upload('photo.png', Buffer.from('x'));
    assert(/\.csv, \.xlsx or \.json/.test(j.error), JSON.stringify(j));

    // 3. the real CFS gallery CSV (sample) is accepted, dated from its file name
    j = await upload('cronItemGalleryUrls_20261022.csv', sample);
    assert(j.ok, JSON.stringify(j));
    assert.strictEqual(j.uploadedFeed.total, 39); assert.strictEqual(j.uploadedFeed.generated, '2026-10-22');
    ev = await call('POST', '/dry-run', { limit: 5, refreshFeed: true });
    const done = ev[ev.length - 1];
    assert.strictEqual(done.type, 'done', JSON.stringify(done));
    assert(ev.some(e => e.type === 'status' && /uploaded backup file "cronItemGalleryUrls_20261022.csv" \(dated 2026-10-22\)/.test(e.message)));
    assert(!done.plans[0].notInCfs, 'UD-88 found in the uploaded file');

    // 4. same file as Excel works too
    const XLSX = require('xlsx');
    const wb = XLSX.read(sample, { type: 'buffer' });
    j = await upload('gallery.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    assert(j.ok && j.uploadedFeed.total === 39, JSON.stringify(j));

    // 5. live feed back → live feed wins over the uploaded file
    livePages = 'up';
    ev = await call('POST', '/dry-run', { limit: 5, refreshFeed: true });
    assert(ev.some(e => e.type === 'status' && /CFS photos from: JSON feed/.test(e.message)), JSON.stringify(ev.filter(e => e.type === 'status')));

    // 6. remove
    j = await call('POST', '/feed/clear'); assert.strictEqual(j.uploadedFeed, null);
    assert.strictEqual((await call('GET', '/feed/info')).uploadedFeed, null);
    console.log('IMAGE SYNC BACKUP FEED TESTS PASSED');
  } catch (e) { console.error('IMAGE SYNC BACKUP FEED TESTS FAILED', e); process.exitCode = 1; }
  server.close(); setTimeout(() => process.exit(), 100);
})();
