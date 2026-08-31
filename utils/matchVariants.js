/**
 * Compare Shopify variants against CFS feeds.
 *
 * Step 1 — Shopify product status check:
 *   Draft / Archived → matchStatus = 'draft'  (already inactive; skip CFS check)
 *   Active / Unlisted / unknown → proceed to step 2
 *
 * Step 2 — CFS feed lookup (priority order):
 *   a) Full SKU in variant feed (exact Shopify SKU match)
 *      Found → matchStatus = 'ok'
 *
 *   b) Full SKU in product feed (Map: Shopify SKU → CFS status)
 *      Found AND CFS status is 'active'   → matchStatus = 'ok'
 *      Found AND CFS status is 'inactive' → matchStatus = 'cfs-inactive'
 *
 *   c) Extract raw IDs from SKU (UD-{prodId}-{varId}):
 *      {varId}  found in cfsVariantAttrIds (iProAttrId column) → matchStatus = 'ok'
 *        (variant exists in CFS under a different SKU mapping — treat as matched)
 *      {prodId} found in cfsProductIds (Product Id column) → matchStatus = 'cfs-product'
 *        (CFS has this as a product entry but no matching variant — needs review)
 *
 *   d) Deep search — Shopify metafield codes already synced to the product:
 *      Shopify variant_code (custom.variant_code) found in cfsVarCodeSet
 *        → matchStatus = 'ok'   (CFS variant feed still carries this code)
 *      Shopify product_code (custom.product_code) found in cfsProductCodeToStatus
 *        AND CFS status is 'active'   → matchStatus = 'ok'
 *        AND CFS status is 'inactive' → matchStatus = 'cfs-inactive'
 *
 *   e) Not found in any check → matchStatus = 'orphaned'
 *
 * matchStatus values:
 *   'ok'          — variant is accounted for in CFS feeds; no action needed
 *   'draft'       — product is already Draft/Archived on Shopify; skip
 *   'cfs-inactive'— product exists in CFS but is marked Inactive there
 *   'cfs-product' — raw prodId found in CFS Product Id column; exists as a CFS product,
 *                   not as a CFS variant — surface for review/restructuring
 *   'orphaned'    — not found anywhere in CFS; candidate for deletion/drafting
 *
 * @param {Array}  shopifyVariants       — from streamShopifyVariants()
 * @param {Set}    validVariantSKUs      — from streamVariantSKUs()       (full UD-x-y format)
 * @param {Map}    validProductSKUs      — from streamProductSKUs()       (short UD-x → 'active'|'inactive')
 * @param {Set}    cfsProductIds         — from streamProductIds()        (raw Product Id values)
 * @param {Set}    cfsVariantAttrIds     — from streamVariantAttrIds()    (raw iProAttrId values)
 * @param {Map}    productCodesBySku     — from streamProductCodes().bySku
 * @param {Map}    productCodesByProdId  — from streamProductCodes().byProdId
 * @param {Map}    variantCodesBySku     — from streamVariantCodes().bySku
 * @param {Map}    variantCodesByAttrId  — from streamVariantCodes().byAttrId
 * @param {Set}    cfsVarCodeSet         — from streamVariantCodes().codeSet  (all var_code values)
 * @param {Map}    cfsProductCodeToStatus— from streamProductCodes().byCode   (Product Code → status)
 */

// Extract {prodId} and {varId} from UD-{prodId}-{varId}
function parseSku(sku) {
  const parts = sku.split('-');
  return { prodId: parts[1] || null, varId: parts[2] || null };
}

function compareVariants(
  shopifyVariants,
  validVariantSKUs,
  validProductSKUs        = new Map(),
  cfsProductIds           = new Set(),
  cfsVariantAttrIds       = new Set(),
  productCodesBySku       = new Map(),
  productCodesByProdId    = new Map(),
  variantCodesBySku       = new Map(),
  variantCodesByAttrId    = new Map(),
  cfsVarCodeSet           = new Set(), // all var_code values from CFS variant feed
  cfsProductCodeToStatus  = new Map(), // CFS Product Code → 'active'|'inactive'
) {
  const results = [];

  // Shopify statuses treated as "already inactive — skip CFS check"
  const SHOPIFY_INACTIVE = new Set(['draft', 'archived']);

  for (const v of shopifyVariants) {
    const sku           = v.variantSku;
    const shopifyStatus = (v.status || '').toLowerCase();

    let matchStatus;

    if (SHOPIFY_INACTIVE.has(shopifyStatus)) {
      // Product is already draft/archived on Shopify — no action needed
      matchStatus = 'draft';

    } else if (validVariantSKUs.has(sku)) {
      // Exact Shopify SKU match in CFS variant feed → OK
      matchStatus = 'ok';

    } else if (validProductSKUs.has(sku)) {
      // Exact Shopify SKU match in CFS product feed — honour CFS status
      const cfsStatus = validProductSKUs.get(sku); // 'active' | 'inactive'
      matchStatus = cfsStatus === 'inactive' ? 'cfs-inactive' : 'ok';

    } else {
      // Step 2c — split SKU into raw IDs and check CFS feed columns directly.
      const { prodId, varId } = parseSku(sku);

      if (varId && cfsVariantAttrIds.has(varId)) {
        // Raw variant attr ID found in CFS variant feed → variant exists, just different SKU
        matchStatus = 'ok';

      } else if (prodId && cfsProductIds.has(prodId)) {
        // Raw product ID found in CFS product feed, but no variant match →
        // this Shopify variant corresponds to a CFS product entry (not a variant).
        // Surface separately so it can be reviewed / promoted to main product.
        matchStatus = 'cfs-product';

      } else if (v.shopifyVariantCode && cfsVarCodeSet.has(v.shopifyVariantCode)) {
        // Deep search — Step 2d(i):
        // The variant's already-synced custom.variant_code exists in the CFS variant
        // feed's var_code column. SKU may have changed but the product is still live.
        matchStatus = 'ok';

      } else if (v.shopifyProductCode && cfsProductCodeToStatus.has(v.shopifyProductCode)) {
        // Deep search — Step 2d(ii):
        // The product's already-synced custom.product_code exists in the CFS product
        // feed's Product Code column. Honour the CFS status for this product.
        const cfsStatus = cfsProductCodeToStatus.get(v.shopifyProductCode);
        matchStatus = cfsStatus === 'inactive' ? 'cfs-inactive' : 'ok';

      } else {
        // Not found anywhere — SKU, raw IDs, and both code lookups all missed
        matchStatus = 'orphaned';
      }
    }

    // For cfs-product rows, carry along the CFS product status (active/inactive)
    // so the publish endpoint can decide whether to set ACTIVE or DRAFT.
    const cfsProductStatus =
      matchStatus === 'cfs-product'
        ? (cfsProductIds.get(parseSku(v.variantSku).prodId) || 'active')
        : undefined;

    // Resolve per-feed codes separately so the sync endpoint can write
    // the right value to each metafield without mixing sources.
    const { prodId, varId } = parseSku(sku);

    // custom.variant_code → var_code from variant feed only
    const variantCode =
      variantCodesBySku.get(sku)                  ||
      (varId  && variantCodesByAttrId.get(varId))  ||
      '';

    // custom.product_code → Product Code from product feed only
    const productCodeOnly =
      productCodesBySku.get(sku)                   ||
      (prodId && productCodesByProdId.get(prodId))  ||
      '';

    // Combined display value (variant code preferred; falls back to product code)
    const productCode = variantCode || productCodeOnly || '';

    results.push({ ...v, matchStatus, productCode, variantCode, productCodeOnly, ...(cfsProductStatus !== undefined && { cfsProductStatus }) });
  }

  const orphaned    = results.filter(r => r.matchStatus === 'orphaned').length;
  const ok          = results.filter(r => r.matchStatus === 'ok').length;
  const draft       = results.filter(r => r.matchStatus === 'draft').length;
  const cfsInactive = results.filter(r => r.matchStatus === 'cfs-inactive').length;
  const cfsProduct  = results.filter(r => r.matchStatus === 'cfs-product').length;

  return { results, summary: { total: results.length, orphaned, ok, draft, cfsInactive, cfsProduct } };
}

module.exports = { compareVariants, parseSku };