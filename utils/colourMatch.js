/**
 * Picks which CFS product a Shopify product should become when Step 3 promotes it
 * ("Publish Selected as Main Product") and its variants point at several CFS products.
 *
 * Example: "Bentley Recliner Armchair - Grey Leather" has variants for
 *   1268112 "Bentley Grey Leather Recliner Sofa Armchair"   and
 *   1268116 "Bentley Brown Leather Recliner Sofa Armchair".
 * The colour words that tell the CFS products apart are {grey} vs {brown};
 * the Shopify title contains "grey" → keep 1268112.
 *
 * Safety rules (anything unclear → flag, never guess):
 *   • exactly one CFS product must match, otherwise flag
 *   • a CFS product name we don't have → flag
 *   • a shade word in the Shopify title (light, dark, pale…) that no CFS product
 *     name contains → flag  ("Light Grey" when CFS only has "Grey")
 */

const COLOUR_WORDS = new Set([
  // colours
  'grey', 'gray', 'brown', 'black', 'white', 'cream', 'beige', 'taupe', 'mink', 'ivory', 'stone', 'sand',
  'charcoal', 'anthracite', 'silver', 'gold', 'bronze', 'copper', 'champagne', 'chrome', 'brass',
  'blue', 'navy', 'teal', 'green', 'sage', 'olive', 'emerald', 'red', 'burgundy', 'wine', 'pink', 'blush',
  'orange', 'rust', 'terracotta', 'yellow', 'mustard', 'purple', 'plum', 'lilac', 'aubergine', 'natural', 'tan',
  // finishes that act as colours
  'oak', 'walnut', 'pine', 'ash', 'mango', 'acacia', 'teak', 'marble', 'marquina', 'travertine', 'calacatta',
  'carrara', 'concrete', 'rattan',
  // shades
  'light', 'dark', 'pale', 'deep', 'soft', 'mid', 'warm', 'cool', 'smoked', 'washed',
]);
const SHADE_WORDS = new Set(['light', 'dark', 'pale', 'deep', 'soft', 'mid', 'warm', 'cool', 'smoked', 'washed']);

function colourWords(text) {
  return new Set(String(text || '').toLowerCase().replace(/gray/g, 'grey')
    .split(/[^a-z]+/).filter(w => COLOUR_WORDS.has(w)));
}

/**
 * @param {string} shopifyTitle
 * @param {Array<{prodId:string, name:string|null}>} candidates  one per distinct CFS product
 * @returns {{ ok:boolean, prodId?:string, reason:string }}
 */
function pickCfsProductByColour(shopifyTitle, candidates) {
  const uniq = [...new Map(candidates.map(c => [c.prodId, c])).values()];
  if (uniq.length === 1) return { ok: true, prodId: uniq[0].prodId, reason: 'only one CFS product' };
  const missing = uniq.filter(c => !c.name);
  if (missing.length) return { ok: false, reason: `CFS name not found for ${missing.map(c => c.prodId).join(', ')} — can't compare colours` };

  const title = colourWords(shopifyTitle);
  const sets = uniq.map(c => ({ ...c, words: colourWords(c.name) }));
  const inAll = [...sets[0].words].filter(w => sets.every(s => s.words.has(w)));
  const distinguishing = sets.map(s => ({ ...s, diff: [...s.words].filter(w => !inAll.includes(w)) }));

  // Shade words in the Shopify title that no CFS product mentions → unclear
  const anyCfs = new Set(sets.flatMap(s => [...s.words]));
  const strayShades = [...title].filter(w => SHADE_WORDS.has(w) && !anyCfs.has(w));
  const list = distinguishing.map(d => `${d.prodId} "${d.name}"`).join(' / ');
  if (strayShades.length) {
    return { ok: false, reason: `Title says "${strayShades.join(' ')}" but no CFS product does (${list}) — please check` };
  }
  if (distinguishing.some(d => !d.diff.length)) {
    return { ok: false, reason: `CFS products can't be told apart by colour (${list}) — please check` };
  }
  const matches = distinguishing.filter(d => d.diff.every(w => title.has(w)));
  if (matches.length === 1) {
    return { ok: true, prodId: matches[0].prodId, reason: `colour match: ${matches[0].diff.join(' ')} — ${matches[0].name}` };
  }
  if (!matches.length) return { ok: false, reason: `No CFS product matches the colour in the title (${list}) — please check` };
  return { ok: false, reason: `More than one CFS product matches the title (${matches.map(m => m.prodId).join(', ')}) — please check` };
}

/**
 * Does ONE CFS product fit the Shopify title? (used when a product is promoted to
 * the CFS product behind its own variant)
 *   • a shade word in the title the CFS name doesn't have → no ("Light Grey" vs "Grey")
 *   • title and CFS name both name colours but share none → no ("Brown" vs "Grey")
 *   • no CFS name → can't compare → ok
 */
function titleFitsCfsName(shopifyTitle, cfsName) {
  if (!cfsName) return { ok: true, reason: 'no CFS name to compare' };
  const t = colourWords(shopifyTitle), n = colourWords(cfsName);
  const stray = [...t].filter(w => SHADE_WORDS.has(w) && !n.has(w));
  if (stray.length) return { ok: false, reason: `Title says "${stray.join(' ')}" but the CFS product doesn't ("${cfsName}") — please check` };
  const tCol = [...t].filter(w => !SHADE_WORDS.has(w)), nCol = [...n].filter(w => !SHADE_WORDS.has(w));
  if (tCol.length && nCol.length && !tCol.some(w => n.has(w))) {
    return { ok: false, reason: `Title colour (${tCol.join(' ')}) doesn't match the CFS product "${cfsName}" — please check` };
  }
  return { ok: true, reason: `matches CFS product "${cfsName}"` };
}

module.exports = { pickCfsProductByColour, colourWords, titleFitsCfsName };
