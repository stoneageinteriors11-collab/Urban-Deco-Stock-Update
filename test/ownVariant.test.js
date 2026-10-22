const assert = require('assert');
const { findOwnVariants: own } = require('../utils/ownVariant');
const v = (id, sku, opts) => ({ id, sku, title: Object.values(opts).join(' / '), selectedOptions: Object.entries(opts).map(([name, value]) => ({ name, value })) });
// Carrera: three products, each with all three colours
const carrera = [v('w', 'UD-1262193', { Colour: 'White' }), v('b', 'UD-1262196', { Colour: 'Black' }), v('t', 'UD-1262194', { Colour: 'Beige' })];
let r = own({ title: 'Carrera Side Table - Round - Black Marquina Marble', handle: 'carrera-side-table-round-black-marquina-engineered-marble' }, carrera);
assert(r.ok && r.ownIds.join() === 'b', JSON.stringify(r));
r = own({ title: 'Carrera Side Table - Round - White Marble', handle: 'carrera-side-table-round-white-marble' }, carrera);
assert(r.ok && r.ownIds.join() === 'w');
r = own({ title: 'Carrera Side Table - Round - Travertine Beige Marble', handle: 'carrera-side-table-round-travertine-beige-engineered-marble' }, carrera);
assert(r.ok && r.ownIds.join() === 't');
// seats
const sofa = [v('2', 'UD-1-1', { Size: '2 Seater' }), v('3', 'UD-2-2', { Size: '3 Seater' })];
r = own({ title: 'Bentley Recliner Sofa - 2 Seater - Grey Leather', handle: 'bentley-recliner-sofa-2-seater-grey-leather' }, sofa);
assert(r.ok && r.ownIds.join() === '2');
// manual / electric
const rec = [v('m', 'UD-5-1', { Type: 'Manual' }), v('e', 'UD-6-2', { Type: 'Electric' })];
r = own({ title: 'London Recliner Chair - Electric - Brown', handle: 'london-recliner-chair-electric-brown' }, rec);
assert(r.ok && r.ownIds.join() === 'e');
// colour x size: sizes not in title → all White sizes are "own"
const milan = ['White', 'Grey'].flatMap(c => ['160cm Table', '180cm Table'].map(s => v(c[0] + s[1], `UD-${c.length}-${s[1]}`, { Color: c, Size: s })));
r = own({ title: 'Milan Dining Table - White Marble - Sizes Available', handle: 'milan-dining-table-white-marble-sizes-available' }, milan);
assert(r.ok && r.ownIds.sort().join() === 'W6,W8', JSON.stringify(r));
// nothing in the title → can't tell
r = own({ title: 'Carrera Side Table', handle: 'carrera-side-table' }, carrera);
assert(!r.ok);
// title names two colours → can't tell
r = own({ title: 'Carrera Side Table - Black and White', handle: 'x' }, carrera);
assert(!r.ok && /more than one/.test(r.reason));
// "Default" variants → use CFS names (Bentley: both variants "Default")
const bent = [{ id: 'g', sku: 'UD-1268112-17353724', title: 'Default', selectedOptions: [{ name: 'Title', value: 'Default Title' }] },
              { id: 'br', sku: 'UD-1268116-17353736', title: 'Default', selectedOptions: [{ name: 'Title', value: 'Default Title' }] }];
const names = new Map([['1268112', 'Bentley Grey Leather Recliner Sofa Armchair'], ['1268116', 'Bentley Brown Leather Recliner Sofa Armchair']]);
r = own({ title: 'Bentley Recliner Armchair - Brown Leather', handle: 'bentley-recliner-armchair-brown-leather' }, bent, names);
assert(r.ok && r.ownIds.join() === 'br', JSON.stringify(r));
// Default variants, one SKU gone from CFS, title matches the remaining name → that one is own
r = own({ title: 'Bentley Recliner Armchair - Grey Leather', handle: 'x' }, bent, new Map([['1268116', 'Bentley Brown Leather Recliner Sofa Armchair']]));
assert(!r.ok || r.ownIds.join() !== 'br', 'never picks the Brown one for a Grey title');
// single variant
r = own({ title: 'X', handle: 'x' }, [carrera[0]]); assert(r.ok && r.ownIds.join() === 'w');
console.log('OWN VARIANT TESTS PASSED');
