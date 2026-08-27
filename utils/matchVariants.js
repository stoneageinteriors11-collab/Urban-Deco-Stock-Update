/**
 * Compare Shopify variants against valid SKUs from the non-Shopify variant feed.
 *
 * Match key: "Shopify SKU" (non-Shopify feed) === "Variant SKU" (Shopify export)
 * Format:    UD-{ProductId}-{VariantAttrId}   e.g. UD-144246-16985763
 *
 * Returns every Shopify variant tagged as "orphaned" (not in non-Shopify feed)
 * or "ok" (still exists on non-Shopify site).
 */
function compareVariants(shopifyVariants, validSKUs) {
  const results = [];

  for (const v of shopifyVariants) {
    const inFeed = validSKUs.has(v.variantSku);
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
