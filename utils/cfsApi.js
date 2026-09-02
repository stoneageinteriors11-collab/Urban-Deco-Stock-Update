/**
 * CFS API utility — replaces all Froogle CSV file parsing.
 *
 * API: https://www.choicefurnituresuperstore.co.uk/productVariantStockJsonCFS.php?brandId=215
 *
 * All products returned by this API are active (no inactive products).
 *
 * Response shape (per product object):
 *   { productId, productCode, deliveryTime, stockStatus, onHand, dueDate,
 *     variants: [{ variantId, productCode, deliveryTime?, stockStatus?, onHand?, dueDate? }] }
 *
 * SKU conventions used throughout the Shopify store:
 *   Product without sub-variants → UD-{productId}
 *   Sub-variant                  → UD-{productId}-{variantId}
 */

const axios = require('axios');

const CFS_API_URL =
  'https://www.choicefurnituresuperstore.co.uk/productVariantStockJsonCFS.php?brandId=215';

// ── Fetch raw product/variant data from the CFS API ──────────────────────────
async function fetchCfsProducts() {
  const res = await axios.get(CFS_API_URL, { timeout: 60_000 });
  const data = res.data;
  if (!Array.isArray(data)) {
    throw new Error(`CFS API returned unexpected format: ${typeof data}`);
  }
  return data;
}

// ── Build the data structures compareVariants() expects ──────────────────────
//
// Returns:
//   validProductSKUs     Map<sku, 'active'>          UD-{prodId} → 'active'
//   cfsProductIds        Map<prodId, 'active'>       raw product IDs → 'active'
//   validVariantSKUs     Set<sku>                    UD-{prodId}-{varId} SKUs
//   cfsVariantAttrIds    Set<varId>                  raw variant IDs (strings)
//   productCodesBySku    Map<sku, productCode>
//   productCodesByProdId Map<prodId, productCode>
//   cfsProductCodeToStatus Map<productCode, 'active'>
//   variantCodesBySku    Map<sku, variantCode>       variant-level SKUs → var code
//   variantCodesByAttrId Map<varId, variantCode>
//   cfsVarCodeSet        Set<variantCode>
//
function buildCompareData(products) {
  const validProductSKUs       = new Map();
  const cfsProductIds          = new Map();
  const validVariantSKUs       = new Set();
  const cfsVariantAttrIds      = new Set();
  const productCodesBySku      = new Map();
  const productCodesByProdId   = new Map();
  const cfsProductCodeToStatus = new Map();
  const variantCodesBySku      = new Map();
  const variantCodesByAttrId   = new Map();
  const cfsVarCodeSet          = new Set();

  for (const item of products) {
    const prodId   = String(item.productId);
    const prodSku  = `UD-${prodId}`;
    const prodCode = item.productCode || '';

    // Product-level SKU is always present (it's the base product)
    validProductSKUs.set(prodSku, 'active');
    cfsProductIds.set(prodId, 'active');
    productCodesBySku.set(prodSku, prodCode);
    productCodesByProdId.set(prodId, prodCode);
    if (prodCode) cfsProductCodeToStatus.set(prodCode, 'active');

    // Sub-variants (if any)
    if (Array.isArray(item.variants) && item.variants.length > 0) {
      for (const v of item.variants) {
        const varId   = String(v.variantId);
        const varSku  = `UD-${prodId}-${varId}`;
        const varCode = v.productCode || '';

        validVariantSKUs.add(varSku);
        cfsVariantAttrIds.add(varId);
        variantCodesBySku.set(varSku, varCode);
        variantCodesByAttrId.set(varId, varCode);
        if (varCode) cfsVarCodeSet.add(varCode);
      }
    }
  }

  return {
    validProductSKUs,
    cfsProductIds,
    validVariantSKUs,
    cfsVariantAttrIds,
    productCodesBySku,
    productCodesByProdId,
    cfsProductCodeToStatus,
    variantCodesBySku,
    variantCodesByAttrId,
    cfsVarCodeSet,
  };
}

// ── Build skuCodeMap for the sync-metafields endpoints ───────────────────────
//
// Returns Map<sku, { productCode, variantCode }>
//
// Products without sub-variants:
//   UD-{prodId} → { productCode: item.productCode, variantCode: item.productCode }
//   (variant_code mirrors product_code because the product IS its only variant)
//
// Products with sub-variants:
//   UD-{prodId}          → { productCode, variantCode: '' }  (no var_code at prod level)
//   UD-{prodId}-{varId}  → { productCode, variantCode: v.productCode }
//
function buildSkuCodeMap(products) {
  const skuCodeMap = new Map();

  for (const item of products) {
    const prodId   = String(item.productId);
    const prodSku  = `UD-${prodId}`;
    const prodCode = item.productCode || '';

    if (!Array.isArray(item.variants) || item.variants.length === 0) {
      // No sub-variants: product-level SKU carries both codes
      skuCodeMap.set(prodSku, { productCode: prodCode, variantCode: prodCode });
    } else {
      // Has sub-variants
      skuCodeMap.set(prodSku, { productCode: prodCode, variantCode: '' });
      for (const v of item.variants) {
        const varId  = String(v.variantId);
        const varSku = `UD-${prodId}-${varId}`;
        skuCodeMap.set(varSku, { productCode: prodCode, variantCode: v.productCode || '' });
      }
    }
  }

  return skuCodeMap;
}

// ── Build stock data maps for the stock sync step ────────────────────────────
//
// Returns:
//   prodStockBySku    Map<sku, { deliveryTime, stockStatus, onHand, dueDate }>
//   prodStockByProdId Map<prodId, { deliveryTime, ... }>
//   varStockBySku     Map<sku, { vNotificationTitle, vOnHand, vDueDate, vinOutStock }>
//   varStockByAttrId  Map<varId, { vNotificationTitle, ... }>
//
// deliveryTimeIsShort() in stocksync.js uses the delivery time string to decide
// whether an item is IN STOCK or OUT OF STOCK, so that field is the critical one.
// Variant-level delivery time falls back to the parent product's when absent.
//
function buildStockData(products) {
  const prodStockBySku    = new Map();
  const prodStockByProdId = new Map();
  const varStockBySku     = new Map();
  const varStockByAttrId  = new Map();

  for (const item of products) {
    const prodId  = String(item.productId);
    const prodSku = `UD-${prodId}`;

    const productRecord = {
      deliveryTime: item.deliveryTime || '',
      stockStatus:  item.stockStatus  || '',
      onHand:       item.onHand       ?? 0,
      dueDate:      item.dueDate      || '',
    };

    prodStockBySku.set(prodSku, productRecord);
    prodStockByProdId.set(prodId, productRecord);

    if (Array.isArray(item.variants) && item.variants.length > 0) {
      for (const v of item.variants) {
        const varId  = String(v.variantId);
        const varSku = `UD-${prodId}-${varId}`;

        // Prefer variant-level fields; fall back to product-level
        const varRecord = {
          vNotificationTitle: v.deliveryTime  || item.deliveryTime  || '',
          vOnHand:            v.onHand        ?? item.onHand        ?? 0,
          vDueDate:           v.dueDate       || item.dueDate       || '',
          vinOutStock:        v.stockStatus   || item.stockStatus   || '',
        };

        varStockBySku.set(varSku, varRecord);
        varStockByAttrId.set(varId, varRecord);
      }
    }
  }

  return { prodStockBySku, prodStockByProdId, varStockBySku, varStockByAttrId };
}

module.exports = { fetchCfsProducts, buildCompareData, buildSkuCodeMap, buildStockData };