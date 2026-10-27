/**
 * Undo records for Step 3 live runs.
 *
 * Every live run (Delete Selected Orphaned, Set Selected to Draft, Publish
 * Selected as Main Product) writes down what it changed and what it was before:
 *
 *   status    — product status            before → after   (undo: put status back)
 *   sku       — variant SKU                before → after   (undo: put SKU back)
 *   photos    — photos detached from a product              (undo: re-attach + old order)
 *   vendor    — product vendor             before → after   (undo: put vendor back)
 *   title     — product title + URL        before → after   (undo: put both back, old URL redirects)
 *   variants-deleted — listed for information only: Shopify can't bring back a
 *                      deleted variant, so this part can NOT be undone.
 *
 * Each run also records which brand it came from (brand / brandId — Urban Deco or
 * one of the other brands). Older undo files have no brand and show "—".
 *
 * Records are saved on the server (uploads/step3-undo/<id>.json) AND downloaded
 * to the user as a file, because Render's disk is wiped on restarts. An undo
 * file can be uploaded again later.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '../uploads/step3-undo');
fs.mkdirSync(DIR, { recursive: true });

const newId = () => `undo-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
const safeId = id => /^undo-\d{14}-[0-9a-f]{6}$/.test(String(id || ''));
const file = id => path.join(DIR, `${id}.json`);

// brandId empty = Urban Deco (main page); otherwise one of the 14 other brands
function brandOf(brandId) {
  if (!brandId) return { brandId: null, brand: 'Urban Deco' };
  const b = require('./brands').getBrand(brandId);
  return { brandId: Number(brandId), brand: b ? b.vendor : `Brand ${brandId}` };
}

function startRun(kind, label, brandId = null) {
  return { type: 'urban-deco-step3-undo', version: 1, id: newId(), kind, label, ...brandOf(brandId), createdAt: new Date().toISOString(),
    store: process.env.SHOPIFY_STORE, entries: [] };
}

function add(run, entry) { run.entries.push({ ...entry, at: new Date().toISOString() }); }

function save(run) {
  if (!run.entries.length) return null;
  fs.writeFileSync(file(run.id), JSON.stringify(run, null, 2));
  return run.id;
}

function load(id) {
  if (!safeId(id)) return null;
  try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch (_) { return null; }
}

function importRun(obj) {
  if (!obj || obj.type !== 'urban-deco-step3-undo' || !safeId(obj.id) || !Array.isArray(obj.entries)) {
    throw new Error('Not a Step 3 undo file');
  }
  if (obj.store && process.env.SHOPIFY_STORE && obj.store !== process.env.SHOPIFY_STORE) {
    throw new Error(`This undo file is for another store (${obj.store})`);
  }
  // keep "already undone" marks from the server copy if it is newer
  const existing = load(obj.id);
  const merged = existing ? { ...obj, entries: obj.entries.map((e, i) => ({ ...e, undoneAt: e.undoneAt || existing.entries[i]?.undoneAt })) } : obj;
  fs.writeFileSync(file(obj.id), JSON.stringify(merged, null, 2));
  return merged;
}

function list() {
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => load(f.replace(/\.json$/, ''))).filter(Boolean)
    .map(r => summarise(r)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function summarise(r) {
  const undoable = r.entries.filter(e => e.type !== 'variants-deleted');
  return {
    id: r.id, kind: r.kind, label: r.label, brand: r.brand || '', brandId: r.brandId ?? null, createdAt: r.createdAt,
    products: new Set(r.entries.map(e => e.productId)).size,
    changes: undoable.length,
    undone: undoable.filter(e => e.undoneAt).length,
    variantsDeleted: r.entries.filter(e => e.type === 'variants-deleted').reduce((a, e) => a + (e.skus || []).length, 0),
    counts: undoable.reduce((a, e) => { a[e.type] = (a[e.type] || 0) + 1; return a; }, {}),
  };
}

function markUndone(run, indexes) {
  const now = new Date().toISOString();
  for (const i of indexes) if (run.entries[i]) run.entries[i].undoneAt = now;
  fs.writeFileSync(file(run.id), JSON.stringify(run, null, 2));
}

module.exports = { brandOf, startRun, add, save, load, importRun, list, summarise, markUndone, safeId, file };
