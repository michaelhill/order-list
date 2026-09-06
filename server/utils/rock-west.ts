// Rock West Composites' storefront, which is Salesforce B2C Commerce (SFRA).
//
// Adds go to `Cart-AddProduct` and, like Playing With Fusion, one part at a
// time through a POST. Everything below was checked against the live store:
//
//   - A GET answers 500. SFRA registers the route as POST-only, so there is no
//     link that can add to a cart — the row has to submit a form.
//   - The POST needs no CSRF token, and no prior session: the first one opens
//     a basket.
//   - Several parts in one request is not on offer. Repeating `pid` adds only
//     the first, and a comma-separated `pid` answers 500.
//   - Adds accumulate against the session cookie, so following the rows in one
//     tab builds the cart up, and `/cart` then shows the lot.
//
// The site id is part of the path and is this vendor's own, so it is written
// out rather than derived — there is nothing to derive it from.
const ROCK_WEST_SITE_PATH = '/on/demandware.store/Sites-RWC-Site/default'

export const ROCK_WEST_HOSTS = ['rockwestcomposites.com']

export function rockWestAddUrl(host: string): string {
  return `https://${host}${ROCK_WEST_SITE_PATH}/Cart-AddProduct`
}

export function rockWestAddFields(
  sku: string,
  quantity: number
): Record<string, string> {
  return {
    pid: sku,
    quantity: String(Math.max(1, Math.trunc(quantity)))
  }
}

export function rockWestCartUrl(host: string): string {
  return `https://${host}/cart`
}

// The `pid` is the product's SKU, and it is deliberately not taken from the URL
// even though it usually looks like it could. Most of their product pages sit
// at /{sku}.html, but a product with variants sits at the *master's* path while
// the orderable SKU is a variant's: /35051-s.html carries sku 35051-s-12.
//
// Posting the master id does work -- it prices correctly, resolving to the
// default variant -- which is precisely why it is the wrong thing to send. It
// succeeds while quietly choosing a variant for the buyer, so an order for a
// 24-inch tube would be filled with whichever length that product defaults to,
// and nothing in the response would say so. The SKU read off the part's own
// page names the variant the buyer actually picked, so that is what gets sent,
// and a part whose SKU cannot be established is excluded rather than guessed at
// -- the same rule pickVariantId applies to Shopify.
export function rockWestSku(value: string | null | undefined): string | null {
  const sku = value?.trim();
  if (!sku) return null;
  // Their SKUs are digits with optional -suffixes (46408-im, 35051-s-12).
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sku) ? sku : null;
}
