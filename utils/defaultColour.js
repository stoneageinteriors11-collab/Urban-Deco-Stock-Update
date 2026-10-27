/**
 * "Default" colour check — finds product options whose value is "Default" / "Default Title"
 * (e.g. Herringford Bedside Cabinet: Color = Brown / Default) and suggests the real name.
 *
 * Pure logic, no network — tested in test/defaultColour.test.js.
 *
 * Which products:
 *   - any option with a value "Default" or "Default Title"
 *   - EXCEPT Shopify's own simple product (one option "Title" = "Default Title") → nothing to fix
 *
 * Type (same as the CSV):
 *   A  Default next to real values           (Brown / Default)        → customers see "Default"
 *   B  Default is the only value, other options exist (Default + sizes)
 *   C  single option, single value "Default" (one-variant product, usually hidden)
 *
 * Where the suggestion comes from (behind every Default variant is a SKU → CFS product):
 *   1. same-sku  The same SKU is sold on another product with a real value for this option
 *                ("Herringford Bedside Cabinet - Oak" has UD-1258290 as "Oak")
 *   2. cfs-name  The words that make the CFS name different from the other values' CFS names
 *                ("Herringford Oak 2 Drawer…" vs "Herringford Walnut 2 Drawer…" → "Oak").
 *                No other values → the colour words in the CFS name.
 *   3. title     The Default variant IS this product's own CFS product (iproductid) →
 *                the colour part of the title ("Axel Round Coffee Table - Walnut Fluted").
 * Two sources agree → "high"; one source → "medium"; none → no suggestion ("please check").
 * A suggestion that already exists as another value of the option → flagged (would clash).
 */
const { colourWords } = require('./colourMatch');

const DEFAULT_RE = /^default( title)?$/i;
const isDefault = v => DEFAULT_RE.test(String(v || '').trim());
const STOP = new Set(['the', 'and', 'with', 'a', 'of', 'in', 'for', 'to', 'default', 'title', 'sizes', 'available', 'set']);

const tokens = s => String(s || '').replace(/gray/gi, 'grey').split(/[^A-Za-z0-9]+/).filter(Boolean);
const titleCase = s => s.replace(/\b([a-z])/g, (m, c) => c.toUpperCase());
const norm = s => tokens(s).map(w => w.toLowerCase()).filter(w => w !== 'and').join(' ');

function parseSku(sku) {
  const m = /^UD-(\d+)(?:-(\d+))?$/i.exec(String(sku || '').trim());
  return m ? { prodId: m[1], varId: m[2] || null } : { prodId: null, varId: null };
}

/** Product title "Name - … - Colour - Material": first part after the name that names a colour and has no digits */
function titleColour(title) {
  const parts = String(title || '').split(/\s+-\s+/).slice(1);
  for (const p of parts) {
    if (/\d/.test(p)) continue;
    if (colourWords(p).size) return p.trim();
  }
  return '';
}

/** The words of `name` that none of the `others` contain, in the original order (stop words dropped) */
function differingWords(name, others) {
  const otherSets = others.map(o => new Set(tokens(o).map(w => w.toLowerCase())));
  return tokens(name).filter(w => {
    const lw = w.toLowerCase();
    return !STOP.has(lw) && !/^\d+$/.test(lw) && otherSets.every(s => !s.has(lw));
  });
}

/**
 * @param {object} product  { id, title, handle, vendor, status, iid, options:[{id,name,optionValues:[{id,name}]}],
 *                            variants:[{id, sku, selectedOptions:[{name,value}]}] }
 * @param {object} ctx      { cfsName(sku) → string|null, skuHomes: Map<sku, [{handle,title,status,options:[{name,value}]}]> }
 * @returns {Array} one row per Default option value
 */
function findDefaults(product, ctx = {}) {
  const opts = product.options || [];
  if (opts.length === 1 && opts[0].name === 'Title' && (opts[0].optionValues || []).every(v => isDefault(v.name))) return [];
  const rows = [];
  for (const o of opts) {
    for (const val of (o.optionValues || [])) {
      if (!isDefault(val.name)) continue;
      const others = (o.optionValues || []).filter(v => !isDefault(v.name)).map(v => v.name);
      const type = others.length ? 'A' : opts.length > 1 ? 'B' : 'C';
      const pick = x => (x.selectedOptions || []).find(s => s.name === o.name)?.value;
      const dv = (product.variants || []).filter(v => pick(v) === val.name);
      const sv = (product.variants || []).filter(v => { const p = pick(v); return p && !isDefault(p); });
      rows.push({
        productId: product.id, title: product.title, handle: product.handle, vendor: product.vendor, status: product.status,
        type, optionId: o.id, optionName: o.name, valueId: val.id, current: val.name, otherValues: others,
        variants: dv.length, skus: dv.map(v => v.sku).filter(Boolean),
        ...suggest(product, o.name, dv, sv, others, ctx),
      });
    }
  }
  return rows;
}

function suggest(product, optionName, dv, sv, others, ctx) {
  const cands = [];   // { value, source, detail }
  const skus = dv.map(v => String(v.sku || '').trim()).filter(Boolean);

  // 1. same SKU on another product with a real value for this option
  const fromHomes = new Map();
  for (const sku of skus) {
    for (const h of (ctx.skuHomes?.get(sku) || [])) {
      if (h.handle === product.handle) continue;
      const v = (h.options || []).find(s => s.name === optionName)?.value;
      if (v && !isDefault(v)) fromHomes.set(norm(v), { value: v, detail: `same SKU ${sku} is "${v}" on ${h.title}${h.status && h.status !== 'ACTIVE' ? ` (${h.status.toLowerCase()})` : ''}` });
    }
  }
  if (fromHomes.size === 1) { const [x] = fromHomes.values(); cands.push({ value: x.value, source: 'same-sku', detail: x.detail }); }
  else if (fromHomes.size > 1) cands.push({ value: null, source: 'same-sku', detail: `same SKU has different names elsewhere (${[...fromHomes.values()].map(x => x.value).join(', ')})` });

  // 2. CFS name vs the other values' CFS names
  const nameOf = sku => (ctx.cfsName ? ctx.cfsName(sku) : null);
  const dNames = [...new Set(skus.map(s => nameOf(s)).filter(Boolean))];
  const sNames = [...new Set(sv.map(v => nameOf(v.sku)).filter(Boolean))].filter(n => !dNames.includes(n));
  if (dNames.length === 1) {
    if (sNames.length) {
      const diff = differingWords(dNames[0], sNames);
      if (diff.length && diff.length <= 4) cands.push({ value: titleCase(diff.join(' ')), source: 'cfs-name', detail: `CFS name "${dNames[0]}" vs ${sNames.map(n => `"${n}"`).join(', ')}` });
    } else {
      const cw = tokens(dNames[0]).filter(w => colourWords(w).size);
      if (cw.length && cw.length <= 3) cands.push({ value: titleCase(cw.join(' ')), source: 'cfs-name', detail: `colour words in CFS name "${dNames[0]}"` });
    }
  }

  // 3. own CFS product → colour part of the product title
  const own = product.iid && skus.some(s => parseSku(s).prodId === String(product.iid));
  if (own) {
    const tc = titleColour(product.title);
    if (tc) cands.push({ value: tc, source: 'title', detail: `this is the product's own CFS product (${product.iid}) — title says "${tc}"` });
  }

  const good = cands.filter(c => c.value);
  const notes = cands.map(c => c.detail);
  if (!good.length) return { suggestion: '', confidence: 'none', sources: [], notes: notes.length ? notes : ['no CFS name, matching SKU or title colour found — please check'] };
  // agreement: same words (ignoring order / "and"); or one is contained in the other
  // "Walnut" and "Walnut Fluted" count as agreeing (one's words are all in the other)
  const wordsOf = v => new Set(norm(v).split(' ').filter(Boolean));
  const within = (a, b) => [...a].every(w => b.has(w));
  const groups = new Map();
  for (const c of good) {
    const w = wordsOf(c.value);
    const hit = [...groups.keys()].find(k => { const kw = wordsOf(k); return within(w, kw) || within(kw, w); });
    if (hit) groups.get(hit).push(c); else groups.set(c.value, [c]);
  }
  const order = { 'same-sku': 0, title: 1, 'cfs-name': 2 };
  const best = [...groups.values()].sort((a, b) => b.length - a.length || order[a[0].source] - order[b[0].source])[0];
  const chosen = best.sort((a, b) => order[a.source] - order[b.source])[0];
  let confidence = best.length >= 2 ? 'high' : 'medium';
  if (groups.size > 1) { confidence = best.length >= 2 ? 'medium' : 'low'; notes.push(`sources disagree: ${[...groups.values()].map(g => `"${g[0].value}"`).join(' vs ')}`); }
  const clash = others.find(o => norm(o) === norm(chosen.value));
  if (clash) { notes.push(`"${chosen.value}" already exists on this product — renaming would clash (duplicate variant?) — please check`); confidence = 'clash'; }
  return { suggestion: chosen.value, confidence, sources: best.map(c => c.source), notes };
}

module.exports = { findDefaults, suggest, titleColour, differingWords, isDefault, parseSku };
