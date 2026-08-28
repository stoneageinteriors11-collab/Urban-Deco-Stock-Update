/**
 * Compare Shopify variants against CFS feeds.
 *
 * Matching rules (both checks always run):
 *
 *   OK       = full SKU (UD-{ProductId}-{VariantId}) found in variant feed
 *              OR product-ID portion (UD-{ProductId}) found in product feed
 *
 *   Orphaned = full SKU NOT in variant feed  AND  product ID NOT in product feed
 *
 * This means a variant is only flagged as orphaned if it doesn't appear
 * in either the variant-level feed or the product-level feed.
 *
 * @param {Array}  shopifyVariants   — from streamShopifyVariants()
 * @param {Set}    validVariantSKUs  — from streamVariantSKUs()  (full UD-x-y format)
 * @param {Set}    validProductSKUs  — from streamProductSKUs()  (short UD-x format)
 */
function compareVariants(shopifyVariants, validVariantSKUs, validProductSKUs = new Set()) {
  const results = [];

  for (const v of shopifyVariants) {
    const sku = v.variantSku;

    // Step 1: check full SKU against variant feed
    const inVariantFeed = validVariantSKUs.size > 0 && validVariantSKUs.has(sku);

    // Step 2: check product-ID portion against product feed (UD-144246-16985763 → UD-144246)
    const parts     = sku.split('-');
    const productId = parts.slice(0, 2).join('-');
    const inProductFeed = validProductSKUs.has(productId);

    // OK if found in either feed; orphaned only if missing from both
    const inFeed = inVariantFeed || inProductFeed;

    results.push({
      ...v,
      matchStatus: inFeed ? 'ok' : 'orphaned',
    });
  }

  const orphaned = results.filter(r => r.matchStatus === 'orphaned').length;
  const ok       = results.filter(r => r.matchStatus === 'ok').length;

  return { results, summary: { total: results.length, orphaned, ok } };
}

module.exports = { compareVariants };