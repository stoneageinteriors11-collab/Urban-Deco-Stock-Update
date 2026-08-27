# Variant Sync Tool

Compares **Urban Deco (Shopify)** variants against the **Choice Furniture Superstore** Froogle variant feed and lets you identify and delete orphaned variants — variants that exist in Shopify but have been removed from the non-Shopify site.

---

## How it works

| Input | File | Key column |
|---|---|---|
| Non-Shopify variant feed | `215_Froogle_Variant_*.csv` | `Shopify SKU` |
| Shopify export (1 or 2 files) | `products_export_1.csv` etc. | `Variant SKU` |

Both share the same format: `UD-{ProductId}-{VariantAttrId}` — e.g. `UD-144246-16985763`

---

## Shopify Connection — OAuth via Partner Dashboard

Since Shopify deprecated legacy custom apps in January 2026, this tool uses OAuth with your Partner Dashboard app credentials.

**Getting your credentials from Partner Dashboard:**

1. Go to [partners.shopify.com](https://partners.shopify.com)
2. Click **Apps** → your app (e.g. "Urban Deco Stock Update")
3. Click **App settings** → copy the **Client ID** and **Client Secret**
4. Paste them into `.env` as `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`

**One more step — add the callback URL to your Partner Dashboard app:**
1. In your app settings → **App setup**
2. Under **URLs** → **Allowed redirection URL(s)** → add:
   - Local:  `http://localhost:3000/auth/callback`
   - Render: `https://your-app.onrender.com/auth/callback`
3. Save

Then when you run the tool, click **"Connect to Shopify"** in the UI — it handles the OAuth flow automatically and saves the token.

---

## Local Setup

```bash
# 1. Clone / copy the project
cd variant-sync-tool

# 2. Install dependencies
npm install

# 3. Create your .env file
cp .env.example .env
# Then edit .env with your values

# 4. Run the app
npm run dev       # development (auto-restart)
npm start         # production
```

Open http://localhost:3000

---

## .env Configuration

```env
SHOPIFY_STORE=urbandeco.myshopify.com
SHOPIFY_API_KEY=your_client_id_from_partner_dashboard
SHOPIFY_API_SECRET=your_client_secret_from_partner_dashboard
SCOPES=read_products,write_products
APP_URL=https://your-app.onrender.com
PORT=3000
```

---

## Deploy to Render

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → **New → Web Service**
3. Connect your GitHub repo
4. Set:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node
5. Add your environment variables under **Environment** tab:
   - `SHOPIFY_STORE`
   - `SHOPIFY_API_TOKEN`
   - `SHOPIFY_API_VERSION`
6. Click **Deploy**

---

## How to Use the App

### Step 1 — Upload Files
- Upload the **non-Shopify variant feed** CSV (`215_Froogle_Variant_*.csv`)
- Upload **Shopify export file 1** (`products_export_1.csv`)
- Optionally upload **Shopify export file 2** if your export was split

### Step 2 — Settings
- Enter your **Shopify store domain** and **API token**
- Click **Test Connection** to verify
- Leave **Dry Run ON** for the first run (safe — no changes made)

### Step 3 — Compare
- Click **Run Comparison**
- Review the results table: filter by Orphaned / OK, search, paginate
- Select orphaned variants using checkboxes (or "Select all orphaned")
- Click **Delete Selected Orphaned** — with Dry Run ON it only logs; turn it OFF to apply

---

## File Structure

```
variant-sync-tool/
├── server.js              # Express app entry point
├── routes/
│   ├── upload.js          # File upload + compare logic
│   └── shopify.js         # Shopify API: delete variants, test connection
├── utils/
│   ├── parseCSV.js        # CSV parsing + column extraction
│   └── matchVariants.js   # Comparison logic
├── public/
│   └── index.html         # Full UI (single page, no build step)
├── uploads/               # Temp folder — files deleted after processing
├── .env.example           # Copy to .env and fill in values
└── package.json
```
