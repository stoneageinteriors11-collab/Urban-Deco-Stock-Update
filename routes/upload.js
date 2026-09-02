const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { streamShopifyVariants } = require('../utils/parseCSV');
const { compareVariants }       = require('../utils/matchVariants');
const { fetchCfsProducts, buildCompareData } = require('../utils/cfsApi');

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
// Required uploads: shopifyFile1
// Optional uploads: shopifyFile2
//
// CFS product/variant data is now fetched directly from the CFS API —
// no file uploads required for the CFS feeds.
//
router.post(
  '/compare',
  upload.fields([
    { name: 'shopifyFile1', maxCount: 1 },
    { name: 'shopifyFile2', maxCount: 1 },
  ]),
  async (req, res) => {
    const uploadedPaths = [];

    try {
      const files = req.files || {};

      if (!files.shopifyFile1) {
        return res.status(400).json({
          error: 'Please upload at least one Shopify export file.',
        });
      }

      const shopifyFile1Path = files.shopifyFile1[0].path;
      const shopifyFile2Path = files.shopifyFile2?.[0]?.path || null;

      uploadedPaths.push(shopifyFile1Path);
      if (shopifyFile2Path) uploadedPaths.push(shopifyFile2Path);

      // 1. Fetch CFS product/variant data from the API
      console.log('▶ Fetching CFS product data from API…');
      const cfsProducts = await fetchCfsProducts();
      console.log(`  ✓ ${cfsProducts.length} products from CFS API`);

      // 2. Build all comparison data structures from the API response
      const {
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
      } = buildCompareData(cfsProducts);

      const activeCount   = [...validProductSKUs.values()].filter(s => s === 'active').length;
      const inactiveCount = validProductSKUs.size - activeCount;
      console.log(`  ✓ ${validProductSKUs.size} product SKUs (${activeCount} active, ${inactiveCount} inactive)`);
      console.log(`  ✓ ${cfsProductIds.size} raw CFS product IDs`);
      console.log(`  ✓ ${productCodesBySku.size} product codes loaded`);
      console.log(`  ✓ ${validVariantSKUs.size} variant SKUs, ${cfsVariantAttrIds.size} variant attr IDs`);

      // 3. Parse Shopify export(s)
      console.log('▶ Streaming Shopify export file 1…');
      const shopifyVariants = await streamShopifyVariants(shopifyFile1Path);
      console.log(`  ✓ ${shopifyVariants.length} variants from file 1`);

      if (shopifyFile2Path) {
        console.log('▶ Streaming Shopify export file 2…');
        const variants2 = await streamShopifyVariants(shopifyFile2Path);
        console.log(`  ✓ ${variants2.length} variants from file 2`);
        shopifyVariants.push(...variants2);
      }

      // 4. Four-step compare (variant feed → product feed → raw CFS IDs → orphaned)
      console.log(`▶ Comparing ${shopifyVariants.length} variants…`);
      const { results, summary } = compareVariants(
        shopifyVariants, validVariantSKUs, validProductSKUs, cfsProductIds, cfsVariantAttrIds,
        productCodesBySku, productCodesByProdId, variantCodesBySku, variantCodesByAttrId,
        cfsVarCodeSet, cfsProductCodeToStatus,
      );
      console.log(`  ✓ ${summary.orphaned} orphaned, ${summary.ok} OK, ${summary.draft} draft/archived, ${summary.cfsInactive} cfs-inactive, ${summary.cfsProduct} cfs-product`);

      res.json({
        success: true,
        summary,
        results,
        // cfsProductIds is a Map<prodId, 'active'|'inactive'>; send as entries array
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