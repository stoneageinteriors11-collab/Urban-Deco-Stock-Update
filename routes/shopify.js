const express = require('express');
const axios   = require('axios');
require('dotenv').config();

const { fetchCfsProducts, buildSkuCodeMap } = require('../utils/cfsApi');
// Image Sync helpers (photo check, backup check, detach) — see routes/imagesync.js
const imageSync = require('./imagesync').helpers;
const { pickCfsProductByColour, titleFitsCfsName } = require('../utils/colourMatch');
const undo = require('../utils/undoLog');
const { findOwnVariants, words: ownWords, distinguishing: ownDistinguishing } = require('../utils/ownVariant');

// CFS product names (stock feed), cached 30 min per brand — used to tell "Default"-option
// variants apart and to check colours. brandId empty = Urban Deco (215); Other Brands
// pages pass their brandId so the names come from that brand's feed.
const cfsNamesCache = new Map();   // brandKey → { at, map, codes }
async function getCfsInfo(brandId) {
  const key = brandId ? String(brandId) : '215';
  const hit = cfsNamesCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit;
  const map = new Map(), codes = new Map();
  try {
    const feed = key === '215' ? await fetchCfsProducts() : await require('../utils/brands').fetchBrandFeed(key);
    for (const p of feed) { map.set(String(p.productId), p.productName || null); if (p.productCode) codes.set(String(p.productId), String(p.productCode).trim()); }
  } catch (e) { console.warn(`  ⚠ CFS product names unavailable (brand ${key}):`, e.message); return { map, codes }; }
  const out = { at: Date.now(), map, codes };
  cfsNamesCache.set(key, out);
  return out;
}
async function getCfsNames(brandId) { return (await getCfsInfo(brandId)).map; }

// Which variant IS this product?
//   Other brands (brandCtx set), in this order:
//     1. custom.iproductid  → the variant whose SKU has that CFS product number (UD-1276462…)
//     2. custom.product_code → the variant whose CFS product code is that code; if the code isn't
//        active in CFS any more and only one variant is being removed, that one is the product's own
//     iproductid and product code pointing at different variants → flag
//     3. the title (utils/ownVariant.js), as before
//   Urban Deco (no brandCtx): the title only, unchanged.
function resolveOwn(product, handle, variants, cfsNames, brandCtx = null, deletingSkus = null) {
  if (brandCtx) {
    const iid = String(product.iid?.value || '').trim();
    const pcode = String(product.pcode?.value || '').trim().toUpperCase();
    const ownOf = list => ({ ok: true, ownIds: list.map(v => v.id), label: list.map(variantLabel).join(', '),
      constraints: (list[0].selectedOptions || []).filter(o => o.value !== 'Default Title') });
    const byIid = iid ? variants.filter(v => parseSku(v.sku).prodId === iid) : [];
    let byCode = [];
    if (pcode) {
      byCode = variants.filter(v => String(brandCtx.codes.get(parseSku(v.sku).prodId) || '').trim().toUpperCase() === pcode);
      const codeActive = [...brandCtx.codes.values()].some(c => String(c).trim().toUpperCase() === pcode);
      if (!byCode.length && !codeActive && deletingSkus && deletingSkus.size === 1) byCode = variants.filter(v => deletingSkus.has(v.sku));
    }
    if (byIid.length && byCode.length && !byCode.every(v => byIid.includes(v))) {
      return { ok: false, conflict: true, reason: `iproductid ${iid} says "${byIid.map(variantLabel).join(', ')}" but product code ${pcode} says "${byCode.map(variantLabel).join(', ')}"` };
    }
    if (byIid.length) return { ...ownOf(byIid), reason: `iproductid ${iid}` };
    if (byCode.length) return { ...ownOf(byCode), reason: `product code ${pcode}` };
  }
  return findOwnVariants({ title: product.title, handle }, variants, cfsNames);
}

// Is the variant being removed this product's OWN variant? (see utils/ownVariant.js)
//   own variant(s) being removed and
//     A. the product's other variants are also sold on another active product (Carrera:
//        separate White / Beige / Black products) → draft the whole product
//     B. this is the only product selling them (Vernal: White product with a Grey variant,
//        no Grey product) → ask: keep it as the Grey product (rename) / Draft / Skip
//   otherwise → delete just the missing variant(s)
// skuHomes = { sku: [handles of ACTIVE products that have this SKU] } from the page.
// Without it (older page) the old rule applies: draft.
function ownDraftCheck(product, handle, deletingSkus, cfsNames, skuHomes = null, brandCtx = null) {
  const variants = product.variants.edges.map(e => e.node);
  const r = resolveOwn(product, handle, variants, cfsNames, brandCtx, deletingSkus);
  if (r.conflict) {
    const remaining = variants.filter(v => !deletingSkus.has(v.sku));
    return { draft: false, ask: true, own: { label: '?', constraints: [] }, remaining, homeless: remaining,
      reason: `can't tell which variant this product is: ${r.reason} — please check` };
  }
  if (!r.ok) return { draft: false, note: `couldn't tell which variant this product is (${r.reason}) — only the missing variant(s) are deleted` };
  const own = variants.filter(v => r.ownIds.includes(v.id));
  const ownSkus = own.map(v => v.sku);
  if (own.every(v => deletingSkus.has(v.sku))) {
    const base = `this product is "${r.label}" (${ownSkus.join(', ')}) and that is not in CFS`;
    const remaining = variants.filter(v => !deletingSkus.has(v.sku));
    if (skuHomes && remaining.length) {
      const homeless = remaining.filter(v => !(skuHomes[v.sku] || []).some(h => h !== handle));
      if (homeless.length) {
        return { draft: false, ask: true, own: r, remaining, homeless,
          reason: `${base}, but ${homeless.map(v => `"${variantLabel(v)}"`).join(', ')} ${homeless.length > 1 ? 'are' : 'is'} only sold on this product — choose what to do` };
      }
      return { draft: true, reason: `${base} — the other colours are sold on their own products, so this product goes to DRAFT, variants and photos kept` };
    }
    return { draft: true, reason: `${base} — whole product goes to DRAFT, variants and photos kept` };
  }
  return { draft: false, note: `this product is "${r.label}" (${ownSkus.join(', ')}), still in CFS — only the other variant(s) are deleted` };
}

// "Keep as the Grey product": swap the own option value (e.g. White) for the kept variant's
// value (Grey) in the title and the handle. "Vernal Coffee Table - White Sintered Stone"
// → "Vernal Coffee Table - Grey Sintered Stone", vernal-…-white-… → vernal-…-grey-…
// If the word isn't found, nothing is renamed and the log says to rename it by hand.
const slugify = t => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const escRe = t => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function renamePlan(product, handle, own, keepNode) {
  const pairs = (own?.constraints || []).map(c => ({ from: c.value, to: (keepNode.selectedOptions || []).find(o => o.name === c.name)?.value }))
    .filter(x => x.from && x.to && x.from !== x.to);
  if (!pairs.length) return { ok: false, note: `title "${product.title}" kept — couldn't work out the new name, please rename it by hand` };
  let title = product.title, newHandle = handle;
  for (const { from, to } of pairs) {
    const re = new RegExp(`(^|[^A-Za-z0-9])${escRe(from)}(?=$|[^A-Za-z0-9])`, 'i');
    if (!re.test(title)) return { ok: false, note: `"${from}" isn't in the title "${product.title}" — title kept, please rename it by hand` };
    title = title.replace(re, (m, pre) => pre + to);
    const hre = new RegExp(`(^|-)${escRe(slugify(from))}(?=-|$)`);
    if (hre.test(newHandle)) newHandle = newHandle.replace(hre, (m, pre) => pre + slugify(to));
  }
  return { ok: true, title, handle: newHandle, changedHandle: newHandle !== handle };
}
const PRODUCT_RENAME_MUTATION = `mutation R($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id title handle } userErrors { field message } } }`;
async function applyRename(client, product, handle, plan, undoRun) {
  if (!plan?.ok) return { ok: false, message: plan?.note || 'not renamed' };
  const input = { id: product.id, title: plan.title };
  if (plan.changedHandle) { input.handle = plan.handle; input.redirectNewHandle = true; }
  const r = await gql(client, PRODUCT_RENAME_MUTATION, { product: input });
  const errs = r?.productUpdate?.userErrors || [];
  if (errs.length) return { ok: false, message: `rename failed: ${errs.map(e => e.message).join(', ')}` };
  rec(undoRun, { type: 'title', productId: product.id, handle, title: product.title,
    before: { title: product.title, handle }, after: { title: plan.title, handle: r.productUpdate.product.handle } });
  return { ok: true, message: `Title renamed "${product.title}" → "${plan.title}"${plan.changedHandle ? `, URL /${handle} → /${r.productUpdate.product.handle} (old URL redirects)` : ''} — you can change the title manually later in Shopify` };
}
// Options for "Needs your decision" when a product's own variant is gone but its other
// variants are only sold here (case B)
function keepAsOptions(product, handle, own, homeless) {
  const opts = homeless.map(v => {
    const rn = renamePlan(product, handle, own, v);
    return { value: `keepas:${v.id}`, label: rn.ok
      ? `Keep as the "${variantLabel(v)}" product — delete "${own.label}", title → "${rn.title}"${rn.changedHandle ? `, URL → /${rn.handle}` : ''}`
      : `Keep as the "${variantLabel(v)}" product — delete "${own.label}" (${rn.note})` };
  });
  opts.push({ value: 'draft', label: 'Set the whole product to Draft (variants & photos kept)' });
  opts.push({ value: 'skip', label: 'Skip — leave as it is' });
  return opts;
}
// Adds an entry to a live run's undo record (no-op on dry runs)
const rec = (run, entry) => { if (run) undo.add(run, entry); };

const router = express.Router();

// ── Shopify GraphQL client ────────────────────────────────────────────────────
function graphqlClient() {
  const store   = process.env.SHOPIFY_STORE;
  const token   = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_API_TOKEN;
  const version = process.env.SHOPIFY_API_VERSION || '2026-07';

  if (!store || !token) {
    throw new Error('Not connected to Shopify. Please click "Connect to Shopify" first.');
  }

  return {
    url: `https://${store}/admin/api/${version}/graphql.json`,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
  };
}

// ── Rate-limit-aware GraphQL caller ──────────────────────────────────────────
// Retries up to 3 times on 429 / transient errors with exponential backoff.
async function gql(client, query, variables = {}, attempt = 1) {
  try {
    const res = await axios.post(
      client.url,
      { query, variables },
      { headers: client.headers, timeout: 30000 }
    );

    // Surface GraphQL-level errors
    if (res.data.errors) {
      const msg = res.data.errors.map(e => e.message).join('; ');
      throw new Error(`GraphQL error: ${msg}`);
    }

    return res.data.data;

  } catch (err) {
    const status = err.response?.status;

    // Network-level failures (socket hang up, ECONNRESET, ETIMEDOUT) have no
    // err.response — detect them by error code or message.
    const isNetworkError = !err.response && (
      err.code === 'ECONNRESET' ||
      err.code === 'ETIMEDOUT'  ||
      err.code === 'ENOTFOUND'  ||
      err.code === 'ECONNABORTED' ||
      err.message?.includes('socket hang up') ||
      err.message?.includes('timeout')
    );

    // Retry on rate limit (429), transient server errors (5xx), or network errors
    if ((status === 429 || (status >= 500 && status < 600) || isNetworkError) && attempt <= 3) {
      const delay = attempt * 2000; // 2s, 4s, 6s
      const reason = isNetworkError ? `network error (${err.code || err.message})` : `HTTP ${status}`;
      console.warn(`  ⚠ ${reason} — retrying in ${delay}ms (attempt ${attempt}/3)`);
      await sleep(delay);
      return gql(client, query, variables, attempt + 1);
    }

    throw err;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Queries & mutations ───────────────────────────────────────────────────────
const PRODUCT_BY_HANDLE_QUERY = `
  query getProduct($handle: String!) {
    productByHandle(handle: $handle) {
      id
      title
      status
      iid: metafield(namespace: "custom", key: "iproductid") { value }
      pcode: metafield(namespace: "custom", key: "product_code") { value }
      images(first: 250) {
        edges { node { id altText } }
      }
      variants(first: 250) {
        edges {
          node {
            id
            sku
            title
            selectedOptions { name value }
            image { id }
          }
        }
      }
    }
  }
`;

const DELETE_VARIANTS_MUTATION = `
  mutation deleteVariants($productId: ID!, $variantsIds: [ID!]!) {
    productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
      product { id title }
      userErrors { field message }
    }
  }
`;

const SET_PRODUCT_DRAFT_MUTATION = `
  mutation setProductDraft($productId: ID!) {
    productUpdate(input: { id: $productId, status: DRAFT }) {
      product { id title status }
      userErrors { field message }
    }
  }
`;

const DELETE_PRODUCT_IMAGES_MUTATION = `
  mutation deleteProductImages($id: ID!, $imageIds: [ID!]!) {
    productDeleteImages(id: $id, imageIds: $imageIds) {
      deletedImageIds
      userErrors { field message }
    }
  }
`;

const METAFIELDS_SET_MUTATION = `
  mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key value }
      userErrors { field message code }
    }
  }
`;

// Query for sync — fetches GIDs plus existing metafield values so we can
// detect conflicts (new vs match vs overwrite) before writing anything.
const PRODUCT_SYNC_QUERY = `
  query getProductSync($handle: String!) {
    productByHandle(handle: $handle) {
      id
      title
      metafield(namespace: "custom", key: "product_code") {
        value
      }
      variants(first: 250) {
        edges {
          node {
            id
            sku
            metafield(namespace: "custom", key: "variant_code") {
              value
            }
          }
        }
      }
    }
  }
`;

// Query for Step 4 enhancement — finds ALL Shopify variants with an exact SKU
// across every product. The sku:'...' filter is exact (quoted value).
// Returns variant GID, existing variant_code, and parent product data.
const VARIANTS_BY_SKU_QUERY = `
  query variantsBySku($query: String!, $after: String) {
    productVariants(first: 50, query: $query, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          sku
          metafield(namespace: "custom", key: "variant_code") { value }
          product {
            id
            handle
            title
            status
            metafield(namespace: "custom", key: "product_code") { value }
          }
        }
      }
    }
  }
`;

// Bulk scan — fetches ALL Shopify variants 250 at a time, with no SKU filter.
// Used by sync-metafields to match CFS SKUs against the full Shopify catalog
// in ~40-200 API calls instead of one call per CFS SKU (~5000+ calls).
const ALL_VARIANTS_SCAN_QUERY = `
  query scanVariants($after: String) {
    productVariants(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          sku
          metafield(namespace: "custom", key: "variant_code") { value }
          product {
            id
            handle
            title
            metafield(namespace: "custom", key: "product_code") { value }
          }
        }
      }
    }
  }
`;

// ── SKU parser: UD-{prodId}-{varId} ──────────────────────────────────────────
function parseSku(sku) {
  const parts = sku.split('-');
  return { prodId: parts[1] || null, varId: parts[2] || null };
}

// ── Short human-readable label for a Shopify variant node ────────────────────
// Uses the variant's title (Shopify combines selected option values into title,
// e.g. "Brown / 2 Seater"). Falls back to selectedOptions, then SKU.
function variantLabel(node) {
  if (node.title && node.title !== 'Default Title') return node.title;
  const opts = node.selectedOptions?.map(o => o.value).filter(Boolean);
  if (opts?.length) return opts.join(' / ');
  return node.sku || '?';
}

// ── Compact list of variant labels ──────────────────────────────────────────
// Returns "A, B, C" for ≤3 nodes or "A, B, C + 2 more" beyond that.
function variantList(nodes, max = 3) {
  const labels = nodes.slice(0, max).map(variantLabel);
  const extra  = nodes.length - max;
  return extra > 0 ? `${labels.join(', ')} + ${extra} more` : labels.join(', ');
}

// Convert a variant SKU to its product-level reference SKU.
// UD-{prodId}-{varId} → UD-{prodId}   (strips the variant ID tail)
// Returns the original sku unchanged if it doesn't have 3+ segments.
function productRefSku(variantSku) {
  if (!variantSku) return '';
  const parts = variantSku.split('-');
  return parts.length >= 3 ? parts.slice(0, 2).join('-') : variantSku;
}

// (Old alt-text/variant-photo image deletion was replaced by the photo check —
//  see /delete-variants-image-plan below. Photos are now detached, never deleted.)

// ── Which variants Step 3 will really delete for one product ─────────────────
// Mirrors the rules in delete-variants-bulk below:
//   some variants orphaned            → delete those
//   all orphaned, none in CFS feeds   → product set to DRAFT (photos untouched)
//   all orphaned, all in CFS feeds    → keep everything
//   all orphaned, mixed               → delete only the ones not in CFS feeds
function decideDeletion(allVariants, orphanedSKUs, productIdSet, variantAttrIdSet, product = null, handle = '', cfsNames = new Map(), skuHomes = null, decision = null, brandCtx = null) {
  const inCfs = v => { const { prodId, varId } = parseSku(v.sku); return (prodId && productIdSet.has(prodId)) || (varId && variantAttrIdSet.has(varId)); };
  const orphaned = allVariants.filter(v => orphanedSKUs.has(v.sku));
  if (!orphaned.length) return { mode: 'none', toDelete: [] };
  let result;
  if (orphaned.length < allVariants.length) result = { mode: 'variants', toDelete: orphaned };
  else {
    const unmatched = allVariants.filter(v => !inCfs(v));
    if (unmatched.length === allVariants.length) return { mode: 'draft', toDelete: [] };
    if (!unmatched.length) return { mode: 'keep', toDelete: [] };
    result = { mode: 'mixed', toDelete: unmatched };
  }
  if (product) {
    const own = ownDraftCheck(product, handle, new Set(result.toDelete.map(v => v.sku)), cfsNames, skuHomes, brandCtx);
    if (own.draft) return { mode: 'draft-own', toDelete: [], reason: own.reason };
    if (own.ask && decision?.keepAs) return { mode: 'keepas', toDelete: result.toDelete, own };
    if (own.ask && decision?.draft) return { mode: 'draft-own', toDelete: [], reason: 'your decision' };
    if (own.ask) return { mode: 'ask-own', toDelete: [], reason: own.reason, own };
  }
  return result;
}

// ── POST /api/shopify/delete-variants-image-plan  (live progress, Stop) ──────
// Same body as delete-variants-bulk. Read-only: works out, photo by photo, which
// photos belong ONLY to the variants that will be deleted (using the CFS image
// feed + picture check from Image Sync). Returns an imagePlanId that
// delete-variants-bulk uses for its dry-run log and live run.
router.post('/delete-variants-image-plan', async (req, res) => {
  const { variants = [], cfsProductIds = [], cfsVariantAttrIds = [], brandId = null, skuHomes = null, decisions = {} } = req.body || {};
  let client;
  try { client = graphqlClient(); } catch (err) { return res.status(400).json({ error: err.message }); }
  const sse = imageSync.openSse(res);
  const { send } = sse;
  const runId = imageSync.startRun(send);
  const check = imageSync.stopCheck(runId);
  try {
    const productIdSet = new Map(cfsProductIds);
    const variantAttrIdSet = new Set(cfsVariantAttrIds);
    const byHandle = new Map();
    for (const v of variants) { if (!byHandle.has(v.handle)) byHandle.set(v.handle, new Set()); byHandle.get(v.handle).add(v.variantSku); }
    const cfsNames = await getCfsNames(brandId);
    const brandCtx = brandId ? { codes: (await getCfsInfo(brandId)).codes } : null;
    const items = [];
    let n = 0;
    for (const [handle, orphanedSKUs] of byHandle) {
      check();
      n++;
      send({ type: 'progress', done: n - 1, total: byHandle.size, message: `Working out which variants go: ${handle}` });
      const data = await gql(client, PRODUCT_BY_HANDLE_QUERY, { handle });
      const product = data?.productByHandle;
      if (!product) continue;
      const decision = decideDeletion(product.variants.edges.map(e => e.node), orphanedSKUs, productIdSet, variantAttrIdSet, product, handle, cfsNames, skuHomes, decisions[handle], brandCtx);
      if (decision.toDelete.length) items.push({ handle, removedSkus: decision.toDelete.map(v => v.sku) });
    }
    const plan = await imageSync.buildRemovalPlan({ client, items, send, check });   // loads the CFS feed only if items exist
    const products = Object.entries(plan.byHandle).map(([handle, p]) => ({ handle, title: p.title, error: p.error || null,
      counts: p.counts || null, removedGroups: p.removedGroups || [], warnings: p.warnings || [] }));
    const summary = products.reduce((a, p) => { if (p.counts) { a.remove += p.counts.remove; a.keep += p.counts.keep; a.check += p.counts.check; } return a; },
      { products: products.length, remove: 0, keep: 0, check: 0 });
    send({ type: 'done', imagePlanId: plan.id, summary, products,
      handlesWithRemovals: products.filter(p => p.counts && p.counts.remove > 0).map(p => p.handle) });
  } catch (e) {
    if (e.stopped) send({ type: 'stopped', message: 'Photo check stopped — nothing was changed' });
    else send({ type: 'error', message: e.message });
  }
  imageSync.endRun(runId);
  sse.end();
});

// Log lines for one product's photos (dry run and live)
function photoLogLines(plan, handle, dryRun) {
  if (!plan) return [{ sku: '-', handle, status: dryRun ? 'dry_run' : 'warning', message: 'Photos: no photo check for this product — photos left as they are' }];
  if (plan.error) return [{ sku: '-', handle, status: 'warning', message: `Photos: ${plan.error}` }];
  const lines = [];
  if (plan.removedGroups?.length) lines.push({ sku: '-', handle, status: dryRun ? 'dry_run' : 'info',
    message: `Photos: ${plan.counts.remove} to remove for removed ${plan.removedGroups.join(', ')} · ${plan.counts.keep} stay · ${plan.counts.check} to check — ${plan.title}` });
  for (const w of plan.warnings || []) lines.push({ sku: '-', handle, status: 'warning', message: `Photos: ${w}` });
  for (const it of plan.items || []) {
    if (it.verdict === 'keep' && !dryRun) continue;
    const verb = it.verdict === 'remove' ? (dryRun ? 'WOULD REMOVE' : 'REMOVE') : it.verdict === 'check' ? 'CHECK (kept)' : 'KEEP';
    lines.push({ sku: '-', handle, status: it.verdict === 'remove' ? (dryRun ? 'image_remove' : 'image_removed') : it.verdict === 'check' ? 'image_check' : 'image_keep',
      message: `Photo ${it.position}: ${verb} — ${it.reason} · ${String(it.url || '').split('/').pop().split('?')[0]}`,
      imageUrl: it.url, imageVerdict: it.verdict, cfsUrl: it.cfsUrl || null });
  }
  return lines;
}

// Live: detach the photos marked "remove" (kept in Shopify Files for 7 days)
async function detachPlannedPhotos(product, handle, plan, backupId, log, undoRun) {
  if (!plan || plan.error || !plan.counts?.remove) return;
  if (!imageSync.backupCovers(backupId, product.id)) {
    log.push({ sku: '-', handle, status: 'warning', message: 'Photos: not in the backup zip — photos left as they are' });
    return;
  }
  try {
    const done = await imageSync.detachPhotos(graphqlClient(), product.id, plan.items.filter(i => i.verdict === 'remove'), 'step3-variant-removed');
    if (done.length) rec(undoRun, { type: 'photos', productId: product.id, handle, title: product.title,
      photos: done.map(d => ({ mediaId: d.mediaId, url: d.url || null })), orderBefore: done.orderBefore || [] });
    for (const l of photoLogLines(plan, handle, false)) {
      if (l.imageVerdict === 'remove' && !done.some(d => d.url === l.imageUrl)) l.message += ' (already gone)';
      log.push(l);
    }
    log.push({ sku: '-', handle, status: 'info', message: `Photos: detached ${done.length} — kept in Shopify Files for 7 days (Image Sync → Clean-up)` });
  } catch (err) {
    log.push({ sku: '-', handle, status: 'warning', message: `Photos: detach failed (variants were still deleted): ${err.message}` });
  }
}

// ── POST /api/shopify/delete-variants-bulk ────────────────────────────────────
//
// Body: { variants: [{ handle, variantSku, ... }], dryRun: bool,
//         cfsProductIds: string[], cfsVariantAttrIds: string[] }
//
// Strategy:
//   1. Group orphaned variants by product handle (one lookup per product, not per variant).
//   2. For each product:
//        a. Fetch all its variants from Shopify via GraphQL.
//        b. Identify which of the product's variants are in the orphaned list.
//        c. If ALL variants are orphaned:
//             → Check CFS feeds: extract {prodId} and {varId} from each orphaned SKU.
//               If {prodId} is in cfsProductIds  OR  {varId} is in cfsVariantAttrIds
//               → product has a CFS presence → skip (don't draft, don't delete).
//               Otherwise → set product to DRAFT.
//           If SOME variants are orphaned → delete only those variants.
//   3. Retry on 429 / 5xx up to 3 times with exponential backoff.
//   4. 350ms pause between product operations to stay inside Shopify's rate limit.
//
router.post('/delete-variants-bulk', async (req, res) => {
  // skuHomes: { sku: [active handles] } (own-variant rule, case A/B); decisions: { [handle]: { keepAs: variantId } | { draft: true } }
  const { variants = [], dryRun = true, cfsProductIds = [], cfsVariantAttrIds = [], imagePlanId = null, backupId = null, brandId = null,
    skuHomes = null, decisions = {} } = req.body;
  const decisionList = [], keepAsHandles = [];
  const brandCtx = brandId ? { codes: (await getCfsInfo(brandId)).codes } : null;   // other brands: own variant by iproductid / product code
  // Photo plan from /delete-variants-image-plan (which photos belong only to deleted variants)
  const imagePlan = imagePlanId ? imageSync.loadRemovalPlan(imagePlanId) : null;
  if (imagePlanId && !imagePlan) return res.status(400).json({ error: 'Photo check not found (server may have restarted) — run it again' });
  const photoPlanFor = handle => (imagePlan ? imagePlan.byHandle[handle] || null : null);
  const undoRun = dryRun ? null : undo.startRun('delete-orphaned', 'Delete Selected Orphaned', brandId);
  if (!dryRun && imagePlan) {
    const needBackup = Object.values(imagePlan.byHandle).some(p => p.counts && p.counts.remove > 0);
    if (needBackup && !backupId) return res.status(400).json({ error: 'A backup zip is required before photos are removed — create it first' });
  }
  // cfsProductIds arrives as [[prodId, status], ...] entries; build a Map (has() still works)
  const productIdSet    = new Map(cfsProductIds);
  const variantAttrIdSet = new Set(cfsVariantAttrIds);

  if (!variants.length) {
    return res.status(400).json({ error: 'No variants provided.' });
  }

  let client;
  try {
    client = graphqlClient();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const log     = [];
  let deleted   = 0;
  let failed    = 0;

  // Step 1 — group orphaned variants by product handle
  const byHandle = new Map();
  for (const v of variants) {
    if (!byHandle.has(v.handle)) byHandle.set(v.handle, []);
    byHandle.get(v.handle).push(v);
  }

  console.log(`▶ Processing ${variants.length} orphaned variants across ${byHandle.size} products (dryRun=${dryRun})`);

  // Step 2 — process one product at a time
  for (const [handle, orphanedForProduct] of byHandle) {
    const orphanedSKUs     = new Set(orphanedForProduct.map(v => v.variantSku));
    // productCode lookup: request body variants carry productCode from compareVariants()
    const productCodeBySku = new Map(orphanedForProduct.map(v => [v.variantSku, v.productCode || '']));

    try {
      if (dryRun) {
        // In dry-run mode we still look up the product so we can report
        // whether it would be a full-product delete or a variant-only delete.
        let productTitle = orphanedForProduct[0].title || handle;
        let action = 'delete variant(s)';
        let deletedNodes = [], remainingNodes = [];   // used after the lookup below
        const photoLines = [];                         // photo lines go after the variant lines
        let ownReason = null, ownNote = null;          // own-variant rule (draft instead of delete)

        try {
          const data = await gql(client, PRODUCT_BY_HANDLE_QUERY, { handle });
          const product = data?.productByHandle;

          if (product) {
            productTitle = product.title;
            const allVariants      = product.variants.edges.map(e => e.node);
            const allImages        = product.images.edges.map(e => e.node);
            const allOrphaned      = allVariants.every(v => orphanedSKUs.has(v.sku));
            deletedNodes           = allVariants.filter(v => orphanedSKUs.has(v.sku));
            remainingNodes         = allVariants.filter(v => !orphanedSKUs.has(v.sku));

            if (allOrphaned) {
              // Per-variant CFS presence check
              const matchedInCFS = allVariants.filter(v => {
                const { prodId, varId } = parseSku(v.sku);
                return (prodId && productIdSet.has(prodId)) || (varId && variantAttrIdSet.has(varId));
              });
              const notInCFS = allVariants.length - matchedInCFS.length;
              if (matchedInCFS.length === 0) {
                action = 'set product to DRAFT (no variants found in CFS feeds)';
              } else if (notInCFS === 0) {
                action = 'keep all variants — all found in CFS feeds';
              } else {
                action = `delete ${notInCFS} unmatched variant(s), keep ${matchedInCFS.length} CFS-matched variant(s)`;
              }
            } else {
              action = `delete ${orphanedSKUs.size} of ${allVariants.length} variant(s)`;
            }

            // Own-variant rule: is one of the variants being deleted this product's OWN one?
            if (action.startsWith('delete')) {
              const deleting = allOrphaned
                ? allVariants.filter(v => { const { prodId, varId } = parseSku(v.sku); return !(prodId && productIdSet.has(prodId)) && !(varId && variantAttrIdSet.has(varId)); })
                : deletedNodes;
              const own = ownDraftCheck(product, handle, new Set(deleting.map(v => v.sku)), await getCfsNames(brandId), skuHomes, brandCtx);
              const dec = decisions[handle] || {};
              if (own.draft) { action = 'set product to DRAFT (own variant not in CFS)'; ownReason = own.reason; }
              else if (own.ask && dec.draft) { action = 'set product to DRAFT (your decision)'; ownReason = 'your decision — whole product goes to DRAFT, variants and photos kept'; }
              else if (own.ask && dec.keepAs) {
                const keep = allVariants.find(v => v.id === dec.keepAs);
                const rn = keep ? renamePlan(product, handle, own.own, keep) : { ok: false, note: 'chosen variant not found' };
                ownNote = `your choice: keep as the "${keep ? variantLabel(keep) : '?'}" product — ` + (rn.ok
                  ? `would rename the title "${product.title}" → "${rn.title}"${rn.changedHandle ? `, URL /${handle} → /${rn.handle} (old URL redirects)` : ''} — you can change the title manually later`
                  : rn.note);
              } else if (own.ask) {
                action = 'ask'; ownReason = own.reason;
                decisionList.push({ origin: 'delete', handle, title: product.title, reason: own.reason, options: keepAsOptions(product, handle, own.own, own.homeless) });
              }
              else ownNote = own.note;
            }

            // Photos: photo-by-photo plan from the photo check (Image Sync engine)
            if (action.startsWith('set product to DRAFT')) {
              photoLines.push({ sku: '-', handle, status: 'dry_run', message: `Photos: product goes to DRAFT — photos left as they are: ${productTitle}` });
            } else if (action === 'ask') {
              photoLines.push({ sku: '-', handle, status: 'dry_run', message: `Photos: not changed — waiting for your decision: ${productTitle}` });
            } else if (!action.startsWith('keep')) {
              photoLines.push(...photoLogLines(photoPlanFor(handle), handle, true));
            }
          }
        } catch (_) { /* dry-run lookup failure is non-fatal */ }

        for (const v of orphanedForProduct) {
          const shopNode = deletedNodes.find(n => n.sku === v.variantSku);
          const label    = shopNode ? variantLabel(shopNode) : (v.option1 || v.option2 || v.variantSku);

          let msg;
          if (action === 'ask') {
            log.push({ sku: v.variantSku, handle, status: 'flagged', message: `NOT changed — ${ownReason} · ${productTitle}`, productCode: v.productCode || '' });
            continue;
          } else if (ownReason) {
            msg = `Would set "${productTitle}" to DRAFT — ${ownReason}`;
          } else if (action.startsWith('set product to DRAFT')) {
            msg = `Would set "${productTitle}" to DRAFT — all variants orphaned (no CFS match); variant "${label}" is kept, nothing deleted`;
          } else if (action.startsWith('keep all')) {
            msg = `Would keep "${label}" — all variants found in CFS feeds: ${productTitle}`;
          } else if (remainingNodes.length > 0) {
            // variant-only delete — list what's staying
            const stayList = variantList(remainingNodes);
            msg = `Would delete variant "${label}" — ${remainingNodes.length} remaining: ${stayList} · ${productTitle}`;
          } else {
            // mixed CFS-matched / unmatched
            msg = `[${action}] Would delete "${label}": ${productTitle}`;
          }
          log.push({ sku: v.variantSku, handle, status: 'dry_run', message: msg, productCode: v.productCode || '' });
        }
        if (ownNote) log.push({ sku: '-', handle, status: /couldn't tell|rename it by hand/.test(ownNote) ? 'warning' : 'info', message: `Which variant is this product: ${ownNote} · ${productTitle}` });

        log.push(...photoLines);

        await sleep(150); // lighter pause during dry-run lookups
        continue;
      }

      // ── Live deletion ──────────────────────────────────────────────────────

      // Look up the product and all its variants
      const data    = await gql(client, PRODUCT_BY_HANDLE_QUERY, { handle });
      const product = data?.productByHandle;

      if (!product) {
        for (const v of orphanedForProduct) {
          log.push({ sku: v.variantSku, handle, status: 'not_found', message: `Product handle "${handle}" not found on Shopify`, productCode: v.productCode || '' });
          failed++;
        }
        continue;
      }

      const allVariants     = product.variants.edges.map(e => e.node);
      const allImages       = product.images.edges.map(e => e.node);
      const cfsNames        = await getCfsNames(brandId);
      // Own-variant rule (live): draft the whole product instead of deleting its own variant
      const draftBecauseOwn = async (reason) => {
        const result = await gql(client, SET_PRODUCT_DRAFT_MUTATION, { productId: product.id });
        const errs = result?.productUpdate?.userErrors || [];
        if (errs.length) {
          for (const v of orphanedForProduct) { log.push({ sku: v.variantSku, handle, status: 'error', message: `Set-to-draft failed: ${errs.map(e => e.message).join(', ')}`, productCode: v.productCode || '' }); failed++; }
          return;
        }
        rec(undoRun, { type: 'status', productId: product.id, handle, title: product.title, before: product.status || 'ACTIVE', after: 'DRAFT' });
        for (const v of orphanedForProduct) { log.push({ sku: v.variantSku, handle, status: 'drafted', message: `Product set to DRAFT — ${reason}: ${product.title}`, productCode: v.productCode || '' }); deleted++; }
      };
      // Own variant gone but the others are only sold here → "Needs your decision" (no change)
      const askOwn = (o) => {
        for (const v of orphanedForProduct) log.push({ sku: v.variantSku, handle, status: 'flagged', message: `NOT changed — ${o.reason} · ${product.title}`, productCode: v.productCode || '' });
        decisionList.push({ origin: 'delete', handle, title: product.title, reason: o.reason, options: keepAsOptions(product, handle, o.own, o.homeless) });
      };
      // Decision "keep as the Grey product": after the missing variant is deleted, rename title + URL
      const keepAsRename = async (o, keepId) => {
        const keep = allVariants.find(v => v.id === keepId);
        const r = keep ? await applyRename(client, product, handle, renamePlan(product, handle, o.own, keep), undoRun) : { ok: false, message: 'chosen variant not found — title kept' };
        log.push({ sku: '-', handle, status: r.ok ? 'updated' : 'warning', message: `${r.message} · ${product.title}` });
        log.push({ sku: '-', handle, status: 'info', message: `Photos: the main photo may still show "${o.own.label}" — update them in Image Sync · ${product.title}` });
        keepAsHandles.push(r.ok && /URL/.test(r.message) ? renamePlan(product, handle, o.own, keep).handle : handle);
      };
      let ownP = null;
      const orphanedNodes   = allVariants.filter(v => orphanedSKUs.has(v.sku));
      const nonOrphanedLeft = allVariants.length - orphanedNodes.length;

      // Match up log entries: report any SKUs from the CSV that weren't found on Shopify
      for (const v of orphanedForProduct) {
        if (!orphanedNodes.find(n => n.sku === v.variantSku)) {
          log.push({ sku: v.variantSku, handle, status: 'not_found', message: `SKU ${v.variantSku} not found on Shopify product "${product.title}"`, productCode: v.productCode || '' });
          failed++;
        }
      }

      if (!orphanedNodes.length) {
        await sleep(350);
        continue;
      }

      if (nonOrphanedLeft === 0) {
        const cfsMatched = orphanedNodes.filter(node => {
          const { prodId, varId } = parseSku(node.sku);
          return (prodId && productIdSet.has(prodId)) || (varId && variantAttrIdSet.has(varId));
        });
        const cfsUnmatched = orphanedNodes.filter(node => {
          const { prodId, varId } = parseSku(node.sku);
          return !(prodId && productIdSet.has(prodId)) && !(varId && variantAttrIdSet.has(varId));
        });

        for (const node of cfsMatched) {
          log.push({ sku: node.sku, handle, status: 'kept', message: `Kept - found in CFS feeds: ${product.title} / ${node.title}`, productCode: productCodeBySku.get(node.sku) || '' });
        }

        const ownMixed = (cfsMatched.length > 0 && cfsUnmatched.length > 0)
          ? ownDraftCheck(product, handle, new Set(cfsUnmatched.map(n => n.sku)), cfsNames, skuHomes, brandCtx) : null;
        const decM = decisions[handle] || {};
        if (ownMixed && (ownMixed.draft || (ownMixed.ask && decM.draft))) {
          console.log(`  → Drafting "${product.title}" — own variant not in CFS`);
          await draftBecauseOwn(ownMixed.draft ? ownMixed.reason : 'your decision');
        } else if (ownMixed && ownMixed.ask && !decM.keepAs) {
          askOwn(ownMixed);
        } else if (cfsMatched.length > 0 && cfsUnmatched.length > 0) {
          console.log(`  ↗ "${product.title}" — deleting ${cfsUnmatched.length} unmatched, keeping ${cfsMatched.length} CFS-matched`);
          const variantIds = cfsUnmatched.map(v => v.id);
          const result = await gql(client, DELETE_VARIANTS_MUTATION, { productId: product.id, variantsIds: variantIds });
          const userErrors = result?.productVariantsBulkDelete?.userErrors || [];

          if (userErrors.length) {
            const errMsg = userErrors.map(e => e.message).join(', ');
            for (const node of cfsUnmatched) {
              log.push({ sku: node.sku, handle, status: 'error', message: `Variant delete failed: ${errMsg}`, productCode: productCodeBySku.get(node.sku) || '' });
              failed++;
            }
          } else {
            for (const node of cfsUnmatched) {
              log.push({ sku: node.sku, handle, status: 'deleted', message: `Deleted: ${product.title} / ${node.title}`, productCode: productCodeBySku.get(node.sku) || '' });
              deleted++;
            }
            rec(undoRun, { type: 'variants-deleted', productId: product.id, handle, title: product.title, skus: cfsUnmatched.map(n => n.sku) });
            // Photos of the removed variants → detached (from the photo check)
            await detachPlannedPhotos(product, handle, photoPlanFor(handle), backupId, log, undoRun);
            if (ownMixed && ownMixed.ask && decM.keepAs) await keepAsRename(ownMixed, decM.keepAs);
          }

        } else if (cfsUnmatched.length === 0) {
          console.log(`  ↷ Keeping "${product.title}" — all variants found in CFS feeds`);

        } else {
          console.log(`  ✗ Drafting "${product.title}" — no variants found in CFS feeds`);
          const result = await gql(client, SET_PRODUCT_DRAFT_MUTATION, { productId: product.id });
          const userErrors = result?.productUpdate?.userErrors || [];

          if (userErrors.length) {
            const errMsg = userErrors.map(e => e.message).join(', ');
            for (const v of orphanedForProduct) {
              log.push({ sku: v.variantSku, handle, status: 'error', message: `Set-to-draft failed: ${errMsg}`, productCode: v.productCode || '' });
              failed++;
            }
          } else {
            for (const v of orphanedForProduct) {
              log.push({ sku: v.variantSku, handle, status: 'drafted', message: `Product set to DRAFT: ${product.title}`, productCode: v.productCode || '' });
              deleted++;
            }
            rec(undoRun, { type: 'status', productId: product.id, handle, title: product.title, before: product.status || 'ACTIVE', after: 'DRAFT' });
          }
        }

      } else if ((ownP = ownDraftCheck(product, handle, new Set(orphanedNodes.map(n => n.sku)), cfsNames, skuHomes, brandCtx)).draft
                 || (ownP.ask && (decisions[handle] || {}).draft)) {
        console.log(`  → Drafting "${product.title}" — own variant not in CFS`);
        await draftBecauseOwn(ownP.draft ? ownP.reason : 'your decision');
      } else if (ownP.ask && !(decisions[handle] || {}).keepAs) {
        askOwn(ownP);
      } else {
        const variantIds = orphanedNodes.map(v => v.id);
        const result = await gql(client, DELETE_VARIANTS_MUTATION, { productId: product.id, variantsIds: variantIds });
        const userErrors = result?.productVariantsBulkDelete?.userErrors || [];

        if (userErrors.length) {
          const errMsg = userErrors.map(e => e.message).join(', ');
          for (const node of orphanedNodes) {
            log.push({ sku: node.sku, handle, status: 'error', message: `Variant delete failed: ${errMsg}`, productCode: productCodeBySku.get(node.sku) || '' });
            failed++;
          }
        } else {
          for (const node of orphanedNodes) {
            log.push({ sku: node.sku, handle, status: 'deleted', message: `Deleted: ${product.title} / ${node.title}`, productCode: productCodeBySku.get(node.sku) || '' });
            deleted++;
          }
          rec(undoRun, { type: 'variants-deleted', productId: product.id, handle, title: product.title, skus: orphanedNodes.map(n => n.sku) });
          // Photos of the removed variants → detached (from the photo check)
          await detachPlannedPhotos(product, handle, photoPlanFor(handle), backupId, log, undoRun);
          if (ownP && ownP.ask && (decisions[handle] || {}).keepAs) await keepAsRename(ownP, decisions[handle].keepAs);
        }
      }

      await sleep(350);

    } catch (err) {
      const msg = err.response?.data?.errors || err.message;
      for (const v of orphanedForProduct) {
        log.push({ sku: v.variantSku, handle, status: 'error', message: String(msg), productCode: v.productCode || '' });
        failed++;
      }
    }
  }

  console.log(`  ✓ Done — deleted: ${deleted}, failed: ${failed}, total: ${variants.length}`);
  const undoId = undoRun ? undo.save(undoRun) : null;
  res.json({ success: true, dryRun, deleted, failed, total: variants.length, log, undoId, decisions: decisionList, imageSyncHandles: keepAsHandles });
});


// ════════════════════════════════════════════════════════════════════════════
// UNDO for Step 3 live runs — drafts, status changes, SKU changes, photos.
// (Deleted variants can't be brought back by Shopify; they are listed, not undone.)
//   GET  /api/shopify/undo/runs              recent runs (saved on the server)
//   GET  /api/shopify/undo/:id/download      the undo file
//   POST /api/shopify/undo/upload            { file: <contents of an undo file> }
//   POST /api/shopify/undo/:id               { dryRun, force, entries?: [index,…] }
// ════════════════════════════════════════════════════════════════════════════
const Q_UNDO_PRODUCT = `query P($id: ID!) { product(id: $id) { id title handle status vendor variants(first: 250) { nodes { id sku } } } }`;
const Q_PRODUCT_VENDOR = `query V($h: String!) { productByHandle(handle: $h) { id title vendor } }`;
const M_SET_STATUS = `mutation S($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id status } userErrors { field message } } }`;

router.get('/undo/runs', (req, res) => {
  try { res.json({ runs: undo.list() }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/undo/:id/download', (req, res) => {
  const run = undo.load(req.params.id);
  if (!run) return res.status(404).send('Undo record not found (server may have restarted) — upload the undo file instead');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="step3-undo_${(run.brand || 'urban-deco').toLowerCase().replace(/[^a-z0-9]+/g, '-')}_${run.createdAt.slice(0, 10)}_${run.id.slice(-6)}.json"`);
  res.send(JSON.stringify(run, null, 2));
});

router.post('/undo/upload', (req, res) => {
  try {
    const obj = typeof req.body?.file === 'string' ? JSON.parse(req.body.file) : req.body?.file;
    const run = undo.importRun(obj);
    res.json({ ok: true, run: undo.summarise(run) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/undo/:id', async (req, res) => {
  const run = undo.load(req.params.id);
  if (!run) return res.status(404).json({ error: 'Undo record not found — upload the undo file' });
  const dryRun = req.body?.dryRun !== false;
  const force = !!req.body?.force;
  const only = Array.isArray(req.body?.entries) ? new Set(req.body.entries.map(Number)) : null;
  if (!dryRun && imageSync.isBusy()) return res.status(409).json({ error: 'Image Sync is running — try again when it has finished' });
  let client;
  try { client = graphqlClient(); } catch (e) { return res.status(400).json({ error: e.message }); }

  const log = [];
  const doneIdx = [];
  let undone = 0, skipped = 0, failed = 0;
  // newest change first, so several changes to one product unwind in the right order
  const order = run.entries.map((e, i) => i).reverse();
  const cache = new Map();
  const current = async pid => {
    if (!cache.has(pid)) cache.set(pid, (await gql(client, Q_UNDO_PRODUCT, { id: pid }))?.product || null);
    return cache.get(pid);
  };
  for (const i of order) {
    const e = run.entries[i];
    if (only && !only.has(i)) continue;
    const base = { sku: '-', handle: e.handle };
    const name = e.title || e.handle;
    if (e.type === 'variants-deleted') {
      log.push({ ...base, status: 'info', message: `Can't undo: ${e.skus.length} deleted variant(s) (${e.skus.join(', ')}) — Shopify can't bring deleted variants back · ${name}` });
      continue;
    }
    if (e.undoneAt) { log.push({ ...base, status: 'info', message: `Already undone (${e.undoneAt.slice(0, 16).replace('T', ' ')}): ${e.type} · ${name}` }); continue; }
    try {
      const p = await current(e.productId);
      if (!p) { log.push({ ...base, status: 'error', message: `Product no longer exists — can't undo · ${name}` }); failed++; continue; }
      if (e.type === 'status') {
        if (p.status === e.before) { log.push({ ...base, status: 'info', message: `Status is already ${e.before} — nothing to do · ${name}` }); doneIdx.push(i); continue; }
        if (p.status !== e.after && !force) { log.push({ ...base, status: 'conflict', message: `Status was changed after the run (now ${p.status}, the run set ${e.after}) — skipped; tick "Overwrite" to undo anyway · ${name}` }); skipped++; continue; }
        if (dryRun) { log.push({ ...base, status: 'dry_run', message: `Would set status back: ${p.status} → ${e.before} · ${name}` }); continue; }
        const r = await gql(client, M_SET_STATUS, { product: { id: p.id, status: e.before } });
        const errs = r?.productUpdate?.userErrors || [];
        if (errs.length) throw new Error(errs.map(x => x.message).join(', '));
        p.status = e.before;
        log.push({ ...base, status: 'undone', message: `Status put back: ${e.after} → ${e.before} · ${name}` });
      } else if (e.type === 'sku') {
        const v = (p.variants?.nodes || []).find(x => x.id === e.variantId);
        if (!v) { log.push({ ...base, status: 'error', message: `Variant no longer exists — can't put SKU ${e.before} back · ${name}` }); failed++; continue; }
        if (v.sku === e.before) { log.push({ ...base, status: 'info', message: `SKU is already ${e.before} · ${name}` }); doneIdx.push(i); continue; }
        if (v.sku !== e.after && !force) { log.push({ ...base, status: 'conflict', message: `SKU was changed after the run (now ${v.sku}) — skipped; tick "Overwrite" to undo anyway · ${name}` }); skipped++; continue; }
        if (dryRun) { log.push({ ...base, sku: e.before, status: 'dry_run', message: `Would put SKU back: ${v.sku} → ${e.before} · ${name}` }); continue; }
        const r = await gql(client, UPDATE_VARIANT_SKU_MUTATION, { productId: p.id, variants: [{ id: v.id, sku: e.before }] });
        const errs = r?.productVariantsBulkUpdate?.userErrors || [];
        if (errs.length) throw new Error(errs.map(x => x.message).join(', '));
        v.sku = e.before;
        log.push({ ...base, sku: e.before, status: 'undone', message: `SKU put back: ${e.after} → ${e.before} · ${name}` });
      } else if (e.type === 'title') {
        const curTitle = p.title;
        if (curTitle === e.before.title && (!e.after.handle || p.handle === e.before.handle)) { log.push({ ...base, status: 'info', message: `Title is already "${e.before.title}" · ${name}` }); doneIdx.push(i); continue; }
        if (curTitle !== e.after.title && !force) { log.push({ ...base, status: 'conflict', message: `Title was changed after the run (now "${curTitle}") — skipped; tick "Overwrite" to undo anyway · ${name}` }); skipped++; continue; }
        const urlOnly = e.before.title === e.after.title;   // Store health "Fix URL" — only the URL changed
        if (dryRun) { log.push({ ...base, status: 'dry_run', message: urlOnly ? `Would put the URL back: /${p.handle} → /${e.before.handle} · ${name}`
          : `Would put the title back: "${curTitle}" → "${e.before.title}"${p.handle !== e.before.handle ? `, URL /${p.handle} → /${e.before.handle}` : ''} · ${name}` }); continue; }
        const input = { id: p.id, title: e.before.title };
        if (p.handle !== e.before.handle) { input.handle = e.before.handle; input.redirectNewHandle = true; }
        const r = await gql(client, M_SET_STATUS, { product: input });
        const errs = r?.productUpdate?.userErrors || [];
        if (errs.length) throw new Error(errs.map(x => x.message).join(', '));
        p.title = e.before.title;
        log.push({ ...base, status: 'undone', message: urlOnly ? `URL put back: /${e.after.handle} → /${e.before.handle} · ${name}`
          : `Title put back: "${e.after.title}" → "${e.before.title}"${input.handle ? `, URL → /${e.before.handle}` : ''} · ${name}` });
      } else if (e.type === 'vendor') {
        if (p.vendor === e.before) { log.push({ ...base, status: 'info', message: `Vendor is already "${e.before}" · ${name}` }); doneIdx.push(i); continue; }
        if (p.vendor !== e.after && !force) { log.push({ ...base, status: 'conflict', message: `Vendor was changed after the run (now "${p.vendor}") — skipped; tick "Overwrite" to undo anyway · ${name}` }); skipped++; continue; }
        if (dryRun) { log.push({ ...base, status: 'dry_run', message: `Would put vendor back: "${p.vendor}" → "${e.before}" · ${name}` }); continue; }
        const r = await gql(client, M_SET_STATUS, { product: { id: p.id, vendor: e.before } });
        const errs = r?.productUpdate?.userErrors || [];
        if (errs.length) throw new Error(errs.map(x => x.message).join(', '));
        p.vendor = e.before;
        log.push({ ...base, status: 'undone', message: `Vendor put back: "${e.after}" → "${e.before}" · ${name}` });
      } else if (e.type === 'option-value') {
        // "Default" colour renamed (routes/defaultcolours.js) → put the old name back
        const { M_RENAME, Q_PRODUCT } = require('./defaultcolours')._q;
        const pp = (await gql(client, Q_PRODUCT, { id: e.productId }))?.product;
        const o = pp?.options.find(x => x.id === e.optionId);
        const val = o?.optionValues.find(x => x.id === e.valueId);
        if (!val) { log.push({ ...base, status: 'error', message: `${e.optionName} value no longer exists — can't put "${e.before}" back · ${name}` }); failed++; continue; }
        if (val.name === e.before) { log.push({ ...base, status: 'info', message: `${e.optionName} is already "${e.before}" · ${name}` }); doneIdx.push(i); continue; }
        if (val.name !== e.after && !force) { log.push({ ...base, status: 'conflict', message: `${e.optionName} was changed after the run (now "${val.name}") — skipped; tick "Overwrite" to undo anyway · ${name}` }); skipped++; continue; }
        if (dryRun) { log.push({ ...base, status: 'dry_run', message: `Would put ${e.optionName} back: "${val.name}" → "${e.before}" · ${name}` }); continue; }
        const r = await gql(client, M_RENAME, { productId: e.productId, option: { id: e.optionId }, values: [{ id: e.valueId, name: e.before }] });
        const errs = r?.productOptionUpdate?.userErrors || [];
        if (errs.length) throw new Error(errs.map(x => x.message).join(', '));
        log.push({ ...base, status: 'undone', message: `${e.optionName} put back: "${e.after}" → "${e.before}" · ${name}` });
      } else if (e.type === 'variant-merge') {
        // split colour merged ("Default Title" → "Bisque Oasis") → move those variants back to the old value
        const { M_MOVE, Q_PRODUCT } = require('./defaultcolours')._q;
        const pp = (await gql(client, Q_PRODUCT, { id: e.productId }))?.product;
        const cur = new Map((pp?.variants?.nodes || []).map(v => [v.id, v.selectedOptions.find(x => x.name === e.optionName)?.value]));
        const gone = e.variants.filter(v => !cur.has(v.id));
        const back = e.variants.filter(v => cur.get(v.id) === e.from);
        const moved = e.variants.filter(v => cur.has(v.id) && cur.get(v.id) !== e.from && (cur.get(v.id) === e.into || force));
        const other = e.variants.filter(v => cur.has(v.id) && cur.get(v.id) !== e.from && cur.get(v.id) !== e.into && !force);
        if (!moved.length) {
          log.push({ ...base, status: other.length ? 'conflict' : 'info', message: other.length
            ? `${e.optionName} was changed after the run (${other.map(v => `${v.label}: "${cur.get(v.id)}"`).join(', ')}) — skipped; tick "Overwrite" to undo anyway · ${name}`
            : `Already back under "${e.from}"${gone.length ? ` (${gone.length} variant(s) no longer exist)` : ''} · ${name}` });
          if (other.length) skipped++; else doneIdx.push(i);
          continue;
        }
        if (dryRun) { log.push({ ...base, status: 'dry_run', message: `Would move ${moved.map(v => v.label).join(', ')} back from "${e.into}" → "${e.from}" · ${name}` }); continue; }
        const r = await gql(client, M_MOVE, { productId: e.productId, variants: moved.map(v => ({ id: v.id, optionValues: [{ optionName: e.optionName, name: e.from }] })) });
        const errs = r?.productVariantsBulkUpdate?.userErrors || [];
        if (errs.length) throw new Error(errs.map(x => x.message).join(', '));
        log.push({ ...base, status: 'undone', message: `Moved ${moved.map(v => v.label).join(', ')} back to "${e.from}"${gone.length ? ` (${gone.length} variant(s) no longer exist)` : ''}${back.length ? ` (${back.length} already there)` : ''} · ${name}` });
      } else if (e.type === 'photos') {
        if (dryRun) {
          for (const ph of e.photos) log.push({ ...base, status: 'dry_run', message: `Would re-attach photo · ${name}`, imageUrl: ph.url, imageVerdict: 'keep' });
          continue;
        }
        const r = await imageSync.reattachPhotos(client, e.productId, e.photos.map(x => x.mediaId), e.orderBefore || []);
        log.push({ ...base, status: r.missing.length ? 'warning' : 'undone',
          message: `Photos: ${r.reattached} re-attached${r.alreadyThere ? `, ${r.alreadyThere} already there` : ''}, old order put back` +
            (r.missing.length ? ` — ${r.missing.length} already deleted from Shopify Files (use Image Sync → Restore with the backup zip)` : '') + ` · ${name}` });
      }
      if (!dryRun) { doneIdx.push(i); undone++; }
    } catch (err) {
      log.push({ ...base, status: 'error', message: `Undo failed: ${err.message} · ${name}` }); failed++;
    }
    await sleep(150);
  }
  if (!dryRun && doneIdx.length) undo.markUndone(run, doneIdx);
  res.json({ success: true, dryRun, undone, skipped, failed, log, run: undo.summarise(undo.load(run.id)) });
});

// ── POST /api/shopify/set-draft ───────────────────────────────────────────────
//
// Body: { variants: [{ handle, variantSku, title, ... }], dryRun: bool }
//
// Sets the Shopify product to DRAFT for each unique handle in the list.
// One API call per product (grouped by handle). Used for CFS-inactive products
// that are still Active on Shopify.
//
router.post('/set-draft', async (req, res) => {
  const { variants = [], dryRun = true } = req.body;

  if (!variants.length) {
    return res.status(400).json({ error: 'No variants provided.' });
  }

  let client;
  try {
    client = graphqlClient();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const log   = [];
  let drafted = 0;
  let failed  = 0;

  // Group by handle — one set-to-draft call per product
  const byHandle = new Map();
  for (const v of variants) {
    if (!byHandle.has(v.handle)) byHandle.set(v.handle, v);
  }

  console.log(`▶ Setting ${byHandle.size} products to DRAFT (dryRun=${dryRun})`);
  const undoRun = dryRun ? null : undo.startRun('set-draft', 'Set Selected to Draft', req.body.brandId || null);

  for (const [handle, representative] of byHandle) {
    const variantsForHandle = variants.filter(v => v.handle === handle);
    const affectedSKUs      = variantsForHandle.map(v => v.variantSku);
    const productCodeBySku  = new Map(variantsForHandle.map(v => [v.variantSku, v.productCode || '']));

    try {
      if (dryRun) {
        for (const sku of affectedSKUs) {
          log.push({ sku, handle, status: 'dry_run', message: `Would set product to DRAFT: ${representative.title || handle}`, productCode: productCodeBySku.get(sku) || '' });
        }
        await sleep(150);
        continue;
      }

      // Look up the product GID by handle
      const data    = await gql(client, PRODUCT_BY_HANDLE_QUERY, { handle });
      const product = data?.productByHandle;

      if (!product) {
        for (const sku of affectedSKUs) {
          log.push({ sku, handle, status: 'not_found', message: `Product handle "${handle}" not found on Shopify`, productCode: productCodeBySku.get(sku) || '' });
          failed++;
        }
        continue;
      }

      const result     = await gql(client, SET_PRODUCT_DRAFT_MUTATION, { productId: product.id });
      const userErrors = result?.productUpdate?.userErrors || [];

      if (userErrors.length) {
        const errMsg = userErrors.map(e => e.message).join(', ');
        for (const sku of affectedSKUs) {
          log.push({ sku, handle, status: 'error', message: `Set-to-draft failed: ${errMsg}`, productCode: productCodeBySku.get(sku) || '' });
          failed++;
        }
      } else {
        for (const sku of affectedSKUs) {
          log.push({ sku, handle, status: 'drafted', message: `Set to DRAFT: ${product.title}`, productCode: productCodeBySku.get(sku) || '' });
          drafted++;
        }
        rec(undoRun, { type: 'status', productId: product.id, handle, title: product.title, before: product.status || 'ACTIVE', after: 'DRAFT' });
      }

      await sleep(350);

    } catch (err) {
      const msg = err.response?.data?.errors || err.message;
      for (const sku of affectedSKUs) {
        log.push({ sku, handle, status: 'error', message: String(msg), productCode: productCodeBySku.get(sku) || '' });
        failed++;
      }
    }
  }

  console.log(`  ✓ Done — drafted: ${drafted}, failed: ${failed}`);
  const undoId = undoRun ? undo.save(undoRun) : null;
  res.json({ success: true, dryRun, drafted, failed, total: variants.length, log, undoId });
});


// ── POST /api/shopify/publish-products ───────────────────────────────────────
//
// Body: { variants: [{ handle, variantSku, title, cfsProductStatus, ... }], dryRun: bool }
//
// For each CFS Product Match variant:
//   1. Look up the Shopify product by handle — get ALL its current variants.
//   2. Delete only the selected variant(s).
//   3. Check whether the product still has OTHER variants remaining after deletion:
//        YES → just delete, leave product status untouched (other variants are fine)
//        NO  → all variants removed; set product status based on CFS:
//                CFS active   → ACTIVE
//                CFS inactive → DRAFT
//
const SET_PRODUCT_ACTIVE_MUTATION = `
  mutation setProductActive($productId: ID!) {
    productUpdate(input: { id: $productId, status: ACTIVE }) {
      product { id title status }
      userErrors { field message }
    }
  }
`;

// Updates a single variant's SKU in-place (used when promoting the last variant
// to a product-level SKU instead of deleting it).
const UPDATE_VARIANT_SKU_MUTATION = `
  mutation updateVariantSku($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku }
      userErrors { field message }
    }
  }
`;

// ── POST /api/shopify/fix-skus ───────────────────────────────────────────────
// Body: { variants: [{ handle, variantSku, fixedSku }], dryRun }
// Rewrites SKUs that only match CFS after removing spaces / stray characters
// (Compare → "SKU typo" tab), e.g. "UD-1244787- 17221688" → "UD-1244787-17221688".
// Skipped if another variant on the same product already has the clean SKU.
// Live runs are saved for Undo (SKU put back).
router.post('/fix-skus', async (req, res) => {
  const { variants = [], dryRun = true } = req.body || {};
  if (!variants.length) return res.status(400).json({ error: 'No variants provided.' });
  let client;
  try { client = graphqlClient(); } catch (err) { return res.status(400).json({ error: err.message }); }
  const { cleanSku } = require('../utils/matchVariants');
  const log = [], decisionList = [];
  let fixed = 0, skipped = 0, failed = 0;
  const undoRun = dryRun ? null : undo.startRun('fix-skus', 'Fix Selected SKUs', req.body.brandId || null);
  const byHandle = new Map();
  for (const v of variants) { if (!byHandle.has(v.handle)) byHandle.set(v.handle, []); byHandle.get(v.handle).push(v); }
  console.log(`▶ Fix SKUs — ${variants.length} variants on ${byHandle.size} products (dryRun=${dryRun})`);

  for (const [handle, rows] of byHandle) {
    try {
      const product = (await gql(client, PRODUCT_BY_HANDLE_QUERY, { handle }))?.productByHandle;
      if (!product) { for (const r of rows) { log.push({ sku: r.variantSku, handle, status: 'not_found', message: `Product "${handle}" not found` }); failed++; } continue; }
      const nodes = product.variants.edges.map(e => e.node);
      const updates = [], dupDeletes = [];
      for (const r of rows) {
        const node = nodes.find(n => n.sku === r.variantSku);
        const target = r.fixedSku || cleanSku(r.variantSku);
        if (!node) { log.push({ sku: r.variantSku, handle, status: 'not_found', message: `SKU "${r.variantSku}" not found on "${product.title}"` }); failed++; continue; }
        if (target === node.sku) { log.push({ sku: r.variantSku, handle, status: 'skipped', message: 'Already clean — nothing to fix' }); skipped++; continue; }
        if (nodes.some(n => n !== node && n.sku === target) || updates.some(u => u.sku === target)) {
          if (r.action === 'delete-duplicate') { dupDeletes.push({ node, target }); continue; }
          log.push({ sku: r.variantSku, handle, status: 'flagged', message: `Not fixed — another variant on "${product.title}" already has SKU ${target}. Please check.` }); skipped++;
          decisionList.push({ origin: 'fix-skus', handle, title: product.title, variantSku: r.variantSku, fixedSku: target,
            reason: `"${variantLabel(node)}" has SKU "${r.variantSku}", but another variant already has the clean SKU ${target}`,
            options: [{ value: 'delete-duplicate', label: `Delete the typo variant "${variantLabel(node)}" (${r.variantSku}) — keep the one with ${target}` },
                      { value: 'skip', label: 'Skip — leave as it is' }] });
          continue;
        }
        updates.push({ id: node.id, sku: target, before: node.sku, label: variantLabel(node) });
      }
      if (dupDeletes.length) {
        if (dryRun) for (const d of dupDeletes) log.push({ sku: d.node.sku, handle, status: 'dry_run', message: `Would delete the typo variant "${variantLabel(d.node)}" (${d.node.sku}) — ${d.target} already exists · ${product.title}` });
        else {
          const r = await gql(client, DELETE_VARIANTS_MUTATION, { productId: product.id, variantsIds: dupDeletes.map(d => d.node.id) });
          const errs = r?.productVariantsBulkDelete?.userErrors || [];
          if (errs.length) for (const d of dupDeletes) { log.push({ sku: d.node.sku, handle, status: 'error', message: `Delete failed: ${errs.map(e => e.message).join(', ')}` }); failed++; }
          else {
            rec(undoRun, { type: 'variants-deleted', productId: product.id, handle, title: product.title, skus: dupDeletes.map(d => d.node.sku) });
            for (const d of dupDeletes) { fixed++; log.push({ sku: d.node.sku, handle, status: 'deleted', message: `Deleted the typo variant "${variantLabel(d.node)}" (${d.node.sku}) — ${d.target} already exists · ${product.title}` }); }
          }
        }
      }
      if (!updates.length) continue;
      if (dryRun) {
        for (const u of updates) log.push({ sku: u.before, handle, status: 'dry_run', message: `Would fix SKU "${u.before}" → "${u.sku}" · ${product.title} / ${u.label}` });
        continue;
      }
      const result = await gql(client, UPDATE_VARIANT_SKU_MUTATION, { productId: product.id, variants: updates.map(u => ({ id: u.id, sku: u.sku })) });
      const errs = result?.productVariantsBulkUpdate?.userErrors || [];
      if (errs.length) { for (const u of updates) { log.push({ sku: u.before, handle, status: 'error', message: `SKU fix failed: ${errs.map(e => e.message).join(', ')}` }); failed++; } }
      else for (const u of updates) {
        fixed++;
        rec(undoRun, { type: 'sku', productId: product.id, handle, title: product.title, variantId: u.id, before: u.before, after: u.sku });
        log.push({ sku: u.sku, handle, status: 'updated', message: `SKU fixed: "${u.before}" → "${u.sku}" · ${product.title} / ${u.label}` });
      }
      await sleep(300);
    } catch (err) {
      for (const r of rows) { log.push({ sku: r.variantSku, handle, status: 'error', message: err.message }); failed++; }
    }
  }
  console.log(`  ✓ Fix SKUs done — fixed: ${fixed}, skipped: ${skipped}, failed: ${failed}`);
  const undoId = undoRun ? undo.save(undoRun) : null;
  res.json({ success: true, dryRun, fixed, skipped, failed, total: variants.length, log, undoId, decisions: decisionList });
});

// ── POST /api/shopify/set-vendor ─────────────────────────────────────────────
// Body: { items: [{ handle, vendor }], dryRun }
// For products found under another brand's CFS feed (Clean-up → "Other brand" tab):
// sets the Shopify vendor to that brand. Saved for Undo.
router.post('/set-vendor', async (req, res) => {
  const { items = [], dryRun = true } = req.body || {};
  if (!items.length) return res.status(400).json({ error: 'Nothing selected.' });
  let client;
  try { client = graphqlClient(); } catch (err) { return res.status(400).json({ error: err.message }); }
  const log = [];
  let changed = 0, failed = 0;
  const undoRun = dryRun ? null : undo.startRun('set-vendor', 'Change vendor', req.body.brandId || null);
  for (const it of items) {
    try {
      const p = (await gql(client, Q_PRODUCT_VENDOR, { h: it.handle }))?.productByHandle;
      if (!p) { log.push({ sku: '-', handle: it.handle, status: 'not_found', message: `Product "${it.handle}" not found` }); failed++; continue; }
      if (p.vendor === it.vendor) { log.push({ sku: '-', handle: it.handle, status: 'skipped', message: `Vendor is already "${it.vendor}" · ${p.title}` }); continue; }
      if (dryRun) { log.push({ sku: '-', handle: it.handle, status: 'dry_run', message: `Would change vendor "${p.vendor}" → "${it.vendor}" · ${p.title}` }); continue; }
      const r = await gql(client, M_SET_STATUS, { product: { id: p.id, vendor: it.vendor } });
      const errs = r?.productUpdate?.userErrors || [];
      if (errs.length) { log.push({ sku: '-', handle: it.handle, status: 'error', message: `Vendor change failed: ${errs.map(e => e.message).join(', ')}` }); failed++; continue; }
      rec(undoRun, { type: 'vendor', productId: p.id, handle: it.handle, title: p.title, before: p.vendor, after: it.vendor });
      changed++;
      log.push({ sku: '-', handle: it.handle, status: 'updated', message: `Vendor changed "${p.vendor}" → "${it.vendor}" · ${p.title}` });
      await sleep(250);
    } catch (e) { log.push({ sku: '-', handle: it.handle, status: 'error', message: e.message }); failed++; }
  }
  const undoId = undoRun ? undo.save(undoRun) : null;
  if (changed) { try { require('./brandsync').clearStoreCache(); } catch (_) {} }   // brand wrong-vendor check re-reads the store
  res.json({ success: true, dryRun, changed, failed, log, undoId });
});

router.post('/publish-products', async (req, res) => {
  // decisions: { [handle]: { keep: [variantId] } | { draft: true } | { skip: true } } — the user's
  // choices for products flagged by an earlier run ("Needs your decision"); onlyHandles limits the
  // run to those products.
  const { variants = [], related = [], dryRun = true, brandId = null, decisions = {}, onlyHandles = null, skuHomes = null } = req.body;

  if (!variants.length && !(Array.isArray(onlyHandles) && onlyHandles.length)) {
    return res.status(400).json({ error: 'No variants provided.' });
  }

  let client;
  try {
    client = graphqlClient();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const log      = [];
  let published  = 0;
  let drafted    = 0;
  let deleted    = 0;
  let failed     = 0;
  let flagged    = 0;   // not promoted: unclear which CFS product it is

  // Group all selected variants by handle
  const byHandle = new Map();
  for (const v of variants) {
    if (!byHandle.has(v.handle)) byHandle.set(v.handle, []);
    byHandle.get(v.handle).push(v);
  }

  console.log(`▶ Promoting ${byHandle.size} CFS-product-match products (dryRun=${dryRun})`);
  const imageSyncHandles = new Set();   // products whose photos Image Sync should update afterwards
  const undoRun = dryRun ? null : undo.startRun('publish', onlyHandles ? 'Flagged products — your decisions' : 'Publish Selected as Main Product', brandId);

  // ── Before changing anything: decide what happens to each product (same for
  //    dry run and live run). Based on the variant the product IS (its "own"
  //    variant, from the title/handle — utils/ownVariant.js):
  //      own variant → CFS product, active & fits the title → PROMOTE: keep it as
  //                    UD-{prodId}, delete every other variant
  //      own variant → CFS product inactive / not in CFS  → DRAFT whole product,
  //                    keep variants and photos
  //      own variant is a normal CFS variant               → delete only the
  //                    selected other variants
  //      unclear                                           → FLAG, change nothing
  //    Products sharing a selected SKU are checked too (e.g. the Grey product that
  //    also carries the Brown variant).
  const cfsNames = await getCfsNames(brandId);
  const cfsCodes = (await getCfsInfo(brandId)).codes;
  const statusBySku = new Map();   // `${handle}|${sku}` → comparison row
  for (const r of related) statusBySku.set(`${r.handle}|${r.variantSku}`, r);
  for (const v of variants) statusBySku.set(`${v.handle}|${v.variantSku}`, { ...v, matchStatus: v.matchStatus || 'cfs-product' });
  const selectedSkus = new Set(variants.map(v => v.variantSku));
  const sharedAdded = new Map();   // handle → SKU it shares with a selected product
  if (Array.isArray(onlyHandles) && onlyHandles.length) {
    // Applying decisions: only the decided products, nothing else
    const only = new Set(onlyHandles);
    for (const h of [...byHandle.keys()]) if (!only.has(h)) byHandle.delete(h);
    for (const h of only) if (!byHandle.has(h)) byHandle.set(h, []);
  } else {
    for (const v of variants) for (const h of (v.sharedSkuHandles || [])) {
      if (!byHandle.has(h) && !sharedAdded.has(h)) sharedAdded.set(h, v.variantSku);
    }
    for (const h of sharedAdded.keys()) byHandle.set(h, []);
  }
  const decisionList = [];   // flagged products → "Needs your decision" on the page
  let decisionKeep = new Set();   // the user's choice for the product being planned (from "Needs your decision")

  const productCache = new Map();   // handle → product
  const plans = new Map();          // handle → plan
  for (const handle of byHandle.keys()) {
    try {
      const product = (await gql(client, PRODUCT_BY_HANDLE_QUERY, { handle }))?.productByHandle;
      productCache.set(handle, product || null);
      if (product) {
        try { plans.set(handle, planPromotion(product, handle)); }
        catch (e) { console.error(`  ✗ planning "${handle}":`, e); plans.set(handle, { action: 'flag', reason: `couldn't check this product (${e.message})` }); }
      }
      await sleep(100);
    } catch (e) { productCache.delete(handle); console.warn(`  ⚠ couldn't load "${handle}":`, e.message); }
  }

  function planPromotion(product, handle) {
    const d = decisions[handle] || {};
    decisionKeep = new Set(d.keep || []);
    if (d.skip) return { action: 'none', reason: 'skipped (your decision)' };
    if (d.draft) return { action: 'draft', reason: 'your decision — whole product goes to DRAFT, variants and photos kept' };
    const plan = planPromotionAuto(product, handle);
    if (plan.action === 'flag' && decisionKeep.size) plan.reason += ' (your choice could not be applied)';
    return plan;
  }

  function planPromotionAuto(product, handle) {
    const all = product.variants.edges.map(e => e.node);
    const stat = n => statusBySku.get(`${handle}|${n.sku}`) || null;
    const picked = all.filter(n => selectedSkus.has(n.sku));
    if ((product.status || 'ACTIVE') !== 'ACTIVE' && !picked.length) return { action: 'none', reason: `already ${product.status}` };
    let own = resolveOwn(product, handle, all, cfsNames, brandId ? { codes: cfsCodes } : null);
    if (own.conflict) return { action: 'flag', reason: `can't tell which variant this product is: ${own.reason} — please check` };
    if (!own.ok && decisionKeep.size) {
      const chosen = all.filter(n => decisionKeep.has(n.id));
      if (chosen.length) own = { ok: true, ownIds: chosen.map(n => n.id), label: chosen.map(variantLabel).join(', '), reason: 'your choice' };
    }

    if (!own.ok) {
      // Can't tell from the title. Old rule only when EVERY variant is a CFS product match:
      // choose the CFS product by colour; otherwise flag.
      if (all.every(n => stat(n)?.matchStatus === 'cfs-product')) {
        const cands = [...new Set(all.map(n => parseSku(n.sku).prodId).filter(Boolean))].map(prodId => ({ prodId, name: cfsNames.get(prodId) || null }));
        const d = pickCfsProductByColour(product.title, cands);
        if (!d.ok) return { action: 'flag', reason: d.reason };
        return tidyPlan(product, all, stat, all.filter(n => parseSku(n.sku).prodId === d.prodId), d.prodId, d.reason);
      }
      return { action: 'flag', reason: `can't tell which variant this product is (${own.reason})`, candidates: all, ask: 'own' };
    }

    const ownNodes = all.filter(n => own.ownIds.includes(n.id));
    const ownSkus  = ownNodes.map(n => n.sku).join(', ');
    const ownStats = ownNodes.map(n => stat(n)?.matchStatus || 'unknown');
    const label    = `this product is "${own.label}" (${ownSkus})`;

    if (ownStats.includes('ok')) {
      // Own variant is a normal CFS variant → leave it; tidy the other variants only
      return tidyPlan(product, all, stat, [], null, `${label}, still in CFS`);
    }
    const ownCfs = ownNodes.filter(n => stat(n)?.matchStatus === 'cfs-product');
    if (ownCfs.length) {
      const prodIds = [...new Set(ownCfs.map(n => parseSku(n.sku).prodId).filter(Boolean))];
      let prodId = prodIds[0], why;
      if (prodIds.length > 1) {
        const d = pickCfsProductByColour(product.title, prodIds.map(p => ({ prodId: p, name: cfsNames.get(p) || null })));
        if (!d.ok) return { action: 'flag', reason: d.reason };
        prodId = d.prodId; why = d.reason;
      } else {
        const fit = titleFitsCfsName(product.title, cfsNames.get(prodId) || null);
        if (!fit.ok) return { action: 'flag', reason: fit.reason };
        why = fit.reason;
      }
      const keepRow = stat(ownCfs.find(n => parseSku(n.sku).prodId === prodId));
      if (keepRow?.cfsProductStatus === 'inactive') {
        const b = onlySoldHere(product, handle, all, stat, own, ownNodes, `${label} — CFS product UD-${prodId} is inactive`);
        if (b) return b;
        return { action: 'draft', reason: `${label} — CFS product UD-${prodId} is inactive — whole product goes to DRAFT, variants and photos kept` };
      }
      return tidyPlan(product, all, stat, ownCfs.filter(n => parseSku(n.sku).prodId === prodId), prodId, `${label} — ${why}`);
    }
    if (ownStats.every(s => s === 'unknown')) return { action: 'flag', reason: `${label} — its CFS status is unknown, run the comparison again` };
    const b = onlySoldHere(product, handle, all, stat, own, ownNodes, `${label} and that is not in CFS`);
    if (b) return b;
    return { action: 'draft', reason: `${label} and that is not in CFS — whole product goes to DRAFT, variants and photos kept` };
  }

  // Own variant gone, but some of the other variants are only sold on this product (Vernal case)
  //   → ask (keep as the Grey product + rename / Draft / Skip); with the choice → do it
  // Returns null when the normal Draft applies (others sold elsewhere, or no skuHomes from the page)
  function onlySoldHere(product, handle, all, stat, own, ownNodes, reasonBase) {
    if (!skuHomes) return null;
    const remaining = all.filter(n => !own.ownIds.includes(n.id));
    const homeless = remaining.filter(n => !(skuHomes[n.sku] || []).some(h => h !== handle));
    if (!remaining.length || !homeless.length) return null;
    const d = decisions[handle] || {};
    if (d.keepAs) {
      const keep = all.find(n => n.id === d.keepAs);
      if (!keep) return { action: 'flag', reason: 'the variant you chose was not found — run the comparison again' };
      const ks = stat(keep);
      const keepProd = ks?.matchStatus === 'cfs-product' && ks.cfsProductStatus !== 'inactive' ? parseSku(keep.sku).prodId : null;
      const plan = tidyPlan(product, remaining, stat, keepProd ? [keep] : [], keepProd, `your choice — keep as the "${variantLabel(keep)}" product`);
      if (plan.action === 'flag') return plan;
      const p2 = plan.action === 'promote' ? plan : { action: 'promote', prodId: null, setActive: false, renames: [], deleteNodes: [], deleteWhy: {}, asIs: [], reason: plan.reason };
      p2.deleteWhy = p2.deleteWhy || {};
      for (const n of ownNodes) { p2.deleteNodes.push(n); p2.deleteWhy[n.id] = `own variant "${variantLabel(n)}" is not in CFS — your choice: keep as "${variantLabel(keep)}"`; }
      p2.rename = renamePlan(product, handle, own, keep);
      return p2;
    }
    return { action: 'flag', ask: 'keepas', keepAsOwn: own, homeless,
      reason: `${reasonBase}, but ${homeless.map(n => `"${variantLabel(n)}"`).join(', ')} ${homeless.length > 1 ? 'are' : 'is'} only sold on this product — choose what to do` };
  }

  // What happens to every variant of a product that stays:
  //   own variant (CFS product)          → SKU shortened to UD-{prodId}, product ACTIVE
  //   other variant, CFS product active  → kept, SKU shortened to UD-{prodId}
  //   other variant, normal CFS variant  → kept as is
  //   other variant, not in CFS          → deleted
  //   anything else (inactive, code-only, unknown) → kept as is, noted
  // Two variants that would get the same SKU → flag, nothing changed.
  // Several variants point at ONE CFS product that has no variants in CFS (e.g. CFS turned
  // "Emerald Green 4ft 6in / 5ft" into a single product "… Emerald Green … – 4ft 6in Double").
  // Which variant is that CFS product?
  //   1. product code: the variant's saved variant_code = the CFS product code
  //   2. name: the words that tell the variants apart (e.g. "4ft 6in Double") are in the CFS name
  //   code and name pointing at different variants, or neither deciding → flag, change nothing
  function normCode(c) { return String(c || '').trim().toUpperCase(); }
  function chooseOne(nodes, prodId, stat) {
    const mine = nodes.filter(n => decisionKeep.has(n.id));
    if (mine.length === 1) return { ok: true, keep: mine[0], reason: 'your choice' };
    const code = normCode(cfsCodes.get(String(prodId)));
    const name = cfsNames.get(String(prodId)) || '';
    const byCode = code ? nodes.filter(n => normCode(stat(n)?.shopifyVariantCode) === code) : [];
    const nameWords = new Set(ownWords(name));
    const diff = ownDistinguishing(nodes.map(variantLabel));
    const byName = name ? nodes.filter((n, i) => diff[i].length && diff[i].every(w => nameWords.has(w))) : [];
    const list = nodes.map(variantLabel).join(', ');
    if (byCode.length === 1) {
      if (byName.length === 1 && byName[0] !== byCode[0]) return { ok: false, candidates: nodes, reason: `variants ${list} point at CFS product UD-${prodId}: product code ${code} says "${variantLabel(byCode[0])}" but the CFS name "${name}" says "${variantLabel(byName[0])}" — please check` };
      return { ok: true, keep: byCode[0], reason: `product code ${code} matches "${variantLabel(byCode[0])}"` };
    }
    if (byName.length === 1) return { ok: true, keep: byName[0], reason: `CFS name "${name}" matches "${variantLabel(byName[0])}"` };
    return { ok: false, candidates: nodes, reason: `${nodes.length} variants (${list}) point at the same CFS product UD-${prodId}${name ? ` ("${name}"${code ? `, code ${code}` : ''})` : ''}, which has no variants in CFS, and neither the product code nor the name says which one it is — please check` };
  }

  function tidyPlan(product, all, stat, ownKeep, ownProdId, reason) {
    const deleteNodes = [], deleteWhy = {}, notes = [];
    if (ownKeep.length > 1) {
      const c = chooseOne(ownKeep, ownProdId, stat);
      if (!c.ok) return { action: 'flag', reason: c.reason, candidates: c.candidates, ask: 'keep' };
      for (const n of ownKeep) if (n !== c.keep) { deleteNodes.push(n); deleteWhy[n.id] = `CFS product UD-${ownProdId} is now only "${variantLabel(c.keep)}" — ${c.reason}`; }
      notes.push(`kept "${variantLabel(c.keep)}" — ${c.reason}`);
      ownKeep = [c.keep];
    }
    let renames = [];
    const asIs = [];
    for (const n of all) {
      if (deleteNodes.includes(n)) continue;
      const s = stat(n), { prodId } = parseSku(n.sku);
      const isOwn = ownKeep.includes(n);
      if (isOwn || (s?.matchStatus === 'cfs-product' && s.cfsProductStatus !== 'inactive' && prodId)) {
        if (n.sku !== `UD-${prodId}`) renames.push({ node: n, newSku: `UD-${prodId}`, own: isOwn });
      } else if (s?.matchStatus === 'orphaned') deleteNodes.push(n);
      else if (s?.matchStatus !== 'ok') asIs.push({ node: n, why: ({ 'cfs-product': 'its CFS product is inactive', 'cfs-inactive': 'inactive in CFS',
        'code-only': 'only an old saved code matches CFS — check', 'sku-typo': 'SKU typo — use Fix Selected SKUs first',
        'other-brand': 'found under another brand — check the vendor', draft: 'product is draft' })[s?.matchStatus] || 'status unknown' });
    }
    // Sibling variants that would share one SKU → same choice rule
    const groups = new Map();
    for (const r of renames) if (!r.own) { if (!groups.has(r.newSku)) groups.set(r.newSku, []); groups.get(r.newSku).push(r); }
    for (const [newSku, rs] of groups) if (rs.length > 1) {
      const prodId = newSku.replace(/^UD-/, '');
      const c = chooseOne(rs.map(r => r.node), prodId, stat);
      if (!c.ok) return { action: 'flag', reason: c.reason, candidates: c.candidates, ask: 'keep' };
      for (const r of rs) if (r.node !== c.keep) { deleteNodes.push(r.node); deleteWhy[r.node.id] = `CFS product UD-${prodId} is now only "${variantLabel(c.keep)}" — ${c.reason}`; }
      renames = renames.filter(r => !(r.newSku === newSku && r.node !== c.keep));
      notes.push(`kept "${variantLabel(c.keep)}" for UD-${prodId} — ${c.reason}`);
    }
    const newSkus = renames.map(r => r.newSku);
    const dup = newSkus.find((x, i) => newSkus.indexOf(x) !== i || all.some(n => n.sku === x && !renames.some(r => r.node === n) && !deleteNodes.includes(n)));
    if (dup) return { action: 'flag', reason: `two variants would both get SKU ${dup} (CFS has no variants for it) — please check` };
    if (!renames.length && !deleteNodes.length && !ownProdId) return { action: 'none', reason: `${reason} — nothing to change` };
    return { action: 'promote', prodId: ownProdId, setActive: !!ownProdId, renames, deleteNodes, deleteWhy, asIs,
      reason: notes.length ? `${reason}; ${notes.join('; ')}` : reason };
  }

  // Two Shopify products must not become the same CFS product
  const byProd = new Map();
  for (const [h, p] of plans) if (p.action === 'promote' && p.prodId) { if (!byProd.has(p.prodId)) byProd.set(p.prodId, []); byProd.get(p.prodId).push(h); }
  for (const [prodId, handles] of byProd) if (handles.length > 1) {
    for (const h of handles) plans.set(h, { action: 'flag', reason: `would become the same CFS product (UD-${prodId}) as ${handles.filter(x => x !== h).join(', ')} — please check` });
  }

  for (const [handle, variantsForProduct] of byHandle) {
    const product = productCache.get(handle);
    const plan = plans.get(handle);
    const extra = sharedAdded.has(handle) ? ` [checked because it also has ${sharedAdded.get(handle)}]` : '';
    const rowsFor = () => variantsForProduct.length ? variantsForProduct.map(v => ({ sku: v.variantSku, productCode: v.productCode || '' }))
      : [{ sku: sharedAdded.get(handle) || '-', productCode: '' }];
    const codeOf = sku => (variantsForProduct.find(v => v.variantSku === sku) || {}).productCode || '';

    if (!product || !plan) {
      for (const r of rowsFor()) { log.push({ ...r, handle, status: 'not_found', message: `Product handle "${handle}" not found on Shopify` }); failed++; }
      continue;
    }
    try {
      if (plan.action === 'none') {
        if (variantsForProduct.length) for (const r of rowsFor()) log.push({ ...r, handle, status: 'skipped', message: `No change — ${plan.reason}: ${product.title}${extra}` });
        continue;
      }
      if (plan.action === 'flag') {
        for (const r of rowsFor()) log.push({ ...r, handle, status: 'flagged', message: `NOT changed — ${plan.reason} · ${product.title}${extra}` });
        flagged++;
        const options = plan.ask === 'keepas' ? keepAsOptions(product, handle, plan.keepAsOwn, plan.homeless).slice(0, -2) : [];
        for (const n of (plan.candidates || [])) options.push({ value: `keep:${n.id}`,
          label: plan.ask === 'own' ? `This product is "${variantLabel(n)}" (${n.sku}) — then apply the normal rules` : `Keep "${variantLabel(n)}" (${n.sku}), delete the other(s) here` });
        options.push({ value: 'draft', label: 'Set the whole product to Draft (variants & photos kept)' });
        options.push({ value: 'skip', label: 'Skip — leave as it is' });
        decisionList.push({ origin: 'publish', handle, title: product.title, reason: plan.reason, options });
        continue;
      }

      if (plan.action === 'draft') {
        if (dryRun) {
          for (const r of rowsFor()) log.push({ ...r, handle, status: 'dry_run', message: `Would set "${product.title}" to DRAFT — ${plan.reason}${extra}` });
          continue;
        }
        const result = await gql(client, SET_PRODUCT_DRAFT_MUTATION, { productId: product.id });
        const errs = result?.productUpdate?.userErrors || [];
        if (errs.length) {
          for (const r of rowsFor()) { log.push({ ...r, handle, status: 'error', message: `Set-to-draft failed: ${errs.map(e => e.message).join(', ')}` }); failed++; }
        } else {
          rec(undoRun, { type: 'status', productId: product.id, handle, title: product.title, before: product.status || 'ACTIVE', after: 'DRAFT' });
          for (const r of rowsFor()) log.push({ ...r, handle, status: 'drafted', message: `Product set to DRAFT — ${plan.reason}: ${product.title}${extra}` });
          drafted++;
          console.log(`  → "${product.title}" → DRAFT (own variant not in CFS)`);
        }
        await sleep(350);
        continue;
      }

      // ── KEEP & TIDY: shorten SKUs of variants that are CFS products, delete variants
      //    not in CFS, set ACTIVE when the product's own variant is a CFS product ──
      const ownRename = plan.renames.find(r => r.own);
      const keepRow = ownRename ? (statusBySku.get(`${handle}|${ownRename.node.sku}`) || {}) : {};
      const targetStatus = keepRow.cfsProductStatus === 'inactive' ? 'DRAFT' : 'ACTIVE';
      if (dryRun) {
        for (const n of plan.deleteNodes) log.push({ sku: n.sku, handle, status: 'dry_run', productCode: codeOf(n.sku),
          message: `Would delete variant "${variantLabel(n)}" (${plan.deleteWhy?.[n.id] || 'not in CFS'}) · ${product.title}${extra}` });
        for (const r of plan.renames) log.push({ sku: r.node.sku, handle, status: 'dry_run', productCode: codeOf(r.node.sku),
          message: r.own
            ? `Would update SKU "${r.node.sku}" → "${r.newSku}" (own variant "${variantLabel(r.node)}") · ${product.title}${extra}`
            : `Would keep variant "${variantLabel(r.node)}" and update SKU "${r.node.sku}" → "${r.newSku}" (CFS product exists) · ${product.title}${extra}` });
        for (const a of plan.asIs) log.push({ sku: a.node.sku, handle, status: 'dry_run', productCode: codeOf(a.node.sku),
          message: `Would leave variant "${variantLabel(a.node)}" as it is (${a.why}) · ${product.title}${extra}` });
        log.push({ sku: '-', handle, status: 'dry_run', message: plan.setActive
          ? `Would set product to ${targetStatus} (main product — ${plan.reason}) · ${product.title}${extra}`
          : `Product status unchanged (${plan.reason}) · ${product.title}${extra}` });
        if (plan.rename) log.push({ sku: '-', handle, status: plan.rename.ok ? 'dry_run' : 'warning', message: plan.rename.ok
          ? `Would rename the title "${product.title}" → "${plan.rename.title}"${plan.rename.changedHandle ? `, URL /${handle} → /${plan.rename.handle} (old URL redirects)` : ''} — you can change the title manually later · ${product.title}`
          : `${plan.rename.note} · ${product.title}` });
        log.push({ sku: '-', handle, status: 'dry_run', message: `Photos: not changed here — will be updated in Image Sync: ${product.title}` });
        imageSyncHandles.add(handle);
        await sleep(150);
        continue;
      }

      // Step A — delete variants not in CFS
      if (plan.deleteNodes.length) {
        const delResult = await gql(client, DELETE_VARIANTS_MUTATION, { productId: product.id, variantsIds: plan.deleteNodes.map(v => v.id) });
        const delErrors = delResult?.productVariantsBulkDelete?.userErrors || [];
        if (delErrors.length) {
          const errMsg = delErrors.map(e => e.message).join(', ');
          for (const n of plan.deleteNodes) { log.push({ sku: n.sku, handle, status: 'error', message: `Variant delete failed: ${errMsg}`, productCode: codeOf(n.sku) }); failed++; }
          await sleep(350);
          continue;
        }
        deleted += plan.deleteNodes.length;
        rec(undoRun, { type: 'variants-deleted', productId: product.id, handle, title: product.title, skus: plan.deleteNodes.map(n => n.sku) });
        for (const n of plan.deleteNodes) log.push({ sku: n.sku, handle, status: 'deleted', productCode: codeOf(n.sku),
          message: `Deleted (${plan.deleteWhy?.[n.id] || 'not in CFS'}): ${product.title} / ${variantLabel(n)}` });
      }

      // Step B — shorten SKUs to UD-{prodId}
      if (plan.renames.length) {
        const updateResult = await gql(client, UPDATE_VARIANT_SKU_MUTATION, { productId: product.id, variants: plan.renames.map(r => ({ id: r.node.id, sku: r.newSku })) });
        const updateErrors = updateResult?.productVariantsBulkUpdate?.userErrors || [];
        if (updateErrors.length) {
          for (const r of plan.renames) { log.push({ sku: r.node.sku, handle, status: 'error', message: `SKU update failed: ${updateErrors.map(e => e.message).join(', ')}`, productCode: codeOf(r.node.sku) }); failed++; }
        } else {
          for (const r of plan.renames) {
            log.push({ sku: r.newSku, handle, status: 'updated', productCode: codeOf(r.node.sku),
              message: `SKU updated: "${r.node.sku}" → "${r.newSku}" (${r.own ? 'own variant' : 'kept, CFS product exists'}) on "${product.title}" / ${variantLabel(r.node)}` });
            rec(undoRun, { type: 'sku', productId: product.id, handle, title: product.title, variantId: r.node.id, before: r.node.sku, after: r.newSku });
          }
          console.log(`  ✓ ${plan.renames.length} SKU(s) updated on "${product.title}"`);
        }
      }
      for (const a of plan.asIs) log.push({ sku: a.node.sku, handle, status: 'skipped', productCode: codeOf(a.node.sku),
        message: `Left as it is (${a.why}): ${product.title} / ${variantLabel(a.node)}` });

      // Step C — photos are handed over to Image Sync
      imageSyncHandles.add(handle);

      // Step D — product status (only when the product's own variant became the main CFS product)
      if (plan.setActive) {
        const statusMutation = targetStatus === 'ACTIVE' ? SET_PRODUCT_ACTIVE_MUTATION : SET_PRODUCT_DRAFT_MUTATION;
        const statusResult = await gql(client, statusMutation, { productId: product.id });
        const statusErrors = statusResult?.productUpdate?.userErrors || [];
        if (statusErrors.length) {
          log.push({ sku: '-', handle, status: 'error', message: `Status update failed: ${statusErrors.map(e => e.message).join(', ')}` });
          failed++;
        } else {
          const verb = targetStatus === 'ACTIVE' ? 'published' : 'drafted';
          log.push({ sku: ownRename?.newSku || '-', handle, status: verb, message: `Main product, set to ${targetStatus} (${plan.reason}): ${product.title}${extra}` });
          if ((product.status || '') !== targetStatus) rec(undoRun, { type: 'status', productId: product.id, handle, title: product.title, before: product.status || 'ACTIVE', after: targetStatus });
          if (targetStatus === 'ACTIVE') published++; else drafted++;
          console.log(`  ✓ "${product.title}" → ${targetStatus} as main product`);
        }
      }
      // Step E — "keep as the Grey product": rename title + URL (old URL redirects)
      if (plan.rename) {
        const r = await applyRename(client, product, handle, plan.rename, undoRun);
        log.push({ sku: '-', handle, status: r.ok ? 'updated' : 'warning', message: `${r.message} · ${product.title}` });
        if (r.ok && plan.rename.changedHandle) { imageSyncHandles.delete(handle); imageSyncHandles.add(plan.rename.handle); }
      }
      await sleep(350);

    } catch (err) {
      const msg = err.response?.data?.errors || err.message;
      for (const r of rowsFor()) { log.push({ ...r, handle, status: 'error', message: String(msg) }); failed++; }
    }
  }

  console.log(`  ✓ Done — deleted variants: ${deleted}, published: ${published}, drafted: ${drafted}, failed: ${failed}`);
  const undoId = undoRun ? undo.save(undoRun) : null;
  res.json({ success: true, dryRun, deleted, published, drafted, failed, flagged, total: variants.length, log, undoId,
    imageSyncHandles: [...imageSyncHandles], decisions: decisionList });
});


// ── POST /api/shopify/sync-metafields ────────────────────────────────────────
//
// Body: { variants: [...allResults...], dryRun: bool }
//
// BULK SCAN APPROACH — replaces the previous per-SKU query strategy.
//
// Old approach (broken): one Shopify API call per CFS SKU (~5000+ calls,
//   ~30 min runtime → connection cut at 20 min by nginx/Cloudflare).
//
// New approach: scan ALL Shopify variants in pages of 250 (40–200 calls total),
//   match each variant's SKU against the CFS skuCodeMap in memory, then write
//   metafields only for matches. Total runtime: 1–2 minutes.
//
// Two phases:
//   Phase 1 (scan):  paginate all Shopify variants, collect matches by product.
//   Phase 2 (write): upsert metafields for each matched product/variant.
//
//   • custom.product_code on the Shopify product (once per product, upsert)
//   • custom.variant_code on the Shopify variant  (one per variant, upsert)
//
// Uses metafieldsSet which acts as upsert — safe to run multiple times.
// Batches up to 25 metafields per API call to stay within Shopify limits.
//
router.post('/sync-metafields', async (req, res) => {
  const { variants = [], dryRun = true } = req.body;

  // Only rows that have at least one code to write
  const toSync = variants.filter(v => v.productCodeOnly || v.variantCode);

  if (!toSync.length) {
    return res.status(400).json({ error: 'No variants with CFS codes found. Make sure the CFS feeds contain Product Code / var_code columns.' });
  }

  let client;
  try {
    client = graphqlClient();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // ── Stream as SSE (text/event-stream) ────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.socket) res.socket.setNoDelay(true);
  res.flushHeaders();
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // ── Keepalive ping every 20s ──────────────────────────────────────────────
  const keepAliveTimer = setInterval(() => {
    if (!res.writableEnded) res.write(': keepalive\n\n');
  }, 20000);
  const endStream = () => { clearInterval(keepAliveTimer); res.end(); };

  const log          = [];
  let synced         = 0;
  let newCount       = 0;
  let overwriteCount = 0;
  let skipped        = 0;
  let failed         = 0;

  // ── Build unique-SKU → codes map (first occurrence wins per SKU) ─────────
  const skuCodeMap = new Map(); // sku → { productCode, variantCode }
  for (const v of toSync) {
    if (!skuCodeMap.has(v.variantSku)) {
      skuCodeMap.set(v.variantSku, {
        productCode: v.productCodeOnly || '',
        variantCode: v.variantCode     || '',
      });
    }
  }

  // ── Identify product-level SKUs that have sub-variants in the feed ───────
  // A "product-level" SKU looks like UD-{prodId} (2 segments).
  // A "sub-variant" SKU looks like UD-{prodId}-{varId} (3 segments).
  //
  // Rule: for UD-{prodId} SKUs that have NO UD-{prodId}-{varId} entries in
  // skuCodeMap, we must write variant_code on the Shopify variant in addition
  // to product_code on the product — because that lone variant IS both the
  // product and the only variant.
  // If UD-{prodId}-{varId} sub-variants DO exist, those carry their own
  // variant_code, and the product-level Shopify variant is just a placeholder.
  const prodIdsWithSubVariants = new Set();
  for (const sku of skuCodeMap.keys()) {
    const parts = sku.split('-');
    if (parts.length >= 3 && parts[0] === 'UD') {
      prodIdsWithSubVariants.add(`${parts[0]}-${parts[1]}`); // e.g. "UD-601539"
    }
  }

  // Returns the variant_code to write for a given Shopify variant SKU.
  // For UD-{prodId}-{varId}: uses codes.variantCode (from CFS variant feed).
  // For UD-{prodId} with no sub-variants: uses codes.variantCode if set,
  //   then falls back to codes.productCode (product and variant are the same item).
  // For UD-{prodId} WITH sub-variants: returns '' (skip — sub-variants own this).
  function resolveVarCode(sku, codes) {
    if (codes.variantCode) return codes.variantCode; // explicit value always wins
    const parts = sku ? sku.split('-') : [];
    if (parts.length === 2 && parts[0] === 'UD' && !prodIdsWithSubVariants.has(sku)) {
      // Product-level SKU with no sub-variants: fall back to productCode
      return codes.productCode || '';
    }
    return '';
  }

  // productCodeWritten tracks which Shopify product GIDs already had
  // product_code written this run (multiple variants can share a product).
  const productCodeWritten = new Set();

  console.log(`▶ sync-metafields: ${skuCodeMap.size} unique CFS SKUs, bulk scan mode (dryRun=${dryRun})`);
  console.log(`  product-level SKUs with sub-variants: ${prodIdsWithSubVariants.size}`);

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 1 — Scan all Shopify variants (250 per page), collect matches
  // ════════════════════════════════════════════════════════════════════════
  send({ type: 'progress', phase: 'scan', scannedVariants: 0, matchedProducts: 0 });

  // matchedByProduct: productId → { productNode, variants: [variantNode, ...] }
  // Built during the scan so Phase 2 has all the data it needs in memory.
  const matchedByProduct = new Map();
  let scanCursor   = null;
  let scanHasMore  = true;
  let scannedVariants = 0;
  let scannedPages    = 0;

  try {
    while (scanHasMore) {
      const data     = await gql(client, ALL_VARIANTS_SCAN_QUERY, { after: scanCursor });
      const edges    = data?.productVariants?.edges    || [];
      const pageInfo = data?.productVariants?.pageInfo || {};
      scannedPages++;
      scannedVariants += edges.length;

      for (const { node } of edges) {
        if (!node.sku || !skuCodeMap.has(node.sku)) continue; // not a CFS SKU — skip
        const pid = node.product.id;
        if (!matchedByProduct.has(pid)) {
          matchedByProduct.set(pid, { productNode: node.product, variants: [] });
        }
        matchedByProduct.get(pid).variants.push(node);
      }

      scanHasMore = pageInfo.hasNextPage;
      scanCursor  = pageInfo.endCursor || null;

      send({ type: 'progress', phase: 'scan', scannedVariants, matchedProducts: matchedByProduct.size });

      if (scannedPages % 10 === 0) {
        console.log(`  … scan page ${scannedPages}: ${scannedVariants} variants scanned, ${matchedByProduct.size} products matched`);
      }
    }
  } catch (scanErr) {
    console.error('  ✗ Scan phase error:', scanErr.message);
    send({ type: 'done', success: false, error: `Scan failed after ${scannedVariants} variants: ${scanErr.message}`,
      dryRun, synced, newCount, overwriteCount, skipped, failed, total: toSync.length, log });
    endStream();
    return;
  }

  console.log(`  ✓ Scan complete — ${scannedVariants} variants scanned across ${scannedPages} pages, ${matchedByProduct.size} products matched`);

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 2 — Write metafields for each matched product
  // ════════════════════════════════════════════════════════════════════════
  const totalProducts = matchedByProduct.size;
  let processed = 0;

  send({ type: 'progress', phase: 'write', processed: 0, totalProducts, synced, newCount, overwriteCount, skipped, failed });

  try {
    for (const [pid, { productNode, variants }] of matchedByProduct) {
      const handle           = productNode.handle;
      const title            = productNode.title;
      const existingProdCode = productNode.metafield?.value || '';

      // Determine the product_code for this product from its matched variants.
      // All variants on the same Shopify product share the same CFS product_code,
      // so take the first non-empty one.
      const productCode = variants
        .map(v => skuCodeMap.get(v.sku)?.productCode)
        .find(c => c) || '';

      try {
        if (dryRun) {
          // ── Dry-run reporting ──────────────────────────────────────────
          if (productCode && !productCodeWritten.has(pid)) {
            if (!existingProdCode) {
              log.push({ type: 'product', sku: variants[0].sku, handle, status: 'dry_run',
                message: `Would set custom.product_code = "${productCode}" on "${title}" (new)`,
                productCode, variantCode: '' });
            } else if (existingProdCode === productCode) {
              log.push({ type: 'product', sku: variants[0].sku, handle, status: 'match',
                message: `custom.product_code already "${productCode}" on "${title}" — no change needed`,
                productCode, variantCode: '' });
            } else {
              log.push({ type: 'product', sku: variants[0].sku, handle, status: 'overwrite',
                message: `Would overwrite custom.product_code: "${existingProdCode}" → "${productCode}" on "${title}"`,
                productCode, variantCode: '' });
            }
            productCodeWritten.add(pid);
          }

          for (const varNode of variants) {
            const codes   = skuCodeMap.get(varNode.sku) || {};
            const varCode = resolveVarCode(varNode.sku, codes);
            if (!varCode) continue;
            const existing = varNode.metafield?.value || '';
            if (!existing) {
              log.push({ type: 'variant', sku: varNode.sku, handle, status: 'dry_run',
                message: `Would set custom.variant_code = "${varCode}" on variant ${varNode.sku} in "${title}" (new)`,
                productCode: codes.productCode, variantCode: varCode });
            } else if (existing === varCode) {
              log.push({ type: 'variant', sku: varNode.sku, handle, status: 'match',
                message: `custom.variant_code already "${varCode}" on variant ${varNode.sku} in "${title}" — no change needed`,
                productCode: codes.productCode, variantCode: varCode });
            } else {
              log.push({ type: 'variant', sku: varNode.sku, handle, status: 'overwrite',
                message: `Would overwrite custom.variant_code: "${existing}" → "${varCode}" on variant ${varNode.sku} in "${title}"`,
                productCode: codes.productCode, variantCode: varCode });
            }
          }

        } else {
          // ── Live sync ─────────────────────────────────────────────────
          const metafields   = [];
          const overwriteMap = new Map(); // GID → old value (for log messages)

          // product_code: write once per product per run
          if (productCode && !productCodeWritten.has(pid)) {
            if (existingProdCode === productCode) {
              log.push({ type: 'product', sku: variants[0].sku, handle, status: 'match',
                message: `custom.product_code already "${productCode}" on "${title}" — skipped`,
                productCode, variantCode: '' });
              skipped++;
            } else {
              if (existingProdCode) overwriteMap.set(pid, existingProdCode);
              metafields.push({ ownerId: pid, namespace: 'custom', key: 'product_code',
                value: productCode, type: 'single_line_text_field' });
            }
          }

          // variant_code: one entry per matched variant on this product
          for (const varNode of variants) {
            const codes   = skuCodeMap.get(varNode.sku) || {};
            const varCode = resolveVarCode(varNode.sku, codes);
            if (!varCode) continue;
            const existing = varNode.metafield?.value || '';
            if (existing === varCode) {
              log.push({ type: 'variant', sku: varNode.sku, handle, status: 'match',
                message: `custom.variant_code already "${varCode}" on variant ${varNode.sku} in "${title}" — skipped`,
                productCode: codes.productCode, variantCode: varCode });
              skipped++;
              continue;
            }
            if (existing) overwriteMap.set(varNode.id, existing);
            metafields.push({ ownerId: varNode.id, namespace: 'custom', key: 'variant_code',
              value: varCode, type: 'single_line_text_field' });
          }

          if (metafields.length) {
            const BATCH_SIZE = 25;
            for (let i = 0; i < metafields.length; i += BATCH_SIZE) {
              const batch      = metafields.slice(i, i + BATCH_SIZE);
              const result     = await gql(client, METAFIELDS_SET_MUTATION, { metafields: batch });
              const userErrors = result?.metafieldsSet?.userErrors || [];

              if (userErrors.length) {
                const errMsg = userErrors.map(e => e.message).join(', ');
                for (const mf of batch) {
                  const isProduct = mf.ownerId === pid;
                  const varSku    = isProduct ? variants[0].sku : (variants.find(v => v.id === mf.ownerId)?.sku || '-');
                  log.push({ type: isProduct ? 'product' : 'variant', sku: varSku, handle,
                    status: 'error', message: `metafieldsSet failed: ${errMsg}` });
                  failed++;
                }
              } else {
                for (const mf of batch) {
                  const isProduct = mf.ownerId === pid;
                  const oldVal    = overwriteMap.get(mf.ownerId);
                  const varSku    = isProduct ? variants[0].sku : (variants.find(v => v.id === mf.ownerId)?.sku || '-');
                  if (isProduct) {
                    productCodeWritten.add(pid);
                    const msg = oldVal
                      ? `Overwrote custom.product_code: "${oldVal}" → "${mf.value}" on "${title}"`
                      : `Set custom.product_code = "${mf.value}" on "${title}" (new)`;
                    log.push({ type: 'product', sku: varSku, handle,
                      status: oldVal ? 'overwrite' : 'synced', message: msg, productCode: mf.value, variantCode: '' });
                  } else {
                    const msg = oldVal
                      ? `Overwrote custom.variant_code: "${oldVal}" → "${mf.value}" on variant ${varSku} in "${title}"`
                      : `Set custom.variant_code = "${mf.value}" on variant ${varSku} in "${title}" (new)`;
                    log.push({ type: 'variant', sku: varSku, handle,
                      status: oldVal ? 'overwrite' : 'synced', message: msg, productCode: '', variantCode: mf.value });
                  }
                  synced++;
                  if (oldVal) overwriteCount++; else newCount++;
                }
              }
            }

            await sleep(180); // brief pause between metafield write batches
          }

          productCodeWritten.add(pid);
        }
      } catch (err) {
        const msg = err.response?.data?.errors || err.message;
        console.error(`  ✗ [${handle}] Error: ${String(msg)}`);
        log.push({ type: 'product', sku: variants[0]?.sku || '-', handle,
          status: 'error', message: String(msg) });
        failed++;
      }

      processed++;
      send({ type: 'progress', phase: 'write', processed, totalProducts, synced, newCount, overwriteCount, skipped, failed });

      if (processed % 50 === 0 || processed === totalProducts) {
        console.log(`  … write ${processed}/${totalProducts} products — synced: ${synced}, skipped: ${skipped}, failed: ${failed}`);
      }

      if (dryRun) await sleep(30);
    }
  } catch (outerErr) {
    console.error(`  ✗ Write phase error at product ${processed}/${totalProducts}:`, outerErr.message);
    send({ type: 'done', success: false, error: `Write error at product ${processed}/${totalProducts}: ${outerErr.message}`,
      dryRun, synced, newCount, overwriteCount, skipped, failed, total: toSync.length, log });
    endStream();
    return;
  }

  console.log(`  ✓ Done — synced: ${synced} (new: ${newCount}, overwrites: ${overwriteCount}), skipped: ${skipped}, failed: ${failed}`);
  send({ type: 'done', success: true, dryRun, synced, newCount, overwriteCount, skipped, failed, total: toSync.length, log });
  endStream();
});


// ── POST /api/shopify/sync-metafields-from-api ───────────────────────────────
//
// Body: { dryRun: bool }
//
// Identical logic to sync-metafields above, but builds skuCodeMap directly
// from the CFS API (no variants[] body needed — no prior compare required).
//
// Phase 1: scan all Shopify variants (250/page), match SKUs against CFS data.
// Phase 2: upsert custom.product_code (product) + custom.variant_code (variant).
//
router.post('/sync-metafields-from-api', async (req, res) => {
  const { dryRun = true } = req.body;

  let client;
  try {
    client = graphqlClient();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // ── Stream as SSE ─────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.socket) res.socket.setNoDelay(true);
  res.flushHeaders();
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const keepAliveTimer = setInterval(() => {
    if (!res.writableEnded) res.write(': keepalive\n\n');
  }, 20000);
  const endStream = () => { clearInterval(keepAliveTimer); res.end(); };

  const log          = [];
  let synced         = 0;
  let newCount       = 0;
  let overwriteCount = 0;
  let skipped        = 0;
  let failed         = 0;

  // ── Fetch CFS data from API ───────────────────────────────────────────────
  send({ type: 'progress', phase: 'fetch', message: 'Fetching CFS product data from API…' });
  let skuCodeMap;
  try {
    console.log('▶ sync-metafields-from-api: fetching CFS API…');
    const cfsProducts = await fetchCfsProducts();
    skuCodeMap = buildSkuCodeMap(cfsProducts);
    console.log(`  ✓ ${cfsProducts.length} products, ${skuCodeMap.size} SKU mappings from CFS API`);
    send({ type: 'progress', phase: 'fetch', skuCount: skuCodeMap.size });
  } catch (fetchErr) {
    console.error('  ✗ CFS API fetch failed:', fetchErr.message);
    send({ type: 'done', success: false, error: `CFS API fetch failed: ${fetchErr.message}`,
      dryRun, synced, newCount, overwriteCount, skipped, failed, total: 0, log });
    endStream();
    return;
  }

  // ── Build prodIdsWithSubVariants (same logic as sync-metafields) ──────────
  const prodIdsWithSubVariants = new Set();
  for (const sku of skuCodeMap.keys()) {
    const parts = sku.split('-');
    if (parts.length >= 3 && parts[0] === 'UD') {
      prodIdsWithSubVariants.add(`${parts[0]}-${parts[1]}`);
    }
  }

  function resolveVarCode(sku, codes) {
    if (codes.variantCode) return codes.variantCode;
    const parts = sku ? sku.split('-') : [];
    if (parts.length === 2 && parts[0] === 'UD' && !prodIdsWithSubVariants.has(sku)) {
      return codes.productCode || '';
    }
    return '';
  }

  const productCodeWritten = new Set();
  const totalCfsSkus = skuCodeMap.size;

  console.log(`▶ sync-metafields-from-api: ${totalCfsSkus} CFS SKUs, bulk scan mode (dryRun=${dryRun})`);
  console.log(`  product-level SKUs with sub-variants: ${prodIdsWithSubVariants.size}`);

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 1 — Scan all Shopify variants (250 per page)
  // ════════════════════════════════════════════════════════════════════════
  send({ type: 'progress', phase: 'scan', scannedVariants: 0, matchedProducts: 0 });

  const matchedByProduct = new Map();
  let scanCursor      = null;
  let scanHasMore     = true;
  let scannedVariants = 0;
  let scannedPages    = 0;

  try {
    while (scanHasMore) {
      const data     = await gql(client, ALL_VARIANTS_SCAN_QUERY, { after: scanCursor });
      const edges    = data?.productVariants?.edges    || [];
      const pageInfo = data?.productVariants?.pageInfo || {};
      scannedPages++;
      scannedVariants += edges.length;

      for (const { node } of edges) {
        if (!node.sku || !skuCodeMap.has(node.sku)) continue;
        const pid = node.product.id;
        if (!matchedByProduct.has(pid)) {
          matchedByProduct.set(pid, { productNode: node.product, variants: [] });
        }
        matchedByProduct.get(pid).variants.push(node);
      }

      scanHasMore = pageInfo.hasNextPage;
      scanCursor  = pageInfo.endCursor || null;

      send({ type: 'progress', phase: 'scan', scannedVariants, matchedProducts: matchedByProduct.size });

      if (scannedPages % 10 === 0) {
        console.log(`  … scan page ${scannedPages}: ${scannedVariants} variants scanned, ${matchedByProduct.size} products matched`);
      }
    }
  } catch (scanErr) {
    console.error('  ✗ Scan phase error:', scanErr.message);
    send({ type: 'done', success: false, error: `Scan failed after ${scannedVariants} variants: ${scanErr.message}`,
      dryRun, synced, newCount, overwriteCount, skipped, failed, total: totalCfsSkus, log });
    endStream();
    return;
  }

  console.log(`  ✓ Scan complete — ${scannedVariants} variants scanned, ${scannedPages} pages, ${matchedByProduct.size} products matched`);

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 2 — Write metafields for each matched product
  // ════════════════════════════════════════════════════════════════════════
  const totalProducts = matchedByProduct.size;
  let processed = 0;

  send({ type: 'progress', phase: 'write', processed: 0, totalProducts, synced, newCount, overwriteCount, skipped, failed });

  try {
    for (const [pid, { productNode, variants }] of matchedByProduct) {
      const handle           = productNode.handle;
      const title            = productNode.title;
      const existingProdCode = productNode.metafield?.value || '';

      const productCode = variants
        .map(v => skuCodeMap.get(v.sku)?.productCode)
        .find(c => c) || '';

      try {
        if (dryRun) {
          if (productCode && !productCodeWritten.has(pid)) {
            if (!existingProdCode) {
              log.push({ type: 'product', sku: variants[0].sku, handle, status: 'dry_run',
                message: `Would set custom.product_code = "${productCode}" on "${title}" (new)`,
                productCode, variantCode: '' });
            } else if (existingProdCode === productCode) {
              log.push({ type: 'product', sku: variants[0].sku, handle, status: 'match',
                message: `custom.product_code already "${productCode}" on "${title}" — no change needed`,
                productCode, variantCode: '' });
            } else {
              log.push({ type: 'product', sku: variants[0].sku, handle, status: 'overwrite',
                message: `Would overwrite custom.product_code: "${existingProdCode}" → "${productCode}" on "${title}"`,
                productCode, variantCode: '' });
            }
            productCodeWritten.add(pid);
          }

          for (const varNode of variants) {
            const codes   = skuCodeMap.get(varNode.sku) || {};
            const varCode = resolveVarCode(varNode.sku, codes);
            if (!varCode) continue;
            const existing = varNode.metafield?.value || '';
            if (!existing) {
              log.push({ type: 'variant', sku: varNode.sku, handle, status: 'dry_run',
                message: `Would set custom.variant_code = "${varCode}" on variant ${varNode.sku} in "${title}" (new)`,
                productCode: codes.productCode, variantCode: varCode });
            } else if (existing === varCode) {
              log.push({ type: 'variant', sku: varNode.sku, handle, status: 'match',
                message: `custom.variant_code already "${varCode}" on variant ${varNode.sku} in "${title}" — no change needed`,
                productCode: codes.productCode, variantCode: varCode });
            } else {
              log.push({ type: 'variant', sku: varNode.sku, handle, status: 'overwrite',
                message: `Would overwrite custom.variant_code: "${existing}" → "${varCode}" on variant ${varNode.sku} in "${title}"`,
                productCode: codes.productCode, variantCode: varCode });
            }
          }

        } else {
          const metafields   = [];
          const overwriteMap = new Map();

          if (productCode && !productCodeWritten.has(pid)) {
            if (existingProdCode === productCode) {
              log.push({ type: 'product', sku: variants[0].sku, handle, status: 'match',
                message: `custom.product_code already "${productCode}" on "${title}" — skipped`,
                productCode, variantCode: '' });
              skipped++;
            } else {
              if (existingProdCode) overwriteMap.set(pid, existingProdCode);
              metafields.push({ ownerId: pid, namespace: 'custom', key: 'product_code',
                value: productCode, type: 'single_line_text_field' });
            }
          }

          for (const varNode of variants) {
            const codes   = skuCodeMap.get(varNode.sku) || {};
            const varCode = resolveVarCode(varNode.sku, codes);
            if (!varCode) continue;
            const existing = varNode.metafield?.value || '';
            if (existing === varCode) {
              log.push({ type: 'variant', sku: varNode.sku, handle, status: 'match',
                message: `custom.variant_code already "${varCode}" on variant ${varNode.sku} in "${title}" — skipped`,
                productCode: codes.productCode, variantCode: varCode });
              skipped++;
              continue;
            }
            if (existing) overwriteMap.set(varNode.id, existing);
            metafields.push({ ownerId: varNode.id, namespace: 'custom', key: 'variant_code',
              value: varCode, type: 'single_line_text_field' });
          }

          if (metafields.length) {
            const BATCH_SIZE = 25;
            for (let i = 0; i < metafields.length; i += BATCH_SIZE) {
              const batch      = metafields.slice(i, i + BATCH_SIZE);
              const result     = await gql(client, METAFIELDS_SET_MUTATION, { metafields: batch });
              const userErrors = result?.metafieldsSet?.userErrors || [];

              if (userErrors.length) {
                const errMsg = userErrors.map(e => e.message).join(', ');
                for (const mf of batch) {
                  const isProduct = mf.ownerId === pid;
                  const varSku    = isProduct ? variants[0].sku : (variants.find(v => v.id === mf.ownerId)?.sku || '-');
                  log.push({ type: isProduct ? 'product' : 'variant', sku: varSku, handle,
                    status: 'error', message: `metafieldsSet failed: ${errMsg}` });
                  failed++;
                }
              } else {
                for (const mf of batch) {
                  const isProduct = mf.ownerId === pid;
                  const oldVal    = overwriteMap.get(mf.ownerId);
                  const varSku    = isProduct ? variants[0].sku : (variants.find(v => v.id === mf.ownerId)?.sku || '-');
                  if (isProduct) {
                    productCodeWritten.add(pid);
                    const msg = oldVal
                      ? `Overwrote custom.product_code: "${oldVal}" → "${mf.value}" on "${title}"`
                      : `Set custom.product_code = "${mf.value}" on "${title}" (new)`;
                    log.push({ type: 'product', sku: varSku, handle,
                      status: oldVal ? 'overwrite' : 'synced', message: msg, productCode: mf.value, variantCode: '' });
                  } else {
                    const msg = oldVal
                      ? `Overwrote custom.variant_code: "${oldVal}" → "${mf.value}" on variant ${varSku} in "${title}"`
                      : `Set custom.variant_code = "${mf.value}" on variant ${varSku} in "${title}" (new)`;
                    log.push({ type: 'variant', sku: varSku, handle,
                      status: oldVal ? 'overwrite' : 'synced', message: msg, productCode: '', variantCode: mf.value });
                  }
                  synced++;
                  if (oldVal) overwriteCount++; else newCount++;
                }
              }
            }
            await sleep(180);
          }

          productCodeWritten.add(pid);
        }
      } catch (err) {
        const msg = err.response?.data?.errors || err.message;
        console.error(`  ✗ [${handle}] Error: ${String(msg)}`);
        log.push({ type: 'product', sku: variants[0]?.sku || '-', handle,
          status: 'error', message: String(msg) });
        failed++;
      }

      processed++;
      send({ type: 'progress', phase: 'write', processed, totalProducts, synced, newCount, overwriteCount, skipped, failed });

      if (processed % 50 === 0 || processed === totalProducts) {
        console.log(`  … write ${processed}/${totalProducts} products — synced: ${synced}, skipped: ${skipped}, failed: ${failed}`);
      }

      if (dryRun) await sleep(30);
    }
  } catch (outerErr) {
    console.error(`  ✗ Write phase error at product ${processed}/${totalProducts}:`, outerErr.message);
    send({ type: 'done', success: false, error: `Write error at product ${processed}/${totalProducts}: ${outerErr.message}`,
      dryRun, synced, newCount, overwriteCount, skipped, failed, total: totalCfsSkus, log });
    endStream();
    return;
  }

  console.log(`  ✓ Done — synced: ${synced} (new: ${newCount}, overwrites: ${overwriteCount}), skipped: ${skipped}, failed: ${failed}`);
  send({ type: 'done', success: true, dryRun, synced, newCount, overwriteCount, skipped, failed, total: totalCfsSkus, log });
  endStream();
});


// ── GET /api/shopify/test-connection ──────────────────────────────────────────
router.get('/test-connection', async (req, res) => {
  try {
    const client = graphqlClient();
    const data   = await gql(client, `{ shop { name myshopifyDomain } }`);
    res.json({ success: true, shop: data.shop.name, domain: data.shop.myshopifyDomain });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;