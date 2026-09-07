const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const axios   = require('axios');
require('dotenv').config();

const { streamShopifyVariants, getRows } = require('../utils/parseCSV');
const { fetchCfsProducts, buildStockData, buildCompareData } = require('../utils/cfsApi');
const { compareVariants } = require('../utils/matchVariants');

const router = express.Router();

// ── Per-request cancel map ────────────────────────────────────────────────────
// Maps runId → boolean (true = cancelled).
// Multiple concurrent syncs can be cancelled independently.
const cancelMap = new Map();

function isCancelled(runId) { return cancelMap.get(runId) === true; }
function makeRunId()        { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

// ── POST /api/stock/cancel ────────────────────────────────────────────────────
router.post('/cancel', (req, res) => {
  const { runId } = req.body || {};
  if (runId && cancelMap.has(runId)) {
    cancelMap.set(runId, true);
    console.log(`  ⛔ Sync cancel requested (runId: ${runId})`);
  } else {
    // Fallback: cancel all active runs
    for (const [id] of cancelMap) cancelMap.set(id, true);
    console.log('  ⛔ Sync cancel requested (all active runs)');
  }
  res.json({ ok: true });
});

// ── File upload ───────────────────────────────────────────────────────────────
const ALLOWED_EXTS = ['.csv', '.xlsx', '.xls'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTS.includes(ext)) return cb(null, true);
    cb(new Error(`Only CSV and Excel files are allowed (got ${ext})`));
  },
});

function tryUnlink(filePath) {
  try { fs.unlinkSync(filePath); } catch (_) {}
}

// ── Shopify GraphQL client ────────────────────────────────────────────────────
function graphqlClient() {
  const store   = process.env.SHOPIFY_STORE;
  const token   = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_API_TOKEN;
  const version = process.env.SHOPIFY_API_VERSION || '2026-07';
  if (!store || !token) throw new Error('Not connected to Shopify. Please connect first.');
  return {
    url:     `https://${store}/admin/api/${version}/graphql.json`,
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gql(client, query, variables = {}, attempt = 1) {
  try {
    const res = await axios.post(client.url, { query, variables }, { headers: client.headers, timeout: 30000 });
    if (res.data.errors) throw new Error(`GraphQL error: ${res.data.errors.map(e => e.message).join('; ')}`);
    return res.data.data;
  } catch (err) {
    const status = err.response?.status;
    if ((status === 429 || (status >= 500 && status < 600)) && attempt <= 3) {
      const delay = attempt * 2000;
      console.warn(`  ⚠ HTTP ${status} — retrying in ${delay}ms (attempt ${attempt}/3)`);
      await sleep(delay);
      return gql(client, query, variables, attempt + 1);
    }
    throw err;
  }
}

// ── Queries ───────────────────────────────────────────────────────────────────

const GET_LOCATIONS_QUERY = `
  query getLocations {
    locations(first: 10) {
      edges { node { id name } }
    }
  }
`;

const GET_PRODUCT_METAFIELDS_QUERY = `
  query getProductMetafields($handle: String!) {
    productByHandle(handle: $handle) {
      id
      title
      metafields(first: 20, namespace: "custom") {
        edges { node { key value } }
      }
      variants(first: 250) {
        edges {
          node {
            id
            sku
            metafields(first: 20, namespace: "custom") {
              edges { node { key value } }
            }
            inventoryItem { id }
          }
        }
      }
    }
  }
`;

const GET_PRODUCT_STOCK_QUERY = `
  query getProductStock($handle: String!, $locationId: ID!) {
    productByHandle(handle: $handle) {
      id
      title
      metafields(first: 20, namespace: "custom") {
        edges { node { key value } }
      }
      variants(first: 250) {
        edges {
          node {
            id
            sku
            metafields(first: 20, namespace: "custom") {
              edges { node { key value } }
            }
            inventoryItem {
              id
              inventoryLevel(locationId: $locationId) {
                quantities(names: ["available"]) { name quantity }
              }
            }
          }
        }
      }
    }
  }
`;

const GET_PRODUCTS_BULK_QUERY = `
  query getProductsBulk($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id handle title vendor status
          metafields(first: 20, namespace: "custom") {
            edges { node { key value } }
          }
          variants(first: 250) {
            edges {
              node {
                id sku
                metafields(first: 20, namespace: "custom") {
                  edges { node { key value } }
                }
                inventoryItem { id }
              }
            }
          }
        }
      }
    }
  }
`;

const GET_PRODUCTS_BULK_QUERY_WITH_INV = `
  query getProductsBulkWithInv($first: Int!, $after: String, $locationId: ID!, $query: String) {
    products(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id handle title vendor status
          metafields(first: 20, namespace: "custom") {
            edges { node { key value } }
          }
          variants(first: 250) {
            edges {
              node {
                id sku
                metafields(first: 20, namespace: "custom") {
                  edges { node { key value } }
                }
                inventoryItem {
                  id
                  inventoryLevel(locationId: $locationId) {
                    quantities(names: ["available"]) { name quantity }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// ── Mutations ─────────────────────────────────────────────────────────────────

const METAFIELDS_SET_MUTATION = `
  mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key value }
      userErrors { field message code }
    }
  }
`;

const INVENTORY_SET_MUTATION = `
  mutation SetInventory($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup { id }
      userErrors { field message code }
    }
  }
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseSku(sku) {
  const parts = sku.split('-');
  return { prodId: parts[1] || null, varId: parts[2] || null };
}

function metafieldMap(metafields) {
  const map = {};
  const nodes = metafields?.edges
    ? metafields.edges.map(e => e.node)
    : (metafields || []);
  for (const mf of nodes) {
    if (mf && mf.key) map[mf.key] = mf.value ?? '';
  }
  return map;
}

function deliveryTimeIsShort(deliveryTime) {
  if (!deliveryTime) return false;
  const lower = deliveryTime.trim().toLowerCase();
  if (lower === 'in stock' || lower === '' || lower === 'call') return true;
  const rangeMatch  = lower.match(/(\d+)\s*[-–]\s*(\d+)\s*weeks?/i);
  const singleMatch = lower.match(/^(\d+)\s*weeks?/i);
  const daysMatch   = lower.match(/(\d+)\s*days?/i);
  if (rangeMatch)  return parseInt(rangeMatch[2],  10) <= 6;
  if (singleMatch) return parseInt(singleMatch[1], 10) <= 6;
  if (daysMatch)   return parseInt(daysMatch[1],   10) <= 42;
  return false;
}

function diffStr(oldVal, newVal) {
  const old = oldVal ?? null;
  if (old === newVal) return `currently "${newVal}" (no change)`;
  if (old === null || old === '') return `not yet set — will set to "${newVal}"`;
  return `currently "${old}" — will change to "${newVal}"`;
}

function diffQty(currentQty, newQty) {
  if (currentQty === null) return `current value unknown — will set to ${newQty}`;
  if (currentQty === newQty) return `currently ${newQty} (no change)`;
  return `currently ${currentQty} — will set to ${newQty}`;
}

// ── Batch metafield writer (chunks of 25) ─────────────────────────────────────
async function writeMetafieldsBatched(client, allMetafields, logTarget, handle) {
  for (let i = 0; i < allMetafields.length; i += 25) {
    const chunk = allMetafields.slice(i, i + 25);
    const mfResult = await gql(client, METAFIELDS_SET_MUTATION, { metafields: chunk });
    const mfErrors = mfResult?.metafieldsSet?.userErrors || [];
    if (mfErrors.length) {
      logTarget.push({ sku: '-', handle, status: 'warning',
        message: `Metafield batch error: ${mfErrors.map(e => e.message).join(', ')}` });
    }
  }
}

// ── POST /api/stock/sync ──────────────────────────────────────────────────────
router.post(
  '/sync',
  upload.fields([
    { name: 'shopifyFile1', maxCount: 1 },
    { name: 'shopifyFile2', maxCount: 1 },
  ]),
  async (req, res) => {
    const uploadedPaths = [];

    try {
      const files  = req.files || {};
      const dryRun = req.body?.dryRun !== 'false' && req.body?.dryRun !== false;

      if (!files.shopifyFile1) {
        return res.status(400).json({ error: 'Please upload at least one Shopify export file.' });
      }

      const shopifyFile1Path = files.shopifyFile1[0].path;
      const shopifyFile2Path = files.shopifyFile2?.[0]?.path || null;
      uploadedPaths.push(shopifyFile1Path);
      if (shopifyFile2Path) uploadedPaths.push(shopifyFile2Path);

      const runId = makeRunId();
      cancelMap.set(runId, false);

      console.log('▶ Stock sync (CSV) — fetching CFS data…');
      const cfsProducts = await fetchCfsProducts();
      const { prodStockBySku, prodStockByProdId, varStockBySku, varStockByAttrId } =
        buildStockData(cfsProducts);
      console.log(`  ✓ ${cfsProducts.length} CFS products`);

      console.log('▶ Streaming Shopify export…');
      const shopifyVariants = await streamShopifyVariants(shopifyFile1Path);
      if (shopifyFile2Path) {
        const v2 = await streamShopifyVariants(shopifyFile2Path);
        shopifyVariants.push(...v2);
      }
      console.log(`  ✓ ${shopifyVariants.length} Shopify variants`);

      let client, locationId = null, hasLocations = false;
      try { client = graphqlClient(); }
      catch (err) { cancelMap.delete(runId); return res.status(400).json({ error: err.message }); }

      try {
        const locData = await gql(client, GET_LOCATIONS_QUERY);
        const locs    = (locData?.locations?.edges || []).map(e => e.node);
        const loc     = locs.find(l => /^shop$/i.test(l.name))
                     || locs.find(l => /shop|warehouse|main/i.test(l.name))
                     || locs[0];
        if (loc) { locationId = loc.id; hasLocations = true; }
      } catch (_) {}

      // ── SSE setup ───────────────────────────────────────────────────────────
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (res.socket) res.socket.setNoDelay(true);
      res.flushHeaders();
      const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      // Send runId immediately so client can cancel this specific run
      send({ type: 'run_id', runId });

      const log = [];
      let newCount = 0, updatedCount = 0, skipped = 0, failed = 0, processed = 0;

      if (!hasLocations) {
        log.push({ sku: '-', handle: '-', status: 'warning',
          message: 'Inventory sync disabled — token missing read_locations scope. Reconnect Shopify to fix.' });
      }

      const byHandle = new Map();
      for (const v of shopifyVariants) {
        if (!byHandle.has(v.handle)) byHandle.set(v.handle, []);
        byHandle.get(v.handle).push(v);
      }
      const totalProducts = byHandle.size;

      try {
        for (const [handle, variantsForProduct] of byHandle) {
          if (isCancelled(runId)) {
            send({ type: 'done', success: true, cancelled: true, dryRun,
              newCount, updatedCount, skipped, failed, total: shopifyVariants.length, log });
            res.end(); return;
          }

          try {
            const productStatus = (variantsForProduct[0].status || '').toLowerCase();
            if (productStatus && productStatus !== 'active') {
              skipped += variantsForProduct.length;
              log.push({ sku: variantsForProduct[0].variantSku, handle, status: 'skipped',
                message: `Shopify product is ${productStatus.toUpperCase()} — skipped` });
              processed++;
              send({ type: 'progress', processed, totalProducts, newCount, updatedCount, skipped, failed });
              continue;
            }

            const repSku = variantsForProduct[0].variantSku;
            let productData;
            if (locationId) {
              productData = await gql(client, GET_PRODUCT_STOCK_QUERY, { handle, locationId });
            } else {
              productData = await gql(client, GET_PRODUCT_METAFIELDS_QUERY, { handle });
            }

            const product = productData?.productByHandle;
            if (!product) {
              failed++;
              log.push({ sku: repSku, handle, status: 'failed', message: 'Product not found on Shopify' });
              processed++;
              send({ type: 'progress', processed, totalProducts, newCount, updatedCount, skipped, failed });
              continue;
            }

            const shopifyNodes = product.variants.edges.map(e => e.node);
            const existingProd = metafieldMap(product.metafields);

            // ── Collect phase: gather all writes for this product ─────────────
            const allMetafields    = []; // batched in chunks of 25
            const allInventory     = []; // sent in one call
            const varLogs          = [];
            let   productInoutWritten = false;

            for (const shopNode of shopifyNodes) {
              const varSku = shopNode.sku;
              if (!varSku) continue;

              const varStock     = varStockBySku.get(varSku);
              const varProdStock = varStock ? null : prodStockBySku.get(varSku);

              if (!varStock && !varProdStock) {
                skipped++;
                varLogs.push({ sku: varSku, handle, status: 'skipped',
                  message: 'No CFS stock data found for this variant SKU — skipped' });
                continue;
              }

              const vDeliveryTime = varStock ? varStock.vNotificationTitle : varProdStock.deliveryTime;
              const vDueDate      = varStock ? (varStock.vDueDate || '') : (varProdStock?.dueDate || '');
              const vIsShortLead  = deliveryTimeIsShort(vDeliveryTime);
              const vInOutStock   = vIsShortLead ? 'IN STOCK' : 'OUT OF STOCK';

              // Product-level metafields — once
              if (!productInoutWritten) {
                productInoutWritten = true;
                const prodInoutCur = existingProd['inoutstock'] ?? null;
                if (prodInoutCur !== vInOutStock) {
                  allMetafields.push({ ownerId: product.id, namespace: 'custom',
                    key: 'inoutstock', value: vInOutStock, type: 'single_line_text_field' });
                }
                if (vDueDate) {
                  allMetafields.push({ ownerId: product.id, namespace: 'custom',
                    key: 'duedate', value: vDueDate, type: 'single_line_text_field' });
                }
              }

              const existingVar = metafieldMap(shopNode.metafields);
              const invLevel    = shopNode.inventoryItem?.inventoryLevel;
              const currentQty  = invLevel?.quantities?.find(q => q.name === 'available')?.quantity ?? null;
              const invItemId   = shopNode.inventoryItem?.id;

              // Variant metafields
              const mfStart       = allMetafields.length;
              const vInoutCur     = existingVar['inoutstock'] ?? null;
              const vInoutChanged = vInoutCur !== vInOutStock;
              if (vInoutChanged) {
                allMetafields.push({ ownerId: shopNode.id, namespace: 'custom',
                  key: 'inoutstock', value: vInOutStock, type: 'single_line_text_field' });
              }
              if (vDeliveryTime && existingVar['vnotificationtitle'] !== vDeliveryTime) {
                allMetafields.push({ ownerId: shopNode.id, namespace: 'custom',
                  key: 'vnotificationtitle', value: vDeliveryTime, type: 'single_line_text_field' });
              }
              if (vDueDate && existingVar['duedate'] !== vDueDate) {
                allMetafields.push({ ownerId: shopNode.id, namespace: 'custom',
                  key: 'duedate', value: vDueDate, type: 'single_line_text_field' });
              }
              const varMfChanged = allMetafields.length > mfStart;

              // Inventory
              const cfsOnHand = varStock ? (varStock.vOnHand ?? 0) : (varProdStock?.onHand ?? 0);
              let targetQty, shouldWriteInv;
              if (!vIsShortLead) {
                targetQty      = 0;
                shouldWriteInv = locationId !== null && currentQty !== 0;
              } else {
                targetQty      = cfsOnHand > 0 ? cfsOnHand : 2;
                shouldWriteInv = locationId !== null && currentQty !== targetQty;
              }
              if (shouldWriteInv && invItemId && locationId) {
                allInventory.push({
                  inventoryItemId: invItemId, locationId,
                  quantity: targetQty, changeFromQuantity: currentQty ?? 0,
                });
              }

              // Log entry
              const anyChanged = vInoutChanged || shouldWriteInv || varMfChanged;
              if (!anyChanged && currentQty !== null) {
                skipped++;
                varLogs.push({ sku: varSku, handle, status: 'skipped',
                  message: `All values already correct — no changes needed\n  inoutstock: "${vInOutStock}" (no change)\n  qty:        ${currentQty} (no change)` });
              } else {
                const isNew     = vInoutCur === null || currentQty === null;
                const status    = dryRun ? 'dry_run' : (isNew ? 'new' : 'updated');
                const ruleLabel = vIsShortLead ? 'IN STOCK' : 'OUT OF STOCK';
                const delivery  = vDeliveryTime || 'n/a';
                const inoutChange = diffStr(vInoutCur, vInOutStock);
                let qtyChange;
                if (locationId !== null) {
                  if (!vIsShortLead) {
                    qtyChange = diffQty(currentQty, 0);
                  } else {
                    const tgt = cfsOnHand > 0 ? cfsOnHand : 2;
                    const note = cfsOnHand > 0 ? ` (CFS onHand: ${cfsOnHand})` : ' (CFS onHand: 0, using fallback)';
                    qtyChange = currentQty === tgt
                      ? `currently ${currentQty} (no change — already matches CFS)`
                      : `currently ${currentQty ?? 'unknown'} — will set to ${tgt}${note}`;
                  }
                } else {
                  qtyChange = !vIsShortLead
                    ? 'would set to 0 — reconnect Shopify to enable inventory reads'
                    : `would set to ${cfsOnHand > 0 ? cfsOnHand : 2} — reconnect Shopify to enable inventory reads`;
                }
                if (isNew) newCount++; else updatedCount++;
                varLogs.push({ sku: varSku, handle, status, rule: ruleLabel, delivery, inoutChange, qtyChange, dueDateChange: vDueDate || '' });
              }
            }

            // ── Write phase (skipped in dry run) ─────────────────────────────
            if (!dryRun) {
              await writeMetafieldsBatched(client, allMetafields, varLogs, handle);
              if (allInventory.length > 0) {
                const invResult = await gql(client, INVENTORY_SET_MUTATION, {
                  idempotencyKey: require('crypto').randomUUID(),
                  input: { name: 'available', reason: 'correction', quantities: allInventory },
                });
                const invErrors = invResult?.inventorySetQuantities?.userErrors || [];
                if (invErrors.length) {
                  varLogs.push({ sku: '-', handle, status: 'warning',
                    message: `Inventory batch error: ${invErrors.map(e => e.message).join(', ')}` });
                }
              }
            }

            log.push(...varLogs);
            await sleep(dryRun ? 30 : 100);

          } catch (prodErr) {
            failed++;
            console.error(`  ✗ Error on handle "${handle}":`, prodErr.message);
            log.push({ sku: '-', handle, status: 'failed', message: prodErr.message });
          }

          processed++;
          send({ type: 'progress', processed, totalProducts, newCount, updatedCount, skipped, failed });

          if (processed % 50 === 0 || processed === totalProducts) {
            console.log(`  … ${processed}/${totalProducts} — new:${newCount} updated:${updatedCount} skipped:${skipped} failed:${failed}`);
          }
        }
      } catch (outerErr) {
        console.error(`  ✗ Unexpected outer error:`, outerErr.message);
        send({ type: 'done', success: false, error: `Server error: ${outerErr.message}`,
          dryRun, newCount, updatedCount, skipped, failed, total: shopifyVariants.length, log });
        res.end(); return;
      }

      console.log(`  ✓ Stock sync done — new:${newCount} updated:${updatedCount} skipped:${skipped} failed:${failed}`);
      send({ type: 'done', success: true, dryRun, newCount, updatedCount, skipped, failed, total: shopifyVariants.length, log });
      res.end();

    } catch (err) {
      console.error('Stock sync error:', err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.end();
    } finally {
      uploadedPaths.forEach(tryUnlink);
      // runId cleanup happens after res.end() — keep it so cancel doesn't error
      setTimeout(() => {
        const { runId } = res.locals || {};
        if (runId) cancelMap.delete(runId);
      }, 5000);
    }
  }
);

// ── POST /api/stock/sync-api ──────────────────────────────────────────────────
router.post('/sync-api', async (req, res) => {
  try {
    const dryRun = req.body?.dryRun !== 'false' && req.body?.dryRun !== false;
    const runId  = makeRunId();
    cancelMap.set(runId, false);

    let client;
    try { client = graphqlClient(); }
    catch (err) { cancelMap.delete(runId); return res.status(400).json({ error: err.message }); }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.socket) res.socket.setNoDelay(true);
    res.flushHeaders();

    const send     = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const keepalive = setInterval(() => res.write(': ping\n\n'), 15000);
    const cleanup   = () => { clearInterval(keepalive); setTimeout(() => cancelMap.delete(runId), 5000); };

    try {
      // Send runId immediately so client can cancel this specific run
      send({ type: 'run_id', runId });

      // ── Phase 1a: CFS stock data ──────────────────────────────────────────
      send({ type: 'status', phase: 'cfs', message: 'Fetching CFS stock data…' });
      const cfsProducts = await fetchCfsProducts();
      const { prodStockBySku, varStockBySku } = buildStockData(cfsProducts);
      send({ type: 'status', phase: 'cfs-done',
        message: `CFS: ${cfsProducts.length} products, ${varStockBySku.size} variant records` });

      // ── Phase 1b: Shopify location ────────────────────────────────────────
      let locationId = null, hasLocations = false;
      send({ type: 'status', phase: 'location', message: 'Fetching Shopify location…' });
      try {
        const locData = await gql(client, GET_LOCATIONS_QUERY);
        const locs    = (locData?.locations?.edges || []).map(e => e.node);
        const loc     = locs.find(l => /^shop$/i.test(l.name))
                     || locs.find(l => /shop|warehouse|main/i.test(l.name))
                     || locs[0];
        if (loc) {
          locationId = loc.id; hasLocations = true;
          send({ type: 'status', phase: 'location-done', message: `Location: "${loc.name}"` });
        } else {
          send({ type: 'status', phase: 'location-warn', message: 'No location found — inventory sync will be skipped' });
        }
      } catch (_) {
        send({ type: 'status', phase: 'location-warn', message: 'Location fetch failed — inventory sync will be skipped' });
      }

      // ── Phase 1c: Paginated Shopify product fetch ─────────────────────────
      send({ type: 'status', phase: 'shopify-fetch', message: 'Fetching Shopify products…' });

      const byHandle = new Map();
      let   cursor   = null;
      const PAGE     = 50;
      const QUERY    = locationId ? GET_PRODUCTS_BULK_QUERY_WITH_INV : GET_PRODUCTS_BULK_QUERY;

      while (true) {
        if (isCancelled(runId)) {
          send({ type: 'done', success: true, cancelled: true, dryRun,
            newCount: 0, updatedCount: 0, skipped: 0, failed: 0, total: 0, log: [] });
          cleanup(); res.end(); return;
        }

        const vars = { first: PAGE, query: 'vendor:"Urban Deco"' };
        if (cursor)     vars.after      = cursor;
        if (locationId) vars.locationId = locationId;

        const data = await gql(client, QUERY, vars);
        const page = data?.products;
        if (!page) break;

        for (const edge of (page.edges || [])) {
          if (edge.node?.handle) byHandle.set(edge.node.handle, edge.node);
        }

        send({ type: 'fetch-progress', fetched: byHandle.size, hasMore: page.pageInfo.hasNextPage });
        console.log(`  … Fetched ${byHandle.size} products so far…`);
        if (!page.pageInfo.hasNextPage) break;
        cursor = page.pageInfo.endCursor;
        await sleep(200);
      }

      const totalProducts = byHandle.size;
      send({ type: 'fetch-done', total: totalProducts });
      console.log(`  ✅ Done fetching — ${totalProducts} products (dryRun=${dryRun}, inventory=${hasLocations})`);

      // ── Phase 2: Sync ─────────────────────────────────────────────────────
      const log = [];
      let newCount = 0, updatedCount = 0, skipped = 0, failed = 0, processed = 0;

      if (!hasLocations) {
        log.push({ sku: '-', handle: '-', status: 'warning',
          message: 'Inventory sync disabled — token is missing read_locations or read_inventory scope. Reconnect Shopify to fix.' });
      }

      for (const [handle, product] of byHandle) {
        if (isCancelled(runId)) {
          send({ type: 'done', success: true, cancelled: true, dryRun,
            newCount, updatedCount, skipped, failed, total: totalProducts, log });
          cleanup(); res.end(); return;
        }

        try {
          const productStatus = (product.status || '').toLowerCase();
          if (productStatus && productStatus !== 'active') {
            const varCount = product.variants?.edges?.length || 0;
            skipped += varCount;
            log.push({ sku: '-', handle, status: 'skipped',
              message: `Shopify product is ${productStatus.toUpperCase()} — skipped` });
            processed++;
            send({ type: 'progress', processed, totalProducts, newCount, updatedCount, skipped, failed });
            continue;
          }

          const shopifyNodes   = (product.variants?.edges || []).map(e => e.node);
          const existingProd   = metafieldMap(product.metafields);

          // ── Collect phase ─────────────────────────────────────────────────
          const allMetafields    = [];
          const allInventory     = [];
          const varLogs          = [];
          let   productInoutWritten = false;

          for (const shopNode of shopifyNodes) {
            const varSku = shopNode.sku;
            if (!varSku) continue;

            const varStock     = varStockBySku.get(varSku);
            const varProdStock = varStock ? null : prodStockBySku.get(varSku);

            if (!varStock && !varProdStock) {
              skipped++;
              varLogs.push({ sku: varSku, handle, status: 'skipped',
                message: 'No CFS stock data found for this variant SKU — skipped' });
              continue;
            }

            const vDeliveryTime = varStock ? varStock.vNotificationTitle : varProdStock.deliveryTime;
            const vDueDate      = varStock ? (varStock.vDueDate || '') : (varProdStock?.dueDate || '');
            const vIsShortLead  = deliveryTimeIsShort(vDeliveryTime);
            const vInOutStock   = vIsShortLead ? 'IN STOCK' : 'OUT OF STOCK';

            // Product-level metafields — once per product
            if (!productInoutWritten) {
              productInoutWritten = true;
              const prodInoutCur = existingProd['inoutstock'] ?? null;
              if (prodInoutCur !== vInOutStock) {
                allMetafields.push({ ownerId: product.id, namespace: 'custom',
                  key: 'inoutstock', value: vInOutStock, type: 'single_line_text_field' });
              }
              if (vDueDate) {
                allMetafields.push({ ownerId: product.id, namespace: 'custom',
                  key: 'duedate', value: vDueDate, type: 'single_line_text_field' });
              }
            }

            const existingVar = metafieldMap(shopNode.metafields);
            const invLevel    = shopNode.inventoryItem?.inventoryLevel;
            const currentQty  = invLevel?.quantities?.find(q => q.name === 'available')?.quantity ?? null;
            const invItemId   = shopNode.inventoryItem?.id;

            // Variant metafields
            const mfStart       = allMetafields.length;
            const vInoutCur     = existingVar['inoutstock'] ?? null;
            const vInoutChanged = vInoutCur !== vInOutStock;
            if (vInoutChanged) {
              allMetafields.push({ ownerId: shopNode.id, namespace: 'custom',
                key: 'inoutstock', value: vInOutStock, type: 'single_line_text_field' });
            }
            if (vDeliveryTime && existingVar['vnotificationtitle'] !== vDeliveryTime) {
              allMetafields.push({ ownerId: shopNode.id, namespace: 'custom',
                key: 'vnotificationtitle', value: vDeliveryTime, type: 'single_line_text_field' });
            }
            if (vDueDate && existingVar['duedate'] !== vDueDate) {
              allMetafields.push({ ownerId: shopNode.id, namespace: 'custom',
                key: 'duedate', value: vDueDate, type: 'single_line_text_field' });
            }
            const varMfChanged = allMetafields.length > mfStart;

            // Inventory
            const cfsOnHand = varStock ? (varStock.vOnHand ?? 0) : (varProdStock?.onHand ?? 0);
            let targetQty, shouldWriteInv;
            if (!vIsShortLead) {
              targetQty      = 0;
              shouldWriteInv = locationId !== null && currentQty !== 0;
            } else {
              targetQty      = cfsOnHand > 0 ? cfsOnHand : 2;
              shouldWriteInv = locationId !== null && currentQty !== targetQty;
            }
            if (shouldWriteInv && invItemId && locationId) {
              allInventory.push({
                inventoryItemId: invItemId, locationId,
                quantity: targetQty, changeFromQuantity: currentQty ?? 0,
              });
            }

            // Log entry
            const anyChanged = vInoutChanged || shouldWriteInv || varMfChanged;
            if (!anyChanged && currentQty !== null) {
              skipped++;
              varLogs.push({ sku: varSku, handle, status: 'skipped',
                message: `All values already correct — no changes needed\n  inoutstock: "${vInOutStock}" (no change)\n  qty:        ${currentQty} (no change)` });
            } else {
              const isNew     = vInoutCur === null || currentQty === null;
              const status    = dryRun ? 'dry_run' : (isNew ? 'new' : 'updated');
              const ruleLabel = vIsShortLead ? 'IN STOCK' : 'OUT OF STOCK';
              const delivery  = vDeliveryTime || 'n/a';
              const inoutChange = diffStr(vInoutCur, vInOutStock);
              let qtyChange;
              if (locationId !== null) {
                if (!vIsShortLead) {
                  qtyChange = diffQty(currentQty, 0);
                } else {
                  const tgt  = cfsOnHand > 0 ? cfsOnHand : 2;
                  const note = cfsOnHand > 0 ? ` (CFS onHand: ${cfsOnHand})` : ' (CFS onHand: 0, using fallback)';
                  qtyChange = currentQty === tgt
                    ? `currently ${currentQty} (no change — already matches CFS)`
                    : `currently ${currentQty ?? 'unknown'} — will set to ${tgt}${note}`;
                }
              } else {
                qtyChange = 'inventory reads disabled — reconnect Shopify to enable';
              }
              if (isNew) newCount++; else updatedCount++;
              varLogs.push({ sku: varSku, handle, status, rule: ruleLabel, delivery, inoutChange, qtyChange, dueDateChange: vDueDate || '' });
            }
          }

          // ── Write phase (skipped in dry run) ─────────────────────────────
          if (!dryRun) {
            await writeMetafieldsBatched(client, allMetafields, varLogs, handle);
            if (allInventory.length > 0) {
              const invResult = await gql(client, INVENTORY_SET_MUTATION, {
                idempotencyKey: require('crypto').randomUUID(),
                input: { name: 'available', reason: 'correction', quantities: allInventory },
              });
              const invErrors = invResult?.inventorySetQuantities?.userErrors || [];
              if (invErrors.length) {
                varLogs.push({ sku: '-', handle, status: 'warning',
                  message: `Inventory batch error: ${invErrors.map(e => e.message).join(', ')}` });
              }
            }
          }

          log.push(...varLogs);
          await sleep(dryRun ? 30 : 100);

        } catch (prodErr) {
          failed++;
          console.error(`  ✗ "${handle}":`, prodErr.message);
          log.push({ sku: '-', handle, status: 'failed', message: prodErr.message });
        }

        processed++;
        send({ type: 'progress', processed, totalProducts, newCount, updatedCount, skipped, failed });

        if (processed % 50 === 0 || processed === totalProducts) {
          console.log(`  … ${processed}/${totalProducts} — new:${newCount} updated:${updatedCount} skipped:${skipped} failed:${failed}`);
        }
      }

      console.log(`  ✓ API sync done — new:${newCount} updated:${updatedCount} skipped:${skipped} failed:${failed}`);
      send({ type: 'done', success: true, dryRun, newCount, updatedCount, skipped, failed, total: totalProducts, log });

    } finally {
      cleanup();
      res.end();
    }

  } catch (err) {
    console.error('sync-api error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

// ── POST /api/stock/compare-api ───────────────────────────────────────────────
router.post('/compare-api', async (req, res) => {
  try {
    const client = graphqlClient();

    console.log('▶ [compare-api] Fetching CFS product data…');
    const cfsProducts = await fetchCfsProducts();
    const {
      validProductSKUs, cfsProductIds, validVariantSKUs, cfsVariantAttrIds,
      productCodesBySku, productCodesByProdId, cfsProductCodeToStatus,
      variantCodesBySku, variantCodesByAttrId, cfsVarCodeSet,
    } = buildCompareData(cfsProducts);

    console.log('▶ [compare-api] Fetching Shopify products…');
    const byHandle = new Map();
    let cursor = null;
    while (true) {
      const vars = { first: 50, query: 'vendor:"Urban Deco"' };
      if (cursor) vars.after = cursor;
      const data = await gql(client, GET_PRODUCTS_BULK_QUERY, vars);
      const page = data?.products;
      if (!page) break;
      for (const edge of (page.edges || [])) {
        if (edge.node?.handle) byHandle.set(edge.node.handle, edge.node);
      }
      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
      await sleep(200);
    }
    console.log(`  ✅ ${byHandle.size} Shopify products fetched`);

    function getMeta(edges, key) {
      const node = (edges || []).map(e => e.node).find(n => n.key === key);
      return node?.value || '';
    }

    const shopifyVariants = [];
    for (const product of byHandle.values()) {
      const productMeta = product.metafields?.edges || [];
      const shopifyProductCode = getMeta(productMeta, 'product_code');
      const status = (product.status || '').toLowerCase();
      for (const ve of (product.variants?.edges || [])) {
        const variant = ve.node;
        if (!variant.sku) continue;
        const variantMeta = variant.metafields?.edges || [];
        shopifyVariants.push({
          handle: product.handle, title: product.title || '',
          variantSku: variant.sku, option1: '', option2: '', barcode: '', inventoryQty: '',
          status, shopifyVariantCode: getMeta(variantMeta, 'variant_code'), shopifyProductCode,
        });
      }
    }

    const { results, summary } = compareVariants(
      shopifyVariants, validVariantSKUs, validProductSKUs, cfsProductIds, cfsVariantAttrIds,
      productCodesBySku, productCodesByProdId, variantCodesBySku, variantCodesByAttrId,
      cfsVarCodeSet, cfsProductCodeToStatus,
    );

    res.json({
      success: true, results, summary,
      cfsProductIds:     [...cfsProductIds.entries()],
      cfsVariantAttrIds: [...cfsVariantAttrIds],
    });

  } catch (err) {
    console.error('[compare-api] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/stock/calendar-sync ────────────────────────────────────────────
router.post('/calendar-sync', upload.single('froogleCsv'), async (req, res) => {
  const uploadedFile = req.file ? req.file.path : null;

  try {
    const dryRun = req.body?.dryRun !== 'false' && req.body?.dryRun !== false;
    const runId  = makeRunId();
    cancelMap.set(runId, false);

    let client;
    try { client = graphqlClient(); }
    catch (err) {
      cancelMap.delete(runId);
      if (uploadedFile) tryUnlink(uploadedFile);
      return res.status(400).json({ error: err.message });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.socket) res.socket.setNoDelay(true);
    res.flushHeaders();

    const send      = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const keepalive = setInterval(() => res.write(': ping\n\n'), 15000);
    const cleanup   = () => {
      clearInterval(keepalive);
      if (uploadedFile) tryUnlink(uploadedFile);
      setTimeout(() => cancelMap.delete(runId), 5000);
    };

    let log = [], updatedCount = 0, skipped = 0, failed = 0, processed = 0, totalProducts = 0;
    let froogleMode = false;

    try {
      // Send runId immediately so client can cancel this specific run
      send({ type: 'run_id', runId });

      // ── Phase 1a: Fetch CFS data ─────────────────────────────────────────────
      //
      // nextDayProductIds  Set<prodId>   — CFS products where deliveryTime = "Next Day"
      //                                    (product-level OR any variant)
      // cfsStockByProdId   Map<prodId, { onHand, variants: Map<varId, onHand> }>
      //                                  — for the in-stock check in Phase 2
      // nextDaySkus        Set<sku>      — Froogle CSV mode only (product-level SKUs)
      //
      const nextDaySkus      = new Set();
      const nextDayProductIds = new Set(); // API mode: CFS productIds that are Next Day
      const cfsStockByProdId  = new Map(); // API mode: stock data keyed by productId

      if (uploadedFile) {
        froogleMode = true;
        send({ type: 'status', phase: 'cfs', message: 'Parsing Froogle CSV for Next Day products…' });
        const rows = await getRows(uploadedFile);
        for (const row of rows) {
          const sku = String(row['Shopify SKU'] || '').trim();
          const dt  = String(row['Delivery Time'] || '').trim();
          if (sku && dt === 'Next Day') nextDaySkus.add(sku);
        }
        send({ type: 'status', phase: 'cfs-done',
          message: `Froogle CSV: ${rows.length} rows — ${nextDaySkus.size} Next Day product SKUs found` });
      } else {
        send({ type: 'status', phase: 'cfs', message: 'Fetching CFS product data…' });
        const cfsProducts = await fetchCfsProducts();

        for (const item of cfsProducts) {
          const prodId  = String(item.productId);
          const prodDt  = (item.deliveryTime || '').trim().toLowerCase();
          let   isNextDay = prodDt === 'next day';

          // Build variant stock map (variantId → onHand)
          const varStock = new Map();
          if (Array.isArray(item.variants) && item.variants.length > 0) {
            for (const v of item.variants) {
              const varDt = (v.deliveryTime || item.deliveryTime || '').trim().toLowerCase();
              if (varDt === 'next day') isNextDay = true;
              varStock.set(String(v.variantId), Number(v.onHand ?? item.onHand ?? 0));
            }
          }

          if (isNextDay) nextDayProductIds.add(prodId);

          cfsStockByProdId.set(prodId, {
            onHand:   Number(item.onHand ?? 0),
            variants: varStock,
          });
        }

        send({ type: 'status', phase: 'cfs-done',
          message: `CFS: ${cfsProducts.length} products — ${nextDayProductIds.size} are Next Day` });
      }

      // ── Phase 1b: Paginated Shopify product fetch ────────────────────────────
      send({ type: 'status', phase: 'shopify-fetch', message: 'Fetching Shopify products…' });

      const byHandle = new Map();
      let   cursor   = null;

      while (true) {
        if (isCancelled(runId)) {
          send({ type: 'done', success: true, cancelled: true, dryRun,
            updatedCount: 0, skipped: 0, failed: 0, total: 0, log: [] });
          cleanup(); res.end(); return;
        }

        const vars = { first: 50, query: 'vendor:"Urban Deco"' };
        if (cursor) vars.after = cursor;

        const data = await gql(client, GET_PRODUCTS_BULK_QUERY, vars);
        const page = data?.products;
        if (!page) break;

        for (const edge of (page.edges || [])) {
          if (edge.node?.handle) byHandle.set(edge.node.handle, edge.node);
        }
        send({ type: 'fetch-progress', fetched: byHandle.size, hasMore: page.pageInfo.hasNextPage });
        console.log(`  … Fetched ${byHandle.size} products so far…`);

        if (!page.pageInfo.hasNextPage) break;
        cursor = page.pageInfo.endCursor;
        await sleep(200);
      }

      totalProducts = byHandle.size;
      send({ type: 'fetch-done', total: totalProducts,
        nextDayCount: froogleMode ? nextDaySkus.size : nextDayProductIds.size });

      // ── Phase 2: Calendar sync ───────────────────────────────────────────────
      for (const [handle, product] of byHandle) {
        if (isCancelled(runId)) {
          send({ type: 'done', success: true, cancelled: true, dryRun,
            updatedCount, skipped, failed, total: totalProducts, log });
          cleanup(); res.end(); return;
        }

        try {
          const productStatus = (product.status || '').toLowerCase();
          if (productStatus && productStatus !== 'active') {
            const varCount = product.variants?.edges?.length || 0;
            skipped += varCount;
            log.push({ sku: '-', handle, status: 'skipped',
              message: `Shopify product is ${productStatus.toUpperCase()} — skipped` });
            processed++;
            send({ type: 'progress', processed, totalProducts, updatedCount, skipped, failed });
            continue;
          }

          const existingProd = metafieldMap(product.metafields);
          const shopifyNodes = (product.variants?.edges || []).map(e => e.node);

          let productHasNextDay      = false;
          let productCalendarWritten = false;

          // ── Collect variant metafields ────────────────────────────────────
          const allMetafields = [];
          const varLogs       = [];

          for (const shopNode of shopifyNodes) {
            const varSku = shopNode.sku;
            if (!varSku) continue;

            // ── Step 1: Is this a Next Day product? ────────────────────────
            // Parse productId and optional variantId from the Shopify SKU.
            // SKU format: UD-{productId}  or  UD-{productId}-{variantId}
            const skuMatch = varSku.match(/^UD-(\d+)(?:-(\d+))?$/);
            if (!skuMatch) {
              skipped++;
              varLogs.push({ sku: varSku, handle, status: 'skipped',
                message: 'SKU does not match UD-{prodId} pattern — skipped' });
              continue;
            }

            const prodId  = skuMatch[1];
            const varId   = skuMatch[2] ?? null; // null = no sub-variant

            let isNextDay;
            let cfsOnHand = null;
            let cfsInStock = null;

            if (froogleMode) {
              // CSV mode: match on product-level SKU UD-{prodId}
              isNextDay = nextDaySkus.has(`UD-${prodId}`);
            } else {
              // API mode: check if this productId is in the Next Day set from CFS
              isNextDay = nextDayProductIds.has(prodId);
            }

            if (!isNextDay) {
              skipped++;
              varLogs.push({
                sku: varSku, handle, status: 'skipped',
                cfsOnHand: null, cfsInStock: null,
                message: 'Not a Next Day product — skipped',
              });
              continue;
            }

            // ── Step 2: CFS stock check (API mode only) ────────────────────
            if (!froogleMode) {
              const stockEntry = cfsStockByProdId.get(prodId);
              if (stockEntry) {
                // If this Shopify variant has a sub-variantId, look up that specific
                // variant's stock; otherwise fall back to the product-level onHand.
                cfsOnHand = varId && stockEntry.variants.has(varId)
                  ? stockEntry.variants.get(varId)
                  : stockEntry.onHand;
                cfsInStock = cfsOnHand > 0;
              } else {
                cfsOnHand  = 0;
                cfsInStock = false;
              }

              if (!cfsInStock) {
                // Out of stock — set vshowcalendar=false on the variant if it isn't already
                const existingVarOos = metafieldMap(shopNode.metafields);
                const curVShowCalOos = existingVarOos['vshowcalendar'] ?? null;
                const calNeedsDisable = curVShowCalOos !== 'false';
                if (calNeedsDisable) {
                  updatedCount++;
                  allMetafields.push({ ownerId: shopNode.id, namespace: 'custom',
                    key: 'vshowcalendar', value: 'false', type: 'boolean' });
                  varLogs.push({
                    sku: varSku, handle,
                    status:    dryRun ? 'dry_run' : 'updated',
                    cfsOnHand, cfsInStock: false,
                    calBefore: curVShowCalOos ?? '(not set)',
                    calAfter:  'false',
                    message:   `Next Day but CFS out of stock (onHand: ${cfsOnHand}) — vshowcalendar set to false`,
                  });
                } else {
                  skipped++;
                  varLogs.push({
                    sku: varSku, handle, status: 'skipped',
                    cfsOnHand, cfsInStock: false,
                    message: `Next Day but out of stock — vshowcalendar already false`,
                  });
                }
                continue;
              }
            }

            productHasNextDay = true;
            const existingVar = metafieldMap(shopNode.metafields);

            const curVShowCal    = existingVar['vshowcalendar'] ?? null;
            const vShowCalChanged = curVShowCal !== 'true';
            if (vShowCalChanged) {
              allMetafields.push({ ownerId: shopNode.id, namespace: 'custom',
                key: 'vshowcalendar', value: 'true', type: 'boolean' });
            }

            const curVNotif    = existingVar['vnotificationtitle'] ?? null;
            const vNotifChanged = curVNotif !== 'Next Day';
            if (vNotifChanged) {
              allMetafields.push({ ownerId: shopNode.id, namespace: 'custom',
                key: 'vnotificationtitle', value: 'Next Day', type: 'single_line_text_field' });
            }

            const anyVarChanged = vShowCalChanged || vNotifChanged;
            if (anyVarChanged) {
              updatedCount++;
              varLogs.push({
                sku: varSku, handle,
                status:       dryRun ? 'dry_run' : 'updated',
                cfsOnHand,
                cfsInStock,
                calBefore:    curVShowCal ?? '(not set)',
                calAfter:     'true',
                notifBefore:  curVNotif   ?? '(not set)',
                notifAfter:   'Next Day',
                calChanged:   vShowCalChanged,
                notifChanged: vNotifChanged,
              });
            } else {
              skipped++;
              varLogs.push({
                sku: varSku, handle, status: 'skipped',
                cfsOnHand,
                cfsInStock,
                message: 'Already correct — vshowcalendar=true and vnotificationtitle=Next Day',
              });
            }
          }

          // ── Product-level metafields ────────────────────────────────────────
          // productHasNextDay = at least one in-stock Next Day variant was found.
          // If no in-stock variant but product currently has showcalendar=true → set false.
          if (productHasNextDay && !productCalendarWritten) {
            // ── In-stock path: enable product calendar ──────────────────────
            productCalendarWritten = true;
            const curShowCal      = existingProd['showcalendar']       ?? null;
            const curProdNotif    = existingProd['vnotificationtitle']  ?? null;
            const showCalChanged  = curShowCal   !== 'true';
            const prodNotifChanged = curProdNotif !== 'Next Day';

            if (showCalChanged) {
              allMetafields.push({ ownerId: product.id, namespace: 'custom',
                key: 'showcalendar', value: 'true', type: 'boolean' });
            }
            if (prodNotifChanged) {
              allMetafields.push({ ownerId: product.id, namespace: 'custom',
                key: 'vnotificationtitle', value: 'Next Day', type: 'single_line_text_field' });
            }

            if (showCalChanged || prodNotifChanged) {
              varLogs.push({
                sku: '-', handle,
                status:       dryRun ? 'dry_run' : 'updated',
                calBefore:    curShowCal   ?? '(not set)',
                calAfter:     'true',
                notifBefore:  curProdNotif ?? '(not set)',
                notifAfter:   'Next Day',
                calChanged:   showCalChanged,
                notifChanged: prodNotifChanged,
              });
            } else {
              varLogs.push({ sku: '-', handle, status: 'skipped',
                message: 'Product showcalendar=true and vnotificationtitle=Next Day — no change' });
            }
          } else if (!productHasNextDay && !productCalendarWritten) {
            // ── Out-of-stock path: disable product calendar if currently enabled ──
            const curShowCal = existingProd['showcalendar'] ?? null;
            if (curShowCal === 'true') {
              productCalendarWritten = true;
              allMetafields.push({ ownerId: product.id, namespace: 'custom',
                key: 'showcalendar', value: 'false', type: 'boolean' });
              updatedCount++;
              varLogs.push({
                sku: '-', handle,
                status:    dryRun ? 'dry_run' : 'updated',
                calBefore: 'true',
                calAfter:  'false',
                message:   'All Next Day variants out of stock — product showcalendar set to false',
              });
            }
          }

          // ── Write phase (skipped in dry run) ─────────────────────────────
          if (!dryRun) {
            await writeMetafieldsBatched(client, allMetafields, varLogs, handle);
          }

          log.push(...varLogs);
          await sleep(dryRun ? 30 : 100);

        } catch (prodErr) {
          failed++;
          console.error(`  ✗ [calendar] Error on handle "${handle}":`, prodErr.message);
          log.push({ sku: '-', handle, status: 'failed', message: prodErr.message });
        }

        processed++;
        send({ type: 'progress', processed, totalProducts, updatedCount, skipped, failed });

        if (processed % 50 === 0 || processed === totalProducts) {
          console.log(`  … [calendar] ${processed}/${totalProducts} — updated:${updatedCount} skipped:${skipped} failed:${failed}`);
        }
      }

      console.log(`  ✓ [calendar] Done — updated:${updatedCount} skipped:${skipped} failed:${failed}`);
      send({ type: 'done', success: true, dryRun, updatedCount, skipped, failed, total: totalProducts, log });
      res.end();

    } catch (innerErr) {
      console.error('[calendar-sync] inner error:', innerErr.message);
      send({ type: 'done', success: false, error: `Server error: ${innerErr.message}`,
        dryRun, updatedCount, skipped, failed, total: totalProducts, log });
      res.end();
    } finally {
      cleanup();
    }

  } catch (err) {
    console.error('[calendar-sync] outer error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

module.exports = router;