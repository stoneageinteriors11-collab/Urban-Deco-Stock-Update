# Urban Deco Stock Sync Tool

A multi-step automation tool that syncs **Urban Deco (Shopify)** products and variants against the **Choice Furniture Superstore (CFS)** stock feed — handling stock updates, calendar/delivery date visibility, and scheduled automation.

---

## What It Does

| Step | Name | Description |
|------|------|-------------|
| Step 1–4 | Variant Sync | Upload CFS Froogle CSV + Shopify export → compare → delete orphaned variants |
| Step 5 | Stock Sync | Pulls live CFS stock via API → updates Shopify inventory levels |
| Step 6 | Calendar Sync | Identifies Next Day products in CFS → sets `showcalendar` / `vshowcalendar` metafields on Shopify |
| Auto | Scheduled Sync | GitHub Actions runs Step 5 then Step 6 automatically every 6 hours |

---

## Shopify Connection — OAuth via Partner Dashboard

**Getting your credentials:**

1. Go to [partners.shopify.com](https://partners.shopify.com)
2. Click **Apps** → your app → **App settings** → copy **Client ID** and **Client Secret**
3. Paste into `.env` as `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`

**Add callback URL to Partner Dashboard app:**
- App settings → **App setup** → **Allowed redirection URL(s)**
  - Local: `http://localhost:3000/auth/callback`
  - Render: `https://your-app.onrender.com/auth/callback`

Then click **Connect to Shopify** in the UI — it handles OAuth automatically.

---

## Local Setup

```bash
cd variant-sync-tool
npm install
cp .env.example .env   # fill in your values
npm run dev            # development (auto-restart)
npm start              # production
```

Open http://localhost:3000

---

## .env Configuration

```env
SHOPIFY_STORE=urbandeco.myshopify.com
SHOPIFY_API_KEY=your_client_id_from_partner_dashboard
SHOPIFY_API_SECRET=your_client_secret_from_partner_dashboard
SHOPIFY_API_TOKEN=your_access_token
SHOPIFY_API_VERSION=2024-01
SCOPES=read_products,write_products
APP_URL=https://your-app.onrender.com
PORT=3000
RENDER_EXTERNAL_URL=https://your-app.onrender.com
CRON_SECRET=your_random_secret_here
```

Generate `CRON_SECRET` with: `openssl rand -hex 32`

---

## Deploy to Render

1. Push repo to GitHub
2. Render Dashboard → **New → Web Service** → connect repo
3. Set:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node
4. Add all env vars from `.env` under the **Environment** tab
5. Click **Deploy**

---

## Scheduled Automation (GitHub Actions)

The tool runs Step 5 then Step 6 automatically every 6 hours via GitHub Actions.

**Setup:**
1. The workflow file is already in `.github/workflows/stock-sync.yml`
2. Go to your GitHub repo → **Settings → Secrets and variables → Actions**
3. Add two secrets:
   - `RENDER_APP_URL` = `https://your-app.onrender.com`
   - `CRON_SECRET` = same value as your Render env var

To trigger manually: GitHub → **Actions** tab → **Urban Deco Stock Sync** → **Run workflow**

The scheduled sync endpoint is: `POST /api/stock/scheduled-sync`
Secured with `x-cron-secret` header.

---

## Shopify Metafields Used

| Metafield | Level | Type | Purpose |
|-----------|-------|------|---------|
| `custom.showcalendar` | Product | Boolean | Show/hide delivery date picker on product page |
| `custom.vshowcalendar` | Variant | Boolean | Show/hide picker per variant |
| `custom.vnotificationtitle` | Variant | Text | Delivery label shown (e.g. "Next Day") |

---

## Delivery Date Picker (Shopify Theme)

A flatpickr date picker appears on the product page for Next Day variants. It:
- Shows only when the selected variant has `vshowcalendar = true`
- Blocks weekends and dates less than 2 days away
- Stores the selected date as a Shopify order tag (`delivery:YYYY-MM-DD`) via Shopify Flow
- Blocks add-to-cart if no date is selected

**Shopify Flow setup:**
- Trigger: Order created
- Action: Add order tag → `delivery:{{ order.lineItems... }}`

---

## How to Use the App

### Steps 1–4 — Variant Sync (CSV mode)
1. Upload the CFS Froogle CSV (`215_Froogle_Variant_*.csv`)
2. Upload Shopify export file(s) (`products_export_1.csv`)
3. Run comparison → review orphaned variants → delete selected

### Step 5 — Stock Sync (API mode)
- Fetches live stock from CFS API
- Updates Shopify inventory levels for all matched SKUs
- Run manually or let the scheduled sync handle it

### Step 6 — Calendar Sync
- Fetches CFS products with `deliveryTime = "Next Day"`
- Matches to Shopify SKUs (`UD-{productId}`)
- Sets `vshowcalendar = true` for in-stock Next Day variants
- Sets `vshowcalendar = false` for out-of-stock ones (bidirectional)

---

## File Structure

```
variant-sync-tool/
├── server.js                        # Express app entry point
├── routes/
│   ├── stocksync.js                 # Stock sync, calendar sync, scheduled sync
│   ├── upload.js                    # File upload + compare logic
│   └── shopify.js                   # Shopify API helpers
├── utils/
│   ├── cfsApi.js                    # CFS API fetch + stock data builder
│   ├── parseCSV.js                  # CSV parsing
│   └── matchVariants.js             # Variant comparison logic
├── public/
│   └── index.html                   # Full UI (single page)
├── .github/
│   └── workflows/
│       └── stock-sync.yml           # GitHub Actions scheduled sync
├── uploads/                         # Temp folder
├── .env.example                     # Copy to .env and fill in values
└── package.json
```