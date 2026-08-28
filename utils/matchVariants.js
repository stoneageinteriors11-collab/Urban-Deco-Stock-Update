/**
 * Compare Shopify variants against CFS feeds.
 *
 * Matching rules:
 *
 *  — If variant feed IS provided:
 *      Use ONLY the variant feed.
 *      OK = full SKU (UD-{ProductId}-{VariantId}) exists in variant feed.
 *      Orphaned = full SKU not in variant feed (even if product exists in product feed).
 *
 *  — If variant feed is NOT provided (only product feed uploaded):
 *      Fall back to product-level check.
 *      OK = product-ID portion (UD-{ProductId}) exists in product feed.
 *      Orphaned = product not found at all.
 *
 * Why: the variant feed is the definitive source of which specific variants
 * are live on CFS. A product existing on CFS doesn't mean all its variants do.
 *
 * @param {Array}  shopifyVariants   — from streamShopifyVariants()
 * @param {Set}    validVariantSKUs  — from streamVariantSKUs()  (full UD-x-y format)
 * @param {Set}    validProductSKUs  — from streamProductSKUs()  (short UD-x format)
 */
function compareVariants(shopifyVariants, validVariantSKUs, validProductSKUs = new Set()) {
  const useVariantFeed = validVariantSKUs.size > 0;
  const results = [];

  for (const v of shopifyVariants) {
    const sku = v.variantSku;
    let inFeed;

    if (useVariantFeed) {
      // Variant feed uploaded → exact match only, no product-level fallback
      inFeed = validVariantSKUs.has(sku);
    } else {
      // No variant feed → product-level fallback (UD-144246-16985763 → UD-144246)
      const parts     = sku.split('-');
      const productId = parts.slice(0, 2).join('-');
      inFeed = validProductSKUs.has(productId);
    }

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