/**
 * Other Brands — Step 1: stock update   (mounted at /api/brands)
 *
 *   GET  /list             brands + their rule text
 *   GET  /:id/count        Shopify products + variants for this vendor, CFS products + SKUs
 *   POST /stock-sync       { brandId, dryRun }  → live progress (SSE), then a log
 *   POST /codes-sync       { brandId, dryRun }  → Step 2: product_code / variant_code (SSE)
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
const { BRANDS, RULE_TEXT, getBrand, fetchBrandFeed, buildBrandStock, buildBrandCodes } = require('../utils/brands');

const router = express.Router();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cancelled = new Set();

// ── Keep Render awake while a brand run is going (same as Image Sync) ─────────
// Render's free plan sleeps after ~15 min without incoming requests, so during a
// run we ping our own public /health URL every 4 minutes. The run also carries on
// on the server if the browser tab is closed.
let awakeJobs = 0, awakeTimer = null;
const selfPingUrl = () => {
  const base = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
  return base ? `${base.replace(/\/$/, '')}/health` : null;
};
function startKeepAwake() {
  awakeJobs++;
  if (awakeTimer || !selfPingUrl()) return;
  const ping = () => axios.get(selfPingUrl(), { timeout: 20000 }).catch(e => console.warn('  ⚠ keep-awake ping failed:', e.message));
  ping();
  awakeTimer = setInterval(ping, 4 * 60 * 1000);
  console.log('  ☕ Other Brands: keep-awake on');
}
function stopKeepAwake() {
  awakeJobs = Math.max(0, awakeJobs - 1);
  if (awakeJobs === 0 && awakeTimer) { clearInterval(awakeTimer); awakeTimer = null; console.log('  ☕ Other Brands: keep-awake off'); }
}

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

// Counts shown on each brand card:
//   Shopify — products and variants with this exact vendor name
//   CFS     — products in the brand's feed and SKUs (a product without variants = 1 SKU,
//             a product with variants = 1 SKU per variant)
// CFS counts are kept for 30 minutes so reloading the page doesn't refetch every feed.
const COUNT_PRODUCTS = `query c($q: String!, $after: String) { products(first: 250, after: $after, query: $q) {
  pageInfo { hasNextPage endCursor } nodes { vendor status variantsCount { count } } } }`;
const cfsCountCache = new Map();   // brandId → { at, products, skus }
async function cfsCounts(brand) {
  const hit = cfsCountCache.get(brand.id);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit;
  const feed = await fetchBrandFeed(brand.id);
  const out = { at: Date.now(), products: feed.length,
    skus: feed.reduce((n, p) => n + (Array.isArray(p.variants) && p.variants.length ? p.variants.length : 1), 0) };
  cfsCountCache.set(brand.id, out);
  return out;
}

router.get('/:id/count', async (req, res) => {
  const brand = getBrand(req.params.id);
  if (!brand) return res.status(404).json({ error: 'Unknown brand' });
  try {
    const client = graphqlClient();
    const shop = (async () => {
      let products = 0, active = 0, variants = 0, after = null;
      do {
        const d = await gql(client, COUNT_PRODUCTS, { q: `vendor:"${brand.vendor}"`, after });
        for (const p of d.products.nodes) {
          if (!sameVendor(p.vendor, brand.vendor)) continue;
          products++; if (p.status === 'ACTIVE') active++;
          variants += p.variantsCount?.count || 0;
        }
        after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
      } while (after);
      return { products, active, variants };
    })();
    const cfs = cfsCounts(brand).catch(e => ({ error: e.message }));
    const [s, c] = await Promise.all([shop, cfs]);
    res.json({ id: brand.id, vendor: brand.vendor, count: s.products, active: s.active, variants: s.variants,
      cfsProducts: c.products ?? null, cfsSkus: c.skus ?? null, cfsError: c.error || null });
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
  if (res.socket) res.socket.setNoDelay(true);
  res.flushHeaders();
  // If the browser disconnects, writes are skipped and the run carries on
  const send = o => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(o)}\n\n`); };
  const ping = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n'); }, 15000);
  startKeepAwake();
  console.log(`▶ Other Brands stock update — ${brand.vendor} (${brand.id}) dryRun=${dryRun}`);
  const runId = crypto.randomBytes(6).toString('hex');
  send({ type: 'run_id', runId });

  const log = [];
  const c = { products: 0, variants: 0, updated: 0, unchanged: 0, notInCfs: 0, flagged: 0, skippedDraft: 0, failed: 0 };
  const finish = (extra = {}) => {
    clearInterval(ping); cancelled.delete(runId); stopKeepAwake();
    console.log(`  ✓ Other Brands ${brand.vendor} done — ${JSON.stringify(c)}${extra.cancelled ? ' (stopped)' : ''}`);
    send({ type: 'done', kind: 'stock', dryRun, brand: brand.vendor, counts: c, log, ...extra });
    if (!res.writableEnded) res.end();
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
      if (done % 100 === 0) console.log(`  … ${brand.vendor}: ${done}/${products.length} products`);
    }
    finish();
  } catch (e) {
    log.push({ handle: '-', sku: '-', status: 'error', message: e.message });
    finish({ error: e.message });
  }
});

// ── Step 2: product codes ─────────────────────────────────────────────────────
// Same rules as Urban Deco's Step 4, limited to one brand's products (all statuses):
//   custom.product_code on the product, custom.variant_code on each variant.
// Only missing or different codes are written; SKUs not in CFS are listed and left alone.
const CODE_PRODUCTS = `
  query p($first: Int!, $after: String, $q: String) {
    products(first: $first, after: $after, query: $q) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id handle title vendor status
        metafield(namespace: "custom", key: "product_code") { value }
        variants(first: 250) { nodes { id sku title metafield(namespace: "custom", key: "variant_code") { value } } }
      }
    }
  }`;

router.post('/codes-sync', async (req, res) => {
  const brand = getBrand(req.body?.brandId);
  const dryRun = req.body?.dryRun !== false && req.body?.dryRun !== 'false';
  if (!brand) return res.status(400).json({ error: 'Pick a brand' });
  let client;
  try { client = graphqlClient(); } catch (e) { return res.status(400).json({ error: e.message }); }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.socket) res.socket.setNoDelay(true);
  res.flushHeaders();
  const send = o => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(o)}\n\n`); };
  const ping = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n'); }, 15000);
  startKeepAwake();
  console.log(`▶ Other Brands codes — ${brand.vendor} (${brand.id}) dryRun=${dryRun}`);
  const runId = crypto.randomBytes(6).toString('hex');
  send({ type: 'run_id', runId });

  const log = [];
  const c = { products: 0, productCodes: 0, variants: 0, updated: 0, unchanged: 0, notInCfs: 0, flagged: 0, failed: 0 };
  const finish = (extra = {}) => {
    clearInterval(ping); cancelled.delete(runId); stopKeepAwake();
    console.log(`  ✓ Other Brands codes ${brand.vendor} done — ${JSON.stringify(c)}${extra.cancelled ? ' (stopped)' : ''}`);
    send({ type: 'done', kind: 'codes', dryRun, brand: brand.vendor, counts: c, log, ...extra });
    if (!res.writableEnded) res.end();
  };

  try {
    send({ type: 'status', message: `Loading CFS feed for ${brand.vendor} (brand ${brand.id})…` });
    const codes = buildBrandCodes(await fetchBrandFeed(brand.id));
    send({ type: 'status', message: `CFS: ${codes.size} SKUs with codes` });
    const vendor = brand.vendor;

    const products = [];
    let after = null;
    do {
      if (cancelled.has(runId)) return finish({ cancelled: true });
      const d = await gql(client, CODE_PRODUCTS, { first: 50, after, q: `vendor:"${vendor}"` });
      products.push(...d.products.nodes.filter(p => sameVendor(p.vendor, vendor)));
      send({ type: 'fetch', fetched: products.length });
      after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
      if (after) await sleep(150);
    } while (after);
    send({ type: 'status', message: `Shopify: ${products.length} ${vendor} products` });
    if (!products.length) log.push({ handle: '-', sku: '-', status: 'warning', message: `No Shopify products found with vendor "${vendor}"` });

    let done = 0;
    for (const p of products) {
      if (cancelled.has(runId)) return finish({ cancelled: true });
      done++; c.products++;
      const metafields = [], rows = [];
      const statusNote = p.status !== 'ACTIVE' ? ` (${p.status.toLowerCase()})` : '';
      // product_code = CFS product code of the first variant found in CFS
      const found = p.variants.nodes.map(v => ({ v, code: v.sku ? codes.get(v.sku.trim()) : null }));
      const prodCode = found.find(x => x.code?.productCode)?.code.productCode || '';
      const curProd = p.metafield?.value || '';
      if (prodCode && curProd !== prodCode) {
        metafields.push({ ownerId: p.id, namespace: 'custom', key: 'product_code', value: prodCode, type: 'single_line_text_field' });
        c.productCodes++;
        rows.push({ handle: p.handle, sku: '(product)', status: dryRun ? 'dry_run' : 'updated',
          message: `${dryRun ? 'Would set' : 'Set'} product_code: "${curProd}" → "${prodCode}"${statusNote}` });
      }
      const distinct = new Set(found.map(x => x.code?.productCode).filter(Boolean));
      if (distinct.size > 1) {
        c.flagged++;
        rows.push({ handle: p.handle, sku: '(product)', status: 'flag', message: `Variants belong to ${distinct.size} CFS products (${[...distinct].join(', ')}) — product_code set to the first one, please check` });
      }
      for (const { v, code } of found) {
        if (!v.sku) continue;
        c.variants++;
        if (!code) { c.notInCfs++; rows.push({ handle: p.handle, sku: v.sku, status: 'not_in_cfs', message: `SKU not in the ${vendor} CFS feed — code not changed${statusNote}` }); continue; }
        const cur = v.metafield?.value || '';
        if (!code.variantCode) {
          c.unchanged++;
          rows.push({ handle: p.handle, sku: v.sku, status: 'unchanged', message: `No variant code in CFS for this SKU (product with CFS variants) — left as "${cur}"` });
        } else if (cur === code.variantCode) {
          c.unchanged++;
          rows.push({ handle: p.handle, sku: v.sku, status: 'unchanged', message: `variant_code already "${cur}"` });
        } else {
          c.updated++;
          metafields.push({ ownerId: v.id, namespace: 'custom', key: 'variant_code', value: code.variantCode, type: 'single_line_text_field' });
          rows.push({ handle: p.handle, sku: v.sku, status: dryRun ? 'dry_run' : 'updated',
            message: `${dryRun ? 'Would set' : 'Set'} variant_code: "${cur}" → "${code.variantCode}"${statusNote}` });
        }
      }
      if (!dryRun && metafields.length) {
        try {
          for (let i = 0; i < metafields.length; i += 25) {
            const r = await gql(client, METAFIELDS_SET, { metafields: metafields.slice(i, i + 25) });
            const errs = r?.metafieldsSet?.userErrors || [];
            if (errs.length) { c.failed++; rows.push({ handle: p.handle, sku: '-', status: 'error', message: `Codes: ${errs.map(e => e.message).join(', ')}` }); }
          }
        } catch (e) { c.failed++; rows.push({ handle: p.handle, sku: '-', status: 'error', message: e.message }); }
        await sleep(100);
      }
      log.push(...rows);
      if (done % 10 === 0 || done === products.length) send({ type: 'progress', done, total: products.length, counts: c });
      if (done % 100 === 0) console.log(`  … ${brand.vendor} codes: ${done}/${products.length} products`);
    }
    finish();
  } catch (e) {
    log.push({ handle: '-', sku: '-', status: 'error', message: e.message });
    finish({ error: e.message });
  }
});

module.exports = router;
