// "Default" colour check — suggestions
const assert = require('assert');
const { findDefaults, titleColour } = require('../utils/defaultColour');

const v = (sku, colour, size) => ({ id: 'v' + sku, sku, selectedOptions: [{ name: 'Color', value: colour }, ...(size ? [{ name: 'Size', value: size }] : [])] });
const opt = (name, ...vals) => ({ id: 'o' + name, name, optionValues: vals.map(x => ({ id: `ov-${name}-${x}`, name: x })) });
const names = {
  1258290: 'Herringford Oak 2 Drawer Bedside Cabinet', 1274063: 'Herringford Walnut 2 Drawer Bedside Cabinet',
  1260031: 'Axel Walnut Fluted Round Coffee Table', 1258282: 'Axel Black Round Coffee Table',
  1260037: 'Belmont Grey and Oak Ottoman Storage Bed', 1276000: 'Toon Black Dining Chair', 1276001: 'Toon Natural Dining Chair',
};
const cfsName = sku => names[(/^UD-(\d+)/.exec(sku) || [])[1]] || null;

// A — Herringford: same SKU sold as "Oak" on its own page + CFS name difference → high
let skuHomes = new Map([['UD-1258290', [{ handle: 'herringford-bedside-cabinet-2-drawer-oak', title: 'Herringford Bedside Cabinet - 2 Drawer - Oak', status: 'ACTIVE', options: [{ name: 'Color', value: 'Oak' }] }]]]);
let r = findDefaults({ id: 'p1', title: 'Herringford Bedside Cabinet - 2 Drawer - Walnut', handle: 'herringford-bedside-cabinet-2-drawer-walnut', iid: '1274063',
  options: [opt('Color', 'Brown', 'Default')], variants: [v('UD-1274063', 'Brown'), v('UD-1258290', 'Default')] }, { cfsName, skuHomes });
assert.strictEqual(r.length, 1); assert.strictEqual(r[0].type, 'A');
assert.strictEqual(r[0].suggestion, 'Oak'); assert.strictEqual(r[0].confidence, 'high', JSON.stringify(r[0]));
assert.deepStrictEqual(r[0].sources.sort(), ['cfs-name', 'same-sku']);
assert.strictEqual(r[0].valueId, 'ov-Color-Default');

// A — Axel: Default is the product's OWN CFS product → title colour + CFS difference agree
r = findDefaults({ id: 'p2', title: 'Axel Round Coffee Table - Walnut Fluted', handle: 'axel', iid: '1260031',
  options: [opt('Color', 'Default', 'Black')], variants: [v('UD-1260031', 'Default'), v('UD-1258282', 'Black')] }, { cfsName });
assert.strictEqual(r[0].suggestion, 'Walnut Fluted'); assert.strictEqual(r[0].confidence, 'high', JSON.stringify(r[0]));

// B — Belmont: only colour is Default, has sizes; title "Grey and Oak" and CFS colour words "Grey Oak" agree
r = findDefaults({ id: 'p3', title: 'Belmont Ottoman Storage Bed - 4ft 6in Double - Grey and Oak', handle: 'belmont', iid: '1260037',
  options: [opt('Color', 'Default'), opt('Size', '4ft 6in Double', '5ft King Size')],
  variants: [v('UD-1260037-1', 'Default', '4ft 6in Double'), v('UD-1260037-2', 'Default', '5ft King Size')] }, { cfsName });
assert.strictEqual(r[0].type, 'B'); assert.strictEqual(r[0].variants, 2);
assert.strictEqual(r[0].suggestion, 'Grey and Oak'); assert.strictEqual(r[0].confidence, 'high', JSON.stringify(r[0]));

// clash — the suggestion already exists as another value (duplicate variant?)
r = findDefaults({ id: 'p4', title: 'Toon Dining Chair - Natural', handle: 'toon', iid: '1276001',
  options: [opt('Color', 'Natural', 'Default Title')], variants: [v('UD-1276001', 'Natural'), v('UD-1276001', 'Default Title')] }, { cfsName });
assert.strictEqual(r[0].confidence, 'clash', JSON.stringify(r[0]));

// nothing to go on → no suggestion
r = findDefaults({ id: 'p5', title: 'Ice Glass Round Side Table', handle: 'ice', iid: null,
  options: [opt('Color', 'Default')], variants: [v('UD-999', 'Default')] }, { cfsName });
assert.strictEqual(r[0].type, 'C'); assert.strictEqual(r[0].suggestion, ''); assert.strictEqual(r[0].confidence, 'none');

// Shopify's own simple product (Title = Default Title) → not listed
assert.deepStrictEqual(findDefaults({ options: [opt('Title', 'Default Title')], variants: [{ sku: 'UD-1', selectedOptions: [{ name: 'Title', value: 'Default Title' }] }] }), []);

// title colour part
assert.strictEqual(titleColour('Grover Bed - Natural - Rattan and Oak - Sizes Available'), 'Natural');
assert.strictEqual(titleColour('Saint Wooden Bed - Sizes Available'), '');
// ── split colour → merge ──
const cv = (sku, colour, size) => ({ id: 'id-' + sku, sku, selectedOptions: [{ name: 'Color', value: colour }, { name: 'Size', value: size }] });
const sizes = ['2 Chairs', '4 Chairs', '6 Chairs', '8 Chairs', '10 Chairs', '12 Chairs'];
// Tommy: Bisque Oasis 2 Chairs + Default Title 4–12 Chairs, all UD-1276316 → merge into Bisque Oasis
r = findDefaults({ id: 't', title: 'Tommy Swivel Dining Armchair - Set of 2 - Bisque Oasis - Fabric and Metal', handle: 'tommy', iid: '1276316',
  options: [opt('Color', 'Bisque Oasis', 'Default Title'), opt('Size', ...sizes)],
  variants: sizes.map((z, i) => cv(`UD-1276316-${708 + i}`, i ? 'Default Title' : 'Bisque Oasis', z)) }, { cfsName });
assert.strictEqual(r[0].action, 'merge'); assert.strictEqual(r[0].mergeInto, 'Bisque Oasis'); assert.strictEqual(r[0].confidence, 'merge');
assert.deepStrictEqual(r[0].moves.map(m => m.label), sizes.slice(1)); assert(r[0].moves.every(m => !m.conflict));
// Basic Fineer: Default (1276123) merges into "Fineer Natural and Black" (1276123); Black (1276124) is left alone
r = findDefaults({ id: 'b', title: 'Basic Dining Chair - Set of 2 - Fineer Natural and Black - Synthetic', handle: 'basic', iid: '1276123',
  options: [opt('Color', 'Fineer Natural and Black', 'Default Title', 'Black'), opt('Size', ...sizes)],
  variants: [...sizes.map((z, i) => cv(`UD-1276123-${646 + i}`, i ? 'Default Title' : 'Fineer Natural and Black', z)), ...sizes.map((z, i) => cv(`UD-1276124-${652 + i}`, 'Black', z))] }, { cfsName });
assert.strictEqual(r[0].action, 'merge'); assert.strictEqual(r[0].mergeInto, 'Fineer Natural and Black'); assert.strictEqual(r[0].moves.length, 5);
// Toon BLACK page: Default variants are the NATURAL product's SKUs (1276113) — not on this page as a colour → no merge, normal rename
skuHomes = new Map([['UD-1276113-586', [{ handle: 'toon-natural', title: 'Toon - Natural', status: 'ACTIVE', options: [{ name: 'Color', value: 'Natural' }] }]]]);
r = findDefaults({ id: 'tb', title: 'Toon Dining Chair - Set of 2 - Black', handle: 'toon-black', iid: '1276114',
  options: [opt('Color', 'Black', 'Default Title'), opt('Size', ...sizes)],
  variants: [...sizes.map((z, i) => cv(`UD-1276114-${591 + i}`, 'Black', z)), cv('UD-1276113-586', 'Default Title', '4 Chairs')] }, { cfsName, skuHomes });
assert.strictEqual(r[0].action, 'rename'); assert.strictEqual(r[0].suggestion, 'Natural');
// a size that already exists under the target colour → conflict
r = findDefaults({ id: 'c', title: 'X - Bisque Oasis', handle: 'x', iid: '1',
  options: [opt('Color', 'Bisque Oasis', 'Default Title'), opt('Size', '2 Chairs', '4 Chairs')],
  variants: [cv('UD-1-1', 'Bisque Oasis', '2 Chairs'), cv('UD-1-2', 'Bisque Oasis', '4 Chairs'), cv('UD-1-3', 'Default Title', '4 Chairs')] }, { cfsName });
assert.strictEqual(r[0].confidence, 'clash'); assert.strictEqual(r[0].moves[0].conflict, true);
console.log('DEFAULT COLOUR TESTS PASSED');
