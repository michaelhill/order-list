// Seattle Fabrics' storefront, which is Shift4Shop (3dcart).
//
// This module is the single source of truth for their option data, because two
// things consume it and they must not drift: the extractor builds the variant
// picker from it, and the cart handoff builds the POST that adds a part. If the
// picker offered a colour the add could not name, the buyer would choose one
// thing and receive another.

export const SEATTLE_FABRICS_HOSTS = ['seattlefabrics.com']

// Their add endpoint answers a POST and only a POST. Checked against the live
// store, so it needn't be re-derived:
//
//   - A GET without `quick=1` is refused outright: /?error=missing_item_id.
//   - `GET add_cart.asp?quick=1&item_id=N` *does* add, and honours `qty-0`,
//     but ignores options entirely -- a product with a required option bounces
//     back to its own page having added nothing. Most of this catalogue has
//     options, and they are the half that matters (the colour, the width), so
//     the quick link is not usable here despite being the obvious route.
//   - The POST must be multipart/form-data. Sent as
//     application/x-www-form-urlencoded the request is accepted and the cart
//     stays empty, which is the worst kind of failure: it looks like it worked.
//   - Several parts in one request is not on offer. A repeated `item_id`, and
//     an indexed `item_id-0`/`item_id-1`, both leave the cart *empty* rather
//     than adding the first -- so there is no partial success to salvage.
//   - Adds accumulate against the session cookie, so following the rows in one
//     tab builds the cart up and /view_cart.asp then shows the lot.
export const SEATTLE_FABRICS_ENCTYPE = 'multipart/form-data'

export function seattleFabricsAddUrl(host: string): string {
  return `https://${host}/add_cart.asp`
}

export function seattleFabricsCartUrl(host: string): string {
  return `https://${host}/view_cart.asp`
}

// /{slug}_p_{id}.html is a product, /{slug}_c_{id}.html a category. The id is
// authoritative and the slug decoration: /utter-nonsense-slug_p_52.html still
// serves the CORDURA, and a stale slug redirects to the current one.
const PRODUCT_ID = /_p_(\d+)\.html$/i

export function seattleFabricsItemId(url: string): string | null {
  try {
    return PRODUCT_ID.exec(new URL(url).pathname)?.[1] ?? null
  } catch {
    return null
  }
}

export function isSeattleFabricsUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return SEATTLE_FABRICS_HOSTS.some(
      domain => host === domain || host.endsWith(`.${domain}`)
    )
  } catch {
    return false
  }
}

export interface SeattleFabricsOption {
  // What the <select> is called. Not constructible: the CORDURA's is
  // `option-di_62-52` and the tape's `option-1872-595`, and posting the wrong
  // name adds nothing while reporting success.
  field: string
  optionId: string
  label: string
  sku: string
  // Adjustments to the base price, not prices. See priceFor below.
  priceAdjustment: number
  pricePercent: number
}

// Attributes come in any order -- these selects carry `name` before `class` --
// so tags are matched generically and attributes read by name.
function attr(tag: string, name: string): string | null {
  const match = new RegExp(`${name}=["']([^"']*)["']`, 'i').exec(tag)
  return match ? match[1]! : null
}

function decode(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

// Shift4Shop emits one parallel array per product id:
//
//   inventoryarray52[2] = '627#-9629';  idarray52[2] = 'FC5-RED';
//
// The index ties them together and `inventoryarray` leads with the option id,
// which is what the <option value> carries -- so this is how an option becomes
// a part number. The id suffix is the product's own, taken from the URL rather
// than matched loosely, or a related product on the same page would mix its
// arrays in.
//
// `aopricearray` sits right beside these and is *not* the price: it is '0' for
// every option of every product in this catalogue, including ones that
// demonstrably cost more.
function skusByOptionId(html: string, productId: string): Map<string, string> {
  const read = (name: string) => {
    const out = new Map<string, string>()
    const pattern = new RegExp(
      `${name}${productId}\\[(\\d+)\\]\\s*=\\s*'([^']*)'`,
      'g'
    )
    for (const match of html.matchAll(pattern)) out.set(match[1]!, match[2]!)
    return out
  }
  const inventory = read('inventoryarray')
  const skus = read('idarray')

  const byOption = new Map<string, string>()
  for (const [index, value] of inventory) {
    const optionId = value.split('#')[0]?.trim()
    const sku = skus.get(index)?.trim()
    if (optionId && sku) byOption.set(optionId, sku)
  }
  return byOption
}

// What an option does to the price, from the hidden inputs the store's own
// validateValues() reads:
//
//   <input type="hidden" name="price_7018"  value="3.00">   absolute
//   <input type="hidden" name="pricep_7018" value="0">      percent
//
// These are adjustments, which is why searching the markup for the price a
// buyer sees finds nothing: the $11.95 option is stored as 3.00 against an
// $8.95 base.
function adjustments(html: string): Map<string, { abs: number, pct: number }> {
  const out = new Map<string, { abs: number, pct: number }>()
  for (const match of html.matchAll(/<input\b([^>]*)>/g)) {
    const name = attr(match[1]!, 'name')
    const found = name ? /^(pricep?)_(\d+)$/.exec(name) : null
    if (!found) continue
    const value = Number(attr(match[1]!, 'value') ?? '0')
    const entry = out.get(found[2]!) ?? { abs: 0, pct: 0 }
    if (found[1] === 'price') entry.abs = Number.isFinite(value) ? value : 0
    else entry.pct = Number.isFinite(value) ? value : 0
    out.set(found[2]!, entry)
  }
  return out
}

/**
 * Every option the store is actually offering for this product.
 *
 * Read from the <select>s, never from the arrays: the CORDURA's arrays carry
 * 26 options while the store offers 9, the rest being colours withdrawn from
 * sale, so listing them would offer a buyer parts that cannot be bought. An
 * option with no array entry is dropped for the mirror-image reason -- it has
 * no part number, which is what both a placeholder (<option value="">Width)
 * and a degenerate single-choice group ("Black/Black" beside the real picker
 * on the neoprene) look like.
 */
export function seattleFabricsOptions(
  html: string,
  productId: string
): SeattleFabricsOption[] {
  const skus = skusByOptionId(html, productId)
  const priceBy = adjustments(html)
  const options: SeattleFabricsOption[] = []
  const seen = new Set<string>()

  for (const select of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const field = attr(select[1]!, 'name')
    if (!field || !/^option-/.test(field)) continue
    for (const option of select[2]!.matchAll(
      /<option\b([^>]*)>([\s\S]*?)<\/option>/g
    )) {
      const optionId = attr(option[1]!, 'value')?.trim()
      const sku = optionId ? skus.get(optionId) : undefined
      if (!optionId || !sku || seen.has(sku)) continue
      seen.add(sku)
      const price = priceBy.get(optionId) ?? { abs: 0, pct: 0 }
      options.push({
        field,
        optionId,
        label: decode(option[2]!) || sku,
        sku,
        priceAdjustment: price.abs,
        pricePercent: price.pct
      })
    }
  }
  return options
}

// Applied in the order the store applies them -- percentage against the base,
// then the absolute -- so the arithmetic matches the page.
export function seattleFabricsPrice(
  base: number | null,
  option: SeattleFabricsOption
): number | null {
  if (base == null) return null
  const adjusted
    = base + (base * option.pricePercent) / 100 + option.priceAdjustment
  return Math.round(adjusted * 1e6) / 1e6
}

/**
 * The fields the add form posts. `qty-0` is the quantity: the index is the
 * store's own, and a single-product add always uses row zero.
 */
export function seattleFabricsAddFields(
  itemId: string,
  quantity: number,
  option?: Pick<SeattleFabricsOption, 'field' | 'optionId'> | null
): Record<string, string> {
  const fields: Record<string, string> = {
    item_id: itemId,
    'qty-0': String(Math.max(1, Math.trunc(quantity)))
  }
  if (option) fields[option.field] = option.optionId
  return fields
}
