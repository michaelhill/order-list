import type { ExtractedVariant } from './part-extractor'
import { hostMatches } from './part-extractor'

// Sailrite sells most fabric and line by the yard or foot in several colours
// and widths, and the price is not the same across them -- Spyderline is $1.30
// in red and $1.40 in black; Dyneema webbing runs $8.75 to $486 across length
// and width. The product page shows the base article with no price of its own,
// so an extraction that ignored the options produced a part with whichever
// price the page happened to render and no way to pick.
//
// The options are plain <select>s driven by htmx:
//
//   <select data-option-select data-variant-attribute-label="Colors"
//           name="option__custitem3" hx-get="/hxcommerce/product/details/103131">
//     <option value="-1">-- Select --</option>
//     <option value="2">Black</option>
//     <option value="16" disabled>Purple</option>
//
// and -- the useful part -- the full product page honours those same names as
// query parameters. Requesting ?option__custitem3=2 returns the page for that
// variant, with its own data-product-sku (103131-BK) and its own schema.org
// Offer. So each variant is one ordinary page fetch, and they can all go at
// once: eight combinations of the webbing come back in about a second, well
// inside the extract endpoint's budget.
//
// Nothing on the base page lists the variants' prices, so there is no cheaper
// route -- the variant SKUs do not appear in its markup at all.

const SAILRITE_HOSTS = ['sailrite.com']

// A product with several option dimensions is a cartesian product, and while
// the ones seen are small (5 colours, or 4 lengths x 2 widths) the count
// multiplies. Cap it rather than let an unusually configurable product fire
// off a hundred requests; past the cap the part still extracts, just without
// a variant list.
const MAX_VARIANTS = 24

interface OptionDimension {
  name: string
  values: Array<{ value: string, title: string }>
}

export function isSailriteHost(hostname: string): boolean {
  return SAILRITE_HOSTS.some(domain => hostMatches(hostname, domain))
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim()
}

/**
 * The variant dimensions a Sailrite product page offers.
 *
 * Regex rather than a DOM parse because the caller already holds the HTML and
 * this shape is unambiguous; `disabled` options are dropped, being the ones
 * struck through on the page as out of stock, and value "-1" is the
 * "-- Select --" placeholder.
 */
export function parseOptionDimensions(html: string): OptionDimension[] {
  const dimensions: OptionDimension[] = []
  for (const match of html.matchAll(
    /<select([^>]*data-option-select[^>]*)>([\s\S]*?)<\/select>/g
  )) {
    const name = /name="([^"]+)"/.exec(match[1]!)?.[1]
    if (!name) continue

    const values: Array<{ value: string, title: string }> = []
    for (const option of match[2]!.matchAll(
      /<option value="([^"]*)"([^>]*)>([^<]*)/g
    )) {
      const value = option[1]!
      if (!value || value === '-1') continue
      if (/\bdisabled\b/.test(option[2]!)) continue
      const title = decodeEntities(option[3] ?? '')
      if (!title) continue
      values.push({ value, title })
    }
    if (values.length > 0) dimensions.push({ name, values })
  }
  return dimensions
}

function combinations(
  dimensions: OptionDimension[]
): Array<{ params: URLSearchParams, title: string }> {
  // No options is not one empty combination: the seed below would otherwise
  // survive the loop untouched and yield a single blank-titled variant for
  // every plain product (the Dacron sailcloths have no selects at all).
  if (dimensions.length === 0) return []

  let out: Array<{ params: string[][], titles: string[] }> = [
    { params: [], titles: [] }
  ]
  for (const dimension of dimensions) {
    const next: typeof out = []
    for (const partial of out) {
      for (const value of dimension.values) {
        next.push({
          params: [...partial.params, [dimension.name, value.value]],
          titles: [...partial.titles, value.title]
        })
      }
    }
    out = next
    if (out.length > MAX_VARIANTS) return []
  }
  return out.map(entry => ({
    params: new URLSearchParams(entry.params),
    // "5-Foot Piece / 2\"" reads better on an order line than the raw values.
    title: entry.titles.join(' / ')
  }))
}

function offerPrice(html: string): number | null {
  for (const match of html.matchAll(
    /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g
  )) {
    let parsed: unknown
    try {
      parsed = JSON.parse(match[1]!)
    } catch {
      continue
    }
    const node = parsed as { '@type'?: unknown, price?: unknown } | null
    if (node && node['@type'] === 'Offer') {
      const price = Number(node.price)
      return Number.isFinite(price) ? price : null
    }
  }
  return null
}

/**
 * One variant per option combination, each with the SKU and price its own
 * page reports. Returns an empty list when the product has no options, when
 * there are more combinations than MAX_VARIANTS, or when the fetches fail --
 * in every case the caller keeps the part it already extracted.
 */
export async function fetchSailriteVariants(
  urlObj: URL,
  html: string,
  userAgent: string,
  signal?: AbortSignal
): Promise<ExtractedVariant[]> {
  const combos = combinations(parseOptionDimensions(html))
  if (combos.length === 0) return []

  const results: Array<ExtractedVariant | null> = await Promise.all(
    combos.map(async (combo) => {
      const target = new URL(urlObj.toString())
      for (const [key, value] of combo.params) {
        target.searchParams.set(key, value)
      }
      try {
        const response = await fetch(target, {
          signal,
          headers: { 'user-agent': userAgent }
        })
        if (!response.ok) return null
        const body = await response.text()
        const sku = /data-product-sku="([^"]*)"/.exec(body)?.[1] ?? null
        const price = offerPrice(body)
        // A combination the store does not actually stock comes back as the
        // base article, with no price of its own. Nothing to offer there.
        if (price == null) return null
        return {
          id: sku ?? combo.title,
          sku,
          title: combo.title,
          price
        }
      } catch {
        return null
      }
    })
  )

  return results.filter((variant): variant is ExtractedVariant => !!variant)
}
