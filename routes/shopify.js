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
      images(first: 250) {
        edges { node { id altText } }
      }
      variants(first: 250) {
        edges {
          node {
            id
            sku
            title
            selectedOptions { name value }
            image { id }
          }
        }
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

const DELETE_PRODUCT_IMAGES_MUTATION = `
  mutation deleteProductImages($id: ID!, $imageIds: [ID!]!) {
    productDeleteImages(id: $id, imageIds: $imageIds) {
      deletedImageIds
      userErrors { field message }
    }
  }
`;

// ── SKU parser: UD-{prodId}-{varId} ──────────────────────────────────────────
function parseSku(sku) {
  const parts = sku.split('-');
  return { prodId: parts[1] || null, varId: parts[2] || null };
}

// ── Image orphan detection (two-tier) ────────────────────────────────────────
//
// Tier 1 — Alt text colour matching (preferred):
//   Extract the colour option from each variant's selectedOptions.
//   If a colour is present ONLY in deleted variants (not in remaining),
//   all product images whose altText equals that colour are queued for deletion.
//
// Tier 2 — Direct variant.image.id fallback:
//   Used when a variant's colour had no alt-text match (alt text blank/different).
//   Deletes the variant's one directly-assigned image, but only if no remaining
//   variant also references that same image ID.
//
// Returns { imageIdsToDelete: string[], logMessages: string[] }
//
function getOrphanedImageIds(allProductImages, deletedVariantNodes, remainingVariantNodes) {
  const imageIdsToDelete = new Set();
  const logMessages      = [];

  // Extract the colour option value from a variant node's selectedOptions array.
  // Prefers an option named "Colour"/"Color"/"Finish"/"Shade"; falls back to first option.
  function getColour(node) {
    const opts = node.selectedOptions || [];
    const opt  = opts.find(o => /colou?r|finish|shade/i.test(o.name)) || opts[0];
    return opt?.value?.trim() || null;
  }

  const deletedColours   = new Set(deletedVariantNodes.map(getColour).filter(Boolean));
  const remainingColours = new Set(remainingVariantNodes.map(getColour).filter(Boolean));
  // Colours that belong ONLY to deleted variants — no remaining variant shares them
  const orphanedColours  = new Set([...deletedColours].filter(c => !remainingColours.has(c)));

  // For Tier 2 safety: image IDs still referenced by remaining variants
  const remainingVariantImageIds = new Set(
    remainingVariantNodes.map(n => n.image?.id).filter(Boolean)
  );

  // ── Tier 1: alt text matching ─────────────────────────────────────────────
  const tier1Handled = new Set(); // colours resolved by tier 1
  for (const img of allProductImages) {
    if (img.altText && orphanedColours.has(img.altText)) {
      imageIdsToDelete.add(img.id);
      tier1Handled.add(img.altText);
    }
  }
  for (const colour of tier1Handled) {
    const count = allProductImages.filter(i => i.altText === colour).length;
    logMessages.push(`delete ${count} image(s) for colour "${colour}" via alt text (no remaining ${colour} variants)`);
  }

  // ── Tier 2: direct variant image fallback ─────────────────────────────────
  for (const node of deletedVariantNodes) {
    const colour = getColour(node);
    // Skip if this colour was already handled by tier 1
    if (colour && tier1Handled.has(colour)) continue;
    // Skip if no directly assigned image
    if (!node.image?.id) continue;
    // Skip if a remaining variant still uses this image (shared image)
    if (remainingVariantImageIds.has(node.image.id)) continue;
    // Skip if already queued
    if (imageIdsToDelete.has(node.image.id)) continue;

    imageIdsToDelete.add(node.image.id);
    logMessages.push(`delete 1 variant image for "${colour || node.title}" via direct assignment (alt text not available)`);
  }

  return { imageIdsToDelete: [...imageIdsToDelete], logMessages };
}

// ── Execute orphaned image deletion (non-fatal) ───────────────────────────────
// Errors are logged as warnings and do not abort the parent operation.
async function deleteOrphanedImages(client, productId, imageIds, log, handle) {
  if (!imageIds.length) return;
  try {
    const result     = await gql(client, DELETE_PRODUCT_IMAGES_MUTATION, { id: productId, imageIds });
    const userErrors = result?.productDeleteImages?.userErrors || [];
    if (userErrors.length) {
      const errMsg = userErrors.map(e => e.message).join(', ');
      log.push({ sku: '-', handle, status: 'warning', message: `Image delete warning: ${errMsg}` });
    } else {
      const count = result?.productDeleteImages?.deletedImageIds?.length ?? imageIds.length;
      console.log(`    ✓ Deleted ${count} orphaned image(s)`);
    }
  } catch (err) {
    log.push({ sku: '-', handle, status: 'warning', message: `Image delete failed (non-fatal): ${err.message}` });
  }
}

// ── POST /api/shopify/delete-variants-bulk ────────────────────────────────────
//
// Body: { variants: [{ handle, variantSku, ... }], dryRun: bool,
//         cfsProductIds: string[], cfsVariantAttrIds: string[] }
//
// Strategy:
//   1. Group orphaned variants by product handle (one lookup per product, not per variant).
//   2. For each product:
//        a. Fetch all its variants from Shopify via GraphQL.
//        b. Identify which of the product's variants are in the orphaned list.
//        c. If ALL variants are orphaned:
//             → Check CFS feeds: extract {prodId} and {varId} from each orphaned SKU.
//               If {prodId} is in cfsProductIds  OR  {varId} is in cfsVariantAttrIds
//               → product has a CFS presence → skip (don't draft, don't delete).
//               Otherwise → set product to DRAFT.
//           If SOME variants are orphaned → delete only those variants.
//   3. Retry on 429 / 5xx up to 3 times with exponential backoff.
//   4. 350ms pause between product operations to stay inside Shopify's rate limit.
//
router.post('/delete-variants-bulk', async (req, res) => {
  const { variants = [], dryRun = true, cfsProductIds = [], cfsVariantAttrIds = [] } = req.body;
  // cfsProductIds arrives as [[prodId, status], ...] entries; build a Map (has() still works)
  const productIdSet    = new Map(cfsProductIds);
  const variantAttrIdSet = new Set(cfsVariantAttrIds);

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
    const orphanedSKUs     = new Set(orphanedForProduct.map(v => v.variantSku));
    // productCode lookup: request body variants carry productCode from compareVariants()
    const productCodeBySku = new Map(orphanedForProduct.map(v => [v.variantSku, v.productCode || '']));

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
            const allVariants      = product.variants.edges.map(e => e.node);
            const allImages        = product.images.edges.map(e => e.node);
            const allOrphaned      = allVariants.every(v => orphanedSKUs.has(v.sku));
            const deletedNodes     = allVariants.filter(v => orphanedSKUs.has(v.sku));
            const remainingNodes   = allVariants.filter(v => !orphanedSKUs.has(v.sku));

            if (allOrphaned) {
              // Per-variant CFS presence check
              const matchedInCFS = allVariants.filter(v => {
                const { prodId, varId } = parseSku(v.sku);
                return (prodId && productIdSet.has(prodId)) || (varId && variantAttrIdSet.has(varId));
              });
              const notInCFS = allVariants.length - matchedInCFS.length;
              if (matchedInCFS.length === 0) {
                action = 'set product to DRAFT (no variants found in CFS feeds)';
              } else if (notInCFS === 0) {
                action = 'keep all variants — all found in CFS feeds';
              } else {
                action = `delete ${notInCFS} unmatched variant(s), keep ${matchedInCFS.length} CFS-matched variant(s)`;
              }
            } else {
              action = `delete ${orphanedSKUs.size} of ${allVariants.length} variant(s)`;
            }

            // Image dry-run: report what would be deleted (only for paths that delete variants)
            const willDeleteVariants = action.startsWith('delete') || action.startsWith('set product to DRAFT') === false;
            if (willDeleteVariants && !action.startsWith('keep') && !action.startsWith('set product to DRAFT')) {
              const effectiveDeleted  = allOrphaned
                ? allVariants.filter(v => { const { prodId, varId } = parseSku(v.sku); return !(prodId && productIdSet.has(prodId)) && !(varId && variantAttrIdSet.has(varId)); })
                : deletedNodes;
              const effectiveRemaining = allOrphaned
                ? allVariants.filter(v => { const { prodId, varId } = parseSku(v.sku); return (prodId && productIdSet.has(prodId)) || (varId && variantAttrIdSet.has(varId)); })
                : remainingNodes;
              const { logMessages: imgMsgs } = getOrphanedImageIds(allImages, effectiveDeleted, effectiveRemaining);
              for (const msg of imgMsgs) {
                log.push({ sku: '-', handle, status: 'dry_run', message: `Images: would ${msg}: ${productTitle}` });
              }
              if (!imgMsgs.length) {
                log.push({ sku: '-', handle, status: 'dry_run', message: `Images: no orphaned images found for ${productTitle}` });
              }
            }
          }
        } catch (_) { /* dry-run lookup failure is non-fatal */ }

        for (const v of orphanedForProduct) {
          log.push({ sku: v.variantSku, handle, status: 'dry_run', message: `[${action}] ${productTitle} / ${v.option1 || v.option2 || 'Default'}`, productCode: v.productCode || '' });
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
          log.push({ sku: v.variantSku, handle, status: 'not_found', message: `Product handle "${handle}" not found on Shopify`, productCode: v.productCode || '' });
          failed++;
        }
        continue;
      }

      const allVariants     = product.variants.edges.map(e => e.node);
      const allImages       = product.images.edges.map(e => e.node);
      const orphanedNodes   = allVariants.filter(v => orphanedSKUs.has(v.sku));
      const nonOrphanedLeft = allVariants.length - orphanedNodes.length;

      // Match up log entries: report any SKUs from the CSV that weren't found on Shopify
      for (const v of orphanedForProduct) {
        if (!orphanedNodes.find(n => n.sku === v.variantSku)) {
          log.push({ sku: v.variantSku, handle, status: 'not_found', message: `SKU ${v.variantSku} not found on Shopify product "${product.title}"`, productCode: v.productCode || '' });
          failed++;
        }
      }

      if (!orphanedNodes.length) {
        await sleep(350);
        continue;
      }

      if (nonOrphanedLeft === 0) {
        const cfsMatched = orphanedNodes.filter(node => {
          const { prodId, varId } = parseSku(node.sku);
          return (prodId && productIdSet.has(prodId)) || (varId && variantAttrIdSet.has(varId));
        });
        const cfsUnmatched = orphanedNodes.filter(node => {
          const { prodId, varId } = parseSku(node.sku);
          return !(prodId && productIdSet.has(prodId)) && !(varId && variantAttrIdSet.has(varId));
        });

        for (const node of cfsMatched) {
          log.push({ sku: node.sku, handle, status: 'kept', message: `Kept - found in CFS feeds: ${product.title} / ${node.title}`, productCode: productCodeBySku.get(node.sku) || '' });
        }

        if (cfsMatched.length > 0 && cfsUnmatched.length > 0) {
          console.log(`  ↗ "${product.title}" — deleting ${cfsUnmatched.length} unmatched, keeping ${cfsMatched.length} CFS-matched`);
          const variantIds = cfsUnmatched.map(v => v.id);
          const result = await gql(client, DELETE_VARIANTS_MUTATION, { productId: product.id, variantsIds: variantIds });
          const userErrors = result?.productVariantsBulkDelete?.userErrors || [];

          if (userErrors.length) {
            const errMsg = userErrors.map(e => e.message).join(', ');
            for (const node of cfsUnmatched) {
              log.push({ sku: node.sku, handle, status: 'error', message: `Variant delete failed: ${errMsg}`, productCode: productCodeBySku.get(node.sku) || '' });
              failed++;
            }
          } else {
            for (const node of cfsUnmatched) {
              log.push({ sku: node.sku, handle, status: 'deleted', message: `Deleted: ${product.title} / ${node.title}`, productCode: productCodeBySku.get(node.sku) || '' });
              deleted++;
            }
            // Delete images orphaned by the removed variants
            const { imageIdsToDelete } = getOrphanedImageIds(allImages, cfsUnmatched, cfsMatched);
            await deleteOrphanedImages(client, product.id, imageIdsToDelete, log, handle);
          }

        } else if (cfsUnmatched.length === 0) {
          console.log(`  ↷ Keeping "${product.title}" — all variants found in CFS feeds`);

        } else {
          console.log(`  ✗ Drafting "${product.title}" — no variants found in CFS feeds`);
          const result = await gql(client, SET_PRODUCT_DRAFT_MUTATION, { productId: product.id });
          const userErrors = result?.productUpdate?.userErrors || [];

          if (userErrors.length) {
            const errMsg = userErrors.map(e => e.message).join(', ');
            for (const v of orphanedForProduct) {
              log.push({ sku: v.variantSku, handle, status: 'error', message: `Set-to-draft failed: ${errMsg}`, productCode: v.productCode || '' });
              failed++;
            }
          } else {
            for (const v of orphanedForProduct) {
              log.push({ sku: v.variantSku, handle, status: 'drafted', message: `Product set to DRAFT: ${product.title}`, productCode: v.productCode || '' });
              deleted++;
            }
          }
        }

      } else {
        const variantIds = orphanedNodes.map(v => v.id);
        const result = await gql(client, DELETE_VARIANTS_MUTATION, { productId: product.id, variantsIds: variantIds });
        const userErrors = result?.productVariantsBulkDelete?.userErrors || [];

        if (userErrors.length) {
          const errMsg = userErrors.map(e => e.message).join(', ');
          for (const node of orphanedNodes) {
            log.push({ sku: node.sku, handle, status: 'error', message: `Variant delete failed: ${errMsg}`, productCode: productCodeBySku.get(node.sku) || '' });
            failed++;
          }
        } else {
          for (const node of orphanedNodes) {
            log.push({ sku: node.sku, handle, status: 'deleted', message: `Deleted: ${product.title} / ${node.title}`, productCode: productCodeBySku.get(node.sku) || '' });
            deleted++;
          }
          // Delete images orphaned by the removed variants
          const remainingNodes = allVariants.filter(v => !orphanedSKUs.has(v.sku));
          const { imageIdsToDelete } = getOrphanedImageIds(allImages, orphanedNodes, remainingNodes);
          await deleteOrphanedImages(client, product.id, imageIdsToDelete, log, handle);
        }
      }

      await sleep(350);

    } catch (err) {
      const msg = err.response?.data?.errors || err.message;
      for (const v of orphanedForProduct) {
        log.push({ sku: v.variantSku, handle, status: 'error', message: String(msg), productCode: v.productCode || '' });
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
    const variantsForHandle = variants.filter(v => v.handle === handle);
    const affectedSKUs      = variantsForHandle.map(v => v.variantSku);
    const productCodeBySku  = new Map(variantsForHandle.map(v => [v.variantSku, v.productCode || '']));

    try {
      if (dryRun) {
        for (const sku of affectedSKUs) {
          log.push({ sku, handle, status: 'dry_run', message: `Would set product to DRAFT: ${representative.title || handle}`, productCode: productCodeBySku.get(sku) || '' });
        }
        await sleep(150);
        continue;
      }

      // Look up the product GID by handle
      const data    = await gql(client, PRODUCT_BY_HANDLE_QUERY, { handle });
      const product = data?.productByHandle;

      if (!product) {
        for (const sku of affectedSKUs) {
          log.push({ sku, handle, status: 'not_found', message: `Product handle "${handle}" not found on Shopify`, productCode: productCodeBySku.get(sku) || '' });
          failed++;
        }
        continue;
      }

      const result     = await gql(client, SET_PRODUCT_DRAFT_MUTATION, { productId: product.id });
      const userErrors = result?.productUpdate?.userErrors || [];

      if (userErrors.length) {
        const errMsg = userErrors.map(e => e.message).join(', ');
        for (const sku of affectedSKUs) {
          log.push({ sku, handle, status: 'error', message: `Set-to-draft failed: ${errMsg}`, productCode: productCodeBySku.get(sku) || '' });
          failed++;
        }
      } else {
        for (const sku of affectedSKUs) {
          log.push({ sku, handle, status: 'drafted', message: `Set to DRAFT: ${product.title}`, productCode: productCodeBySku.get(sku) || '' });
          drafted++;
        }
      }

      await sleep(350);

    } catch (err) {
      const msg = err.response?.data?.errors || err.message;
      for (const sku of affectedSKUs) {
        log.push({ sku, handle, status: 'error', message: String(msg), productCode: productCodeBySku.get(sku) || '' });
        failed++;
      }
    }
  }

  console.log(`  ✓ Done — drafted: ${drafted}, failed: ${failed}`);
  res.json({ success: true, dryRun, drafted, failed, total: variants.length, log });
});


// ── POST /api/shopify/publish-products ───────────────────────────────────────
//
// Body: { variants: [{ handle, variantSku, title, cfsProductStatus, ... }], dryRun: bool }
//
// For each CFS Product Match variant:
//   1. Look up the Shopify product by handle — get ALL its current variants.
//   2. Delete only the selected variant(s).
//   3. Check whether the product still has OTHER variants remaining after deletion:
//        YES → just delete, leave product status untouched (other variants are fine)
//        NO  → all variants removed; set product status based on CFS:
//                CFS active   → ACTIVE
//                CFS inactive → DRAFT
//
const SET_PRODUCT_ACTIVE_MUTATION = `
  mutation setProductActive($productId: ID!) {
    productUpdate(input: { id: $productId, status: ACTIVE }) {
      product { id title status }
      userErrors { field message }
    }
  }
`;

router.post('/publish-products', async (req, res) => {
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

  const log      = [];
  let published  = 0;
  let drafted    = 0;
  let deleted    = 0;
  let failed     = 0;

  // Group all selected variants by handle
  const byHandle = new Map();
  for (const v of variants) {
    if (!byHandle.has(v.handle)) byHandle.set(v.handle, []);
    byHandle.get(v.handle).push(v);
  }

  console.log(`▶ Promoting ${byHandle.size} CFS-product-match products (dryRun=${dryRun})`);

  for (const [handle, variantsForProduct] of byHandle) {
    const affectedSKUs     = variantsForProduct.map(v => v.variantSku);
    const skuSet           = new Set(affectedSKUs);
    const productCodeBySku = new Map(variantsForProduct.map(v => [v.variantSku, v.productCode || '']));

    // CFS status for this product (inactive if any selected variant is inactive)
    const anyCfsInactive = variantsForProduct.some(v => v.cfsProductStatus === 'inactive');
    const targetStatus   = anyCfsInactive ? 'DRAFT' : 'ACTIVE';

    try {
      // Always look up the product — we need to know how many variants it has
      const data    = await gql(client, PRODUCT_BY_HANDLE_QUERY, { handle });
      const product = data?.productByHandle;

      if (!product) {
        for (const sku of affectedSKUs) {
          log.push({ sku, status: 'not_found', message: `Product handle "${handle}" not found on Shopify`, productCode: productCodeBySku.get(sku) || '' });
          failed++;
        }
        continue;
      }

      const allShopifyVariants = product.variants.edges.map(e => e.node);
      const variantsToDelete   = allShopifyVariants.filter(n => skuSet.has(n.sku));
      const remainingVariants  = allShopifyVariants.filter(n => !skuSet.has(n.sku));

      if (variantsToDelete.length === 0) {
        for (const sku of affectedSKUs) {
          log.push({ sku, handle, status: 'not_found', message: `SKU not found on Shopify product "${product.title}"`, productCode: productCodeBySku.get(sku) || '' });
          failed++;
        }
        continue;
      }

      // ── Dry-run: report what would happen ────────────────────────────────
      if (dryRun) {
        const action = remainingVariants.length > 0
          ? `delete variant only - ${remainingVariants.length} other variant(s) remain on product`
          : `delete variant & set product to ${targetStatus} (no other variants remain)`;
        for (const v of variantsForProduct) {
          log.push({ sku: v.variantSku, handle, status: 'dry_run', message: `Would ${action}: ${product.title}`, productCode: v.productCode || '' });
        }
        // Image dry-run
        const allImages = product.images.edges.map(e => e.node);
        const { logMessages: imgMsgs } = getOrphanedImageIds(allImages, variantsToDelete, remainingVariants);
        for (const msg of imgMsgs) {
          log.push({ sku: '-', handle, status: 'dry_run', message: `Images: would ${msg}: ${product.title}` });
        }
        if (!imgMsgs.length) {
          log.push({ sku: '-', handle, status: 'dry_run', message: `Images: no orphaned images found for ${product.title}` });
        }
        await sleep(150);
        continue;
      }

      // ── Live: Step 1 — delete the selected variant(s) ────────────────────
      const variantIds   = variantsToDelete.map(v => v.id);
      const deleteResult = await gql(client, DELETE_VARIANTS_MUTATION, {
        productId: product.id,
        variantsIds: variantIds,
      });
      const deleteErrors = deleteResult?.productVariantsBulkDelete?.userErrors || [];

      if (deleteErrors.length) {
        const errMsg = deleteErrors.map(e => e.message).join(', ');
        for (const sku of affectedSKUs) {
          log.push({ sku, handle, status: 'error', message: `Variant delete failed: ${errMsg}`, productCode: productCodeBySku.get(sku) || '' });
          failed++;
        }
        await sleep(350);
        continue;
      }

      deleted += variantIds.length;
      console.log(`  ✓ Deleted ${variantIds.length} variant(s) from "${product.title}"`);

      // ── Step 1b — delete orphaned images ─────────────────────────────────
      const allImages = product.images.edges.map(e => e.node);
      const { imageIdsToDelete } = getOrphanedImageIds(allImages, variantsToDelete, remainingVariants);
      await deleteOrphanedImages(client, product.id, imageIdsToDelete, log, handle);

      // ── Step 2 — update product status only if no other variants remain ──
      if (remainingVariants.length > 0) {
        for (const v of variantsForProduct) {
          log.push({
            sku: v.variantSku,
            handle,
            status: 'deleted',
            message: `Variant deleted; product status unchanged - ${remainingVariants.length} other variant(s) remain: ${product.title}`,
            productCode: v.productCode || '',
          });
        }
        console.log(`  ↷ Skipping status update for "${product.title}" — ${remainingVariants.length} variant(s) still present`);

      } else {
        const statusMutation = targetStatus === 'ACTIVE'
          ? SET_PRODUCT_ACTIVE_MUTATION
          : SET_PRODUCT_DRAFT_MUTATION;

        const statusResult = await gql(client, statusMutation, { productId: product.id });
        const statusErrors = statusResult?.productUpdate?.userErrors || [];

        if (statusErrors.length) {
          const errMsg = statusErrors.map(e => e.message).join(', ');
          for (const sku of affectedSKUs) {
            log.push({ sku, handle, status: 'error', message: `Status update failed: ${errMsg}`, productCode: productCodeBySku.get(sku) || '' });
            failed++;
          }
        } else {
          const verb      = targetStatus === 'ACTIVE' ? 'published' : 'drafted';
          const cfsStatus = anyCfsInactive ? 'inactive' : 'active';
          for (const v of variantsForProduct) {
            log.push({
              sku: v.variantSku,
              handle,
              status: verb,
              message: `Variant deleted & product set to ${targetStatus} (CFS: ${cfsStatus}): ${product.title}`,
              productCode: v.productCode || '',
            });
          }
          if (targetStatus === 'ACTIVE') published++;
          else drafted++;
          console.log(`  ✓ Product "${product.title}" → ${targetStatus} (CFS was ${cfsStatus})`);
        }
      }

      await sleep(350);

    } catch (err) {
      const msg = err.response?.data?.errors || err.message;
      for (const sku of affectedSKUs) {
        log.push({ sku, handle, status: 'error', message: String(msg), productCode: productCodeBySku.get(sku) || '' });
        failed++;
      }
    }
  }

  console.log(`  ✓ Done — deleted variants: ${deleted}, published: ${published}, drafted: ${drafted}, failed: ${failed}`);
  res.json({ success: true, dryRun, deleted, published, drafted, failed, total: variants.length, log });
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