import { defineEventHandler } from "h3";
import { and, desc, eq, gte, isNotNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { useDB } from "../../utils/db";
import { productCache, productPriceHistory, vendors } from "../../utils/schema";

// Every price move the tracker has recorded, newest first.
//
// Not auth-gated, matching search.get.ts, facets.get.ts and price-history.get.ts
// beside it: this is the same public product catalogue those already serve,
// read a different way.

// A change is a history row with an earlier row behind it. The *first* row for
// a product is not a change -- it is the price the tracker opened at -- so it
// is excluded, or every product would appear on this page the day it entered
// the catalogue with a fabricated "change" from nothing.
//
// The window function deliberately runs over the whole table rather than over
// the date range: the row a change is measured against is the one before it,
// which by the nature of change-only storage is usually *outside* the window.
// Filtering first and lagging second would compare each change to the previous
// change in the window and silently misreport the first one in every range.

// Enough rows to cover any window a person will ask for -- the catalogue is
// ~5,250 products and only moves a few prices a night -- while bounding what
// one request can pull into memory. If this is ever hit the page is showing a
// truncated range, so it is reported rather than passed over in silence.
const ROW_CAP = 20_000;

const DAY_MS = 24 * 60 * 60 * 1000;

const querySchema = z.object({
  // Plain YYYY-MM-DD, as the orders table's date filters use.
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // Vendor *names*, matching the vocabulary the search page already puts in
  // its URL. The sixteen curated vendors have distinct names, so this reads
  // better than an opaque id and resolves just as precisely.
  vendors: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform(value =>
      value === undefined ? [] : Array.isArray(value) ? value : [value]),
  q: z.string().max(200).optional(),
  // Newest first by default. The other three exist because a page whose whole
  // purpose is spotting notable moves needs a way to ask for the big ones, and
  // sorting client-side would only reorder the current page -- which reads as
  // a broken sort rather than a paginated one.
  sort: z
    .enum(["recent", "drop", "rise", "movement"])
    .default("recent"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

// Local midnight, to agree with how the orders table reads its own date
// inputs and with the local-offset timestamps vendord writes.
function startOfDay(value: string): Date {
  return new Date(`${value}T00:00:00`);
}

interface CachedProduct {
  title?: unknown
  handle?: unknown
  image?: unknown
  images?: Array<{ src?: unknown }>
}

// The productCache row shape, unwrapped the same way the search sync and the
// price recorder unwrap it -- six scrapers nest the product differently.
function parseCachedProduct(productJson: string): CachedProduct | null {
  let data: unknown;
  try {
    data = JSON.parse(productJson);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const envelope = data as Record<string, unknown>;
  const inner = envelope.productData as Record<string, unknown> | undefined;
  return ((inner?.product as CachedProduct) ?? inner ?? envelope) as CachedProduct;
}

// Mirrors the URL the Meilisearch sync builds, so a row here and the same
// product on the search page link to the same place.
function productUrl(
  hostname: string,
  vendorType: string,
  handle: unknown
): string | null {
  if (typeof handle !== "string" || !handle) return null;
  return vendorType === "shopify"
    ? `https://${hostname}/products/${handle}`
    : `https://${hostname}/${handle}`;
}

export default defineEventHandler(async (event) => {
  const query = await getValidatedQuery(event, data => querySchema.parse(data));

  const to = query.to
    ? new Date(startOfDay(query.to).getTime() + DAY_MS) // inclusive of that day
    : new Date();
  const from = query.from
    ? startOfDay(query.from)
    : new Date(to.getTime() - 30 * DAY_MS);

  if (from >= to) {
    throw createError({
      statusCode: 400,
      statusMessage: "The start date must fall before the end date"
    });
  }

  const db = useDB();

  const ordered = db
    .select({
      productId: productPriceHistory.productId,
      priceMicros: productPriceHistory.priceMicros,
      currency: productPriceHistory.currency,
      recordedAt: productPriceHistory.recordedAt,
      previousMicros: sql<string | null>`lag(${productPriceHistory.priceMicros}) over (
        partition by ${productPriceHistory.productId}
        order by ${productPriceHistory.recordedAt}, ${productPriceHistory.id}
      )`.as("previous_micros")
    })
    .from(productPriceHistory)
    .as("ordered");

  const rows = await db
    .select({
      productId: ordered.productId,
      priceMicros: ordered.priceMicros,
      previousMicros: ordered.previousMicros,
      currency: ordered.currency,
      recordedAt: ordered.recordedAt,
      productJson: productCache.productJson,
      vendorName: vendors.name,
      vendorHostname: vendors.hostname,
      vendorType: vendors.type
    })
    .from(ordered)
    .innerJoin(productCache, eq(productCache.id, ordered.productId))
    .innerJoin(vendors, eq(vendors.id, productCache.vendorId))
    .where(
      and(
        isNotNull(ordered.previousMicros),
        // The recorder only writes on a change, so this is insurance rather
        // than a filter that should ever fire.
        ne(ordered.priceMicros, sql`${ordered.previousMicros}`),
        gte(ordered.recordedAt, from),
        lt(ordered.recordedAt, to)
      )
    )
    .orderBy(desc(ordered.recordedAt))
    .limit(ROW_CAP);

  const needle = query.q?.trim().toLowerCase() ?? "";

  const matched = rows.flatMap((row) => {
    const product = parseCachedProduct(row.productJson);
    const title
      = typeof product?.title === "string" && product.title
        ? product.title
        : "Unknown product";

    // Title and vendor, which is what the box in front of the user says it
    // searches. The description is deliberately not included: it is a whole
    // product blurb and matching it makes the filter feel arbitrary.
    if (
      needle
      && !title.toLowerCase().includes(needle)
      && !row.vendorName.toLowerCase().includes(needle)
    ) {
      return [];
    }

    // The lag() column has no drizzle type mapper behind it, so pg hands the
    // bigint back as a string where the mapped column beside it is a number.
    const previous = Number(row.previousMicros);
    const current = row.priceMicros;
    if (!Number.isFinite(previous)) return [];

    const image
      = typeof product?.image === "string"
        ? product.image
        : typeof product?.images?.[0]?.src === "string"
          ? product.images[0].src
          : null;

    return [{
      // The id the search index uses, so a row can open the same price-history
      // modal the search page opens.
      id: Buffer.from(row.productId).toString("base64").replace(/=/g, ""),
      title,
      vendorName: row.vendorName,
      url: productUrl(row.vendorHostname, row.vendorType, product?.handle),
      image,
      currency: row.currency,
      previousPrice: previous / 1_000_000,
      newPrice: current / 1_000_000,
      absolute: (current - previous) / 1_000_000,
      // Guarded because a product that was genuinely free has no percentage.
      percent: previous === 0 ? null : ((current - previous) / previous) * 100,
      changedAt: row.recordedAt.toISOString()
    }];
  });

  // Counts for the vendor filter, taken from the date- and text-filtered set
  // *before* the vendor filter is applied -- so choosing one vendor does not
  // collapse the menu to that single option.
  const vendorCounts = new Map<string, number>();
  for (const change of matched) {
    vendorCounts.set(
      change.vendorName,
      (vendorCounts.get(change.vendorName) ?? 0) + 1
    );
  }

  const selected = new Set(query.vendors);
  const filtered = selected.size
    ? matched.filter(change => selected.has(change.vendorName))
    : matched;

  // Sorted over the whole filtered set, before the page is cut out of it.
  const sorted = [...filtered];
  if (query.sort === "drop") {
    sorted.sort((a, b) => (a.percent ?? 0) - (b.percent ?? 0));
  } else if (query.sort === "rise") {
    sorted.sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0));
  } else if (query.sort === "movement") {
    sorted.sort(
      (a, b) => Math.abs(b.percent ?? 0) - Math.abs(a.percent ?? 0));
  }

  const start = (query.page - 1) * query.limit;

  return {
    changes: sorted.slice(start, start + query.limit),
    total: filtered.length,
    // Counted across the whole filtered range, not the page, so the summary
    // line describes the answer rather than the slice of it on screen.
    increases: filtered.filter(change => change.absolute > 0).length,
    decreases: filtered.filter(change => change.absolute < 0).length,
    page: query.page,
    limit: query.limit,
    from: from.toISOString(),
    to: to.toISOString(),
    vendors: [...vendorCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    // True when the range held more rows than one request will carry, so the
    // page can say so rather than quietly showing a partial answer.
    truncated: rows.length === ROW_CAP
  };
});
