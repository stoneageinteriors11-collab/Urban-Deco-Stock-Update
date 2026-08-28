/**
 * Compare Shopify variants against CFS feeds.
 *
 * Step 1 — Shopify product status check:
 *   Draft / Archived → matchStatus = 'draft'  (already inactive; skip CFS check)
 *   Active / Unlisted / unknown → proceed to step 2
 *
 * Step 2 — CFS feed lookup (direct, no extraction):
 *   a) Check full SKU against variant feed (Set)
 *      Found → matchStatus = 'ok'
 *
 *   b) Check SKU against product feed (Map: SKU → CFS status)
 *      Found AND CFS status is 'active'   → matchStatus = 'ok'
 *      Found AND CFS status is 'inactive' → matchStatus = 'draft'
 *                                           (product exists on CFS but is inactive
 *                                            → Shopify product should be set to draft)
 *
 *   c) Not found in either feed → matchStatus = 'orphaned'
 *
 * @param {Array}  shopifyVariants   — from streamShopifyVariants()
 * @param {Set}    validVariantSKUs  — from streamVariantSKUs()   (full UD-x-y format)
 * @param {Map}    validProductSKUs  — from streamProductSKUs()   (short UD-x → 'active'|'inactive')
 */
function compareVariants(shopifyVariants, validVariantSKUs, validProductSKUs = new Map()) {
  const results = [];

  // Shopify statuses treated as "already inactive — skip CFS check"
  const SHOPIFY_INACTIVE = new Set(['draft', 'archived']);

  for (const v of shopifyVariants) {
    const sku          = v.variantSku;
    const shopifyStatus = (v.status || '').toLowerCase();

    let matchStatus;

    if (SHOPIFY_INACTIVE.has(shopifyStatus)) {
      // Product is already draft/archived on Shopify — no action needed
      matchStatus = 'draft';

    } else if (validVariantSKUs.has(sku)) {
      // Exact match in CFS variant feed → OK
      matchStatus = 'ok';

    } else if (validProductSKUs.has(sku)) {
      // Matched in CFS product feed — honour the CFS product's status
      const cfsStatus = validProductSKUs.get(sku); // 'active' | 'inactive'
      // 'cfs-inactive' = active on Shopify but CFS product is inactive → needs set-to-draft action
      matchStatus = cfsStatus === 'inactive' ? 'cfs-inactive' : 'ok';

    } else {
      // Not in either feed → orphaned
      matchStatus = 'orphaned';
    }

    results.push({ ...v, matchStatus });
  }

  const orphaned    = results.filter(r => r.matchStatus === 'orphaned').length;
  const ok          = results.filter(r => r.matchStatus === 'ok').length;
  const draft       = results.filter(r => r.matchStatus === 'draft').length;
  const cfsInactive = results.filter(r => r.matchStatus === 'cfs-inactive').length;

  return { results, summary: { total: results.length, orphaned, ok, draft, cfsInactive } };
}

module.exports = { compareVariants };