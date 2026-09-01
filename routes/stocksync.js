const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const axios   = require('axios');
require('dotenv').config();

const {
  streamShopifyVariants,
  streamProductStockData,
  streamVariantStockData,
} = require('../utils/parseCSV');

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
                available
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

// Format a metafield diff: "old" → "new", (not set) → "new", or "val" (no change)
function diffStr(oldVal, newVal) {
  const old = oldVal ?? null;
  if (old === newVal) return `"${newVal}" (no change)`;
  if (old === null || old === '') return `(not set) → "${newVal}"`;
  return `"${old}" → "${newVal}"`;
}

// Format an inventory diff. currentQty=null means unknown (no read_locations scope).
function diffQty(currentQty, newQty) {
  if (currentQty === null) return `(unknown) → ${newQty}`;
  if (currentQty === newQty) return `${newQty} (no change)`;
  return `${currentQty} → ${newQty}`;
}

// ── POST /api/stock/sync ──────────────────────────────────────────────────────
//
// Required uploads: productFeed, shopifyFile1
// Optional uploads: variantFeed, shopifyFile2
// Body field:       dryRun (boolean, default true)
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
    { name: 'productFeed',  maxCount: 1 },
    { name: 'variantFeed',  maxCount: 1 },
    { name: 'shopifyFile1', maxCount: 1 },
    { name: 'shopifyFile2', maxCount: 1 },
  ]),
  async (req, res) => {
    const uploadedPaths = [];

    try {
      const files  = req.files || {};
      const dryRun = req.body?.dryRun !== 'false' && req.body?.dryRun !== false;

      if (!files.productFeed || !files.shopifyFile1) {
        return res.status(400).json({
          error: 'Please upload the CFS product feed and at least one Shopify export file.',
        });
      }

      const productFeedPath  = files.productFeed[0].path;
      const variantFeedPath  = files.variantFeed?.[0]?.path || null;
      const shopifyFile1Path = files.shopifyFile1[0].path;
      const shopifyFile2Path = files.shopifyFile2?.[0]?.path || null;

      uploadedPaths.push(productFeedPath, shopifyFile1Path);
      if (variantFeedPath)  uploadedPaths.push(variantFeedPath);
      if (shopifyFile2Path) uploadedPaths.push(shopifyFile2Path);

      // ── Parse CFS feeds ───────────────────────────────────────────────────
      console.log('▶ Stock sync — parsing feeds…');
      const { bySku: prodStockBySku, byProdId: prodStockByProdId } =
        await streamProductStockData(productFeedPath);
      console.log(`  ✓ ${prodStockBySku.size} product stock records`);

      let varStockBySku    = new Map();
      let varStockByAttrId = new Map();
      if (variantFeedPath) {
        const vs = await streamVariantStockData(variantFeedPath);
        varStockBySku    = vs.bySku;
        varStockByAttrId = vs.byAttrId;
        console.log(`  ✓ ${varStockBySku.size} variant stock records`);
      }

      // ── Parse Shopify exports ─────────────────────────────────────────────
      console.log('▶ Streaming Shopify export…');
      const shopifyVariants = await streamShopifyVariants(shopifyFile1Path);
      if (shopifyFile2Path) {
        const v2 = await streamShopifyVariants(shopifyFile2Path);
        shopifyVariants.push(...v2);
      }
      console.log(`  ✓ ${shopifyVariants.length} Shopify variants`);

      // ── Shopify client (always needed) ────────────────────────────────────
      let client     = null;
      let locationId = null;      // null = read_locations scope missing
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
        const loc     = locs.find(l => /^shop$/i.test(l.name))
                     || locs.find(l => /shop|warehouse|main/i.test(l.name))
                     || locs[0];
        if (loc) {
          locationId   = loc.id;
          hasLocations = true;
          console.log(`  ✓ Location: "${loc.name}" (${loc.id})`);
        } else {
          console.warn('  ⚠ No locations found — inventory sync will be skipped');
        }
      } catch (locErr) {
        // read_locations scope missing — metafields will still sync, inventory skipped
        console.warn('  ⚠ Cannot read locations (missing read_locations scope) — inventory sync will be skipped');
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
      if (!dryRun && !hasLocations) {
        log.push({ sku: '-', handle: '-', status: 'warning',
          message: 'Inventory sync skipped — Shopify access token is missing the read_locations scope. Metafields will still be synced.' });
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
          // ── CFS stock lookup ───────────────────────────────────────────────
          const repSku     = variantsForProduct[0].variantSku;
          const { prodId } = parseSku(repSku);
          const prodStock  = prodStockBySku.get(repSku)
                          || (prodId ? prodStockByProdId.get(prodId) : null);

          if (!prodStock) {
            skipped += variantsForProduct.length;
            log.push({ sku: repSku, handle, status: 'skipped',
              message: `No CFS stock data found — skipping (${variantsForProduct.length} variant(s))` });
            processed++;
            send({ type: 'progress', processed, totalProducts, newCount, updatedCount, skipped, failed });
            continue;
          }

          const { deliveryTime, inOutStock, onHand, dueDate } = prodStock;
          const isShortLead = deliveryTimeIsShort(deliveryTime);
          const stockStatus = isShortLead ? (inOutStock || 'In Stock') : 'Out Of Stock';

          // ── Fetch current Shopify values ───────────────────────────────────
          // Dry run  → metafields-only query (no locationId, no read_locations needed)
          // Live     → full query with inventory level (if locationId available)
          //            falls back to metafields-only if locationId is null
          let productData;
          if (locationId) {
            // Use the inventory query whenever we have a location — reads current qty for dry run diffs too
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

          // ── Product-level metafields ───────────────────────────────────────
          const prodMfToWrite = [];
          function checkProd(key, newValue) {
            const cur     = existingProd[key] ?? null;
            const changed = cur !== newValue;
            if (changed) {
              prodMfToWrite.push({
                ownerId: product.id, namespace: 'custom', key,
                value: newValue, type: 'single_line_text_field',
              });
            }
            return { cur, newValue, changed, isNew: cur === null };
          }
          checkProd('inoutstock', stockStatus);
          checkProd('duedate',    dueDate || '');

          if (!dryRun && prodMfToWrite.length > 0) {
            const mfResult = await gql(client, METAFIELDS_SET_MUTATION, { metafields: prodMfToWrite });
            const mfErrors = mfResult?.metafieldsSet?.userErrors || [];
            if (mfErrors.length) {
              log.push({ sku: repSku, handle, status: 'warning',
                message: `Product metafield error: ${mfErrors.map(e => e.message).join(', ')}` });
            }
          }

          // ── Per-variant ────────────────────────────────────────────────────
          for (const shopNode of shopifyNodes) {
            const varSku = shopNode.sku;
            if (!varSku) continue;

            const { varId }   = parseSku(varSku);
            const varStock    = varStockBySku.get(varSku)
                             || (varId ? varStockByAttrId.get(varId) : null);

            const vNotifTitle   = varStock?.vNotificationTitle || '';
            const vOnHand       = varStock ? varStock.vOnHand : onHand;
            const vDueDate      = varStock?.vDueDate   || dueDate;
            const vInOutStock   = varStock?.vinOutStock || stockStatus;
            const effVariantQty = isShortLead ? Math.max(vOnHand, 2) : 0;

            const existingVar = metafieldMap(shopNode.metafields);
            // currentQty is null when using metafields-only query (dry run or no scope)
            const currentQty  = shopNode.inventoryItem?.inventoryLevel?.available ?? null;
            const invItemId   = shopNode.inventoryItem?.id;

            // Compare metafields
            const varMfToWrite = [];
            function checkVar(key, newValue) {
              const cur     = existingVar[key] ?? null;
              const changed = cur !== newValue;
              if (changed) {
                varMfToWrite.push({
                  ownerId: shopNode.id, namespace: 'custom', key,
                  value: newValue, type: 'single_line_text_field',
                });
              }
              return { cur, newValue, changed, isNew: cur === null };
            }

            const v_inout = checkVar('inoutstock',         vInOutStock);
            const v_due   = checkVar('duedate',            vDueDate || '');
            const v_notif = vNotifTitle
              ? checkVar('vnotificationtitle', vNotifTitle)
              : { cur: existingVar['vnotificationtitle'] ?? null, newValue: null, changed: false, isNew: false };

            // Inventory: only compare if we have the current qty (live + locationId)
            const qtyChanged = locationId !== null && currentQty !== effVariantQty;

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

              if (invItemId && locationId && qtyChanged) {
                const invResult = await gql(client, INVENTORY_SET_MUTATION, {
                  input: {
                    name: 'available', reason: 'correction',
                    quantities: [{ inventoryItemId: invItemId, locationId, quantity: effVariantQty }],
                  },
                });
                const invErrors = invResult?.inventorySetQuantities?.userErrors || [];
                if (invErrors.length) {
                  log.push({ sku: varSku, handle, status: 'warning',
                    message: `Inventory set error: ${invErrors.map(e => e.message).join(', ')}` });
                }
              }
            }

            // ── Build log entry with old→new diffs ─────────────────────────
            const anyMfChanged  = v_inout.changed || v_due.changed || v_notif.changed;
            const anyInvChanged = qtyChanged;
            const anyChanged    = anyMfChanged || anyInvChanged;

            if (!anyChanged && currentQty !== null) {
              // Everything matches (and we could verify qty) — truly skipped
              skipped++;
              log.push({ sku: varSku, handle, status: 'skipped',
                message: 'All values already correct — no changes needed\n' +
                  `  inoutstock:  "${vInOutStock}" (no change)\n` +
                  `  duedate:     "${vDueDate || ''}" (no change)\n` +
                  `  qty:         ${currentQty} (no change)` +
                  (vNotifTitle ? `\n  vnotificationtitle: "${vNotifTitle}" (no change)` : ''),
              });
            } else {
              const isNew    = v_inout.isNew || v_due.isNew || (vNotifTitle && v_notif.isNew) || currentQty === null;
              const status   = dryRun ? 'dry_run' : (isNew ? 'new' : 'updated');
              const rule     = `${isShortLead ? 'IN STOCK' : 'OUT OF STOCK'} (delivery: "${deliveryTime || 'n/a'}")`;

              const lines = [`Rule: ${rule}`];
              lines.push(`  inoutstock:  ${diffStr(v_inout.cur, vInOutStock)}`);
              lines.push(`  duedate:     ${diffStr(v_due.cur,   vDueDate || '')}`);

              // Inventory line — show "(no read_locations scope)" when we can't compare
              if (locationId !== null) {
                lines.push(`  qty:         ${diffQty(currentQty, effVariantQty)}`);
              } else {
                lines.push(`  qty:         would set to ${effVariantQty} (current value unknown — read_locations scope missing)`);
              }

              // Only log vnotificationtitle when the CFS feed provides a value for this variant.
              // If vNotifTitle is empty (variant not in feed / no variant feed uploaded),
              // no write is queued so don't show a misleading "→ ''" line.
              if (vNotifTitle) {
                lines.push(`  vnotificationtitle: ${diffStr(v_notif.cur, vNotifTitle)}`);
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

module.exports = router;