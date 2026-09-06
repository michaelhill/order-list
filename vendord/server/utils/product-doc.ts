// Fields read out of a productCache row, shared by the two things that consume
// one: the Meilisearch sync and the price recorder. They have to agree on what
// "the price" of a product is, or the figure on a search card and the figure
// its history chart plots would come from different places and drift apart.

// Shopify sends the description as a body_html blob, and it is both indexed and
// rendered by the search page — so tags and entities would otherwise show up in
// results and dilute relevance. No dependency for this: vendord has no HTML
// library and one blob per product does not justify adding one.
export function htmlToText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const text = value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

// Shopify quotes prices as strings ("19.99"). Meilisearch declares price
// sortable and search.get.ts offers price-asc/price-desc, but sorting strings
// is lexicographic — "119.99" lands between "11.00" and "12.00" — so the sort
// silently returned nonsense. Store a number.
export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Six scrapers write this table and they nest the product differently: the
// Shopify branch stores the raw /products.json object, the rest store a
// UnifiedProduct, and older rows arrived wrapped in a productData envelope.
export function parseCachedProduct(
  productJson: string,
  cacheId: string,
): Record<string, unknown> | null {
  let data: unknown;
  try {
    data = JSON.parse(productJson);
  } catch (error) {
    console.error(
      `Failed to parse product JSON for cached product ${cacheId}:`,
      error,
    );
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const envelope = data as Record<string, unknown>;
  const inner = envelope.productData as Record<string, unknown> | undefined;
  return (inner?.product as Record<string, unknown>) ?? inner ?? envelope;
}

// The headline price: the product's own where it has one, else the first
// variant's. Deliberately not min(variants) — Swyft's bumper kit lists at
// $999.99 with a $19.99 screws-only variant under it, and $999.99 is what the
// page shows.
export function productPrice(
  product: Record<string, unknown>,
): number | undefined {
  const variants = product.variants as Array<Record<string, unknown>> | undefined;
  return toNumber(product.price ?? variants?.[0]?.price);
}
