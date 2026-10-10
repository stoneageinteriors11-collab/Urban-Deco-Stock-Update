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
