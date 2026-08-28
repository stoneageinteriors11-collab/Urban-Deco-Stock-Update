/**
 * Compare Shopify variants against both CFS feeds using a two-step check:
 *
 *  Step 1 — Variant feed match (exact):
 *    Full SKU  "UD-144246-16985763"  must exist in the variant feed Set.
 *
 *  Step 2 — Product feed match (fallback):
 *    Extract the product-ID portion  "UD-144246"  and check the product feed Set.
 *    If the product is still listed on CFS, the variant is considered OK even if
 *    the specific variant isn't in the variant feed yet.
 *
 *  Only if BOTH checks fail is the variant tagged "orphaned".
 *
 * @param {Array}  shopifyVariants   — from streamShopifyVariants()
 * @param {Set}    validVariantSKUs  — from streamVariantSKUs()   (full SKU format)
 * @param {Set}    validProductSKUs  — from streamProductSKUs()   (short UD-{id} format)
 */
function compareVariants(shopifyVariants, validVariantSKUs, validProductSKUs = new Set()) {
  const results = [];

  for (const v of shopifyVariants) {
    const sku = v.variantSku;

    // Step 1: exact variant match
    let inFeed = validVariantSKUs.has(sku);

    // Step 2: product-level fallback (UD-144246-16985763 → UD-144246)
    if (!inFeed && validProductSKUs.size > 0) {
      const parts = sku.split('-');         // ['UD', '144246', '16985763']
      const productId = parts.slice(0, 2).join('-'); // 'UD-144246'
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