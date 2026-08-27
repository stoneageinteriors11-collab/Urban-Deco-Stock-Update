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
  fs.writeFileSync(TOKEN_FILE, token, 'utf8');
  process.env.SHOPIFY_ACCESS_TOKEN = token;
}

function loadToken() {
  if (process.env.SHOPIFY_ACCESS_TOKEN) return process.env.SHOPIFY_ACCESS_TOKEN;
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) process.env.SHOPIFY_ACCESS_TOKEN = t;
    return t || null;
  } catch { return null; }
}

// ── GET /auth ─────────────────────────────────────────────────────────────────
// Starts the OAuth flow — redirects to Shopify
router.get('/', (req, res) => {
  const shop    = process.env.SHOPIFY_STORE;
  const apiKey  = process.env.SHOPIFY_API_KEY;
  const scopes  = process.env.SCOPES || 'read_products,write_products';
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

// ── GET /auth/disconnect ──────────────────────────────────────────────────────
router.get('/disconnect', (req, res) => {
  try { fs.unlinkSync(TOKEN_FILE); } catch (_) {}
  delete process.env.SHOPIFY_ACCESS_TOKEN;
  res.json({ success: true });
});

module.exports = { router, loadToken };
