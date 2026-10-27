const assert = require('assert');
const core = require('../utils/imageSyncCore');
const product = require('./milan-product.json');
// selectedOptions weren't fetched in the saved sample — derive them from the variant title
for (const [i, v] of product.variants.nodes.entries()) {
  v.id = 'gid://shopify/ProductVariant/' + (500 + i);
  const [c, s] = v.title.split(' / ');
  v.selectedOptions = [{ name: 'Color', value: c }, { name: 'Size', value: s }];
}
const base = 'https://images.choicefurnituresuperstore.co.uk/images2/Dining/Dining-Tables/';
const mk = (id, sku, mainTs, galTs, name) => ({
  iProductId: id, vSKU: sku, mainImage: `${base}${mainTs}${name}.jpg`, galleryCount: 6,
  galleryImages: [1,2,3,4,5,6].map(n => `${base}${galTs}${name}-0${n}.jpg`) });
const feed = new Map([
  ['144250', mk(144250, 'CFSUD-069', '1769678790', '1769690539', 'Milan-6-Seater-White-Marble-Dining-Table-Sizes-Available')],
  ['601535', mk(601535, 'CFSUD-948', '1769680991', '1769690414', 'Milan-6-Seater-Grey-Marble-Dining-Table-Sizes-Available')],
  ['1262189', mk(1262189, 'CFSUD-7996', '1769684527', '1769690325', 'Milan-Travertine-Beige-Engineered-Marble-6-Seater-Dining-Table-Sizes-Available')],
]);

// ── CFSUD rule unit cases ──
let r = core.applyCfsudRule(feed.get('144250'));
assert(r.ok && r.gallery.length === 5 && r.excluded[0].url.endsWith('-06.jpg'));
r = core.applyCfsudRule({ vSKU: 'CFSUD-1', mainImage: 'm', galleryCount: 0, galleryImages: [] });
assert(r.ok && r.gallery.length === 0 && r.excluded.length === 0);
r = core.applyCfsudRule({ vSKU: 'CFSUD-1', mainImage: 'm', galleryCount: 1, galleryImages: ['a'] });
assert(r.ok && r.gallery.length === 0 && r.excluded.length === 1 && r.main === 'm');
r = core.applyCfsudRule({ vSKU: 'CFSBMH-1', mainImage: 'm', galleryCount: 2, galleryImages: ['a', 'b'] });
assert(r.ok && r.gallery.length === 2 && r.excluded.length === 0);
r = core.applyCfsudRule({ vSKU: 'CFSUD-1', mainImage: 'm', galleryCount: 3, galleryImages: ['a', 'b'] });
assert(!r.ok);
// position, not filename: last entry is excluded even if named -01
r = core.applyCfsudRule({ vSKU: 'x-CFSUD-9', mainImage: 'm', galleryCount: 2, galleryImages: ['z-06.jpg', 'z-01.jpg'] });
assert(r.excluded[0].url === 'z-01.jpg');
// other brands: the CFSUD last-photo rule is switched off — every gallery photo kept
r = core.applyCfsudRule(feed.get('144250'), { dropLast: false });
assert(r.ok && r.gallery.length === 6 && r.excluded.length === 0);
r = core.applyCfsudRule({ vSKU: 'CFSUD-1', mainImage: 'm', galleryCount: 3, galleryImages: ['a', 'b'] }, { dropLast: false });
assert(!r.ok, 'gallery count check still applies');
assert.deepStrictEqual(core.parseUdSku('UD-144250-16985745'), { cfsId: '144250', varId: '16985745' });
assert.deepStrictEqual(core.parseUdSku('UD-88'), { cfsId: '88', varId: null });
assert(core.parseUdSku('ABC-1') === null);

// ── Full product plan (Milan) ──
const plan = core.buildProductPlan({ product, feedById: feed });
console.log(JSON.stringify(plan.counts), plan.errors, plan.warnings);
assert(plan.ok);
assert.strictEqual(plan.counts.proposed, 18);
assert.strictEqual(plan.counts.reuse, 15);
assert.strictEqual(plan.counts.upload, 3);
assert.strictEqual(plan.counts.excluded, 3);
// same product for another brand (cfsudRule off): the 3 last photos come back
const planBrand = core.buildProductPlan({ product, feedById: feed, choices: { cfsudRule: false } });
assert(planBrand.ok); assert.strictEqual(planBrand.counts.excluded, 0); assert.strictEqual(planBrand.counts.proposed, 21);
assert.strictEqual(plan.counts.detach, 0);
assert.strictEqual(plan.counts.variantChanges, 0);
assert.strictEqual(plan.counts.altFix, 0);
assert.strictEqual(plan.featured.proposed, product.featuredMedia.id);
console.log(plan.proposed.map(o => `${o.position}. ${o.action.padEnd(6)} ${o.group.padEnd(5)} ${core.fileNameFromUrl(o.src).slice(-14)}`).join('\n'));
assert.deepStrictEqual(plan.proposed.map(o => o.group), [...Array(6).fill('White'), ...Array(6).fill('Grey'), ...Array(6).fill('Beige')]);
assert(plan.proposed[5].action === 'upload' && plan.proposed[5].src.endsWith('-05.jpg'));

// ── Live store already showing the excluded -06 image → default detach ──
const p2 = JSON.parse(JSON.stringify(product));
p2.media.nodes.push({ id: 'gid://shopify/MediaImage/999', alt: 'White', mediaContentType: 'IMAGE',
  image: { url: 'https://cdn.shopify.com/s/files/1/x/1769690539Milan-6-Seater-White-Marble-Dining-Table-Sizes-Available-06_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg' } });
p2.media.nodes.push({ id: 'gid://shopify/MediaImage/998', alt: 'Grey', mediaContentType: 'IMAGE',
  image: { url: 'https://cdn.shopify.com/s/files/1/x/lifestyle-shot.jpg' } });
const plan2 = core.buildProductPlan({ product: p2, feedById: feed });
assert.strictEqual(plan2.detach.length, 1);
assert.strictEqual(plan2.detach[0].kind, 'excluded-live');
const manual = plan2.proposed.find(o => o.mediaId === 'gid://shopify/MediaImage/998');
assert(manual && manual.action === 'keep' && manual.position === 13, 'manual Grey photo stays at end of Grey group');
// user chooses to keep the excluded one instead
const plan3 = core.buildProductPlan({ product: p2, feedById: feed, choices: { detach: { 'gid://shopify/MediaImage/999': false } } });
assert.strictEqual(plan3.detach.length, 0);

// ── Missing feed record / ambiguous / broken image → product skipped ──
const feed2 = new Map(feed); feed2.delete('601535');
assert(!core.buildProductPlan({ product, feedById: feed2 }).ok);
const broken = new Map([[feed.get('144250').galleryImages[2], { error: 'HTTP 404' }]]);
assert(!core.buildProductPlan({ product, feedById: feed, cfsHash: broken }).ok);
const p4 = JSON.parse(JSON.stringify(product)); p4.variants.nodes[3].sku = 'UD-144250-1';
assert(!core.buildProductPlan({ product: p4, feedById: feed }).ok, 'one CFS product across two colours is ambiguous');

// ── Re-run: record says media came from URL X with sha A, CFS now has sha B → replaced ──
const whiteMainUrl = feed.get('144250').mainImage;
const rec = { images: [{ mediaId: product.media.nodes[0].id, src: whiteMainUrl, sha: 'AAA' }] };
const plan5 = core.buildProductPlan({ product, feedById: feed, record: rec, cfsHash: new Map([[whiteMainUrl, { sha: 'BBB', bytes: 1 }]]) });
assert.strictEqual(plan5.counts.upload, 4);
assert(plan5.detach.some(d => d.kind === 'replaced') === false, 'featured image is protected from detach');
assert(plan5.warnings.some(w => /featured/.test(w)));

// ── Re-run after a successful sync is a no-op ──
const p6 = JSON.parse(JSON.stringify(product));
let n = 1000;
for (const [cfsId, label] of [['144250','White'],['601535','Grey'],['1262189','Beige']]) {
  const idx = p6.media.nodes.map((m, i) => [m, i]).filter(([m]) => m.alt === label).pop()[1];
  p6.media.nodes.splice(idx + 1, 0, { id: `gid://shopify/MediaImage/${n++}`, alt: label, mediaContentType: 'IMAGE',
    image: { url: 'https://cdn.shopify.com/s/files/1/x/' + core.fileNameFromUrl(feed.get(cfsId).galleryImages[4]) } });
}
const plan6 = core.buildProductPlan({ product: p6, feedById: feed });
assert(plan6.noChange, 'second run should change nothing: ' + JSON.stringify(plan6.counts));
console.log('CSV lines:', core.plansToCsv([plan, plan2]).split('\n').length);
console.log('ALL TESTS PASSED');
// featured can be switched to a new upload slot
const plan7 = core.buildProductPlan({ product, feedById: feed, choices: { featured: '144250:g5' } });
assert(plan7.proposed[0].key === '144250:g5' && !plan7.noChange);
console.log('FEATURED TEST PASSED');
// not found in CFS → clear message + flag
const feedNone = new Map();
const pn = core.buildProductPlan({ product, feedById: feedNone });
assert(!pn.ok && pn.notInCfs === 'all' && /Couldn't find in CFS/.test(pn.errors[0]));
const feedSome = new Map(feed); feedSome.delete('1262189');
const ps = core.buildProductPlan({ product, feedById: feedSome });
assert(!ps.ok && ps.notInCfs === 'some' && ps.notInCfsVariants.length === 3);
assert(core.plansToCsv([pn]).includes("Couldn't find in CFS"));
console.log('NOT-IN-CFS TEST PASSED');
// ── Picture check on name matches ──
{
  const mkThumb = v => Buffer.alloc(3072, v).toString('base64');
  const cfsHash = new Map(), shopHash = new Map();
  for (const rec of feed.values()) for (const u of [rec.mainImage, ...rec.galleryImages]) cfsHash.set(u, { sha: 'c' + u, thumb: mkThumb(100), w: 1200, h: 1200 });
  for (const m of product.media.nodes) shopHash.set(m.id, { sha: 's' + m.id, thumb: mkThumb(100), w: 600, h: 600 });
  // same picture → reuse, labelled name+picture
  let pl = core.buildProductPlan({ product, feedById: feed, cfsHash, shopHash });
  assert(pl.ok && pl.counts.reuse === 15 && pl.proposed.filter(o => o.matchedBy === 'name+picture').length === 15, JSON.stringify(pl.counts));
  // CFS swapped White -02 under the same name → upload new + old one detached as "replaced"
  const w02 = feed.get('144250').galleryImages[1];
  const oldW02 = product.media.nodes[2].id;
  cfsHash.set(w02, { sha: 'new', thumb: mkThumb(200), w: 1200, h: 1200 });
  pl = core.buildProductPlan({ product, feedById: feed, cfsHash, shopHash });
  assert(pl.counts.upload === 4 && pl.counts.replacedSameName === 1, JSON.stringify(pl.counts));
  assert(pl.detach.some(d => d.mediaId === oldW02 && d.kind === 'replaced'));
  assert(pl.proposed[2].action === 'upload' && pl.proposed[2].replaces === oldW02, 'new -02 takes the old one\'s place');
  // borderline → "please check": default upload, user can choose to reuse
  const t = Buffer.alloc(3072, 100); for (let i = 0; i < 3 * 25; i++) t[i] = 200;   // ~2.4% changed
  cfsHash.set(w02, { sha: 'new', thumb: t.toString('base64'), w: 1200, h: 1200 });
  pl = core.buildProductPlan({ product, feedById: feed, cfsHash, shopHash });
  assert(pl.counts.unsure === 1 && pl.counts.upload === 4, JSON.stringify(pl.counts));
  pl = core.buildProductPlan({ product, feedById: feed, cfsHash, shopHash, choices: { reuseUnsure: { [oldW02]: true } } });
  assert(pl.counts.unsure === 0 && pl.counts.upload === 3 && pl.proposed[2].mediaId === oldW02);
  // never match a White CFS photo to a Grey Shopify photo by picture alone
  const p2 = JSON.parse(JSON.stringify(product));
  p2.media.nodes[7].image.url = 'https://cdn.shopify.com/x/renamed.jpg';    // Grey -02 renamed
  const pl2 = core.buildProductPlan({ product: p2, feedById: feed, cfsHash: new Map([...cfsHash].map(([k, v]) => [k, { ...v, thumb: mkThumb(100) }])), shopHash });
  assert(pl2.proposed.find(o => o.mediaId === p2.media.nodes[7].id).group === 'Grey', 'renamed Grey photo re-found by picture, stays Grey');
  console.log('PICTURE-CHECK PLAN TESTS PASSED');
}
// ── "Replace with CFS photos" (Bern-style: old re-cropped copies with other names) ──
{
  const pb = JSON.parse(JSON.stringify(product));
  pb.media.nodes.forEach((m, i) => { m.image.url = `https://cdn.shopify.com/x/Bern-old-101052-${i}.jpg`; m.alt = ''; });
  const off = core.buildProductPlan({ product: pb, feedById: feed });
  assert(off.counts.upload === 18 && off.counts.keep === 15 && off.counts.detach === 0, 'OFF: old photos kept alongside ' + JSON.stringify(off.counts));
  const on = core.buildProductPlan({ product: pb, feedById: feed, choices: { replaceMode: true } });
  assert(on.counts.proposed === 18 && on.counts.detach === 15 && on.counts.keep === 0, 'ON: clean CFS gallery ' + JSON.stringify(on.counts));
  assert(on.proposed[0].key === '144250:main' && on.warnings.some(w => /Featured photo changes/.test(w)), 'featured moves to CFS main');
  assert(on.proposed.every(o => o.alt === o.group), 'all photos get colour alt text');
  // keep one specific old photo even in replace mode
  const keepId = pb.media.nodes[3].id;
  const on2 = core.buildProductPlan({ product: pb, feedById: feed, choices: { replaceMode: true, detach: { [keepId]: false } } });
  assert(on2.counts.detach === 14 && on2.proposed.some(o => o.mediaId === keepId));
  // chosen featured is respected
  const on3 = core.buildProductPlan({ product: pb, feedById: feed, choices: { replaceMode: true, featured: '601535:main' } });
  assert(on3.proposed[0].key === '601535:main');
  // replace mode never detaches non-image media (videos)
  const pv = JSON.parse(JSON.stringify(pb)); pv.media.nodes.push({ id: 'gid://shopify/Video/1', alt: '', mediaContentType: 'VIDEO' });
  assert(!core.buildProductPlan({ product: pv, feedById: feed, choices: { replaceMode: true } }).detach.some(d => d.mediaId === 'gid://shopify/Video/1'));
  console.log('REPLACE-MODE TESTS PASSED');
}
// ── Photo-type filters: white background + not square (after CFSUD rule) ──
{
  // Bern Black (real CFS sizes/edge values): main + 6 gallery; #4,#5 are cut-outs, #6 is last (CFSUD)
  const rec = { iProductId: 1, vSKU: 'CFSUD-5209', mainImage: 'm', galleryCount: 6, galleryImages: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'] };
  const h = new Map([['m', { w: 2000, h: 2000, edgeWhite: 0 }], ['g1', { w: 2000, h: 2000, edgeWhite: 0 }], ['g2', { w: 2000, h: 2000, edgeWhite: 0.02 }],
    ['g3', { w: 2000, h: 2000, edgeWhite: 0.1 }], ['g4', { w: 2000, h: 1266, edgeWhite: 0.99 }], ['g5', { w: 2000, h: 1426, edgeWhite: 0.99 }], ['g6', { w: 2000, h: 2000, edgeWhite: 0.99 }]]);
  const r = core.applyCfsudRule(rec);
  assert.deepStrictEqual(r.excluded.map(x => x.url), ['g6']);                     // CFSUD first, by position
  const f = core.applyPhotoFilters(r, h, { skipWhiteBg: true, skipNonSquare: true });
  assert.deepStrictEqual(f.gallery, ['g1', 'g2', 'g3']);
  assert.deepStrictEqual(f.excluded.map(x => x.rule), ['white-background', 'white-background']);
  // square white-background cut-out is caught; non-square room photo is caught by the shape rule
  const f2 = core.applyPhotoFilters({ main: 'm', gallery: ['a', 'b', 'c'] }, new Map([['m', { w: 1, h: 1 }], ['a', { w: 2000, h: 2000, edgeWhite: 0.96 }],
    ['b', { w: 2000, h: 1495, edgeWhite: 0 }], ['c', { w: 2000, h: 2000, edgeWhite: 0.5 }]]), { skipWhiteBg: true, skipNonSquare: true });
  assert.deepStrictEqual(f2.gallery, ['c']); assert(f2.warnings.some(w => /light background/.test(w)), 'grey studio flagged, not skipped');
  // switches off → nothing extra skipped
  assert.strictEqual(core.applyPhotoFilters(r, h, { skipWhiteBg: false, skipNonSquare: false }).gallery.length, 5);
  // main image is never skipped
  const f3 = core.applyPhotoFilters({ main: 'm', gallery: [] }, new Map([['m', { w: 2000, h: 1200, edgeWhite: 1 }]]), { skipWhiteBg: true, skipNonSquare: true });
  assert(f3.warnings.length === 2);
  // full plan: Milan where every photo is square + room photo → filters change nothing
  const sq = new Map(); for (const rec2 of feed.values()) for (const u of [rec2.mainImage, ...rec2.galleryImages]) sq.set(u, { w: 2000, h: 2000, edgeWhite: 0 });
  sq.set(feed.get('144250').galleryImages[5], { w: 2000, h: 2000, edgeWhite: 1 });
  const pm = core.buildProductPlan({ product, feedById: feed, cfsHash: sq });
  assert(pm.counts.proposed === 18 && pm.counts.excludedCfsud === 3 && pm.counts.excludedWhiteBg === 0);
  console.log('PHOTO-FILTER TESTS PASSED');
}
// ── Step 3: photos to remove when variants are deleted ──
{
  const greyIds = product.variants.nodes.filter(v => v.title.startsWith('Grey')).map(v => v.id);
  // 1. remove the whole Grey colour (alt texts present, no fingerprints) → the 5 Grey photos go
  let r = core.planVariantRemoval({ product, removedVariantIds: greyIds, feedById: feed });
  assert.deepStrictEqual(r.removedGroups, ['Grey']);
  assert.strictEqual(r.counts.remove, 5, JSON.stringify(r.counts));
  assert(r.items.filter(x => x.verdict === 'remove').every(x => x.alt === 'Grey'));
  assert(r.items.filter(x => x.verdict === 'remove').every(x => /removed Grey/.test(x.reason)));
  // 2. remove only ONE size of Grey → colour still exists → nothing removed
  r = core.planVariantRemoval({ product, removedVariantIds: [greyIds[0]], feedById: feed });
  assert.strictEqual(r.counts.remove, 0); assert.deepStrictEqual(r.removedGroups, []);
  // 3. Bern-style: empty alt texts, file names match CFS → still found by name
  const pb = JSON.parse(JSON.stringify(product)); pb.media.nodes.forEach(m => { m.alt = ''; });
  r = core.planVariantRemoval({ product: pb, removedVariantIds: greyIds, feedById: feed });
  assert.strictEqual(r.counts.remove, 5, 'found by CFS file name without alt text');
  // 4. empty alt + renamed files + no CFS record → only the variant's linked photo goes; rest "check"
  const pc = JSON.parse(JSON.stringify(pb)); pc.media.nodes.forEach((m, i) => { m.image.url = `https://cdn.shopify.com/x/old-${i}.jpg`; });
  const f2 = new Map(feed); f2.delete('601535');
  r = core.planVariantRemoval({ product: pc, removedVariantIds: greyIds, feedById: f2 });
  assert.strictEqual(r.counts.remove, 1, JSON.stringify(r.counts));
  assert(r.items.find(x => x.verdict === 'remove').reason.startsWith('Main photo of deleted variant'));
  assert(r.counts.check >= 4 && r.warnings.some(w => /No CFS photos/.test(w)));
  // 5. picture match: renamed Grey photo found by picture
  const sh = new Map(), ch = new Map();
  const pat = [...Array(20)].map(() => require('crypto').randomBytes(3072).toString('base64'));   // a distinct "picture" each
  pc.media.nodes.forEach((m, i) => sh.set(m.id, { thumb: pat[i], w: 1000, h: 1000 }));
  const greyMedia = product.media.nodes.map((m, i) => [m, i]).filter(([m]) => m.alt === 'Grey');
  const greyRec = feed.get('601535');
  [greyRec.mainImage, ...greyRec.galleryImages].forEach((u, k) => { const gi = greyMedia[k]; ch.set(u, { thumb: gi ? pat[gi[1]] : pat[18], w: 2000, h: 2000 }); });
  for (const rec2 of feed.values()) if (rec2 !== greyRec) for (const u of [rec2.mainImage, ...rec2.galleryImages]) if (!ch.has(u)) ch.set(u, { thumb: pat[19], w: 2000, h: 2000 });
  r = core.planVariantRemoval({ product: pc, removedVariantIds: greyIds, feedById: feed, cfsHash: ch, shopHash: sh });
  assert.strictEqual(r.counts.remove, 5, 'renamed Grey photos found by picture ' + JSON.stringify(r.counts));
  // 6. removing every colour would strip all photos → nothing removed, flagged
  r = core.planVariantRemoval({ product, removedVariantIds: product.variants.nodes.map(v => v.id), feedById: feed });
  assert(r.counts.remove === 0 && r.warnings.some(w => /Every photo/.test(w)));
  console.log('STEP-3 REMOVAL TESTS PASSED');
}
