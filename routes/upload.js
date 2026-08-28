const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { streamVariantSKUs, streamShopifyVariants } = require('../utils/parseCSV');
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
// Accepts: variantFeed (non-Shopify variant CSV), shopifyFile1, shopifyFile2 (optional)
// All CSV parsing uses streaming — no whole-file reads into memory.
router.post(
  '/compare',
  upload.fields([
    { name: 'variantFeed',  maxCount: 1 },
    { name: 'shopifyFile1', maxCount: 1 },
    { name: 'shopifyFile2', maxCount: 1 },
  ]),
  async (req, res) => {
    const uploadedPaths = [];

    try {
      const files = req.files;

      if (!files.variantFeed || !files.shopifyFile1) {
        return res.status(400).json({ error: 'Please upload the non-Shopify variant feed and at least one Shopify export file.' });
      }

      const variantFeedPath  = files.variantFeed[0].path;
      const shopifyFile1Path = files.shopifyFile1[0].path;
      const shopifyFile2Path = files.shopifyFile2?.[0]?.path || null;

      uploadedPaths.push(variantFeedPath, shopifyFile1Path);
      if (shopifyFile2Path) uploadedPaths.push(shopifyFile2Path);

      console.log('▶ Streaming non-Shopify variant feed…');
      // 1. Stream non-Shopify variant feed → build Set of valid SKUs (very low memory)
      const validSKUs = await streamVariantSKUs(variantFeedPath);
      console.log(`  ✓ ${validSKUs.size} valid SKUs loaded`);

      console.log('▶ Streaming Shopify export file 1…');
      // 2. Stream Shopify export(s) — process sequentially to keep peak memory low
      const shopifyVariants = await streamShopifyVariants(shopifyFile1Path);
      console.log(`  ✓ ${shopifyVariants.length} variants from file 1`);

      if (shopifyFile2Path) {
        console.log('▶ Streaming Shopify export file 2…');
        const variants2 = await streamShopifyVariants(shopifyFile2Path);
        console.log(`  ✓ ${variants2.length} variants from file 2`);
        shopifyVariants.push(...variants2);
      }

      console.log(`▶ Comparing ${shopifyVariants.length} Shopify variants against ${validSKUs.size} valid SKUs…`);
      // 3. Compare
      const { results, summary } = compareVariants(shopifyVariants, validSKUs);
      console.log(`  ✓ Done — ${summary.orphaned} orphaned, ${summary.ok} OK`);

      res.json({ success: true, summary, results });

    } catch (err) {
      console.error('Compare error:', err);
      res.status(500).json({ error: err.message });
    } finally {
      // 4. Always clean up uploaded temp files
      uploadedPaths.forEach(tryUnlink);
    }
  }
);

module.exports = router;