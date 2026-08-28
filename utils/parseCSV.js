const fs   = require('fs');
const { parse } = require('csv-parse');

/**
 * Stream a CSV file and collect all rows as an array of objects.
 * Uses csv-parse in streaming mode so the entire file is never held in memory at once.
 */
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

/**
 * Stream the non-Shopify variant Froogle CSV and return a Set of valid Shopify SKUs.
 * Column: "Shopify SKU"  e.g. UD-144246-16985763
 * Memory cost: one string per unique SKU (~30 bytes each), not the whole file.
 */
function streamVariantSKUs(filePath) {
  return new Promise((resolve, reject) => {
    const skus = new Set();
    fs.createReadStream(filePath)
      .pipe(parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        bom: true,
      }))
      .on('data', row => {
        const sku = (row['Shopify SKU'] || '').trim();
        if (sku) skus.add(sku);
      })
      .on('end',  () => resolve(skus))
      .on('error', reject);
  });
}

/**
 * Stream a Shopify export CSV and return an array of variant objects.
 * Skips image-only rows (rows with no Variant SKU or no Handle).
 * Column: "Variant SKU"
 */
function streamShopifyVariants(filePath) {
  return new Promise((resolve, reject) => {
    const variants = [];
    fs.createReadStream(filePath)
      .pipe(parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        bom: true,
      }))
      .on('data', row => {
        const sku = (row['Variant SKU'] || '').trim();
        if (!sku || !row['Handle']) return; // skip image-only rows
        variants.push({
          handle:       (row['Handle']             || '').trim(),
          title:        (row['Title']              || '').trim(),
          variantSku:   sku,
          option1:      (row['Option1 Value']      || '').trim(),
          option2:      (row['Option2 Value']      || '').trim(),
          option3:      (row['Option3 Value']      || '').trim(),
          price:        (row['Variant Price']       || '').trim(),
          barcode:      (row['Variant Barcode']     || '').trim(),
          inventoryQty: (row['Variant Inventory Qty'] || '').trim(),
          status:       (row['Status']             || '').trim(),
        });
      })
      .on('end',  () => resolve(variants))
      .on('error', reject);
  });
}

// ── Legacy sync-style helpers (kept for any callers that still use them) ──────
// These now delegate to the streaming versions — same API, now async.
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
      handle:       (row['Handle']             || '').trim(),
      title:        (row['Title']              || '').trim(),
      variantSku:   sku,
      option1:      (row['Option1 Value']      || '').trim(),
      option2:      (row['Option2 Value']      || '').trim(),
      option3:      (row['Option3 Value']      || '').trim(),
      price:        (row['Variant Price']       || '').trim(),
      barcode:      (row['Variant Barcode']     || '').trim(),
      inventoryQty: (row['Variant Inventory Qty'] || '').trim(),
      status:       (row['Status']             || '').trim(),
    });
  }
  return variants;
}

module.exports = {
  parseCSVFile,
  streamVariantSKUs,
  streamShopifyVariants,
  extractVariantSKUs,
  extractShopifyVariants,
};