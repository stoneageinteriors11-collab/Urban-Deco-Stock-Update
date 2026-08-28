const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { streamProductSKUs, streamVariantSKUs, streamShopifyVariants } = require('../utils/parseCSV');
const { compareVariants } = require('../utils/matchVariants');

const router = express.Router();

// Store uploads in /uploads folder, keep original extension
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB max

// Helper: delete a file safely (won't throw if already gone)
function tryUnlink(filePath) {
  try { fs.unlinkSync(filePath); } catch (_) {}
}

// ── POST /api/compare ────────────────────────────────────────────────────────
// Accepts:
//   productFeed   — CFS non-Shopify product CSV  (Shopify SKU col: UD-{ProductId})
//   variantFeed   — CFS non-Shopify variant CSV  (Shopify SKU col: UD-{ProductId}-{VariantId})
//   shopifyFile1  — Shopify export part 1
//   shopifyFile2  — Shopify export part 2 (optional)
//
// Matching logic (two-step):
//   1. Check full SKU against variant feed  (exact)
//   2. If not found, check product ID portion against product feed  (fallback)
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
      const files = req.files;

      if (!files.productFeed || !files.variantFeed || !files.shopifyFile1) {
        return res.status(400).json({
          error: 'Please upload the CFS product feed, CFS variant feed, and at least one Shopify export file.',
        });
      }

      const productFeedPath  = files.productFeed[0].path;
      const variantFeedPath  = files.variantFeed[0].path;
      const shopifyFile1Path = files.shopifyFile1[0].path;
      const shopifyFile2Path = files.shopifyFile2?.[0]?.path || null;

      uploadedPaths.push(productFeedPath, variantFeedPath, shopifyFile1Path);
      if (shopifyFile2Path) uploadedPaths.push(shopifyFile2Path);

      // 1. Stream CFS product feed → Set of short product SKUs (UD-{ProductId})
      console.log('▶ Streaming CFS product feed…');
      const validProductSKUs = await streamProductSKUs(productFeedPath);
      console.log(`  ✓ ${validProductSKUs.size} product SKUs loaded`);

      // 2. Stream CFS variant feed → Set of full variant SKUs (UD-{ProductId}-{VariantId})
      console.log('▶ Streaming CFS variant feed…');
      const validVariantSKUs = await streamVariantSKUs(variantFeedPath);
      console.log(`  ✓ ${validVariantSKUs.size} variant SKUs loaded`);

      // 3. Stream Shopify export(s)
      console.log('▶ Streaming Shopify export file 1…');
      const shopifyVariants = await streamShopifyVariants(shopifyFile1Path);
      console.log(`  ✓ ${shopifyVariants.length} variants from file 1`);

      if (shopifyFile2Path) {
        console.log('▶ Streaming Shopify export file 2…');
        const variants2 = await streamShopifyVariants(shopifyFile2Path);
        console.log(`  ✓ ${variants2.length} variants from file 2`);
        shopifyVariants.push(...variants2);
      }

      // 4. Two-step compare
      console.log(`▶ Comparing ${shopifyVariants.length} Shopify variants…`);
      const { results, summary } = compareVariants(shopifyVariants, validVariantSKUs, validProductSKUs);
      console.log(`  ✓ Done — ${summary.orphaned} orphaned, ${summary.ok} OK`);

      res.json({ success: true, summary, results });

    } catch (err) {
      console.error('Compare error:', err);
      res.status(500).json({ error: err.message });
    } finally {
      // Always clean up uploaded temp files
      uploadedPaths.forEach(tryUnlink);
    }
  }
);

module.exports = router;