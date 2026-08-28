/**
 * Compare Shopify variants against CFS feeds.
 *
 * Matching rules — DIRECT lookup only (no extraction or fallback):
 *
 *   OK       = Shopify SKU found verbatim in the variant feed's "Shopify SKU" column
 *              OR Shopify SKU found verbatim in the product feed's "Shopify SKU" column
 *
 *   Orphaned = SKU not found in either feed
 *
 * Why direct lookup:
 *   - Short SKUs (UD-1242963)        → match the product feed directly
 *   - Full SKUs  (UD-170639-17280410) → match the variant feed directly
 *   Extracting the product-ID from a full SKU and checking the product feed
 *   produces false "OK" results (the product exists on CFS but the specific
 *   variant does not).
 *
 * @param {Array}  shopifyVariants   — from streamShopifyVariants()
 * @param {Set}    validVariantSKUs  — from streamVariantSKUs()  (full UD-x-y format)
 * @param {Set}    validProductSKUs  — from streamProductSKUs()  (short UD-x format)
 */
function compareVariants(shopifyVariants, validVariantSKUs, validProductSKUs = new Set()) {
  const results = [];

  for (const v of shopifyVariants) {
    const sku = v.variantSku;

    // Direct lookup in both feeds — no extraction, no fallback
    const inFeed = validVariantSKUs.has(sku) || validProductSKUs.has(sku);

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