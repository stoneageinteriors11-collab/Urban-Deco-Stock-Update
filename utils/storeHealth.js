/**
 * Store health — read-only checks over the whole store (pure logic, tested in test/storeHealth.test.js).
 *
 * Input product: { id, handle, title, vendor, status (ACTIVE/DRAFT/ARCHIVED), iid, pcode,
 *                  options:[{id,name,optionValues:[{id,name}]}], variants:[{id, sku, title, selectedOptions:[{name,value}]}] }
 * ctx: { byProd: Map(prodId → {brandId, vendor, name}), byVar: Map(varId → …),
 *        knownVendors: [names], findDefaults (utils/defaultColour) }
 *
 * Each check returns rows { productId, handle, title, vendor, status, skus:[], detail, fixLink? }.
 * Nothing here changes the store — every tile points to the place in the tool that fixes it.
 */
const { colourWords } = require('./colourMatch');
const { cleanSku, wrongPairing } = require('./matchVariants');

const UD_RE = /^UD-(\d+)(?:-(\d+))?$/i;
const parse = sku => { const m = UD_RE.exec(String(sku || '').trim()); return m ? { prodId: m[1], varId: m[2] || null } : null; };
const low = s => String(s || '').trim().toLowerCase();
// URL (handle) made from the title — same rule as the rest of the tool (routes/shopify.js slugify)
const slugify = t => String(t || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const CHECKS = [
  { id: 'default-colours', label: '"Default" colours', why: 'Customers see "Default" / "Default Title" as a colour choice.', fix: '"Default" colours page', link: '/default-colours.html' },
  { id: 'split-colours', label: 'Split colours', why: 'One CFS product shown as a real colour + "Default" (e.g. Bisque Oasis 2 Chairs + Default Title 4–12 Chairs).', fix: '"Default" colours page → Merge', link: '/default-colours.html' },
  { id: 'not-in-cfs', label: 'SKU not in any CFS feed', why: 'Not in Urban Deco\'s or any brand\'s CFS feed — no stock updates; may be discontinued.', fix: 'Clean-up for that vendor (Step 3)' },
  { id: 'sku-typo', label: 'SKU typos', why: 'Spaces or stray characters in the SKU, or a variant number that belongs to another CFS product — it only matches CFS once corrected.', fix: 'Clean-up → SKU typo tab → Fix Selected SKUs' },
  { id: 'wrong-vendor', label: 'Wrong vendor', why: 'SKUs belong to another brand\'s CFS feed — this product misses that brand\'s stock, codes and order-ahead.', fix: 'Brand clean-up → Wrong vendor tab → Change Vendor' },
  { id: 'no-sku', label: 'No SKU', why: 'Variants with an empty SKU — no tool can match them to CFS (fine for bundles/packages).', fix: 'By hand, or ignore if intended' },
  { id: 'dup-sku', label: 'Same SKU twice on one product', why: 'Two variants on one product share a SKU — usually a duplicate variant.', fix: 'By hand (delete the extra variant)' },
  { id: 'same-own-item', label: 'Same item on two pages', why: 'Two or more products are the same CFS product (own item) — duplicate pages.', fix: 'Check if intended; draft the extra page' },
  { id: 'missing-ids', label: 'Missing CFS product ID / code', why: 'No custom.iproductid or custom.product_code — skipped by the product code step and own-colour checks.', fix: 'Product codes step / by hand' },
  { id: 'url-title', label: 'URL doesn\'t match title', why: 'A colour in the title is not in the URL (e.g. title "Natural", URL "…medium-brown…").', fix: 'Tick them and click "Fix URLs" — new URL made from the title, old URL redirects (dry run + Undo)' },
  { id: 'unknown-vendor', label: 'Unknown vendor', why: 'Vendor is not Urban Deco or one of the 14 brands — no tool step covers it.', fix: 'Info only' },
];

function runChecks(products, ctx) {
  const out = Object.fromEntries(CHECKS.map(c => [c.id, []]));
  const known = new Set((ctx.knownVendors || []).map(low));
  const brandOfSku = sku => { const p = parse(sku); if (!p) return null; return ctx.byProd.get(p.prodId) || (p.varId && ctx.byVar.get(p.varId)) || null; };
  const base = p => ({ productId: p.id, handle: p.handle, title: p.title, vendor: p.vendor, status: p.status });
  const ownKey = new Map();   // CFS product id → products whose OWN item it is

  for (const p of products) {
    const vs = p.variants || [];
    const skus = vs.map(v => String(v.sku || '').trim());

    // 1 + 2. "Default" colours / split colours
    if (ctx.findDefaults) {
      for (const r of ctx.findDefaults(p, { cfsName: () => null })) {
        const row = { ...base(p), skus: r.skus, detail: r.action === 'merge'
          ? `"${r.current}" (${r.variants} variant(s)) is the same CFS product as "${r.mergeInto}" → merge`
          : `${r.optionName}: "${r.current}" — type ${r.type}${r.otherValues.length ? `, next to ${r.otherValues.join(', ')}` : ''}`,
          fixLink: `/default-colours.html?vendor=${encodeURIComponent(p.vendor)}` };
        out[r.action === 'merge' ? 'split-colours' : 'default-colours'].push(row);
      }
    }

    // 3 + 4. not in any CFS feed / SKU typos
    const notIn = [], typos = [];
    const optsOf = sku => (vs.find(v => String(v.sku || '').trim() === sku)?.selectedOptions || []).map(o => o.value);
    for (const s of skus) {
      if (!s) continue;
      if (parse(s)) {
        // variant number that belongs to another CFS product (e.g. Batilda Black UD-1271925-17373742 = Cream's number)
        const wp = wrongPairing(s, id => ctx.byVar.get(id), id => ctx.byProd.get(id)?.vars, optsOf(s));
        if (wp) { if (wp.fixedSku) typos.push(`"${s}" → ${wp.fixedSku} (variant no. belongs to CFS product ${wp.ownerProdId})`); else notIn.push(s); continue; }
        // option removed in CFS: the CFS product still has other options, but not this one
        const pr = parse(s), bp = ctx.byProd.get(pr.prodId);
        if (pr.varId && bp?.vars?.length && !bp.vars.some(x => x.varId === pr.varId)) { notIn.push(s); continue; }
        if (!brandOfSku(s)) notIn.push(s);
        continue;
      }
      const c = cleanSku(s);
      if (parse(c)) typos.push(`"${s}" → ${c}${brandOfSku(c) ? '' : ' (not in CFS either)'}`);
      else notIn.push(s);
    }
    if (notIn.length) out['not-in-cfs'].push({ ...base(p), skus: notIn, detail: `${notIn.length} of ${vs.length} variant(s) not in any CFS feed${notIn.some(s => !parse(s)) ? ' (some aren\'t UD- SKUs)' : ''}` });
    if (typos.length) out['sku-typo'].push({ ...base(p), skus: typos.map(t => t.split(' → ')[0].replace(/"/g, '')), detail: typos.join('; ') });

    // 5. wrong vendor (SKUs in another brand's feed)
    const brands = new Map();
    for (const s of skus) { const b = brandOfSku(s); if (b) brands.set(b.vendor, (brands.get(b.vendor) || 0) + 1); }
    if (brands.size && !brands.has(p.vendor) && ![...brands.keys()].some(v => low(v) === low(p.vendor))) {
      const list = [...brands].map(([v, n]) => `${v} (${n})`).join(', ');
      out['wrong-vendor'].push({ ...base(p), skus: skus.filter(Boolean), shouldBe: brands.size === 1 ? [...brands.keys()][0] : null, detail: `Vendor "${p.vendor || '(blank)'}" but SKUs are in: ${list}${brands.size > 1 ? ' — mixed brands, fix by hand' : ''}` });
    }

    // 6. no SKU
    const empty = vs.filter(v => !String(v.sku || '').trim());
    if (empty.length) out['no-sku'].push({ ...base(p), skus: [], detail: `${empty.length} of ${vs.length} variant(s) with no SKU (${empty.slice(0, 4).map(v => v.title || 'Default').join(', ')}${empty.length > 4 ? '…' : ''})` });

    // 7. same SKU twice on one product
    const seen = new Map();
    for (const v of vs) { const s = String(v.sku || '').trim(); if (s) seen.set(s, [...(seen.get(s) || []), v.title || 'Default']); }
    const dups = [...seen].filter(([, t]) => t.length > 1);
    if (dups.length) out['dup-sku'].push({ ...base(p), skus: dups.map(([s]) => s), detail: dups.map(([s, t]) => `${s} on ${t.join(' + ')}`).join('; ') });

    // 8. own item (iproductid, or the only CFS product on a one-product page)
    const prods = [...new Set(skus.map(s => parse(s)?.prodId).filter(Boolean))];
    const own = p.iid ? String(p.iid) : (prods.length === 1 ? prods[0] : null);
    if (own) ownKey.set(own, [...(ownKey.get(own) || []), p]);

    // 9. missing CFS product id / product code (CFS-backed products only)
    if (prods.length && (!p.iid || !String(p.pcode || '').trim())) {
      out['missing-ids'].push({ ...base(p), skus: skus.filter(Boolean).slice(0, 6),
        detail: [!p.iid && 'no iproductid', !String(p.pcode || '').trim() && 'no product_code'].filter(Boolean).join(' + ') });
    }

    // 10. colour in the title but not in the URL
    const tw = [...colourWords(p.title)].filter(w => !['light', 'dark', 'pale', 'deep', 'soft', 'mid', 'warm', 'cool', 'smoked', 'washed'].includes(w));
    const hw = new Set(String(p.handle || '').toLowerCase().replace(/gray/g, 'grey').split('-'));
    const missing = tw.filter(w => !hw.has(w));
    if (missing.length) {
      const hc = [...colourWords(String(p.handle || '').replace(/-/g, ' '))].filter(w => !tw.includes(w));
      out['url-title'].push({ ...base(p), skus: [], newHandle: slugify(p.title), detail: `Title says ${missing.map(w => `"${w}"`).join(', ')}, URL doesn't${hc.length ? ` (URL says ${hc.map(w => `"${w}"`).join(', ')})` : ''}` });
    }

    // 11. unknown vendor
    if (!known.has(low(p.vendor))) out['unknown-vendor'].push({ ...base(p), skus: [], detail: `Vendor "${p.vendor || '(blank)'}"` });
  }

  for (const [pid, ps] of ownKey) {
    if (ps.length < 2) continue;
    for (const p of ps) {
      out['same-own-item'].push({ ...base(p), skus: (p.variants || []).map(v => v.sku).filter(s => parse(s)?.prodId === pid),
        detail: `Same CFS product ${pid}${ctx.byProd.get(pid)?.name ? ` ("${ctx.byProd.get(pid).name}")` : ''} as: ${ps.filter(x => x !== p).map(x => x.title).join(' · ')}` });
    }
  }
  return CHECKS.map(c => ({ ...c, count: out[c.id].length, rows: out[c.id] }));
}

module.exports = { runChecks, CHECKS, slugify };
