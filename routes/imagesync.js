/**
 * Image Sync (Step 7) — CFS gallery images → Urban Deco Shopify products.
 *
 * Manual only. Not part of /scheduled-sync or the GitHub Actions job.
 *
 * Flow:  Dry run  →  Backup zip (download + verify)  →  Apply  →  (Restore)  →  Clean-up
 *
 * Endpoints (mounted at /api/images):
 *   GET  /status                       connection + access-scope check
 *   POST /dry-run            (SSE)     build read-only plan
 *   GET  /plan/:id                     plan JSON
 *   POST /plan/:id/choices             featured / detach / include choices → re-plan one product
 *   GET  /plan/:id/csv                 preview as CSV
 *   POST /backup             (SSE)     build backup zip for selected products
 *   GET  /backup/:id/download          download the zip
 *   POST /backup/:id/confirm           browser sends sha256 of what it downloaded
 *   POST /apply              (SSE)     apply plan (needs confirmed backup)
 *   POST /pause                        pause a running apply/restore after the current product
 *   GET  /jobs/:id                     job progress
 *   POST /restore/upload               upload a backup zip
 *   POST /restore            (SSE)     restore products from an uploaded zip
 *   POST /cleanup/scan       (SSE)     list detached photos older than 7 days
 *   POST /cleanup/delete               permanently delete selected detached photos
 *
 * Needs Shopify scopes: read_products, write_products, read_files, write_files
 */

const express  = require('express');
const axios    = require('axios');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const multer   = require('multer');
const archiver = require('archiver');
const yauzl    = require('yauzl');
const sharp    = require('sharp');
require('dotenv').config();

const core = require('../utils/imageSyncCore');

const router = express.Router();

// ── Settings ─────────────────────────────────────────────────────────────────
const FEED_URL        = 'https://www.choicefurnituresuperstore.co.uk/cronItemGalleryUrls_Json.php';
const FEED_TTL_MS     = 30 * 60 * 1000;
const MF_NAMESPACE    = 'ud_image_sync';
const MF_KEY          = 'record';
const DETACH_KEEP_DAYS = 7;
const DOWNLOAD_CONCURRENCY = 6;
const MAX_BATCH       = 100;
const PAGE_SIZE       = 10;   // products per Shopify page (media + variants are heavy)

const ROOT        = path.join(__dirname, '../uploads/image-sync');
const DIRS = {
  plans:   path.join(ROOT, 'plans'),
  backups: path.join(ROOT, 'backups'),
  jobs:    path.join(ROOT, 'jobs'),
  restore: path.join(ROOT, 'restore'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

// ── Small helpers ────────────────────────────────────────────────────────────
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const newId  = p => `${p}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const safeId = id => /^[a-z]+-\d{14}-[0-9a-f]{6}$/.test(String(id || ''));
const numId  = gid => String(gid || '').split('/').pop();

function writeJson(file, obj) { fs.writeFileSync(file, JSON.stringify(obj)); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

// ── Keep Render awake during long jobs ───────────────────────────────────────
// Render's free plan sleeps after ~15 min without incoming requests. While any
// image-sync job runs we ping our own public /health URL every 4 minutes
// (same idea as the scheduled sync, which uses RENDER_EXTERNAL_URL).
// The job also keeps running on the server if the browser tab is closed.
let awakeJobs = 0;
let awakeTimer = null;
const AWAKE_EVERY_MS = 4 * 60 * 1000;
function selfPingUrl() {
  const base = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
  return base ? `${base.replace(/\/$/, '')}/health` : null;
}
function startKeepAwake() {
  awakeJobs++;
  if (awakeTimer || !selfPingUrl()) return;
  awakeTimer = setInterval(() => {
    axios.get(selfPingUrl(), { timeout: 20000 }).catch(e => console.warn('  ⚠ keep-awake ping failed:', e.message));
  }, AWAKE_EVERY_MS);
  console.log('  ☕ Image sync: keep-awake on');
}
function stopKeepAwake() {
  awakeJobs = Math.max(0, awakeJobs - 1);
  if (awakeJobs === 0 && awakeTimer) { clearInterval(awakeTimer); awakeTimer = null; console.log('  ☕ Image sync: keep-awake off'); }
}

function openSse(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.socket) res.socket.setNoDelay(true);
  res.flushHeaders();
  // SSE keepalive comment every 15s (same as the other steps) so the connection isn't dropped
  const keepalive = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
  startKeepAwake();
  let ended = false;
  return {
    // If the browser disconnects, writes are ignored and the job carries on.
    send: obj => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); },
    end:  () => { if (ended) return; ended = true; clearInterval(keepalive); stopKeepAwake(); if (!res.writableEnded) res.end(); },
  };
}

// ── Shopify GraphQL ──────────────────────────────────────────────────────────
function graphqlClient() {
  const store   = process.env.SHOPIFY_STORE;
  const token   = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_API_TOKEN;
  const version = process.env.SHOPIFY_API_VERSION || '2026-07';
  if (!store || !token) throw new Error('Not connected to Shopify. Please click "Connect to Shopify" first.');
  return {
    url: `https://${store}/admin/api/${version}/graphql.json`,
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  };
}

async function gql(client, query, variables = {}, attempt = 1) {
  try {
    const res = await axios.post(client.url, { query, variables }, { headers: client.headers, timeout: 60000 });
    if (res.data.errors) {
      const throttled = res.data.errors.some(e => e.extensions?.code === 'THROTTLED');
      if (throttled && attempt <= 6) { await sleep(1500 * attempt); return gql(client, query, variables, attempt + 1); }
      throw new Error(`GraphQL error: ${res.data.errors.map(e => e.message).join('; ')}`);
    }
    return res.data.data;
  } catch (err) {
    const status = err.response?.status;
    const net = !err.response && /ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNABORTED|socket hang up|timeout/i.test(`${err.code} ${err.message}`);
    if ((status === 429 || (status >= 500 && status < 600) || net) && attempt <= 4) {
      await sleep(2000 * attempt);
      return gql(client, query, variables, attempt + 1);
    }
    throw err;
  }
}

function userErrorsOf(payload) {
  return [...(payload?.userErrors || []), ...(payload?.mediaUserErrors || [])];
}
function assertNoUserErrors(payload, what) {
  const errs = userErrorsOf(payload);
  if (errs.length) throw new Error(`${what}: ${errs.map(e => e.message).join('; ')}`);
}

const PRODUCT_FIELDS = `
  id handle title status vendor updatedAt
  featuredMedia { id }
  options { name position values }
  media(first: 250) { nodes {
    id alt mediaContentType status
    ... on MediaImage { image { url width height } originalSource { url fileSize } }
  } }
  variants(first: 250) { nodes {
    id sku title position selectedOptions { name value }
    media(first: 5) { nodes { id } }
  } }
  metafield(namespace: "${MF_NAMESPACE}", key: "${MF_KEY}") { id value }
`;

const Q_PRODUCTS = `query P($first:Int!,$after:String,$query:String){
  products(first:$first, after:$after, query:$query){ pageInfo{hasNextPage endCursor} nodes{ ${PRODUCT_FIELDS} } } }`;
const Q_PRODUCT = `query P($id:ID!){ product(id:$id){ ${PRODUCT_FIELDS} } }`;
const Q_PRODUCT_BY_HANDLE = `query P($h:String!){ productByHandle(handle:$h){ ${PRODUCT_FIELDS} } }`;
const Q_VARIANT_PRODUCTS = `query V($q:String!){ productVariants(first:50, query:$q){ nodes{ product{ id } } } }`;
const Q_SCOPES = `query { currentAppInstallation { accessScopes { handle } } }`;
const Q_NODES_MEDIA = `query S($ids:[ID!]!){ nodes(ids:$ids){ ... on MediaImage{ id status fileStatus alt createdAt image{url} mediaErrors{ code message } } } }`;
const Q_JOB = `query J($id:ID!){ job(id:$id){ id done } }`;
const Q_RECORDS_PAGE = `query R($first:Int!,$after:String){ products(first:$first, after:$after){ pageInfo{hasNextPage endCursor}
  nodes{ id handle title metafield(namespace:"${MF_NAMESPACE}", key:"${MF_KEY}"){ id value } } } }`;

const M_FILE_CREATE = `mutation FC($files:[FileCreateInput!]!){ fileCreate(files:$files){
  files{ id fileStatus alt ... on MediaImage{ status image{url} } } userErrors{ field message code } } }`;
const M_FILE_UPDATE = `mutation F($files:[FileUpdateInput!]!){ fileUpdate(files:$files){
  files{ id alt fileStatus } userErrors{ field message code } } }`;
const M_FILE_DELETE = `mutation X($fileIds:[ID!]!){ fileDelete(fileIds:$fileIds){ deletedFileIds userErrors{ field message code } } }`;
const M_REORDER = `mutation R($id:ID!,$moves:[MoveInput!]!){ productReorderMedia(id:$id, moves:$moves){
  job{ id done } mediaUserErrors{ field message code } } }`;
const M_VARIANT_APPEND = `mutation A($productId:ID!,$variantMedia:[ProductVariantAppendMediaInput!]!){
  productVariantAppendMedia(productId:$productId, variantMedia:$variantMedia){ productVariants{ id } userErrors{ field message code } } }`;
const M_VARIANT_DETACH = `mutation D($productId:ID!,$variantMedia:[ProductVariantDetachMediaInput!]!){
  productVariantDetachMedia(productId:$productId, variantMedia:$variantMedia){ productVariants{ id } userErrors{ field message code } } }`;
const M_METAFIELDS_SET = `mutation M($metafields:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$metafields){
  metafields{ id } userErrors{ field message code } } }`;
const M_STAGED = `mutation U($input:[StagedUploadInput!]!){ stagedUploadsCreate(input:$input){
  stagedTargets{ url resourceUrl parameters{ name value } } userErrors{ field message } } }`;

async function fetchProduct(client, id) {
  const d = await gql(client, Q_PRODUCT, { id });
  return d.product;
}

function parseRecord(product) {
  try { return product?.metafield?.value ? JSON.parse(product.metafield.value) : null; }
  catch (_) { return null; }
}

async function saveRecord(client, productId, record) {
  record.v = 1;
  record.updatedAt = new Date().toISOString();
  const d = await gql(client, M_METAFIELDS_SET, { metafields: [{
    ownerId: productId, namespace: MF_NAMESPACE, key: MF_KEY, type: 'json', value: JSON.stringify(record) }] });
  assertNoUserErrors(d.metafieldsSet, 'Saving image record');
}

// Snapshot = the parts of a product we promise to put back on restore.
function snapshotOf(product) {
  return {
    mediaIds: (product.media?.nodes || []).map(m => m.id),
    alts: Object.fromEntries((product.media?.nodes || []).map(m => [m.id, m.alt || ''])),
    featured: product.featuredMedia?.id || null,
    variantMedia: Object.fromEntries((product.variants?.nodes || []).map(v => [v.id, (v.media?.nodes || []).map(n => n.id)])),
  };
}
function sameSnapshot(a, b) {
  return JSON.stringify([a.mediaIds, a.featured, a.variantMedia]) === JSON.stringify([b.mediaIds, b.featured, b.variantMedia]);
}

// ── CFS feed (cached) ────────────────────────────────────────────────────────
let feedCache = null; // { at, generated, byId: Map }
async function getFeed(force = false) {
  if (!force && feedCache && Date.now() - feedCache.at < FEED_TTL_MS) return feedCache;
  const res = await axios.get(FEED_URL, { timeout: 240000, maxContentLength: 200 * 1024 * 1024 });
  const products = res.data?.products;
  if (!Array.isArray(products) || products.length === 0) {
    // Never treat an empty / broken feed as "no images" — stop instead.
    throw new Error('CFS image feed returned no products — stopping (nothing was changed)');
  }
  const byId = new Map(products.map(p => [String(p.iProductId), p]));
  feedCache = { at: Date.now(), generated: res.data.generated || null, total: products.length, byId };
  return feedCache;
}

// ── Image download + fingerprint ─────────────────────────────────────────────
async function downloadImage(url, attempt = 1) {
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: 50 * 1024 * 1024 });
    const buf = Buffer.from(res.data);
    if (!buf.length) throw new Error('empty file');
    const type = String(res.headers['content-type'] || '');
    if (type && !/^image\//i.test(type) && !/octet-stream/i.test(type)) throw new Error(`not an image (${type})`);
    return { buf, sha: sha256(buf), bytes: buf.length, type, ...(await visualFingerprint(buf)) };
  } catch (err) {
    const status = err.response?.status;
    if (attempt < 3 && status !== 404 && status !== 403) { await sleep(1000 * attempt); return downloadImage(url, attempt + 1); }
    throw new Error(status ? `HTTP ${status}` : err.message);
  }
}

// Visual fingerprint used to tell "same picture, re-saved" from "different picture".
//   thumb = 32x32 colour thumbnail (base64 of raw RGB) — survives re-saving, resizing and format changes
//   w/h   = size (for the shape: portrait vs landscape)
// Returns {} if the file can't be decoded — the comparison then falls back to file name only.
async function visualFingerprint(buf) {
  try {
    const meta = await sharp(buf, { failOn: 'none' }).metadata();
    const raw = await sharp(buf, { failOn: 'none' }).rotate().flatten({ background: '#ffffff' })
      .resize(32, 32, { fit: 'fill', kernel: 'cubic' }).removeAlpha().raw().toBuffer();
    const rotated = (meta.orientation || 1) >= 5;
    return { thumb: raw.toString('base64'), edgeWhite: await edgeWhiteness(buf),
      w: rotated ? meta.height : meta.width, h: rotated ? meta.width : meta.height };
  } catch (_) { return {}; }
}

// Share of the photo's border (2px ring of a 64x64 copy, averaged over the 4 sides) that is
// plain white: near-white (all channels >= 235) and not coloured (channel spread <= 18).
// Cut-outs on white measure ~0.95–1.0; room photos and close-ups ~0–0.15 (checked on real CFS photos).
async function edgeWhiteness(buf) {
  try {
    const N = 64;
    const px = await sharp(buf, { failOn: 'none' }).rotate().flatten({ background: '#ffffff' })
      .resize(N, N, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    const white = (x, y) => { const i = (y * N + x) * 3; const mn = Math.min(px[i], px[i + 1], px[i + 2]), mx = Math.max(px[i], px[i + 1], px[i + 2]); return mn >= 235 && mx - mn <= 18; };
    const sides = [0, 0, 0, 0];
    for (let k = 0; k < N; k++) for (const t of [0, 1]) {
      sides[0] += white(k, t); sides[1] += white(k, N - 1 - t); sides[2] += white(t, k); sides[3] += white(N - 1 - t, k);
    }
    return +(sides.reduce((a, b) => a + b, 0) / (4 * 2 * N)).toFixed(3);
  } catch (_) { return null; }
}

// Shopify CDN can resize on the fly — a 600px copy is plenty for the visual check.
function shopifyThumb(url) { return url ? url + (url.includes('?') ? '&' : '?') + 'width=600' : url; }

async function hashUrls(urls, cache, onProgress, check) {
  const todo = [...new Set(urls)].filter(u => u && !cache.has(u));
  let done = 0;
  await mapLimit(todo, DOWNLOAD_CONCURRENCY, async u => {
    if (check) check();
    try { const r = await downloadImage(u); cache.set(u, { sha: r.sha, bytes: r.bytes, thumb: r.thumb, edgeWhite: r.edgeWhite, w: r.w, h: r.h }); }
    catch (e) { cache.set(u, { error: e.message }); }
    done++; if (onProgress && done % 10 === 0) onProgress(done, todo.length);
  });
}

async function fingerprintShopify(products, session, send, check) {
  const need = [];
  for (const p of products) for (const m of p.media?.nodes || []) {
    if (m.mediaContentType !== 'IMAGE' || session.shopHash[m.id]) continue;
    const url = m.image?.url || m.originalSource?.url; if (url) need.push([m.id, shopifyThumb(url)]);
  }
  if (!need.length) return;
  if (send) send({ type: 'status', message: `Checking ${need.length} current Shopify photos by picture…` });
  const tmp = new Map();
  await hashUrls(need.map(x => x[1]), tmp, send ? (d, t) => send({ type: 'progress', phase: 'shopify-images', done: d, total: t }) : null, check);
  for (const [mid, url] of need) {
    const h = tmp.get(url);
    if (h && !h.error) session.shopHash[mid] = { sha: h.sha, thumb: h.thumb, w: h.w, h: h.h };
  }
}

// ── Plans (dry runs) ─────────────────────────────────────────────────────────
const plans = new Map(); // id → plan session (RAM), also saved to disk
function loadPlan(id) {
  if (!safeId(id)) return null;
  if (plans.has(id)) return plans.get(id);
  const p = readJson(path.join(DIRS.plans, `${id}.json`));
  if (p) plans.set(id, p);
  return p;
}
function savePlan(p) { plans.set(p.id, p); writeJson(path.join(DIRS.plans, `${p.id}.json`), p); }

function planFor(session, productId, feed) {
  const raw = session.raw[productId];
  const cfsHash = new Map(Object.entries(session.cfsHash || {}));
  const shopHash = new Map(Object.entries(session.shopHash || {}));
  const plan = core.buildProductPlan({
    product: raw, feedById: feed.byId, cfsHash, shopHash,
    record: parseRecord(raw),
    // per-product choices; "Replace with CFS photos" falls back to the dry-run-wide setting
    choices: { replaceMode: !!session.replaceMode, skipWhiteBg: session.skipWhiteBg !== false,
      skipNonSquare: session.skipNonSquare !== false, ...(session.choices[productId] || {}) },
  });
  plan.include = session.include[productId] !== undefined ? session.include[productId] : (plan.ok && !plan.noChange);
  if (!plan.ok) plan.include = false;
  return plan;
}

async function resolveProducts(client, tokens, send) {
  const ids = new Set();
  const out = [];
  for (const t of tokens) {
    let found = [];
    try {
      if (/^gid:\/\/shopify\/Product\/\d+$/.test(t)) {
        const p = await fetchProduct(client, t); if (p) found = [p];
      } else if (/^(UD-)?\d+(-\d+)?$/i.test(t)) {
        const cfsId = t.replace(/^UD-/i, '').split('-')[0];
        const d = await gql(client, Q_VARIANT_PRODUCTS, { q: `sku:UD-${cfsId}*` });
        const pids = [...new Set((d.productVariants?.nodes || []).map(n => n.product.id))];
        for (const pid of pids) { const p = await fetchProduct(client, pid); if (p) found.push(p); }
      } else {
        const d = await gql(client, Q_PRODUCT_BY_HANDLE, { h: t });
        if (d.productByHandle) found = [d.productByHandle];
      }
    } catch (e) { send({ type: 'warn', message: `Could not look up "${t}": ${e.message}` }); }
    if (!found.length) send({ type: 'warn', message: `Nothing found for "${t}"` });
    for (const p of found) if (!ids.has(p.id)) { ids.add(p.id); out.push(p); }
  }
  return out;
}

// ── Stop / pause ─────────────────────────────────────────────────────────────
// Every long step sends { type: 'run', runId } first; the page's Stop button posts
// that id to /stop. Read-only steps (dry run, backup, clean-up scan) stop at once;
// apply/restore finish the product they are on, then stop (never half a product).
const stopRequests = new Set();
class StoppedError extends Error { constructor() { super('Stopped'); this.stopped = true; } }
function startRun(send, id = newId('run')) { send({ type: 'run', runId: id }); return id; }
const stopCheck = runId => () => { if (stopRequests.has(runId)) throw new StoppedError(); };
function endRun(runId) { setTimeout(() => stopRequests.delete(runId), 60000); }

// ── Jobs (apply / restore) ───────────────────────────────────────────────────
const pauseRequests = new Set();
let activeRun = null; // { kind, jobId } — only one write job at a time

function jobFile(id) { return path.join(DIRS.jobs, `${id}.json`); }
function saveJob(job) { job.updatedAt = new Date().toISOString(); writeJson(jobFile(job.id), job); }

// ════════════════════════════════════════════════════════════════════════════
// GET /thumb?u=<image url> — small preview images for the page.
// CFS blocks its photos from being shown on other websites, so the browser can't
// load them directly; the server fetches them and sends a 300px copy.
// Only CFS and Shopify image hosts are allowed (not an open proxy).
// ════════════════════════════════════════════════════════════════════════════
const THUMB_HOSTS = ['images.choicefurnituresuperstore.co.uk', 'www.choicefurnituresuperstore.co.uk', 'cdn.shopify.com'];
const thumbCache = new Map(); // url → Buffer (most recent 600)
router.get('/thumb', async (req, res) => {
  const u = String(req.query.u || '');
  let host;
  try { host = new URL(u).hostname; } catch (_) { return res.status(400).end(); }
  if (!THUMB_HOSTS.includes(host)) return res.status(403).end();
  try {
    let out = thumbCache.get(u);
    if (!out) {
      const r = await axios.get(u, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: 50 * 1024 * 1024 });
      out = await sharp(Buffer.from(r.data), { failOn: 'none' }).rotate().resize(300, 300, { fit: 'inside' }).jpeg({ quality: 75 }).toBuffer();
      thumbCache.set(u, out);
      if (thumbCache.size > 600) thumbCache.delete(thumbCache.keys().next().value);
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(out);
  } catch (e) {
    res.status(502).end();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /status
// ════════════════════════════════════════════════════════════════════════════
router.get('/status', async (req, res) => {
  try {
    const client = graphqlClient();
    const d = await gql(client, Q_SCOPES);
    const scopes = (d.currentAppInstallation?.accessScopes || []).map(s => s.handle);
    const need = ['read_products', 'write_products', 'read_files', 'write_files'];
    const keepAwake = !!selfPingUrl();
  const missing = need.filter(s => !scopes.includes(s) && !(s.startsWith('read_') && scopes.includes(s.replace('read_', 'write_'))));
    res.json({ connected: true, scopes, missing, activeRun, keepAwake, feedCachedAt: feedCache?.at || null });
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /dry-run   body: { tokens?: string[], limit?, after?, includeDrafts? }
// ════════════════════════════════════════════════════════════════════════════
router.post('/dry-run', async (req, res) => {
  let client;
  try { client = graphqlClient(); } catch (e) { return res.status(400).json({ error: e.message }); }
  const sse = openSse(res);
  const { send } = sse;
  const runId = startRun(send);
  const check = stopCheck(runId);
  try {
    const tokens = (req.body?.tokens || []).map(s => String(s).trim()).filter(Boolean);
    const limit = Math.max(1, Math.min(MAX_BATCH, parseInt(req.body?.limit, 10) || 25));
    const includeDrafts = !!req.body?.includeDrafts;

    send({ type: 'status', message: 'Loading CFS image feed (can take ~90 seconds)…' });
    const feed = await getFeed(!!req.body?.refreshFeed);
    send({ type: 'status', message: `CFS feed: ${feed.total} products (generated ${feed.generated})` });

    // 1. Which products?
    let products = [];
    let nextCursor = null;
    if (tokens.length) {
      send({ type: 'status', message: `Looking up ${tokens.length} product reference(s)…` });
      products = await resolveProducts(client, tokens, send);
    } else {
      const q = `vendor:"Urban Deco"${includeDrafts ? '' : ' status:active'}`;
      let after = req.body?.after || null;
      while (products.length < limit) {
        check();
        const d = await gql(client, Q_PRODUCTS, { first: Math.min(PAGE_SIZE, limit - products.length), after, query: q });
        const page = d.products;
        // exact vendor match (search can be loose)
        products.push(...page.nodes.filter(p => p.vendor === 'Urban Deco'));
        send({ type: 'status', message: `Fetched ${products.length} Shopify products…` });
        if (!page.pageInfo.hasNextPage) { after = null; break; }
        after = page.pageInfo.endCursor;
      }
      nextCursor = after;
    }
    if (!products.length) throw new Error('No products to check');

    // 2. Download + fingerprint every CFS image those products need
    const cfsUrls = [];
    for (const p of products) {
      for (const v of p.variants?.nodes || []) {
        const parsed = core.parseUdSku(v.sku); if (!parsed) continue;
        const rec = feed.byId.get(parsed.cfsId); if (!rec) continue;
        cfsUrls.push(rec.mainImage, ...(rec.galleryImages || []));
      }
    }
    const cfsHash = new Map();
    send({ type: 'status', message: `Checking ${new Set(cfsUrls).size} CFS images…` });
    await hashUrls(cfsUrls, cfsHash, (d, t) => send({ type: 'progress', phase: 'cfs-images', done: d, total: t }), check);

    // 3. Session + Shopify photo fingerprints
    const session = {
      id: newId('plan'), createdAt: new Date().toISOString(), feedGenerated: feed.generated,
      nextCursor, raw: {}, choices: {}, include: {}, replaceMode: !!req.body?.replaceMode,
      skipWhiteBg: req.body?.skipWhiteBg !== false, skipNonSquare: req.body?.skipNonSquare !== false,
      cfsHash: Object.fromEntries(cfsHash), shopHash: {},
    };
    for (const p of products) session.raw[p.id] = p;

    // Fingerprint every current Shopify photo so name matches can be checked by picture
    await fingerprintShopify(products, session, send, check);

    // 4. Final plans
    const out = products.map(p => planFor(session, p.id, feed));
    savePlan(session);
    const summary = summarise(out);
    send({ type: 'done', planId: session.id, nextCursor, replaceMode: session.replaceMode,
      skipWhiteBg: session.skipWhiteBg, skipNonSquare: session.skipNonSquare, summary, plans: out });
  } catch (e) {
    if (e.stopped) send({ type: 'stopped', message: 'Dry run stopped — nothing was changed' });
    else send({ type: 'error', message: e.message });
  }
  endRun(runId);
  sse.end();
});

function summarise(planList) {
  const s = { products: planList.length, ready: 0, noChange: 0, skipped: 0, notInCfs: 0, uploads: 0, reuse: 0, excluded: 0, detach: 0, manual: 0, review: 0 };
  for (const p of planList) {
    if (!p.ok) s.skipped++; else if (p.noChange) s.noChange++; else s.ready++;
    if (p.notInCfs) s.notInCfs++;
    s.uploads += p.counts.upload; s.reuse += p.counts.reuse; s.excluded += p.counts.excluded;
    s.detach += p.counts.detach; s.manual += p.counts.manual; s.review += p.counts.review;
  }
  return s;
}

// ════════════════════════════════════════════════════════════════════════════
// Plan read / choices / CSV
// ════════════════════════════════════════════════════════════════════════════
router.get('/plan/:id', async (req, res) => {
  const s = loadPlan(req.params.id);
  if (!s) return res.status(404).json({ error: 'Dry run not found (server may have restarted) — run it again' });
  try {
    const feed = await getFeed();
    const out = Object.keys(s.raw).map(pid => planFor(s, pid, feed));
    res.json({ planId: s.id, nextCursor: s.nextCursor, summary: summarise(out), plans: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// body: { productId, include?, featured?, detach?: { mediaId: bool } }
router.post('/plan/:id/choices', async (req, res) => {
  const s = loadPlan(req.params.id);
  if (!s) return res.status(404).json({ error: 'Dry run not found — run it again' });
  const { productId, include, featured, detach, reuseUnsure, replaceMode } = req.body || {};
  if (!s.raw[productId]) return res.status(400).json({ error: 'Product is not in this dry run' });
  const c = s.choices[productId] || {};
  if (featured !== undefined) c.featured = featured || undefined;
  if (detach) c.detach = { ...(c.detach || {}), ...detach };
  if (reuseUnsure) c.reuseUnsure = { ...(c.reuseUnsure || {}), ...reuseUnsure };
  if (replaceMode !== undefined) { c.replaceMode = !!replaceMode; delete c.detach; }   // switching mode resets single-photo ticks
  s.choices[productId] = c;
  if (include !== undefined) s.include[productId] = !!include;
  savePlan(s);
  try { res.json({ plan: planFor(s, productId, await getFeed()) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Change dry-run-wide options without re-running: { replaceMode?, skipWhiteBg?, skipNonSquare? }
// (old route /replace-mode {on} kept working). Per-product overrides for changed options are cleared.
router.post(['/plan/:id/options', '/plan/:id/replace-mode'], async (req, res) => {
  const s = loadPlan(req.params.id);
  if (!s) return res.status(404).json({ error: 'Dry run not found — run it again' });
  const b = req.body || {};
  if (b.on !== undefined) b.replaceMode = b.on;
  for (const k of ['replaceMode', 'skipWhiteBg', 'skipNonSquare']) {
    if (b[k] === undefined) continue;
    s[k] = !!b[k];
    for (const c of Object.values(s.choices)) { delete c[k]; delete c.detach; }
  }
  savePlan(s);
  try {
    const feed = await getFeed();
    const out = Object.keys(s.raw).map(pid => planFor(s, pid, feed));
    res.json({ planId: s.id, replaceMode: !!s.replaceMode, skipWhiteBg: s.skipWhiteBg !== false, skipNonSquare: s.skipNonSquare !== false,
      summary: summarise(out), plans: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/plan/:id/csv', async (req, res) => {
  const s = loadPlan(req.params.id);
  if (!s) return res.status(404).send('Dry run not found');
  const feed = await getFeed();
  let out = Object.keys(s.raw).map(pid => planFor(s, pid, feed));
  const onlySelected = req.query.only === 'selected';
  if (onlySelected) out = out.filter(p => p.include && p.ok && !p.noChange);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="image-sync-${onlySelected ? 'to-apply' : 'dry-run'}_${s.id}.csv"`);
  res.send(core.plansToCsv(out));
});

// ════════════════════════════════════════════════════════════════════════════
// POST /backup   body: { planId, productIds }
// ════════════════════════════════════════════════════════════════════════════
router.post('/backup', async (req, res) => {
  let client;
  try { client = graphqlClient(); } catch (e) { return res.status(400).json({ error: e.message }); }
  const sse = openSse(res);
  const { send } = sse;
  const backupId = newId('backup');
  const zipPath = path.join(DIRS.backups, `${backupId}.zip`);
  const runId = startRun(send);
  const check = stopCheck(runId);
  let archive = null;
  try {
    const s = loadPlan(req.body?.planId);
    if (!s) throw new Error('Dry run not found — run it again');
    const productIds = (req.body?.productIds || []).filter(id => s.raw[id]);
    if (!productIds.length) throw new Error('No products selected');
    if (productIds.length > MAX_BATCH) throw new Error(`Max ${MAX_BATCH} products per batch`);

    const output = fs.createWriteStream(zipPath);
    archive = archiver('zip', { zlib: { level: 0 } }); // photos are already compressed
    const closed = new Promise((resolve, reject) => { output.on('close', resolve); archive.on('error', reject); output.on('error', reject); });
    archive.pipe(output);

    const manifest = { type: 'urban-deco-image-backup', version: 1, backupId, createdAt: new Date().toISOString(),
      store: process.env.SHOPIFY_STORE, planId: s.id, products: [] };
    let n = 0;
    for (const pid of productIds) {
      n++;
      const p = await fetchProduct(client, pid);
      if (!p) { send({ type: 'warn', message: `Product ${pid} no longer exists — skipped` }); continue; }
      // Short paths inside the zip (Windows can't extract paths over ~260 characters).
      // The real handle and original file names are kept in manifest.json.
      const folder = `p${String(manifest.products.length + 1).padStart(3, '0')}-${numId(p.id)}`;
      const media = [];
      const nodes = p.media?.nodes || [];
      for (let i = 0; i < nodes.length; i++) {
        check();
        const m = nodes[i];
        const entry = { id: m.id, position: i + 1, alt: m.alt || '', type: m.mediaContentType,
          url: m.image?.url || m.originalSource?.url || null };
        if (m.mediaContentType === 'IMAGE' && entry.url) {
          const dl = await downloadImage(m.originalSource?.url || entry.url).catch(() => null)
                  || await downloadImage(entry.url); // throws if both fail → whole backup fails
          const original = core.fileNameFromUrl(entry.url);
          const ext = (path.extname(original).toLowerCase().match(/^\.(jpe?g|png|webp|gif)$/) || ['.jpg'])[0];
          entry.file = `${folder}/${String(i + 1).padStart(2, '0')}${ext}`;
          entry.originalName = original;
          entry.sha256 = dl.sha; entry.bytes = dl.bytes; entry.mimeType = dl.type || 'image/jpeg';
          archive.append(dl.buf, { name: entry.file });
        }
        media.push(entry);
      }
      manifest.products.push({
        productId: p.id, handle: p.handle, title: p.title, updatedAt: p.updatedAt,
        featuredMediaId: p.featuredMedia?.id || null,
        media,
        variants: (p.variants?.nodes || []).map(v => ({ id: v.id, sku: v.sku, title: v.title, mediaIds: (v.media?.nodes || []).map(x => x.id) })),
        snapshot: snapshotOf(p),
        record: parseRecord(p),
      });
      send({ type: 'progress', done: n, total: productIds.length, message: `Backed up ${p.handle} (${media.length} photos)` });
    }
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    archive.append(
      `Urban Deco image backup ${backupId}\nCreated ${manifest.createdAt}\nProducts: ${manifest.products.length}\n\n` +
      `Keep this zip for at least 30 days.\nTo restore: Image Sync page → Restore → upload this zip (no need to extract it).\n\n` +
      `Folders:\n` + manifest.products.map((p, i) => `  p${String(i + 1).padStart(3, '0')}-${numId(p.productId)}  =  ${p.handle}`).join('\n') + '\n',
      { name: 'README.txt' });
    await archive.finalize();
    await closed;

    // Verify: read the zip back and check every photo against the manifest.
    send({ type: 'status', message: 'Verifying backup zip…' });
    const verify = await verifyZip(zipPath);
    if (!verify.ok) throw new Error(`Backup verification failed: ${verify.error}`);
    const zipSha = await fileSha(zipPath);
    const bytes = fs.statSync(zipPath).size;
    const meta = { id: backupId, createdAt: manifest.createdAt, planId: s.id, zipSha, bytes, confirmed: false,
      products: manifest.products.map(p => ({ productId: p.productId, handle: p.handle, snapshot: p.snapshot })) };
    writeJson(path.join(DIRS.backups, `${backupId}.json`), meta);
    send({ type: 'done', backupId, bytes, zipSha, products: meta.products.length, photos: verify.photos });
  } catch (e) {
    if (archive) { try { archive.abort(); } catch (_) {} }
    try { fs.unlinkSync(zipPath); } catch (_) {}
    if (e.stopped) send({ type: 'stopped', message: 'Backup stopped — no zip was made and nothing was changed' });
    else send({ type: 'error', message: e.message });
  }
  endRun(runId);
  sse.end();
});

function fileSha(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

// Read a zip: returns { names: string[], read(name) → Promise<Buffer>, close() }
function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) return reject(err);
      const entries = new Map();
      zip.on('entry', e => { entries.set(e.fileName, e); zip.readEntry(); });
      zip.on('end', () => resolve({
        names: [...entries.keys()],
        read: name => new Promise((res2, rej2) => {
          const e = entries.get(name); if (!e) return rej2(new Error(`${name} missing from zip`));
          zip.openReadStream(e, (er, stream) => {
            if (er) return rej2(er);
            const chunks = []; stream.on('data', c => chunks.push(c)); stream.on('end', () => res2(Buffer.concat(chunks))); stream.on('error', rej2);
          });
        }),
        close: () => zip.close(),
      }));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

async function verifyZip(file) {
  let z;
  try {
    z = await openZip(file);
    const manifest = JSON.parse((await z.read('manifest.json')).toString('utf8'));
    if (manifest.type !== 'urban-deco-image-backup') return { ok: false, error: 'not an Urban Deco image backup' };
    let photos = 0;
    for (const p of manifest.products) for (const m of p.media) {
      if (!m.file) continue;
      const buf = await z.read(m.file);
      if (sha256(buf) !== m.sha256) return { ok: false, error: `${m.file} is damaged` };
      photos++;
    }
    return { ok: true, manifest, photos };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { if (z) z.close(); }
}

router.get('/backup/:id/download', (req, res) => {
  if (!safeId(req.params.id)) return res.status(400).send('Bad id');
  const f = path.join(DIRS.backups, `${req.params.id}.zip`);
  if (!fs.existsSync(f)) return res.status(404).send('Backup zip not found on server (it may have restarted) — create it again');
  const date = new Date().toISOString().slice(0, 10);
  res.download(f, `ud-images_${date}_${req.params.id.slice(-6)}.zip`);
});

router.post('/backup/:id/confirm', (req, res) => {
  if (!safeId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const metaFile = path.join(DIRS.backups, `${req.params.id}.json`);
  const meta = readJson(metaFile);
  if (!meta) return res.status(404).json({ error: 'Backup not found' });
  if (String(req.body?.sha256 || '').toLowerCase() !== meta.zipSha) {
    return res.status(400).json({ error: 'The downloaded file does not match the backup — download it again' });
  }
  meta.confirmed = true; meta.confirmedAt = new Date().toISOString();
  writeJson(metaFile, meta);
  res.json({ ok: true, backupId: meta.id });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /pause  body: { jobId }
// ════════════════════════════════════════════════════════════════════════════
router.post('/pause', (req, res) => {
  const id = req.body?.jobId || activeRun?.jobId;
  if (id) pauseRequests.add(id);
  res.json({ ok: true, jobId: id || null });
});

// POST /stop  body: { runId } — works for every step
router.post('/stop', (req, res) => {
  const id = String(req.body?.runId || '');
  if (!id) return res.status(400).json({ error: 'runId missing' });
  stopRequests.add(id);
  pauseRequests.add(id);            // apply/restore: runId is the job id
  res.json({ ok: true, runId: id });
});

router.get('/jobs/:id/csv', (req, res) => {
  if (!safeId(req.params.id)) return res.status(400).send('Bad id');
  const j = readJson(jobFile(req.params.id));
  if (!j) return res.status(404).send('Job not found (server may have restarted)');
  const rows = [['job', 'kind', 'product_id', 'handle', 'result', 'reason', 'photos_before', 'photos_after', 'uploaded', 'reused',
    'excluded_cfsud', 'detached', 'alt_fixed', 'variant_photos_changed', 'steps']];
  for (const [pid, p] of Object.entries(j.products)) {
    const c = p.counts || {};
    rows.push([j.id, j.kind, pid, p.handle, p.state, p.reason || p.error || '', c.current ?? '', c.proposed ?? '', c.upload ?? '', c.reuse ?? '',
      c.excluded ?? '', c.detach ?? p.detached ?? '', c.altFix ?? '', c.variantChanges ?? '', (p.log || []).join(' | ')]);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="image-sync-results_${j.id}.csv"`);
  res.send(core.toCsv(rows));
});

router.get('/jobs/:id', (req, res) => {
  if (!safeId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const j = readJson(jobFile(req.params.id));
  if (!j) return res.status(404).json({ error: 'Job not found' });
  res.json(j);
});

// ════════════════════════════════════════════════════════════════════════════
// POST /apply   body: { planId, backupId, productIds, jobId? (resume) }
// ════════════════════════════════════════════════════════════════════════════
router.post('/apply', async (req, res) => {
  let client;
  try { client = graphqlClient(); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (activeRun) return res.status(409).json({ error: `Another ${activeRun.kind} is running (${activeRun.jobId})` });
  const sse = openSse(res);
  const { send } = sse;
  let job;
  try {
    const s = loadPlan(req.body?.planId);
    if (!s) throw new Error('Dry run not found — run it again');
    const meta = readJson(path.join(DIRS.backups, `${req.body?.backupId}.json`));
    if (!meta || !safeId(req.body?.backupId)) throw new Error('Backup not found — create and download the backup first');
    if (!meta.confirmed) throw new Error('Backup has not been confirmed as downloaded — download it first');
    const inBackup = new Map(meta.products.map(p => [p.productId, p]));
    const productIds = (req.body?.productIds || []).filter(id => s.raw[id]);
    const notBacked = productIds.filter(id => !inBackup.has(id));
    if (notBacked.length) throw new Error(`${notBacked.length} selected product(s) are not in this backup`);
    if (!productIds.length) throw new Error('No products selected');

    // Resume or new job
    if (req.body?.jobId && safeId(req.body.jobId)) {
      job = readJson(jobFile(req.body.jobId));
      if (!job) throw new Error('Job to resume not found');
      job.status = 'running';
    } else {
      job = { id: newId('job'), kind: 'apply', planId: s.id, backupId: meta.id, createdAt: new Date().toISOString(),
        status: 'running', products: Object.fromEntries(productIds.map(id => [id, { handle: s.raw[id].handle, state: 'waiting' }])) };
    }
    stopRequests.delete(job.id); pauseRequests.delete(job.id);
    activeRun = { kind: 'apply', jobId: job.id };
    saveJob(job);
    send({ type: 'job', jobId: job.id });
    startRun(send, job.id);

    send({ type: 'status', message: 'Loading CFS image feed…' });
    const feed = await getFeed(); // throws on empty/failed feed → nothing touched

    let i = 0;
    for (const pid of Object.keys(job.products)) {
      i++;
      const jp = job.products[pid];
      if (jp.state === 'done' || jp.state === 'skipped') continue;
      if (pauseRequests.has(job.id)) { job.status = 'paused'; break; }
      send({ type: 'progress', done: i - 1, total: Object.keys(job.products).length, message: `Working on ${jp.handle}…` });
      delete jp.error; delete jp.reason;   // clear results from an earlier failed attempt
      try {
        const result = await applyOne({ client, session: s, feed, pid, job, backup: inBackup.get(pid), send });
        Object.assign(jp, result);
      } catch (e) {
        jp.state = 'failed'; jp.error = e.message;
      }
      saveJob(job);
      send({ type: 'product', productId: pid, handle: jp.handle, ...jp });
    }
    if (job.status === 'running') job.status = 'finished';
    saveJob(job);
    const states = Object.values(job.products).reduce((a, p) => { a[p.state] = (a[p.state] || 0) + 1; return a; }, {});
    send({ type: 'done', jobId: job.id, status: job.status, states });
  } catch (e) {
    if (job) { job.status = 'stopped'; job.error = e.message; saveJob(job); }
    send({ type: 'error', message: e.message });
  } finally {
    if (job) pauseRequests.delete(job.id);
    activeRun = null;
  }
  sse.end();
});

async function waitForReady(client, ids, label) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const d = await gql(client, Q_NODES_MEDIA, { ids });
    const nodes = d.nodes || [];
    const failed = nodes.find(n => n && (n.status === 'FAILED' || n.fileStatus === 'FAILED'));
    if (failed) throw new Error(`${label}: Shopify could not process an image (${failed.mediaErrors?.map(x => x.message).join('; ') || 'FAILED'})`);
    if (nodes.length === ids.length && nodes.every(n => n && (n.status === 'READY' || n.fileStatus === 'READY'))) return nodes;
    await sleep(2500);
  }
  throw new Error(`${label}: images were still processing after 3 minutes`);
}

async function waitForJob(client, jobObj) {
  if (!jobObj || jobObj.done) return;
  for (let k = 0; k < 60; k++) {
    await sleep(1000);
    const d = await gql(client, Q_JOB, { id: jobObj.id });
    if (d.job?.done) return;
  }
  throw new Error('Reordering photos took too long');
}

async function reorderTo(client, productId, orderedIds) {
  const moves = orderedIds.map((id, idx) => ({ id, newPosition: String(idx) }));
  for (let k = 0; k < moves.length; k += 250) {
    const d = await gql(client, M_REORDER, { id: productId, moves: moves.slice(k, k + 250) });
    assertNoUserErrors(d.productReorderMedia, 'Reordering photos');
    await waitForJob(client, d.productReorderMedia.job);
  }
}

async function setVariantMedia(client, productId, wanted, current) {
  // wanted/current: Map variantId → mediaId|null
  const detach = [], append = [];
  for (const [vid, mid] of wanted) {
    const cur = current.get(vid) || [];
    if (mid && cur.length === 1 && cur[0] === mid) continue;
    if (!mid && cur.length === 0) continue;
    if (cur.length) detach.push({ variantId: vid, mediaIds: cur });
    if (mid) append.push({ variantId: vid, mediaIds: [mid] });
  }
  if (detach.length) {
    const d = await gql(client, M_VARIANT_DETACH, { productId, variantMedia: detach });
    assertNoUserErrors(d.productVariantDetachMedia, 'Clearing variant photos');
  }
  if (append.length) {
    const d = await gql(client, M_VARIANT_APPEND, { productId, variantMedia: append });
    assertNoUserErrors(d.productVariantAppendMedia, 'Setting variant photos');
  }
  return { changed: detach.length + append.length };
}

async function fileUpdateBatched(client, files, what) {
  for (let k = 0; k < files.length; k += 25) {
    const d = await gql(client, M_FILE_UPDATE, { files: files.slice(k, k + 25) });
    assertNoUserErrors(d.fileUpdate, what);
  }
}

async function applyOne({ client, session, feed, pid, job, backup, send }) {
  const log = [];
  const say = m => { log.push(m); send({ type: 'log', productId: pid, message: m }); };

  // 1. Live product must still match the backup (or be a resume of this job)
  let product = await fetchProduct(client, pid);
  if (!product) return { state: 'skipped', reason: 'Product no longer exists', log };
  let record = parseRecord(product) || {};
  const live = snapshotOf(product);
  const isResume = record.pending?.jobId === job.id;
  if (record.lastApply?.jobId === job.id) return { state: 'done', reason: 'Already applied in this job', log };
  if (!isResume && !sameSnapshot(live, backup.snapshot)) {
    return { state: 'skipped', reason: 'Photos changed since the backup was taken — run a new dry run + backup', log };
  }

  // 2. Re-plan with live data and the choices made in the preview
  session.raw[pid] = product;
  const missing = [];
  for (const v of product.variants?.nodes || []) {
    const parsed = core.parseUdSku(v.sku); const rec = parsed && feed.byId.get(parsed.cfsId);
    if (rec) for (const u of [rec.mainImage, ...(rec.galleryImages || [])]) if (!session.cfsHash[u]) missing.push(u);
  }
  if (missing.length) {
    const tmp = new Map(); await hashUrls(missing, tmp);
    for (const [u, h] of tmp) session.cfsHash[u] = h;
  }
  await fingerprintShopify([product], session, null);
  const plan = planFor(session, pid, feed);
  if (!plan.ok) return { state: 'skipped', reason: plan.errors.join(' | '), log };
  if (plan.noChange) {
    return { state: 'done', reason: 'Nothing to change', log };
  }

  // 3. Upload new photos to Shopify Files (NOT attached to the product yet)
  const uploads = plan.proposed.filter(o => o.action === 'upload');
  const keyToMedia = new Map(plan.proposed.filter(o => o.mediaId).map(o => [o.key, o.mediaId]));
  const pendingUploads = record.pending?.jobId === job.id ? (record.pending.uploads || []) : [];
  for (const pu of pendingUploads) if (pu.key) keyToMedia.set(pu.key, pu.mediaId);
  const toCreate = uploads.filter(u => !keyToMedia.has(u.key));
  if (toCreate.length) {
    say(`Uploading ${toCreate.length} new photo(s)…`);
    const d = await gql(client, M_FILE_CREATE, { files: toCreate.map(u => ({
      originalSource: u.src, alt: u.alt, contentType: 'IMAGE',
      filename: core.fileNameFromUrl(u.src), duplicateResolutionMode: 'APPEND_UUID' })) });
    assertNoUserErrors(d.fileCreate, 'Uploading photos');
    const files = d.fileCreate.files || [];
    if (files.length !== toCreate.length) throw new Error('Shopify returned an unexpected number of uploaded files');
    toCreate.forEach((u, idx) => {
      keyToMedia.set(u.key, files[idx].id);
      pendingUploads.push({ key: u.key, mediaId: files[idx].id, src: u.src, sha: u.sha || null, at: new Date().toISOString() });
    });
    record.pending = { jobId: job.id, uploads: pendingUploads };
    await saveRecord(client, pid, record);   // so a retry never uploads these again
  }
  const newIds = uploads.map(u => keyToMedia.get(u.key));
  if (newIds.length) {
    say('Waiting for Shopify to finish processing uploads…');
    await waitForReady(client, newIds, product.handle);
  }

  // 4. Attach the verified uploads to the product (they land at the end, then we reorder)
  product = await fetchProduct(client, pid);
  const attachedNow = new Set((product.media?.nodes || []).map(m => m.id));
  const toAttach = newIds.filter(id => !attachedNow.has(id));
  if (toAttach.length) {
    await fileUpdateBatched(client, toAttach.map(id => ({ id, referencesToAdd: [pid] })), 'Attaching photos');
    say(`Attached ${toAttach.length} photo(s)`);
  }

  // 5. Alt text fixes (colour names the theme filters on)
  const altFixes = plan.proposed.filter(o => o.altFix && o.mediaId).map(o => ({ id: o.mediaId, alt: o.alt }));
  if (altFixes.length) { await fileUpdateBatched(client, altFixes, 'Updating alt text'); say(`Corrected alt text on ${altFixes.length} photo(s)`); }

  // 6. Order (featured first), then variant photos
  const finalIds = plan.proposed.map(o => o.mediaId || keyToMedia.get(o.key));
  if (finalIds.some(x => !x)) throw new Error('Internal: a proposed photo has no Shopify id');
  await reorderTo(client, pid, finalIds);
  say('Photos reordered');

  product = await fetchProduct(client, pid);
  const currentVM = new Map((product.variants?.nodes || []).map(v => [v.id, (v.media?.nodes || []).map(n => n.id)]));
  const wantedVM = new Map(plan.variantAssign.map(v => [v.variantId, v.targetMediaId || keyToMedia.get(v.targetKey) || null]));
  const vm = await setVariantMedia(client, pid, wantedVM, currentVM);
  if (vm.changed) say(`Updated ${vm.changed} variant photo link(s)`);

  // 7. Detach (not delete) photos marked for removal — kept in Shopify Files
  const detachIds = plan.detach.map(d => d.mediaId).filter(id => !finalIds.includes(id));
  if (detachIds.length) {
    await fileUpdateBatched(client, detachIds.map(id => ({ id, referencesToRemove: [pid] })), 'Detaching photos');
    say(`Detached ${detachIds.length} photo(s) (kept in Shopify Files for ${DETACH_KEEP_DAYS} days)`);
  }

  // 8. Verify
  product = await fetchProduct(client, pid);
  const after = snapshotOf(product);
  const problems = [];
  if (after.mediaIds.join(',') !== finalIds.join(',')) problems.push('photo order does not match the plan');
  for (const [vid, mid] of wantedVM) if (mid && (after.variantMedia[vid] || [])[0] !== mid) problems.push(`variant ${numId(vid)} photo not set`);

  // 9. Save the record (what the app manages from now on)
  const recById = new Map((record.images || []).map(r => [r.mediaId, r]));
  const images = plan.proposed.filter(o => o.src).map(o => {
    const mid = o.mediaId || keyToMedia.get(o.key);
    return { mediaId: mid, src: o.src, sha: o.sha || recById.get(mid)?.sha || null, cfsId: o.cfsId, group: o.group, role: o.role };
  });
  const now = new Date().toISOString();
  record = {
    images,
    detached: [...(record.detached || []), ...plan.detach.filter(d => detachIds.includes(d.mediaId))
      .map(d => ({ mediaId: d.mediaId, at: now, reason: d.kind, src: recById.get(d.mediaId)?.src || null, url: d.url || null }))],
    excluded: plan.groups.flatMap(g => g.excluded.map(x => ({ cfsId: g.cfsId, url: x.url, reason: x.reason }))),
    lastApply: { jobId: job.id, backupId: job.backupId, at: now, before: backup.snapshot.mediaIds, after: after.mediaIds },
  };
  await saveRecord(client, pid, record);

  if (problems.length) return { state: 'failed', reason: `Applied but check failed: ${problems.join('; ')}`, log, counts: plan.counts };
  return { state: 'done', log, counts: plan.counts };
}

// ════════════════════════════════════════════════════════════════════════════
// Restore
// ════════════════════════════════════════════════════════════════════════════
const zipUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DIRS.restore),
    filename: (req, file, cb) => cb(null, `${newId('restore')}.zip`),
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(/\.zip$/i.test(file.originalname) ? null : new Error('Please upload the backup .zip'), true),
});

router.post('/restore/upload', zipUpload.single('zip'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No zip uploaded' });
  const restoreId = path.basename(req.file.filename, '.zip');
  const v = await verifyZip(req.file.path);
  if (!v.ok) { try { fs.unlinkSync(req.file.path); } catch (_) {} return res.status(400).json({ error: `Zip check failed: ${v.error}` }); }
  res.json({
    restoreId, backupId: v.manifest.backupId, createdAt: v.manifest.createdAt, photos: v.photos,
    products: v.manifest.products.map(p => ({ productId: p.productId, handle: p.handle, title: p.title, photos: p.media.length })),
  });
});

// body: { restoreId, productIds, force }
router.post('/restore', async (req, res) => {
  let client;
  try { client = graphqlClient(); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (activeRun) return res.status(409).json({ error: `Another ${activeRun.kind} is running (${activeRun.jobId})` });
  const sse = openSse(res);
  const { send } = sse;
  let z, job;
  try {
    const restoreId = req.body?.restoreId;
    if (!safeId(restoreId)) throw new Error('Upload the backup zip first');
    const zipPath = path.join(DIRS.restore, `${restoreId}.zip`);
    if (!fs.existsSync(zipPath)) throw new Error('Uploaded zip not found (server may have restarted) — upload it again');
    z = await openZip(zipPath);
    const manifest = JSON.parse((await z.read('manifest.json')).toString('utf8'));
    const wanted = new Set(req.body?.productIds || []);
    const items = manifest.products.filter(p => wanted.has(p.productId));
    if (!items.length) throw new Error('No products selected');

    job = { id: newId('job'), kind: 'restore', backupId: manifest.backupId, createdAt: new Date().toISOString(), status: 'running',
      products: Object.fromEntries(items.map(p => [p.productId, { handle: p.handle, state: 'waiting' }])) };
    activeRun = { kind: 'restore', jobId: job.id };   // also blocks image sync while restoring
    saveJob(job);
    send({ type: 'job', jobId: job.id });
    startRun(send, job.id);

    let i = 0;
    for (const item of items) {
      i++;
      const jp = job.products[item.productId];
      if (pauseRequests.has(job.id)) { job.status = 'paused'; break; }
      send({ type: 'progress', done: i - 1, total: items.length, message: `Restoring ${item.handle}…` });
      try { Object.assign(jp, await restoreOne({ client, z, item, force: !!req.body?.force, send })); }
      catch (e) { jp.state = 'failed'; jp.error = e.message; }
      saveJob(job);
      send({ type: 'product', productId: item.productId, ...jp });
    }
    if (job.status === 'running') job.status = 'finished';
    saveJob(job);
    send({ type: 'done', jobId: job.id, status: job.status });
  } catch (e) {
    if (job) { job.status = 'stopped'; job.error = e.message; saveJob(job); }
    send({ type: 'error', message: e.message });
  } finally {
    if (z) z.close();
    if (job) pauseRequests.delete(job.id);
    activeRun = null;
  }
  sse.end();
});

async function reuploadFromZip(client, z, m) {
  const buf = await z.read(m.file);
  // original Shopify file name (new zips) — older zips stored it in the path itself
  const filename = (m.originalName || path.basename(m.file).replace(/^\d+-/, '')).replace(/_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.)/i, '');
  const st = await gql(client, M_STAGED, { input: [{ resource: 'IMAGE', filename, mimeType: m.mimeType || 'image/jpeg',
    httpMethod: 'POST', fileSize: String(buf.length) }] });
  assertNoUserErrors(st.stagedUploadsCreate, 'Preparing upload');
  const t = st.stagedUploadsCreate.stagedTargets[0];
  const form = new FormData();
  for (const p of t.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([buf], { type: m.mimeType || 'image/jpeg' }), filename);
  const up = await fetch(t.url, { method: 'POST', body: form });
  if (!up.ok) throw new Error(`Upload of ${filename} failed (HTTP ${up.status})`);
  const d = await gql(client, M_FILE_CREATE, { files: [{ originalSource: t.resourceUrl, alt: m.alt || '', contentType: 'IMAGE',
    filename, duplicateResolutionMode: 'APPEND_UUID' }] });
  assertNoUserErrors(d.fileCreate, 'Re-uploading photo');
  return d.fileCreate.files[0].id;
}

async function restoreOne({ client, z, item, force, send }) {
  const say = m => send({ type: 'log', productId: item.productId, message: m });
  let product = await fetchProduct(client, item.productId);
  if (!product) return { state: 'skipped', reason: 'Product no longer exists in Shopify' };
  const record = parseRecord(product) || {};
  const live = snapshotOf(product);

  if (sameSnapshot(live, item.snapshot)) return { state: 'done', reason: 'Already matches the backup' };
  // Conflict: someone edited photos after the image sync ran
  if (record.lastApply && live.mediaIds.join(',') !== (record.lastApply.after || []).join(',') && !force) {
    return { state: 'conflict', reason: 'Photos were edited after the image sync — tick "Overwrite edits" to restore anyway' };
  }

  // Which backed-up photos still exist in Shopify Files?
  const imageMedia = item.media.filter(m => m.type === 'IMAGE');
  const ids = item.media.map(m => m.id);
  const exist = new Set();
  for (let k = 0; k < ids.length; k += 100) {
    const d = await gql(client, Q_NODES_MEDIA, { ids: ids.slice(k, k + 100) });
    for (const n of d.nodes || []) if (n && n.id) exist.add(n.id);
  }
  const idMap = new Map(); // backup id → current id
  const attached = new Set(live.mediaIds);
  const reattach = [];
  const reuploaded = [];
  for (const m of item.media) {
    if (attached.has(m.id)) { idMap.set(m.id, m.id); continue; }
    if (exist.has(m.id)) { idMap.set(m.id, m.id); reattach.push(m.id); continue; }
    if (m.type !== 'IMAGE' || !m.file) { say(`Cannot restore ${m.type} ${numId(m.id)} — not in backup`); continue; }
    const nid = await reuploadFromZip(client, z, m);
    idMap.set(m.id, nid); reuploaded.push(nid);
  }
  if (reuploaded.length) { say(`Re-uploaded ${reuploaded.length} photo(s) from the zip`); await waitForReady(client, reuploaded, item.handle); }
  const toAttach = [...reattach, ...reuploaded];
  if (toAttach.length) { await fileUpdateBatched(client, toAttach.map(id => ({ id, referencesToAdd: [item.productId] })), 'Re-attaching photos'); say(`Re-attached ${toAttach.length} photo(s)`); }

  // Alt text back
  product = await fetchProduct(client, item.productId);
  const curAlt = new Map((product.media?.nodes || []).map(m => [m.id, m.alt || '']));
  const altBack = imageMedia.filter(m => idMap.has(m.id) && curAlt.get(idMap.get(m.id)) !== (m.alt || ''))
    .map(m => ({ id: idMap.get(m.id), alt: m.alt || '' }));
  if (altBack.length) await fileUpdateBatched(client, altBack, 'Restoring alt text');

  // Order exactly as in the backup
  const ordered = item.media.map(m => idMap.get(m.id)).filter(Boolean);
  await reorderTo(client, item.productId, ordered);

  // Variant photos
  product = await fetchProduct(client, item.productId);
  const currentVM = new Map((product.variants?.nodes || []).map(v => [v.id, (v.media?.nodes || []).map(n => n.id)]));
  const wantedVM = new Map(item.variants.filter(v => currentVM.has(v.id)).map(v => [v.id, v.mediaIds[0] ? (idMap.get(v.mediaIds[0]) || null) : null]));
  await setVariantMedia(client, item.productId, wantedVM, currentVM);

  // Detach (never delete) photos that were not in the backup — e.g. added by the sync
  const keep = new Set(ordered);
  const extra = (product.media?.nodes || []).map(m => m.id).filter(id => !keep.has(id));
  if (extra.length) {
    await fileUpdateBatched(client, extra.map(id => ({ id, referencesToRemove: [item.productId] })), 'Detaching sync photos');
    say(`Detached ${extra.length} photo(s) added after the backup (kept in Shopify Files)`);
  }

  // Record: back to the backed-up record, but remember what we detached so clean-up can find it
  const now = new Date().toISOString();
  const restoredRecord = item.record ? { ...item.record } : {};
  restoredRecord.detached = [...(restoredRecord.detached || []), ...(record.detached || []),
    ...extra.map(id => ({ mediaId: id, at: now, reason: 'restore' }))]
    .filter((d, idx, arr) => arr.findIndex(x => x.mediaId === d.mediaId) === idx)
    .filter(d => !keep.has(d.mediaId))
    .filter(d => !(ids.includes(d.mediaId) && !exist.has(d.mediaId)));   // file already gone (re-uploaded instead)
  restoredRecord.restoredAt = now;
  delete restoredRecord.pending;
  await saveRecord(client, item.productId, restoredRecord);

  product = await fetchProduct(client, item.productId);
  const after = snapshotOf(product);
  if (after.mediaIds.join(',') !== ordered.join(',')) return { state: 'failed', reason: 'Restored, but photo order check failed' };
  return { state: 'done', reattached: reattach.length, reuploaded: reuploaded.length, detached: extra.length };
}

// ════════════════════════════════════════════════════════════════════════════
// Clean-up (manual): delete detached photos older than 7 days
// ════════════════════════════════════════════════════════════════════════════
router.post('/cleanup/scan', async (req, res) => {
  let client;
  try { client = graphqlClient(); } catch (e) { return res.status(400).json({ error: e.message }); }
  const sse = openSse(res);
  const { send } = sse;
  const runId = startRun(send);
  const check = stopCheck(runId);
  try {
    const cutoff = Date.now() - DETACH_KEEP_DAYS * 86400000;
    const candidates = [];
    const inUse = new Set(); // media ids any product's record still uses
    let after = null, scanned = 0;
    do {
      check();
      const d = await gql(client, Q_RECORDS_PAGE, { first: 100, after });
      for (const p of d.products.nodes) {
        scanned++;
        if (!p.metafield?.value) continue;
        let r; try { r = JSON.parse(p.metafield.value); } catch (_) { continue; }
        for (const im of r.images || []) inUse.add(im.mediaId);
        for (const dt of r.detached || []) {
          if (dt.deletedAt) continue;
          candidates.push({ productId: p.id, handle: p.handle, ...dt, old: new Date(dt.at).getTime() <= cutoff });
        }
      }
      send({ type: 'progress', message: `Scanned ${scanned} products…` });
      after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
    } while (after);

    // Is the file still attached to anything we know about? Still exists?
    const ids = [...new Set(candidates.map(c => c.mediaId))];
    const exists = new Map();
    for (let k = 0; k < ids.length; k += 100) {
      const d = await gql(client, Q_NODES_MEDIA, { ids: ids.slice(k, k + 100) });
      for (const n of d.nodes || []) if (n && n.id) exists.set(n.id, n);
    }
    const items = candidates.map(c => ({
      ...c,
      exists: exists.has(c.mediaId),
      preview: exists.get(c.mediaId)?.image?.url || c.url || null,
      shared: inUse.has(c.mediaId),
      deletable: c.old && exists.has(c.mediaId) && !inUse.has(c.mediaId),
    }));
    send({ type: 'done', scanned, items });
  } catch (e) {
    if (e.stopped) send({ type: 'stopped', message: 'Scan stopped — nothing was deleted' });
    else send({ type: 'error', message: e.message });
  }
  endRun(runId);
  sse.end();
});

// body: { items: [{ productId, mediaId }] }
router.post('/cleanup/delete', async (req, res) => {
  let client;
  try { client = graphqlClient(); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (activeRun) return res.status(409).json({ error: `Wait — a ${activeRun.kind} is running` });
  try {
    const items = (req.body?.items || []).filter(x => x.productId && x.mediaId);
    const byProduct = new Map();
    for (const it of items) { if (!byProduct.has(it.productId)) byProduct.set(it.productId, []); byProduct.get(it.productId).push(it.mediaId); }
    const cutoff = Date.now() - DETACH_KEEP_DAYS * 86400000;
    const deleted = [], refused = [];
    for (const [pid, mids] of byProduct) {
      const product = await fetchProduct(client, pid);
      const record = parseRecord(product) || {};
      const attachedHere = new Set((product?.media?.nodes || []).map(m => m.id));
      const ok = mids.filter(mid => {
        const d = (record.detached || []).find(x => x.mediaId === mid && !x.deletedAt);
        const why = !d ? 'not in this product\'s detached list' : new Date(d.at).getTime() > cutoff ? `detached less than ${DETACH_KEEP_DAYS} days ago`
          : attachedHere.has(mid) ? 'attached to the product again' : (record.images || []).some(im => im.mediaId === mid) ? 'in use' : null;
        if (why) refused.push({ productId: pid, mediaId: mid, reason: why });
        return !why;
      });
      if (!ok.length) continue;
      const d = await gql(client, M_FILE_DELETE, { fileIds: ok });
      const errs = userErrorsOf(d.fileDelete);
      const gone = new Set(d.fileDelete.deletedFileIds || []);
      for (const mid of ok) (gone.has(mid) ? deleted : refused).push({ productId: pid, mediaId: mid, reason: gone.has(mid) ? null : (errs[0]?.message || 'not deleted') });
      const now = new Date().toISOString();
      record.detached = (record.detached || []).map(x => gone.has(x.mediaId) ? { ...x, deletedAt: now } : x);
      await saveRecord(client, pid, record);
    }
    res.json({ deleted, refused });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router._visualFingerprint = visualFingerprint; // exposed for tests
module.exports = router;