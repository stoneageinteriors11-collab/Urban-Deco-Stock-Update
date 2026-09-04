const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const axios   = require('axios');
require('dotenv').config();

const { streamShopifyVariants } = require('../utils/parseCSV');
const { fetchCfsProducts, buildStockData, buildCompareData } = require('../utils/cfsApi');
const { compareVariants } = require('../utils/matchVariants');

const router = express.Router();

// ── Cancel flag ───────────────────────────────────────────────────────────────
// Simple module-level flag. The sync loop checks it each iteration.
// Resets to false at the start of every new sync.
let cancelRequested = false;

// ── POST /api/stock/cancel ────────────────────────────────────────────────────
router.post('/cancel', (req, res) => {
  cancelRequested = true;
  console.log('  ⛔ Stock sync cancel requested');
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

// ── Metafields-only query (no locationId required) ────────────────────────────
// Uses connection format (compatible with all API versions).
// Fetches the "custom" namespace and we filter keys client-side.
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

// ── Full query including inventory level (requires read_locations scope) ───────
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

// ── Bulk product fetch queries (used by /sync-api — no CSV upload needed) ─────

// Without inventory quantities (fallback when read_inventory scope is missing)
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

// With inventory quantities (requires read_inventory scope — added after re-auth)
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
  mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
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

// Accepts either connection format { edges: [{node}] } or plain array [{key,value}]
function metafieldMap(metafields) {
  const map = {};
  // Connection format returned by the updated queries
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

// Format a metafield diff in plain readable language
function diffStr(oldVal, newVal) {
  const old = oldVal ?? null;
  if (old === newVal) return `currently "${newVal}" (no change)`;
  if (old === null || old === '') return `not yet set — will set to "${newVal}"`;
  return `currently "${old}" — will change to "${newVal}"`;
}

// Format an inventory diff in plain readable language
function diffQty(currentQty, newQty) {
  if (currentQty === null) return `current value unknown — will set to ${newQty}`;
  if (currentQty === newQty) return `currently ${newQty} (no change)`;
  return `currently ${currentQty} — will set to ${newQty}`;
}

// ── POST /api/stock/sync ──────────────────────────────────────────────────────
//
// Required uploads: shopifyFile1
// Optional uploads: shopifyFile2
// Body field:       dryRun (boolean, default true)
//
// CFS stock data is fetched directly from the CFS API — no file uploads needed.
//
// Dry run  — always reads current metafields (old→new diff in log); no writes.
//            Inventory diff shown as "would set to X" if read_locations missing.
// Live run — tries to get location for inventory comparison; if read_locations
//            scope is missing, metafields are still synced, inventory is skipped
//            with a one-time warning in the log.
//
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
        return res.status(400).json({
          error: 'Please upload at least one Shopify export file.',
        });
      }

      const shopifyFile1Path = files.shopifyFile1[0].path;
      const shopifyFile2Path = files.shopifyFile2?.[0]?.path || null;

      uploadedPaths.push(shopifyFile1Path);
      if (shopifyFile2Path) uploadedPaths.push(shopifyFile2Path);

      // ── Fetch CFS stock data from API ─────────────────────────────────────
      console.log('▶ Stock sync — fetching CFS data from API…');
      const cfsProducts = await fetchCfsProducts();
      const { prodStockBySku, prodStockByProdId, varStockBySku, varStockByAttrId } =
        buildStockData(cfsProducts);
      console.log(`  ✓ ${cfsProducts.length} products from CFS API`);
      console.log(`  ✓ ${prodStockBySku.size} product stock records, ${varStockBySku.size} variant stock records`);

      // ── Parse Shopify exports ─────────────────────────────────────────────
      console.log('▶ Streaming Shopify export…');
      const shopifyVariants = await streamShopifyVariants(shopifyFile1Path);
      if (shopifyFile2Path) {
        const v2 = await streamShopifyVariants(shopifyFile2Path);
        shopifyVariants.push(...v2);
      }
      console.log(`  ✓ ${shopifyVariants.length} Shopify variants`);

      // ── Shopify client (always needed) ────────────────────────────────────
      let client       = null;
      let locationId   = null;   // null = read_locations scope missing
      let hasLocations = false;
      try {
        client = graphqlClient();
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      // Try to get location — needed both for dry-run qty comparison and live inventory writes.
      try {
        const locData = await gql(client, GET_LOCATIONS_QUERY);
        const locs    = (locData?.locations?.edges || []).map(e => e.node);
        console.log(`  ℹ Locations found: ${locs.map(l => `"${l.name}"`).join(', ') || 'none'}`);
        const loc     = locs.find(l => /^shop$/i.test(l.name))
                     || locs.find(l => /shop|warehouse|main/i.test(l.name))
                     || locs[0];
        if (loc) {
          locationId   = loc.id;
          hasLocations = true;
          console.log(`  ✓ Using location: "${loc.name}" (${loc.id})`);
        } else {
          console.warn('  ⚠ No locations returned by Shopify — inventory sync will be skipped');
        }
      } catch (locErr) {
        const locErrMsg = locErr.response?.data
          ? JSON.stringify(locErr.response.data)
          : locErr.message;
        console.warn('  ⚠ Location fetch failed:', locErrMsg);
      }

      // Reset cancel flag for this run
      cancelRequested = false;

      // ── SSE setup ─────────────────────────────────────────────────────────
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (res.socket) res.socket.setNoDelay(true);
      res.flushHeaders();
      const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      const log = [];
      let newCount     = 0;
      let updatedCount = 0;
      let skipped      = 0;
      let failed       = 0;
      let processed    = 0;

      // Warn once in the log if inventory sync is unavailable
      if (!hasLocations) {
        log.push({ sku: '-', handle: '-', status: 'warning',
          message: 'Inventory sync disabled — token missing read_locations scope.\n' +
            'Fix: in Shopify Admin go to Settings → Apps & sales channels → find this app → Uninstall it.\n' +
            'Then click "Connect to Shopify" here to re-authorise and get a fresh token with the correct scopes.\n' +
            'inoutstock metafields will still be synced this run.' });
      }

      const byHandle = new Map();
      for (const v of shopifyVariants) {
        if (!byHandle.has(v.handle)) byHandle.set(v.handle, []);
        byHandle.get(v.handle).push(v);
      }
      const totalProducts = byHandle.size;
      console.log(`▶ Processing ${shopifyVariants.length} variants across ${totalProducts} products (dryRun=${dryRun}, inventory=${hasLocations ? 'yes' : 'no'})`);

      try { // outer try

      for (const [handle, variantsForProduct] of byHandle) {
        // Check cancel flag before each product
        if (cancelRequested) {
          console.log(`  ⛔ Sync cancelled at product ${processed + 1}/${totalProducts}`);
          send({ type: 'done', success: true, cancelled: true, dryRun,
            newCount, updatedCount, skipped, failed, total: shopifyVariants.length, log });
          res.end();
          return;
        }

        try {
          // ── Skip non-active Shopify products ───────────────────────────────
          const productStatus = (variantsForProduct[0].status || '').toLowerCase();
          if (productStatus && productStatus !== 'active') {
            skipped += variantsForProduct.length;
            log.push({ sku: variantsForProduct[0].variantSku, handle, status: 'skipped',
              message: `Shopify product is ${productStatus.toUpperCase()} — skipped (only ACTIVE products are synced)` });
            processed++;
            send({ type: 'progress', processed, totalProducts, newCount, updatedCount, skipped, failed });
            continue;
          }

          // Representative SKU used only for error log entries — all CFS data is
          // looked up per-variant inside the loop by exact Shopify SKU match.
          const repSku = variantsForProduct[0].variantSku;

          // ── Fetch current Shopify values ───────────────────────────────────
          // Always use the inventory query when we have a location so dry-run
          // can show the real current qty. Falls back to metafields-only when
          // locationId is null (read_locations scope missing).
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

          // ── Per-variant ────────────────────────────────────────────────────
          // Product-level inoutstock is written once, derived from the first variant
          // that has a CFS match (avoids needing a "representative SKU" for the product).
          let productInoutWritten = false;

          for (const shopNode of shopifyNodes) {
            const varSku = shopNode.sku;
            if (!varSku) continue;

            // Strict exact-SKU lookup: Shopify Variant SKU → CFS "Shopify SKU" column.
            // Variant feed first (full SKU e.g. UD-156928-16939645), then product feed
            // (product-level SKU e.g. UD-1243174 or UD-1243180). No fuzzy matching.
            const varStock     = varStockBySku.get(varSku);
            const varProdStock = varStock ? null : prodStockBySku.get(varSku);

            if (!varStock && !varProdStock) {
              skipped++;
              log.push({ sku: varSku, handle, status: 'skipped',
                message: 'No CFS stock data found for this variant SKU — skipped' });
              continue;
            }

            // Delivery time is always the source of truth — never trust vinOutStock directly
            const vDeliveryTime = varStock ? varStock.vNotificationTitle : varProdStock.deliveryTime;
            const vIsShortLead  = deliveryTimeIsShort(vDeliveryTime);
            const vInOutStock   = vIsShortLead ? 'IN STOCK' : 'OUT OF STOCK';

            // Product-level inoutstock: write once from the first matched variant
            if (!productInoutWritten) {
              productInoutWritten = true;
              const prodInoutCur = existingProd['inoutstock'] ?? null;
              if (prodInoutCur !== vInOutStock) {
                const prodMfToWrite = [{
                  ownerId: product.id, namespace: 'custom', key: 'inoutstock',
                  value: vInOutStock, type: 'single_line_text_field',
                }];
                if (!dryRun) {
                  const mfResult = await gql(client, METAFIELDS_SET_MUTATION, { metafields: prodMfToWrite });
                  const mfErrors = mfResult?.metafieldsSet?.userErrors || [];
                  if (mfErrors.length) {
                    log.push({ sku: varSku, handle, status: 'warning',
                      message: `Product metafield error: ${mfErrors.map(e => e.message).join(', ')}` });
                  }
                }
              }
            }

            const existingVar = metafieldMap(shopNode.metafields);
            // currentQty is null when locationId is missing (no read_locations scope)
            const invLevel    = shopNode.inventoryItem?.inventoryLevel;
            const currentQty  = invLevel?.quantities?.find(q => q.name === 'available')?.quantity ?? null;
            const invItemId   = shopNode.inventoryItem?.id;

            // ── Inoutstock metafield ──────────────────────────────────────
            const varMfToWrite  = [];
            const vInoutCur     = existingVar['inoutstock'] ?? null;
            const vInoutChanged = vInoutCur !== vInOutStock;
            if (vInoutChanged) {
              varMfToWrite.push({
                ownerId: shopNode.id, namespace: 'custom', key: 'inoutstock',
                value: vInOutStock, type: 'single_line_text_field',
              });
            }

            // ── Inventory quantity logic ──────────────────────────────────
            // OUT OF STOCK: always set qty to 0
            // IN STOCK:     set qty to 2 ONLY if currently 0; otherwise no change
            let targetQty;
            let shouldWriteInv;
            if (!vIsShortLead) {
              // OUT OF STOCK
              targetQty    = 0;
              shouldWriteInv = locationId !== null && currentQty !== 0;
            } else {
              // IN STOCK
              if (currentQty === 0) {
                targetQty    = 2;
                shouldWriteInv = locationId !== null;
              } else {
                // qty > 0 or unknown — do not touch inventory
                targetQty    = currentQty;
                shouldWriteInv = false;
              }
            }

            // ── Live: write if changed ─────────────────────────────────────
            if (!dryRun) {
              if (varMfToWrite.length > 0) {
                const vmfResult = await gql(client, METAFIELDS_SET_MUTATION, { metafields: varMfToWrite });
                const vmfErrors = vmfResult?.metafieldsSet?.userErrors || [];
                if (vmfErrors.length) {
                  log.push({ sku: varSku, handle, status: 'warning',
                    message: `Variant metafield error: ${vmfErrors.map(e => e.message).join(', ')}` });
                }
              }

              if (invItemId && locationId && shouldWriteInv) {
                const invResult = await gql(client, INVENTORY_SET_MUTATION, {
                  input: {
                    name: 'available', reason: 'correction',
                    quantities: [{ inventoryItemId: invItemId, locationId, quantity: targetQty }],
                  },
                });
                const invErrors = invResult?.inventorySetQuantities?.userErrors || [];
                if (invErrors.length) {
                  log.push({ sku: varSku, handle, status: 'warning',
                    message: `Inventory set error: ${invErrors.map(e => e.message).join(', ')}` });
                }
              }
            }

            // ── Build log entry ────────────────────────────────────────────
            const anyChanged = vInoutChanged || shouldWriteInv;

            if (!anyChanged && currentQty !== null) {
              // Everything already correct and we could verify — truly skipped
              skipped++;
              log.push({ sku: varSku, handle, status: 'skipped',
                message: `All values already correct — no changes needed\n` +
                  `  inoutstock: "${vInOutStock}" (no change)\n` +
                  `  qty:        ${currentQty} (no change)`,
              });
            } else {
              const isNew  = vInoutCur === null || currentQty === null;
              const status = dryRun ? 'dry_run' : (isNew ? 'new' : 'updated');
              const rule   = `${vIsShortLead ? 'IN STOCK' : 'OUT OF STOCK'} (delivery: "${vDeliveryTime || 'n/a'}")`;

              const lines = [`Rule: ${rule}`];
              lines.push(`  inoutstock: ${diffStr(vInoutCur, vInOutStock)}`);

              // Inventory line
              if (locationId !== null) {
                if (!vIsShortLead) {
                  // OUT OF STOCK: always targeting 0
                  lines.push(`  qty:        ${diffQty(currentQty, 0)}`);
                } else if (currentQty === 0) {
                  // IN STOCK and was 0 → set to 2
                  lines.push(`  qty:        currently 0 — will set to 2`);
                } else {
                  // IN STOCK and already > 0 → no change
                  lines.push(`  qty:        currently ${currentQty} (no change — already > 0)`);
                }
              } else {
                // No read_locations scope
                if (!vIsShortLead) {
                  lines.push(`  qty:        would set to 0 — reconnect Shopify via OAuth to enable inventory reads`);
                } else {
                  lines.push(`  qty:        would set to 2 if currently 0 — reconnect Shopify via OAuth to enable inventory reads`);
                }
              }

              if (!dryRun) {
                if (isNew) newCount++; else updatedCount++;
              } else {
                if (isNew) newCount++; else updatedCount++;
              }

              log.push({ sku: varSku, handle, status, message: lines.join('\n') });
            }
          }

          await sleep(dryRun ? 100 : 250);

        } catch (prodErr) {
          failed++;
          console.error(`  ✗ Error on handle "${handle}":`, prodErr.message);
          log.push({ sku: '-', handle, status: 'failed', message: prodErr.message });
        }

        processed++;
        send({ type: 'progress', processed, totalProducts, newCount, updatedCount, skipped, failed });

        if (processed % 50 === 0 || processed === totalProducts) {
          console.log(`  … ${processed}/${totalProducts} — new: ${newCount}, updated: ${updatedCount}, skipped: ${skipped}, failed: ${failed}`);
        }
      }

      } catch (outerErr) {
        console.error(`  ✗ Unexpected error at product ${processed}/${totalProducts}:`, outerErr.message);
        send({ type: 'done', success: false, error: `Server error: ${outerErr.message}`,
          dryRun, newCount, updatedCount, skipped, failed, total: shopifyVariants.length, log });
        res.end();
        return;
      }

      console.log(`  ✓ Stock sync done — new: ${newCount}, updated: ${updatedCount}, skipped: ${skipped}, failed: ${failed}`);
      send({ type: 'done', success: true, dryRun, newCount, updatedCount, skipped, failed, total: shopifyVariants.length, log });
      res.end();

    } catch (err) {
      console.error('Stock sync error:', err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.end();
    } finally {
      uploadedPaths.forEach(tryUnlink);
    }
  }
);

// ── POST /api/stock/sync-api ──────────────────────────────────────────────────
//
// API-driven sync — fetches Shopify product data directly (no CSV upload).
// Streams SSE in two phases:
//   Phase 1 — Fetch CFS + location + all Shopify products (paginated)
//   Phase 2 — Compare with CFS and write updates (same logic as /sync)
//
// Requires read_inventory scope for inventory qty. Without it metafields still
// sync and a one-time warning is shown in the log.
//
// Render keep-alive: sends SSE comment pings every 15s to prevent timeout.
//
router.post('/sync-api', async (req, res) => {
  try {
    const dryRun = req.body?.dryRun !== 'false' && req.body?.dryRun !== false;

    let client;
    try { client = graphqlClient(); }
    catch (err) { return res.status(400).json({ error: err.message }); }

    // ── SSE headers — open stream immediately (keeps Render connection alive) ──
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.socket) res.socket.setNoDelay(true);
    res.flushHeaders();

    const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // Keepalive ping every 15 s — prevents Render from closing idle connections
    const keepalive = setInterval(() => res.write(': ping\n\n'), 15000);
    const cleanup   = () => clearInterval(keepalive);

    try {
      cancelRequested = false;

      // ── Phase 1a: CFS stock data ──────────────────────────────────────────
      send({ type: 'status', phase: 'cfs', message: 'Fetching CFS stock data…' });
      const cfsProducts = await fetchCfsProducts();
      const { prodStockBySku, varStockBySku } = buildStockData(cfsProducts);
      send({ type: 'status', phase: 'cfs-done',
        message: `CFS: ${cfsProducts.length} products, ${varStockBySku.size} variant records` });

      // ── Phase 1b: Shopify location ────────────────────────────────────────
      let locationId   = null;
      let hasLocations = false;
      send({ type: 'status', phase: 'location', message: 'Fetching Shopify location…' });
      try {
        const locData = await gql(client, GET_LOCATIONS_QUERY);
        const locs    = (locData?.locations?.edges || []).map(e => e.node);
        console.log(`  ℹ Locations: ${locs.map(l => `"${l.name}"`).join(', ') || 'none'}`);
        const loc     = locs.find(l => /^shop$/i.test(l.name))
                     || locs.find(l => /shop|warehouse|main/i.test(l.name))
                     || locs[0];
        if (loc) {
          locationId   = loc.id;
          hasLocations = true;
          send({ type: 'status', phase: 'location-done',
            message: `Location: "${loc.name}"` });
        } else {
          send({ type: 'status', phase: 'location-warn',
            message: 'No location found — inventory sync will be skipped' });
        }
      } catch (locErr) {
        send({ type: 'status', phase: 'location-warn',
          message: 'Location fetch failed — inventory sync will be skipped' });
      }

      // ── Phase 1c: Paginated Shopify product fetch ─────────────────────────
      send({ type: 'status', phase: 'shopify-fetch', message: 'Fetching Shopify products…' });

      const byHandle = new Map();      // handle → product GraphQL node
      let   cursor   = null;
      const PAGE     = 50;             // safe limit for nested variant data
      const QUERY    = locationId
        ? GET_PRODUCTS_BULK_QUERY_WITH_INV
        : GET_PRODUCTS_BULK_QUERY;

      while (true) {
        if (cancelRequested) {
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

        const fetched = byHandle.size;
        send({ type: 'fetch-progress', fetched, hasMore: page.pageInfo.hasNextPage });
        console.log(`  📦 Fetched ${fetched} products so far…`);

        if (!page.pageInfo.hasNextPage) break;
        cursor = page.pageInfo.endCursor;
        await sleep(200); // stay within 2 req/s burst budget
      }

      const totalProducts = byHandle.size;
      send({ type: 'fetch-done', total: totalProducts });
      console.log(`  ✅ Done fetching — ${totalProducts} Shopify products total (dryRun=${dryRun}, inventory=${hasLocations})`);

      // ── Phase 2: Sync ─────────────────────────────────────────────────────
      const log = [];
      let newCount = 0, updatedCount = 0, skipped = 0, failed = 0, processed = 0;

      if (!hasLocations) {
        log.push({ sku: '-', handle: '-', status: 'warning',
          message: 'Inventory sync disabled — token is missing read_locations or read_inventory scope.\n' +
            'Fix: Disconnect then reconnect Shopify (OAuth) to get an updated token with all scopes.' });
      }

      for (const [handle, product] of byHandle) {
        if (cancelRequested) {
          send({ type: 'done', success: true, cancelled: true, dryRun,
            newCount, updatedCount, skipped, failed, total: totalProducts, log });
          cleanup(); res.end(); return;
        }

        try {
          // Skip non-active products
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
          let   productInoutWritten = false;

          for (const shopNode of shopifyNodes) {
            const varSku = shopNode.sku;
            if (!varSku) continue;

            const varStock     = varStockBySku.get(varSku);
            const varProdStock = varStock ? null : prodStockBySku.get(varSku);

            if (!varStock && !varProdStock) {
              skipped++;
              log.push({ sku: varSku, handle, status: 'skipped',
                message: 'No CFS stock data found for this variant SKU — skipped' });
              continue;
            }

            const vDeliveryTime = varStock ? varStock.vNotificationTitle : varProdStock.deliveryTime;
            const vIsShortLead  = deliveryTimeIsShort(vDeliveryTime);
            const vInOutStock   = vIsShortLead ? 'IN STOCK' : 'OUT OF STOCK';

            // Product-level inoutstock — write once from first matched variant
            if (!productInoutWritten) {
              productInoutWritten = true;
              const prodInoutCur = existingProd['inoutstock'] ?? null;
              if (prodInoutCur !== vInOutStock && !dryRun) {
                const mfResult = await gql(client, METAFIELDS_SET_MUTATION, {
                  metafields: [{ ownerId: product.id, namespace: 'custom', key: 'inoutstock',
                    value: vInOutStock, type: 'single_line_text_field' }],
                });
                const mfErrors = mfResult?.metafieldsSet?.userErrors || [];
                if (mfErrors.length) {
                  log.push({ sku: varSku, handle, status: 'warning',
                    message: `Product metafield error: ${mfErrors.map(e => e.message).join(', ')}` });
                }
              }
            }

            const existingVar  = metafieldMap(shopNode.metafields);
            const invLevel     = shopNode.inventoryItem?.inventoryLevel;
            const currentQty   = invLevel?.quantities?.find(q => q.name === 'available')?.quantity ?? null;
            const invItemId    = shopNode.inventoryItem?.id;

            // Variant inoutstock metafield
            const varMfToWrite  = [];
            const vInoutCur     = existingVar['inoutstock'] ?? null;
            const vInoutChanged = vInoutCur !== vInOutStock;
            if (vInoutChanged) {
              varMfToWrite.push({ ownerId: shopNode.id, namespace: 'custom', key: 'inoutstock',
                value: vInOutStock, type: 'single_line_text_field' });
            }

            // Inventory quantity logic
            let targetQty, shouldWriteInv;
            if (!vIsShortLead) {
              targetQty      = 0;
              shouldWriteInv = locationId !== null && currentQty !== 0;
            } else {
              if (currentQty === 0) {
                targetQty      = 2;
                shouldWriteInv = locationId !== null;
              } else {
                targetQty      = currentQty;
                shouldWriteInv = false;
              }
            }

            // Live writes
            if (!dryRun) {
              if (varMfToWrite.length > 0) {
                const vmfResult = await gql(client, METAFIELDS_SET_MUTATION, { metafields: varMfToWrite });
                const vmfErrors = vmfResult?.metafieldsSet?.userErrors || [];
                if (vmfErrors.length) {
                  log.push({ sku: varSku, handle, status: 'warning',
                    message: `Variant metafield error: ${vmfErrors.map(e => e.message).join(', ')}` });
                }
              }
              if (invItemId && locationId && shouldWriteInv) {
                const invResult = await gql(client, INVENTORY_SET_MUTATION, {
                  input: { name: 'available', reason: 'correction',
                    quantities: [{ inventoryItemId: invItemId, locationId, quantity: targetQty }] },
                });
                const invErrors = invResult?.inventorySetQuantities?.userErrors || [];
                if (invErrors.length) {
                  log.push({ sku: varSku, handle, status: 'warning',
                    message: `Inventory set error: ${invErrors.map(e => e.message).join(', ')}` });
                }
              }
            }

            // Build log entry
            const anyChanged = vInoutChanged || shouldWriteInv;

            if (!anyChanged && currentQty !== null) {
              skipped++;
              log.push({ sku: varSku, handle, status: 'skipped',
                message: `All values already correct — no changes needed\n` +
                  `  inoutstock: "${vInOutStock}" (no change)\n` +
                  `  qty:        ${currentQty} (no change)` });
            } else {
              const isNew  = vInoutCur === null || currentQty === null;
              const status = dryRun ? 'dry_run' : (isNew ? 'new' : 'updated');
              const rule   = `${vIsShortLead ? 'IN STOCK' : 'OUT OF STOCK'} (delivery: "${vDeliveryTime || 'n/a'}")`;

              const lines = [`Rule: ${rule}`];
              lines.push(`  inoutstock: ${diffStr(vInoutCur, vInOutStock)}`);

              if (locationId !== null) {
                if (!vIsShortLead)        lines.push(`  qty:        ${diffQty(currentQty, 0)}`);
                else if (currentQty === 0) lines.push(`  qty:        currently 0 — will set to 2`);
                else                      lines.push(`  qty:        currently ${currentQty} (no change — already > 0)`);
              } else {
                lines.push(`  qty:        inventory reads disabled — reconnect Shopify to enable`);
              }

              if (isNew) newCount++; else updatedCount++;
              log.push({ sku: varSku, handle, status, message: lines.join('\n') });
            }
          } // end per-variant

          await sleep(dryRun ? 50 : 200);

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
      send({ type: 'done', success: true, dryRun,
        newCount, updatedCount, skipped, failed, total: totalProducts, log });

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
// API-mode compare: fetches Shopify products via GraphQL instead of CSV upload.
// Returns the same JSON structure as POST /api/compare (upload.js).
router.post('/compare-api', async (req, res) => {
  try {
    const client = graphqlClient();

    // 1. CFS data
    console.log('▶ [compare-api] Fetching CFS product data…');
    const cfsProducts = await fetchCfsProducts();
    const {
      validProductSKUs,
      cfsProductIds,
      validVariantSKUs,
      cfsVariantAttrIds,
      productCodesBySku,
      productCodesByProdId,
      cfsProductCodeToStatus,
      variantCodesBySku,
      variantCodesByAttrId,
      cfsVarCodeSet,
    } = buildCompareData(cfsProducts);
    console.log(`  ✓ ${validProductSKUs.size} product SKUs, ${validVariantSKUs.size} variant SKUs`);

    // 2. Fetch Shopify products via API (no inventory needed for compare)
    console.log('▶ [compare-api] Fetching Shopify products…');
    const byHandle = new Map();
    let cursor = null;
    const PAGE = 50;

    while (true) {
      const vars = { first: PAGE, query: 'vendor:"Urban Deco"' };
      if (cursor) vars.after = cursor;
      const data = await gql(client, GET_PRODUCTS_BULK_QUERY, vars);
      const page = data?.products;
      if (!page) break;
      for (const edge of (page.edges || [])) {
        if (edge.node?.handle) byHandle.set(edge.node.handle, edge.node);
      }
      console.log(`  📦 Fetched ${byHandle.size} products so far…`);
      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
      await sleep(200);
    }
    console.log(`  ✅ ${byHandle.size} Shopify products fetched`);

    // 3. Map GraphQL nodes → shopifyVariants shape expected by compareVariants()
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
          handle:             product.handle,
          title:              product.title || '',
          variantSku:         variant.sku,
          option1:            '',
          option2:            '',
          barcode:            '',
          inventoryQty:       '',
          status,
          shopifyVariantCode: getMeta(variantMeta, 'variant_code'),
          shopifyProductCode,
        });
      }
    }
    console.log(`  ✓ ${shopifyVariants.length} variants mapped`);

    // 4. Compare
    console.log('▶ [compare-api] Running comparison…');
    const { results, summary } = compareVariants(
      shopifyVariants, validVariantSKUs, validProductSKUs, cfsProductIds, cfsVariantAttrIds,
      productCodesBySku, productCodesByProdId, variantCodesBySku, variantCodesByAttrId,
      cfsVarCodeSet, cfsProductCodeToStatus,
    );
    console.log(`  ✓ ${summary.orphaned} orphaned, ${summary.ok} OK, ${summary.draft} draft, ${summary.cfsInactive} cfs-inactive, ${summary.cfsProduct} cfs-product`);

    res.json({
      success:          true,
      results,
      summary,
      cfsProductIds:    [...cfsProductIds.entries()],
      cfsVariantAttrIds:[...cfsVariantAttrIds],
    });

  } catch (err) {
    console.error('[compare-api] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;