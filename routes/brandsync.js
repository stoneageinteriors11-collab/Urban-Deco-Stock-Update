/**
 * Other Brands — Step 1: stock update   (mounted at /api/brands)
 *
 *   GET  /list             brands + their rule text
 *   GET  /:id/count        how many Shopify products have this vendor
 *   POST /stock-sync       { brandId, dryRun }  → live progress (SSE), then a log
 *   POST /cancel           { runId }            → Stop
 *
 * For every ACTIVE Shopify product of the brand, each variant's SKU is looked up in
 * that brand's CFS feed and these are written (only when different):
 *   delivery time → custom.vnotificationtitle (variant)
 *   stock status  → custom.inoutstock         (variant + product)
 *   due date      → custom.duedate            (variant + product)
 *   on hand       → Shopify available quantity
 * Product-level stock status = IN STOCK if any variant is in stock.
 * SKUs not in the feed are skipped (they belong to the clean-up step).
 */
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();
const { BRANDS, RULE_TEXT, getBrand, fetchBrandFeed, buildBrandStock } = require('../utils/brands');

const router = express.Router();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cancelled = new Set();

function graphqlClient() {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_API_TOKEN;
  const version = process.env.SHOPIFY_API_VERSION || '2026-07';
  if (!store || !token) throw new Error('Not connected to Shopify. Please connect first.');
  return { url: `https://${store}/admin/api/${version}/graphql.json`, headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } };
}
async function gql(client, query, variables = {}, attempt = 1) {
  try {
    const res = await axios.post(client.url, { query, variables }, { headers: client.headers, timeout: 30000 });
    if (res.data.errors) throw new Error(`GraphQL error: ${res.data.errors.map(e => e.message).join('; ')}`);
    return res.data.data;
  } catch (err) {
    const status = err.response?.status;
    if ((status === 429 || (status >= 500 && status < 600)) && attempt <= 3) { await sleep(attempt * 2000); return gql(client, query, variables, attempt + 1); }
    throw err;
  }
}

const LOCATIONS = `query { locations(first: 10) { edges { node { id name } } } }`;
const COUNT = `query c($q: String!) { productsCount(query: $q) { count } }`;
const PRODUCTS = `
  query p($first: Int!, $after: String, $q: String, $loc: ID!) {
    products(first: $first, after: $after, query: $q) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id handle title vendor status
        metafields(first: 50, namespace: "custom") { nodes { key value } }
        variants(first: 250) { nodes {
          id sku title
          metafields(first: 50, namespace: "custom") { nodes { key value } }
          inventoryItem { id tracked inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { name quantity } } }
        } }
      }
    }
  }`;
const METAFIELDS_SET = `mutation m($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { field message } } }`;
const INVENTORY_SET = `mutation s($input: InventorySetQuantitiesInput!, $key: String!) {
  inventorySetQuantities(input: $input) @idempotent(key: $key) { userErrors { field message } } }`;

const mfMap = nodes => Object.fromEntries((nodes || []).map(n => [n.key, n.value ?? '']));
const sameVendor = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

router.get('/list', (req, res) => {
  res.json({ brands: BRANDS.map(b => ({ ...b, ruleText: RULE_TEXT[b.rule] })) });
});

router.get('/:id/count', async (req, res) => {
  const brand = getBrand(req.params.id);
  if (!brand) return res.status(404).json({ error: 'Unknown brand' });
  try {
    const d = await gql(graphqlClient(), COUNT, { q: `vendor:"${brand.vendor}"` });
    res.json({ id: brand.id, vendor: brand.vendor, count: d?.productsCount?.count ?? 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/cancel', (req, res) => { if (req.body?.runId) cancelled.add(req.body.runId); res.json({ ok: true }); });

router.post('/stock-sync', async (req, res) => {
  const brand = getBrand(req.body?.brandId);
  const dryRun = req.body?.dryRun !== false && req.body?.dryRun !== 'false';
  if (!brand) return res.status(400).json({ error: 'Pick a brand' });
  let client;
  try { client = graphqlClient(); } catch (e) { return res.status(400).json({ error: e.message }); }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  const runId = crypto.randomBytes(6).toString('hex');
  send({ type: 'run_id', runId });

  const log = [];
  const c = { products: 0, variants: 0, updated: 0, unchanged: 0, notInCfs: 0, flagged: 0, skippedDraft: 0, failed: 0 };
  const finish = (extra = {}) => {
    clearInterval(ping); cancelled.delete(runId);
    send({ type: 'done', dryRun, brand: brand.vendor, counts: c, log, ...extra });
    res.end();
  };

  try {
    // 1. CFS feed for this brand
    send({ type: 'status', message: `Loading CFS feed for ${brand.vendor} (brand ${brand.id})…` });
    let feed = await fetchBrandFeed(brand.id);
    const feedName = feed[0]?.brandName;
    const vendor = brand.vendor;
    if (feedName && !sameVendor(feedName, vendor)) {
      log.push({ handle: '-', sku: '-', status: 'warning', message: `CFS calls this brand "${feedName}" — Shopify vendor used: "${vendor}"` });
    }
    const stock = buildBrandStock(feed, brand);
    send({ type: 'status', message: `CFS: ${feed.length} products, ${stock.size} SKUs` });
    feed = null;

    // 2. Shopify location
    const locs = (await gql(client, LOCATIONS))?.locations?.edges?.map(e => e.node) || [];
    const loc = locs.find(l => /^shop$/i.test(l.name)) || locs.find(l => /shop|warehouse|main/i.test(l.name)) || locs[0];
    if (!loc) throw new Error('No Shopify location found — can\'t update quantities');
    send({ type: 'status', message: `Location: "${loc.name}"` });

    // 3. Shopify products of this vendor
    const products = [];
    let after = null;
    do {
      if (cancelled.has(runId)) return finish({ cancelled: true });
      const d = await gql(client, PRODUCTS, { first: 20, after, q: `vendor:"${vendor}"`, loc: loc.id });
      products.push(...d.products.nodes.filter(p => sameVendor(p.vendor, vendor)));
      send({ type: 'fetch', fetched: products.length });
      after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
      if (after) await sleep(150);
    } while (after);
    send({ type: 'status', message: `Shopify: ${products.length} ${vendor} products` });
    if (!products.length) log.push({ handle: '-', sku: '-', status: 'warning', message: `No Shopify products found with vendor "${vendor}"` });

    // 4. Compare and write
    let done = 0;
    for (const p of products) {
      if (cancelled.has(runId)) return finish({ cancelled: true });
      done++;
      if (p.status !== 'ACTIVE') {
        c.skippedDraft++;
        if (done % 10 === 0) send({ type: 'progress', done, total: products.length, counts: c });
        continue;
      }
      c.products++;
      try {
        const metafields = [], inventory = [], rows = [];
        const prodMf = mfMap(p.metafields?.nodes);
        const matched = [];
        for (const v of p.variants.nodes) {
          if (!v.sku) continue;
          c.variants++;
          const s = stock.get(v.sku.trim());
          if (!s) {
            c.notInCfs++;
            rows.push({ handle: p.handle, sku: v.sku, status: 'not_in_cfs', message: `SKU not in the ${vendor} CFS feed — skipped (clean-up step)` });
            continue;
          }
          matched.push(s);
          const mf = mfMap(v.metafields?.nodes);
          const changes = [];
          const setMf = (key, value, label) => {
            if (!value || (mf[key] ?? '') === value) return;
            metafields.push({ ownerId: v.id, namespace: 'custom', key, value, type: 'single_line_text_field' });
            changes.push(`${label}: "${mf[key] ?? ''}" → "${value}"`);
          };
          setMf('inoutstock', s.stockStatus, 'stock status');
          setMf('vnotificationtitle', s.deliveryTime, 'delivery');
          setMf('duedate', s.dueDate, 'due date');
          const cur = v.inventoryItem?.inventoryLevel?.quantities?.find(q => q.name === 'available')?.quantity ?? null;
          if (cur !== s.qty) {
            if (!v.inventoryItem?.inventoryLevel) rows.push({ handle: p.handle, sku: v.sku, status: 'warning', message: `Not stocked at "${loc.name}" — quantity not changed (would be ${s.qty})` });
            else { inventory.push({ inventoryItemId: v.inventoryItem.id, locationId: loc.id, quantity: s.qty, changeFromQuantity: cur ?? 0 }); changes.push(`quantity: ${cur ?? '?'} → ${s.qty}`); }
          }
          if (v.inventoryItem && v.inventoryItem.tracked === false) rows.push({ handle: p.handle, sku: v.sku, status: 'warning', message: 'Inventory is not tracked on Shopify for this variant — quantity has no effect' });
          const cfsText = `CFS: ${s.cfsStatus || '(blank)'}, on hand ${s.cfsOnHand ?? 0}, ${s.deliveryTime || 'no delivery time'}${s.dueDate && s.dueDate !== 'NA' ? `, due ${s.dueDate}` : ''}`;
          if (s.flags.length) {
            c.flagged++;
            rows.push({ handle: p.handle, sku: v.sku, status: 'flag', message: `Check: ${s.flags.join('; ')}${brand.note ? ` (${brand.note})` : ''} — ${cfsText}` });
          }
          if (changes.length) {
            c.updated++;
            rows.push({ handle: p.handle, sku: v.sku, status: dryRun ? 'dry_run' : 'updated', message: `${dryRun ? 'Would update' : 'Updated'} — ${changes.join(' · ')}  [${cfsText}]` });
          } else {
            c.unchanged++;
            rows.push({ handle: p.handle, sku: v.sku, status: 'unchanged', message: `Already correct [${cfsText}]` });
          }
        }
        // Product-level: IN STOCK if any variant is in stock; due date of the first matched variant
        if (matched.length) {
          const prodStatus = matched.some(s => s.stockStatus === 'IN STOCK') ? 'IN STOCK' : (matched.find(s => s.stockStatus)?.stockStatus || '');
          const prodDue = matched.find(s => s.dueDate)?.dueDate || '';
          if (prodStatus && prodMf.inoutstock !== prodStatus) metafields.push({ ownerId: p.id, namespace: 'custom', key: 'inoutstock', value: prodStatus, type: 'single_line_text_field' });
          if (prodDue && prodMf.duedate !== prodDue) metafields.push({ ownerId: p.id, namespace: 'custom', key: 'duedate', value: prodDue, type: 'single_line_text_field' });
        }

        if (!dryRun && (metafields.length || inventory.length)) {
          for (let i = 0; i < metafields.length; i += 25) {
            const r = await gql(client, METAFIELDS_SET, { metafields: metafields.slice(i, i + 25) });
            const errs = r?.metafieldsSet?.userErrors || [];
            if (errs.length) { c.failed++; rows.push({ handle: p.handle, sku: '-', status: 'error', message: `Metafields: ${errs.map(e => e.message).join(', ')}` }); }
          }
          if (inventory.length) {
            const r = await gql(client, INVENTORY_SET, { key: crypto.randomUUID(), input: { name: 'available', reason: 'correction', quantities: inventory } });
            const errs = r?.inventorySetQuantities?.userErrors || [];
            if (errs.length) { c.failed++; rows.push({ handle: p.handle, sku: '-', status: 'error', message: `Quantity: ${errs.map(e => e.message).join(', ')}` }); }
          }
          await sleep(120);
        }
        log.push(...rows);
      } catch (e) {
        c.failed++;
        log.push({ handle: p.handle, sku: '-', status: 'error', message: e.message });
      }
      if (done % 10 === 0 || done === products.length) send({ type: 'progress', done, total: products.length, counts: c });
    }
    finish();
  } catch (e) {
    log.push({ handle: '-', sku: '-', status: 'error', message: e.message });
    finish({ error: e.message });
  }
});

module.exports = router;
