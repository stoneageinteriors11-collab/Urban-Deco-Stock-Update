const fs = require('fs');
const { parse } = require('csv-parse/sync');

/**
 * Parse a CSV file and return array of row objects
 */
function parseCSVFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return parseCSVString(content);
}

/**
 * Parse a CSV string and return array of row objects
 */
function parseCSVString(content) {
  return parse(content, {
    columns: true,        // use first row as keys
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    bom: true,            // handle BOM characters
  });
}

/**
 * Extract valid Shopify SKUs from the non-Shopify variant Froogle CSV
 * Column used: "Shopify SKU"  e.g. UD-144246-16985763
 */
function extractVariantSKUs(rows) {
  const skus = new Set();
  for (const row of rows) {
    const sku = (row['Shopify SKU'] || '').trim();
    if (sku) skus.add(sku);
  }
  return skus;
}

/**
 * Extract all variants from Shopify export CSV(s)
 * Column used: "Variant SKU"
 * Also captures: Handle, Title, Option1 Value, Option2 Value, Variant Barcode
 */
function extractShopifyVariants(rows) {
  const variants = [];
  for (const row of rows) {
    const sku = (row['Variant SKU'] || '').trim();
    // Skip rows with no SKU or no handle (image-only rows in Shopify export)
    if (!sku || !row['Handle']) continue;

    variants.push({
      handle:       (row['Handle'] || '').trim(),
      title:        (row['Title'] || '').trim(),
      variantSku:   sku,
      option1:      (row['Option1 Value'] || '').trim(),
      option2:      (row['Option2 Value'] || '').trim(),
      option3:      (row['Option3 Value'] || '').trim(),
      price:        (row['Variant Price'] || '').trim(),
      barcode:      (row['Variant Barcode'] || '').trim(),
      inventoryQty: (row['Variant Inventory Qty'] || '').trim(),
      status:       (row['Status'] || '').trim(),
    });
  }
  return variants;
}

module.exports = { parseCSVFile, parseCSVString, extractVariantSKUs, extractShopifyVariants };
