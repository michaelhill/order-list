import type { UnifiedProduct } from './bigcommerce'
import { productsFromUrls } from './product-urls'

// RoboPromo runs Volusion, an older hosted platform with none of the catalogue
// endpoints the other scrapers use -- no /products.json, no storefront GraphQL,
// and a sitemap.xml that lists only categories. Its category pages render their
// listings client-side, so fetching one server-side returns navigation and
// nothing else, which is why a first pass found zero products.
//
// What it does have is /pindex.asp, Volusion's built-in product index. That one
// is plain server-rendered HTML listing every product as /product_p/{code}.htm,
// and the product pages behind it are server-readable too.
//
// Those pages need no parser of their own. They carry og:title, og:image and a
// schema.org <span itemprop='price' content='139.00'>, all of which the app's
// own extractor already reads -- so this walks the index and hands each URL to
// extractPart rather than growing a second copy of that logic. The one thing
// the page markup does not surface is the SKU, and the URL carries it.

const USER_AGENT
  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'

const PRODUCT_HREF = /href="([^"]*\/product_p\/[^"]+\.htm)"/gi

/** Product codes are the URL segment, which Volusion shows uppercased. */
function skuFromUrl(url: string): string | null {
  const match = /\/product_p\/([^/]+)\.htm$/i.exec(new URL(url).pathname)
  return match ? match[1]!.toUpperCase() : null
}

/**
 * Every product in the store's own index. Volusion paginates category pages
 * but not /pindex.asp, so one fetch enumerates the catalogue.
 */
export async function fetchVolusionProducts(
  hostname: string
): Promise<UnifiedProduct[]> {
  const indexRes = await fetch(`https://${hostname}/pindex.asp`, {
    headers: { 'User-Agent': USER_AGENT }
  })
  if (!indexRes.ok) {
    throw new Error(`Failed to fetch Volusion index: ${indexRes.status}`)
  }
  const html = await indexRes.text()

  const urls = new Set<string>()
  for (const match of html.matchAll(PRODUCT_HREF)) {
    try {
      urls.add(new URL(match[1]!, `https://${hostname}/`).toString())
    } catch {
      // A malformed href costs its own product, not the run.
    }
  }
  if (urls.size === 0) {
    throw new Error(`No products found in ${hostname}/pindex.asp`)
  }

  // The page markup never carries the product code; the URL does.
  return productsFromUrls(urls, { skuFromUrl })
}
