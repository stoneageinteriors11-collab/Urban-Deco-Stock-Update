const express  = require('express');
const axios    = require('axios');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');

const router   = express.Router();

// We store the access token in a local file so it survives server restarts
// On Render, use an env var instead (see README)
const TOKEN_FILE = path.join(__dirname, '../.shopify_token');

function saveToken(token) {
  // Always set in-process env var (works within this dyno instance)
  process.env.SHOPIFY_ACCESS_TOKEN = token;
  // Best-effort file write — may fail on Render's ephemeral FS, that's OK
  try {
    fs.writeFileSync(TOKEN_FILE, token, 'utf8');
    console.log('✅ Token saved to file and env var.');
  } catch (e) {
    console.warn('⚠️  Could not write token file (ephemeral FS?). Token is set in env var for this process only.');
    console.warn('   → Copy the token from /auth/token?reveal=1 into your Render SHOPIFY_ACCESS_TOKEN env var to make it permanent.');
  }
}

function loadToken() {
  // Check env var first — but guard against empty string (which is falsy but shouldn't clear a valid token)
  const envToken = process.env.SHOPIFY_ACCESS_TOKEN;
  if (envToken && envToken.trim()) return envToken.trim();

  // Fall back to file
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) {
      process.env.SHOPIFY_ACCESS_TOKEN = t; // cache in env for subsequent requests
      console.log('ℹ️  Token loaded from file and cached in env var.');
    }
    return t || null;
  } catch { return null; }
}

// ── GET /auth ─────────────────────────────────────────────────────────────────
// Starts the OAuth flow — redirects to Shopify
router.get('/', (req, res) => {
  const shop    = process.env.SHOPIFY_STORE;
  const apiKey  = process.env.SHOPIFY_API_KEY;
  const scopes  = process.env.SCOPES || 'read_products,write_products,read_locations,read_inventory,write_inventory';
  const appUrl  = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  const redirect = `${appUrl}/auth/callback`;
  const nonce   = crypto.randomBytes(16).toString('hex');

  // Store nonce in memory (simple — fine for single-user internal tool)
  global._shopifyNonce = nonce;

  const authUrl = `https://${shop}/admin/oauth/authorize?` +
    `client_id=${apiKey}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirect)}&state=${nonce}`;

  res.redirect(authUrl);
});

// ── GET /auth/callback ────────────────────────────────────────────────────────
// Shopify redirects here after the user approves
router.get('/callback', async (req, res) => {
  const { code, state, hmac, shop } = req.query;

  // Validate state/nonce
  if (state !== global._shopifyNonce) {
    return res.status(403).send('Invalid state parameter. Please try connecting again.');
  }

  // Validate HMAC
  const secret = process.env.SHOPIFY_API_SECRET;
  const params = Object.keys(req.query)
    .filter(k => k !== 'hmac')
    .sort()
    .map(k => `${k}=${req.query[k]}`)
    .join('&');
  const digest = crypto.createHmac('sha256', secret).update(params).digest('hex');
  if (digest !== hmac) {
    return res.status(403).send('HMAC validation failed. Request may have been tampered with.');
  }

  try {
    // Exchange code for permanent access token
    const tokenRes = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id:     process.env.SHOPIFY_API_KEY,
      client_secret: secret,
      code,
    });

    const accessToken = tokenRes.data.access_token;
    saveToken(accessToken);

    console.log(`✅ Shopify OAuth complete. Access token saved.`);
    res.redirect('/?connected=true');

  } catch (err) {
    console.error('OAuth callback error:', err.response?.data || err.message);
    res.status(500).send('Failed to get access token from Shopify. Please try again.');
  }
});

// ── GET /auth/status ──────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  const token = loadToken();
  res.json({ connected: !!token });
});

// ── GET /auth/token ───────────────────────────────────────────────────────────
// Returns the current access token so it can be copied into Render env vars.
// Only the first/last 4 chars are sent by default; pass ?reveal=1 to get full token.
router.get('/token', (req, res) => {
  const token = loadToken();
  if (!token) return res.json({ token: null });
  if (req.query.reveal === '1') return res.json({ token });
  // Masked preview so user can confirm it loaded without exposing it in screenshots
  const masked = token.slice(0, 4) + '•'.repeat(Math.max(0, token.length - 8)) + token.slice(-4);
  res.json({ token: masked });
});

// ── GET /auth/disconnect ──────────────────────────────────────────────────────
router.get('/disconnect', (req, res) => {
  try { fs.unlinkSync(TOKEN_FILE); } catch (_) {}
  delete process.env.SHOPIFY_ACCESS_TOKEN;
  res.json({ success: true });
});

module.exports = { router, loadToken };