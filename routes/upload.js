const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { parseCSVFile, extractVariantSKUs, extractShopifyVariants } = require('../utils/parseCSV');
const { compareVariants } = require('../utils/matchVariants');

const router = express.Router();

// Store uploads in /uploads folder, keep original extension
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB max

// ── POST /api/compare ────────────────────────────────────────────────────────
// Accepts: variantFeed (non-Shopify variant CSV), shopifyFile1, shopifyFile2 (optional)
router.post(
  '/compare',
  upload.fields([
    { name: 'variantFeed', maxCount: 1 },
    { name: 'shopifyFile1', maxCount: 1 },
    { name: 'shopifyFile2', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const files = req.files;

      if (!files.variantFeed || !files.shopifyFile1) {
        return res.status(400).json({ error: 'Please upload the non-Shopify variant feed and at least one Shopify export file.' });
      }

      // 1. Parse non-Shopify variant feed → extract valid Shopify SKUs
      const variantFeedRows = parseCSVFile(files.variantFeed[0].path);
      const validSKUs       = extractVariantSKUs(variantFeedRows);

      // 2. Parse Shopify export(s) — merge both files if second is provided
      const shopify1Rows = parseCSVFile(files.shopifyFile1[0].path);
      const shopify2Rows = files.shopifyFile2
        ? parseCSVFile(files.shopifyFile2[0].path)
        : [];

      const allShopifyRows = [...shopify1Rows, ...shopify2Rows];
      const shopifyVariants = extractShopifyVariants(allShopifyRows);

      // 3. Compare
      const { results, summary } = compareVariants(shopifyVariants, validSKUs);

      // 4. Clean up uploaded files
      [files.variantFeed[0], files.shopifyFile1[0], ...(files.shopifyFile2 || [])].forEach(f => {
        try { fs.unlinkSync(f.path); } catch (_) {}
      });

      res.json({ success: true, summary, results });

    } catch (err) {
      console.error('Compare error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
