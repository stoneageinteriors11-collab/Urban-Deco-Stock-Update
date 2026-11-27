// Shopify THROTTLED handling — shared caller + the order-ahead run (fake CFS + fake Shopify, nothing real is called)
const assert = require('assert');
const axios = require('axios');
process.env.SHOPIFY_STORE = 'mock.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = 'x';

const G = require('../utils/shopifyGql');
const waits = [];
G.sleep = async ms => { waits.push(ms); };          // no real waiting in tests

const throttledReply = (available = 200) => ({ data: {
  errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
  extensions: { cost: { requestedQueryCost: 1000, actualQueryCost: null,
    throttleStatus: { maximumAvailable: 2000, currentlyAvailable: available, restoreRate: 100 } } },
} });
const okReply = (data, available = 1900) => ({ data: { data,
  extensions: { cost: { requestedQueryCost: 10, actualQueryCost: 10,
    throttleStatus: { maximumAvailable: 2000, currentlyAvailable: available, restoreRate: 100 } } } } });
const client = { url: 'https://mock/graphql.json', headers: {} };

(async () => {
  // ── 1. shared caller ──
  const gql = G.createGql();
  {
    let calls = 0; waits.length = 0;
    axios.post = async () => (++calls <= 2 ? throttledReply() : okReply({ shop: { name: 'x' } }));
    const d = await gql(client, 'query { shop { name } }');
    assert.deepStrictEqual(d, { shop: { name: 'x' } });
    assert.strictEqual(calls, 3, 'THROTTLED twice, then success');
    assert.deepStrictEqual(waits, [8000, 8000], '(1000 - 200) / 100 = 8s each');
  }
  {
    let calls = 0; waits.length = 0;
    axios.post = async () => { calls++; return throttledReply(); };
    await assert.rejects(gql(client, 'query { shop { name } }'), e => e.code === 'THROTTLED' && /still THROTTLED after 5 tries/.test(e.message));
    assert.strictEqual(calls, 5, 'stops after 5 tries');
    assert.strictEqual(waits.length, 4);
  }
  {
    waits.length = 0;
    axios.post = async () => throttledReply(995);               // nearly enough points → minimum 1s
    await assert.rejects(gql(client, 'q'));
    assert(waits.every(w => w === 1000), waits.join());
  }
  {
    waits.length = 0;                                             // low bucket after success → wait to ~50 %
    axios.post = async () => okReply({ a: 1 }, 100);
    await gql(client, 'q');
    assert.deepStrictEqual(waits, [9000], '(1000 - 100) / 100 = 9s');
    waits.length = 0;
    axios.post = async () => okReply({ a: 1 }, 500);            // 25 % full → no pause
    await gql(client, 'q');
    assert.deepStrictEqual(waits, []);
  }
  {
    let calls = 0; waits.length = 0;                              // 429 retry kept
    axios.post = async () => { if (++calls < 3) { const e = new Error('429'); e.response = { status: 429 }; throw e; } return okReply({ ok: true }); };
    assert.deepStrictEqual(await gql(client, 'q'), { ok: true });
    assert.deepStrictEqual(waits, [2000, 4000]);
  }
  {
    axios.post = async () => ({ data: { errors: [{ message: 'Field x does not exist' }] } });   // other errors still throw at once
    await assert.rejects(gql(client, 'q'), /GraphQL error: Field x does not exist/);
  }

  // ── 2. order-ahead run (All brands path, one brand here) ──
  const ukDay = off => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(Date.now() + off * 864e5));
  const due = ukDay(5), cutoff = ukDay(30);
  const feed = [{ productId: 2, brandName: 'J-Line', productName: 'Vase', deliveryTime: '6-8 Weeks', stockStatus: 'OUT OF STOCK', onHand: 0, dueDate: due, variants: [] }];
  axios.get = async () => ({ data: feed });
  const mfAlias = o => Object.fromEntries(['inoutstock', 'vnotificationtitle', 'duedate', 'stock_status_override', 'override_cutoff'].map(k => ['mf_' + k, o[k] != null ? { value: o[k] } : null]));
  const product = { id: 'P2', handle: 'vase', title: 'Vase', vendor: 'J-Line', status: 'ACTIVE', ...mfAlias({ inoutstock: 'OUT OF STOCK' }),
    variants: { nodes: [{ id: 'V2', sku: 'UD-2', title: 'Default', ...mfAlias({ inoutstock: 'OUT OF STOCK', duedate: due }),
      inventoryItem: { id: 'I2', tracked: true, inventoryLevel: { quantities: [{ name: 'available', quantity: 0 }] } } }] } };

  let productsThrottles = 0, productsQuery = '';
  const writes = [];
  axios.post = async (url, body) => {
    const q = body.query;
    if (/locations/.test(q)) return okReply({ locations: { edges: [{ node: { id: 'L1', name: 'Shop' } }] } });
    if (/products\(/.test(q)) {
      productsQuery = q;
      if (productsThrottles > 0) { productsThrottles--; return throttledReply(); }
      return okReply({ products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [JSON.parse(JSON.stringify(product))] } });
    }
    if (/metafieldsSet/.test(q)) { writes.push(...body.variables.metafields); return okReply({ metafieldsSet: { userErrors: [] } }); }
    if (/inventorySetQuantities/.test(q)) return okReply({ inventorySetQuantities: { userErrors: [] } });
    throw new Error('unhandled ' + q.slice(0, 60));
  };

  const express = require('express');
  const app = express(); app.use(express.json());
  app.use('/api/brands', require('../routes/brandsync'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = async body => {
    const t = await (await fetch(base + '/api/brands/order-ahead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).text();
    return t.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))).pop();
  };
  const errLines = [];
  const realErr = console.error;
  console.error = (...a) => { errLines.push(a.join(' ')); };
  try {
    // THROTTLED twice on the products page, then OK → run completes and writes
    productsThrottles = 2;
    let r = await run({ brandIds: [363], cutoff, dryRun: false });
    assert.strictEqual(r.type, 'done'); assert(!r.error, r.error);
    assert.strictEqual(r.counts.products, 1); assert.strictEqual(r.counts.newAhead, 1); assert.strictEqual(r.counts.failed, 0);
    assert.deepStrictEqual(writes.map(m => `${m.ownerId}.${m.key}=${m.value}`).sort(),
      [`P2.stock_status_override=IN STOCK`, `V2.override_cutoff=${cutoff}`, `V2.stock_status_override=IN STOCK`]);
    // Only the custom metafields the code reads, by alias — no metafields(first: 50)
    assert(!/metafields\(first/.test(productsQuery), 'no metafields(first: 50)');
    for (const k of ['inoutstock', 'vnotificationtitle', 'duedate', 'stock_status_override', 'override_cutoff'])
      assert(productsQuery.includes(`mf_${k}: metafield(namespace: "custom", key: "${k}")`), k);
    // Aliased values are read: an existing override with the same cut-off and qty 5 is "already orderable"
    product[`mf_stock_status_override`] = { value: 'IN STOCK' };
    product.variants.nodes[0].mf_stock_status_override = { value: 'IN STOCK' };
    product.variants.nodes[0].mf_override_cutoff = { value: cutoff };
    product.variants.nodes[0].inventoryItem.inventoryLevel.quantities[0].quantity = 5;
    r = await run({ brandIds: [363], cutoff, dryRun: true });
    assert.strictEqual(r.counts.keptAhead, 1, JSON.stringify(r.counts)); assert.strictEqual(r.counts.newAhead, 0);

    // Always THROTTLED → stops after 5 tries with a clear message, and it's in the server log
    productsThrottles = Infinity; errLines.length = 0;
    r = await run({ brandIds: [363], cutoff, dryRun: true });
    assert.strictEqual(r.type, 'done');
    assert(/still THROTTLED after 5 tries/.test(r.error || ''), r.error);
    assert(errLines.some(l => /\[order-ahead\] brand=J-Line handle=- — Shopify rate limit: still THROTTLED after 5 tries/.test(l)), errLines.join('\n'));
  } finally { console.error = realErr; server.close(); }
  console.log('✓ shopifyThrottle tests passed');
})().catch(e => { console.error(e); process.exit(1); });
