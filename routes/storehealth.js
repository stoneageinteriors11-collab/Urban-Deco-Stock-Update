/**
 * Store health   (mounted at /api/store-health)
 *
 *   POST /run  { includeDrafts? }  (SSE)  → read-only checks over the whole store (utils/storeHealth.js)
 *
 * Reads: every variant (shared 30-minute store list from routes/brandsync.js), every product's
 * options + custom.iproductid + custom.product_code, and all CFS feeds (Urban Deco + 14 brands).
 * Active products only unless includeDrafts. Nothing is changed.
 */
const express = require('express');
const { _shared: S } = require('./brandsync');
const { runChecks } = require('../utils/storeHealth');
const { findDefaults } = require('../utils/defaultColour');
const { BRANDS } = require('../utils/brands');

const router = express.Router();

const Q_PRODUCT_INFO = `
  query P($after: String) {
    products(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id handle status
        iid: metafield(namespace: "custom", key: "iproductid") { value }
        pcode: metafield(namespace: "custom", key: "product_code") { value }
        options { id name optionValues { id name } }
      }
    }
  }`;

let infoCache = null;   // product id → { iid, pcode, options } (30 minutes, like the store list)
async function productInfo(client, send) {
  if (infoCache && Date.now() - infoCache.at < 30 * 60 * 1000) return infoCache.map;
  const map = new Map();
  let after = null;
  do {
    const d = await S.gql(client, Q_PRODUCT_INFO, { after });
    for (const p of d.products.nodes) map.set(p.id, { iid: p.iid?.value || null, pcode: p.pcode?.value || '', options: p.options || [] });
    send({ type: 'status', message: `Reading product details… ${map.size}` });
    after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
    if (after) await S.sleep(150);
  } while (after);
  infoCache = { at: Date.now(), map };
  return map;
}

router.post('/run', async (req, res) => {
  let client;
  try { client = S.graphqlClient(); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.socket) res.socket.setNoDelay(true);
  res.flushHeaders();
  const send = o => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(o)}\n\n`); };
  const ping = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n'); }, 15000);
  S.startKeepAwake();
  const includeDrafts = !!req.body?.includeDrafts;
  console.log(`▶ Store health${includeDrafts ? ' (incl. drafts)' : ''}`);
  try {
    if (req.body?.refresh) { S.clearStoreCache(); infoCache = null; }
    send({ type: 'status', message: 'Loading all CFS feeds (Urban Deco + 14 brands)…' });
    const idx = await S.crossBrandIndex();
    if (idx.failed.length) send({ type: 'warn', message: `Couldn't load: ${idx.failed.join(', ')} — "not in CFS" / "wrong vendor" may be overstated for those brands` });
    send({ type: 'status', message: 'Reading every variant in the store (first run takes 1–2 minutes)…' });
    const store = await S.storeProducts(client);
    const info = await productInfo(client, send);

    const products = [];
    for (const p of store.values()) {
      const status = String(p.status || '').toUpperCase();
      if (!includeDrafts && status !== 'ACTIVE') continue;
      const i = info.get(p.id) || {};
      products.push({ id: p.id, handle: p.handle, title: p.title, vendor: p.vendor, status, iid: i.iid || null, pcode: i.pcode || '',
        options: i.options || [], variants: p.variants.map(v => ({ id: v.id, sku: v.sku, title: (v.selectedOptions || []).map(o => o.value).join(' / '), selectedOptions: v.selectedOptions || [] })) });
    }
    send({ type: 'status', message: `Checking ${products.length} products…` });
    const checks = runChecks(products, { byProd: idx.byProd, byVar: idx.byVar, knownVendors: ['Urban Deco', ...BRANDS.map(b => b.vendor)], findDefaults });
    const summary = Object.fromEntries(checks.map(c => [c.id, c.count]));
    console.log(`  ✓ Store health: ${products.length} products · ${JSON.stringify(summary)}`);
    send({ type: 'done', products: products.length, includeDrafts, shop: process.env.SHOPIFY_STORE || '', checkedAt: new Date().toISOString(), checks,
      cfsFailed: idx.failed, brands: BRANDS.map(b => ({ id: b.id, vendor: b.vendor })) });
  } catch (e) {
    console.error('[store-health]', e.message);
    send({ type: 'error', message: e.message });
  } finally {
    clearInterval(ping); S.stopKeepAwake();
    if (!res.writableEnded) res.end();
  }
});

module.exports = router;
