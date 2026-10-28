/**
 * Other brands (not Urban Deco) — list, CFS feed and stock rules.
 *
 * Feed: productVariantStockJsonCFS.php?brandId=<id>   (same layout as Urban Deco / 215)
 * Shopify: products whose vendor = the CFS brand name, SKUs UD-{productId}[-{variantId}]
 *
 * Stock values are copied from CFS as they are, except:
 *   J-Line, Richmond Interiors : IN STOCK → quantity 5 · OUT OF STOCK → quantity 0
 *   Gert Snel                  : always IN STOCK, quantity 5 (CFS status is blank)
 * Flagged for later (copied as-is, marked in the log):
 *   IN STOCK with 0 on hand, blank stock status (information only — values are still copied as-is)
 */
const axios = require('axios');

const FEED_URL = id => `https://www.choicefurnituresuperstore.co.uk/productVariantStockJsonCFS.php?brandId=${id}`;

// vendor = CFS brand name (also the Shopify vendor)
const BRANDS = [
  { id: 315, vendor: 'Beehive',            rule: 'as-is' },
  { id: 335, vendor: 'House Nordic',       rule: 'as-is' },
  { id: 28,  vendor: 'Limelight',          rule: 'as-is' },
  { id: 363, vendor: 'J-Line',             rule: 'in-stock-5' },
  { id: 364, vendor: 'Livingfurn',         rule: 'as-is' },
  { id: 365, vendor: 'Twenty 10 Design',   rule: 'as-is' },
  { id: 212, vendor: 'Richmond Interiors', rule: 'in-stock-5' },
  { id: 236, vendor: 'Actona',             rule: 'as-is' },
  { id: 130, vendor: 'Country Living',     rule: 'as-is' },
  { id: 29,  vendor: 'Julian Bowen',       rule: 'as-is' },
  { id: 80,  vendor: 'Birlea',             rule: 'as-is' },
  { id: 188, vendor: 'Furniture To Go',    rule: 'as-is' },
  { id: 22,  vendor: 'Annaghmore',         rule: 'as-is' },
  { id: 366, vendor: 'Gert Snel',          rule: 'always-5' },
];
const RULE_TEXT = {
  'as-is':      'Copied exactly as CFS has it (IN STOCK with 0 on hand → quantity 5)',
  'in-stock-5': 'IN STOCK → quantity 5 · OUT OF STOCK → quantity 0',
  'always-5':   'Always IN STOCK, quantity 5',
};

const IN_STOCK_ZERO_QTY = 5;   // quantity used when CFS says IN STOCK but on hand is 0
const getBrand = id => BRANDS.find(b => b.id === Number(id)) || null;

async function fetchBrandFeed(id) {
  const res = await axios.get(FEED_URL(id), { timeout: 90_000 });
  if (!Array.isArray(res.data)) throw new Error(`CFS feed for brand ${id} returned an unexpected format`);
  return res.data;
}

const clean = v => (v === undefined || v === null) ? '' : String(v).trim();
const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };

/** Apply the brand's rule to one CFS record → { stockStatus, qty, deliveryTime, dueDate, flags[] } */
function applyRule(brand, rec) {
  const status = clean(rec.stockStatus).toUpperCase();
  const out = { deliveryTime: clean(rec.deliveryTime), dueDate: clean(rec.dueDate), cfsStatus: status, cfsOnHand: rec.onHand, flags: [] };
  if (brand.rule === 'always-5') return { ...out, stockStatus: 'IN STOCK', qty: 5 };
  if (brand.rule === 'in-stock-5') {
    if (status === 'IN STOCK') return { ...out, stockStatus: 'IN STOCK', qty: 5 };
    if (status === 'OUT OF STOCK') return { ...out, stockStatus: 'OUT OF STOCK', qty: 0 };
  }
  const qty = num(rec.onHand);
  if (!status) out.flags.push('CFS stock status is blank');
  // Other brands only (Urban Deco's own stock sync doesn't use this): CFS says IN STOCK but 0 on hand → 5
  if (status === 'IN STOCK' && qty === 0) return { ...out, stockStatus: status, qty: IN_STOCK_ZERO_QTY, qtyNote: `CFS IN STOCK but 0 on hand → ${IN_STOCK_ZERO_QTY}` };
  return { ...out, stockStatus: status, qty };
}

/**
 * SKU → stock record for one brand.
 *   UD-{productId}              → product values
 *   UD-{productId}-{variantId}  → variant values (missing fields fall back to the product)
 */
function buildBrandStock(feed, brand) {
  const bySku = new Map();
  for (const p of feed) {
    const prodId = String(p.productId);
    bySku.set(`UD-${prodId}`, { ...applyRule(brand, p), level: 'product', productName: p.productName || '' });
    for (const v of (Array.isArray(p.variants) ? p.variants : [])) {
      const merged = {
        deliveryTime: clean(v.deliveryTime) || p.deliveryTime,
        stockStatus:  clean(v.stockStatus)  || p.stockStatus,
        onHand:       v.onHand ?? p.onHand,
        dueDate:      clean(v.dueDate)      || p.dueDate,
      };
      bySku.set(`UD-${prodId}-${v.variantId}`, { ...applyRule(brand, merged), level: 'variant', productName: `${p.productName || ''} — ${v.variantOption || v.variantId}` });
    }
  }
  return bySku;
}

/**
 * SKU → codes for one brand (same rules as Urban Deco's Step 4):
 *   simple product (no CFS variants) UD-{p}     → product_code + variant_code = product code
 *   product with CFS variants       UD-{p}     → product_code only (variant_code left alone)
 *   CFS variant                     UD-{p}-{v} → product_code = product code, variant_code = variant code
 */
function buildBrandCodes(feed) {
  const bySku = new Map();
  for (const p of feed) {
    const prodId = String(p.productId), code = clean(p.productCode);
    const vars = Array.isArray(p.variants) ? p.variants : [];
    bySku.set(`UD-${prodId}`, { productCode: code, variantCode: vars.length ? '' : code });
    for (const v of vars) bySku.set(`UD-${prodId}-${v.variantId}`, { productCode: code, variantCode: clean(v.productCode) });
  }
  return bySku;
}

module.exports = { BRANDS, RULE_TEXT, IN_STOCK_ZERO_QTY, getBrand, fetchBrandFeed, applyRule, buildBrandStock, buildBrandCodes };
