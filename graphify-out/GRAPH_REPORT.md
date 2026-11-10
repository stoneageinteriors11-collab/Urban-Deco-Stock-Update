# Graph Report - variant-sync-tool  (2026-11-02)

## Corpus Check
- 41 files · ~100,907 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: (none) 1, .toml 1)

## Summary
- 711 nodes · 1122 edges · 34 communities
- Extraction: 93% EXTRACTED · 7% INFERRED · 0% AMBIGUOUS · INFERRED: 82 edges (avg confidence: 0.85)
- Token cost: unavailable (host-agent usage was not reported).

## Community Hubs (Navigation)
- Image Sync Backend
- Shopify Variant Cleanup
- Colour Matching and Health
- Server Authentication and Uploads
- Variant and Image Tests
- Stock Sync and CSV
- Application Dependencies
- Image Sync Integration Tests
- Image Cleanup Integration Tests
- Default Colour Route Tests
- Brand Sync Backend
- Undo Run Storage
- Brand Stock Route Tests
- Image Planning Rules
- Brand and Health Interfaces
- Image Backup and Restore
- Dashboard Comparison Workflow
- Scheduled Stock Workflow
- Dashboard Product Decisions
- Application Stock Architecture
- Dashboard Deletion Safeguards
- Brand Comparison Tests
- Brand Code Tests
- Brand Feed Rules
- Dashboard Data Sources
- Delivery Calendar Workflow
- Dashboard Stock Updates
- Default Colour Interface
- Dashboard Undo Workflow
- CFS Feed Access
- Shopify Connection Interface
- Image Plan Review
- Delivery Date Integration
- Store Product Pagination

## God Nodes (most connected - your core abstractions)
1. `express` - 18 edges
2. `gql()` - 17 edges
3. `axios` - 16 edges
4. `applyOne()` - 16 edges
5. `getRows()` - 14 edges
6. `restoreOne()` - 13 edges
7. `Compare & Results` - 12 edges
8. `suggest()` - 10 edges
9. `buildProductPlan()` - 10 edges
10. `Other Brands stock management` - 10 edges

## Surprising Connections (you probably didn't know these)
- `cfsCounts()` --calls--> `fetchBrandFeed()`  [EXTRACTED]
  routes/brandsync.js → utils/brands.js
- `wrongVendorRows()` --calls--> `parseSku()`  [EXTRACTED]
  routes/brandsync.js → utils/matchVariants.js
- `readJsonFeed()` --indirect_call--> `FEED_URL()`  [INFERRED]
  routes/imagesync.js → utils/brands.js
- `getCfsInfo()` --calls--> `fetchCfsProducts()`  [EXTRACTED]
  routes/shopify.js → utils/cfsApi.js
- `planPromotionAuto()` --calls--> `pickCfsProductByColour()`  [EXTRACTED]
  routes/shopify.js → utils/colourMatch.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Protected variant cleanup workflow** — public_index_photo_check, public_index_photo_backup, public_index_deleteselected, public_index_undo [EXTRACTED 1.00]

## Communities (34 total, 0 thin omitted)

### Community 0 - "Image Sync Backend"
Cohesion: 0.05
Nodes (74): applyOne(), archiver, assertNoUserErrors(), axios, backupCovers(), buildRemovalPlan(), cachedHash(), crypto (+66 more)

### Community 1 - "Shopify Variant Cleanup"
Cohesion: 0.06
Nodes (48): applyRename(), axios, cfsHas(), cfsNamesCache, chooseOne(), decideDeletion(), detachPlannedPhotos(), escRe() (+40 more)

### Community 2 - "Colour Matching and Health"
Cohesion: 0.06
Nodes (41): express, router, assert, names, r, sizes, skuHomes, assert (+33 more)

### Community 3 - "Server Authentication and Uploads"
Cohesion: 0.05
Nodes (32): express, axios, crypto, express, fs, loadToken(), path, router (+24 more)

### Community 4 - "Variant and Image Tests"
Cohesion: 0.04
Nodes (39): assert, broken, feed, feed2, feedNone, feedSome, lim, manual (+31 more)

### Community 5 - "Stock Sync and CSV"
Cohesion: 0.06
Nodes (30): ALLOWED_EXTS, axios, cancelMap, express, fs, gql(), multer, path (+22 more)

### Community 6 - "Application Dependencies"
Cohesion: 0.07
Nodes (35): dependencies, archiver@^7.0.1, axios@^1.7.2, cors@^2.8.5, csv-parse@^5.5.6, dotenv@^16.4.5, express@^4.19.2, multer@^1.4.5-lts.1 (+27 more)

### Community 7 - "Image Sync Integration Tests"
Cohesion: 0.08
Nodes (22): addFile(), app, assert, axios, calls, crypto, express, feed (+14 more)

### Community 8 - "Image Cleanup Integration Tests"
Cohesion: 0.08
Nodes (24): addFile(), app, assert, axios, calls, crypto, express, feed (+16 more)

### Community 9 - "Default Colour Route Tests"
Cohesion: 0.11
Nodes (15): ALL, app, applySse(), assert, axios, base(), express, feeds (+7 more)

### Community 10 - "Brand Sync Backend"
Cohesion: 0.13
Nodes (13): axios, cancelled, cfsCountCache, crypto, dueDay(), express, orderAheadCheck(), qualifiesOrderAhead() (+5 more)

### Community 11 - "Undo Run Storage"
Cohesion: 0.18
Nodes (15): brandOf(), crypto, DIR, file(), fs, importRun(), list(), load() (+7 more)

### Community 12 - "Brand Stock Route Tests"
Cohesion: 0.11
Nodes (13): app, asis, assert, axios, bh, codeProducts, express, feed (+5 more)

### Community 13 - "Image Planning Rules"
Cohesion: 0.22
Nodes (17): applyCfsudRule(), applyGalleryLimit(), applyPhotoFilters(), buildProductPlan(), colourOptionName(), compareVisual(), fileNameFromUrl(), FILTER (+9 more)

### Community 14 - "Brand and Health Interfaces"
Cohesion: 0.13
Nodes (16): /api/brands/cancel, /api/brands/codes-sync, /api/brands/{id}/count, /api/brands/list, /api/brands/order-ahead, Brand-scoped variant clean-up, Other Brands stock management, Product and variant codes (+8 more)

### Community 15 - "Image Backup and Restore"
Cohesion: 0.14
Nodes (14): /api/images/apply, /api/images/backup, /api/images/backup/{id}/confirm, /api/images/backup/{id}/download, /api/images/cleanup/delete, /api/images/cleanup/scan, /api/images/restore, /api/images/restore/upload (+6 more)

### Community 16 - "Dashboard Comparison Workflow"
Cohesion: 0.12
Nodes (16): Brand-specific cleanup, POST /api/brands/compare, /api/brands/list, SKU not in CFS: old saved code match, POST /api/stock/compare-api, POST /api/compare, Compare & Results, Results CSV export (+8 more)

### Community 17 - "Scheduled Stock Workflow"
Cohesion: 0.13
Nodes (14): RENDER_APP_URL, jobs, sync, name, on, schedule, workflow_dispatch, cron (+6 more)

### Community 18 - "Dashboard Product Decisions"
Cohesion: 0.17
Nodes (13): applyDecisions, Needs your decision, POST /api/shopify/set-draft, Dry Run, POST /api/shopify/fix-skus, fixSelectedSkus, Image Sync handoff, Own-variant product promotion (+5 more)

### Community 19 - "Application Stock Architecture"
Cohesion: 0.24
Nodes (11): /api/brands/stock-sync, Active brand stock update, Next Day calendar sync, Choice Furniture Superstore stock feed, Shopify OAuth, Render deployment, GitHub Actions six-hour scheduled sync, Shopify (+3 more)

### Community 20 - "Dashboard Deletion Safeguards"
Cohesion: 0.20
Nodes (11): POST /api/images/backup, POST /api/images/backup/:backupId/confirm, POST /api/shopify/delete-variants-bulk, deleteSelected, POST /api/shopify/delete-variants-image-plan, POST /api/images/stop, POST /api/shopify/sync-metafields-from-api, SHA-256-confirmed photo backup zip (+3 more)

### Community 21 - "Brand Comparison Tests"
Cohesion: 0.18
Nodes (9): app, assert, axios, express, feeds, server, shop, storeExtra (+1 more)

### Community 22 - "Brand Code Tests"
Cohesion: 0.22
Nodes (7): chooseProductCode(), assert, byId, codes, feed, jesper, r

### Community 23 - "Brand Feed Rules"
Cohesion: 0.36
Nodes (8): applyRule(), axios, buildBrandCodes(), buildBrandStock(), clean(), getBrand(), num(), RULE_TEXT

### Community 24 - "Dashboard Data Sources"
Cohesion: 0.29
Nodes (8): API Mode, CFS Stock API, CFS code metafield sync, CSV Upload, Variant Sync Tool dashboard, custom.product_code, Shopify Products API, custom.variant_code

### Community 25 - "Delivery Calendar Workflow"
Cohesion: 0.25
Nodes (8): Calendar Sync, POST /api/stock/calendar-sync, Froogle CSV, Next Day Delivery, runCalendarSync, custom.showcalendar, custom.vnotificationtitle, custom.vshowcalendar

### Community 26 - "Dashboard Stock Updates"
Cohesion: 0.25
Nodes (8): POST /api/stock/cancel, custom.inoutstock, Inventory quantity, runStockSyncApi, runStockSyncCsv, Stock Sync, POST /api/stock/sync-api, POST /api/stock/sync

### Community 27 - "Default Colour Interface"
Cohesion: 0.29
Nodes (6): /api/default-colours/apply, /api/default-colours/scan, /api/shopify/undo/{id}/download, Default colour review and repair, Rename Default option values, Undo previous option changes

### Community 28 - "Dashboard Undo Workflow"
Cohesion: 0.33
Nodes (6): runUndo, Undo a live run, POST /api/shopify/undo/:id, Downloadable undo file, /api/shopify/undo/runs, POST /api/shopify/undo/upload

### Community 29 - "CFS Feed Access"
Cohesion: 0.33
Nodes (6): cfsCounts(), crossBrandIndex(), readJsonFeed(), FEED_URL(), fetchBrandFeed(), fetchCfsProducts()

### Community 30 - "Shopify Connection Interface"
Cohesion: 0.40
Nodes (5): /auth/disconnect, /auth/status, /auth/token?reveal=1, Shopify Connection, /api/shopify/test-connection

### Community 31 - "Image Plan Review"
Cohesion: 0.50
Nodes (4): /api/images/dry-run, /api/images/plan/{id}/choices, /api/images/plan/{id}/options, Read-only image plan

### Community 32 - "Delivery Date Integration"
Cohesion: 0.67
Nodes (3): custom.showcalendar and custom.vshowcalendar, Flatpickr delivery date picker, Shopify Flow delivery order tags

### Community 33 - "Store Product Pagination"
Cohesion: 1.00
Nodes (3): gql(), sleep(), storeProducts()

## Knowledge Gaps
- **76 isolated node(s):** `Choice Furniture Superstore stock feed`, `CSV variant comparison and orphan deletion`, `Render deployment`, `Shopify Flow delivery order tags`, `/api/brands/list` (+71 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 382 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `express` connect `Server Authentication and Uploads` to `Image Sync Backend`, `Shopify Variant Cleanup`, `Colour Matching and Health`, `Variant and Image Tests`, `Stock Sync and CSV`, `Application Dependencies`, `Image Sync Integration Tests`, `Image Cleanup Integration Tests`, `Default Colour Route Tests`, `Brand Sync Backend`, `Brand Stock Route Tests`, `Brand Comparison Tests`?**
  _High betweenness centrality (0.118) - this node is a cross-community bridge._
- **What connects `Choice Furniture Superstore stock feed`, `CSV variant comparison and orphan deletion`, `Render deployment` to the rest of the system?**
  _76 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Image Sync Backend` be split into smaller, more focused modules?**
  _Cohesion score 0.05339506172839506 - nodes in this community are weakly interconnected._
- **Why does `axios` connect `Application Dependencies` to `Image Sync Backend`, `Shopify Variant Cleanup`, `Server Authentication and Uploads`, `Variant and Image Tests`, `Stock Sync and CSV`, `Image Sync Integration Tests`, `Image Cleanup Integration Tests`, `Default Colour Route Tests`, `Brand Sync Backend`, `Brand Stock Route Tests`, `Brand Comparison Tests`, `Brand Feed Rules`?**
  _High betweenness centrality (0.087) - this node is a cross-community bridge._
- **Should `Shopify Variant Cleanup` be split into smaller, more focused modules?**
  _Cohesion score 0.055811571940604196 - nodes in this community are weakly interconnected._
- **Why does `multer` connect `Application Dependencies` to `Image Sync Backend`, `Server Authentication and Uploads`, `Stock Sync and CSV`?**
  _High betweenness centrality (0.007) - this node is a cross-community bridge._
- **Should `Colour Matching and Health` be split into smaller, more focused modules?**
  _Cohesion score 0.06298701298701298 - nodes in this community are weakly interconnected._

Audit notes: Semantic extraction used host agents; actual token usage was unavailable from the agent tool. Zero counters above are placeholders, not measured zero usage. Code extraction ran locally without an LLM.

`graphify-out/` was written into the working tree and is not ignored; commit only outputs your team should share, or add it to `.gitignore`.

Graph health diagnostics are recorded in GRAPH_HEALTH.txt.

Graph health warning: 9 dangling endpoint edges, 5 self-loop edges, and 192 same-endpoint edges collapsed in the default graph. These are extraction/export limitations, not verified application defects. Unclassified files omitted: .gitignore and shopify.app.toml.
