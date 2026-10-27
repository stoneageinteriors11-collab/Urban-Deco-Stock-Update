/**
 * Image Sync — pure planning logic (no network, no Shopify calls).
 *
 * Everything here is deterministic so it can be tested on its own:
 *   node utils/imageSyncCore.test.js
 *
 * Terms used below
 *   CFS record   — one entry from cronItemGalleryUrls_Json.php
 *                  { iProductId, vSKU, mainImage, galleryCount, galleryImages[] }
 *   group        — one CFS product inside a Shopify product (usually one colour)
 *   "key"        — a stable id for a proposed image slot, e.g. "144250:main", "144250:g3"
 */

const path = require('path');

const COLOUR_OPTION_RE = /colou?r|finish|shade/i;

// ── SKU parsing ──────────────────────────────────────────────────────────────
// UD-{cfsProductId}            → { cfsId, varId: null }
// UD-{cfsProductId}-{varId}    → { cfsId, varId }
function parseUdSku(sku) {
  const m = /^UD-(\d+)(?:-(\d+))?$/i.exec(String(sku || '').trim());
  if (!m) return null;
  return { cfsId: m[1], varId: m[2] || null };
}

// ── CFSUD exclusion rule ─────────────────────────────────────────────────────
// Order matters:
//   1. galleryCount must equal the ORIGINAL gallery length, otherwise skip.
//   2. If vSKU contains CFSUD, drop the LAST POSITION of the ORIGINAL gallery.
//   3. mainImage is always kept.
//   (De-duplication / ordering happen later, after this.)
function applyCfsudRule(rec, { dropLast = true } = {}) {   // dropLast=false for other brands (Urban Deco only rule)
  const gallery = Array.isArray(rec.galleryImages) ? rec.galleryImages.slice() : [];
  const declared = Number(rec.galleryCount);
  if (!Number.isFinite(declared) || declared !== gallery.length) {
    return {
      ok: false,
      error: `galleryCount (${rec.galleryCount}) does not match gallery length (${gallery.length})`,
    };
  }
  if (!rec.mainImage) {
    return { ok: false, error: 'CFS record has no mainImage' };
  }

  const excluded = [];
  let kept = gallery;
  if (dropLast && /CFSUD/i.test(String(rec.vSKU || '')) && gallery.length > 0) {
    const lastIndex = gallery.length - 1;
    excluded.push({
      url: gallery[lastIndex],
      galleryPosition: lastIndex + 1, rule: 'cfsud',
      reason: `CFSUD rule – last gallery position (${lastIndex + 1} of ${gallery.length}) excluded`,
    });
    kept = gallery.slice(0, lastIndex);
  }
  return { ok: true, main: rec.mainImage, gallery: kept, excluded };
}

// ── Filename key used for "same picture" matching by name ────────────────────
// Shopify keeps the original filename but may append "_<uuid>" when a name is
// already taken, and may lowercase / swap characters. We normalise both sides.
const UUID_SUFFIX_RE = /_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function nameKey(url) {
  if (!url) return '';
  let base;
  try { base = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); }
  catch (_) { base = String(url).split('?')[0].split('/').pop() || ''; }
  base = base.replace(/\.[a-z0-9]{2,5}$/i, '');       // extension
  base = base.replace(UUID_SUFFIX_RE, '');            // Shopify duplicate suffix
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function fileNameFromUrl(url) {
  try { return decodeURIComponent(path.basename(new URL(url).pathname)); }
  catch (_) { return path.basename(String(url).split('?')[0]); }
}

function colourOptionName(options) {
  const opt = (options || []).find(o => COLOUR_OPTION_RE.test(o.name));
  return opt ? opt.name : null;
}

function variantColour(variant, colourOpt) {
  if (!colourOpt) return null;
  const so = (variant.selectedOptions || []).find(o => o.name === colourOpt);
  return so ? String(so.value).trim() : null;
}


// ── Photo-type filters (after the CFSUD rule) ───────────────────────────────
// CFS galleries mix room photos with white-background cut-outs and odd-shaped
// photos. Urban Deco only uses square room/close-up photos, so by default:
//   • white-background photos are skipped (edgeWhite = share of the photo's border
//     that is plain white; cut-outs measure 0.95+, room photos 0–0.15 on real CFS data)
//   • non-square photos are skipped (more than 2% off square)
// The main image is never skipped — if it looks like a cut-out/non-square we only warn.
// Light-grey studio backgrounds (edgeWhite 0.35–0.75) are kept but flagged to check.
const FILTER = { WHITE_BG_MIN: 0.75, WHITE_BG_CHECK: 0.35, SQUARE_TOLERANCE: 0.02 };
function applyPhotoFilters(r, cfsHash, filters) {
  const gallery = [], excluded = [], warnings = [];
  const info = u => cfsHash.get(u) || {};
  const shape = i => (i.w && i.h ? Math.abs(i.w / i.h - 1) : 0);
  const sizeTxt = i => (i.w && i.h ? `${i.w}×${i.h}` : '');
  r.gallery.forEach((u, idx) => {
    const i = info(u);
    const pos = idx + 1;
    if (filters.skipWhiteBg && typeof i.edgeWhite === 'number' && i.edgeWhite >= FILTER.WHITE_BG_MIN) {
      excluded.push({ url: u, galleryPosition: pos, rule: 'white-background',
        reason: `White background (cut-out photo) — skipped` });
      return;
    }
    if (filters.skipNonSquare && shape(i) > FILTER.SQUARE_TOLERANCE) {
      excluded.push({ url: u, galleryPosition: pos, rule: 'not-square',
        reason: `Not square (${sizeTxt(i)}) — skipped` });
      return;
    }
    if (filters.skipWhiteBg && typeof i.edgeWhite === 'number' && i.edgeWhite >= FILTER.WHITE_BG_CHECK) {
      warnings.push(`gallery photo ${pos} has a light background — check it is not a cut-out (${fileNameFromUrl(u)})`);
    }
    gallery.push(u);
  });
  const m = info(r.main);
  if (typeof m.edgeWhite === 'number' && m.edgeWhite >= FILTER.WHITE_BG_MIN) warnings.push('main image looks like a white-background cut-out (kept — main image is never skipped)');
  if (shape(m) > FILTER.SQUARE_TOLERANCE) warnings.push(`main image is not square (${sizeTxt(m)}) (kept — main image is never skipped)`);
  return { gallery, excluded, warnings };
}

// ── CFS 5-photo limit (all brands) ───────────────────────────────────────────
// The CFS site shows the main photo + the first 4 gallery photos, however many the feed
// has (e.g. Herringford Walnut: 8 in the feed, 01–04 shown). Applied LAST, after the
// CFSUD rule and the photo-type filters, keeping CFS order — so up to 5 good photos.
const GALLERY_LIMIT = 4;
function applyGalleryLimit(r, original = []) {
  if (r.gallery.length <= GALLERY_LIMIT) return { gallery: r.gallery, excluded: [] };
  const excluded = r.gallery.slice(GALLERY_LIMIT).map(u => {
    const pos = original.indexOf(u) + 1 || null;
    return { url: u, galleryPosition: pos, rule: 'limit',
      reason: `Over the CFS 5-photo limit${pos ? ` (gallery photo ${pos})` : ''} — CFS shows the main photo + first ${GALLERY_LIMIT} gallery photos` };
  });
  return { gallery: r.gallery.slice(0, GALLERY_LIMIT), excluded };
}

// ── Visual comparison ────────────────────────────────────────────────────────
// Each image gets a 32x32 colour thumbnail (made in routes/imagesync.js with sharp)
// plus its width/height. We count how much of the thumbnail CLEARLY changed:
//   re-saved / resized / converted copy of the same photo → ~0% changed
//   different colour, angle, product, or a re-shoot       → several % changed
// Looking at "how much clearly changed" (not an overall average) means a change
// to just the table top still shows up even when the background is identical.
const VIS = { PIXEL_CHANGED: 30, SAME_MAX: 0.01, STRICT_SAME_MAX: 0.005, DIFF_MIN: 0.04, SHAPE_DIFF: 0.08 };
function thumbChange(a, b) {
  const x = Buffer.from(a, 'base64'), y = Buffer.from(b, 'base64');
  if (x.length !== y.length || !x.length || x.length % 3) return null;
  let changed = 0;
  const px = x.length / 3;
  for (let i = 0; i < x.length; i += 3) {
    const d = (Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2])) / 3;
    if (d > VIS.PIXEL_CHANGED) changed++;
  }
  return changed / px;
}
function compareVisual(a, b, opts = {}) {
  if (a && b && a.sha && b.sha && a.sha === b.sha) return { verdict: 'same', detail: 'identical file' };
  if (!a || !b || !a.thumb || !b.thumb) return { verdict: 'unknown', detail: 'picture could not be read' };
  const changed = thumbChange(a.thumb, b.thumb);
  if (changed === null) return { verdict: 'unknown', detail: 'picture could not be read' };
  const ra = a.w && a.h ? a.w / a.h : null, rb = b.w && b.h ? b.w / b.h : null;
  const shapeOff = ra && rb ? Math.abs(ra - rb) / ra : 0;
  const detail = `${(changed * 100).toFixed(1)}% of the picture differs, shape difference ${Math.round(shapeOff * 100)}%`;
  if (shapeOff > VIS.SHAPE_DIFF || changed >= VIS.DIFF_MIN) return { verdict: 'different', detail, changed };
  if (changed <= (opts.strict ? VIS.STRICT_SAME_MAX : VIS.SAME_MAX)) return { verdict: 'same', detail, changed };
  return { verdict: opts.strict ? 'different' : 'unsure', detail, changed };
}

// ── Build the dry-run plan for ONE Shopify product ───────────────────────────
//
// input = {
//   product:  Shopify product node (see PRODUCT_FIELDS in routes/imagesync.js)
//   feedById: Map<cfsId string, CFS record>
//   cfsHash:  Map<url, { sha, bytes } | { error }>     (CFS images downloaded)
//   shopHash: Map<mediaId, { sha } | { error }>        (optional, Shopify images)
//   record:   parsed ud_image_sync.record metafield or null
//   choices:  { featured?, detach?: { [mediaId]: boolean }, reuseUnsure?: { [mediaId]: boolean } }  (from preview UI)
// }
//
// Returns a plan object. plan.ok === false means the product is skipped.
function buildProductPlan(input) {
  const { product, feedById, cfsHash = new Map(), shopHash = new Map(), record = null, choices = {} } = input;
  const filters = { skipWhiteBg: choices.skipWhiteBg !== false, skipNonSquare: choices.skipNonSquare !== false };
  const errors = [];
  const warnings = [];

  const media = (product.media?.nodes || []).map((m, i) => ({
    mediaId: m.id,
    position: i + 1,
    alt: m.alt || '',
    type: m.mediaContentType,
    status: m.status,
    url: m.image?.url || m.originalSource?.url || null,
  }));
  const variants = (product.variants?.nodes || []).map((v, i) => ({
    id: v.id,
    sku: v.sku || '',
    title: v.title,
    position: v.position || i + 1,
    selectedOptions: v.selectedOptions || [],
    mediaIds: (v.media?.nodes || []).map(n => n.id),
  })).sort((a, b) => a.position - b.position);

  const featuredMediaId = product.featuredMedia?.id || media[0]?.mediaId || null;
  const colourOpt = colourOptionName(product.options);

  // ── 1. Map variants → CFS products (groups) ────────────────────────────────
  const groupsById = new Map();           // cfsId → group
  const groupOrder = [];                  // cfsIds in Shopify variant/option order
  const notInCfs = [];                    // variants whose CFS product is missing from the feed
  for (const v of variants) {
    const parsed = parseUdSku(v.sku);
    if (!parsed) { errors.push(`Variant "${v.title}" has an unrecognised SKU "${v.sku}"`); continue; }
    const rec = feedById.get(parsed.cfsId);
    if (!rec) {
      notInCfs.push({ sku: v.sku, title: v.title, cfsId: parsed.cfsId });
      errors.push(`Couldn't find in CFS: CFS product ${parsed.cfsId} (variant ${v.title}, SKU ${v.sku}) is not in the CFS image feed`);
      continue;
    }
    if (!groupsById.has(parsed.cfsId)) {
      groupsById.set(parsed.cfsId, { cfsId: parsed.cfsId, vSKU: rec.vSKU, rec, variants: [], colours: new Set() });
      groupOrder.push(parsed.cfsId);
    }
    const g = groupsById.get(parsed.cfsId);
    g.variants.push(v);
    const c = variantColour(v, colourOpt);
    if (c) g.colours.add(c);
  }

  // Ambiguity: one CFS product spread across several colours can't be split.
  for (const g of groupsById.values()) {
    if (g.colours.size > 1) {
      errors.push(`Ambiguous mapping: CFS product ${g.cfsId} is used by several colours (${[...g.colours].join(', ')})`);
    }
  }
  if (!variants.length) errors.push('Product has no variants');

  // ── 2. Apply the CFSUD rule per group ─────────────────────────────────────
  const groups = [];
  for (const cfsId of groupOrder) {
    const g = groupsById.get(cfsId);
    const r = applyCfsudRule(g.rec, { dropLast: choices.cfsudRule !== false });
    if (!r.ok) { errors.push(`CFS product ${cfsId} (${g.vSKU}): ${r.error}`); continue; }
    // Photo-type filters run AFTER the CFSUD rule (which works on original positions).
    const f = applyPhotoFilters(r, cfsHash, filters);
    r.gallery = f.gallery; r.excluded = [...r.excluded, ...f.excluded];
    for (const w of f.warnings) warnings.push(`${g.vSKU}: ${w}`);
    // CFS 5-photo limit runs last: main + first 4 gallery photos that are left
    const lim = applyGalleryLimit(r, Array.isArray(g.rec.galleryImages) ? g.rec.galleryImages : []);
    r.gallery = lim.gallery; r.excluded = [...r.excluded, ...lim.excluded];
    const label = colourOpt ? ([...g.colours][0] || '') : (product.title || '');
    groups.push({
      cfsId, vSKU: g.vSKU, label,
      galleryCount: Number(g.rec.galleryCount),
      main: r.main, gallery: r.gallery, excluded: r.excluded,
      variantIds: g.variants.map(v => v.id),
      variantSkus: g.variants.map(v => v.sku),
    });
  }

  // ── 3. Proposed CFS image slots (main first, then gallery), de-duplicated ──
  const slots = [];
  const seenUrl = new Map();   // url → slot key
  const seenSha = new Map();   // sha → slot key
  const slotByKey = new Map();
  for (const g of groups) {
    const entries = [{ url: g.main, role: 'main', idx: 0 }, ...g.gallery.map((u, i) => ({ url: u, role: 'gallery', idx: i + 1 }))];
    for (const e of entries) {
      const key = `${g.cfsId}:${e.role === 'main' ? 'main' : 'g' + e.idx}`;
      const h = cfsHash.get(e.url);
      if (h && h.error) { errors.push(`Broken CFS image (${h.error}): ${e.url}`); continue; }
      const sha = h?.sha || null;
      const dupOf = seenUrl.get(e.url) || (sha && seenSha.get(sha));
      if (dupOf) {
        // Same picture already in the gallery — share it, don't upload twice.
        if (e.role === 'main') g.mainKey = dupOf;
        warnings.push(`Duplicate CFS image skipped (${fileNameFromUrl(e.url)} = ${dupOf})`);
        continue;
      }
      const slot = { key, cfsId: g.cfsId, group: g.label, role: e.role, src: e.url, sha, bytes: h?.bytes || null };
      slots.push(slot); slotByKey.set(key, slot);
      seenUrl.set(e.url, key); if (sha) seenSha.set(sha, key);
      if (e.role === 'main') g.mainKey = key;
    }
  }

  // ── 4. Match existing Shopify media to proposed slots ─────────────────────
  const recImages = new Map((record?.images || []).map(i => [i.mediaId, i]));
  const recPending = new Map(((record?.pending && record.pending.uploads) || []).map(i => [i.mediaId, i]));
  const usedMedia = new Set();
  const excludedUrls = new Map();
  for (const g of groups) for (const x of g.excluded) excludedUrls.set(x.url, x);

  // 4a. app record says this media came from this exact CFS URL
  for (const s of slots) {
    for (const m of media) {
      if (usedMedia.has(m.mediaId)) continue;
      const r = recImages.get(m.mediaId) || recPending.get(m.mediaId);
      if (r && r.src === s.src) {
        if (s.sha && r.sha && s.sha !== r.sha) {
          s.updated = { oldMediaId: m.mediaId };       // same URL, new picture
          break;
        }
        s.mediaId = m.mediaId; s.matchedBy = 'record'; usedMedia.add(m.mediaId); break;
      }
    }
  }
  // 4b. same file name (ignoring Shopify's random suffix) — then CHECK THE PICTURE.
  //     A name match alone isn't trusted: CFS may have swapped the picture
  //     but kept the name. The visual check decides reuse / replace / unsure.
  const reuseUnsure = choices.reuseUnsure || {};
  for (const s of slots) {
    if (s.mediaId || s.updated) continue;
    const k = nameKey(s.src);
    const m = media.find(m => !usedMedia.has(m.mediaId) && m.type === 'IMAGE' && nameKey(m.url) === k);
    if (!m) continue;
    const v = compareVisual(cfsHash.get(s.src), shopHash.get(m.mediaId));
    s.visual = v;
    if (v.verdict === 'same') {
      s.mediaId = m.mediaId; s.matchedBy = 'name+picture'; usedMedia.add(m.mediaId);
    } else if (v.verdict === 'unknown') {
      s.mediaId = m.mediaId; s.matchedBy = 'name-only'; usedMedia.add(m.mediaId);
      warnings.push(`Matched by file name only — picture could not be compared (${fileNameFromUrl(s.src)})`);
    } else if (v.verdict === 'unsure' && reuseUnsure[m.mediaId]) {
      s.mediaId = m.mediaId; s.matchedBy = 'name (unsure, kept by you)'; usedMedia.add(m.mediaId);
    } else {
      // different, or unsure (default = treat as different): upload the CFS picture, old one is replaced
      s.nameClash = { oldMediaId: m.mediaId, verdict: v.verdict, detail: v.detail };
      usedMedia.add(m.mediaId);            // reserved: shown as "replaced" / "please check" below
    }
  }
  // 4c. same picture under a different name (exact file, or visually identical
  //     AND same colour AND same alt group — so a White photo never matches Grey)
  for (const s of slots) {
    if (s.mediaId || s.updated || s.nameClash) continue;
    const cfsV = cfsHash.get(s.src);
    const m = media.find(m => {
      if (usedMedia.has(m.mediaId) || m.type !== 'IMAGE') return false;
      const sh = shopHash.get(m.mediaId);
      if (!sh) return false;
      if (cfsV?.sha && sh.sha && cfsV.sha === sh.sha) return true;
      if (m.alt && s.group && m.alt !== s.group) return false;   // never match across colours
      return compareVisual(cfsV, sh, { strict: true }).verdict === 'same';
    });
    if (m) { s.mediaId = m.mediaId; s.matchedBy = 'picture'; usedMedia.add(m.mediaId); }
  }

  // ── 5. Classify everything else that is on Shopify now ────────────────────
  const detachChoices = choices.detach || {};
  // "Replace with CFS photos": photos that don't match any CFS photo are detached by default
  // (still kept in Shopify Files + the backup zip; any single photo can be unticked to keep it).
  const replaceMode = !!choices.replaceMode;
  const others = [];   // existing media not matched to a CFS slot
  for (const m of media) {
    const clashSlot = slots.find(s => s.nameClash?.oldMediaId === m.mediaId);
    if (usedMedia.has(m.mediaId) && !clashSlot) continue;
    let kind, reason, defaultDetach = false;
    const rec = recImages.get(m.mediaId);
    const updatedSlot = slots.find(s => s.updated?.oldMediaId === m.mediaId);
    const exclMatch = [...excludedUrls.values()].find(x =>
      (rec && rec.src === x.url) || (m.type === 'IMAGE' && nameKey(m.url) === nameKey(x.url)) ||
      (m.type === 'IMAGE' && compareVisual(cfsHash.get(x.url), shopHash.get(m.mediaId), { strict: true }).verdict === 'same'));
    if (m.type !== 'IMAGE') {
      kind = 'other-media'; reason = `${m.type} — not touched`;
    } else if (clashSlot && clashSlot.nameClash.verdict === 'unsure') {
      kind = 'unsure'; defaultDetach = true;
      reason = `Please check: same file name as the CFS photo but the picture looks a bit different (${clashSlot.nameClash.detail}). The new CFS photo will be uploaded and this one detached — click "Reuse this one instead" to keep it`;
    } else if (clashSlot) {
      kind = 'replaced'; defaultDetach = true;
      reason = `Same name, different picture (${clashSlot.nameClash.detail}) — replaced by the current CFS photo`;
    } else if (updatedSlot) {
      kind = 'replaced'; reason = `CFS picture changed at the same URL — replaced by new upload`; defaultDetach = true;
    } else if (exclMatch) {
      kind = 'excluded-live'; defaultDetach = true;
      reason = `Currently shown, but excluded — ${exclMatch.rule === 'white-background' ? 'white-background cut-out' : exclMatch.rule === 'not-square' ? 'not square' : exclMatch.rule === 'limit' ? 'over the CFS 5-photo limit' : 'CFSUD rule'} (${fileNameFromUrl(exclMatch.url)})`;
    } else if (rec) {
      kind = 'removed-at-cfs'; defaultDetach = replaceMode;
      reason = replaceMode ? 'Added by the app before, no longer in the CFS feed — detached (Replace with CFS photos)'
                           : 'Added by the app before, no longer in the CFS feed — review';
    } else {
      kind = 'manual'; defaultDetach = replaceMode;
      reason = replaceMode ? 'Not matched to any CFS photo — detached (Replace with CFS photos). Untick to keep it'
                           : 'Not from CFS (manual?) — kept';
    }
    let detach = Object.prototype.hasOwnProperty.call(detachChoices, m.mediaId) ? !!detachChoices[m.mediaId] : defaultDetach;
    if (m.type !== 'IMAGE') detach = false;
    others.push({ ...m, kind, reason, defaultDetach, detach,
      compareWith: clashSlot ? clashSlot.src : null, replacedBy: clashSlot ? clashSlot.key : null });
  }

  // Featured image: keep the current one unless the preview chose another.
  // choices.featured may be an existing media id OR a proposed slot key (e.g. a new upload)
  let featured = choices.featured || choices.featuredMediaId || featuredMediaId;
  const featuredOther = others.find(o => o.mediaId === featured);
  const firstCfsKey = groups[0] && groups[0].mainKey;
  if (featuredOther && featuredOther.detach && replaceMode && !choices.featured && firstCfsKey) {
    // Replace mode and nobody picked a featured photo: the first colour's CFS main photo becomes featured.
    featured = firstCfsKey;
    warnings.push('Featured photo changes to the CFS main photo (the old featured photo is not a CFS photo and is being replaced)');
  } else if (featuredOther && featuredOther.detach) {
    warnings.push('The current featured image was marked for removal — it is kept because it is the featured image');
    featuredOther.detach = false;
  }

  // ── 6. Final order ────────────────────────────────────────────────────────
  // Per group: CFS main, CFS gallery (CFS order), then kept non-CFS photos whose
  // alt text is this group's colour. Then everything else that is kept.
  const order = [];
  const pushed = new Set();
  const push = item => { const id = item.mediaId || item.key; if (pushed.has(id)) return; pushed.add(id); order.push(item); };
  for (const g of groups) {
    for (const s of slots.filter(s => s.cfsId === g.cfsId)) {
      push({ key: s.key, mediaId: s.mediaId || null, action: s.mediaId ? 'reuse' : 'upload', src: s.src, sha: s.sha,
        alt: g.label, group: g.label, cfsId: g.cfsId, role: s.role, matchedBy: s.matchedBy || null,
        // Only colour products need exact alt text (the theme filters the gallery by it).
        altFix: !!(colourOpt && s.mediaId && (media.find(m => m.mediaId === s.mediaId)?.alt || '') !== g.label),
        replaces: s.updated?.oldMediaId || s.nameClash?.oldMediaId || null,
        visual: s.visual ? s.visual.detail : null });
    }
    for (const o of others.filter(o => !o.detach && o.alt === g.label && o.type === 'IMAGE')) {
      push({ key: o.mediaId, mediaId: o.mediaId, action: 'keep', kind: o.kind, alt: o.alt, group: o.alt, url: o.url });
    }
  }
  for (const o of others.filter(o => !o.detach)) {
    push({ key: o.mediaId, mediaId: o.mediaId, action: 'keep', kind: o.kind, alt: o.alt, group: o.alt, url: o.url });
  }
  // Featured stays first
  const fIdx = order.findIndex(o => (o.mediaId && o.mediaId === featured) || o.key === featured);
  if (fIdx > 0) order.unshift(order.splice(fIdx, 1)[0]);
  if (featured && fIdx === -1) warnings.push('Chosen featured image is not in the final gallery — first photo will be featured');
  order.forEach((o, i) => { o.position = i + 1; });

  if (order.length > 250) errors.push(`Would have ${order.length} photos — Shopify allows 250 per product`);

  // ── 7. Variant assignments ────────────────────────────────────────────────
  const variantAssign = [];
  for (const g of groups) {
    const mainSlot = slotByKey.get(g.mainKey);
    for (const vid of g.variantIds) {
      const v = variants.find(x => x.id === vid);
      const target = mainSlot ? (mainSlot.mediaId || mainSlot.key) : null;
      variantAssign.push({
        variantId: vid, sku: v.sku, title: v.title,
        currentMediaId: v.mediaIds[0] || null,
        targetKey: mainSlot ? mainSlot.key : null,
        targetMediaId: mainSlot?.mediaId || null,
        change: !(mainSlot?.mediaId && v.mediaIds[0] === mainSlot.mediaId),
      });
    }
  }

  const detach = others.filter(o => o.detach).map(o => ({ mediaId: o.mediaId, kind: o.kind, reason: o.reason, url: o.url, alt: o.alt }));
  const uploads = order.filter(o => o.action === 'upload');

  const currentOrder = media.map(m => m.mediaId);
  const finalExisting = order.filter(o => o.mediaId).map(o => o.mediaId);
  const orderChanges = uploads.length > 0 || detach.length > 0 ||
    finalExisting.join(',') !== currentOrder.filter(id => finalExisting.includes(id)).join(',');

  const counts = {
    current: media.length,
    proposed: order.length,
    reuse: order.filter(o => o.action === 'reuse').length,
    upload: uploads.length,
    keep: order.filter(o => o.action === 'keep').length,
    excluded: groups.reduce((a, g) => a + g.excluded.length, 0),
    excludedCfsud: groups.reduce((a, g) => a + g.excluded.filter(x => x.rule === 'cfsud').length, 0),
    excludedWhiteBg: groups.reduce((a, g) => a + g.excluded.filter(x => x.rule === 'white-background').length, 0),
    excludedNotSquare: groups.reduce((a, g) => a + g.excluded.filter(x => x.rule === 'not-square').length, 0),
    excludedLimit: groups.reduce((a, g) => a + g.excluded.filter(x => x.rule === 'limit').length, 0),
    detach: detach.length,
    altFix: order.filter(o => o.altFix).length,
    variantChanges: variantAssign.filter(v => v.change).length,
    manual: others.filter(o => o.kind === 'manual' && !o.detach).length,   // manual photos that STAY
    review: others.filter(o => o.kind === 'removed-at-cfs').length,
    unsure: others.filter(o => o.kind === 'unsure').length,
    replacedSameName: others.filter(o => o.kind === 'replaced').length,
  };
  const noChange = counts.upload === 0 && counts.detach === 0 && counts.altFix === 0 &&
    counts.variantChanges === 0 && !orderChanges && (order[0] && (order[0].mediaId === featuredMediaId));

  return {
    productId: product.id, handle: product.handle, title: product.title, status: product.status,
    updatedAt: product.updatedAt, colourOption: colourOpt,
    ok: errors.length === 0, errors, warnings,
    // 'all' = no variant of this product exists in CFS, 'some' = only some variants are missing
    notInCfs: notInCfs.length === 0 ? null : (notInCfs.length === variants.length ? 'all' : 'some'),
    notInCfsVariants: notInCfs,
    groups: groups.map(g => ({ cfsId: g.cfsId, vSKU: g.vSKU, label: g.label, galleryCount: g.galleryCount,
      main: g.main, gallery: g.gallery, excluded: g.excluded, variantSkus: g.variantSkus })),
    current: media.map(m => ({ ...m, featured: m.mediaId === featuredMediaId,
      variants: variants.filter(v => v.mediaIds.includes(m.mediaId)).map(v => v.sku) })),
    proposed: order,
    detach,
    others: others.map(o => ({ mediaId: o.mediaId, kind: o.kind, reason: o.reason, defaultDetach: o.defaultDetach, detach: o.detach, url: o.url, alt: o.alt,
      compareWith: o.compareWith || null, reuse: !!reuseUnsure[o.mediaId] })),
    variantAssign,
    featured: { current: featuredMediaId, proposed: featured },
    replaceMode, filters,
    counts, noChange,
  };
}

// Simple CSV helper
function toCsv(rows) {
  const esc = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map(r => r.map(esc).join(',')).join('\n');
}

// Flatten plans into preview CSV rows
function plansToCsv(plans) {
  const rows = [['handle', 'title', 'status', 'ok', 'line_type', 'position', 'action', 'colour', 'cfs_product', 'role',
    'source_or_current_url', 'shopify_media_id', 'matched_by', 'note']];
  for (const p of plans) {
    for (const e of p.errors) rows.push([p.handle, p.title, p.status, p.ok, 'error', '', 'skip', '', '', '', '', '', '', e]);
    for (const w of p.warnings) rows.push([p.handle, p.title, p.status, p.ok, 'warning', '', '', '', '', '', '', '', '', w]);
    for (const o of p.proposed) rows.push([p.handle, p.title, p.status, p.ok, 'proposed', o.position, o.action, o.group || '',
      o.cfsId || '', o.role || o.kind || '', o.src || o.url || '', o.mediaId || '', o.matchedBy || '',
      [o.altFix ? 'alt text corrected' : '', o.replaces ? `replaces ${o.replaces}` : '', o.visual ? `picture check: ${o.visual}` : ''].filter(Boolean).join('; ')]);
    for (const g of p.groups) for (const x of g.excluded) rows.push([p.handle, p.title, p.status, p.ok, 'excluded', '', 'exclude',
      g.label, g.cfsId, 'gallery', x.url, '', '', x.reason]);
    for (const d of p.detach) rows.push([p.handle, p.title, p.status, p.ok, 'detach', '', 'detach', d.alt, '', d.kind, d.url || '', d.mediaId, '', d.reason]);
    for (const o of p.others.filter(o => o.kind === 'unsure' && !o.detach)) rows.push([p.handle, p.title, p.status, p.ok, 'please-check', '', 'keep', o.alt, '', o.kind, o.url || '', o.mediaId, '', o.reason]);
    for (const v of p.variantAssign) rows.push([p.handle, p.title, p.status, p.ok, 'variant', '', v.change ? 'assign' : 'unchanged',
      '', '', v.sku, '', v.targetMediaId || v.targetKey || '', '', v.title]);
  }
  return toCsv(rows);
}

// ── Photos to remove when variants are deleted (Step 3) ──────────────────────
//
// input = {
//   product:           Shopify product node (media + variants), BEFORE the delete
//   removedVariantIds: variant ids that Step 3 is about to delete
//   feedById, cfsHash, shopHash: same as buildProductPlan (CFS feed + fingerprints)
// }
// A "group" is a colour (or, for products without a colour option, a CFS product).
// Only groups with NO variants left are orphaned — deleting one size of a colour
// that keeps other sizes removes no photos.
// Each current photo gets a verdict:
//   remove — belongs to an orphaned group (matches its CFS photos by name/picture,
//            alt text = that colour, or is the photo linked to a deleted variant)
//   keep   — belongs to a remaining group, or is not a picture (video etc.)
//   check  — can't be tied to any group → kept, flagged for a human
function planVariantRemoval(input) {
  const { product, removedVariantIds = [], feedById = new Map(), cfsHash = new Map(), shopHash = new Map() } = input;
  const removedSet = new Set(removedVariantIds);
  const colourOpt = colourOptionName(product.options);
  const variants = (product.variants?.nodes || []).map(v => ({
    id: v.id, sku: v.sku || '', title: v.title,
    colour: variantColour(v, colourOpt),
    cfsId: (parseUdSku(v.sku) || {}).cfsId || null,
    mediaIds: (v.media?.nodes || []).map(n => n.id),
  }));
  const groupOf = v => (colourOpt ? (v.colour || v.title) : (v.cfsId || v.sku || v.title));
  const removed = variants.filter(v => removedSet.has(v.id));
  const remaining = variants.filter(v => !removedSet.has(v.id));
  const remainingGroups = new Set(remaining.map(groupOf));
  const orphanGroups = new Set(removed.map(groupOf).filter(g => !remainingGroups.has(g)));

  // CFS photos (ALL of them — incl. ones Image Sync would skip — because old copies may be live)
  const cfsPhotos = (vs) => {
    const out = [];
    for (const v of vs) {
      const rec = v.cfsId && feedById.get(v.cfsId);
      if (!rec) continue;
      [rec.mainImage, ...(rec.galleryImages || [])].forEach((u, i) => u && out.push({ url: u, group: groupOf(v), cfsId: v.cfsId, pos: i === 0 ? 'main photo' : `gallery photo ${i}` }));
    }
    return out;
  };
  const orphanVariants = removed.filter(v => orphanGroups.has(groupOf(v)));
  const orphanCfs = cfsPhotos(orphanVariants);
  const keepCfs = cfsPhotos(remaining);
  const orphanCfsMissing = [...new Set(orphanVariants.filter(v => !v.cfsId || !feedById.get(v.cfsId)).map(groupOf))];

  const matchCfs = (m, list) => {
    for (const c of list) {
      if (nameKey(c.url) === nameKey(m.url)) {
        const v = compareVisual(cfsHash.get(c.url), shopHash.get(m.mediaId));
        if (v.verdict === 'different') continue;
        return { ...c, how: v.verdict === 'same' ? 'name + picture' : 'file name' };
      }
    }
    for (const c of list) {
      const v = compareVisual(cfsHash.get(c.url), shopHash.get(m.mediaId), { strict: true });
      if (v.verdict === 'same') return { ...c, how: 'same picture' };
    }
    return null;
  };

  const items = [];
  const media = product.media?.nodes || [];
  media.forEach((n, i) => {
    const m = { mediaId: n.id, position: i + 1, alt: (n.alt || '').trim(), type: n.mediaContentType,
      url: n.image?.url || n.originalSource?.url || null };
    const usedByRemaining = remaining.filter(v => v.mediaIds.includes(m.mediaId));
    const usedByRemoved = removed.filter(v => v.mediaIds.includes(m.mediaId));
    let verdict, reason, cfs = null;
    if (m.type !== 'IMAGE') { verdict = 'keep'; reason = `${m.type} — not touched`; }
    else if (!orphanGroups.size) { verdict = 'keep'; reason = 'No colour is fully removed — photos stay'; }
    else if (usedByRemaining.length) { verdict = 'keep'; reason = `Main photo of remaining variant ${usedByRemaining[0].title}`; }
    else if ((cfs = matchCfs(m, keepCfs))) { verdict = 'keep'; reason = `Matches CFS ${cfs.pos} of remaining ${cfs.group} (${cfs.how})`; }
    else if (m.alt && remainingGroups.has(m.alt)) { verdict = 'keep'; reason = `Alt text "${m.alt}" = a remaining colour`; }
    else if ((cfs = matchCfs(m, orphanCfs))) { verdict = 'remove'; reason = `Matches CFS ${cfs.pos} of removed ${cfs.group} (${cfs.how})`; }
    else if (m.alt && orphanGroups.has(m.alt)) { verdict = 'remove'; reason = `Alt text "${m.alt}" = removed colour`; }
    else if (usedByRemoved.length && usedByRemoved.every(v => orphanGroups.has(groupOf(v)))) {
      verdict = 'remove'; reason = `Main photo of deleted variant ${usedByRemoved[0].title}`;
    } else { verdict = 'check'; reason = "Can't tell which colour this photo belongs to — kept, please check"; }
    items.push({ ...m, verdict, reason, cfsUrl: cfs ? cfs.url : null });
  });

  const keepCount = items.filter(x => x.verdict !== 'remove').length;
  const warnings = [];
  if (orphanCfsMissing.length) warnings.push(`No CFS photos for removed ${orphanCfsMissing.join(', ')} — matched by alt text / variant photo only`);
  if (media.length && keepCount === 0) warnings.push('Every photo would be removed — nothing will be removed from this product, please check');
  if (media.length && keepCount === 0) for (const it of items) if (it.verdict === 'remove') { it.verdict = 'check'; it.reason += ' — kept because it would leave the product with no photos'; }

  return {
    productId: product.id, handle: product.handle, title: product.title,
    removedGroups: [...orphanGroups], remainingGroups: [...remainingGroups],
    items, warnings,
    counts: { remove: items.filter(x => x.verdict === 'remove').length, keep: items.filter(x => x.verdict === 'keep').length,
      check: items.filter(x => x.verdict === 'check').length },
  };
}

module.exports = {
  parseUdSku, applyCfsudRule, nameKey, fileNameFromUrl, colourOptionName,
  buildProductPlan, plansToCsv, toCsv, compareVisual, VIS, applyPhotoFilters, FILTER, planVariantRemoval, applyGalleryLimit, GALLERY_LIMIT,
};
