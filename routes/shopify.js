const express = require('express');
const axios   = require('axios');
require('dotenv').config();

const router = express.Router();

// ── Shopify GraphQL client ────────────────────────────────────────────────────
function graphqlClient() {
  const store   = process.env.SHOPIFY_STORE;
  const token   = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_API_TOKEN;
  const version = process.env.SHOPIFY_API_VERSION || '2024-04';

  if (!store || !token) {
    throw new Error('Not connected to Shopify. Please click "Connect to Shopify" first.');
  }

  return {
    url: `https://${store}/admin/api/${version}/graphql.json`,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
  };
}

// ── Rate-limit-aware GraphQL caller ──────────────────────────────────────────
// Retries up to 3 times on 429 / transient errors with exponential backoff.
async function gql(client, query, variables = {}, attempt = 1) {
  try {
    const res = await axios.post(
      client.url,
      { query, variables },
      { headers: client.headers, timeout: 30000 }
    );

    // Surface GraphQL-level errors
    if (res.data.errors) {
      const msg = res.data.errors.map(e => e.message).join('; ');
      throw new Error(`GraphQL error: ${msg}`);
    }

    return res.data.data;

  } catch (err) {
    const status = err.response?.status;

    // Retry on rate limit (429) or transient server errors (5xx)
    if ((status === 429 || (status >= 500 && status < 600)) && attempt <= 3) {
      const delay = attempt * 2000; // 2s, 4s, 6s
      console.warn(`  ⚠ HTTP ${status} — retrying in ${delay}ms (attempt ${attempt}/3)`);
      await sleep(delay);
      return gql(client, query, variables, attempt + 1);
    }

    throw err;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Queries & mutations ───────────────────────────────────────────────────────
const PRODUCT_BY_HANDLE_QUERY = `
  query getProduct($handle: String!) {
    productByHandle(handle: $handle) {
      id
      title
      variants(first: 250) {
        edges { node { id sku title } }
      }
    }
  }
`;

const DELETE_VARIANTS_MUTATION = `
  mutation deleteVariants($productId: ID!, $variantsIds: [ID!]!) {
    productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
      product { id title }
      userErrors { field message }
    }
  }
`;

const SET_PRODUCT_DRAFT_MUTATION = `
  mutation setProductDraft($productId: ID!) {
    productUpdate(input: { id: $productId, status: DRAFT }) {
      product { id title status }
      userErrors { field message }
    }
  }
`;

// ── POST /api/shopify/delete-variants-bulk ────────────────────────────────────
//
// Body: { variants: [{ handle, variantSku, title, option1, ... }], dryRun: bool }
//
// Strategy:
//   1. Group orphaned variants by product handle (one lookup per product, not per variant).
//   2. For each product:
//        a. Fetch all its variants from Shopify via GraphQL.
//        b. Identify which of the product's variants are in the orphaned list.
//        c. If ALL variants are orphaned → delete the entire product.
//           If SOME variants are orphaned → delete only those variants.
//   3. Retry on 429 / 5xx up to 3 times with exponential backoff.
//   4. 350ms pause between product operations to stay inside Shopify's rate limit.
//
router.post('/delete-variants-bulk', async (req, res) => {
  const { variants = [], dryRun = true } = req.body;

  if (!variants.length) {
    return res.status(400).json({ error: 'No variants provided.' });
  }

  let client;
  try {
    client = graphqlClient();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const log     = [];
  let deleted   = 0;
  let failed    = 0;

  // Step 1 — group orphaned variants by product handle
  const byHandle = new Map();
  for (const v of variants) {
    if (!byHandle.has(v.handle)) byHandle.set(v.handle, []);
    byHandle.get(v.handle).push(v);
  }

  console.log(`▶ Processing ${variants.length} orphaned variants across ${byHandle.size} products (dryRun=${dryRun})`);

  // Step 2 — process one product at a time
  for (const [handle, orphanedForProduct] of byHandle) {
    const orphanedSKUs = new Set(orphanedForProduct.map(v => v.variantSku));

    try {
      if (dryRun) {
        // In dry-run mode we still look up the product so we can report
        // whether it would be a full-product delete or a variant-only delete.
        let productTitle = orphanedForProduct[0].title || handle;
        let action = 'delete variant(s)';

        try {
          const data = await gql(client, PRODUCT_BY_HANDLE_QUERY, { handle });
          const product = data?.productByHandle;

          if (product) {
            productTitle = product.title;
            const allVariants = product.variants.edges.map(e => e.node);
            const allOrphaned = allVariants.every(v => orphanedSKUs.has(v.sku));
            action = allOrphaned ? 'set product to DRAFT (all variants orphaned)' : `delete ${orphanedSKUs.size} of ${allVariants.length} variant(s)`;
          }
        } catch (_) { /* dry-run lookup failure is non-fatal */ }

        for (const v of orphanedForProduct) {
          log.push({ sku: v.variantSku, status: 'dry_run', message: `[${action}] ${productTitle} / ${v.option1 || v.option2 || 'Default'}` });
        }

        await sleep(150); // lighter pause during dry-run lookups
        continue;
      }

      // ── Live deletion ──────────────────────────────────────────────────────

      // Look up the product and all its variants
      const data    = await gql(client, PRODUCT_BY_HANDLE_QUERY, { handle });
      const product = data?.productByHandle;

      if (!product) {
        for (const v of orphanedForProduct) {
          log.push({ sku: v.variantSku, status: 'not_found', message: `Product handle "${handle}" not found on Shopify` });
          failed++;
        }
        continue;
      }

      const allVariants     = product.variants.edges.map(e => e.node);
      const orphanedNodes   = allVariants.filter(v => orphanedSKUs.has(v.sku));
      const nonOrphanedLeft = allVariants.length - orphanedNodes.length;

      // Match up log entries: report any SKUs from the CSV that weren't found on Shopify
      for (const v of orphanedForProduct) {
        if (!orphanedNodes.find(n => n.sku === v.variantSku)) {
          log.push({ sku: v.variantSku, status: 'not_found', message: `SKU ${v.variantSku} not found on Shopify product "${product.title}"` });
          failed++;
        }
      }

      if (!orphanedNodes.length) {
        await sleep(350);
        continue;
      }

      if (nonOrphanedLeft === 0) {
        // All variants are orphaned → set the entire product to DRAFT
        const result = await gql(client, SET_PRODUCT_DRAFT_MUTATION, { productId: product.id });
        const userErrors = result?.productUpdate?.userErrors || [];

        if (userErrors.length) {
          const errMsg = userErrors.map(e => e.message).join(', ');
          for (const v of orphanedForProduct) {
            log.push({ sku: v.variantSku, status: 'error', message: `Set-to-draft failed: ${errMsg}` });
            failed++;
          }
        } else {
          for (const v of orphanedForProduct) {
            log.push({ sku: v.variantSku, status: 'drafted', message: `Product set to DRAFT: ${product.title}` });
            deleted++;
          }
        }

      } else {
        // Only some variants are orphaned → delete those variants only
        const variantIds = orphanedNodes.map(v => v.id);
        const result = await gql(client, DELETE_VARIANTS_MUTATION, { productId: product.id, variantsIds: variantIds });
        const userErrors = result?.productVariantsBulkDelete?.userErrors || [];

        if (userErrors.length) {
          const errMsg = userErrors.map(e => e.message).join(', ');
          for (const node of orphanedNodes) {
            log.push({ sku: node.sku, status: 'error', message: `Variant delete failed: ${errMsg}` });
            failed++;
          }
        } else {
          for (const node of orphanedNodes) {
            log.push({ sku: node.sku, status: 'deleted', message: `Deleted: ${product.title} / ${node.title}` });
            deleted++;
          }
        }
      }

      await sleep(350); // ~3 products/sec — safely inside Shopify's rate limit

    } catch (err) {
      const msg = err.response?.data?.errors || err.message;
      for (const v of orphanedForProduct) {
        log.push({ sku: v.variantSku, status: 'error', message: String(msg) });
        failed++;
      }
    }
  }

  console.log(`  ✓ Done — deleted: ${deleted}, failed: ${failed}, total: ${variants.length}`);
  res.json({ success: true, dryRun, deleted, failed, total: variants.length, log });
});


// ── POST /api/shopify/set-draft ───────────────────────────────────────────────
//
// Body: { variants: [{ handle, variantSku, title, ... }], dryRun: bool }
//
// Sets the Shopify product to DRAFT for each unique handle in the list.
// One API call per product (grouped by handle). Used for CFS-inactive products
// that are still Active on Shopify.
//
router.post('/set-draft', async (req, res) => {
  const { variants = [], dryRun = true } = req.body;

  if (!variants.length) {
    return res.status(400).json({ error: 'No variants provided.' });
  }

  let client;
  try {
    client = graphqlClient();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const log   = [];
  let drafted = 0;
  let failed  = 0;

  // Group by handle — one set-to-draft call per product
  const byHandle = new Map();
  for (const v of variants) {
    if (!byHandle.has(v.handle)) byHandle.set(v.handle, v);
  }

  console.log(`▶ Setting ${byHandle.size} products to DRAFT (dryRun=${dryRun})`);

  for (const [handle, representative] of byHandle) {
    const affectedSKUs = variants.filter(v => v.handle === handle).map(v => v.variantSku);

    try {
      if (dryRun) {
        for (const sku of affectedSKUs) {
          log.push({ sku, status: 'dry_run', message: `Would set product to DRAFT: ${representative.title || handle}` });
        }
        await sleep(150);
        continue;
      }

      // Look up the product GID by handle
      const data    = await gql(client, PRODUCT_BY_HANDLE_QUERY, { handle });
      const product = data?.productByHandle;

      if (!product) {
        for (const sku of affectedSKUs) {
          log.push({ sku, status: 'not_found', message: `Product handle "${handle}" not found on Shopify` });
          failed++;
        }
        continue;
      }

      const result     = await gql(client, SET_PRODUCT_DRAFT_MUTATION, { productId: product.id });
      const userErrors = result?.productUpdate?.userErrors || [];

      if (userErrors.length) {
        const errMsg = userErrors.map(e => e.message).join(', ');
        for (const sku of affectedSKUs) {
          log.push({ sku, status: 'error', message: `Set-to-draft failed: ${errMsg}` });
          failed++;
        }
      } else {
        for (const sku of affectedSKUs) {
          log.push({ sku, status: 'drafted', message: `Set to DRAFT: ${product.title}` });
          drafted++;
        }
      }

      await sleep(350);

    } catch (err) {
      const msg = err.response?.data?.errors || err.message;
      for (const sku of affectedSKUs) {
        log.push({ sku, status: 'error', message: String(msg) });
        failed++;
      }
    }
  }

  console.log(`  ✓ Done — drafted: ${drafted}, failed: ${failed}`);
  res.json({ success: true, dryRun, drafted, failed, total: variants.length, log });
});


// ── GET /api/shopify/test-connection ──────────────────────────────────────────
router.get('/test-connection', async (req, res) => {
  try {
    const client = graphqlClient();
    const data   = await gql(client, `{ shop { name myshopifyDomain } }`);
    res.json({ success: true, shop: data.shop.name, domain: data.shop.myshopifyDomain });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;