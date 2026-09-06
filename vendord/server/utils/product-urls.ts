import type { UnifiedProduct } from './bigcommerce'
import { extractPart } from '../../../server/utils/part-extractor'

// Turning a list of product URLs into cache rows, shared by the two scrapers
// that work that way: Volusion, which enumerates the list from the store's own
// index, and `curated`, which is handed one.
//
// Neither needs a parser. The app's extractor already reads these pages --
// Shopify JSON, schema.org, OpenGraph, in that order -- so this is only the
// fetch loop and the mapping into the shape meilisearch:sync expects.

/** Fetch each URL through the extractor and keep the ones that yield a part. */
export async function productsFromUrls(
  urls: Iterable<string>,
  options: { skuFromUrl?: (url: string) => string | null } = {}
): Promise<UnifiedProduct[]> {
  const products: UnifiedProduct[] = []

  for (const url of urls) {
    try {
      const result = await extractPart(url)
      const product = result.product
      // A page that yields no title is a redirect or a retired product, not
      // something to index under an empty name.
      if (!product?.title) continue

      const unified: UnifiedProduct = {
        title: product.title,
        // sync builds the link as `https://{hostname}/{handle}` for anything
        // that isn't shopify, so the handle carries the whole path.
        handle: new URL(url).pathname.replace(/^\//, ''),
        description: product.description ?? 'no description'
      }
      if (product.price != null) unified.price = product.price
      if (product.image) unified.image = product.image

      // The page's own SKU when it publishes one, else whatever the caller can
      // read off the URL -- Volusion puts the product code there and exposes
      // it nowhere in the markup.
      const sku = product.sku ?? options.skuFromUrl?.(url) ?? null
      if (sku) {
        // sync reads `sku || id` off this field for the searchable SKU list.
        unified.variants = [
          { id: sku, title: 'Default', price: product.price ?? undefined }
        ]
      }

      products.push(unified)
    } catch {
      // One unreachable page should not cost the rest of the catalogue.
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }

  return products
}

/**
 * The product URLs a `curated` vendor lists in its `config` column. That
 * column is a NOT NULL text field the rest of the app never reads, which is
 * why it is the natural home for this.
 *
 * Shape: `{"urls": ["https://…", …]}`. Anything else is a configuration
 * mistake rather than a transient failure, so it throws rather than quietly
 * indexing nothing.
 */
export function curatedUrls(config: string, hostname: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(config)
  } catch {
    throw new Error(`Vendor config for ${hostname} is not valid JSON`)
  }
  const urls = (parsed as { urls?: unknown } | null)?.urls
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error(`Vendor config for ${hostname} lists no urls`)
  }

  const out: string[] = []
  for (const entry of urls) {
    if (typeof entry !== 'string') continue
    let url: URL
    try {
      url = new URL(entry)
    } catch {
      continue
    }
    // Confining these to the vendor's own host keeps a config edit from
    // pointing the scraper at an unrelated site, and keeps the link the sync
    // builds from `hostname` + handle pointing where the product actually is.
    if (url.hostname.toLowerCase() !== hostname.toLowerCase()) continue
    out.push(url.toString())
  }
  if (out.length === 0) {
    throw new Error(`Vendor config for ${hostname} lists no usable urls`)
  }
  return out
}
