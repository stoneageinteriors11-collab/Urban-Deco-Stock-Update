const express = require('express');
const axios   = require('axios');
require('dotenv').config();

const router = express.Router();

// ── Shopify GraphQL client ────────────────────────────────────────────────────
function graphqlClient() {
  const store   = process.env.SHOPIFY_STORE;
  const token   = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_API_TOKEN;
  const version = process.env.SHOPIFY_API_VERSION || '2026-07';

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

    // Network-level failures (socket hang up, ECONNRESET, ETIMEDOUT) have no
    // err.response — detect them by error code or message.
    const isNetworkError = !err.response && (
      err.code === 'ECONNRESET' ||
      err.code === 'ETIMEDOUT'  ||
      err.code === 'ENOTFOUND'  ||
      err.code === 'ECONNABORTED' ||
      err.message?.includes('socket hang up') ||
      err.message?.includes('timeout')
    );

    // Retry on rate limit (429), transient server errors (5xx), or network errors
    if ((status === 429 || (status >= 500 && status < 600) || isNetworkError) && attempt <= 3) {
      const delay = attempt * 2000; // 2s, 4s, 6s
      const reason = isNetworkError ? `network error (${err.code || err.message})` : `HTTP ${status}`;
      console.warn(`  ⚠ ${reason} — retrying in ${delay}ms (attempt ${attempt}/3)`);
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

const METAFIELDS_SET_MUTATION = `
  mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key value }
      userErrors { field message code }
    }
  }
`;

// Query for sync — fetches GIDs plus existing metafield values so we can
// detect conflicts (new vs match vs overwrite) before writing anything.
const PRODUCT_SYNC_QUERY = `
  query getProductSync($handle: String!) {
    productByHandle(handle: $handle) {
      id
      title
      metafield(namespace: "custom", key: "product_code") {
        value
      }
      variants(first: 250) {
        edges {
          node {
            id
            sku
            metafield(namespace: "custom", key: "variant_code") {
              value
            }
          }
        }
      }
    }
  }
`;

// Query for Step 4 enhancement — finds ALL Shopify variants with an exact SKU
// across every product. The sku:'...' filter is exact (quoted value).
// Returns variant GID, existing variant_code, and parent product data.
const VARIANTS_BY_SKU_QUERY = `
  query variantsBySku($query: String!, $after: String) {
    productVariants(first: 50, query: $query, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          sku
          metafield(namespace: "custom", key: "variant_code") { value }
          product {
            id
            handle
            title
            status
            metafield(namespace: "custom", key: "product_code") { value }
          }
        }
      }
    }
  }
`;

// ── SKU parser: UD-{prodId}-{varId} ──────────────────────────────────────────
function parseSku(sku) {
  const parts = sku.split('-');
  return { prodId: parts[1] || null, varId: parts[2] || null };
}

// ── Short human-readable label for a Shopify variant node ────────────────────
// Uses the variant's title (Shopify combines selected option values into title,
// e.g. "Brown / 2 Seater"). Falls back to selectedOptions, then SKU.
function variantLabel(node) {
  if (node.title && node.title !== 'Default Title') return node.title;
  const opts = node.selectedOptions?.map(o => o.value).filter(Boolean);
  if (opts?.length) return opts.join(' / ');
  return node.sku || '?';
}

// ── Compact list of variant labels ──────────────────────────────────────────
// Returns "A, B, C" for ≤3 nodes or "A, B, C + 2 more" beyond that.
function variantList(nodes, max = 3) {
  const labels = nodes.slice(0, max).map(variantLabel);
  const extra  = nodes.length - max;
  return extra > 0 ? `${labels.join(', ')} + ${extra} more` : labels.join(', ');
}

// Convert a variant SKU to its product-level reference SKU.
// UD-{prodId}-{varId} → UD-{prodId}   (strips the variant ID tail)
// Returns the original sku unchanged if it doesn't have 3+ segments.
function productRefSku(variantSku) {
  if (!variantSku) return '';
  const parts = variantSku.split('-');
  return parts.length >= 3 ? parts.slice(0, 2).join('-') : variantSku;
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
          const shopNode = deletedNodes.find(n => n.sku === v.variantSku);
          const label    = shopNode ? variantLabel(shopNode) : (v.option1 || v.option2 || v.variantSku);

          let msg;
          if (action.startsWith('set product to DRAFT')) {
            msg = `Would set "${productTitle}" to DRAFT — all variants orphaned, deleting "${label}" (no CFS match)`;
          } else if (action.startsWith('keep all')) {
            msg = `Would keep "${label}" — all variants found in CFS feeds: ${productTitle}`;
          } else if (remainingNodes.length > 0) {
            // variant-only delete — list what's staying
            const stayList = variantList(remainingNodes);
            msg = `Would delete variant "${label}" — ${remainingNodes.length} remaining: ${stayList} · ${productTitle}`;
          } else {
            // mixed CFS-matched / unmatched
            msg = `[${action}] Would delete "${label}": ${productTitle}`;
          }
          log.push({ sku: v.variantSku, handle, status: 'dry_run', message: msg, productCode: v.productCode || '' });
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

// Updates a single variant's SKU in-place (used when promoting the last variant
// to a product-level SKU instead of deleting it).
const UPDATE_VARIANT_SKU_MUTATION = `
  mutation updateVariantSku($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku }
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
        const allImages = product.images.edges.map(e => e.node);

        for (const v of variantsForProduct) {
          const shopNode = variantsToDelete.find(n => n.sku === v.variantSku);
          const label    = shopNode ? variantLabel(shopNode) : (v.option1 || v.option2 || v.variantSku);

          let msg;
          if (remainingVariants.length > 0) {
            const stayList = variantList(remainingVariants);
            msg = `Would delete variant "${label}" — ${remainingVariants.length} remaining: ${stayList} · ${product.title}`;
          } else {
            // Shopify forbids deleting the last variant — keep the first and update its SKU
            // to the product-level format; delete any others before it.
            const isKeeper = variantsToDelete[0]?.sku === v.variantSku;
            const { prodId } = parseSku(v.variantSku);
            const newSku = prodId ? `UD-${prodId}` : v.variantSku;
            if (isKeeper) {
              msg = `Would update SKU "${v.variantSku}" → "${newSku}" & set product to ${targetStatus} (last variant — promoted to main product) · ${product.title}`;
            } else {
              msg = `Would delete variant "${label}" (cleanup before SKU promotion) · ${product.title}`;
            }
          }
          log.push({ sku: v.variantSku, handle, status: 'dry_run', message: msg, productCode: v.productCode || '' });
        }

        // Image dry-run
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

      const allImages = product.images.edges.map(e => e.node);

      if (remainingVariants.length === 0) {
        // ── All variants on this product are cfs-product matches ────────────
        // Shopify forbids deleting the absolute last variant on a product.
        // Strategy: keep the first variant and update its SKU to the product-level
        // format (UD-{prodId}); delete all others; then set the product status.

        const keepNode   = variantsToDelete[0];
        const deleteRest = variantsToDelete.slice(1);
        const { prodId } = parseSku(keepNode.sku);
        const newSku     = prodId ? `UD-${prodId}` : keepNode.sku;

        // Step A — delete all variants except the one we're keeping
        if (deleteRest.length > 0) {
          const delResult  = await gql(client, DELETE_VARIANTS_MUTATION, {
            productId: product.id, variantsIds: deleteRest.map(v => v.id),
          });
          const delErrors  = delResult?.productVariantsBulkDelete?.userErrors || [];
          if (delErrors.length) {
            const errMsg = delErrors.map(e => e.message).join(', ');
            for (const node of deleteRest) {
              log.push({ sku: node.sku, handle, status: 'error', message: `Variant delete failed: ${errMsg}`, productCode: productCodeBySku.get(node.sku) || '' });
              failed++;
            }
            await sleep(350);
            continue;
          }
          deleted += deleteRest.length;
          for (const node of deleteRest) {
            log.push({ sku: node.sku, handle, status: 'deleted', message: `Deleted (cleanup before SKU promotion): ${product.title} / ${variantLabel(node)}`, productCode: productCodeBySku.get(node.sku) || '' });
          }
        }

        // Step B — update the kept variant's SKU to the product-level format
        const updateResult = await gql(client, UPDATE_VARIANT_SKU_MUTATION, {
          productId: product.id,
          variants: [{ id: keepNode.id, sku: newSku }],
        });
        const updateErrors = updateResult?.productVariantsBulkUpdate?.userErrors || [];
        if (updateErrors.length) {
          const errMsg = updateErrors.map(e => e.message).join(', ');
          log.push({ sku: keepNode.sku, handle, status: 'error', message: `SKU update failed: ${errMsg}`, productCode: productCodeBySku.get(keepNode.sku) || '' });
          failed++;
        } else {
          log.push({ sku: newSku, handle, status: 'updated', message: `SKU promoted: "${keepNode.sku}" → "${newSku}" on "${product.title}"`, productCode: productCodeBySku.get(keepNode.sku) || '' });
          console.log(`  ✓ SKU promoted: "${keepNode.sku}" → "${newSku}"`);
        }

        // Step C — delete orphaned images (treating all original variants as deleted)
        const { imageIdsToDelete } = getOrphanedImageIds(allImages, variantsToDelete, []);
        await deleteOrphanedImages(client, product.id, imageIdsToDelete, log, handle);

        // Step D — set product status
        const statusMutation = targetStatus === 'ACTIVE' ? SET_PRODUCT_ACTIVE_MUTATION : SET_PRODUCT_DRAFT_MUTATION;
        const statusResult   = await gql(client, statusMutation, { productId: product.id });
        const statusErrors   = statusResult?.productUpdate?.userErrors || [];
        if (statusErrors.length) {
          const errMsg = statusErrors.map(e => e.message).join(', ');
          log.push({ sku: newSku, handle, status: 'error', message: `Status update failed: ${errMsg}`, productCode: productCodeBySku.get(keepNode.sku) || '' });
          failed++;
        } else {
          const verb      = targetStatus === 'ACTIVE' ? 'published' : 'drafted';
          const cfsStatus = anyCfsInactive ? 'inactive' : 'active';
          log.push({ sku: newSku, handle, status: verb, message: `Promoted to main product & set to ${targetStatus} (CFS: ${cfsStatus}): ${product.title}`, productCode: productCodeBySku.get(keepNode.sku) || '' });
          if (targetStatus === 'ACTIVE') published++;
          else drafted++;
          console.log(`  ✓ "${product.title}" → ${targetStatus} as main product (CFS: ${cfsStatus})`);
        }

      } else {
        // ── Some variants remain — delete the selected ones only ─────────────
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

        // Delete orphaned images
        const { imageIdsToDelete } = getOrphanedImageIds(allImages, variantsToDelete, remainingVariants);
        await deleteOrphanedImages(client, product.id, imageIdsToDelete, log, handle);

        for (const v of variantsForProduct) {
          log.push({
            sku: v.variantSku,
            handle,
            status: 'deleted',
            message: `Variant deleted; product status unchanged — ${remainingVariants.length} other variant(s) remain: ${product.title}`,
            productCode: v.productCode || '',
          });
        }
        console.log(`  ↷ Skipping status update for "${product.title}" — ${remainingVariants.length} variant(s) still present`);
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


// ── POST /api/shopify/sync-metafields ────────────────────────────────────────
//
// Body: { variants: [...allResults...], dryRun: bool }
//
// Enhanced: for each unique variant SKU with a CFS code, queries Shopify directly
// using productVariants(query: "sku:'...'") to find ALL products that contain that
// SKU — not just the ones in the compare results. This ensures that if UD-601539
// appears on 3 Shopify products, all 3 get product_code and/or variant_code set.
//
//   • custom.product_code on the Shopify product (once per product per run, upsert)
//   • custom.variant_code on the Shopify variant (one per variant, upsert)
//
// Uses metafieldsSet which acts as upsert — safe to run multiple times.
// Batches up to 25 metafields per API call to stay within Shopify limits.
//
router.post('/sync-metafields', async (req, res) => {
  const { variants = [], dryRun = true } = req.body;

  // Only rows that have at least one code to write
  const toSync = variants.filter(v => v.productCodeOnly || v.variantCode);

  if (!toSync.length) {
    return res.status(400).json({ error: 'No variants with CFS codes found. Make sure the CFS feeds contain Product Code / var_code columns.' });
  }

  let client;
  try {
    client = graphqlClient();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // ── Stream as SSE (text/event-stream) ────────────────────────────────────
  // nginx recognises this content-type and never buffers it, unlike NDJSON.
  // Each event is:  data: <JSON>\n\n
  // The last event carries { type:'done', ... } with the full log + counters.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.socket) res.socket.setNoDelay(true); // disable Nagle buffering
  res.flushHeaders();
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const log  = [];
  let synced         = 0;  // total metafields written (new + overwrites)
  let newCount       = 0;  // written because no prior value existed
  let overwriteCount = 0;  // written because prior value differed
  let skipped        = 0;  // value already matched — no write needed
  let failed         = 0;

  // ── Build unique-SKU → codes map (first occurrence wins per SKU) ─────────
  // Enhanced approach: instead of grouping by handle from the compare results,
  // we deduplicate by SKU and then query Shopify directly to find ALL products
  // that carry each SKU. This guarantees every matching product is updated,
  // including products that weren't in the Shopify export for the compare step.
  const skuCodeMap = new Map(); // sku → { productCode, variantCode }
  for (const v of toSync) {
    if (!skuCodeMap.has(v.variantSku)) {
      skuCodeMap.set(v.variantSku, {
        productCode: v.productCodeOnly || '',
        variantCode: v.variantCode     || '',
      });
    }
  }

  let processed = 0;
  const totalProducts = skuCodeMap.size; // "products" here = unique SKUs to process

  // productCodeWritten tracks which Shopify product GIDs already had
  // product_code written this run (multiple SKUs can share a product).
  const productCodeWritten = new Set();

  console.log(`▶ Syncing metafields for ${skuCodeMap.size} unique SKUs (dryRun=${dryRun})`);

  try { // ── outer try ──────────────────────────────────────────────────────

  for (const [sku, { productCode, variantCode }] of skuCodeMap) {
    try {
      // ── Query Shopify for ALL variants with this exact SKU ─────────────
      // productVariants(query:"sku:'X'") uses an exact-match filter.
      // We post-filter results to guard against partial matches.
      let allVariantNodes = [];
      let cursor    = null;
      let hasMore   = true;
      while (hasMore) {
        const data = await gql(client, VARIANTS_BY_SKU_QUERY, {
          query: `sku:'${sku}'`,
          after:  cursor,
        });
        const edges    = data?.productVariants?.edges    || [];
        const pageInfo = data?.productVariants?.pageInfo || {};
        for (const e of edges) {
          if (e.node.sku === sku) allVariantNodes.push(e.node); // exact match guard
        }
        hasMore = pageInfo.hasNextPage;
        cursor  = pageInfo.endCursor || null;
      }

      if (!allVariantNodes.length) {
        log.push({ type: 'variant', sku, handle: '-', status: 'not_found',
          message: `SKU ${sku} not found on any Shopify product`,
          productCode, variantCode });
        failed++;
        continue;
      }

      // ── Group found variants by their parent product ───────────────────
      const byProduct = new Map(); // productId → { productNode, variants: [] }
      for (const varNode of allVariantNodes) {
        const pid = varNode.product.id;
        if (!byProduct.has(pid)) byProduct.set(pid, { productNode: varNode.product, variants: [] });
        byProduct.get(pid).variants.push(varNode);
      }

      // ── Process each Shopify product that holds this SKU ───────────────
      for (const [pid, { productNode, variants }] of byProduct) {
        const handle          = productNode.handle;
        const title           = productNode.title;
        const existingProdCode = productNode.metafield?.value || '';

        if (dryRun) {
          // product_code — report once per product per run
          if (productCode && !productCodeWritten.has(pid)) {
            if (!existingProdCode) {
              log.push({ type: 'product', sku, handle, status: 'dry_run',
                message: `Would set custom.product_code = "${productCode}" on "${title}" (new)`,
                productCode, variantCode: '' });
            } else if (existingProdCode === productCode) {
              log.push({ type: 'product', sku, handle, status: 'match',
                message: `custom.product_code already "${productCode}" on "${title}" — no change needed`,
                productCode, variantCode: '' });
            } else {
              log.push({ type: 'product', sku, handle, status: 'overwrite',
                message: `Would overwrite custom.product_code: "${existingProdCode}" → "${productCode}" on "${title}"`,
                productCode, variantCode: '' });
            }
            productCodeWritten.add(pid); // mark reported for this product
          }

          // variant_code — report for each variant
          if (variantCode) {
            for (const varNode of variants) {
              const existing = varNode.metafield?.value || '';
              if (!existing) {
                log.push({ type: 'variant', sku, handle, status: 'dry_run',
                  message: `Would set custom.variant_code = "${variantCode}" on variant ${sku} in "${title}" (new)`,
                  productCode, variantCode });
              } else if (existing === variantCode) {
                log.push({ type: 'variant', sku, handle, status: 'match',
                  message: `custom.variant_code already "${variantCode}" on variant ${sku} in "${title}" — no change needed`,
                  productCode, variantCode });
              } else {
                log.push({ type: 'variant', sku, handle, status: 'overwrite',
                  message: `Would overwrite custom.variant_code: "${existing}" → "${variantCode}" on variant ${sku} in "${title}"`,
                  productCode, variantCode });
              }
            }
          }

        } else {
          // ── Live sync ─────────────────────────────────────────────────
          const metafields   = [];
          const overwriteMap = new Map(); // GID → old value

          // product_code: write once per product per run
          if (productCode && !productCodeWritten.has(pid)) {
            if (existingProdCode === productCode) {
              log.push({ type: 'product', sku, handle, status: 'match',
                message: `custom.product_code already "${productCode}" on "${title}" — skipped`,
                productCode, variantCode: '' });
              skipped++;
            } else {
              if (existingProdCode) overwriteMap.set(pid, existingProdCode);
              metafields.push({ ownerId: pid, namespace: 'custom', key: 'product_code',
                value: productCode, type: 'single_line_text_field' });
            }
          }

          // variant_code: write for each variant on this product
          if (variantCode) {
            for (const varNode of variants) {
              const existing = varNode.metafield?.value || '';
              if (existing === variantCode) {
                log.push({ type: 'variant', sku, handle, status: 'match',
                  message: `custom.variant_code already "${variantCode}" on variant ${sku} in "${title}" — skipped`,
                  productCode, variantCode });
                skipped++;
                continue;
              }
              if (existing) overwriteMap.set(varNode.id, existing);
              metafields.push({ ownerId: varNode.id, namespace: 'custom', key: 'variant_code',
                value: variantCode, type: 'single_line_text_field' });
            }
          }

          if (metafields.length) {
            const BATCH_SIZE = 25;
            for (let i = 0; i < metafields.length; i += BATCH_SIZE) {
              const batch      = metafields.slice(i, i + BATCH_SIZE);
              const result     = await gql(client, METAFIELDS_SET_MUTATION, { metafields: batch });
              const userErrors = result?.metafieldsSet?.userErrors || [];

              if (userErrors.length) {
                const errMsg = userErrors.map(e => e.message).join(', ');
                for (const mf of batch) {
                  const isProduct = mf.ownerId === pid;
                  log.push({ type: isProduct ? 'product' : 'variant', sku, handle,
                    status: 'error', message: `metafieldsSet failed: ${errMsg}` });
                  failed++;
                }
              } else {
                for (const mf of batch) {
                  const isProduct = mf.ownerId === pid;
                  const oldVal    = overwriteMap.get(mf.ownerId);
                  if (isProduct) {
                    productCodeWritten.add(pid);
                    const msg = oldVal
                      ? `Overwrote custom.product_code: "${oldVal}" → "${mf.value}" on "${title}"`
                      : `Set custom.product_code = "${mf.value}" on "${title}" (new)`;
                    log.push({ type: 'product', sku, handle,
                      status: oldVal ? 'overwrite' : 'synced', message: msg, productCode: mf.value, variantCode: '' });
                  } else {
                    const msg = oldVal
                      ? `Overwrote custom.variant_code: "${oldVal}" → "${mf.value}" on variant ${sku} in "${title}"`
                      : `Set custom.variant_code = "${mf.value}" on variant ${sku} in "${title}" (new)`;
                    log.push({ type: 'variant', sku, handle,
                      status: oldVal ? 'overwrite' : 'synced', message: msg, productCode: '', variantCode: mf.value });
                  }
                  synced++;
                  if (oldVal) overwriteCount++; else newCount++;
                }
              }
            }

            await sleep(180);
          }

          // Mark product as handled even if everything was already a match
          productCodeWritten.add(pid);
        }
      } // end byProduct loop

    } catch (err) {
      const msg = err.response?.data?.errors || err.message;
      console.error(`  ✗ [${sku}] Error: ${String(msg)}`);
      log.push({ type: 'variant', sku, handle: '-', status: 'error', message: String(msg) });
      failed++;
    }

    // Progress heartbeat after every unique SKU
    processed++;
    send({ type: 'progress', processed, totalProducts, synced, newCount, overwriteCount, skipped, failed });

    if (processed % 50 === 0 || processed === totalProducts) {
      console.log(`  … ${processed}/${totalProducts} SKUs done — synced: ${synced}, skipped: ${skipped}, failed: ${failed}`);
    }

    if (dryRun) await sleep(60); // light throttle between SKU queries in dry-run
  }

  // ── outer catch ────────────────────────────────────────────────────────
  } catch (outerErr) {
    console.error(`  ✗ Unexpected outer error at SKU ${processed}/${totalProducts}:`, outerErr.message, outerErr.stack);
    send({ type: 'done', success: false, error: `Server error at SKU ${processed}/${totalProducts}: ${outerErr.message}`,
      dryRun, synced, newCount, overwriteCount, skipped, failed, total: toSync.length, log });
    res.end();
    return;
  }

  console.log(`  ✓ Done — synced: ${synced} (new: ${newCount}, overwrites: ${overwriteCount}), skipped: ${skipped}, failed: ${failed}`);
  send({ type: 'done', success: true, dryRun, synced, newCount, overwriteCount, skipped, failed, total: toSync.length, log });
  res.end();
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