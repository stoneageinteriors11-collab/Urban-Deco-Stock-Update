/**
 * Shared Shopify Admin GraphQL caller — used by every route.
 *
 * Shopify's cost-based rate limit comes back as HTTP 200 with
 * errors[].extensions.code === "THROTTLED" (not a 429), so it is handled here:
 *   - THROTTLED  → wait until the bucket has enough points for this query, then retry
 *                  (up to MAX_THROTTLE_TRIES tries in total)
 *   - HTTP 429 / 5xx (and, where asked, network errors) → retry as before
 *   - after every successful reply, if the bucket is below 20 % full, pause until it
 *     has refilled to about 50 %, so a long run doesn't keep hitting the limit
 *
 * Usage:  const gql = createGql({ timeout: 30000 });   await gql(client, QUERY, vars)
 */
const axios = require('axios');

const MAX_THROTTLE_TRIES = 5;
const LOW_BUCKET = 0.2;      // below 20 % of maximumAvailable → pause
const REFILL_TO  = 0.5;      // … until about 50 %

// Looked up through module.exports at call time so tests can replace it
const realSleep = ms => new Promise(r => setTimeout(r, ms));

// Cost info: Shopify puts it in the top-level `extensions.cost`; also accept it on an error
function costOf(body) {
  return body?.extensions?.cost
    || (body?.errors || []).map(e => e?.extensions?.cost).find(Boolean)
    || null;
}

// Wait for a THROTTLED reply: (requestedQueryCost - currentlyAvailable) / restoreRate seconds, min 1s
function throttleWaitMs(cost, attempt = 1) {
  const t = cost?.throttleStatus;
  const requested = cost?.requestedQueryCost;
  if (t && Number(t.restoreRate) > 0 && requested != null) {
    const secs = (Number(requested) - Number(t.currentlyAvailable || 0)) / Number(t.restoreRate);
    return Math.max(1000, Math.ceil(secs * 1000));
  }
  return Math.max(1000, 1000 * attempt);   // no cost info — back off 1s, 2s, 3s …
}

// Pause after a successful reply when the bucket is low (0 = no pause needed)
function refillWaitMs(cost) {
  const t = cost?.throttleStatus;
  if (!t || !(Number(t.restoreRate) > 0) || !(Number(t.maximumAvailable) > 0)) return 0;
  const max = Number(t.maximumAvailable), cur = Number(t.currentlyAvailable || 0);
  if (cur >= max * LOW_BUCKET) return 0;
  return Math.ceil(((max * REFILL_TO - cur) / Number(t.restoreRate)) * 1000);
}

function isNetworkError(err) {
  if (err.response) return false;
  return ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNABORTED'].includes(err.code)
    || /socket hang up|timeout/i.test(err.message || '');
}

/**
 * opts:
 *   timeout       axios timeout (ms)                      default 30000
 *   httpRetries   retries on 429 / 5xx (/ network)        default 3
 *   retryNetwork  also retry network errors               default false
 *   httpDelay     attempt → ms before an HTTP retry       default attempt * 2000
 */
function createGql(opts = {}) {
  const timeout = opts.timeout ?? 30000;
  const httpRetries = opts.httpRetries ?? 3;
  const retryNetwork = !!opts.retryNetwork;
  const httpDelay = opts.httpDelay || (attempt => attempt * 2000);

  return async function gql(client, query, variables = {}) {
    let throttleTry = 0, httpTry = 0;
    for (;;) {
      let res;
      try {
        res = await axios.post(client.url, { query, variables }, { headers: client.headers, timeout });
      } catch (err) {
        const status = err.response?.status;
        const net = retryNetwork && isNetworkError(err);
        if ((status === 429 || (status >= 500 && status < 600) || net) && httpTry < httpRetries) {
          httpTry++;
          const delay = httpDelay(httpTry);
          const reason = net ? `network error (${err.code || err.message})` : `HTTP ${status}`;
          console.warn(`  ⚠ Shopify ${reason} — retrying in ${delay}ms (attempt ${httpTry}/${httpRetries})`);
          await module.exports.sleep(delay);
          continue;
        }
        throw err;
      }

      const body = res.data || {};
      const cost = costOf(body);
      if (body.errors) {
        const throttled = body.errors.some(e => e?.extensions?.code === 'THROTTLED');
        if (throttled) {
          throttleTry++;
          if (throttleTry >= MAX_THROTTLE_TRIES) {
            const err = new Error(`Shopify rate limit: still THROTTLED after ${MAX_THROTTLE_TRIES} tries — stopped. Wait a minute and run it again.`);
            err.code = 'THROTTLED';
            throw err;
          }
          const wait = throttleWaitMs(cost, throttleTry);
          console.warn(`  ⚠ Shopify THROTTLED — waiting ${(wait / 1000).toFixed(1)}s (try ${throttleTry}/${MAX_THROTTLE_TRIES})`);
          await module.exports.sleep(wait);
          continue;
        }
        throw new Error(`GraphQL error: ${body.errors.map(e => e.message).join('; ')}`);
      }

      const pause = refillWaitMs(cost);
      if (pause > 0) await module.exports.sleep(pause);
      return body.data;
    }
  };
}

// One line in the Render logs for a failed run / product
function logRunError(step, { brand, handle } = {}, err) {
  console.error(`  ✗ [${step}] brand=${brand || '-'} handle=${handle || '-'} — ${err?.message || err}`);
}

module.exports = { createGql, throttleWaitMs, refillWaitMs, logRunError, MAX_THROTTLE_TRIES, sleep: realSleep };
