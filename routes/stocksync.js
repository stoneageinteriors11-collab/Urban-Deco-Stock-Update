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
  const version = process.env.SHOPIFY_API_VERSION || '2024-04';
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

// ── Queries & mutations ───────────────────────────────────────────────────────

const GET_LOCATIONS_QUERY = `
  query getLocations {
    locations(first: 10) {
      edges { node { id name } }
    }
  }
`;

// Fetch product + all variants with inventoryItem IDs for inventory writes.
const GET_PRODUCT_STOCK_QUERY = `
  query getProductStock($handle: String!) {
    productByHandle(handle: $handle) {
      id
      title
      variants(first: 250) {
        edges {
          node {
            id
            sku
            inventoryItem { id }
          }
        }
      }
    }
  }
`;

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

// ── SKU parser ────────────────────────────────────────────────────────────────
function parseSku(sku) {
  const parts = sku.split('-');
  return { prodId: parts[1] || null, varId: parts[2] || null };
}

// ── Delivery time parser ──────────────────────────────────────────────────────
// Returns true if the UPPER bound of the delivery window is ≤ 6 weeks.
// Handles strings like:
//   "4-6 weeks", "2-3 weeks", "1 week", "7-8 weeks", "In Stock", "Call"
function deliveryTimeIsShort(deliveryTime) {
  if (!deliveryTime) return false;
  const lower = deliveryTime.trim().toLowerCase();

  // Explicit in-stock / immediate signals
  if (lower === 'in stock' || lower === '' || lower === 'call') return true;

  // Match patterns like "4-6 weeks", "2 weeks", "1 week"
  // We look at the UPPER number (e.g. 6 in "4-6") to be conservative.
  const rangeMatch  = lower.match(/(\d+)\s*[-–]\s*(\d+)\s*weeks?/i);
  const singleMatch = lower.match(/^(\d+)\s*weeks?/i);

  if (rangeMatch) {
    const upperWeeks = parseInt(rangeMatch[2], 10);
    return upperWeeks <= 6;
  }
  if (singleMatch) {
    const weeks = parseInt(singleMatch[1], 10);
    return weeks <= 6;
  }

  // Days handling: "14 days", "30 days"
  const daysMatch = lower.match(/(\d+)\s*days?/i);
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    return days <= 42; // 6 weeks in days
  }

  return false; // unknown format → treat as long lead time (out of stock)
}

// ── POST /api/stock/sync ──────────────────────────────────────────────────────
//
// Required uploads: productFeed, shopifyFile1
// Optional uploads: variantFeed, shopifyFile2
// Body field:       dryRun (boolean, default true)
//
// For each Shopify product / variant:
//   1. Look up CFS stock data by SKU, then by prodId / attrId as fallback
//   2. Apply delivery time rule:
//      - deliveryTime ≤ 6 weeks  → IN STOCK  (if onHand = 0, set to 2)
//      - deliveryTime  > 6 weeks → OUT OF STOCK (qty = 0)
//   3. Write metafields: custom.inoutstock, custom.vnotificationtitle, custom.duedate
//   4. Set inventory quantity at the "Shop" location
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
      const files   = req.files || {};
      const dryRun  = req.body?.dryRun !== 'false' && req.body?.dryRun !== false;

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

      // 1. Parse CFS feeds
      console.log('▶ Stock sync — parsing feeds…');
      const { bySku: prodStockBySku, byProdId: prodStockByProdId } =
        await streamProductStockData(productFeedPath);
      console.log(`  ✓ ${prodStockBySku.size} product stock records`);

      let varStockBySku   = new Map();
      let varStockByAttrId = new Map();
      if (variantFeedPath) {
        const vs = await streamVariantStockData(variantFeedPath);
        varStockBySku    = vs.bySku;
        varStockByAttrId = vs.byAttrId;
        console.log(`  ✓ ${varStockBySku.size} variant stock records`);
      }

      // 2. Parse Shopify export(s) — gives us handles + SKUs
      console.log('▶ Streaming Shopify export…');
      const shopifyVariants = await streamShopifyVariants(shopifyFile1Path);
      if (shopifyFile2Path) {
        const v2 = await streamShopifyVariants(shopifyFile2Path);
        shopifyVariants.push(...v2);
      }
      console.log(`  ✓ ${shopifyVariants.length} Shopify variants`);

      // 3. Get Shopify client; find Shop location ID (unless dry run)
      let client     = null;
      let locationId = null;
      try {
        client = graphqlClient();
        if (!dryRun) {
          const locData = await gql(client, GET_LOCATIONS_QUERY);
          const locs    = (locData?.locations?.edges || []).map(e => e.node);
          // Prefer location named "Shop" or "Online Store" or take the first one
          const loc = locs.find(l => /^shop$/i.test(l.name))
                   || locs.find(l => /shop|warehouse|main/i.test(l.name))
                   || locs[0];
          if (!loc) throw new Error('No Shopify location found for inventory updates.');
          locationId = loc.id;
          console.log(`  ✓ Inventory location: "${loc.name}" (${loc.id})`);
        }
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      // ── SSE setup ─────────────────────────────────────────────────────────
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (res.socket) res.socket.setNoDelay(true);
      res.flushHeaders();
      const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      const log = [];
      let synced  = 0;
      let skipped = 0;
      let failed  = 0;
      let processed = 0;

      // Group variants by handle — one Shopify API call per product
      const byHandle = new Map();
      for (const v of shopifyVariants) {
        if (!byHandle.has(v.handle)) byHandle.set(v.handle, []);
        byHandle.get(v.handle).push(v);
      }
      const totalProducts = byHandle.size;
      console.log(`▶ Processing ${shopifyVariants.length} variants across ${totalProducts} products (dryRun=${dryRun})`);

      try { // outer try

      for (const [handle, variantsForProduct] of byHandle) {
        try {
          // ── Find product-level CFS stock data ─────────────────────────────
          // Use the first variant's SKU / prodId as the product key
          const repVariant = variantsForProduct[0];
          const repSku     = repVariant.variantSku;
          const { prodId } = parseSku(repSku);

          const prodStock = prodStockBySku.get(repSku)
                         || (prodId ? prodStockByProdId.get(prodId) : null);

          if (!prodStock) {
            skipped += variantsForProduct.length;
            log.push({
              sku: repSku, handle, status: 'skipped',
              message: `No CFS stock data found for product — skipping (${variantsForProduct.length} variant(s))`,
            });
            processed++;
            send({ type: 'progress', processed, totalProducts, synced, skipped, failed });
            continue;
          }

          const { deliveryTime, inOutStock, onHand, dueDate } = prodStock;
          const isShortLead = deliveryTimeIsShort(deliveryTime);

          // Apply delivery time rule
          // IN STOCK:  isShortLead = true  → effective qty = max(onHand, 2), status = inOutStock || 'In Stock'
          // OUT OF STOCK: isShortLead = false → effective qty = 0
          const effectiveQty = isShortLead ? Math.max(onHand, 2) : 0;
          const stockStatus  = isShortLead ? (inOutStock || 'In Stock') : 'Out Of Stock';

          if (dryRun) {
            // ── DRY RUN: log what would be written ────────────────────────
            const productTitle = repVariant.title || handle;

            // Per-variant dry-run entry
            for (const v of variantsForProduct) {
              const { varId, prodId: vProdId } = parseSku(v.variantSku);

              // Variant-level CFS stock (optional)
              const varStock = varStockBySku.get(v.variantSku)
                            || (varId ? varStockByAttrId.get(varId) : null);
              const vNotifTitle = varStock?.vNotificationTitle || '';
              const vOnHand     = varStock ? varStock.vOnHand : onHand;
              const vDueDate    = varStock?.vDueDate    || dueDate;
              const vInOutStock = varStock?.vinOutStock || stockStatus;

              const effVariantQty = isShortLead ? Math.max(vOnHand, 2) : 0;

              log.push({
                sku: v.variantSku,
                handle,
                status: 'dry_run',
                message: [
                  `Would set stock for variant "${v.variantSku}" on "${productTitle}"`,
                  `  Delivery: ${deliveryTime || '(none)'} → ${isShortLead ? 'IN STOCK' : 'OUT OF STOCK'} rule`,
                  `  Qty: ${effVariantQty}`,
                  `  custom.inoutstock: "${vInOutStock}"`,
                  `  custom.duedate: "${vDueDate}"`,
                  vNotifTitle ? `  custom.vnotificationtitle: "${vNotifTitle}"` : null,
                ].filter(Boolean).join('\n'),
              });
              synced++;
            }

          } else {
            // ── LIVE: fetch Shopify product, write metafields + inventory ──

            // Fetch product with variant IDs + inventoryItem IDs
            const productData = await gql(client, GET_PRODUCT_STOCK_QUERY, { handle });
            const product     = productData?.productByHandle;
            if (!product) {
              failed++;
              log.push({ sku: repSku, handle, status: 'failed', message: `Product not found on Shopify` });
              processed++;
              send({ type: 'progress', processed, totalProducts, synced, skipped, failed });
              continue;
            }

            const shopifyNodes = product.variants.edges.map(e => e.node);

            // ── Product-level metafields ─────────────────────────────────
            const productMetafields = [
              {
                ownerId:   product.id,
                namespace: 'custom',
                key:       'inoutstock',
                value:     stockStatus,
                type:      'single_line_text_field',
              },
              {
                ownerId:   product.id,
                namespace: 'custom',
                key:       'duedate',
                value:     dueDate || '',
                type:      'single_line_text_field',
              },
            ];

            if (productMetafields.length > 0) {
              const mfResult    = await gql(client, METAFIELDS_SET_MUTATION, { metafields: productMetafields });
              const mfErrors    = mfResult?.metafieldsSet?.userErrors || [];
              if (mfErrors.length) {
                const errMsg = mfErrors.map(e => e.message).join(', ');
                log.push({ sku: repSku, handle, status: 'warning', message: `Product metafield error: ${errMsg}` });
              }
            }

            // ── Per-variant metafields + inventory ───────────────────────
            for (const shopNode of shopifyNodes) {
              const varSku = shopNode.sku;
              if (!varSku) continue;

              // Find the CFS variant stock data
              const { varId } = parseSku(varSku);
              const varStock  = varStockBySku.get(varSku)
                             || (varId ? varStockByAttrId.get(varId) : null);

              const vNotifTitle = varStock?.vNotificationTitle || '';
              const vOnHand     = varStock ? varStock.vOnHand : onHand;
              const vDueDate    = varStock?.vDueDate    || dueDate;
              const vInOutStock = varStock?.vinOutStock || stockStatus;
              const effVariantQty = isShortLead ? Math.max(vOnHand, 2) : 0;

              // Build variant metafields
              const variantMetafields = [
                {
                  ownerId:   shopNode.id,
                  namespace: 'custom',
                  key:       'inoutstock',
                  value:     vInOutStock,
                  type:      'single_line_text_field',
                },
                {
                  ownerId:   shopNode.id,
                  namespace: 'custom',
                  key:       'duedate',
                  value:     vDueDate || '',
                  type:      'single_line_text_field',
                },
              ];
              if (vNotifTitle) {
                variantMetafields.push({
                  ownerId:   shopNode.id,
                  namespace: 'custom',
                  key:       'vnotificationtitle',
                  value:     vNotifTitle,
                  type:      'single_line_text_field',
                });
              }

              // Write variant metafields
              const vmfResult = await gql(client, METAFIELDS_SET_MUTATION, { metafields: variantMetafields });
              const vmfErrors = vmfResult?.metafieldsSet?.userErrors || [];
              if (vmfErrors.length) {
                const errMsg = vmfErrors.map(e => e.message).join(', ');
                log.push({ sku: varSku, handle, status: 'warning', message: `Variant metafield error: ${errMsg}` });
              }

              // Write inventory quantity
              const invItemId = shopNode.inventoryItem?.id;
              if (invItemId && locationId) {
                const invResult = await gql(client, INVENTORY_SET_MUTATION, {
                  input: {
                    name:     'available',
                    reason:   'correction',
                    quantities: [{
                      inventoryItemId: invItemId,
                      locationId,
                      quantity: effVariantQty,
                    }],
                  },
                });
                const invErrors = invResult?.inventorySetQuantities?.userErrors || [];
                if (invErrors.length) {
                  const errMsg = invErrors.map(e => e.message).join(', ');
                  log.push({ sku: varSku, handle, status: 'warning', message: `Inventory set error: ${errMsg}` });
                }
              }

              synced++;
              log.push({
                sku:     varSku,
                handle,
                status:  'synced',
                message: `Set stock: qty=${effVariantQty}, inoutstock="${vInOutStock}", duedate="${vDueDate}"${vNotifTitle ? `, vnotificationtitle="${vNotifTitle}"` : ''} — ${isShortLead ? 'IN STOCK' : 'OUT OF STOCK'} (delivery: ${deliveryTime})`,
              });
            }

            // Small delay to respect rate limits
            await sleep(250);
          }

        } catch (prodErr) {
          failed++;
          console.error(`  ✗ Error on handle "${handle}":`, prodErr.message);
          log.push({ sku: '-', handle, status: 'failed', message: prodErr.message });
        }

        processed++;
        send({ type: 'progress', processed, totalProducts, synced, skipped, failed });

        if (processed % 50 === 0 || processed === totalProducts) {
          console.log(`  … ${processed}/${totalProducts} products processed — synced: ${synced}, skipped: ${skipped}, failed: ${failed}`);
        }
      }

      } catch (outerErr) {
        console.error(`  ✗ Unexpected error at product ${processed}/${totalProducts}:`, outerErr.message);
        send({ type: 'done', success: false, error: `Server error: ${outerErr.message}`, dryRun, synced, skipped, failed, total: shopifyVariants.length, log });
        res.end();
        return;
      }

      console.log(`  ✓ Stock sync done — synced: ${synced}, skipped: ${skipped}, failed: ${failed}`);
      send({ type: 'done', success: true, dryRun, synced, skipped, failed, total: shopifyVariants.length, log });
      res.end();

    } catch (err) {
      console.error('Stock sync error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      } else {
        res.end();
      }
    } finally {
      uploadedPaths.forEach(tryUnlink);
    }
  }
);

module.exports = router;