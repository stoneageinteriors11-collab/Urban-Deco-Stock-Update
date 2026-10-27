// "Default" colour check — suggestions
const assert = require('assert');
const { findDefaults, titleColour } = require('../Claude outputs/default-colours-tool/new/utils/defaultColour');

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
console.log('DEFAULT COLOUR TESTS PASSED');
