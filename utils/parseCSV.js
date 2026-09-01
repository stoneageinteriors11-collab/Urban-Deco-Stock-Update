const fs   = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const XLSX = require('xlsx');

// ── File type detection ───────────────────────────────────────────────────────
function isExcel(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.xlsx' || ext === '.xls';
}

// ── CSV streaming (memory-efficient for large files) ──────────────────────────
function parseCSVFile(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        bom: true,
      }))
      .on('data', row => rows.push(row))
      .on('end',  () => resolve(rows))
      .on('error', reject);
  });
}

// ── XLSX parsing (SheetJS — reads first sheet) ────────────────────────────────
function parseXLSXFile(filePath) {
  const wb   = XLSX.readFile(filePath);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  // raw:false → all values as strings; defval:'' → empty cells become ''
  return XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
}

// ── Unified entry point ───────────────────────────────────────────────────────
// Returns Promise<Array of row objects> regardless of file type
async function getRows(filePath) {
  if (isExcel(filePath)) return parseXLSXFile(filePath);
  return parseCSVFile(filePath);
}

// ── CFS Product feed → Map of short product SKUs → CFS status ────────────────
// Map value is the normalised status string: 'active' | 'inactive'
// The CFS product feed has a "Status" column with values "Active" / "Inactive".
async function streamProductSKUs(filePath) {
  const rows = await getRows(filePath);
  const skus = new Map(); // SKU → 'active' | 'inactive'
  for (const row of rows) {
    const sku    = String(row['Shopify SKU'] || '').trim();
    const status = String(row['Status']      || '').trim().toLowerCase();
    if (sku) skus.set(sku, status || 'active'); // default to active if missing
  }
  return skus;
}

// ── CFS Variant feed → Set of full variant SKUs (UD-{ProductId}-{VariantId}) ──
async function streamVariantSKUs(filePath) {
  const rows = await getRows(filePath);
  const skus = new Set();
  for (const row of rows) {
    const sku = String(row['Shopify SKU'] || '').trim();
    if (sku) skus.add(sku);
  }
  return skus;
}

// Column names for the Shopify metafield export columns (synced by the sync tool)
const COL_SHOPIFY_PRODUCT_CODE = 'Metafield: custom.product_code [single_line_text_field]';
const COL_SHOPIFY_VARIANT_CODE = 'Variant Metafield: custom.variant_code [single_line_text_field]';

// ── Shopify export → array of variant objects ─────────────────────────────────
// Status is only populated on the first row of each product in standard CSV
// exports. We track the last-seen status per handle so every variant row
// inherits its product's status correctly.
// product_code is also only on the first row per product — we carry it forward
// the same way.
async function streamShopifyVariants(filePath) {
  const rows            = await getRows(filePath);
  const variants        = [];
  const statusByHandle  = {}; // handle → last seen non-empty status
  const prodCodeByHandle = {}; // handle → last seen non-empty product_code metafield

  for (const row of rows) {
    const handle = String(row['Handle'] || '').trim();
    if (!handle) continue;

    // Capture status whenever the row has one (even if no SKU)
    const rowStatus = String(row['Status'] || '').trim();
    if (rowStatus) statusByHandle[handle] = rowStatus;

    // Capture product_code whenever the row has one — it only appears on the
    // first variant row of each product in the Shopify metafield export.
    const rowProdCode = String(row[COL_SHOPIFY_PRODUCT_CODE] || '').trim();
    if (rowProdCode) prodCodeByHandle[handle] = rowProdCode;

    const sku = String(row['Variant SKU'] || '').trim();
    if (!sku) continue; // skip image-only / header rows

    variants.push({
      handle,
      title:        String(row['Title']                || '').trim(),
      variantSku:   sku,
      option1:      String(row['Option1 Value']        || '').trim(),
      option2:      String(row['Option2 Value']        || '').trim(),
      option3:      String(row['Option3 Value']        || '').trim(),
      price:        String(row['Variant Price']         || '').trim(),
      barcode:      String(row['Variant Barcode']       || '').trim(),
      inventoryQty: String(row['Variant Inventory Qty'] || '').trim(),
      // Use the captured status; fall back to the handle's inherited status
      status:       rowStatus || statusByHandle[handle] || '',
      // Codes already written to Shopify metafields — used as a fallback match signal
      shopifyVariantCode: String(row[COL_SHOPIFY_VARIANT_CODE] || '').trim(),
      shopifyProductCode: rowProdCode || prodCodeByHandle[handle] || '',
    });
  }
  return variants;
}

// ── CFS Product feed → Map of raw Product IDs → CFS status ───────────────────
// Used for the "all variants orphaned" check and cfs-product status propagation.
// Map value is normalised status: 'active' | 'inactive'
async function streamProductIds(filePath) {
  const rows = await getRows(filePath);
  const ids = new Map(); // prodId → 'active' | 'inactive'
  for (const row of rows) {
    const id     = String(row['Product Id'] || '').trim();
    const status = String(row['Status']     || '').trim().toLowerCase();
    if (id) ids.set(id, status === 'inactive' ? 'inactive' : 'active');
  }
  return ids;
}

// ── CFS Variant feed → Set of raw variant attribute IDs ──────────────────────
// Used for the same "all variants orphaned" check: extract {varid} from
// UD-{prodid}-{varid} and verify against this set before setting to DRAFT.
async function streamVariantAttrIds(filePath) {
  const rows = await getRows(filePath);
  const ids = new Set();
  for (const row of rows) {
    const id = String(row['iProAttrId'] || '').trim();
    if (id) ids.add(id);
  }
  return ids;
}

// ── CFS Product feed → product code maps ─────────────────────────────────────
// Returns {
//   bySku:    Map<shopifySku, code>,      — used to set the metafield value
//   byProdId: Map<prodId, code>,          — fallback by raw product ID
//   byCode:   Map<productCode, status>,   — reverse lookup: code → 'active'|'inactive'
// }
// The `byCode` map enables "deep search" matching: if a Shopify variant's
// already-synced product_code metafield matches a code in the CFS product feed,
// we treat the product as matched (even if the SKU no longer appears in the feed).
async function streamProductCodes(filePath) {
  const rows    = await getRows(filePath);
  const bySku    = new Map();
  const byProdId = new Map();
  const byCode   = new Map(); // Product Code → 'active' | 'inactive'
  for (const row of rows) {
    const sku    = String(row['Shopify SKU']  || '').trim();
    const id     = String(row['Product Id']   || '').trim();
    const code   = String(row['Product Code'] || '').trim();
    const status = String(row['Status']       || '').trim().toLowerCase();
    const normStatus = status === 'inactive' ? 'inactive' : 'active';
    if (sku  && code) bySku.set(sku, code);
    if (id   && code) byProdId.set(id, code);
    if (code)         byCode.set(code, normStatus);
  }
  return { bySku, byProdId, byCode };
}

// ── CFS Variant feed → variant code maps ─────────────────────────────────────
// Returns {
//   bySku:    Map<shopifySku, code>,    — used to set the metafield value
//   byAttrId: Map<iProAttrId, code>,   — fallback by raw attr ID
//   codeSet:  Set<varCode>,            — all var_code values that exist in CFS
// }
// The `codeSet` enables "deep search" matching: if a Shopify variant's
// already-synced variant_code metafield is in codeSet, we know the CFS feed
// still carries that product code and the variant is not orphaned.
async function streamVariantCodes(filePath) {
  const rows    = await getRows(filePath);
  const bySku    = new Map();
  const byAttrId = new Map();
  const codeSet  = new Set(); // all var_code values present in CFS variant feed
  for (const row of rows) {
    const sku    = String(row['Shopify SKU'] || '').trim();
    const attrId = String(row['iProAttrId']  || '').trim();
    const code   = String(row['var_code']    || '').trim();
    if (sku    && code) bySku.set(sku, code);
    if (attrId && code) byAttrId.set(attrId, code);
    if (code)           codeSet.add(code);
  }
  return { bySku, byAttrId, codeSet };
}

// ── CFS Product feed → stock / delivery data ──────────────────────────────────
// Returns { bySku: Map<shopifySku, data>, byProdId: Map<prodId, data> }
// data = { deliveryTime, inOutStock, onHand, dueDate }
async function streamProductStockData(filePath) {
  const rows    = await getRows(filePath);
  const bySku    = new Map();
  const byProdId = new Map();
  for (const row of rows) {
    const sku          = String(row['Shopify SKU']   || '').trim();
    const prodId       = String(row['Product Id']    || '').trim();
    const deliveryTime = String(row['Delivery Time'] || '').trim();
    const inOutStock   = String(row['inOutStock']    || '').trim();
    const onHand       = parseInt(String(row['OnHand'] || '0')) || 0;
    const dueDate      = String(row['DueDate']       || '').trim();
    const data = { deliveryTime, inOutStock, onHand, dueDate };
    if (sku)    bySku.set(sku, data);
    if (prodId) byProdId.set(prodId, data);
  }
  return { bySku, byProdId };
}

// ── CFS Variant feed → variant stock data ─────────────────────────────────────
// Returns { bySku: Map<shopifySku, data>, byAttrId: Map<iProAttrId, data> }
// data = { vNotificationTitle, vOnHand, vDueDate, vinOutStock }
async function streamVariantStockData(filePath) {
  const rows    = await getRows(filePath);
  const bySku    = new Map();
  const byAttrId = new Map();
  for (const row of rows) {
    const sku                = String(row['Shopify SKU']        || '').trim();
    const attrId             = String(row['iProAttrId']         || '').trim();
    const vNotificationTitle = String(row['vNotificationTitle'] || '').trim();
    const vOnHand            = parseInt(String(row['vOnHand']   || '0')) || 0;
    const vDueDate           = String(row['vDueDate']           || '').trim();
    const vinOutStock        = String(row['vinOutStock']        || '').trim();
    const data = { vNotificationTitle, vOnHand, vDueDate, vinOutStock };
    if (sku)    bySku.set(sku, data);
    if (attrId) byAttrId.set(attrId, data);
  }
  return { bySku, byAttrId };
}

// ── Legacy helpers (kept for compatibility) ───────────────────────────────────
function extractVariantSKUs(rows) {
  const skus = new Set();
  for (const row of rows) {
    const sku = (row['Shopify SKU'] || '').trim();
    if (sku) skus.add(sku);
  }
  return skus;
}

function extractShopifyVariants(rows) {
  const variants = [];
  for (const row of rows) {
    const sku = (row['Variant SKU'] || '').trim();
    if (!sku || !row['Handle']) continue;
    variants.push({
      handle:       (row['Handle']               || '').trim(),
      title:        (row['Title']                || '').trim(),
      variantSku:   sku,
      option1:      (row['Option1 Value']        || '').trim(),
      option2:      (row['Option2 Value']        || '').trim(),
      option3:      (row['Option3 Value']        || '').trim(),
      price:        (row['Variant Price']         || '').trim(),
      barcode:      (row['Variant Barcode']       || '').trim(),
      inventoryQty: (row['Variant Inventory Qty'] || '').trim(),
      status:       (row['Status']               || '').trim(),
    });
  }
  return variants;
}

module.exports = {
  getRows,
  streamProductSKUs,
  streamVariantSKUs,
  streamShopifyVariants,
  streamProductIds,
  streamVariantAttrIds,
  streamProductCodes,
  streamVariantCodes,
  streamProductStockData,
  streamVariantStockData,
  parseCSVFile,
  extractVariantSKUs,
  extractShopifyVariants,
};