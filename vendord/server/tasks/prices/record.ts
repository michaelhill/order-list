import { defineTask } from "nitropack/runtime";
import { inArray } from "drizzle-orm";
import { useDB } from "../../../../server/utils/db";
import {
  productCache,
  productPriceHistory,
} from "../../../../server/utils/schema";
import { parseCachedProduct, productPrice } from "../../utils/product-doc";

interface TaskResult {
  success: boolean;
  error?: string;
  // Products whose price we saw for the first time.
  tracked?: number;
  // Products whose price moved since the last scrape.
  changed?: number;
  // Products whose price was unchanged, so only lastSeenAt advanced.
  unchanged?: number;
  // Products with no readable price at all — nothing to record.
  skipped?: number;
}

// Postgres caps a statement at 65535 bound parameters. These rows carry six
// columns, so a thousand at a time leaves plenty of headroom and keeps the
// whole catalogue to a handful of round trips.
const INSERT_CHUNK = 1000;
const TOUCH_CHUNK = 2000;

export default defineTask({
  meta: {
    name: "prices:record",
    description: "Record a price point for every cached product that moved",
  },
  async run(): Promise<{ result: TaskResult }> {
    const db = useDB();

    const cached = await db
      .select({ id: productCache.id, productJson: productCache.productJson })
      .from(productCache);
    if (cached.length === 0) {
      return { result: { success: true, tracked: 0, changed: 0, unchanged: 0 } };
    }

    // The whole history in one query rather than a lookup per product: it is
    // one row per price *change*, so even a year of daily scrapes over the
    // catalogue is a few thousand rows. Ordered ascending so the last write to
    // the map for a product is its newest row.
    const history = await db
      .select({
        id: productPriceHistory.id,
        productId: productPriceHistory.productId,
        priceMicros: productPriceHistory.priceMicros,
      })
      .from(productPriceHistory)
      .orderBy(productPriceHistory.productId, productPriceHistory.recordedAt);

    const latest = new Map<string, { id: string; priceMicros: number }>();
    for (const row of history) {
      latest.set(row.productId, { id: row.id, priceMicros: row.priceMicros });
    }

    // One timestamp for the whole run, so every product recorded tonight shares
    // an x position on the chart instead of smearing across the minutes the
    // scrape took.
    const now = new Date();
    const inserts: Array<typeof productPriceHistory.$inferInsert> = [];
    const touch: string[] = [];
    let tracked = 0;
    let changed = 0;
    let skipped = 0;

    for (const row of cached) {
      const product = parseCachedProduct(row.productJson, row.id);
      const price = product ? productPrice(product) : undefined;
      if (price === undefined) {
        skipped += 1;
        continue;
      }
      // Round at the micro-dollar, not the cent: a vendor quoting $1.2345
      // should not read as a change every night from floating point noise.
      const priceMicros = Math.round(price * 1_000_000);
      const previous = latest.get(row.id);

      if (!previous) {
        tracked += 1;
      } else if (previous.priceMicros === priceMicros) {
        touch.push(previous.id);
        continue;
      } else {
        changed += 1;
      }

      inserts.push({
        id: crypto.randomUUID(),
        productId: row.id,
        priceMicros,
        currency:
          typeof product?.currency === "string" && product.currency
            ? product.currency
            : "USD",
        recordedAt: now,
        lastSeenAt: now,
      });
    }

    for (let i = 0; i < inserts.length; i += INSERT_CHUNK) {
      await db
        .insert(productPriceHistory)
        .values(inserts.slice(i, i + INSERT_CHUNK));
    }

    // Advancing lastSeenAt is what separates "unchanged" from "unobserved".
    // Without it a chart cannot tell a price that has genuinely held for two
    // months from one nobody has checked since.
    for (let i = 0; i < touch.length; i += TOUCH_CHUNK) {
      await db
        .update(productPriceHistory)
        .set({ lastSeenAt: now })
        .where(
          inArray(productPriceHistory.id, touch.slice(i, i + TOUCH_CHUNK)),
        );
    }

    console.log(
      `Recorded prices: ${tracked} newly tracked, ${changed} changed, `
      + `${touch.length} unchanged, ${skipped} without a price`,
    );

    return {
      result: {
        success: true,
        tracked,
        changed,
        unchanged: touch.length,
        skipped,
      },
    };
  },
});
