/**
 * Store health   (mounted at /api/store-health)
 *
 *   POST /run      { includeDrafts? }      (SSE) → read-only checks over the whole store (utils/storeHealth.js)
 *   POST /fix-url  { items, dryRun }        (SSE) → the only fix on this page: URL made from the title, with redirect + Undo
 *
 * Reads: every variant (shared 30-minute store list from routes/brandsync.js), every product's
 * options + custom.iproductid + custom.product_code, and all CFS feeds (Urban Deco + 14 brands).
 * Active products only unless includeDrafts. Nothing is changed.
 */
const express = require('express');
const { _shared: S } = require('./brandsync');
const { runChecks } = require('../Claude outputs/store-health-fixurl/new/utils/storeHealth');
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

// ── Fix URLs ("URL doesn't match title") ──────────────────────────────────────
// POST /fix-url { items:[{ productId, handle }], dryRun }  (SSE)
// New URL = made from the CURRENT title (slugify); the old URL redirects to it (redirectNewHandle).
// Skipped: title already matches, URL changed since the check, or the new URL is used by another product.
// Saved for Undo as type 'title' (puts the old URL back, with a redirect).
const undo = require('../utils/undoLog');
const { slugify } = require('../Claude outputs/store-health-fixurl/new/utils/storeHealth');
const Q_P = `query P($id: ID!) { product(id: $id) { id title handle } }`;
const Q_BY_HANDLE = `query H($h: String!) { productByHandle(handle: $h) { id title status } }`;
const M_HANDLE = `mutation U($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id handle } userErrors { field message } } }`;

router.post('/fix-url', async (req, res) => {
  const { items = [], dryRun = true } = req.body || {};
  if (!items.length) return res.status(400).json({ error: 'Nothing selected.' });
  let client;
  try { client = S.graphqlClient(); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.socket) res.socket.setNoDelay(true);
  res.flushHeaders();
  const send = o => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(o)}\n\n`); };
  S.startKeepAwake();
  console.log(`▶ Store health — ${dryRun ? 'DRY RUN' : 'LIVE'} fix URL for ${items.length} product(s)`);
  const log = [];
  let changed = 0, skipped = 0, failed = 0, done = 0, undoId = null;
  const undoRun = dryRun ? null : undo.startRun('fix-url', 'Fix URL from title');
  const push = row => {
    log.push(row); done++;
    if (row.status === 'error') console.log(`  ✗ ${row.handle}: ${row.message}`);
    send({ type: 'progress', done, total: items.length, row, counts: { changed, skipped, failed } });
  };
  try {
    for (const it of items) {
      const base = { sku: '-', handle: it.handle || '-' };
      try {
        const p = (await S.gql(client, Q_P, { id: it.productId }))?.product;
        if (!p) { failed++; push({ ...base, status: 'error', message: 'Product not found' }); continue; }
        const to = slugify(p.title);
        if (!to) { failed++; push({ ...base, status: 'error', message: `Can't make a URL from the title "${p.title}"` }); continue; }
        if (p.handle === to) { skipped++; push({ ...base, status: 'skipped', message: `URL already matches the title (/${to}) · ${p.title}` }); continue; }
        if (it.handle && p.handle !== it.handle) { skipped++; push({ ...base, status: 'skipped', message: `URL was changed since the check (now /${p.handle}) — run the check again · ${p.title}` }); continue; }
        const taken = (await S.gql(client, Q_BY_HANDLE, { h: to }))?.productByHandle;
        if (taken && taken.id !== p.id) { failed++; push({ ...base, status: 'error', message: `/${to} is already used by "${taken.title}" (${String(taken.status).toLowerCase()}) — not changed · ${p.title}` }); continue; }
        if (dryRun) { push({ ...base, status: 'dry_run', message: `Would change URL /${p.handle} → /${to} (old URL redirects) · ${p.title}` }); continue; }
        const r = await S.gql(client, M_HANDLE, { product: { id: p.id, handle: to, redirectNewHandle: true } });
        const errs = r?.productUpdate?.userErrors || [];
        if (errs.length) { failed++; push({ ...base, status: 'error', message: `URL change failed: ${errs.map(e => e.message).join(', ')} · ${p.title}` }); continue; }
        const now = r?.productUpdate?.product?.handle || to;
        undo.add(undoRun, { type: 'title', productId: p.id, handle: now, title: p.title, before: { title: p.title, handle: p.handle }, after: { title: p.title, handle: now } });
        undoId = undo.save(undoRun);
        changed++;
        push({ ...base, status: 'updated', message: `URL changed /${p.handle} → /${now} (old URL redirects) · ${p.title}` });
        await S.sleep(250);
      } catch (e) { failed++; push({ ...base, status: 'error', message: e.message }); }
    }
    if (changed) { S.clearStoreCache(); infoCache = null; }
    console.log(`  ✓ Fix URL ${dryRun ? 'dry run' : 'live'} — changed:${changed} skipped:${skipped} failed:${failed}${undoId ? ` · undo ${undoId}` : ''}`);
    send({ type: 'done', dryRun, changed, skipped, failed, log, undoId });
  } catch (e) {
    send({ type: 'error', message: e.message, log, undoId });
  } finally { S.stopKeepAwake(); if (!res.writableEnded) res.end(); }
});

module.exports = router;
