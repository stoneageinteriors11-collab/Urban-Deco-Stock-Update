/**
 * Works out which variant(s) a Shopify product "is".
 *
 * Many Urban Deco products are one CFS product shown with its siblings as extra
 * variants (e.g. "Carrera Side Table – Black Marquina" also sells White and
 * Beige). When Step 3 removes variants, it matters whether the variant being
 * removed is the product's OWN one (→ draft the whole product) or a sibling
 * (→ delete just that variant).
 *
 * Works for any kind of option — colour, size ("2 Seater"), type ("Electric"):
 *   1. For each option, find the words that tell its values apart
 *      (White / Beige / Black, 2 Seater / 3 Seater, Manual / Electric).
 *   2. A value whose distinguishing words all appear in the product title or
 *      handle is the product's own value for that option.
 *   3. Options not mentioned in the title (e.g. sizes) don't narrow it down.
 *   4. Products whose variants have no real options ("Default Title") use the
 *      CFS product name behind each SKU instead (when CFS still has it).
 * Anything unclear → { ok: false } and the caller keeps its normal behaviour.
 */

const STOP = new Set(['the', 'and', 'with', 'a', 'of', 'in', 'for', 'to', 'default', 'title', 'sizes', 'available']);

function words(text) {
  return String(text || '').toLowerCase().replace(/gray/g, 'grey')
    .split(/[^a-z0-9]+/).filter(w => w && !STOP.has(w));
}

// distinguishing words of each label = its words minus words shared by ALL labels
function distinguishing(labels) {
  const sets = labels.map(l => new Set(words(l)));
  const common = sets.length ? [...sets[0]].filter(w => sets.every(s => s.has(w))) : [];
  return sets.map(s => [...s].filter(w => !common.includes(w)));
}

/**
 * @param {{title:string, handle:string}} product
 * @param {Array<{id:string, sku:string, title?:string, selectedOptions?:{name,value}[]}>} variants
 * @param {Map<string,string>} [cfsNameByProdId]  CFS product names (from the stock feed)
 * @returns {{ ok:boolean, ownIds?:string[], label?:string, reason:string }}
 */
function findOwnVariants(product, variants, cfsNameByProdId = new Map()) {
  if (!variants.length) return { ok: false, reason: 'no variants' };
  if (variants.length === 1) return { ok: true, ownIds: [variants[0].id], label: variants[0].title || variants[0].sku, reason: 'only one variant' };
  const titleWords = new Set([...words(product.title), ...words(product.handle)]);

  // ── options ──────────────────────────────────────────────────────────────
  const optionNames = [...new Set(variants.flatMap(v => (v.selectedOptions || []).map(o => o.name)))];
  const realOptions = optionNames.filter(n => {
    const vals = new Set(variants.map(v => (v.selectedOptions || []).find(o => o.name === n)?.value || ''));
    return vals.size > 1;
  });
  const constraints = [];
  for (const name of realOptions) {
    const values = [...new Set(variants.map(v => (v.selectedOptions || []).find(o => o.name === name)?.value || ''))];
    const diff = distinguishing(values);
    const hits = values.filter((val, i) => diff[i].length && diff[i].every(w => titleWords.has(w)));
    if (hits.length === 1) constraints.push({ name, value: hits[0] });
    else if (hits.length > 1) return { ok: false, reason: `title matches more than one ${name} (${hits.join(', ')})` };
  }
  if (constraints.length) {
    const own = variants.filter(v => constraints.every(c => (v.selectedOptions || []).find(o => o.name === c.name)?.value === c.value));
    if (!own.length) return { ok: false, reason: 'no variant has that combination' };
    return { ok: true, ownIds: own.map(v => v.id), label: constraints.map(c => c.value).join(' / '),
      reason: `title says "${constraints.map(c => c.value).join(' / ')}"` };
  }

  // ── no real options ("Default Title") → use CFS product names behind the SKUs ──
  if (!realOptions.length) {
    const named = variants.map(v => {
      const prodId = String(v.sku || '').split('-')[1];
      return { v, name: prodId ? cfsNameByProdId.get(prodId) || null : null };
    });
    const withName = named.filter(x => x.name);
    if (withName.length >= 1) {
      const diff = distinguishing(withName.map(x => x.name));
      const hits = withName.filter((x, i) => diff[i].length && diff[i].every(w => titleWords.has(w)));
      if (hits.length === 1) return { ok: true, ownIds: [hits[0].v.id], label: hits[0].v.sku, reason: `title matches CFS product "${hits[0].name}"` };
      if (hits.length > 1) return { ok: false, reason: 'title matches more than one CFS product' };
    }
    return { ok: false, reason: 'variants have no options and the title matches no CFS product name' };
  }
  return { ok: false, reason: "the title doesn't name any of the variants" };
}

module.exports = { findOwnVariants, words };
