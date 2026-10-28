// Store health — every check on small fake products
const assert = require('assert');
const { runChecks } = require('../utils/storeHealth');
const { findDefaults } = require('../utils/defaultColour');

const byProd = new Map([
  ['100', { brandId: 215, vendor: 'Urban Deco', name: 'Milan White Table' }],
  ['101', { brandId: 215, vendor: 'Urban Deco', name: 'Milan Grey Table' }],
  ['200', { brandId: 80, vendor: 'Birlea', name: 'Herringford Oak' }],
  ['300', { brandId: 364, vendor: 'Livingfurn', name: 'Noor Natural TV Unit' }],
  ['316', { brandId: 364, vendor: 'Livingfurn', name: 'Tommy Bisque Oasis' }],
  ['603', { brandId: 215, vendor: 'Urban Deco', name: 'Orthopocket Mattress' }],
]);
const opt = (name, ...vals) => ({ id: 'o' + name, name, optionValues: vals.map(v => ({ id: `${name}-${v}`, name: v })) });
const v = (sku, colour, size) => ({ id: 'v' + sku + (size || ''), sku, title: [colour, size].filter(Boolean).join(' / '),
  selectedOptions: [{ name: 'Color', value: colour }, ...(size ? [{ name: 'Size', value: size }] : [])] });
const P = (id, extra) => ({ id: 'gid://shopify/Product/' + id, handle: 'h' + id, title: 'P' + id, vendor: 'Urban Deco', status: 'ACTIVE', iid: null, pcode: 'X', options: [opt('Color', 'White')], variants: [], ...extra });

const products = [
  // healthy
  P(1, { title: 'Milan Table - White', handle: 'milan-table-white', iid: '100', options: [opt('Color', 'White', 'Grey')], variants: [v('UD-100', 'White'), v('UD-101', 'Grey')] }),
  // Default colour next to a real colour (different CFS products) → default-colours
  P(2, { title: 'Herringford - Walnut', handle: 'herringford-walnut', vendor: 'Birlea', iid: '200', options: [opt('Color', 'Brown', 'Default')], variants: [v('UD-200', 'Brown'), v('UD-999', 'Default')] }),
  // split colour → split-colours
  P(3, { title: 'Tommy - Bisque Oasis', handle: 'tommy-bisque-oasis', vendor: 'Livingfurn', iid: '316', options: [opt('Color', 'Bisque Oasis', 'Default Title'), opt('Size', '2 Chairs', '4 Chairs')],
    variants: [v('UD-316-1', 'Bisque Oasis', '2 Chairs'), v('UD-316-2', 'Default Title', '4 Chairs')] }),
  // SKU typo + not in CFS + no SKU + same SKU twice
  P(4, { title: 'Posey Bed - Navy', handle: 'posey-bed-navy', iid: '101', options: [opt('Color', 'Navy')],
    variants: [v('UD-101- 5', 'Navy'), v('UD-777', 'Navy'), v('', 'Navy'), v('UD-101', 'Navy'), v('UD-101', 'Navy')] }),
  // wrong vendor: Livingfurn SKU on an "Urban Deco" product; title colour not in URL
  P(5, { title: 'Noor TV Unit - Natural', handle: 'noor-tv-unit-medium-brown', iid: '300', options: [opt('Color', 'Natural')], variants: [v('UD-300', 'Natural')] }),
  // same own item on two pages (no iproductid — single CFS product) + missing ids
  P(6, { title: '2 x Orthopocket Mattress', handle: 'ortho-2', vendor: 'Store Brand', iid: null, pcode: '', options: [opt('Title', 'Default Title')], variants: [{ id: 'm1', sku: 'UD-603', title: 'Default Title', selectedOptions: [{ name: 'Title', value: 'Default Title' }] }] }),
  P(7, { title: '3 x Orthopocket Mattress', handle: 'ortho-3', vendor: 'Store Brand', iid: null, pcode: '', options: [opt('Title', 'Default Title')], variants: [{ id: 'm2', sku: 'UD-603', title: 'Default Title', selectedOptions: [{ name: 'Title', value: 'Default Title' }] }] }),
];
const checks = runChecks(products, { byProd, byVar: new Map(), knownVendors: ['Urban Deco', 'Birlea', 'Livingfurn'], findDefaults });
const by = Object.fromEntries(checks.map(c => [c.id, c]));
const handles = id => by[id].rows.map(r => r.handle).sort();
console.log(checks.map(c => `${c.id}: ${c.count}`).join(' · '));

assert.deepStrictEqual(handles('default-colours'), ['herringford-walnut']);
assert.deepStrictEqual(handles('split-colours'), ['tommy-bisque-oasis']);
assert(/same CFS product as "Bisque Oasis" → merge/.test(by['split-colours'].rows[0].detail));
assert.deepStrictEqual(handles('not-in-cfs'), ['herringford-walnut', 'posey-bed-navy']);   // UD-999, UD-777
assert.deepStrictEqual(handles('sku-typo'), ['posey-bed-navy']); assert(/"UD-101- 5" → UD-101-5/.test(by['sku-typo'].rows[0].detail));
assert.deepStrictEqual(handles('wrong-vendor'), ['noor-tv-unit-medium-brown', 'ortho-2', 'ortho-3']);   // Store Brand products with Urban Deco SKUs are flagged too assert(/SKUs are in: Livingfurn \(1\)/.test(by['wrong-vendor'].rows[0].detail));
assert.deepStrictEqual(handles('no-sku'), ['posey-bed-navy']);
assert.deepStrictEqual(handles('dup-sku'), ['posey-bed-navy']); assert(/UD-101 on Navy \+ Navy/.test(by['dup-sku'].rows[0].detail));
assert.deepStrictEqual(handles('same-own-item'), ['ortho-2', 'ortho-3']);
assert.deepStrictEqual(handles('missing-ids'), ['ortho-2', 'ortho-3']);
assert.deepStrictEqual(handles('url-title'), ['noor-tv-unit-medium-brown']); assert(/Title says "natural".*URL says "brown"/.test(by['url-title'].rows[0].detail), by['url-title'].rows[0].detail);
assert.deepStrictEqual(handles('unknown-vendor'), ['ortho-2', 'ortho-3']);
assert(!checks.some(c => c.rows.some(r => r.handle === 'milan-table-white')), 'healthy product is in no list');
console.log('STORE HEALTH TESTS PASSED');
