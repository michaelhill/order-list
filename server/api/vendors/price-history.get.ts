import { defineEventHandler } from "h3";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { useDB } from "../../utils/db";
import { productCache, productPriceHistory } from "../../utils/schema";

// Not auth-gated, matching search.get.ts and facets.get.ts beside it: this is
// the same public product catalogue those already serve, one product at a time.

// The search index keys documents by base64 of the productCache id (see the
// Meilisearch sync), so that is what a search result can hand back. Accept the
// raw cache id too — it is the more natural thing to hold outside the index.
function decodeProductId(id: string): string | null {
  if (id.includes(":")) return id;
  try {
    const decoded = Buffer.from(id, "base64").toString("utf8");
    return decoded.includes(":") ? decoded : null;
  } catch {
    return null;
  }
}

export default defineEventHandler(async (event) => {
  const query = await getValidatedQuery(event, data =>
    z.object({ id: z.string().min(1).max(512) }).parse(data));

  const productId = decodeProductId(query.id);
  if (!productId) {
    throw createError({ statusCode: 400, statusMessage: "Invalid product id" });
  }

  const db = useDB();
  const [product] = await db
    .select({ id: productCache.id })
    .from(productCache)
    .where(eq(productCache.id, productId))
    .limit(1);
  if (!product) {
    throw createError({ statusCode: 404, statusMessage: "Unknown product" });
  }

  const rows = await db
    .select({
      priceMicros: productPriceHistory.priceMicros,
      currency: productPriceHistory.currency,
      recordedAt: productPriceHistory.recordedAt,
      lastSeenAt: productPriceHistory.lastSeenAt
    })
    .from(productPriceHistory)
    .where(eq(productPriceHistory.productId, productId))
    .orderBy(asc(productPriceHistory.recordedAt));

  // One point per price the product has held, oldest first. The chart draws
  // these as steps: each price holds flat from the day it appeared until the
  // day the next one did, then jumps. Interpolating between them would assert
  // prices that were never charged.
  const points = rows.map(row => ({
    priceMicros: row.priceMicros,
    price: row.priceMicros / 1_000_000,
    recordedAt: row.recordedAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString()
  }));

  const last = rows.at(-1);
  return {
    productId,
    currency: last?.currency ?? "USD",
    points,
    // When this product entered the tracker, and the most recent scrape that
    // confirmed its current price. Past lastCheckedAt the price is simply
    // unknown, and the chart stops there rather than running a flat line to
    // today.
    trackedSince: rows[0]?.recordedAt.toISOString() ?? null,
    lastCheckedAt: last?.lastSeenAt.toISOString() ?? null
  };
});
