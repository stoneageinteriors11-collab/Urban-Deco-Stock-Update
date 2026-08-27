const express = require('express');
const axios   = require('axios');
require('dotenv').config();

const router = express.Router();

function shopifyClient() {
  const store   = process.env.SHOPIFY_STORE;
  // Support both direct token (shpat_) and OAuth-acquired token
  const token   = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_API_TOKEN;
  const version = process.env.SHOPIFY_API_VERSION || '2024-04';

  if (!store || !token) {
    throw new Error('Not connected to Shopify. Please click "Connect to Shopify" first.');
  }

  return axios.create({
    baseURL: `https://${store}/admin/api/${version}`,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  });
}

// Helper: wait between calls to respect Shopify rate limits (2 req/sec for REST)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── POST /api/shopify/delete-variants ─────────────────────────────────────────
// Body: { skus: ["UD-123-456", ...], dryRun: true/false }
// Finds each variant by SKU then deletes it via the Shopify Admin REST API
router.post('/delete-variants', async (req, res) => {
  const { skus = [], dryRun = true } = req.body;

  if (!skus.length) {
    return res.status(400).json({ error: 'No SKUs provided.' });
  }

  const client = shopifyClient();
  const log    = [];
  let deleted  = 0;
  let failed   = 0;

  for (const sku of skus) {
    try {
      // Search for the variant by SKU
      const searchRes = await client.get(`/variants.json?fields=id,product_id,sku,title&limit=5`, {
        params: { fields: 'id,product_id,sku,title', limit: 5 }
      });

      // Shopify doesn't filter variants by SKU directly — use GraphQL or product search
      // Instead we search products by SKU using the product search endpoint
      const productRes = await client.get('/products.json', {
        params: { fields: 'id,title,variants', limit: 250 }
      });

      // This approach is slow for bulk; the preferred method is to pass product_id + variant_id
      // Since we have the SKU in format UD-{productId}-{variantAttrId}, we can extract product context
      // For now, search through returned products (batching handled below)
      let found = null;
      for (const product of productRes.data.products || []) {
        const match = (product.variants || []).find(v => v.sku === sku);
        if (match) {
          found = { productId: product.id, variantId: match.id, title: product.title, variantTitle: match.title };
          break;
        }
      }

      if (!found) {
        log.push({ sku, status: 'not_found', message: 'Variant not found in Shopify' });
        continue;
      }

      if (dryRun) {
        log.push({ sku, status: 'dry_run', message: `Would delete variant ${found.variantId} (${found.title} / ${found.variantTitle})` });
      } else {
        await client.delete(`/products/${found.productId}/variants/${found.variantId}.json`);
        log.push({ sku, status: 'deleted', message: `Deleted variant ${found.variantId} (${found.title} / ${found.variantTitle})` });
        deleted++;
      }

      await sleep(500); // 2 req/sec rate limit safety

    } catch (err) {
      failed++;
      const msg = err.response?.data?.errors || err.message;
      log.push({ sku, status: 'error', message: String(msg) });
    }
  }

  res.json({ success: true, dryRun, deleted, failed, total: skus.length, log });
});


// ── POST /api/shopify/delete-variants-bulk ────────────────────────────────────
// Faster bulk delete using GraphQL — accepts array of { productId, variantId, sku }
// These IDs come from the compare step when the Shopify export is used (no extra lookup needed)
router.post('/delete-variants-bulk', async (req, res) => {
  const { variants = [], dryRun = true } = req.body;
  // variants: [{ sku, handle, title, option1, variantSku }]
  // Since we don't have Shopify internal IDs from the CSV export,
  // we use the GraphQL productVariantsBulkDelete mutation via handle lookup

  if (!variants.length) {
    return res.status(400).json({ error: 'No variants provided.' });
  }

  const store   = process.env.SHOPIFY_STORE;
  const token   = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_API_TOKEN;
  const version = process.env.SHOPIFY_API_VERSION || '2024-04';
  const graphqlUrl = `https://${store}/admin/api/${version}/graphql.json`;

  const log    = [];
  let deleted  = 0;
  let failed   = 0;

  for (const v of variants) {
    try {
      if (dryRun) {
        log.push({ sku: v.variantSku, status: 'dry_run', message: `Would delete: ${v.title} / ${v.option1 || v.option2 || 'Default'}` });
        continue;
      }

      // Step 1: Look up the product by handle to get its GID
      const lookupQuery = `
        query getProductByHandle($handle: String!) {
          productByHandle(handle: $handle) {
            id
            variants(first: 100) {
              edges {
                node { id sku title }
              }
            }
          }
        }
      `;

      const lookupRes = await axios.post(
        graphqlUrl,
        { query: lookupQuery, variables: { handle: v.handle } },
        { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } }
      );

      const product = lookupRes.data?.data?.productByHandle;
      if (!product) {
        log.push({ sku: v.variantSku, status: 'not_found', message: `Product handle "${v.handle}" not found` });
        failed++;
        continue;
      }

      const variantNode = product.variants.edges.find(e => e.node.sku === v.variantSku);
      if (!variantNode) {
        log.push({ sku: v.variantSku, status: 'not_found', message: `SKU ${v.variantSku} not found on product` });
        failed++;
        continue;
      }

      // Step 2: Delete the variant
      const deleteMutation = `
        mutation deleteVariant($productId: ID!, $variantsIds: [ID!]!) {
          productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
            product { id title }
            userErrors { field message }
          }
        }
      `;

      const deleteRes = await axios.post(
        graphqlUrl,
        {
          query: deleteMutation,
          variables: { productId: product.id, variantsIds: [variantNode.node.id] },
        },
        { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } }
      );

      const userErrors = deleteRes.data?.data?.productVariantsBulkDelete?.userErrors || [];
      if (userErrors.length) {
        log.push({ sku: v.variantSku, status: 'error', message: userErrors.map(e => e.message).join(', ') });
        failed++;
      } else {
        log.push({ sku: v.variantSku, status: 'deleted', message: `Deleted: ${v.title} / ${variantNode.node.title}` });
        deleted++;
      }

      await sleep(500);

    } catch (err) {
      failed++;
      log.push({ sku: v.variantSku, status: 'error', message: err.message });
    }
  }

  res.json({ success: true, dryRun, deleted, failed, total: variants.length, log });
});


// ── GET /api/shopify/test-connection ──────────────────────────────────────────
router.get('/test-connection', async (req, res) => {
  try {
    const client = shopifyClient();
    const r = await client.get('/shop.json');
    res.json({ success: true, shop: r.data.shop.name, domain: r.data.shop.domain });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
