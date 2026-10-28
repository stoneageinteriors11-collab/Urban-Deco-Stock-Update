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
 *      Shopify variant_code / product_code still found in the CFS feeds, BUT the
 *      SKU's own CFS IDs are not → matchStatus = 'code-only'
 *        (only an old saved code matches — the code may now belong to a different
 *         CFS product; shown for a human to check, never actioned automatically)
 *
 *   e) Not found in any check → matchStatus = 'orphaned'
 *
 * matchStatus values:
 *   'ok'          — variant is accounted for in CFS feeds; no action needed
 *   'draft'       — product is already Draft/Archived on Shopify; skip
 *   'cfs-inactive'— product exists in CFS but is marked Inactive there
 *   'cfs-product' — raw prodId found in CFS Product Id column; exists as a CFS product,
 *                   not as a CFS variant — surface for review/restructuring
 *   'code-only'   — SKU not in CFS, only an old saved code matches; check
 *   'orphaned'    — not found anywhere in CFS; candidate for deletion/drafting
 *
 * Every row also gets sharedSkuHandles: other Shopify products using the same SKU.
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

// CFS variant number that belongs to a DIFFERENT CFS product — e.g. Batilda Black/Anthracite
// "UD-1271925-17373742": 17373742 is Cream's (1271926) "2 x Chairs"; Anthracite's is 17373736.
// ownerOf(varId) → { prodId, option } | undefined;  varsOf(prodId) → [{ varId, option }] | undefined
// Returns null when the pairing is fine (or unknown), else { ownerProdId, ownerOption, fixedSku|null, option }.
// The right SKU is picked by matching the option text (e.g. "2 x Chairs"): first the Shopify options,
// then the option of the variant the number really belongs to. Only a single clear match is used.
const normOpt = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
function wrongPairing(sku, ownerOf, varsOf, shopifyOptions = []) {
  const { prodId, varId } = parseSku(String(sku || ''));
  if (!prodId || !varId) return null;
  const own = ownerOf(varId);
  if (!own || own.prodId == null || String(own.prodId) === prodId) return null;
  const mine = varsOf(prodId) || [];
  const pickOne = want => { const m = mine.filter(v => normOpt(v.option) && normOpt(v.option) === want); return m.length === 1 ? m[0] : null; };
  let hit = null;
  for (const o of shopifyOptions.map(normOpt).filter(Boolean)) { hit = pickOne(o); if (hit) break; }
  if (!hit && own.option) hit = pickOne(normOpt(own.option));
  return { ownerProdId: String(own.prodId), ownerOption: own.option || '', fixedSku: hit ? `UD-${prodId}-${hit.varId}` : null, option: hit ? hit.option : '' };
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
  cfsVarInfo              = null,      // { owner: Map(varId → {prodId, option}), byProd: Map(prodId → [{varId, option}]) }
) {
  const results = [];

  // Shopify statuses treated as "already inactive — skip CFS check"
  const SHOPIFY_INACTIVE = new Set(['draft', 'archived']);

  for (const v of shopifyVariants) {
    const sku           = v.variantSku;
    const shopifyStatus = (v.status || '').toLowerCase();

    let matchStatus;
    let codeOnlyNote = '';
    let fixedSku = '';

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

    } else if (cleanSku(sku) !== sku && (validVariantSKUs.has(cleanSku(sku)) || validProductSKUs.has(cleanSku(sku)))) {
      // SKU typo — only matches CFS once spaces / stray characters are removed
      // (e.g. "UD-1244787- 17221688" → "UD-1244787-17221688"). Fixed with "Fix Selected SKUs".
      matchStatus = 'sku-typo';
      codeOnlyNote = `SKU "${sku}" has a typo — CFS has "${cleanSku(sku)}"`;

    } else {
      // Step 2c — split SKU into raw IDs and check CFS feed columns directly.
      const { prodId, varId } = parseSku(sku);
      // Is the variant number really this product's? (it may belong to another CFS product)
      const wp = cfsVarInfo ? wrongPairing(sku, id => cfsVarInfo.owner.get(id), id => cfsVarInfo.byProd.get(id), [v.option1, v.option2, v.option3]) : null;
      const wpNote = wp ? `variant no. ${varId} belongs to another CFS product (${wp.ownerProdId}${wp.ownerOption ? ` "${wp.ownerOption}"` : ''}), not ${prodId}` : '';

      if (wp && wp.fixedSku) {
        // Wrong variant number → fix the SKU to this product's own variant with the same option
        matchStatus = 'sku-typo';
        fixedSku = wp.fixedSku;
        codeOnlyNote = `Wrong SKU — ${wpNote}. CFS has ${wp.fixedSku}${wp.option ? ` for "${wp.option}"` : ''}`;

      } else if (wp) {
        // Wrong variant number and no clear match on this product → not in CFS
        matchStatus = 'orphaned';
        codeOnlyNote = `Wrong SKU — ${wpNote}; no matching variant found on CFS product ${prodId}`;

      } else if (varId && cfsVariantAttrIds.has(varId)) {
        // Raw variant attr ID found in CFS variant feed → variant exists, just different SKU
        matchStatus = 'ok';

      } else if (prodId && cfsProductIds.has(prodId)) {
        // Raw product ID found in CFS product feed, but no variant match →
        // this Shopify variant corresponds to a CFS product entry (not a variant).
        // Surface separately so it can be reviewed / promoted to main product.
        matchStatus = 'cfs-product';

      } else if (v.shopifyVariantCode && cfsVarCodeSet.has(v.shopifyVariantCode)) {
        // Deep search — Step 2d(i): only the saved custom.variant_code matches.
        // The SKU itself isn't in CFS, so the code may now belong to another
        // CFS product → flag for a human, don't treat as OK.
        matchStatus = 'code-only';
        codeOnlyNote = `saved variant code "${v.shopifyVariantCode}" is in CFS, but SKU ${sku} is not`;

      } else if (v.shopifyProductCode && cfsProductCodeToStatus.has(v.shopifyProductCode)) {
        // Deep search — Step 2d(ii): only the saved custom.product_code matches.
        matchStatus = 'code-only';
        codeOnlyNote = `saved product code "${v.shopifyProductCode}" is in CFS, but SKU ${sku} is not`;

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

    results.push({ ...v, ...(matchStatus === 'sku-typo' && { fixedSku: fixedSku || cleanSku(sku) }), matchStatus, productCode, variantCode, productCodeOnly, ...(cfsProductStatus !== undefined && { cfsProductStatus }),
      ...(codeOnlyNote && { codeOnlyNote }) });
  }

  // Same SKU on more than one Shopify product → note the other products on each row
  const handlesBySku = new Map();
  for (const r of results) {
    if (!r.variantSku) continue;
    if (!handlesBySku.has(r.variantSku)) handlesBySku.set(r.variantSku, new Set());
    handlesBySku.get(r.variantSku).add(r.handle);
  }
  for (const r of results) {
    const hs = handlesBySku.get(r.variantSku);
    r.sharedSkuHandles = hs && hs.size > 1 ? [...hs].filter(h => h !== r.handle) : [];
  }

  const orphaned    = results.filter(r => r.matchStatus === 'orphaned').length;
  const ok          = results.filter(r => r.matchStatus === 'ok').length;
  const draft       = results.filter(r => r.matchStatus === 'draft').length;
  const cfsInactive = results.filter(r => r.matchStatus === 'cfs-inactive').length;
  const cfsProduct  = results.filter(r => r.matchStatus === 'cfs-product').length;
  const codeOnly    = results.filter(r => r.matchStatus === 'code-only').length;
  const skuTypo     = results.filter(r => r.matchStatus === 'sku-typo').length;
  const sharedSku   = results.filter(r => r.sharedSkuHandles.length).length;

  return { results, summary: { total: results.length, orphaned, ok, draft, cfsInactive, cfsProduct, codeOnly, skuTypo, sharedSku } };
}

// Clean form of a SKU: no spaces/invisible characters, upper-case UD prefix, single dashes,
// no stray dash or dot at the ends. "UD-1244787- 17221688" → "UD-1244787-17221688"
function cleanSku(sku) {
  return String(sku || '').replace(/[\s\u200B-\u200D\uFEFF]+/g, '').replace(/^ud-/i, 'UD-')
    .replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
}

module.exports = { compareVariants, parseSku, cleanSku, wrongPairing };