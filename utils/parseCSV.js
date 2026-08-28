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

// ── Shopify export → array of variant objects ─────────────────────────────────
// Status is only populated on the first row of each product in standard CSV
// exports. We track the last-seen status per handle so every variant row
// inherits its product's status correctly.
async function streamShopifyVariants(filePath) {
  const rows          = await getRows(filePath);
  const variants      = [];
  const statusByHandle = {}; // handle → last seen non-empty status

  for (const row of rows) {
    const handle = String(row['Handle'] || '').trim();
    if (!handle) continue;

    // Capture status whenever the row has one (even if no SKU)
    const rowStatus = String(row['Status'] || '').trim();
    if (rowStatus) statusByHandle[handle] = rowStatus;

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
  parseCSVFile,
  extractVariantSKUs,
  extractShopifyVariants,
};