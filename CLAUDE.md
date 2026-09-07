# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Innovators Parts (`innovators-parts`) — a parts ordering app for FRC robotics teams, branded *Innovators Parts — Powered by FRCTools*. It's a fork of [FRCTools Orders](https://github.com/frctools/order-list) by Graham Howard (MIT; original copyright retained in `LICENSE`), diverged far enough that changes aren't sent upstream. Nuxt 4 app deployed to a **DigitalOcean droplet** (Nitro `node-server` preset, PM2 behind Caddy), backed by Postgres via Drizzle, with Better Auth for auth/organizations and Meilisearch for product search.

## Commands

```bash
# Dependencies (see Windows/native note below)
bun install

# Local Postgres (docker-compose, image pinned to postgres:17, host port 5433)
docker compose up -d

# Dev server -> http://localhost:3000
bun run dev

# vendord, in a second terminal -> http://localhost:3001
# Needed in dev for anything that goes through the scraper: the delegated
# hosts, and the vendors rendered in a browser (Powerwerx). Without it those
# lookups fall back to a plain fetch, collect the vendor's bot challenge and
# quietly return nothing -- the degradation working as designed, but
# indistinguishable from the feature being broken. PM2 keeps it alive in
# production, so this is a dev-only trap.
cd vendord && bun run dev

# Lint + typecheck (CI runs both on every push, see .github/workflows/ci.yml)
bun run lint
bun run typecheck

# Production build (Node server output in .output/)
bun run build
```

## Deployment

Runs on a single **DigitalOcean droplet** (Ubuntu 24.04, 1 vCPU / 2 GB), not
Cloudflare Workers. Caddy is the only process bound to a public port;
everything else listens on localhost:

| | |
| --- | --- |
| Caddy | `:80`/`:443` — TLS and reverse proxy, config in `deploy/Caddyfile` |
| Nuxt | `127.0.0.1:3000` — `.output/server/index.mjs` under PM2 |
| vendord | `127.0.0.1:3434` — the scraper, under PM2 |
| Postgres | `127.0.0.1:5433` — `docker compose up -d`, container `parts-db-1` |
| Meilisearch | `127.0.0.1:7700` — same compose file, container `parts-meilisearch-1`, capped at 512 MB |

`deploy/provision.sh` builds the box from scratch and is safe to re-run. The
app runs as the unprivileged `parts` user out of `/srv/parts`, not as root.

**Search brings its own setup up.** `provision.sh` never ran `docker compose up`
— Postgres was started by hand once — so the deploy workflow now does it, which
is what makes the Meilisearch service in `docker-compose.yml` exist on the box
at all. The same step appends `MEILISEARCH_HOST`/`INDEX` to the droplet's
`.env` and generates `MEILISEARCH_API_KEY` if it is absent (rsync excludes
`.env`, so it cannot be shipped), then waits for `/health`. It runs before the
migrate that seeds vendors and before the reload that re-reads `.env`. The key
is written once and never rotated on later deploys: rotating it would lock the
running app out of its own index until the next reload. A final step scrapes when
there is something new to fetch — an empty index, **or any vendor row with
nothing cached against it**. That second condition is the one that matters day
to day: a migration seeding a new vendor lands its row, and an empty-index-only
check left those products missing from production until the nightly task ran,
which is exactly how Lumyn Labs and Luma Vision shipped invisible. It is
deliberately not every push — a scrape walks every storefront and takes
minutes — and it can never fail the deploy, the site being up and verified by
then.

**Releases ship themselves.** `.github/workflows/deploy.yml` runs on every push
to `main` (and on `workflow_dispatch`): it builds both outputs in CI, checks
what migrations are pending, uploads over rsync, installs, migrates, verifies
the schema caught up, reloads PM2 and smoke-tests the result. It holds the
production deploy key and is deliberately never triggered by `pull_request` —
the repo is a public fork, so a PR from anyone must not be able to reach it.
`deploy/release.sh` does the same by hand from a workstation, for when CI
isn't an option.

**Build off the droplet** — in CI or locally — and ship `.output/`: a Nuxt build
wants more memory than a 2 GB box has spare, and an OOM mid-build takes the
running site with it. `bun install` is nearly as hungry: run it with nothing
else competing, and expect the box to be unresponsive for a minute if it
starts swapping. It answers ICMP throughout, so "ping works but SSH hangs"
is memory pressure, not the network.

Two things about that box that are easy to get wrong:

- **PM2 does not read `.env`.** Nitro only loads it in dev, and PM2 has no
  `env_file` option, so a process started without help comes up with no
  `DATABASE_URL` and fails on its first query. `ecosystem.config.cjs` parses
  the file itself and passes it to both processes — vendord included, whose
  routes import the app's own `server/utils/db`.
- **Docker publishes ports around ufw.** It writes its own iptables rules
  ahead of ufw's chain, so a bare `"5433:5432"` puts Postgres on the public
  internet while `ufw status` still reports the port as denied. The compose
  file pins the published address to `127.0.0.1` deliberately.

Shipping a release by hand:

```bash
./deploy/release.sh                 # build, upload, install, migrate, reload
SKIP_BUILD=1 ./deploy/release.sh    # ship what is already in .output/
```

That script migrates unconditionally and has none of the destructive-migration
gate the workflow applies, so read the pending SQL yourself before running it.

The droplet needs a **full** `bun install`, not `--production`: `.output` does
not vendor its dependencies (`better-sqlite3` is resolved from `node_modules`
at runtime, and `/docs` breaks without it), and `drizzle-kit` — which
`db:migrate` needs — is a devDependency.

**Never ship `.output/server/node_modules`.** Nitro traces a dependency copy in
there for whatever machine ran the build; from a Windows workstation its nested
directories arrive empty and the app crash-loops on `ENOENT reading
.../html-to-text/node_modules/htmlparser2`. Both `release.sh` and the
workflow's `rsync` exclude it so resolution walks up into the
natively-installed `node_modules` instead.

Migrations run **before** the reload, for the reason in the migrations note
below. Backups are `deploy/backup-db.sh` on a nightly cron, plus weekly droplet
snapshots; the script refuses to keep a dump that comes back suspiciously
small, and copies off-box when `RCLONE_REMOTE` is set.

Database migrations (Drizzle Kit reads `DATABASE_URL`):

```bash
bun run db:generate   # create a migration from schema changes
bun run db:migrate    # apply pending migrations in drizzle/
```

**A migration must land before the code that needs it.** Deploying code that queries a table its database doesn't have takes the site down, and nothing else notices: the build succeeds, static pages render, and only the queries touching the new schema fail. That is exactly how the receipts feature shipped against a database with no `order_receipts` table. Only additive migrations are safe to apply in either order; a rename or drop (like `unit_price_cents` → `unit_price_micros` in `0016`) is not.

The deploy workflow enforces that ordering rather than leaving it to discipline. `deploy/pending-migrations.mjs` reads the applied `created_at` values out of `drizzle.__drizzle_migrations`, diffs them against `drizzle/meta/_journal.json`, and runs **before the upload**, so a deploy that can't safely migrate stops while the server is still untouched. It regex-scans each pending file for `DROP` / `RENAME` / `TRUNCATE` / `ALTER COLUMN … TYPE` and refuses to continue on a hit — deliberately over-broad, since a false positive costs one ticked checkbox and a false negative discards a column with nobody watching. To apply one of those, re-run the workflow from `workflow_dispatch` with `run_migrations` ticked. Migration, then a re-check that nothing is still pending, then the reload.

Two caveats when writing one:

- **Hand-written migrations still need a snapshot.** `0013`–`0015` were written by hand without regenerating `drizzle/meta`, which left the snapshots four migrations behind the schema — `db:generate` then diffed from the wrong baseline and started prompting about unrelated tables. `0016_snapshot.json` re-baselines it. If you hand-write SQL again, regenerate the snapshot too, and check `db:generate` reports *"No schema changes"* on an unmodified schema before committing.
- **Drizzle Kit generates destructively for renames.** It emits DROP + ADD, which discards the column's data. Migration `0016` is the pattern to copy: add the new column, `UPDATE` across from the old one, then drop.

There is no test runner configured; "verification" means lint + typecheck + exercising the dev server. In production the nearest equivalent is the workflow's smoke test, which probes one URL per rendering path — prerendered `/`, SSR'd `/auth/login`, Nuxt Content `/docs/getting-started`, and `/api/orders` expecting a 401. Checking only `/` is how a sitewide docs 404 once shipped green, which is why the list is what it is.

## Environment

Dev config lives in `.env` (gitignored). Most server code reads `process.env.*` directly (not just Nuxt `runtimeConfig`):

**`BETTER_AUTH_URL` must be the origin you are actually browsing.** Better Auth derives its cookie attributes from it, so pointing a dev instance at the production URL makes it issue `__Secure-better-auth.session_token` with `Secure` set — which a browser refuses over `http://localhost`. Sign-in then answers `200` and the session silently never exists, which reads as a wrong password rather than a misconfiguration. The OAuth redirect URI comes from the same value, so the same mistake sends a dev Google sign-in to production after consent. `http://localhost:3000` in dev.


- `DATABASE_URL` — local Postgres, e.g. `postgres://postgres:orderr@localhost:5433/postgres`
- `DATABASE_POOL_MAX` — optional; size of the connection pool, default 10
- `VENDORD_URL` — optional; where the scraper listens. Defaults to `http://localhost:3001` in dev and `http://localhost:3434` in production
- `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (`http://localhost:3000` in dev)
- `RESEND_KEY` — transactional email; optional in dev (only used when sending invites/notifications)
- `MEILISEARCH_HOST`, `MEILISEARCH_API_KEY`, `MEILISEARCH_INDEX` — product search; optional. `docker compose up -d` runs one locally on `127.0.0.1:7700`, so dev is `http://127.0.0.1:7700` with the key from `MEILISEARCH_API_KEY` (default `devsearchkey`)
- `MEILISEARCH_EMBEDDER` — optional; the name of an embedder configured on the index. Set it to turn on hybrid (keyword + semantic) search, leave it unset for keyword only
- `DIGIKEY_CLIENT_ID`, `DIGIKEY_CLIENT_SECRET`, `DIGIKEY_API_BASE` — DigiKey Product Information API v4 (developer.digikey.com); optional. Sandbox and production are separate apps with separate credentials, so `DIGIKEY_API_BASE` has to match the pair in use — `https://sandbox-api.digikey.com` or `https://api.digikey.com`. Unset means DigiKey parts fall back to the URL-derived name and SKU.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — optional; enables "Continue with Google" on the auth pages. Both must be set or the provider is absent entirely and no button renders. The redirect URI to register with Google is `<origin>/api/auth/callback/google`. Signing in with Google does **not** bypass the invitation gate — Better Auth creates an OAuth user through the same `createWithHooks("user")` path, so the hook in `auth.ts` runs either way.
- `SIGNUP_BOOTSTRAP_EMAIL` — optional; restricts the one-time first-account signup to a single address (see *Signups are invitation-only* below). Unset means the first person to reach an empty instance claims it.
- `NUXT_PUBLIC_SENTRY_DSN` — optional

## Architecture

**Database connection** — `server/utils/db.ts` is the single DB entry point (`useDB()`): a drizzle `node-postgres` client over one `pg.Pool` built from `DATABASE_URL`. Always go through `useDB()`.

The pool is **built once for the life of the process**, and that matters. It used to be rebuilt on every `useDB()` call, which was merely wasteful on Workers — isolates are short-lived and Hyperdrive pooled underneath — but exhausts Postgres on a long-running Node server instead: a single request touches `useDB()` several times, none of them are closed, and the server stops answering once `max_connections` is reached. `DATABASE_POOL_MAX` (default 10) sizes it, comfortably under Postgres' default of 100 so psql, backups and a second process still get in. `closeDB()` exists so shutdown doesn't wait on idle connections.

**Signups are invitation-only** — there is no open registration. `server/utils/signup-gate.ts` holds the rule and `auth.ts` enforces it in Better Auth's `databaseHooks.user.create.before`, which throws a `403 APIError`. It lives in the database hook rather than on the page or a route wrapper because Better Auth owns `/api/auth/**` — a check anywhere else is bypassed by posting to `sign-up/email` directly. An account can be created only when:

- a **pending, unexpired invitation** exists for that email (compared case-insensitively — Better Auth lowercases invitation addresses but not necessarily signup ones), or
- the instance has **no users at all**, the bootstrap window that lets the first owner in. That window is first-come on a public host, so `SIGNUP_BOOTSTRAP_EMAIL` narrows it to one address; it closes permanently once any user exists.

Note that Better Auth's `acceptInvitation` refuses unless the session's email matches the invitation exactly, so an invited signup must use the invited address — `/api/signup-status` exists to tell the signup page which of its three states to render (`bootstrap` / `invitation` / `closed`) and hands back the invited address so the form can pin it. That endpoint is cosmetic; forging its answer gains nothing because the hook still runs. Deliberately *not* used: `emailAndPassword.disableSignUp`, which would also lock out invited users and break the invite flow entirely.

**Invitations turn into membership at sign-in**, not only when someone follows an `/accept-invitation/<id>` link. Being invited and being a member are separate things, and that link only ever arrives by email — so anyone signing in another way (straight to `/auth/login`, through Google, or at `/auth/signup` without the link) ended up with an account, no organization and an empty dashboard while the invitation sat pending. With no `RESEND_KEY` set no email goes out at all, and that is the only path there is. So `databaseHooks.session.create.before` in `auth.ts` calls `acceptPendingInvitations()`, keyed off the address the invitation was sent to — the same thing Better Auth's own `acceptInvitation` checks — and seeds `activeOrganizationId` from what it joined, falling back to `soleOrganizationOf()`. Without that seeding Better Auth leaves the field null on a new session and every API route refuses with a 400 while the dashboard still shows a team. It runs on every sign-in, so it also repairs accounts created before it existed. There are no transactions, so it is written to be re-runnable: a partial failure leaves the rest pending for the next sign-in.

**Multi-tenancy via Better Auth organizations** — `server/utils/auth.ts` configures Better Auth with the `organization` plugin. Every app resource is scoped to an organization. The gate for authenticated API routes is `requireOrganizationContext(event)` in `server/utils/session.ts`: it returns `{ user, session, organizationId, membership }`, throwing **401** if unauthenticated and **400** if no active org is selected (`session.activeOrganizationId`). It resolves `membership` through a `getFullOrganization` call, so it costs an extra auth round-trip per request. New API handlers that touch org data should call it first and filter queries by `organizationId`.

**Schema is split in two** — `server/utils/auth-schema.ts` holds Better Auth tables (user, session, account, organization, member, invitation); `server/utils/schema.ts` holds app tables (vendors, tags, orders, orderItems, orderTags, orderPayments, orderReceipts, productCache, notification\*). Both are registered in `drizzle.config.ts` and merged into the drizzle client. (Note: a second `auth-schema.ts` exists at the repo root from the Better Auth CLI — the one the DB actually imports is `server/utils/auth-schema.ts`.)

### Order data model

Orders are **two-level**: an order is a per-vendor *purchase order header*, and the parts are line items under it.

- `orders` — vendor (`vendorId` for a known vendor row, else free-text `vendorName`), `status` (`to_order` → `ordered` → `arrived`), `orderedAt`/`arrivedAt`, and post-order fulfilment fields (`trackingCarrier`, `trackingNumber`, `shippingCents`, `taxCents`). The order advances as a unit — status lives here, not on parts.
- `orderItems` — one part per row (`partName`, `quantity`, `unitPriceMicros`, variant fields, `externalUrl`).
- `orderTags` — tags attach to **line items** (`orderItemId`), not to orders.
- `orderPayments` — split payment lines (`credit_card` / `voucher` / `coupon` / `other`), so one order can be part credit card, part Kit-of-Parts voucher, part coupon.
- `orderReceipts` — uploaded invoices and packing slips, several per order. See *Receipts* below.

**Money units** — item unit prices are stored as **micro-dollars** (1e-6 USD) in `orderItems.unitPriceMicros`, because distributors quote sub-cent prices at quantity breaks (DigiKey goes to five decimals) and whole cents rounded them away. Everything else — shipping, tax, payments, and all order totals — stays in whole cents, which is what actually gets paid. `app/utils/money.ts` owns the conversions and the display rule: a unit price renders as plain money when it lands on whole cents (`$2.40`) and only spells out the extra digits when it genuinely carries them (`$0.231`). Line totals sum in micros and round to cents once, never per line.

Totals are derived in JS rather than stored: `totalCents` (items), `paidCents` (payments), `grandTotalCents` (items + shipping + tax).

**Grouping rule** — parts are added with a vendor, and `findOrCreatePendingOrder` drops each part into the org's open (`to_order`) order for that vendor, creating one if none exists. `vendorKey()` mirrors that grouping so moves can be validated: parts only combine within the same vendor, and only between `to_order` orders. Any source order left empty (by a split, a move, or an item delete) is deleted.

**Order write logic lives in `server/utils/order-service.ts`**, keeping route handlers thin: `addLineItem` / `addLineItemsBulk` / `addItemToOrder` (create), `updateLineItem` / `deleteLineItem`, `splitItemsToNewOrder` (move parts into a fresh order — "ship separately"), `moveItemsToOrder` (join parts into an existing open order), `updateOrderDetails` (tracking/shipping/tax plus replacing the payment set), and the Zod `createOrderSchema`. All reads go through the private `fetchOrders()`, which runs five queries (orders, payments, receipt metadata, items, item tags) and assembles the full `OrderRecord`.

### Receipts

Orders carry uploaded invoices and packing slips; several per order is normal — a vendor invoice plus a packing slip, or one per shipment when an order splits. `server/utils/receipt-service.ts` owns the logic, with routes under `server/api/orders/[id]/receipts/`.

**The bytes live in Postgres** (`order_receipts.content`, a `bytea` declared through a drizzle `customType` since there's no built-in), not on disk. The nightly backup is a `pg_dump` and nothing else, so anything on the filesystem would be covered only by the weekly droplet snapshot — a receipt uploaded and lost inside the same week would be unrecoverable. Keeping it in the table gives receipts the same restore guarantee as the orders they document. `MAX_RECEIPT_BYTES` caps an upload at 10 MB so one file can't dominate the dump it rides along in.

Three things about the handling are deliberate:

- **The MIME type is sniffed from the bytes**, never trusted from the multipart headers the client controls — a declared `application/pdf` says nothing about what was actually sent. `detectMimeType()` matches magic bytes for PDF/JPEG/PNG/WebP, and the type it returns is what gets stored and later echoed back as the download's `Content-Type`.
- **Filenames are stripped** of control characters, quotes, backslashes and path separators, because they end up inside a quoted `Content-Disposition`.
- **Downloads are served defensively**: `X-Content-Type-Options: nosniff`, a `default-src 'none'; sandbox` CSP to neutralise anything active inside a PDF, and `Cache-Control: private, no-store` because these are organization data served from the app's own origin. `?download=1` switches the disposition from `inline` to `attachment`.

Every route calls `assertOrderInOrg()` first — a receipt id alone must never be enough to reach a file, or one organization could read another's audit trail. Neither `listReceipts()` nor `fetchOrders()` selects `content`, so listing orders never drags receipt bytes through memory; the download route is the one place it is read.

**API routes** — Nitro file-based routing under `server/api/` with method suffixes (`index.get.ts`, `[id].patch.ts`, etc.). Orders live at `/api/orders` (list/create), `/api/orders/[id]` (patch status/vendor, delete), `/api/orders/[id]/details`, `/api/orders/[id]/items[/itemId]`, `/api/orders/[id]/receipts[/receiptId]`, `/api/orders/[id]/cart-link`, plus `bulk`, `move`, `split`, and `payment-methods`.

**Vendors & product search** — three distinct systems:
- `server/api/vendors/search.get.ts` queries **Meilisearch** over the product catalog; `facets.get.ts` beside it returns facet values (default `vendorName`) for the search page's filters. Neither is auth-gated.

  **How the index gets filled.** Two Nitro tasks in vendord, chained: `scrape` walks every row of the `vendors` table — Shopify through `/products.json?limit=250&page=N`, BigCommerce through its storefront GraphQL — and upserts each product into `productCache`; it then runs `meilisearch:sync`, which joins `productCache` to `vendors` and pushes documents to the index. Trigger them at `GET /scrape` and `GET /sync` on vendord (dev: `localhost:3001`), and `scrape` runs nightly (see *Price history* below for how that is scheduled). Both read `DATABASE_URL` and the `MEILISEARCH_*` vars, and vendord needs its own `bun install`.

  **Price history is recorded as part of every scrape.** `scrape` ends by calling `prices:record` (`GET /record-prices` to run it alone), which walks `productCache` and writes to `productPriceHistory`. Three things about it are the whole design:

  - **One row per price, not per observation.** A product whose price has not moved gets its existing row's `lastSeenAt` advanced, not a new row. The catalogue is ~5,250 products; a year of nightly scrapes therefore costs roughly 5,250 rows plus however many prices actually moved, rather than the ~1.9M a naive daily snapshot would.
  - **`lastSeenAt` is what keeps that honest.** With change-only rows there is otherwise no way to distinguish "held at $19.99 since March" from "nobody has checked since March", and the chart would draw a confident flat line across a gap. It also gives the step plot its true shape: the old price is known to have held right up to the scrape before the new one appeared, so a change renders as a single vertical jump rather than a slope drawn between two distant samples. That is the difference between "it changed on the 14th" and "it drifted over three weeks", and only the first is true.
  - **The price is read through the same helper the index uses.** `vendord/server/utils/product-doc.ts` holds `parseCachedProduct`/`productPrice`, and both `meilisearch:sync` and `prices:record` go through it. They have to agree, or the figure on a search card and the figure its own history chart plots would come from different places and drift.

  Recording is wrapped in its own try/catch inside `scrape`: the catalogue and the index are already updated by the time it runs, and losing one night of price points is not worth failing a scrape over.

  **Midnight Eastern is decided in the task, not the cron.** Nitro schedules with croner and hands it nothing but the expression — `new Cron(expr, handler)` in `nitropack/dist/runtime/internal/task.mjs` — so there is no timezone to pass and croner reads the *host's* local time. The obvious fix, `TZ=America/New_York` on the vendord process, is the wrong one: every timestamp column in this schema is `timestamp without time zone`, and node-postgres serializes a `Date` using the process's local offset, so vendord would silently start writing timestamps four or five hours off from what the app writes and reads. Nothing would error.

  So `scheduledTasks` wakes `nightly` hourly (`0 * * * *`) and it scrapes only on the wake-up that lands at midnight in New York, asking `Intl` rather than tracking DST itself. The first version instead fired at `0 4 * * *` and `0 5 * * *` — midnight Eastern under EDT and EST — and dropped whichever wasn't midnight. That was correct only while the host stayed on UTC, an assumption nothing enforced and nothing would have reported breaking: on a workstation already set to Eastern those same expressions mean 4am and 5am local, so the task never ran at midnight at all. 23 no-op wake-ups a day cost one `Intl` call each, and the schedule is now right on any host in any zone.

  **Reading it back**: `GET /api/vendors/price-history?id=<search doc id>` (auth-gated no more than `search`/`facets` beside it, being the same public catalogue). It takes the base64 document id the search index uses, or the raw `productCache` key. `app/components/PriceHistoryChart.vue` draws the step plot as inline SVG — a dozen line segments per product does not justify a charting dependency, and none of them steps correctly without configuration anyway. Its one rule: every segment is horizontal or vertical, never diagonal. `PriceHistoryModal.vue` wraps it, and the search page opens it from the price on each result card.

  **The whole catalogue's movement is at `/price-changes`**, served by `GET /api/vendors/price-changes` — a table of every recorded move, defaulting to the last 30 days, with date, vendor and text filters. Public, like `search`/`facets`/`price-history` beside it.

  Three things about that endpoint are the design.

  - **A change is a history row with an earlier row behind it**, so the *first* row for a product is excluded. That row is the price the tracker opened at, not a move; counting it would put every product on the page the day it entered the catalogue, reporting a change from nothing.
  - **The `lag()` window runs over the whole table, and the date filter is applied after it.** Because storage is change-only, the row a change is measured against is usually *outside* the window being asked for — the previous price could be from months ago. Filtering first and lagging second would silently compare each change to the previous change *in the window*, misreporting the first one in every range. Verified against SQL: a change on 2026-09-02 inside an eight-day window correctly reported the 08-20 price as its predecessor, not the 60-day-old baseline.
  - **Vendor facet counts are taken before the vendor filter is applied**, so picking one vendor does not collapse the menu to that single option.

  Two smaller notes. The `previous_micros` column is a bare `lag()` with no drizzle type mapper behind it, so pg hands that bigint back as a *string* where the mapped column beside it is a number — it is coerced explicitly. And `ROW_CAP` bounds what one request pulls into memory; hitting it is reported as `truncated` and surfaced as a banner, rather than quietly showing a partial answer.

  **The page's default date range is computed in UTC, deliberately, not in the viewer's local day.** The page is server-rendered, so that default is computed twice — once on the droplet, once in the browser — and a local-day default disagrees whenever the two are not on the same calendar date. That is not cosmetic: the SSR pass fetches one range, the client hydrates with another and immediately refetches, so a page load costs two of these queries on a one-core box and the dates visibly jump. UTC is also the right anchor rather than merely a consistent one, since the droplet runs on it and the server reads these dates as its own local midnight against timestamps vendord writes at the same offset.

  **The `vendors` table is the input, and it does not seed itself** — an empty table means an empty index, with both tasks reporting success. Sixteen FRC vendors are reachable, and which platform a brand runs is not guessable. Several of the smaller ones sit on a `shop.`/`store.` subdomain rather than the apex, and the apex does not always redirect to it, so the hostname in the table is the one that actually serves `/products.json`:

  | vendor | `type` | hostname |
  | --- | --- | --- |
  | WestCoast Products | `shopify` | `wcproducts.com` |
  | AndyMark | `shopify` | `www.andymark.com` |
  | The Thrifty Bot | `shopify` | `www.thethriftybot.com` |
  | Cross the Road Electronics | `shopify` | `store.ctr-electronics.com` |
  | REV Robotics | `bigcommerce` | `www.revrobotics.com` |
  | Swyft Robotics | `swyft` | `swyftrobotics.com` |
  | Swerve Drive Specialties | `shopify` | `www.swervedrivespecialties.com` |
  | Armabot | `shopify` | `www.armabot.com` |
  | Last Anvil Innovations | `shopify` | `lastanvil.com` |
  | Limelight Vision | `shopify` | `limelightvision.io` |
  | Redux Robotics | `shopify` | `shop.reduxrobotics.com` |
  | Copperforge | `shopify` | `shop.copperforge.cc` |
  | Lumyn Labs | `shopify` | `lumynlabs.com` |
  | Luma Vision | `shopify` | `luma.vision` |
  | RoboPromo | `volusion` | `www.robopromo.com` |
  | Sailrite | `curated` | `www.sailrite.com` |

  **`swyft` is a one-store type, not a platform.** Swyft runs a *headless* Shopify storefront on Next.js, so none of the endpoints the `shopify` branch needs are served: `/products.json` and `/collections/all/products.json` both 404, and the sitemap is the Next.js app's own, with no `/products/{handle}` URLs in it. Only the CDN and checkout are still Shopify's. What the Next.js app does publish is better than either — every page embeds an RSC flight payload (`self.__next_f`) carrying complete product objects (`slug`, `sku`, `name`, `description`, `priceCents`, `image`, `shopifyProductId`, `shopifyVariantId`, `variants[]`), and each page carries not only its own product but every one it links to, so walking the sitemap's ~64 product pages yields the whole catalogue several times over, deduplicated by slug. `vendord/server/utils/swyft.ts` does this.

  Three things there are deliberate. The payload is a React element tree rather than a document with a known path to the product, so objects are located by a key only they carry (`"variants":[`) and read out by **brace matching**. React marks lazy chunk references and absent values with a leading `$` (`"$undefined"`, `"$3a"`), so any field read from it has to reject those or it stores a pointer as text. And the indexed price is the product's own `priceCents`, **not** `min(variants)`: they diverge where the cheap variants are spare parts — the bumper kit lists at $999.99 with a $19.99 screws-only variant under it, and $999.99 is what the page shows.

  Cart handoff is not wired up for it: `detectPlatform` returns `null` for a `swyft` vendorType, so no button appears. The scraped variants do carry `shopifyVariantId`, so Shopify cart permalinks could be made to work later.

  **Swyft is delegated to vendord** (`DELEGATED_HOSTS`), and is the case that mechanism was kept for. The product lives in an RSC flight payload, which `vendord/server/utils/swyft.ts` reads and the in-process extractor cannot — so left to itself the extractor got as far as OpenGraph: a title, no price, no variants. That is the failure worth remembering, because it is silent. OpenGraph *did* return a product, so `applyExtractedProduct` in the slideover accepted it and returned without ever consulting the scraper, and `isUrlDerived` was false because the source was `opengraph` rather than `url`, so no warning rendered either. A part arrived named, priced blank, with no variant picker and nothing saying anything had been missed. All 42 Swyft products carry more than one variant, so this affected every one of them.

  vendord's own route needed a `swyft` branch to go with it. It had none: `index.ts` handles `shopify`, `bigcommerce` and `amazon`, so a Swyft URL only ever resolved out of the **cache**, and anything the nightly had not scraped yet answered *"Unsupported vendor type"*. `fetchSwyftProduct` fetches the single page and reads it with the same parser the scrape uses.

  That branch deliberately **does not write to `productCache`**, unlike the ones around it. Their ids come from a canonical handle; this one would come from the pasted path, and Swyft's leading section is decorative — every prefix resolves to the same product, so `/structure/swyft-bearing-plates` and `/motion/swyft-bearing-plates` would land as two rows for one part, which is two search documents and two price histories each telling half the story. The nightly scrape walks the sitemap, knows which section is canonical, and owns that row.

  **`volusion` is RoboPromo's platform**, and like `swyft` it needed its own path because Volusion serves none of the catalogue endpoints the other scrapers use: no `/products.json`, no storefront GraphQL, and a `sitemap.xml` listing only categories. Its category pages render their listings **client-side**, so fetching one server-side returns navigation and nothing else — a first pass across all 22 categories found zero products and looked like an empty store. The way in is `/pindex.asp`, Volusion's built-in product index: plain server-rendered HTML listing every product as `/product_p/{code}.htm`.

  Those product pages need no parser of their own. They carry `og:title`, `og:image` and a schema.org `<span itemprop='price' content='139.00'>`, all of which `part-extractor.ts` reads — `og:image` only since RoboPromo was added, because the extractor had been discarding it and Volusion is the one vendor whose search documents are built from its output, so those products indexed with no picture at all, so `vendord/server/utils/volusion.ts` walks the index and hands each URL to `extractPart` rather than growing a second copy of that logic. Only the SKU is missing from the markup, and the URL carries it.

  RoboPromo is also why `FRC_VENDORS` matters beyond cosmetics: their `og:site_name` is the bare host, so before a curated entry existed the OpenGraph fallback named the vendor **"www.robopromo.com"** on every pasted part. `mappedVendor` takes precedence over `ogVendor()`, so the entry fixes it. Their own `itemprop` `legalName` is "RoboPromo LLC".

  **`curated` indexes a named list rather than a storefront.** Sailrite sells thousands of marine items an FRC team will never buy, so a full scrape would bury the few that matter under upholstery tools. A `curated` vendor keeps its product URLs in **`vendors.config`** — a `NOT NULL` text column nothing else in the app reads — as `{"urls": [...]}`, and `productsFromUrls` fetches each through the ordinary extractor. Adding or dropping a product is an `UPDATE` to that row, not a code change. URLs are confined to the vendor's own hostname, so a config edit cannot point the scraper elsewhere or break the link `sync` builds from `hostname` + handle. Migration `0021` seeds the fourteen Sailrite products (two Dacron sailcloths, eight Insignia fabrics, one Dyneema webbing, three Spyderline sizes).

  **Sailrite prices per option, and the variants are fetched** (`server/utils/sailrite.ts`). Most of their fabric and line comes in colours, lengths and widths that do *not* share a price — Spyderline is $1.30 red and $1.40 black, Dyneema webbing runs $8.75 to $486 — and the product page shows the base article. The options are plain `<select>`s driven by htmx, and the useful part is that **the full product page honours those same names as query parameters**: `?option__custitem3=2` returns that variant's page with its own `data-product-sku` (`103131-BK`) and its own schema.org Offer. So each variant is one ordinary page fetch and they all go at once — eight combinations of the webbing come back in about a second, well inside the extract endpoint's 9s budget. Nothing on the base page lists variant prices, so there is no cheaper route; the variant SKUs do not appear in its markup at all.

  Multi-dimension products are a cartesian product (Dyneema is 4 lengths × 2 widths), capped at 24 combinations so an unusually configurable product cannot fire off a hundred requests — past the cap the part still extracts, just without variants. `disabled` options are dropped, being the out-of-stock ones struck through on the page, and that is per-page: Purple exists on Spyderline 103130 but not 103131. The slideover needed no change — it already builds its picker from `product.variants` and has a watcher that sets `unitPrice` on selection.

  **Redirects are followed by hand, with a cookie jar.** `fetchWithUa` used `redirect: 'follow'`, which carries no cookies, and that is fatal on a storefront whose first visit is gated behind one. AutomationDirect bounces an anonymous request through an SSO "silent auth" check; without the cookie that check sets, nothing records it already ran, and the request ping-pongs between the store and `login.automationdirect.com` indefinitely — curl with a jar settles it in four hops, Node's fetch spends its budget and throws, so their whole catalogue read as unreachable while the pages were in fact being served. Cookies are scoped to the domain that set them and sent nowhere else, so a redirect off-site cannot carry the first site's session. The same rewrite closed an SSRF gap: `isBlockedHost` now lives beside the extractor and is re-checked on **every hop**, where before the route validated only the URL the user pasted and a vendor could have redirected onward to `169.254.169.254` unseen.

  **AutomationDirect names every product after its own part number.** Their JSON-LD `name` is the bare SKU on every item they sell, so a line item read "EA3-BRK" while the page was headed "Panel Mounting Brackets: replacement, 8/pk, …". That real name is in `<title>`, trailed by `(PN# …)` and the site name, so it is taken apart and used — but *only* when the markup's name is nothing but the SKU. An earlier version reached for the page title whenever a SKU existed, which appended branding to six other vendors ("… - Ace Hardware", "… - REV Robotics") and put Rock West's part number in front of its own name. Their category pages carry no Product markup at all, and the OpenGraph fallback is suppressed for them so a listing cannot become a part named "Productivity1000 DC and Combo I/O Modules" with no price — the trap WCP's configurator pages and VEX's slug pages also set. Their vendor name is mapped because the JSON-LD path would otherwise take `brand`, which is the product line: a mounting bracket arrived from "C-more Micro".

  **A price is allowed to live in `priceSpecification` rather than on the offer**, and Ace Hardware's only lives there: their Offer carries the URL, availability and a return policy, with the money in a `UnitPriceSpecification` beside them. Reading the offer alone produced a complete-looking product priced `null` — the same symptom Sailrite had, from a different cause. `priceFromOffers` now falls through to it, which works generally because a PriceSpecification names its fields `price`/`priceCurrency` too. Otherwise Ace needs nothing special: they serve pages to a plain fetch, and the JSON-LD carries name, sku, image, brand and description. They sell each size as its own URL with its own SKU, so `variations` is empty and there is no picker to build. Their vendor name is mapped because the JSON-LD path would otherwise take the product's `brand` — the manufacturer, not the store — and a roof bracket arrived from "Qual-Craft".

  **Product names are entity-decoded.** JSON-LD sits inside a `<script>` and needs no HTML escaping, but vendors escape it anyway: Ace's names hold `&amp;`, which reached an order as the literal "GE Tub &amp; Tile Caulk". `cleanName` runs both the product title and ProductGroup variant names through `cleanText`, the latter so a variant's `"{product} - "` prefix still matches the decoded group name.

  **schema.org `@id` references are resolved across blocks**, which is what makes Sailrite work at all. They split a product over four `<script type="application/ld+json">` blocks: the Product carries `"offers": {"@id": "#offers"}` and `"image": {"@id": "#primary-image"}`, with the Offer holding the price and the ImageObject the URL in blocks of their own. Reading the Product alone yielded a complete-looking part priced `null` — the "everything but the price" symptom. The extractor now indexes every node by `@id` while collecting and swaps a bare reference for the node it names, with inline fields winning over referenced ones.

  Three others are BigCommerce but **cannot** be scraped, and it is worth not re-deriving this: `getBigCommerceToken` lifts a storefront GraphQL token out of the homepage HTML, and **goBILDA, ServoCity and BaneBots don't publish one** — not on any template (home, cart, login, search), not at runtime (their storefronts are server-rendered Stencil and never call the GraphQL API), and their `/graphql` answers *"credentials were missing"* to an anonymous request. Reaching them would need a different scraper built on their product sitemap (`/xmlsitemap.php?type=products`) plus a page fetch each. Playing With Fusion, Robot Marketplace and Team221 run older platforms with no product feed at all, and Kauai Labs and Nexus Robot are WooCommerce with the public Store API (`/wp-json/wc/store/v1/products`) disabled — checked, all 404. `rushrobotics.com` and `nexusrobotics.com` are parked domains that bounce every path to a `/lander` page, and `lumavision.com` is an unrelated WooCommerce company, not Luma Vision — whose store is the apex `luma.vision`, TLD included.

  **Hybrid search is opt-in.** `search.get.ts` used to pass `hybrid: { embedder: "default" }` unconditionally, and Meilisearch rejects the whole request when no embedder is configured — *"Passing `hybrid` as a parameter requires enabling the `vector store` experimental feature"* — so every search failed on any instance without one, which is the default. It now sends `hybrid` only when `MEILISEARCH_EMBEDDER` names one, and otherwise runs keyword search over `title`/`description`/`vendorName`/`skus`.

  **`sort` is moved ahead of the relevance rules.** Meilisearch's default order is `words, typo, proximity, attribute, sort, exactness`, which means an explicit sort only ever breaks ties between documents relevance had already tied — searching *led* and asking for cheapest first returned $24.99, $29.99, $2.49, each relevance bucket sorted on its own. The sync sets `rankingRules` with `sort` first instead. A query that names no sort is unaffected, since the rule is a no-op without one.

  Two more things the sync deliberately normalises, because Shopify's raw values break the features the index advertises: **prices are parsed to numbers** (Shopify quotes them as strings, and `price` is a declared sortable attribute — sorting strings put `119.99` between `11.00` and `12.00`, so `sort=price-asc` silently returned nonsense), and **`body_html` is flattened to text** (it is both indexed and rendered by the search page).
- `server/api/vendors/index.get.ts` proxies to the external `vendord` scraper service over localhost — `http://localhost:3434` in production, `http://localhost:3001` in dev, both overridden by `VENDORD_URL` (`server/utils/vendord.ts`). It forwards only what the scraper needs to look like a browser, never the caller's cookies. Vendors carry a `type` (`shopify`/`bigcommerce`/`amazon`) and `config`; fetched products are cached in the `productCache` table.
- `server/api/vendors/extract.get.ts` + `server/utils/part-extractor.ts` is a **self-contained in-process extractor** that needs no scraper service or DB: given a product URL it tries Shopify's `/products/{handle}.json`, then JSON-LD, then an Amazon-specific DOM read (their meta tags describe the storefront — `<meta name="title">` is `"Amazon.com: {name} : {category}"` and there's no price tag at all), then OpenGraph/meta. It is auth-gated and refuses loopback/private/link-local hosts so it can't be used as an SSRF proxy.

  **A schema.org `ProductGroup` stands in for a Product**, and reading only `@type: Product` is what made Bambu Lab's store arrive with a title, an image and no price. Shopify's newer storefronts describe an options product as a ProductGroup: the group holds the name and description, every choice sits under `hasVariant` with its own `offers`, and the group itself carries no offers or image at all. `collectProducts` now gathers groups into a second list, preferred only when no plain Product matched, and `variantsFromProductGroup` reads the choices out — variant id from the `?id=`/`?variant=` in each offer's URL, price from its offer, and the title with the group's own `"{product} - "` prefix stripped, since that is how Shopify names a variant. The group's price is the selected variant's, honouring a `?variant=`/`?id=` deep link the same way the Shopify path does.

  Two details there are deliberate. The markup falls back to the **variant id as the `sku`** when a product has none of its own — every Bambu Lab part — so a `sku` equal to the id it was read from is dropped rather than shown to a buyer as a part number. And the JSON-LD path now falls back to **`og:image`**, because a ProductGroup has no image of its own.

  **A `WebPage` is allowed to hang the product off `mainEntity`**, and reading only the top-level `@type` missed it. Rock West Composites (Salesforce B2C Commerce) marks its pages up that way — `WebPage` with the real `Product`, complete with `sku`, `offers.price` and `image`, one level down — so the OpenGraph fallback took over and every part arrived with a title and nothing else. schema.org defines `mainEntity` as "the primary entity described in this page", so a Product found there *is* the product, never an incidental mention; both `collectProducts` and `collectById` descend into it.

  **Rock West's quantity discounts are in the markup, not the JSON-LD**, which quotes only the single-unit price. Their tier table (`<span class="tier-quantity" data-quantity data-price>`) becomes `priceBreaks`, the same field DigiKey fills, so `OrderEditorSlideover.vue` already renders the tiers and applies the one the entered quantity reaches. It needs no extra request — the tiers are in the page already fetched — and attributes are read by name rather than position, since a template is free to reorder them and a positional regex would fail by silently finding nothing. Fewer than two tiers is treated as no schedule at all, because a lone tier is just the ordinary price restated. Thresholds vary by product (2+/5+, 6+/25+, 10+/50+) and some products have none. The markup is that platform's default tiered-pricing template so it would likely hold for other stores on it, but only Rock West is confirmed and only Rock West is asked.

**A few vendors are rendered in a real browser.** `BROWSER_RENDER_HOSTS` in `server/utils/vendord.ts` names them; `extract.get.ts` asks vendord to load the page in headed Chromium and passes the HTML to `extractPart`, which then reads it with the ordinary strategies. The browser buys page *access*, not a parser.

Several things about it are deliberate:

- **It lives in vendord, not the app.** Chromium is by far the heaviest thing on a 1 vCPU / 2 GB box, and vendord is the process that can afford to die: if a render exhausts memory it takes the scraper down, the site keeps serving, and the extractor falls back to fetching the page itself.
- **Headed, under Xvfb.** Headless Chromium is refused by these challenges — measured against Powerwerx, headless gets 403 and headed gets the page — so `provision.sh` installs `xvfb`, runs it as its own systemd unit on `:99`, and `ecosystem.config.cjs` passes `DISPLAY=:99` to vendord. A unit rather than `xvfb-run` so the display outlives a vendord restart.
- **Every failure degrades.** No display, no Chromium, challenge never clears, vendord down — all return null, and `extractPart` falls back to its own fetch, which is exactly what it did before. Nothing about this path can make a lookup fail that used to succeed.
- **One browser at a time**, launched per request and closed in a `finally`. Two concurrent launches would double the memory on a box with about a gigabyte spare, and a leaked Chromium is the one thing it cannot absorb.
- **The list is short on purpose.** It only helps where the block is a solvable challenge. Lowe's and Home Depot answer a flat deny that a browser does not clear either, so adding them would spend the memory for nothing.
- **Playwright is a dependency of the *root* `package.json`, not just vendord's.** vendord ships as a Nitro bundle whose traced `.output/server/node_modules` is deliberately excluded from the upload, so its externals resolve by walking up into `/srv/parts/node_modules` — which is what the droplet's root `bun install` fills. Listing it only in `vendord/package.json` installs it nowhere the droplet can see.
- **These hosts get a longer request budget.** Measured on the droplet, launching Chromium and loading a Powerwerx product page takes 6.3s against the 9s that suffices for everything else; aborting mid-render would fail the request with a 502 instead of falling back, so `extract.get.ts` allows 25s when the host needs a browser.

  **The browser is kept alive between renders**, which is where most of the time went. A cold launch costs 766ms on the droplet against roughly a second of navigation, so paying it per lookup was the single largest cost. `renderPage` now holds one Chromium and closes it after 30 minutes idle — long enough to cover a whole ordering session, since a ten-minute window made a team pay for a relaunch mid-session, and short enough to hand the memory back on a box nobody is using. A fresh *context* per render keeps one vendor's cookies off another's page; that costs a few milliseconds against the hundreds the reuse saves. `isConnected()` catches a browser that crashed or was OOM-killed underneath us, which on a 2 GB box is a question of when.

  **Subresources that cannot affect the DOM are aborted** — images, media, fonts, stylesheets. Scripts, XHR and fetch are emphatically not blocked: the challenges *are* scripts, and BrickLink's product arrives over XHR after the shell. Blocking an image does not remove its `src` from the markup, so image URLs still extract.

  **A vendor's own JavaScript is dropped where the data is server-rendered**, and that is most of a render's cost. Measured on the droplet, Online Metals went from 3642ms to 730ms with its scripts blocked — 194 requests down to 70 — for a byte-identical extraction. `blockScripts` is opt-in per host and verified by extracting with and without and comparing, never assumed: Online Metals, Powerwerx and VEX come back with the same price and the same variant counts at a third to a fifth of the time. BrickLink must *not* have it, and is the reason it is opt-in: their product arrives over XHR after the shell, so without scripts the render yields nothing at all.

  The bot walls are themselves scripts, so `CHALLENGE_INFRA` keeps `cdn-cgi`, `awswaf` and the like running even when the vendor's code is dropped. That was never exercised in testing — these hosts served a browser without challenging it every time — so rather than trust it, a render that comes back still showing a challenge with scripts blocked is retried once with them allowed. The fast path stays fast and the rare challenged request still succeeds.

  **BrickLink's converted price follows the client's IP, not its locale.** The seller quotes in their own currency and BrickLink adds a conversion — `~US $115.6733` from the droplet's New York address, `~GBP 85.4941` from elsewhere. The extractor looks for a dollar figure, so from the wrong vantage point the price simply vanished. It now records the seller's own figure in the line item's notes whenever there is no dollar amount, with an instruction to enter the price, rather than leaving a part with no indication of what it costs. Pinning the browser context's locale does *not* fix this and is not there for that reason; it only makes renders otherwise deterministic.

  Measured end to end through the authenticated endpoint, steady state: Powerwerx 2375ms → 1367ms, VEX 3295ms → 1125ms, BrickLink 3170ms → 2361ms, Online Metals 1829ms → 1573ms. With a cold launch in the mix the gap is wider still — BrickLink went 9802ms → 2347ms.

  **The droplet is much slower than a laptop and that is CPU, not the browser**: the same three pages take 3.7s, 4.7s and 10.8s there against ~1-2.4s locally, because one vCPU executes a storefront's JavaScript slowly. Reuse and blocking do not help with that, which is why browser-rendered hosts get a 25s request budget rather than the 9s everything else uses.

  Holding a warm browser costs about **358 MB** — the droplet's free memory goes from ~1159 MB to ~801 MB and returns exactly when the idle timer fires, with no Chromium left behind. That is the deliberate trade for the latency. Two things were considered and rejected: reusing a *context* per host would keep the challenge clearance cookie and save BrickLink's 582ms WAF solve, but multiplies resident memory per host and risks a stale-cookie loop for one vendor's benefit; and blocking third-party domains turns out to buy nothing, since what these pages fetch is their own infrastructure plus the WAF endpoints the challenge needs.

**A rendered page beats a URL guess**, so `URL_ONLY_VENDORS` is skipped when the caller supplies HTML — Studica is in both lists, using the render when there is one and its slug when the browser could not produce one. The URL parser is still applied at the end of `extractPart` for that case, so a render that yields nothing readable falls back rather than returning nothing.

**Powerwerx needs its price and variants read out of the page.** Their JSON-LD names the product and stops: the Offer is an `AggregateOffer` carrying `lowPrice` 4.79 against `highPrice` 1089.19 over 62 offers, and there is no `sku` anywhere in it. That low price is a "from" figure that reads like a real one — the same trap WCP's configurator pages set — so `powerwerxFields` **overrides** it with the first `.product-price` on the page ($73.99, what the page actually shows) rather than filling in behind it. Their variants are a run of sibling elements tied together by the product id in the sku element's own id (`sku-2336` alongside `price-value-2336`): one `specAttr` per option, then the sku, then the price. All 62 come back, which matches the `offerCount` in the AggregateOffer — a useful cross-check. The option's unit lives in its *name* rather than its value ("Wire Gauge (AWG)" with value "2"), so it is appended, or the picker reads "2 / 25 ft." and loses what the 2 measures.

**BrickLink is a marketplace, and the vendor name carries the seller.** A store URL is `/{storeSlug}?itemID=N#/shop`, and the same LEGO part is listed by many sellers at their own price and condition — so the vendor is `BrickLink — Old Brick`, not `BrickLink`. Without the seller, two parts bought from two sellers group into one order that cannot be checked out as one, since `findOrCreatePendingOrder` groups by vendor and each seller is a separate checkout. The seller's display name comes from the `<title>` ("Old Brick - BrickLink.com"), falling back to the store slug in the path.

Their page has **no JSON-LD, no OpenGraph, and a `<title>` naming the shop rather than the item**, so the generic fallbacks would name a part after a store — and before a render was available they did worse than that, reading the interstitial and producing a part called *"JavaScript is disabled"*. `fromBrickLink` reads the item row the SPA renders instead, and its `source` is `html` rather than a structured-data label, because that is what it is.

Two things about the price. The seller may quote in their own currency, in which case the row reads `Price: EUR 99.5299(~US $115.6733)`; the dollar figure is taken either way, because this schema stores a bare number with no currency beside it and a euro amount would be recorded as dollars. When that figure is BrickLink's own conversion the line item's notes say so, so the record does not silently claim a price the seller will not charge. A US seller shows a plain `US $` and gets no such note.

**Two renderer behaviours BrickLink forced, both general.** AWS WAF announces itself only through the globals its script sets — its page has an empty `<title>` and no visible text — so `awsWafCookieDomainList` and `gokuProps` join the challenge markers. And it clears by *reloading*, which made `page.content()` throw "Unable to retrieve content because the page is navigating" and abort the whole render; content reads now treat that as "nothing yet" and ask again, which any reloading challenge needs. `BROWSER_RENDER_HOSTS` entries may also name a `waitFor` selector, since clearing the wall on a single-page storefront reveals a shell and the product arrives over XHR afterwards — BrickLink waits for `.item.table-row`; the other three are server-rendered and name nothing.

**Seattle Fabrics is Shift4Shop (3dcart), and their options are the whole vendor.** Cloudflare's managed challenge sits over everything, robots.txt included, so a plain fetch gets 403 — but unlike Micro Center's, a headed browser clears it on the first navigation every time, so they are in `BROWSER_RENDER_HOSTS` with `blockScripts` (verified identical extraction at 665ms against 2106ms; the option data is in inline scripts, which blocking external ones does not touch).

They publish **no JSON-LD at all** — only schema.org *microdata* as `<meta itemprop>` tags. The OpenGraph fallback therefore already reads their price and image correctly, and `seattleFabricsFields` exists for the two things it cannot do: name the product, and find the options.

- **`og:title` is their SEO title** ("500 Denier CORDURA® Fabric for Sale | Seattle Fabrics"). The `<h1>` carries the real product name and is used instead.
- **The name keeps its price and unit.** 35% of their 839 products are titled like `60" 500 D. CORDURA® Nylon @ $16.50 - $18.50/ linear yard`. That reads oddly on a line item, but the unit is load-bearing for fabric — you are buying a length — and the price and unit are welded into one phrase, so splitting them reliably across 293 variations is the kind of guess that produced Micro Center's fabricated "30.6 GBps". It stays verbatim.
- **`_p_{id}.html` is a product, `_c_{id}.html` a category**, and the branch refuses anything else outright. A category page has an `<h1>` and no price, so without the gate "500 D. CORDURA®" becomes a priceless line item — the trap VEX's slug pages and WCP's configurator pages set.
- **The id is authoritative and the slug is decoration**, exactly as Online Metals' `/pid/` is: `/utter-nonsense-slug_p_52.html` still serves the CORDURA, and a stale slug redirects to the current one. A sitemap URL for product 28 came back as "Sunbrella Hold" because that product had been renamed since — the extractor was right and the URL was stale.

**Reading the options takes two sources, and the obvious one is a trap.** The picker is an ordinary `<select name="option-{groupId}-{productId}">`, and the part number comes from parallel JS arrays keyed by index, where `inventoryarray` leads with the option id: `inventoryarray52[2] = '627#-9629'` alongside `idarray52[2] = 'FC5-RED'`.

`aopricearray` sits right beside those and is **not** the price. It is `'0'` for every option of every product in the catalogue, including the ones that demonstrably cost more. The real figure is in hidden inputs the store's own `validateValues()` reads — `price_{optionId}` (absolute) and `pricep_{optionId}` (percent) — and they hold *adjustments to the base price*, not prices, which is why grepping the markup for the price a buyer sees finds nothing: the $11.95 option is stored as `3.00` against an $8.95 base. Applied percentage-first then absolute, matching the store.

That is what makes the picker honest, and the products cross-check themselves: the CORDURA's Berry Compliant colours carry `+2.00` on a $16.50 base, which is exactly the "$16.50 - $18.50" its own title advertises, and HH-66 Vinyl Cement's `0/6/18/30/98` on a $20 base gives the $20–$118 quarter-pint-to-gallon ladder. Reading `aopricearray` instead would have quoted $16.50 for an $18.50 fabric, silently.

Two smaller rules. Variants are built **from the `<select>`, never from the arrays** — the CORDURA's arrays carry 26 options while the store offers 9, the rest being colours withdrawn from sale — and an option with no array entry is dropped, which is what both a placeholder (`<option value="">Width</option>`) and a degenerate single-choice group ("Black/Black" beside the real picker on the neoprene) look like. A product left with exactly one option returns it as the product's `sku` rather than as a one-item picker, the same rule the nested-offer reader uses.

**Online Metals is rendered now, not delegated.** They used to be the one entry in `DELEGATED_HOSTS`, handed to vendord as a *fetch* — which produced nothing usable, so a part fell through to the URL parser and arrived named from its slug ("1 5 X 1 5 X 0.125 Aluminum Angle 6063 T52") with no price. A browser render returns the page's own JSON-LD instead: the real name with its dimensions, the sku, description, image, and an `AggregateOffer` holding one nested offer per cut length. `DELEGATED_HOSTS` is now empty; the mechanism is kept because it is sound and the next unreadable vendor may suit it.

  **Nested offers inside an AggregateOffer are variants**, and reading them is general schema.org rather than an Online Metals shim. Each offer carries the `?variant=` id its own URLs use, the price for that length, and an `additionalProperty` list — of which the shipping-weight entries are dropped, since a variant labelled "12.0 / 0.44" would be offering the buyer a weight. A `?variant=` in the pasted URL now selects against that list, so a deep link to a 36" cut prices as $14.97 rather than as the cheapest offer, and carries `1023_36_0` as its SKU. A single nested offer is ignored: that is the price restated, not a choice.

  Their `pid` is authoritative and the slug is decoration — `/pid/1023` redirects to whatever the canonical slug is, so a stale or wrong slug still resolves. And they interpolate a missing field straight into the product name (`Legs: 1.5" x 1.5"null, Thickness: 0.125"`), so `cleanName` strips it. The first version anchored to a closing inch mark, which only covered `1.5"null,` and missed `Litz Wirenull,` — the value it follows can be any character. What is constant is the shape: a lowercase `null` welded onto the end of a value with the field separator immediately after, so the rule requires a non-space before and a comma-or-end after. That is what spares the name of a Null Modem Cable, where `Null` is a word with a space on each side.

Three escape hatches exist for vendors the extractor can't read directly:

- **A vendor API** — `server/utils/digikey.ts` calls DigiKey's Product Information API v4, which `extract.get.ts` tries first for DigiKey links (`source: 'digikey'`). It beats the page even where the page were readable: description, stock, packaging variations, and quantity price breaks. Tokens live ~10 minutes and are cached in module scope — one token for the whole process, now that it is a long-lived Node server rather than a Worker isolate. With no credentials set it returns `null` without making a request, and the URL fallback below takes over.

- **Delegation to vendord** — `DELEGATED_HOSTS` in `server/utils/vendord.ts` sends a host to the scraper *first*, mapping its reply into the extractor's own result shape (`source: 'scraper'`); if vendord is down or blocked in turn, the extractor's own fallbacks still run. The list holds **Swyft Robotics**, whose RSC flight payload only vendord can read (see *Swyft is delegated to vendord* above). Online Metals used to be here and is browser-rendered now, which reads their page properly where the scraper hop did not.
- **URL-only vendors** (`URL_ONLY_VENDORS` in `part-extractor.ts`) — hosts whose pages a server can't usefully read at all. These are matched *before* any network call and parsed straight from the URL (`source: 'url'`), and none of them yields a price. Online Metals decodes `/buy/{category}/{slug}/pid/{pid}` plus the `?variant=` cut length; McMaster-Carr decodes the part number out of `/91290A115/`; DigiKey lands here when no API credentials are set; Studica takes a name guessed from its flat slug and deliberately no SKU; VEX decodes the part number out of `/276-4810.html`, which is exactly what their own page reports as both `sku` and `mpn`; Lowe's decodes `/pd/{slug}/{itemNumber}` into a title and their own "Item #", Home Depot `/p/{slug}/{internetNumber}` the same way, Menards `/main/…/{slug}/{model}/p-{id}-c-{cat}.htm`, whose model number is the SKU, Harbor Freight `/{slug}-{itemNumber}.html`, and Micro Center `/product/{itemNumber}/{slug}`. What the UI does with the result is uniform: `source === 'url'` with a null price raises the "this vendor blocks automated lookups" warning in `OrderEditorSlideover.vue`, so the buyer knows to check the name and type the price in. A second wording covers the case where *nothing* was read — no product from the extractor and none from vendord either, which is Bolt Depot — since the first one promises details that in that case do not exist. Both share one notice box; the silent version, a form that simply sat blank, read as a lookup that had never run.

  **Probing a blocked vendor costs the person whose machine you are on.** These checks go out over the developer's own connection, so a WAF that decides it is looking at a bot flags their residential IP, not a sandbox — and that block applies to their browser too, not just to the tooling. Working out *how* Grainger blocks (homepage, robots.txt, a category page, a product page, then headless and headed Chromium, then Zoro) cost the owner of this repo their personal access to grainger.com, and Menards' Imperva escalated mid-session until sitemap URLs that had worked minutes earlier stopped answering. Headless-browser automation from a residential IP is about the strongest bot signal there is. So: confirm a block **once** and stop. Characterising it further is not worth someone's ability to use the site, and none of the detail above changed what got built — every one of these vendors ended up URL-only regardless.

  Eight of these are blocked rather than merely unreadable, and the blocks differ. **McMaster is never requested** — their pages render client-side, are marked `noindex, noarchive`, and robots.txt disallows the endpoints serving the data, so a fetch returns a shell whose only title is "McMaster-Carr". Don't add a scraping path for them. **Studica and VEX are Cloudflare**, and neither is readable by any plain request: both refuse curl, Node's `fetch` (so delegating a *fetch* to vendord achieves nothing — it makes the same kind of request) and headless Chrome. Both are now in `BROWSER_RENDER_HOSTS` instead, which does clear them. The older note here said a headed browser was "re-blocked after roughly one navigation" for VEX, and that turns out not to describe this usage: a fresh browser is launched and closed per lookup, so every request is a first navigation — four consecutive product pages rendered clean. They stay in `URL_ONLY_VENDORS` as well, as the fallback for a render that does not happen, and because their URL grammar is load-bearing (below). Both publish complete schema.org Product data, so an allowlist would still be better than a browser: delete the render entry and let an ordinary fetch run.

**The product/non-product gate is opt-in, and only VEX opts in.** Where a vendor's URL grammar genuinely tells a product from a category, it stays authoritative even once the page can be read — VEX's slug pages (`/wheels.html`) carry the same `.html` suffix as a part number and are marked up as a `Product`, "Wheels" at $9.99, so rendering one and trusting its JSON-LD turned a category into a line item.

  Applying that rule to *every* URL-only vendor was wrong, and Online Metals showed why. Most of these parsers exist to salvage a name from a URL when the page cannot be read, not to rule on what a product is, and their grammars are only as complete as the URLs that happened to be seen when they were written. Theirs required a numeric `/pid/`, so a marketplace item at `/pid/mp-00065192` did not match — and the blanket gate turned an unanticipated id into "not a product" for a page that renders perfectly, with six spool sizes and their prices. The id rule now accepts any word characters, and the gate is a per-vendor flag.

  **Lowe's is Akamai Bot Manager**: a plain fetch is answered 403, a full browser header set gets the behavioural challenge interstitial rather than the page, and Chromium — headless *or* headed — is answered "Access Denied" outright, so there is nothing for vendord to add either. Their robots.txt separately disallows `/pd/*/*/pricing/*`, which puts the price out of bounds by their own policy rather than merely out of reach, the same standing as McMaster.

  **Home Depot is the same block and the same answer.** AkamaiGHost returns a bare "Access Denied" to a plain fetch — not even a challenge — and refuses Chromium identically whether headless or headed. Their `federation-gateway` GraphQL API does respond, but only to a storefront key carried in page JS the block keeps out of reach; harvesting one to get around a control they have deliberately put up is not something to build here, and their affiliate product feed is the sanctioned route if this is ever wanted properly. Unlike Lowe's, their robots.txt permits `/p/` — the block is technical rather than policy — but permitted and possible are different things. The slug must contain a hyphen, or `/p/qv/{id}`, the quick-view endpoint their own robots.txt disallows, parses as a product named "qv"; all 45,000 product URLs in their sitemap are multi-word, so nothing real is turned away, and Lowe's gets no such rule because 373 of theirs genuinely are one word.

  **Bolt Depot is a Cloudflare managed challenge**, and their URL carries nothing to fall back on: `/Product-Details?product=8972` is an id and no name, so there is no slug to rebuild a title from and no `URL_ONLY_VENDORS` entry worth writing. Worth knowing that their robots.txt is `Allow: /` with only `/cdn-cgi/` excluded — they invite crawling, and the block reads as Cloudflare's bot-fight default rather than a decision about them, so asking them to allowlist the droplet is the route that would actually make their pages extract.

  **A vendor is still known when nothing else is.** When the extractor finds no product the slideover falls through to vendord, and for a host like this vendord answers "Product not found on vendor site" — a throw that used to leave the whole form empty, discarding the vendor name the extractor had already derived from the hostname. It is now applied before the scraper call, so a blocked vendor at least fills that field in; a scraper that does succeed overwrites it with its own vendor as before.

  **Micro Center is Cloudflare, and the browser does not reliably clear it** — which is what separates them from Studica and VEX, whose entries in `BROWSER_RENDER_HOSTS` clear the same vendor's wall every time. Measured: one render in five got through, after **28 seconds**, and the other four sat on the interstitial for the full window; by the fifth the store had stopped issuing a clearance cookie to that address at all, on a fresh context and a second product. So there is deliberately no render entry. Adding one would make every paste hang for the whole 25s browser budget and then fall back to exactly what the URL parser returns anyway, while each attempt spends the standing of the address making it — and in production that is a DigitalOcean IP, which Cloudflare treats more harshly than the residential one those numbers came from. Their robots.txt is behind the same wall, so their crawl policy cannot be read either, which puts them in McMaster's and Grainger's category rather than Harbor Freight's. They are matched before any network call and **their site is never requested**.

  Their URL is the good kind: `/product/{itemNumber}/{slug}`, where the item number is Micro Center's own — the number on the shelf tag, and what their search takes — and the slug is unusually descriptive. `/support/{id}/{slug}` shares the shape but not the first segment, so it does not match.

  Two things about rebuilding that title. It must **not** go through `titleFromHardwareSlug`: that rebuilder exists for stores which hyphenate a decimal — Menards writes `1-1-2-in` for an inch and a half — whereas Micro Center simply drops the point, so "SATA 3.0 6 GBps" arrives as `sata-30-6-gbps`. Run through it, the 30 pairs with the 6 and the title claims "30.6 GBps", a figure the product does not have; inventing a number is worse than leaving the URL's own spacing alone. The dropped point is not recoverable in general either, and shouldn't be guessed at — `25-inch` is a collapsed 2.5″ drive on one product and a real 25-inch monitor on the next.

  And their catalogue is written in acronyms, which a de-slugged title capitalises as ordinary words — "Ssd", "Nvme", "Pcie". `MICRO_CENTER_TERMS` is an explicit table of display forms rather than a rule about short tokens, so it can only reach words that are always acronyms here and never a size, and it carries the mixed case no uppercasing rule would reach ("PCIe", "GBps", "eMMC"). `capitalizeTitle` takes it as an optional argument, so Menards and Harbor Freight are untouched — their titles were validated without it and are not changed blind. Deliberately absent from the table: `m2`, since an M2 screw is a real thing a team buys and "M2" is right for both readings where "M.2" is right for only one.

  **Harbor Freight is PerimeterX**, and their homepage is the only thing that gets through it — cached hard at the edge — while product pages, category pages and the sitemap all answer 403 with a `px-captcha` body. robots.txt is readable and permits product pages, so this is a bot control rather than a policy about crawlers. Their URL is the good kind: `/{slug}-{itemNumber}.html` carries both the lowercase title and the Item # from their shelf tags, so it goes through the same reconstruction as Lowe's, Home Depot and Menards, title-cased as Menards is.

  Worth knowing the corpus behind that is **thin**, because the sitemap and every category page are blocked: one product URL lifted from their own homepage, plus the nine non-product links beside it. The single path segment plus trailing digits is what separates them — `/deals.html` and `/join-inside-track-club.html` carry no number, `/collections/inside-track-club-deals.html` is two segments. The slug reconstruction it leans on is the one already validated against 60,000 URLs from the other three, so the untested part is only the match rule. If their URLs ever turn out to have another shape, that is where to look.

  **Grainger is not worth investigating again.** They answer every request — product page, category, homepage, even `robots.txt` — with a WAF incident page carrying HTTP 200 and the title "Whoops, we couldn't find that.", so a block reads as an ordinary 404. Headless Chromium gets the same page, a headed one gets a 403, and zoro.com (their sister company) answers 403 as well. With robots.txt itself blocked there is no way to read their crawl policy or reach a sitemap, so there is no corpus to validate a URL parser against and none was written; their B2B API for account holders is the only sanctioned route. Someone paying for that lesson once is enough.

  **Menards is Imperva, and the block is selective.** Their home page, category pages and sitemaps all serve a plain fetch happily — the whole 6,690-URL product sitemap included — while a product page answers with Imperva's "Pardon Our Interruption" challenge. Chromium is refused harder still, headed or headless: a bare "Request unsuccessful. Incapsula incident". Probing further escalated it, with sitemap URLs that had worked minutes earlier starting to answer the interstitial too, which is the point to stop rather than push. Their vendor name needs no `FRC_VENDORS` entry — the host fallback already yields "Menards".

  **Lowe's slugs need their fractions rebuilt.** The slug is the product title with every space hyphenated, which flattens `3/4` and `3.375` into the same `3-4`/`3-375` shape — so a naive de-slug renders a half-inch bolt as "1 2 in", which for hardware is the part of the name that matters most. A fraction is recoverable from what hardware fractions look like: the denominator is a power of two and a fully reduced numerator over one is always odd, since `2/4` would have been written `1/2`, and a leading zero settles it the other way because nothing is sized `0/944`. Validated against the 7,855 product URLs in `sitemap/detail0.xml` — which is served happily even though product pages are not: `3/4-in`, `1/8-in` and `1/32-in` come back as fractions while `3.375-in`, `94.48-in`, `0.944-in`, `1.023-in` and `3.5625-in` stay decimal. The unit is rejoined only to a measurement (`6 in` → `6-in`); unanchored, that rule also rewrote prose, turning "All in One" into "All-in One". The pairing is greedy from the left, which misreads a run of three numbers whose *last* two are the measurement — "RED-SINCE-1885-7-5-in" becomes "1885.7 5-in" — but that is 63 of those 45,000 URLs and all brand slogans carrying a year, so it is left alone rather than traded for a rule that would misread the 1,682 genuine `21-1/2-in` runs.

  **A trailing model number is dropped from the title**, since both stores tend to end the slug with one (42% of Home Depot's URLs, 5% of Lowe's) and it reads as noise on a line item. The test is strict on purpose, because the failure that matters is stripping a *size* — for hardware that is the half of the name carrying the meaning, the same reason fractions are rebuilt. Requiring two letters spares `10X14`, `1000W` and `5000K`; an explicit dimension guard spares `10X14X2`, whose two X's would otherwise count as letters. Erring this way leaves single-letter models like `G16010` in place, which merely looks untidy.

  **Two things only Menards needs.** Their measurements write the dimension letter straight onto the denominator — `69-1-4w` for 69-1/4″ wide — and 527 of the 748 measurements in their sitemap look like that, more than don't; the fraction reader takes an optional one- or two-letter tail (`w`, `d`, `h`, `mm` are all that occur) and hands it back attached, upper-cased, so the title reads `69-1/4W x 80H`. A letter run only counts when it sits directly on a digit, which is what leaves the `lb` in `4-lb` alone. And their slug is entirely lowercase, so it is title-cased on the way out, with `x` among the words left down since it is the dimension separator in half these names. Lowe's and Home Depot must *not* be title-cased — their slugs carry the real casing, and running them through it would render "DEWALT", "KILZ" and "RUBI" as "Dewalt", "Kilz" and "Rubi".

  VEX accepts **only** the `NNN-NNNN.html` part-number shape. Their slug pages (`/wheels.html`, `/gears.html`) carry the same `.html` suffix and are marked up as a `Product` — named "Wheels", with a null price and nothing orderable behind them. Turning one into a line item is the same trap WCP's configurator pages set, so they get no extraction at all. Anchoring the digits is also what rejects `/123-kits.html` and `/393-motors.html`, which are slugs that merely begin with them.

**Vendor cart handoff** — `server/utils/cart-link.ts` turns a `to_order` order into a one-click cart on the vendor's own storefront, served by `GET /api/orders/:id/cart-link` and surfaced by `app/components/VendorCartButton.vue`. Two platforms: **Shopify** (`/cart/{variantId}:{qty},…?storefront=true`), which needs the numeric variant id — items usually store a SKU, so unresolved ones are looked up through the part extractor; **Amazon** (`/gp/aws/cart/add.html?AssociateTag=0&ASIN.n=…&Quantity.n=…`), which needs no lookups because the ASIN is in every product link; and **DigiKey** ([FastAdd](https://forum.digikey.com/t/digikey-fastadd-bulk-add-parts-into-a-digikey-cart-via-third-party-tooling-and-urls/61356), `/classic/ordering/fastadd.aspx?part1=…&qty1=…`), which needs DigiKey's own part number and so resolves the stored manufacturer part number through their API. Two vendors add one part at a time instead, and come back as `addLinks` — a link per part that the button lists in a popover, ticking each off as it's followed. Every row targets the same named window so the buyer walks through one tab, and adds accumulate in the vendor's session.

**Some storefronts are Shopify only at checkout**, and `NO_CART_HOSTS` in `cart-link.ts` (mirrored by the same name in `app/utils/cart.ts`) is the list. Bambu Lab is the first: `/products/{handle}` reads as a Shopify path, and their ProductGroup markup hands over genuine variant ids, but `/cart/{id}:{qty}`, `/cart.js`, `/products.json` and `/products/{handle}.json` all 404 — they run a custom frontend over Shopify's checkout. Nothing upstream can tell, so without the entry the button appears, builds a permalink from real ids and sends the buyer to a 404. That is worse than not offering it, so `detectPlatform` returns `null` for those hosts and the button never renders.

**Playing With Fusion** takes a `POST` to `/addtocart.php` with `qty=N` and `pdids[]=<id>`, so those rows carry `postFields` and the UI submits a form rather than following a link. The product id is right in the URL (`/products/118`), so no lookup is needed. The same request as a `GET` leaves the cart empty, and several `pdids[]` in one `POST` all land at the single `qty` (a `qty[]` array is ignored) — hence one request per part.

**Rock West Composites** is Salesforce B2C Commerce, and adds one part per `POST` to `Cart-AddProduct`, so those rows carry `postFields` like Playing With Fusion's. Checked against the live store, so it needn't be re-derived: a `GET` answers 500 (SFRA registers the route POST-only, so no link can ever add to that cart), the POST needs no CSRF token and opens a basket on its own, several parts in one request is not on offer — a repeated `pid` adds only the first and a comma-separated one answers 500 — and adds accumulate against the session cookie, so following the rows in one tab builds the cart and `/cart` then shows the lot.

Their add answers with **JSON, not a page**, so the handoff tab would otherwise sit on `{"action":"Cart-AddProduct"…}`. `VendorCartButton.vue` follows a form row by re-targeting the same named window at the cart. Two constraints shape that. The add has to stay a top-level navigation — moved into a hidden iframe the store's session cookie becomes third-party and gets blocked, and the cart the buyer finally opens is empty — and nothing cross-origin reports when that navigation finished, so the follow-up is timed rather than triggered. The delay is load-bearing: navigating too early aborts the POST in flight and the part is *silently* missing. Measured in Chromium, a 250ms follow-up loses the add outright and 800ms does not, against an add that loaded in 330–776ms over five runs; `CART_REVEAL_MS` is 2s for that margin, and a connection slow enough to beat it still fails visibly, since the buyer lands on the cart page listing exactly what is in it with every row still clickable.

The `pid` is the SKU, and it is deliberately not taken from the URL. Their pages sit at `/{sku}.html`, but a product with variants sits at the *master's* path while the orderable SKU is a variant's — `/35051-s.html` carries sku `35051-s-12`. Posting the master does work, pricing correctly against the default variant, and that is exactly why it is wrong to send: it succeeds while silently picking a length for the buyer. The SKU read off the part's own page names the variant they chose, so a part whose SKU can't be established is excluded rather than guessed at.

**Seattle Fabrics** adds one part per `POST` to `add_cart.asp`, like Rock West, and their entry in `server/utils/seattle-fabrics.ts` records what was checked against the live store so it needn't be re-derived:

- A GET without `quick=1` is refused outright (`/?error=missing_item_id`).
- `GET add_cart.asp?quick=1&item_id=N` *does* add and honours `qty-0` — but **ignores options entirely**, bouncing an optioned product back to its own page having added nothing. Most of this catalogue has options and they are the half that matters (the colour, the width), so the obvious route is the wrong one.
- **The POST must be `multipart/form-data`.** Sent as `application/x-www-form-urlencoded` the request is accepted and the cart stays empty — the worst kind of failure, because it looks like success. `CartAddLink` gained an optional `enctype` for this; every other vendor leaves it unset and gets the browser default.
- Several parts in one request is not on offer: a repeated `item_id` and an indexed `item_id-0`/`item_id-1` both leave the cart **empty** rather than adding the first, so there is no partial success to salvage.
- Adds accumulate against the session cookie, so following the rows in one tab builds the cart and `/view_cart.asp` shows the lot.

**The option field name is not constructible**, and this is the trap: the CORDURA's select is `option-di_62-52` while the tape's is `option-1872-595`. Posting a constructed name adds nothing and reports success — it cost one silently half-filled cart to find. It has to be read off the page, which is why `buildSeattleFabricsCart` renders each distinct product once rather than deriving the fields from the URL alone.

That render is also why **a part whose option cannot be established is excluded rather than posted without one**, including when the page could not be rendered at all: without it there is no way to tell a product that needs no option from one that does, and a bare add for an optioned product bounces silently. Same reasoning as `rock-west.ts` refusing to post a master id.

**`server/utils/seattle-fabrics.ts` is shared with the extractor** deliberately. Both the variant picker and the add need to agree on what an option is called, what it costs and which field carries it; two copies would drift, and the failure mode is a buyer choosing one colour and receiving another. `part-extractor.ts` imports `seattleFabricsOptions`/`seattleFabricsPrice` from it, and the picker's variant `id` is the **option id** while its `sku` is the part number — the slideover stores `sku ?? id`, so the order keeps carrying the SKU and the cart matches it back.

Verified end to end through the real button against the live store: three parts, two of them optioned, posted one at a time into one tab produce `Cart Subtotal (6 items): $89.40` — `$18.50×3` for the Berry Compliant CORDURA, `$11.95×2` for the 3/8" tape, `$6.00` for an option-less pattern, plus their `$4.00` handling line. A deliberately bogus SKU was excluded rather than guessed. One run in five lost the *first* add to the popup racing Cloudflare's challenge; that degrades visibly rather than silently, since the buyer lands on the cart listing exactly what is in it with every row still clickable.

**BigCommerce** (REV Robotics, BaneBots) is the other: it adds one product per URL and ignores every multi-item form — array parameters, redirect chaining, `action=addbulk` — so those orders come back as `addLinks`, a link per part that the button lists in a popover. Adds accumulate in the vendor's session, so following them in one tab builds the cart up. The id in those URLs is BigCommerce's internal product id, read off the add-to-cart form on each product page (`data-product-id` appears on every related-product tile too, so it's the wrong one to grab). Whether a bare add will actually land can't be predicted — a product with options and one that's out of stock both just bounce to their own page, and neither shows in the markup reliably — so no attempt is made to; the bounce lands the buyer where they need to be anyway.

Platform detection is the fiddly part. An order with no vendor row is identified by its parts' URLs, and `/products/` alone is far too weak a signal — DigiKey (`/en/products/detail/…`) and Playing With Fusion (`/products/118`) both use it without being Shopify. So DigiKey is matched by host first, and the Shopify path check requires the handle to be the last segment *and* contain a letter, since Shopify handles are slugs built from product titles. Anything that still slips through is caught server-side: if no lookup actually reached Shopify's product JSON, the result is `unsupported-platform` rather than blaming the parts for not matching. `AssociateTag` is mandatory — without it the endpoint takes the parameters but never fills the cart, and the failure is invisible to an unauthenticated check because a signed-out request bounces to sign-in either way. The value isn't validated; `0` is deliberate, since a real Associates tag would quietly earn commission on a team's purchases. Parts that can't be resolved are reported in `excluded` rather than silently dropped, and `app/utils/cart.ts` holds a deliberately optimistic client-side check for whether to show the button at all.

**Client data layer** — `app/` is the Nuxt srcDir. Client fetching uses **TanStack Vue Query** (`app/plugins/vue-query.ts`); composables in `app/composables/` wrap endpoints with stable query keys (e.g. `useOrdersQuery` / `ORDERS_QUERY_KEY`). Note that `app/pages/app.vue` copies the query result into a local `ordersState` ref and patches it optimistically (`upsertOrder`/`removeOrder`) from mutation responses rather than invalidating the query. Client order types are derived from the server via `InternalApi` in `app/types/orders.ts`, so changes to `OrderRecord` propagate to the UI automatically. Auth state is exposed via `app/composables/auth.ts` plus `app/plugins/auth.{client,server}.ts`.

**Dashboard interactions** — `/app` offers a board view and a table view. The board has three drag targets: dropping an order on a **column** changes its status, dropping a part on another **order card** moves it there (same vendor, both `to_order`), and dropping a part on the **To order column** splits it into its own order. The table view filters by date range, vendor, status and tag, and exports CSV.

**Mobile layout** — every page fit a phone only after four separate fixes, and the useful thing to keep is *why* each one overflowed, since the same traps recur.

- **`lg` is the header's breakpoint, not `sm`.** `UHeader` renders its own menu button and hides it at `lg`, so anything narrower must keep the nav links behind that button. They used to sit in the bar *alongside* it, which put a signed-in header 205px over a 390px screen and 87px over a 768px one — the tablet case was already broken before any of this. The links now live in the header's `#body` slot (which was previously empty, so the button opened a blank panel), and the bar shows them from `lg` up. `OrganizationMenu`'s org name and the colour-mode button follow the same breakpoint for the same reason.
- **`min-width: auto` is why the board overflowed, not the column count.** The board is already one column on mobile (`grid gap-4 md:grid-cols-3`). What blew it out was a grid item at its default `min-width: auto`, which lets an item grow to *min-content* — and min-content there was a `truncate` part name, since `truncate` sets `white-space: nowrap` and so has a min-content width of the whole untruncated string (450px). The `truncate` could never engage because nothing above it was constrained. `min-w-0` on the grid item and the drop zone fixes it; the ellipsis then works as intended. Any flex or grid child holding truncating text needs this.
- **Wide tables are fine.** `/organization`'s member table is 906px inside a 326px `overflow-auto` wrapper, and the page itself does not scroll. That is the intended pattern — check page `scrollWidth`, not element widths, or contained scrollers read as false positives.
- **The rest was vertical.** `UPageHero` puts 96px of padding above and below its text, which pushed the first filter on `/search` and `/price-changes` 416px down an 844px screen. Both pass `:ui="{ container: 'py-10 sm:py-32' }"`, which trims only the mobile value — `sm:py-32` and the component's own `lg:py-40` are what it already used, so tablet and desktop are untouched.

Verified by measuring `document.scrollWidth - clientWidth` on all eight routes at 320/360/390/430/540/768/1024/1280. 320px needed two extras: the footer's three buttons wrap rather than overflow, and the wordmark drops a size under 360px.

**Routing & rendering** — landing `/` is prerendered (`routeRules`). The authenticated dashboard is `/app` (alongside `/settings` and `/organization`; `/search` and `/price-changes` are public, serving the same catalogue the unauthenticated search API does), gated by `app/middleware/app.global.ts` (redirects unauthenticated users to `/auth/login`, and enforces admin/owner role for `/organization`). Marketing/docs use Nuxt Content: markdown in `content/`, config in `content.config.ts`, served at `/docs`. Layouts: `default` (marketing), `app`, `auth`, `docs`.

**Email/notifications** — Resend + Vue Email templates (`server/utils/*.vue`, rendered with `@vue-email/render`). Per-user, per-org preferences and an audit log live in `notificationPreferences` / `notificationLog`; helpers in `notification-helpers.ts` and `email-service.ts`. Route handlers fire notifications and forget them (`.catch(console.error)`), so a mail failure never fails the write.

**Nitro config** (`nuxt.config.ts`) — `preset: 'node-server'`; `experimental.asyncContext` enabled, which is what lets `auth.ts` call a bare `useEvent()` to derive its `baseUrl`; `pg-native` and `canvas` externalized; `typeof window` replaced with `undefined`; and `@vitejs/plugin-vue` added to the Rollup config so the Vue Email SFCs under `server/utils/` compile into the server build. The Cloudflare bindings that used to live here — `HYPERDRIVE`, `KV`, `DB` (D1), `VPC_SERVICE` — went with the preset; see git history if any of it is ever wanted back.

## Gotchas

- **Code style is inconsistent across the repo.** Some files use single quotes and no semicolons (the top half of `schema.ts`, `part-extractor.ts`, most of `app/composables/`), others double quotes with semicolons (`order-service.ts`, the notification tables, most API routes). Match the surrounding file rather than a repo-wide convention; ESLint stylistic config is in `nuxt.config.ts` (`commaDangle: never`, `braceStyle: 1tbs`).
- **There are no DB transactions.** Multi-step writes — split, move, and the details update that deletes and reinserts payment rows — are sequential statements, so a failure partway through can leave inconsistent state. Keep multi-step order mutations idempotent/re-runnable.
- **`findOrCreatePendingOrder` is check-then-insert**, so concurrent adds for the same vendor can produce two open orders. Harmless but user-visible; the parts can be merged back with `moveItemsToOrder`.
- **`better-sqlite3` is load-bearing now, and its native build fails on Windows** without Visual Studio C++ build tools. It used to be genuinely unused — on Workers, `@nuxt/content` stored its data in D1 — but the `node-server` preset stores it in SQLite instead, and the built output references the driver throughout. Removing the dependency breaks `/docs` in production. On Windows, if `bun install` fails on its build step, run `bun install --ignore-scripts` then `bun run postinstall` (`nuxt prepare`); the droplet is Linux and builds it without complaint.
- **The app runs under Node, not Bun** (`interpreter: 'node'` in `ecosystem.config.cjs`). Bun builds it, but `@nuxt/content` opens its SQLite through `better-sqlite3`, a Node native addon Bun cannot `dlopen`. Under Bun every content query throws and `/docs` returns 404 while the rest of the site looks perfectly healthy — which is exactly how it shipped green past a smoke test that only checked `/`. It survived a Windows-built `.output` (which bundled a different connector) and broke the first time CI built on Linux.
- **`docker-compose.yml` pins `postgres:17`.** The unpinned `postgres` tag now resolves to PG18, which refuses to start with the volume mounted at the legacy `/var/lib/postgresql/data` path.
- **Nothing Cloudflare-specific is left at runtime**, so dev and production now differ only in configuration — which was the main reason to move off Workers. Any Hyperdrive/KV/D1/`VPC_SERVICE` reference you find is stale documentation or dead code, not something still wired up.
