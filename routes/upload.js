const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { streamProductSKUs, streamVariantSKUs, streamShopifyVariants, streamProductIds, streamVariantAttrIds, streamProductCodes, streamVariantCodes } = require('../utils/parseCSV');
const { compareVariants } = require('../utils/matchVariants');

const router = express.Router();

const ALLOWED_EXTS = ['.csv', '.xlsx', '.xls'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTS.includes(ext)) return cb(null, true);
    cb(new Error(`Only CSV and Excel files are allowed (got ${ext})`));
  },
});

function tryUnlink(filePath) {
  try { fs.unlinkSync(filePath); } catch (_) {}
}

// ── POST /api/compare ────────────────────────────────────────────────────────
// Required:  productFeed, shopifyFile1
// Optional:  variantFeed, shopifyFile2
//
// Matching (two-step):
//   1. Full SKU vs variant feed (exact)
//   2. Product-ID portion vs product feed (fallback)
//   Orphaned only if BOTH checks fail.
router.post(
  '/compare',
  upload.fields([
    { name: 'productFeed',  maxCount: 1 },
    { name: 'variantFeed',  maxCount: 1 },
    { name: 'shopifyFile1', maxCount: 1 },
    { name: 'shopifyFile2', maxCount: 1 },
  ]),
  async (req, res) => {
    const uploadedPaths = [];

    try {
      const files = req.files || {};

      if (!files.productFeed || !files.shopifyFile1) {
        return res.status(400).json({
          error: 'Please upload the CFS product feed and at least one Shopify export file.',
        });
      }

      const productFeedPath  = files.productFeed[0].path;
      const variantFeedPath  = files.variantFeed?.[0]?.path  || null;
      const shopifyFile1Path = files.shopifyFile1[0].path;
      const shopifyFile2Path = files.shopifyFile2?.[0]?.path || null;

      uploadedPaths.push(productFeedPath, shopifyFile1Path);
      if (variantFeedPath)  uploadedPaths.push(variantFeedPath);
      if (shopifyFile2Path) uploadedPaths.push(shopifyFile2Path);

      // 1. Product feed (required)
      console.log('▶ Streaming CFS product feed…');
      const validProductSKUs = await streamProductSKUs(productFeedPath);
      const activeCount   = [...validProductSKUs.values()].filter(s => s === 'active').length;
      const inactiveCount = validProductSKUs.size - activeCount;
      console.log(`  ✓ ${validProductSKUs.size} product SKUs (${activeCount} active, ${inactiveCount} inactive)`);

      // Also extract raw Product IDs for the all-variants-orphaned CFS presence check
      const cfsProductIds = await streamProductIds(productFeedPath);
      console.log(`  ✓ ${cfsProductIds.size} raw CFS product IDs`);

      // 2. Product feed codes
      const { bySku: productCodesBySku, byProdId: productCodesByProdId } = await streamProductCodes(productFeedPath);
      console.log(`  ✓ ${productCodesBySku.size} product codes loaded`);

      // 3. Variant feed (optional)
      let validVariantSKUs    = new Set();
      let cfsVariantAttrIds   = new Set();
      let variantCodesBySku   = new Map();
      let variantCodesByAttrId = new Map();
      if (variantFeedPath) {
        console.log('▶ Streaming CFS variant feed…');
        validVariantSKUs  = await streamVariantSKUs(variantFeedPath);
        cfsVariantAttrIds = await streamVariantAttrIds(variantFeedPath);
        const vc = await streamVariantCodes(variantFeedPath);
        variantCodesBySku    = vc.bySku;
        variantCodesByAttrId = vc.byAttrId;
        console.log(`  ✓ ${validVariantSKUs.size} variant SKUs, ${cfsVariantAttrIds.size} variant attr IDs, ${variantCodesBySku.size} variant codes`);
      } else {
        console.log('ℹ  No variant feed uploaded — using product feed only');
      }

      // 4. Shopify export(s)
      console.log('▶ Streaming Shopify export file 1…');
      const shopifyVariants = await streamShopifyVariants(shopifyFile1Path);
      console.log(`  ✓ ${shopifyVariants.length} variants from file 1`);

      if (shopifyFile2Path) {
        console.log('▶ Streaming Shopify export file 2…');
        const variants2 = await streamShopifyVariants(shopifyFile2Path);
        console.log(`  ✓ ${variants2.length} variants from file 2`);
        shopifyVariants.push(...variants2);
      }

      // 5. Four-step compare (variant feed → product feed → raw CFS IDs → orphaned)
      console.log(`▶ Comparing ${shopifyVariants.length} variants…`);
      const { results, summary } = compareVariants(
        shopifyVariants, validVariantSKUs, validProductSKUs, cfsProductIds, cfsVariantAttrIds,
        productCodesBySku, productCodesByProdId, variantCodesBySku, variantCodesByAttrId,
      );
      console.log(`  ✓ ${summary.orphaned} orphaned, ${summary.ok} OK, ${summary.draft} draft/archived, ${summary.cfsInactive} cfs-inactive, ${summary.cfsProduct} cfs-product`);

      res.json({
        success: true,
        summary,
        results,
        // cfsProductIds is now a Map<prodId, 'active'|'inactive'>; send as entries array
        // so the frontend can reconstruct the map for publish-products decisions.
        cfsProductIds:    [...cfsProductIds.entries()],  // [[prodId, status], …]
        cfsVariantAttrIds: [...cfsVariantAttrIds],
      });

    } catch (err) {
      console.error('Compare error:', err);
      res.status(500).json({ error: err.message });
    } finally {
      uploadedPaths.forEach(tryUnlink);
    }
  }
);

module.exports = router;