/**
 * "Default" colour check   (mounted at /api/default-colours)
 *
 *   POST /scan   { vendor?, includeDrafts? }  (SSE)  → products with a "Default" / "Default Title" option
 *                value (not Shopify's plain simple products) + a suggested real name for each
 *   POST /apply  { items:[{productId, optionId, valueId, current, newName}], dryRun, brandId? }
 *                → renames the option value on Shopify; every rename is saved for Undo
 *
 * Suggestions come from utils/defaultColour.js (same SKU on another product, CFS product names,
 * the product title for its own CFS product). Nothing is renamed without the user ticking it.
 * Photo alt texts ("Default") are fixed by the next Image Sync run.
 */
const express = require('express');
const { _shared: S } = require('./brandsync');
const { findDefaults } = require('../utils/defaultColour');
const undo = require('../utils/undoLog');

const router = express.Router();

const Q_PRODUCTS = `
  query P($first: Int!, $after: String, $q: String) {
    products(first: $first, after: $after, query: $q) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id handle title vendor status
        iid: metafield(namespace: "custom", key: "iproductid") { value }
        options { id name optionValues { id name } }
        variants(first: 100) { nodes { id sku selectedOptions { name value } } }
      }
    }
  }`;
const Q_PRODUCT = `query P($id: ID!) { product(id: $id) { id title handle options { id name optionValues { id name } } } }`;
const M_RENAME = `mutation R($productId: ID!, $option: OptionUpdateInput!, $values: [OptionValueUpdateInput!]) {
  productOptionUpdate(productId: $productId, option: $option, optionValuesToUpdate: $values) {
    product { id } userErrors { field message code } } }`;

function sse(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.socket) res.socket.setNoDelay(true);
  res.flushHeaders();
  const ping = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n'); }, 15000);
  return {
    send: o => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(o)}\n\n`); },
    end: () => { clearInterval(ping); if (!res.writableEnded) res.end(); },
  };
}

router.post('/scan', async (req, res) => {
  let client;
  try { client = S.graphqlClient(); } catch (e) { return res.status(400).json({ error: e.message }); }
  const { send, end } = sse(res);
  S.startKeepAwake();
  try {
    const vendor = String(req.body?.vendor || '').trim();
    const includeDrafts = !!req.body?.includeDrafts;

    send({ type: 'status', message: 'Loading CFS product names (all brands)…' });
    const idx = await S.crossBrandIndex();
    if (idx.failed.length) send({ type: 'warn', message: `CFS names not loaded for: ${idx.failed.join(', ')}` });
    const cfsName = sku => {
      const m = /^UD-(\d+)/i.exec(String(sku || '').trim());
      return m ? (idx.byProd.get(m[1])?.name || null) : null;
    };

    send({ type: 'status', message: 'Reading the store (same SKU on other products) — first run takes a minute or two…' });
    const store = await S.storeProducts(client);
    const skuHomes = new Map();
    for (const p of store.values()) {
      for (const v of p.variants) {
        const sku = String(v.sku || '').trim(); if (!sku) continue;
        if (!skuHomes.has(sku)) skuHomes.set(sku, []);
        skuHomes.get(sku).push({ handle: p.handle, title: p.title, status: String(p.status || '').toUpperCase(), options: v.selectedOptions || [] });
      }
    }

    send({ type: 'status', message: 'Finding products with a "Default" option…' });
    const q = `variant_title:Default*${includeDrafts ? '' : ' AND status:active'}${vendor ? ` AND vendor:"${vendor}"` : ''}`;
    const rows = [];
    let after = null, seen = 0;
    do {
      const d = await S.gql(client, Q_PRODUCTS, { first: 8, after, q });   // 8 × 100 variants keeps the query cost under Shopify's limit
      for (const p of d.products.nodes) {
        if (vendor && String(p.vendor || '').trim().toLowerCase() !== vendor.toLowerCase()) continue;
        seen++;
        rows.push(...findDefaults({ ...p, iid: p.iid?.value || null, variants: p.variants.nodes }, { cfsName, skuHomes }));
      }
      send({ type: 'progress', seen, found: rows.length });
      after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
      if (after) await S.sleep(150);
    } while (after);

    const order = { A: 0, B: 1, C: 2 };
    rows.sort((a, b) => order[a.type] - order[b.type] || (a.status === 'ACTIVE' ? 0 : 1) - (b.status === 'ACTIVE' ? 0 : 1) || a.vendor.localeCompare(b.vendor) || a.title.localeCompare(b.title));
    const summary = rows.reduce((s, r) => { s[r.type]++; s[r.confidence] = (s[r.confidence] || 0) + 1; return s; }, { A: 0, B: 0, C: 0, total: rows.length, products: new Set(rows.map(r => r.productId)).size });
    console.log(`  ✓ Default colour scan${vendor ? ` (${vendor})` : ''}: ${JSON.stringify(summary)}`);
    send({ type: 'done', rows, summary, shop: process.env.SHOPIFY_STORE || '' });
  } catch (e) {
    console.error('[default-colours/scan]', e.message);
    send({ type: 'error', message: e.message });
  } finally { S.stopKeepAwake(); end(); }
});

// Streams progress (SSE): { type:'progress', done, total, row } per product, then { type:'done', … }.
// Each live rename is written to the undo file straight away, so a run that is cut off can still be undone.
router.post('/apply', async (req, res) => {
  const { items = [], dryRun = true, brandId = null } = req.body || {};
  if (!items.length) return res.status(400).json({ error: 'Nothing selected.' });
  let client;
  try { client = S.graphqlClient(); } catch (e) { return res.status(400).json({ error: e.message }); }
  const { send, end } = sse(res);
  S.startKeepAwake();
  console.log(`▶ Default colours — ${dryRun ? 'DRY RUN' : 'LIVE'} rename of ${items.length} value(s)`);
  const log = [];
  let changed = 0, failed = 0, skipped = 0, done = 0;
  const undoRun = dryRun ? null : undo.startRun('default-colour', 'Rename "Default" colour', brandId);
  let undoId = null;
  const push = row => {
    log.push(row); done++;
    if (row.status === 'error') console.log(`  ✗ ${row.handle}: ${row.message}`);
    send({ type: 'progress', done, total: items.length, row, counts: { changed, skipped, failed } });
    if (done % 25 === 0 || done === items.length) console.log(`  … default colours ${done}/${items.length} — renamed:${changed} skipped:${skipped} failed:${failed}`);
  };
  try {
    for (const it of items) {
      const newName = String(it.newName || '').trim();
      const base = { sku: '-', handle: it.handle || '-' };
      try {
        if (!newName) { skipped++; push({ ...base, status: 'skipped', message: `No new name given · ${it.title || it.handle}` }); continue; }
        const p = (await S.gql(client, Q_PRODUCT, { id: it.productId }))?.product;
        if (!p) { failed++; push({ ...base, status: 'error', message: `Product not found · ${it.title || it.handle}` }); continue; }
        const o = p.options.find(x => x.id === it.optionId);
        const val = o?.optionValues.find(x => x.id === it.valueId);
        if (!o || !val) { failed++; push({ ...base, status: 'error', message: `Option value no longer exists · ${p.title}` }); continue; }
        if (val.name === newName) { skipped++; push({ ...base, status: 'skipped', message: `${o.name} is already "${newName}" · ${p.title}` }); continue; }
        if (it.current && val.name !== it.current) { skipped++; push({ ...base, status: 'skipped', message: `${o.name} was changed since the scan (now "${val.name}") — run the scan again · ${p.title}` }); continue; }
        const clash = o.optionValues.find(x => x.id !== val.id && x.name.trim().toLowerCase() === newName.toLowerCase());
        if (clash) { failed++; push({ ...base, status: 'error', message: `"${newName}" already exists in ${o.name} on this product — not renamed (duplicate variant?) · ${p.title}` }); continue; }
        if (dryRun) { push({ ...base, status: 'dry_run', message: `Would rename ${o.name}: "${val.name}" → "${newName}" · ${p.title}` }); continue; }
        const before = val.name;
        const r = await S.gql(client, M_RENAME, { productId: p.id, option: { id: o.id }, values: [{ id: val.id, name: newName }] });
        const errs = r?.productOptionUpdate?.userErrors || [];
        if (errs.length) { failed++; push({ ...base, status: 'error', message: `Rename failed: ${errs.map(e => e.message).join(', ')} · ${p.title}` }); continue; }
        undo.add(undoRun, { type: 'option-value', productId: p.id, handle: p.handle, title: p.title, optionId: o.id, optionName: o.name, valueId: val.id, before, after: newName });
        undoId = undo.save(undoRun);   // saved after every rename
        changed++;
        push({ ...base, status: 'updated', message: `Renamed ${o.name}: "${before}" → "${newName}" · ${p.title}` });
        await S.sleep(250);
      } catch (e) { failed++; push({ ...base, status: 'error', message: `${e.message} · ${it.title || it.handle}` }); }
    }
    if (changed) S.clearStoreCache();
    console.log(`  ✓ Default colours ${dryRun ? 'dry run' : 'live'} done — renamed:${changed} skipped:${skipped} failed:${failed}${undoId ? ` · undo ${undoId}` : ''}`);
    send({ type: 'done', success: true, dryRun, changed, skipped, failed, log, undoId });
  } catch (e) {
    console.error('[default-colours/apply]', e.message);
    send({ type: 'error', message: e.message, log, undoId });
  } finally { S.stopKeepAwake(); end(); }
});

module.exports = router;
module.exports._q = { M_RENAME, Q_PRODUCT };
