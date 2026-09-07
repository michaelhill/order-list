import { parseHTML } from 'linkedom'
import parse, { splitCookiesString } from './set-cookie-parser'
import type { DpoOptionGroup } from './wcp-dpo'
import { fetchSailriteVariants, isSailriteHost } from './sailrite'
import { ROCK_WEST_HOSTS } from './rock-west'
import {
  SEATTLE_FABRICS_HOSTS,
  seattleFabricsOptions,
  seattleFabricsPrice
} from './seattle-fabrics'

// Self-contained product extractor: given a product URL, reach out to the site
// and pull structured details. Tries, in order:
//   1. Shopify  — /products/{handle}.json (most FRC vendors run Shopify)
//   2. JSON-LD  — schema.org/Product in <script type="application/ld+json">
//   2.5 Amazon  — its meta tags describe the storefront, so read the DOM
//   3. OpenGraph/meta — og:*, product:price:*, itemprop fallbacks
// No external scraper service or database required.

export interface ExtractedVariant {
  id: string
  sku: string | null
  title: string
  price: number | null
}

// A quantity discount tier: buy `quantity` or more, pay `unitPrice` each.
export interface PriceBreak {
  quantity: number
  unitPrice: number
}

export interface ExtractedProduct {
  title: string
  description: string | null
  price: number | null
  currency: string | null
  sku: string | null
  // The product's main image, absolute. Every page shape below carries one and
  // it was being read and thrown away; the search index renders it, so a
  // vendor whose scraper goes through this extractor (Volusion) had products
  // with no picture at all.
  image?: string | null
  // The platform's *product* id, distinct from the variant id below. Only the
  // Shopify path sets it, and only because WCP's configurator lookup is keyed
  // by product rather than variant.
  productId?: string | null
  // The platform id of the variant these details describe. `variants` is left
  // empty when there's no real choice to make, so this is the only way to
  // recover the id of a single-variant product (a cart link needs it).
  variantId: string | null
  variantTitle: string | null
  variants: ExtractedVariant[]
  // Quantity discount tiers, when the vendor publishes them (DigiKey does).
  // Ascending by quantity; the applicable tier is the last one the ordered
  // quantity reaches.
  priceBreaks?: PriceBreak[]
}

export interface ExtractionResult {
  url: string
  hostname: string
  vendorName: string
  source:
    | 'shopify'
    | 'amazon'
    | 'digikey'
    | 'json-ld'
    // Read out of the page's DOM by a vendor-specific reader, where the page
    // publishes no structured data at all.
    | 'html'
    | 'opengraph'
    | 'scraper'
    | 'url'
    | 'none'
  product: ExtractedProduct | null
  // Set when the page is a configurator rather than a single orderable part:
  // the real parts it offers, each a standalone product in its own right.
  // See server/utils/wcp-dpo.ts.
  optionGroups?: DpoOptionGroup[]
}

// Common FRC vendors -> canonical display name. Matched by hostname suffix so
// www./store. subdomains resolve too.
const FRC_VENDORS: Array<{ match: string, name: string }> = [
  { match: 'revrobotics.com', name: 'REV Robotics' },
  { match: 'wcproducts.com', name: 'WestCoast Products' },
  { match: 'gobilda.com', name: 'goBILDA' },
  { match: 'servocity.com', name: 'ServoCity' },
  { match: 'thethriftybot.com', name: 'The Thrifty Bot' },
  { match: 'swyftrobotics.com', name: 'Swyft Robotics' },
  { match: 'lastanvil.com', name: 'Last Anvil Innovations' },
  { match: 'swervedrivespecialties.com', name: 'Swerve Drive Specialties' },
  { match: 'armabot.com', name: 'Armabot' },
  { match: 'reduxrobotics.com', name: 'Redux Robotics' },
  { match: 'limelightvision.io', name: 'Limelight Vision' },
  { match: 'copperforge.cc', name: 'Copperforge' },
  { match: 'lumynlabs.com', name: 'Lumyn Labs' },
  // The apex domain, TLD and all -- not a subdomain of a luma.com.
  { match: 'luma.vision', name: 'Luma Vision' },
  // Without this the OpenGraph fallback names the vendor from og:site_name,
  // which RoboPromo sets to the bare host -- parts came through as
  // "www.robopromo.com". Their own itemprop legalName is "RoboPromo LLC".
  { match: 'robopromo.com', name: 'RoboPromo' },
  { match: 'andymark.com', name: 'AndyMark' },
  // Their og:site_name is the regional storefront, "Bambu Lab US Store"; the
  // brand is what belongs on a line item. Matched on the apex so the other
  // regional stores (eu., uk.) resolve the same way.
  { match: 'bambulab.com', name: 'Bambu Lab' },
  // Nothing on their pages names the store -- no og:site_name, no brand in the
  // JSON-LD -- so the host fallback produced the runic "Rockwestcomposites".
  { match: 'rockwestcomposites.com', name: 'Rock West Composites' },
  // Their own styling, apostrophe included; the host fallback gives "Lowes".
  { match: 'lowes.com', name: "Lowe's" },
  // Without this the JSON-LD path names the vendor from the product's `brand`,
  // which is the manufacturer rather than the store -- a roof bracket came
  // through as "Qual-Craft".
  { match: 'acehardware.com', name: 'Ace Hardware' },
  // Two words, and the host fallback gives "Boltdepot".
  { match: 'boltdepot.com', name: 'Bolt Depot' },
  // Their own styling is one word. Without this the JSON-LD path names the
  // vendor from the product's `brand`, which is the line it belongs to --
  // a mounting bracket arrived from "C-more Micro".
  { match: 'automationdirect.com', name: 'AutomationDirect' },
  // Two words; the host fallback gives "Seattlefabrics". Their og:site_name
  // happens to be right, but the microdata branch does not consult it.
  { match: 'seattlefabrics.com', name: 'Seattle Fabrics' },
  // Two words, like Bolt Depot; the host fallback gives "Microcenter".
  { match: 'microcenter.com', name: 'Micro Center' },
  // Two words; the host fallback gives "Harborfreight".
  { match: 'harborfreight.com', name: 'Harbor Freight' },
  // Their own styling carries the article; the host fallback gives "Homedepot".
  { match: 'homedepot.com', name: 'The Home Depot' },
  { match: 'vexrobotics.com', name: 'VEX Robotics' },
  { match: 'vexpro.com', name: 'VEXpro' },
  { match: 'ctr-electronics.com', name: 'Cross the Road Electronics' },
  { match: 'onlinemetals.com', name: 'Online Metals' },
  { match: 'mcmaster.com', name: 'McMaster-Carr' },
  { match: 'studica.com', name: 'Studica' },
  { match: 'digikey.com', name: 'DigiKey' },
  { match: 'digikey.ca', name: 'DigiKey' }
]

// Match a hostname against a bare domain, tolerating www./store. subdomains.
export function hostMatches(hostname: string, domain: string): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, '')
  return h === domain || h.endsWith(`.${domain}`)
}

// Shopify's `product.vendor` holds the brand/manufacturer, not the store you
// order from, and is often left as the "My Store" default. Ignore that value.
const DEFAULT_SHOPIFY_VENDORS = new Set(['my store'])

const USER_AGENT
  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'

function friendlyVendorName(hostname: string): string | null {
  for (const v of FRC_VENDORS) {
    if (hostMatches(hostname, v.match)) return v.name
  }
  return null
}

// The name to show for a host: the curated one when we have it, else a
// readable form of the domain.
export function vendorDisplayName(hostname: string): string {
  return friendlyVendorName(hostname) ?? titleCaseHost(hostname)
}

function titleCaseHost(hostname: string): string {
  const base
    = hostname.replace(/^www\./, '').split('.').slice(0, -1).join('.')
    || hostname
  return base
    .split(/[.-]/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

// Parse a price that may arrive as a number or a messy string ("$1,234.56").
function parsePrice(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const normalized = String(value).replace(/[^0-9.,]/g, '')
  if (!normalized) return null
  const hasDot = normalized.includes('.')
  const hasComma = normalized.includes(',')
  // "1234,56" (EU) -> "1234.56"; otherwise treat commas as thousands separators.
  const numeric
    = hasComma && !hasDot
      ? Number(normalized.replace(/,/g, '.'))
      : Number(normalized.replace(/,/g, ''))
  return Number.isFinite(numeric) ? numeric : null
}

// Strip HTML/entities/whitespace and cap length so descriptions fit the Notes field.
function cleanText(input: unknown, max = 600): string | null {
  if (typeof input !== 'string') return null
  let text = input
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    // Stripping inline tags can leave a space before punctuation ("word .").
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim()
  if (!text) return null
  if (text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`
  return text
}

// JSON-LD sits inside a <script>, so it needs no HTML escaping -- but vendors
// escape it anyway. Ace Hardware's product names arrive holding "&amp;", which
// reaches an order as the literal "GE Tub &amp; Tile Caulk". cleanText already
// decodes entities and collapses whitespace; a name only needs a shorter cap
// than a description's.
// A "name" that is only the SKU is an identifier, not a name. AutomationDirect
// puts the bare part number in both fields on every product they sell, so a
// line item read "EA3-BRK" while the page was headed "Panel Mounting Brackets:
// replacement, 8/pk, for C-more Micro EA3 series touch panels". That real name
// lives in <title>, trailed by the part number in parentheses and the site
// name, so take it apart rather than settle for the identifier.
function titleBesideSku(
  pageTitle: string | null,
  sku: string
): string | null {
  if (!pageTitle) return null
  let title = pageTitle
  // Site branding after the last pipe: "... | AutomationDirect".
  const brand = title.lastIndexOf(' | ')
  if (brand > 0) title = title.slice(0, brand)
  // A trailing parenthetical naming the part number: "(PN# EA3-BRK)".
  title = title.replace(/\s*\([^)]*\)\s*$/, (match) =>
    match.toLowerCase().includes(sku.toLowerCase()) ? '' : match)
  title = cleanName(title) ?? ''
  // Only worth swapping in if it says more than the identifier did.
  return title && title.toLowerCase() !== sku.toLowerCase() ? title : null
}

function cleanName(value: unknown): string | null {
  const text = cleanText(value, 300)
  // Online Metals interpolate a missing field straight into their product
  // name, and it lands on the line item: 'Legs: 1.5" x 1.5"null, Thickness:
  // 0.125"' and 'Wire Type: Unserved Litz Wirenull, Wire Size: 26 AWGnull'.
  // A first pass anchored this to a closing inch mark, which only covered the
  // first of those -- the value it follows can be any character at all.
  //
  // What is constant is the shape: a lowercase `null` welded onto the end of a
  // value, with nothing between, and the field's separator immediately after.
  // Requiring both a non-space before and a comma-or-end after is what spares
  // the name of a Null Modem Cable, where `Null` is a word with a space on
  // each side.
  return text?.replace(/(?<=\S)null(?=,|$)/g, '') ?? null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number') return String(value)
  return null
}

// Reject the loopback/link-local/private ranges, so neither this fetch nor the
// route that calls it can be pointed at something internal. Exported because
// both need it: the route validates what the user pasted, and the redirect
// follower below re-checks every hop.
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '0.0.0.0' || host === '::1' || host === '[::1]') return true
  if (/^127\./.test(host)) return true
  if (/^10\./.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  if (/^169\.254\./.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  return false
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 10

interface JarEntry { value: string, domain: string }

// A cookie is kept only for the domain that set it, and sent only back to that
// domain -- a redirect off to another site must not carry the first one's
// session with it.
function storeCookies(
  res: Response,
  host: string,
  jar: Map<string, JarEntry>
): void {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : splitCookiesString(res.headers.get('set-cookie'))
  for (const cookie of parse(raw, { silent: true })) {
    if (!cookie.name) continue
    const declared = typeof cookie.domain === 'string' ? cookie.domain : null
    const domain = (declared ?? host).replace(/^\./, '').toLowerCase()
    if (host !== domain && !host.endsWith(`.${domain}`)) continue
    jar.set(`${domain}\u0000${cookie.name}`, { value: cookie.value, domain })
  }
}

function cookieHeader(
  jar: Map<string, JarEntry>,
  host: string
): string | null {
  const pairs: string[] = []
  for (const [key, entry] of jar) {
    if (host !== entry.domain && !host.endsWith(`.${entry.domain}`)) continue
    pairs.push(`${key.slice(key.indexOf('\u0000') + 1)}=${entry.value}`)
  }
  return pairs.length > 0 ? pairs.join('; ') : null
}

// Redirects are followed by hand rather than by `redirect: 'follow'`, for two
// reasons.
//
// Cookies. Some storefronts gate a first visit on a redirect that expects the
// client to carry one: AutomationDirect bounces an anonymous request through an
// SSO "silent auth" check, and without the cookie that check sets, nothing
// records that it already ran -- the request ping-pongs between the store and
// login.automationdirect.com indefinitely. curl with a jar settles it in four
// hops; Node's fetch, which has no jar, spends its redirect budget and throws,
// so those products read as unreachable when the page is in fact served.
//
// And safety. The route validates the hostname the user pasted, but with
// `follow` a vendor could redirect us onward to 169.254.169.254 and nothing
// would look again. Every hop is checked here.
async function fetchWithUa(
  url: string,
  accept: string,
  signal?: AbortSignal
): Promise<Response> {
  const jar = new Map<string, JarEntry>()
  let current = url

  for (let hop = 0; ; hop++) {
    const target = new URL(current)
    const host = target.hostname.toLowerCase()
    if (isBlockedHost(host)) {
      throw new Error(`Refusing to fetch ${host}`)
    }

    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'Accept': accept,
      'Accept-Language': 'en-US,en;q=0.9'
    }
    const cookies = cookieHeader(jar, host)
    if (cookies) headers.Cookie = cookies

    const res = await fetch(current, { signal, redirect: 'manual', headers })
    storeCookies(res, host, jar)

    const location = res.headers.get('location')
    if (!REDIRECT_STATUS.has(res.status) || !location) return res
    if (hop >= MAX_REDIRECTS) return res

    // Nothing reads a redirect's body; release it rather than leaving the
    // connection open for the length of the chain.
    await res.body?.cancel().catch(() => {})
    current = new URL(location, current).toString()
  }
}

// Image URLs in markup are often protocol-relative ("//cdn/x.jpg") or
// site-relative; the search page renders whatever it is handed, so resolve
// against the page before storing it.
function absoluteUrl(value: string | null, base: URL): string | null {
  if (!value) return null
  try {
    return new URL(value, base).toString()
  } catch {
    return null
  }
}

// ---- Shopify -------------------------------------------------------------

function shopifyHandle(urlObj: URL): string | null {
  const parts = urlObj.pathname.split('/').filter(Boolean)
  const idx = parts.indexOf('products')
  const handle = idx !== -1 ? parts[idx + 1] : undefined
  return handle ?? null
}

async function tryShopify(
  urlObj: URL,
  signal?: AbortSignal
): Promise<{ product: ExtractedProduct, vendor: string | null } | null> {
  const handle = shopifyHandle(urlObj)
  if (!handle) return null

  const jsonUrl = `${urlObj.origin}/products/${handle}.json`
  let res: Response
  try {
    res = await fetchWithUa(jsonUrl, 'application/json', signal)
  } catch {
    return null
  }
  if (!res.ok) return null
  if (!(res.headers.get('content-type') || '').includes('json')) return null

  let data: unknown
  try {
    data = await res.json()
  } catch {
    return null
  }

  const product = isRecord(data) ? data.product : null
  if (!isRecord(product)) return null
  const title = asString(product.title)
  if (!title) return null

  const rawVariants = Array.isArray(product.variants) ? product.variants : []
  const variants: ExtractedVariant[] = rawVariants
    .filter(isRecord)
    .map((v) => {
      const variantTitle = asString(v.title)
      return {
        id: asString(v.id) ?? '',
        sku: asString(v.sku),
        title:
          !variantTitle || variantTitle === 'Default Title'
            ? title
            : variantTitle,
        price: parsePrice(v.price)
      }
    })

  // Honor ?variant=<id> deep links; otherwise default to the first variant.
  const requestedVariant = urlObj.searchParams.get('variant')
  const selected
    = (requestedVariant
      && variants.find(variant => variant.id === requestedVariant))
    || variants[0]
    || null

  // Only surface a variant picker when there's a real choice to make.
  const hasRealVariants
    = variants.length > 1 || variants.some(variant => variant.title !== title)

  const rawVendor = asString(product.vendor)
  const vendor
    = rawVendor && !DEFAULT_SHOPIFY_VENDORS.has(rawVendor.toLowerCase())
      ? rawVendor
      : null

  return {
    vendor,
    product: {
      title,
      description: cleanText(product.body_html),
      productId: asString(product.id),
      price: selected?.price ?? null,
      currency: 'USD',
      sku: selected?.sku ?? null,
      variantId: selected?.id ?? null,
      variantTitle:
        selected && selected.title !== title ? selected.title : null,
      variants: hasRealVariants ? variants : []
    }
  }
}

// ---- JSON-LD -------------------------------------------------------------

// Products and ProductGroups are collected into separate lists so a page
// carrying both still prefers the plain Product. Neither recursion descends
// into `hasVariant`, so a group's choices never surface as products of their
// own.
//
// `mainEntity` is descended into because a page is entitled to describe itself
// as a WebPage and hang the actual subject underneath -- schema.org's own
// wording for the property is "the primary entity described in this page", so a
// Product found there is the product, not an incidental mention. Rock West
// Composites (Salesforce B2C Commerce) does exactly this, and reading only the
// top-level type found nothing: the OpenGraph fallback took over and every part
// came through with a title, no price, no SKU and no image, while all four sat
// in the markup one level down.
function collectProducts(
  node: unknown,
  out: Record<string, unknown>[],
  groups: Record<string, unknown>[]
): void {
  if (Array.isArray(node)) {
    for (const item of node) collectProducts(item, out, groups)
    return
  }
  if (!isRecord(node)) return
  if ('@graph' in node) collectProducts(node['@graph'], out, groups)
  if ('mainEntity' in node) collectProducts(node.mainEntity, out, groups)
  const type = node['@type']
  const types = Array.isArray(type) ? type : [type]
  if (types.includes('Product')) out.push(node)
  else if (types.includes('ProductGroup')) groups.push(node)
}

// Rock West publishes quantity discounts as a tier table in the page markup and
// not in its JSON-LD, which carries only the single-unit price. A team buying
// six tubes pays the six-up price, so reading the table is the difference
// between the figure shown and the figure charged. No extra request: the tiers
// are in the HTML already fetched.
//
// The markup is Salesforce B2C Commerce's default tiered-pricing template, so
// this would likely hold for other stores on that platform -- but only Rock
// West is confirmed, so only Rock West is asked.
// Powerwerx's JSON-LD names the product and nothing else -- their Offer
// carries a currency and an availability with no price in it, and there is no
// sku anywhere in the markup. Both are in the page, in the two nopCommerce
// blocks below, so read them from there rather than return a product priced
// null for a page we went to the trouble of rendering.
const POWERWERX_HOSTS = ['powerwerx.com']

function isPowerwerxHost(hostname: string): boolean {
  return POWERWERX_HOSTS.some(domain => hostMatches(hostname, domain))
}

function powerwerxFields(document: ParsedDoc): {
  price: number | null
  sku: string | null
  variants: ExtractedVariant[]
} {
  // The first .product-price is the product's own; the rest belong to the
  // variants below it. This has to *override* the JSON-LD rather than fill in
  // behind it, because their AggregateOffer carries lowPrice 4.79 against
  // highPrice 1089.19 over 62 offers -- a "from" price that reads like a real
  // one, the same trap WCP's configurator pages set.
  const price = parsePrice(
    document.querySelector('.product-price')?.textContent ?? null
  )
  // "SKU: Wire-RB GTIN:" -- the label and the next field share the block.
  const skuText = document.querySelector('.sku')?.textContent ?? ''
  const sku = /SKU:\s*(\S+)/i.exec(skuText)?.[1] ?? null

  // Each variant is a run of siblings: one `specAttr` per option (gauge,
  // length), the sku, then the price. They are tied together by the product id
  // in the sku element's own id -- `sku-2336` alongside `price-value-2336`.
  const variants: ExtractedVariant[] = []
  const seen = new Set<string>()
  for (const el of document.querySelectorAll('div._sku[data-sku]')) {
    const variantSku = el.getAttribute('data-sku')?.trim()
    const productId = el.getAttribute('id')?.replace(/^sku-/, '')
    const container = el.parentElement
    if (!variantSku || !productId || !container) continue
    if (seen.has(variantSku)) continue
    seen.add(variantSku)

    const options: string[] = []
    for (const attr of container.querySelectorAll('.specAttr')) {
      const value = attr.getAttribute('data-value')?.trim()
      if (!value) continue
      // The unit lives in the option's name rather than its value -- "Wire
      // Gauge (AWG)" with value "2" -- so a bare join reads "2 / 25 ft." and
      // loses what the 2 measures.
      const unit = /\(([^)]+)\)\s*$/.exec(
        attr.getAttribute('data-name') ?? ''
      )?.[1]
      options.push(unit && !value.includes(unit) ? `${value} ${unit}` : value)
    }
    const priceEl = container.querySelector(`.price-value-${productId}`)
    variants.push({
      id: variantSku,
      sku: variantSku,
      title: options.join(' / ') || variantSku,
      price: parsePrice(priceEl?.getAttribute('data-price'))
    })
  }

  return { price, sku, variants }
}

// Seattle Fabrics runs Shift4Shop (3dcart), which publishes no JSON-LD at all
// -- only schema.org *microdata*, as `<meta itemprop>` tags. The OpenGraph
// fallback below already reads `meta[itemprop="price"]`, so price and image
// come out fine without help. Two things do not, and both matter:
//
//   - `og:title` is their SEO title ("500 Denier CORDURA(R) Fabric for Sale |
//     Seattle Fabrics"), not the product name. The <h1> carries the real one.
//   - The options are the whole point of the vendor, and they live in a
//     JavaScript block rather than in the markup.
//
// The option reading itself lives in server/utils/seattle-fabrics.ts, shared
// with the cart handoff so the picker and the add cannot disagree about what
// a colour is called or what it costs.

function isSeattleFabricsHost(hostname: string): boolean {
  return SEATTLE_FABRICS_HOSTS.some(domain => hostMatches(hostname, domain))
}

// /{slug}_p_{id}.html is a product; /{slug}_c_{id}.html is a category.
//
// The id is authoritative and the slug is decoration, exactly as Online
// Metals' /pid/ is: /utter-nonsense-slug_p_52.html still serves the CORDURA,
// and a stale slug redirects to the current one -- a sitemap URL for product
// 28 came back as "Sunbrella Hold" because that product had been renamed
// since. So a link that has drifted still resolves, and what the page says
// wins over what the URL claims.
const SEATTLE_FABRICS_PRODUCT = /_p_(\d+)\.html$/i

function seattleFabricsFields(
  document: ParsedDoc,
  html: string,
  productId: string,
  basePrice: number | null
): { title: string | null, sku: string | null, variants: ExtractedVariant[] } {
  const title = cleanName(document.querySelector('h1')?.textContent)

  const variants: ExtractedVariant[] = seattleFabricsOptions(html, productId)
    .map(option => ({
      // The option id, which is what the cart handoff has to post. The
      // slideover stores `sku ?? id`, so the order still carries the part
      // number and this costs nothing.
      id: option.optionId,
      sku: option.sku,
      title: cleanText(option.label) ?? option.sku,
      price: seattleFabricsPrice(basePrice, option)
    }))

  // One option is not a choice, it is the part number restated -- the same
  // rule the nested-offer reader uses. Hand it back as the product's SKU
  // instead, which is the useful half.
  if (variants.length === 1) {
    return { title, sku: variants[0]!.sku, variants: [] }
  }
  return { title, sku: null, variants }
}

// BrickLink is a marketplace, not a storefront, and that shapes everything
// here. A store URL is /{storeSlug}?itemID=N#/shop: the same LEGO part is
// listed by many sellers at their own prices and conditions, so the seller is
// part of the vendor's identity -- "BrickLink — Old Brick", not "BrickLink".
// Without that, two parts bought from two sellers group into one order that
// cannot be checked out as one, since findOrCreatePendingOrder groups by
// vendor and each seller is a separate checkout.
//
// The page carries no JSON-LD and no OpenGraph at all, and its <title> is the
// store rather than the item, so the generic fallbacks would name a part after
// the shop. Everything below is read from the item row the SPA renders.
const BRICKLINK_HOSTS = ['bricklink.com']

function isBrickLinkHost(hostname: string): boolean {
  return BRICKLINK_HOSTS.some(domain => hostMatches(hostname, domain))
}

// "Old Brick - BrickLink.com" -> "Old Brick". Falls back to the store slug in
// the path, which is what the URL carries when the title has not rendered.
function brickLinkSeller(document: ParsedDoc, urlObj: URL): string | null {
  const title = document.querySelector('title')?.textContent ?? ''
  const named = /^(.*?)\s*-\s*BrickLink\.com\s*$/i.exec(title.trim())?.[1]
  if (named) return named.trim()
  const slug = urlObj.pathname.split('/').filter(Boolean)[0]
  return slug ? slug.replace(/_/g, ' ') : null
}

function fromBrickLink(
  document: ParsedDoc,
  urlObj: URL
): { vendorName: string, product: ExtractedProduct } | null {
  const row = document.querySelector('.item.table-row')
  if (!row) return null

  // The name is split across <strong> runs -- colour, then the part name.
  const parts: string[] = []
  for (const strong of row.querySelectorAll('.description p strong')) {
    const value = cleanName(strong.textContent)
    if (value) parts.push(value)
  }
  const title = parts.join(' ').replace(/\s+/g, ' ').trim()
  if (!title) return null

  // The breadcrumb ends with the BrickLink part number (54821pb02), which is
  // the identifier that means anything across sellers.
  const crumbs = [...row.querySelectorAll('.bl-breadcrumb a')]
  const sku = cleanName(crumbs.at(-1)?.textContent)

  // "Price: EUR 99.5299(~US $115.6733)" for a seller pricing in their own
  // currency, or a plain "US $12.34". Take the dollar figure either way: it is
  // what BrickLink shows the buyer, and this schema stores a bare number with
  // no currency beside it, so a euro amount would be recorded as dollars.
  const buy = row.querySelector('.buy')?.textContent ?? ''
  const price = parsePrice(/US\s*\$\s*([\d,]+\.?\d*)/i.exec(buy)?.[1] ?? null)
  const converted = /~\s*US\s*\$/i.test(buy)
  // The seller's own figure, whatever currency they price in. Recorded
  // whenever it differs from the dollar amount -- including when there is no
  // dollar amount at all, which happens when BrickLink converts into some
  // other currency for the viewer and leaves `price` null. Losing it then
  // would leave a line item with no indication of what the thing costs.
  const native = /Price:\s*([A-Z]{3}\s*[\d,.]+)/.exec(buy)?.[1]

  const condition = cleanName(row.querySelector('.condition')?.textContent)
  const notes = [
    condition ? `Condition: ${condition}` : null,
    // Say so on the record when the figure is BrickLink's own conversion
    // rather than the amount the seller charges.
    native && converted ? `Seller price ${native}; US $ is converted` : null,
    native && !converted && price === null
      ? `Seller price ${native}; no US $ conversion shown, enter the price`
      : null
  ].filter(Boolean).join('. ')

  const seller = brickLinkSeller(document, urlObj)
  return {
    vendorName: seller ? `BrickLink — ${seller}` : 'BrickLink',
    product: {
      title,
      description: notes || null,
      price,
      currency: 'USD',
      sku,
      image: absoluteUrl(
        row.querySelector('.image img')?.getAttribute('src') ?? null,
        urlObj
      ),
      variantId: null,
      variantTitle: null,
      variants: []
    }
  }
}

const AUTOMATION_DIRECT_HOSTS = ['automationdirect.com']

function isAutomationDirectHost(hostname: string): boolean {
  return AUTOMATION_DIRECT_HOSTS.some(domain => hostMatches(hostname, domain))
}

function isRockWestHost(hostname: string): boolean {
  return ROCK_WEST_HOSTS.some(domain => hostMatches(hostname, domain))
}

const TIER_SPAN = /<span[^>]*class="[^"]*\btier-quantity\b[^"]*"[^>]*>/gi

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`, 'i').exec(tag)
  return match ? match[1]! : null
}

function rockWestPriceBreaks(html: string): PriceBreak[] {
  const breaks: PriceBreak[] = []
  for (const [tag] of html.matchAll(TIER_SPAN)) {
    // Attributes are read by name rather than by position -- a template is
    // free to reorder them, and a regex that assumed the order would fail
    // silently by finding nothing.
    const quantity = Number(attr(tag, 'data-quantity'))
    const unitPrice = Number(attr(tag, 'data-price'))
    if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice)) continue
    if (quantity < 1 || unitPrice <= 0) continue
    breaks.push({ quantity: Math.round(quantity), unitPrice })
  }
  // A single tier is not a discount schedule, just the ordinary price restated.
  if (breaks.length < 2) return []
  return breaks.sort((a, b) => a.quantity - b.quantity)
}

// Shopify's newer storefronts describe an options product as a schema.org
// ProductGroup: the group holds the name and description, and every choice is
// a Product under `hasVariant` carrying its own price. Matching `@type:
// Product` alone found nothing on those pages, so the OpenGraph fallback took
// over and the part arrived with a title and no price at all. Bambu Lab's
// store is one, and it has no second way in -- /products/{handle}.json,
// /products.json and /cart.js all 404 there, so the Shopify path never runs.
function variantsFromProductGroup(
  group: Record<string, unknown>,
  groupName: string,
  base: URL
): ExtractedVariant[] {
  const raw = group.hasVariant
  if (!Array.isArray(raw)) return []
  const prefix = `${groupName} - `
  const variants: ExtractedVariant[] = []
  for (const variant of raw) {
    if (!isRecord(variant)) continue
    const name = cleanName(variant.name)
    if (!name) continue
    const offers = Array.isArray(variant.offers) ? variant.offers[0] : variant.offers
    const id
      = variantIdFromUrl(isRecord(offers) ? asString(offers.url) : null, base)
      ?? asString(variant.productID)
      ?? ''
    const sku = asString(variant.sku)
    // Shopify names a variant "{product} - {options}"; the picker wants only
    // the options half.
    let title = name.startsWith(prefix) ? name.slice(prefix.length) : name
    if (!title || title === 'Default Title') title = groupName
    variants.push({
      id,
      // The markup falls back to the variant id when a product carries no SKU
      // of its own, which every Bambu Lab part does. Storing that would put a
      // Shopify internal id in front of the buyer as a part number.
      sku: sku && sku !== id ? sku : null,
      title,
      price: priceFromOffers(offers).price
    })
  }
  return variants
}

// An AggregateOffer may carry the individual offers it summarises, and where a
// vendor fills those in they *are* the variants. Online Metals lists one per
// cut length, each with the `?variant=` id its own URLs use, so this recovers
// the picker the URL-only parser could only ever guess at from the query
// string -- and the prices, which that parser had no way to know at all.
//
// Properties describing the shipment rather than the choice are dropped: a
// variant labelled "12.0 / 0.44" would be offering the buyer a weight.
const OFFER_PROPERTY_NOISE = /weight|shipping|ship\s/i

function variantsFromAggregateOffer(
  offers: unknown,
  base: URL
): ExtractedVariant[] {
  if (!isRecord(offers)) return []
  const nested = offers.offers
  if (!Array.isArray(nested)) return []

  const variants: ExtractedVariant[] = []
  const seen = new Set<string>()
  for (const offer of nested) {
    if (!isRecord(offer)) continue
    const sku = asString(offer.sku)
    const id
      = sku
      ?? variantIdFromUrl(asString(offer.url), base)
    if (!id || seen.has(id)) continue
    seen.add(id)

    const labels: string[] = []
    const props = offer.additionalProperty
    for (const prop of Array.isArray(props) ? props : [props]) {
      if (!isRecord(prop)) continue
      const name = asString(prop.name) ?? ''
      if (OFFER_PROPERTY_NOISE.test(name)) continue
      const value = asString(prop.value)
      if (value) labels.push(value)
    }

    variants.push({
      id,
      sku,
      title: labels.join(' / ') || id,
      price: parsePrice(offer.price)
    })
  }
  // One offer is not a choice, just the price restated.
  return variants.length > 1 ? variants : []
}

// A ProductGroup's offers link to the variant as ?id= (Shopify's own markup)
// or ?variant= (the canonical product URL form).
function variantIdFromUrl(value: string | null, base: URL): string | null {
  if (!value) return null
  try {
    const params = new URL(value, base).searchParams
    return params.get('id') ?? params.get('variant')
  } catch {
    return null
  }
}

// schema.org lets a node point at another by reference rather than nesting it,
// and Sailrite splits a product across four <script> blocks that way: the
// Product carries `"offers": {"@id": "#offers"}` and `"image": {"@id":
// "#primary-image"}`, with the Offer holding the price and the ImageObject the
// URL in blocks of their own. Reading the Product alone therefore produced a
// complete-looking part with no price at all -- the failure this resolves.
function collectById(node: unknown, out: Map<string, Record<string, unknown>>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectById(item, out)
    return
  }
  if (!isRecord(node)) return
  if ('@graph' in node) collectById(node['@graph'], out)
  if ('mainEntity' in node) collectById(node.mainEntity, out)
  const id = node['@id']
  if (typeof id === 'string' && id && !out.has(id)) out.set(id, node)
}

/**
 * Swap a bare `{"@id": "#x"}` for the node it names. Fields written inline win
 * over the referenced ones, so a node that carries both its own data and an
 * id keeps its data.
 */
function resolveRef(
  value: unknown,
  byId: Map<string, Record<string, unknown>>
): unknown {
  if (Array.isArray(value)) return value.map(item => resolveRef(item, byId))
  if (!isRecord(value)) return value
  const id = value['@id']
  if (typeof id !== 'string') return value
  const target = byId.get(id)
  if (!target || target === value) return value
  return { ...target, ...value }
}

function priceFromOffers(offers: unknown): {
  price: number | null
  currency: string | null
} {
  if (Array.isArray(offers)) {
    for (const offer of offers) {
      const result = priceFromOffers(offer)
      if (result.price != null) return result
    }
    return { price: null, currency: null }
  }
  if (!isRecord(offers)) return { price: null, currency: null }
  // AggregateOffer nests real offers; recurse into them first.
  if (offers.offers) {
    const nested = priceFromOffers(offers.offers)
    if (nested.price != null) return nested
  }
  const direct = parsePrice(offers.price ?? offers.lowPrice ?? offers.highPrice)
  if (direct != null) {
    return { price: direct, currency: asString(offers.priceCurrency) }
  }
  // schema.org also lets the amount sit in a priceSpecification instead of on
  // the offer itself, and Ace Hardware's pages only put it there: their Offer
  // carries availability and a return policy, with the money in a
  // UnitPriceSpecification beside them. Reading the offer alone found a
  // complete-looking product priced null. The recursion works because a
  // PriceSpecification names its fields `price`/`priceCurrency` too; the first
  // entry carrying an amount wins, as it does for a list of offers.
  if (offers.priceSpecification) {
    const spec = priceFromOffers(offers.priceSpecification)
    if (spec.price != null) {
      return {
        price: spec.price,
        currency: spec.currency ?? asString(offers.priceCurrency)
      }
    }
  }
  return { price: null, currency: asString(offers.priceCurrency) }
}

function brandName(brand: unknown): string | null {
  if (typeof brand === 'string') return brand.trim() || null
  if (isRecord(brand)) return asString(brand.name)
  return null
}

// ---- HTML meta -----------------------------------------------------------

// linkedom ships loose DOM types (and the server tsconfig omits the DOM lib),
// so describe just the surface we use and cast the parsed document to it.
interface ParsedEl {
  getAttribute(name: string): string | null
  textContent: string | null
  // Only the Powerwerx reader needs to walk the tree: their variants are a run
  // of sibling elements sharing a container.
  parentElement: ParsedEl | null
  querySelector(selector: string): ParsedEl | null
  querySelectorAll(selector: string): Iterable<ParsedEl>
}
interface ParsedDoc {
  querySelector(selector: string): ParsedEl | null
  querySelectorAll(selector: string): Iterable<ParsedEl>
}

function parseDocument(html: string): ParsedDoc {
  return (parseHTML(html) as unknown as { document: ParsedDoc }).document
}

function getMeta(document: ParsedDoc, selectors: string[]): string | null {
  for (const selector of selectors) {
    const el = document.querySelector(selector)
    if (!el) continue
    const content
      = el.getAttribute('content') ?? el.getAttribute('value') ?? el.textContent
    if (content && content.trim()) return content.trim()
  }
  return null
}

// ---- URL-only vendors ----------------------------------------------------

// Some vendors' product pages can't be read by a server at all — the details
// arrive via client-side rendering, or the site refuses automated requests.
// Their URLs still identify the part, and parsing one costs no request, so
// these hosts skip the network entirely.

// Online Metals sits behind a bot challenge, so a server fetch of the product
// page comes back as an interstitial rather than the listing — none of the
// three strategies above can see anything. Their URLs carry enough on their
// own to be worth filling in:
//   /en/buy/{category}/{slug}/pid/{pid}          the product
//   ?variant={pid}_{lengthInInches}_{n}          a specific cut length
// Their marketplace items carry a prefixed id -- /pid/mp-00065192 -- alongside
// the plain numeric ones, so this cannot require digits.
const ONLINE_METALS_PRODUCT = /\/buy\/[^/]+\/([^/]+)\/pid\/([\w-]+)/i

function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .join(' ')
    // Leading dimensions are written as "0-625" for 0.625". Only a leading
    // zero is unambiguous — "1-2" is a fraction (1/2"), so leave it alone.
    .replace(/\b0 (\d+)/g, '0.$1')
    .replace(/\b\w/g, character => character.toUpperCase())
}

function fromOnlineMetalsUrl(urlObj: URL): ExtractedProduct | null {
  const match = ONLINE_METALS_PRODUCT.exec(urlObj.pathname)
  if (!match) return null
  const [, slug, productId] = match

  // The cut length is what actually gets ordered, so prefer its sku over the
  // bare product id when the link names one.
  const variant = urlObj.searchParams.get('variant')
  const isVariantOfProduct = !!variant && variant.startsWith(`${productId}_`)
  const lengthInches = isVariantOfProduct ? variant.split('_')[1] : null

  return {
    title: titleFromSlug(slug!),
    description: null,
    // Price is per cut length and only lives on the page we can't read.
    price: null,
    currency: 'USD',
    sku: isVariantOfProduct ? variant : productId!,
    variantId: isVariantOfProduct ? variant : null,
    variantTitle: lengthInches ? `${lengthInches}" length` : null,
    variants: []
  }
}

// McMaster-Carr renders product pages entirely client-side, marks them
// `noindex, noarchive`, and disallows the endpoints that serve the data in
// robots.txt — a fetch returns a shell whose only title is "McMaster-Carr",
// which would be worse than nothing. We never request their pages.
//
// The part number is the whole identifier and it's right in the path:
//   /91290A115/                          the part
//   /91290A115-alloy-steel-screws/       same, with an SEO slug
const MCMASTER_PART = /^\/(\d{3,6}[A-Z]\d{1,5})(?:-([a-z0-9-]+))?\/?$/i

function fromMcMasterUrl(urlObj: URL): ExtractedProduct | null {
  const match = MCMASTER_PART.exec(urlObj.pathname)
  if (!match) return null
  const [, partNumber, slug] = match

  return {
    // Without the page there's no description; the part number is a name a
    // team will recognise, and they can rename it.
    title: slug ? titleFromSlug(slug) : partNumber!.toUpperCase(),
    description: null,
    price: null,
    currency: 'USD',
    sku: partNumber!.toUpperCase(),
    variantId: null,
    variantTitle: null,
    variants: []
  }
}

// DigiKey sits behind the same bot challenge Online Metals uses, but its URLs
// are unusually rich — manufacturer, manufacturer part number, and DigiKey's
// own product id are all in the path:
//   /en/products/detail/{manufacturer}/{mpn}/{id}
//   /product-detail/en/{manufacturer}/{mpn}/{digikeyPartNumber}/{id}  (legacy)
export const DIGIKEY_HOSTS = ['digikey.com', 'digikey.ca']
const DIGIKEY_MODERN = /\/products\/detail\/([^/]+)\/([^/]+)\/(\d+)/i
const DIGIKEY_LEGACY
  = /\/product-detail\/[a-z]{2}\/([^/]+)\/([^/]+)\/([^/]+)\/(\d+)/i

// The manufacturer and part number a DigiKey link names, for callers that
// want to look the part up properly rather than guess from the URL.
export function digiKeyPartFromUrl(
  url: string
): { manufacturer: string, mpn: string } | null {
  let urlObj: URL
  try {
    urlObj = new URL(url)
  } catch {
    return null
  }
  if (!DIGIKEY_HOSTS.some(domain => hostMatches(urlObj.hostname, domain))) {
    return null
  }
  const match
    = DIGIKEY_LEGACY.exec(urlObj.pathname)
      ?? DIGIKEY_MODERN.exec(urlObj.pathname)
  if (!match) return null
  const mpn = decodeURIComponent(match[2]!).trim()
  if (!mpn) return null
  return { manufacturer: titleFromSlug(decodeURIComponent(match[1]!)), mpn }
}

function fromDigiKeyUrl(urlObj: URL): ExtractedProduct | null {
  const match
    = DIGIKEY_LEGACY.exec(urlObj.pathname)
      ?? DIGIKEY_MODERN.exec(urlObj.pathname)
  if (!match) return null

  const manufacturer = titleFromSlug(decodeURIComponent(match[1]!))
  // The manufacturer part number is what engineers call the part, and what a
  // BOM will be written against — so it's both the name and the sku.
  const mpn = decodeURIComponent(match[2]!).trim()
  if (!mpn) return null

  return {
    title: manufacturer ? `${manufacturer} ${mpn}` : mpn,
    description: null,
    // Price is per quantity break and only lives on the page we can't read.
    price: null,
    currency: 'USD',
    sku: mpn,
    variantId: null,
    variantTitle: null,
    variants: []
  }
}

// Studica runs nopCommerce behind a Cloudflare *managed* challenge, and it
// covers everything — product pages, robots.txt, sitemap.xml, products.json,
// and the .ca storefront too. The challenge keys on the client's fingerprint
// rather than on headers or IP: curl with a browser User-Agent from a
// residential address is refused, and so is headless Chrome. Only a headed
// browser clears it. Delegating to vendord would not help, because vendord
// makes the same kind of plain request this does.
//
// That is a shame rather than a parsing problem: their product pages carry a
// complete schema.org Product block (name, sku, mpn, brand, offers.price)
// that the JSON-LD path below would read perfectly. If Studica ever allowlist
// us or publish a feed, delete this and let the ordinary extraction run.
//
// Until then the URL is all there is. Studica's product URLs are a single
// flat slug at the root (/motor-pack), which is the same shape as their
// category and marketing pages (/motors, /webinars) — so there is no way to
// tell a product link from any other link, and the name below is a guess from
// the slug. Deliberately no price and no SKU: a guessed name with an empty
// price reads as the rough draft it is, whereas inventing a price would look
// like a successful lookup.
const STUDICA_SLUG = /^\/([a-z0-9][a-z0-9-]*)\/?$/i

// Pages that are definitely not parts, so a stray paste doesn't become a line
// item named "Cart". Categories are indistinguishable from products and are
// not worth guessing at.
const STUDICA_NON_PRODUCT = new Set([
  'cart', 'checkout', 'login', 'register', 'search', 'compareproducts',
  'contactus', 'customer', 'wishlist', 'recentlyviewedproducts', 'newproducts',
  'privacy-notice', 'conditions-of-use', 'about-us', 'webinars', 'blog'
])

function fromStudicaUrl(urlObj: URL): ExtractedProduct | null {
  const match = STUDICA_SLUG.exec(urlObj.pathname)
  if (!match) return null
  const slug = match[1]!.toLowerCase()
  if (STUDICA_NON_PRODUCT.has(slug)) return null

  return {
    title: titleFromSlug(slug),
    description: null,
    price: null,
    currency: 'USD',
    sku: null,
    variantId: null,
    variantTitle: null,
    variants: []
  }
}

// VEX runs Magento behind a Cloudflare rule stricter than Studica's. It
// refuses curl and Node's fetch — so delegating to vendord would not help
// either, since vendord makes the same kind of plain request — refuses
// headless Chrome, and answers with a custom "Access Temporarily Blocked"
// page rather than a challenge anything can solve. A headed browser does get
// through, but only for roughly one navigation: a second page load in the
// same session is blocked again.
//
// As with Studica that is a shame rather than a parsing problem. VEX product
// pages carry a complete schema.org Product block (name, sku, mpn,
// offers.price) that the JSON-LD path below would read perfectly, and their
// robots.txt allows the product URLs. If VEX ever allowlist us, delete this
// and let the ordinary extraction run.
//
// The URL is worth more here than it is at Studica, though. A VEX product
// page is /276-4810.html, and that part number is exactly what the page
// itself reports as both sku and mpn — so it is authoritative rather than a
// guess. Only the description and the price are missing.
//
// Deliberately only the part-number shape is accepted. VEX serves slug pages
// with the same .html suffix (/wheels.html, /gears.html, /v5-structure.html)
// and those are *group* pages: marked up as a Product, named "Wheels", with a
// null price and nothing orderable behind them. Turning one into a line item
// would read as a successful lookup for a part that cannot be bought — the
// same trap WCP's configurator pages set. Anchoring the digits also rejects
// the near misses that begin with them: /123-kits.html and /393-motors.html
// are slugs, not part numbers.
const VEX_PART = /^\/(\d{3}-\d{4})\.html$/i

function fromVexUrl(urlObj: URL): ExtractedProduct | null {
  const match = VEX_PART.exec(urlObj.pathname)
  if (!match) return null

  // Teams write their BOMs against this number, and VEX sells only its own
  // parts, so it stands alone as the name — there is no manufacturer to
  // qualify it with the way a DigiKey line needs.
  const partNumber = match[1]!

  return {
    title: partNumber,
    description: null,
    // Only ever on the page, never in the URL.
    price: null,
    currency: 'USD',
    sku: partNumber,
    variantId: null,
    variantTitle: null,
    variants: []
  }
}

// Lowe's sits behind Akamai Bot Manager and there is no server-side way in.
// A plain fetch is answered 403; a full browser header set gets the behavioural
// challenge interstitial ("Powered and protected by Akamai") rather than the
// page; and Chromium, headless or headed, is answered "Access Denied" outright.
// Delegating to vendord would achieve nothing, since it makes the same kind of
// request. Their robots.txt also disallows /pd/*/*/pricing/*, so the price is
// off-limits by their own policy and not merely unreachable -- the same
// standing as McMaster. Don't add a scraping path for them.
//
// What the URL does carry is genuinely useful. /pd/{slug}/{itemNumber} holds
// the item number Lowe's search and stores index by (their "Item #"), and a
// slug that is the product title with every space turned into a hyphen.
const LOWES_PRODUCT = /^\/pd\/([^/]+)\/(\d+)\/?$/i

// Both hardware stores here hyphenate the product title to build the slug, so
// the same reconstruction serves Lowe's and Home Depot.
//
// Hardware is sized in fractions, and the slug flattens both "3/4" and "3.375"
// to the same "3-4"/"3-375" shape -- so "1-2-in" has to be told apart from
// "2-12-in" or the name comes out meaning something else entirely.
//
// A fraction is recoverable because of what hardware fractions look like: the
// denominator is a power of two, and a fully reduced numerator over one is
// always odd (2/4 would have been written 1/2). A leading zero settles it the
// other way, since nothing is sized "0/944". Checked against the 7,855 product
// URLs in their sitemap: 3/4-in, 1/8-in and 1/32-in come back as fractions,
// while 3.375-in, 94.48-in, 0.944-in, 1.023-in and 3.5625-in stay decimal.
const FRACTION_DENOMINATORS = new Set([2, 4, 8, 16, 32, 64])

function isHardwareFraction(numerator: string, denominator: string): boolean {
  if (denominator.startsWith('0')) return false
  const n = Number(numerator)
  const d = Number(denominator)
  return FRACTION_DENOMINATORS.has(d) && n % 2 === 1 && n < d
}

// A bare dimension -- 10X14, 10X14X2 -- is a size, never a model number.
const DIMENSION_TOKEN = /^\d+(?:X\d+)+$/

function isModelNumber(token: string): boolean {
  if (token.length < 5) return false
  if (token !== token.toUpperCase()) return false
  if (DIMENSION_TOKEN.test(token)) return false
  const letters = token.match(/[A-Z]/g)?.length ?? 0
  const digits = token.match(/\d/g)?.length ?? 0
  return letters >= 2 && digits >= 2
}

// The lower half of a measurement, which may carry a dimension letter straight
// on the end: Menards writes 69-1-4w for 69-1/4 inches wide, and 527 of the 748
// measurements in their sitemap look like that -- more than don't. Lowe's and
// Home Depot always separate the unit, so this costs them nothing.
const MEASURE_TAIL = /^(\d+)([a-z]{1,2})?$/i

function measureTail(
  value: string | undefined
): { digits: string, suffix: string } | null {
  const match = value ? MEASURE_TAIL.exec(value) : null
  return match ? { digits: match[1]!, suffix: match[2] ?? '' } : null
}

// Words left lowercase inside a title. "x" earns its place here: it is the
// dimension separator in half these names ("62-1/4 x 80"), and capitalising it
// reads as a word rather than a multiplication sign.
const TITLE_MINOR_WORDS = new Set([
  'a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'per', 'the',
  'to', 'with', 'x'
])

// Menards lowercases its whole slug, so a name lifted straight out of one
// arrives shouting nothing and meaning little ("aston nautis xl ... shower
// door"). Lowe's and Home Depot keep the real casing in theirs -- "DEWALT",
// "KILZ", "RUBI" -- so they must not be put through this, which would render
// those as "Dewalt", "Kilz" and "Rubi".
function capitalizeTitle(
  title: string,
  terms?: Map<string, string>
): string {
  return title
    .split(' ')
    .map((word, index) => {
      // A caller-supplied display form wins outright: it is the only thing
      // that can produce the mixed case an acronym actually carries, which no
      // capitalisation rule would arrive at ("PCIe", not "Pcie" or "PCIE").
      const term = terms?.get(word.toLowerCase())
      if (term) return term
      // Anything starting with a digit is a measurement. Its own capitals are
      // the dimension letters written straight onto the number -- 69-1/4w x
      // 80h, which the store renders 69-1/4"W x 80"H. A letter run only counts
      // when it sits directly on a digit, so the "lb" in "4-lb" is left alone.
      if (!/^[a-z]/i.test(word)) {
        return word.replace(
          /(\d)([a-z]{1,2})$/,
          (_, digit, letters) => digit + letters.toUpperCase()
        )
      }
      if (index > 0 && TITLE_MINOR_WORDS.has(word.toLowerCase())) {
        return word.toLowerCase()
      }
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(' ')
}

function titleFromHardwareSlug(slug: string, capitalize = false): string {
  const parts = slug.split('-')
  const out: string[] = []
  const isNumber = (value: string | undefined) => !!value && /^\d+$/.test(value)

  for (let i = 0; i < parts.length; i++) {
    const a = parts[i]!
    const b = parts[i + 1]
    const c = parts[i + 2]
    // "1-1-2-in" is one and a half inches: a whole number, then a fraction.
    if (isNumber(a) && isNumber(b)) {
      const tail = measureTail(c)
      if (tail && isHardwareFraction(b!, tail.digits)) {
        out.push(`${a}-${b}/${tail.digits}${tail.suffix}`)
        i += 2
        continue
      }
    }
    if (isNumber(a)) {
      const tail = measureTail(b)
      if (tail) {
        out.push(
          isHardwareFraction(a, tail.digits)
            ? `${a}/${tail.digits}${tail.suffix}`
            : `${a}.${tail.digits}${tail.suffix}`
        )
        i += 1
        continue
      }
    }
    out.push(a)
  }

  // Both stores tend to end the slug with the manufacturer's model number --
  // 42% of Home Depot's URLs and 5% of Lowe's -- which reads as noise on a line
  // item ("...Shutters in Peaceful Blue ARW101BB311X33SBH"). The product is
  // still identified by the item number in the URL, which is what either
  // store's own search takes, so the token is dropped.
  //
  // The test is deliberately strict, because the failure that matters is
  // stripping a *size*: for hardware that is the half of the name carrying the
  // meaning, the same reason the fractions above are rebuilt. Requiring two
  // letters spares "10X14", "1000W" and "5000K", and the dimension guard spares
  // "10X14X2", whose two X's would otherwise read as letters. Erring this way
  // leaves single-letter model numbers like "G16010" in the title, which merely
  // looks untidy.
  const last = out.at(-1)
  if (last && isModelNumber(last)) out.pop()

  // Rejoin a unit to the measurement in front of it, and only there: an
  // unanchored rule also rewrote ordinary words, turning "All in One" into
  // "All-in One".
  const title = out
    .join(' ')
    .replace(/(\d)\s+(in|ft|mm|cm|oz|lb)\b/gi, '$1-$2')
    .trim()
  return capitalize ? capitalizeTitle(title) : title
}

function fromLowesUrl(urlObj: URL): ExtractedProduct | null {
  const match = LOWES_PRODUCT.exec(urlObj.pathname)
  if (!match) return null
  const title = titleFromHardwareSlug(match[1]!)
  if (!title) return null

  return {
    title,
    description: null,
    price: null,
    currency: 'USD',
    // Lowe's own "Item #", which is what their search and their stores look up.
    sku: match[2]!,
    variantId: null,
    variantTitle: null,
    variants: []
  }
}

// Home Depot is the same story as Lowe's and reached the same way. AkamaiGHost
// answers a plain fetch with a bare "Access Denied" -- not even a challenge --
// and Chromium is refused identically whether headless or headed. Their
// federation-gateway GraphQL API does respond, but only to a storefront key
// carried in page JS that the block keeps out of reach; harvesting one to get
// around a control they have deliberately put up is not something to build, and
// their affiliate product feed is the sanctioned route if this is ever wanted
// properly. Unlike Lowe's, robots.txt permits /p/ -- the block is technical
// rather than policy -- but permitted and possible are different things.
//
// /p/{slug}/{internetNumber}: the trailing id is the "Internet #" their own
// search takes, and the slug is the hyphenated title.
//
// The slug must carry a hyphen. Without that, /p/qv/{id} -- the quick-view
// endpoint their own robots.txt disallows -- parses as a product named "qv".
// Every one of the 45,000 product URLs in their sitemap has a multi-word slug,
// so nothing real is turned away. Lowe's gets no such rule: 373 of theirs are
// genuinely single-word.
const HOME_DEPOT_PRODUCT = /^\/p\/(?:[^/]+\/)*([^/]*-[^/]*)\/(\d+)\/?$/i

function fromHomeDepotUrl(urlObj: URL): ExtractedProduct | null {
  const match = HOME_DEPOT_PRODUCT.exec(urlObj.pathname)
  if (!match) return null
  const title = titleFromHardwareSlug(match[1]!)
  if (!title) return null

  return {
    title,
    description: null,
    price: null,
    currency: 'USD',
    sku: match[2]!,
    variantId: null,
    variantTitle: null,
    variants: []
  }
}

// Menards is behind Imperva Advanced Bot Protection, and unlike the other two
// the block is selective: their home page, category pages and sitemaps all
// serve a plain fetch happily, while a product page answers with Imperva's
// "Pardon Our Interruption" challenge. Chromium is refused harder still, headed
// or headless -- a bare "Request unsuccessful. Incapsula incident". Probing
// further only escalated it, with sitemap URLs that had worked minutes earlier
// starting to answer the interstitial too, so the sensible reading is that
// automated product access is not on offer and should not be pursued.
//
// /main/{category...}/{slug}/{model}/p-{productId}-c-{categoryId}.htm -- the
// title slug and the model number are the two segments before the last, in
// every one of the 6,690 product URLs in their sitemap.
const MENARDS_PRODUCT = /^\/main\/(?:.+\/)?([^/]+)\/([^/]+)\/p-\d+-c-\d+\.htm$/i

function fromMenardsUrl(urlObj: URL): ExtractedProduct | null {
  const match = MENARDS_PRODUCT.exec(urlObj.pathname)
  if (!match) return null
  const title = titleFromHardwareSlug(match[1]!, true)
  if (!title) return null

  return {
    title,
    description: null,
    price: null,
    currency: 'USD',
    // Their model number, which is what the page shows and their search takes.
    // Upper-cased because the URL lowercases it and the store does not.
    sku: match[2]!.toUpperCase(),
    variantId: null,
    variantTitle: null,
    variants: []
  }
}

// Harbor Freight is behind PerimeterX. Their homepage is served -- it is cached
// hard at the edge -- but product and category pages both answer 403 with a
// px-captcha body, so there is nothing to read and nothing for vendord to add.
// robots.txt is readable and permits product pages, so this is a bot control
// rather than a policy about crawlers.
//
// /{slug}-{itemNumber}.html, one path segment: the trailing digits are the
// "Item #" printed on their shelf tags and taken by their own search, and the
// slug is the lowercase title, so it goes through the same reconstruction as
// Lowe's, Home Depot and Menards.
//
// The corpus behind this is thinner than for those three, because the sitemap
// and every category page are blocked: it is one product URL taken from their
// own homepage plus the nine non-product links beside it. The single path
// segment is what separates them -- /deals.html and /join-inside-track-club.html
// carry no trailing number, and /collections/inside-track-club-deals.html is
// two segments. The slug reconstruction itself is the one already validated
// against 60,000 URLs from the other three.
const HARBOR_FREIGHT_PRODUCT = /^\/([a-z0-9-]+)-(\d+)\.html$/i

function fromHarborFreightUrl(urlObj: URL): ExtractedProduct | null {
  const match = HARBOR_FREIGHT_PRODUCT.exec(urlObj.pathname)
  if (!match) return null
  // Their slugs are lowercase, as Menards' are, so the title is rebuilt.
  const title = titleFromHardwareSlug(match[1]!, true)
  if (!title) return null

  return {
    title,
    description: null,
    price: null,
    currency: 'USD',
    sku: match[2]!,
    variantId: null,
    variantTitle: null,
    variants: []
  }
}

// Micro Center sits behind a Cloudflare managed challenge, and unlike Studica's
// and VEX's a headed browser does not reliably clear it. Measured: one render
// in five got through, after 28 seconds, and the rest sat on the interstitial
// for the whole window -- after which the store stopped issuing a clearance
// cookie to that address at all, on a fresh context and a second product. That
// is worse than useless here. Every paste would hang for the full browser
// budget and then fall back to exactly what this parser returns anyway, while
// each attempt spends the standing of whatever address makes it -- and in
// production that is a datacentre IP, which Cloudflare treats more harshly
// than the residential one these numbers came from. Their robots.txt is behind
// the same wall, so their crawl policy cannot be read either.
//
// So they are matched before any network call and their site is never
// requested. That is the whole point of the entry, not a consolation prize.
//
// /product/{itemNumber}/{slug}. The item number is Micro Center's own -- what
// is on the shelf tag and what their search takes -- and their slugs are
// unusually descriptive, so the pair rebuilds a good line item. /support/{id}/
// pages share the shape but not the first segment, so they do not match.
const MICRO_CENTER_PRODUCT = /^\/product\/(\d+)\/([^/]+)\/?$/i

// Their catalogue is written in acronyms, and a de-slugged title capitalises
// them as ordinary words -- "Ssd", "Nvme", "Pcie" -- which reads as a typo on
// every line item. An explicit table rather than a rule about short tokens, so
// it can only reach words that are always acronyms in a parts catalogue and
// never a size. It carries the mixed-case forms for the same reason: no
// uppercasing rule gets "PCIe" or "GBps" right.
//
// Deliberately absent: "m2". Micro Center writes M.2 for the drive form
// factor, but an M2 screw is a real thing a team buys, and "M2" is right for
// both readings where "M.2" is right for only one.
const MICRO_CENTER_TERMS = new Map([
  ['ssd', 'SSD'], ['hdd', 'HDD'], ['nvme', 'NVMe'], ['pcie', 'PCIe'],
  ['pci', 'PCI'], ['sata', 'SATA'], ['usb', 'USB'], ['hdmi', 'HDMI'],
  ['vga', 'VGA'], ['dvi', 'DVI'], ['rgb', 'RGB'], ['led', 'LED'],
  ['lcd', 'LCD'], ['oled', 'OLED'], ['cpu', 'CPU'], ['gpu', 'GPU'],
  ['ram', 'RAM'], ['ddr', 'DDR'], ['ddr3', 'DDR3'], ['ddr4', 'DDR4'],
  ['ddr5', 'DDR5'], ['atx', 'ATX'], ['itx', 'ITX'], ['psu', 'PSU'],
  ['nas', 'NAS'], ['poe', 'PoE'], ['lan', 'LAN'], ['qlc', 'QLC'],
  ['tlc', 'TLC'], ['mlc', 'MLC'], ['slc', 'SLC'], ['nand', 'NAND'],
  ['emmc', 'eMMC'], ['sdxc', 'SDXC'], ['sdhc', 'SDHC'], ['awg', 'AWG'],
  ['pwm', 'PWM'], ['gpio', 'GPIO'], ['uart', 'UART'], ['kvm', 'KVM'],
  ['ups', 'UPS'], ['oem', 'OEM'], ['mhz', 'MHz'], ['ghz', 'GHz'],
  ['rpm', 'RPM'], ['wifi', 'WiFi'], ['gbps', 'GBps'], ['mbps', 'MBps'],
  ['tb', 'TB'], ['gb', 'GB'], ['mb', 'MB'],
  // PCIe lane widths are written lowercase, and the generic rule would
  // capitalise them: "Gen 4 X4" for "Gen 4 x4". A bounded set -- there
  // are only these five -- and no collision with a dimension like
  // "10x14", which carries digits on both sides of the x.
  ['x1', 'x1'], ['x2', 'x2'], ['x4', 'x4'], ['x8', 'x8'], ['x16', 'x16']
])

function fromMicroCenterUrl(urlObj: URL): ExtractedProduct | null {
  const match = MICRO_CENTER_PRODUCT.exec(urlObj.pathname)
  if (!match) return null

  // Deliberately *not* titleFromHardwareSlug. That rebuilder exists for stores
  // which hyphenate a decimal -- Menards writes 1-1-2-in for an inch and a
  // half -- whereas Micro Center simply drops the point, so "SATA 3.0 6 GBps"
  // arrives as "sata-30-6-gbps". Run through it, the 30 pairs with the 6 and
  // the title claims "30.6 GBps", a figure the product does not have.
  // Inventing a number is worse than leaving the URL's own spacing alone.
  const title = capitalizeTitle(
    match[2]!.split('-').filter(Boolean).join(' '),
    MICRO_CENTER_TERMS
  ).trim()
  if (!title) return null

  return {
    title,
    description: null,
    price: null,
    currency: 'USD',
    sku: match[1]!,
    variantId: null,
    variantTitle: null,
    variants: []
  }
}

const URL_ONLY_VENDORS: Array<{
  domain: string
  parse: (urlObj: URL) => ExtractedProduct | null
  // Whether refusing a URL means "this is not a product page" rather than
  // merely "this parser cannot read it". Only true where the URL grammar
  // genuinely tells the two apart, which is a much stronger claim than being
  // able to parse the usual shape -- see the note at the check itself.
  gatesProducts?: boolean
}> = [
  { domain: 'onlinemetals.com', parse: fromOnlineMetalsUrl },
  { domain: 'mcmaster.com', parse: fromMcMasterUrl },
  { domain: 'digikey.com', parse: fromDigiKeyUrl },
  // Canadian teams order from the .ca storefront; same URL shapes.
  { domain: 'digikey.ca', parse: fromDigiKeyUrl },
  { domain: 'studica.com', parse: fromStudicaUrl },
  { domain: 'vexrobotics.com', parse: fromVexUrl, gatesProducts: true },
  { domain: 'lowes.com', parse: fromLowesUrl },
  { domain: 'homedepot.com', parse: fromHomeDepotUrl },
  // No FRC_VENDORS entry needed: the host fallback already yields "Menards".
  { domain: 'menards.com', parse: fromMenardsUrl },
  { domain: 'harborfreight.com', parse: fromHarborFreightUrl },
  { domain: 'microcenter.com', parse: fromMicroCenterUrl }
]

// ---- Amazon --------------------------------------------------------------

// Amazon's meta tags describe the storefront, not the product: <meta
// name="title"> reads "Amazon.com: {name} : {category}" and there's no price
// tag at all. The real title and price are in the DOM, so read those instead
// of letting the generic OpenGraph fallback pick up the wrapped version.

export function isAmazonHost(hostname: string): boolean {
  return /(^|\.)amazon\.[a-z]{2,3}(\.[a-z]{2})?$/i.test(hostname)
}

// Peel the storefront prefix and trailing category breadcrumb off a title.
// Only used when the page didn't give us the clean #productTitle.
export function cleanAmazonTitle(title: string): string {
  const withoutStore = title.replace(/^\s*amazon[^:]*:\s*/i, '')
  // "{name} : {category}" — product names use ", " or ": ", rarely " : ".
  const breadcrumb = withoutStore.lastIndexOf(' : ')
  const name = breadcrumb > 0 ? withoutStore.slice(0, breadcrumb) : withoutStore
  return name.trim()
}

// The ASIN is Amazon's part number, and it's in the URL.
const AMAZON_ASIN = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i

function amazonAsin(urlObj: URL): string | null {
  return AMAZON_ASIN.exec(urlObj.pathname)?.[1]?.toUpperCase() ?? null
}

// The ASIN out of a product link, for callers holding a URL string.
export function amazonAsinFromUrl(url: string): string | null {
  try {
    return amazonAsin(new URL(url))
  } catch {
    return null
  }
}

function tryAmazon(
  document: ParsedDoc,
  urlObj: URL
): ExtractedProduct | null {
  const rawTitle = getMeta(document, [
    '#productTitle',
    'meta[property="og:title"]',
    'meta[name="title"]'
  ])
  if (!rawTitle) return null
  const title = cleanAmazonTitle(rawTitle)
  if (!title) return null

  const price = parsePrice(
    getMeta(document, [
      '#corePrice_feature_div .a-offscreen',
      '#corePriceDisplay_desktop_feature_div .a-offscreen',
      '#apex_desktop .a-offscreen',
      '.a-price .a-offscreen',
      '#priceblock_ourprice',
      '#priceblock_dealprice'
    ])
  )

  // The meta description repeats the wrapped title; the bullet list is the
  // only place with anything worth putting in Notes.
  const bullets = cleanText(
    getMeta(document, ['#feature-bullets'])?.replace(/^\s*About this item\s*/i, '')
  )

  return {
    title,
    description: bullets,
    price,
    currency: 'USD',
    sku: amazonAsin(urlObj),
    variantId: null,
    variantTitle: null,
    variants: []
  }
}

// ---- Orchestration -------------------------------------------------------

export async function extractPart(
  url: string,
  signal?: AbortSignal,
  // HTML the caller already has. A few vendors answer this process with a bot
  // challenge and a real browser with the page, so the route renders those
  // through vendord and passes the result in here -- where it goes through
  // exactly the same strategies as any other page. The browser buys access,
  // not a parser, and a render that failed simply passes nothing.
  prefetchedHtml?: string | null
): Promise<ExtractionResult> {
  const urlObj = new URL(url)
  const hostname = urlObj.hostname
  const mappedVendor = friendlyVendorName(hostname)
  const vendorName = mappedVendor ?? titleCaseHost(hostname)

  // 0. Vendors whose pages a server can't read. Fetching them either fails or
  // returns a shell we'd misread as real details, so the URL is the only
  // source — and checking it costs no request.
  //
  // Skipped when the caller has already rendered the page: a real page beats a
  // name guessed from a slug, so Studica is both URL-only *and* browser-
  // rendered -- it uses the render when there is one and the URL when the
  // browser could not produce one. The guess is still there at the end of this
  // function for that case.
  const urlOnly = URL_ONLY_VENDORS.find(v => hostMatches(hostname, v.domain))
  const fromUrl = urlOnly?.parse(urlObj) ?? null

  // Where a vendor's URL grammar genuinely distinguishes a product from a
  // category, that stays authoritative even once the page can be read. VEX is
  // the case: their slug pages (/wheels.html, /gears.html) carry the same
  // .html suffix as a part number and are marked up as a Product -- "Wheels",
  // $9.99, with nothing orderable behind it -- so rendering one and trusting
  // its JSON-LD turned a category into a line item.
  //
  // It is opt-in because the general version of this rule was wrong. Most of
  // these parsers exist to salvage a name from a URL when the page cannot be
  // read, not to rule on what a product is, and their grammars are only as
  // complete as the URLs I happened to see: Online Metals' marketplace ids
  // (/pid/mp-00065192) did not match a rule written for numeric ones, and a
  // blanket gate turned an unanticipated id into "not a product" for a page
  // sitting there perfectly readable.
  if (urlOnly?.gatesProducts && !fromUrl) {
    return { url, hostname, vendorName, source: 'none', product: null }
  }
  if (urlOnly && !prefetchedHtml) {
    return {
      url,
      hostname,
      vendorName,
      source: fromUrl ? 'url' : 'none',
      product: fromUrl
    }
  }

  // 1. Shopify JSON — richest data, so try it first for any /products/ URL.
  const shopify = await tryShopify(urlObj, signal)
  if (shopify) {
    return {
      url,
      hostname,
      vendorName: mappedVendor ?? shopify.vendor ?? titleCaseHost(hostname),
      source: 'shopify',
      product: shopify.product
    }
  }

  // Fetch the page once for the HTML-based strategies, unless the caller
  // already rendered it. A failed render passes nothing and the ordinary
  // fetch still runs, so the result is what it was before.
  let html: string | null = prefetchedHtml ?? null
  if (html === null) {
    try {
      const res = await fetchWithUa(
        url,
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        signal
      )
      if (res.ok) html = await res.text()
    } catch {
      html = null
    }
  }

  if (html) {
    const document = parseDocument(html)
    const ogDescription = () =>
      cleanText(
        getMeta(document, [
          'meta[property="og:description"]',
          'meta[name="description"]',
          'meta[name="twitter:description"]'
        ])
      )
    const ogVendor = () =>
      getMeta(document, ['meta[property="og:site_name"]'])
    // A Shopify ProductGroup carries no image of its own, and og:image is the
    // same picture the page leads with.
    const ogImage = () =>
      getMeta(document, [
        'meta[property="og:image"]',
        'meta[name="twitter:image"]'
      ])

    // 1.5 BrickLink: a marketplace with no JSON-LD, no OpenGraph, and a title
    // naming the shop rather than the item, so read its item row directly
    // before the generic fallbacks get a chance to name a part after a store.
    if (isBrickLinkHost(hostname)) {
      const found = fromBrickLink(document, urlObj)
      return found
        ? {
            url,
            hostname,
            vendorName: found.vendorName,
            source: 'html',
            product: found.product
          }
        : { url, hostname, vendorName: 'BrickLink', source: 'none', product: null }
    }

    // 2. JSON-LD Product, or the ProductGroup that stands in for one.
    const products: Record<string, unknown>[] = []
    const productGroups: Record<string, unknown>[] = []
    // Indexed across every block, not just the one the Product came from --
    // the node a reference names is routinely in a different <script>.
    const nodesById = new Map<string, Record<string, unknown>>()
    for (const script of Array.from(
      document.querySelectorAll('script[type="application/ld+json"]')
    )) {
      const raw = script.textContent
      if (!raw) continue
      try {
        const parsed = JSON.parse(raw)
        collectProducts(parsed, products, productGroups)
        collectById(parsed, nodesById)
      } catch {
        // Ignore malformed JSON-LD blocks.
      }
    }
    const node = products[0] ?? productGroups[0]
    const name = node ? cleanName(node.name) : null
    if (node && name) {
      const groupVariants = variantsFromProductGroup(node, name, urlObj)
      // Honor ?variant= / ?id= deep links; otherwise the first variant, which
      // is the one the page itself opens on.
      const requested
        = urlObj.searchParams.get('variant') ?? urlObj.searchParams.get('id')
      const selected
        = (requested && groupVariants.find(v => v.id === requested))
        || groupVariants[0]
        || null

      const aggregateVariants = variantsFromAggregateOffer(
        resolveRef(node.offers, nodesById),
        urlObj
      )
      // Honour ?variant= against the offer list too, so a deep link to a
      // particular cut length prices as that length rather than the cheapest.
      const requestedOffer
        = urlObj.searchParams.get('variant')
        ?? urlObj.searchParams.get('id')
      const chosenOffer = requestedOffer
        ? aggregateVariants.find(v => v.id === requestedOffer)
        : undefined

      const own = priceFromOffers(resolveRef(node.offers, nodesById))
      // A group has no offers of its own; the chosen variant is the price.
      const price = chosenOffer?.price ?? own.price ?? selected?.price ?? null
      const currency = own.currency

      let variants: ExtractedVariant[]
      if (groupVariants.length > 0) {
        // Only surface a picker when there's a real choice to make -- the same
        // rule the Shopify path applies.
        const hasChoice
          = groupVariants.length > 1
          || groupVariants.some(variant => variant.title !== name)
        variants = hasChoice ? groupVariants : []
      } else if (aggregateVariants.length > 0) {
        variants = aggregateVariants
      } else if (isSailriteHost(hostname)) {
        // Sailrite prices per colour, length and width, and the page shows
        // only the base article. See server/utils/sailrite.ts -- one page
        // fetch per combination, run together, so the picker carries real
        // prices.
        variants = await fetchSailriteVariants(urlObj, html, USER_AGENT, signal)
      } else {
        variants = []
      }

      // `name` stays as the markup gave it, because the ProductGroup variant
      // titles are matched against it; only what gets shown is swapped.
      const sku = asString(node.sku) ?? asString(node.mpn) ?? selected?.sku
      // Only when the markup's name is *nothing but* the SKU. Any vendor who
      // named their product properly keeps that name: reaching for the page
      // title regardless appended site branding to six of them -- "… - Ace
      // Hardware", "… - REV Robotics" -- and put Rock West's part number in
      // front of its own name.
      const nameIsSku
        = !!sku && !!name && name.toLowerCase() === sku.toLowerCase()
      const displayTitle
        = (nameIsSku
          ? titleBesideSku(
              cleanName(document.querySelector('title')?.textContent),
              sku!
            )
          : null)
        ?? name

      // Read out of the page for vendors whose JSON-LD leaves them out.
      const supplement = isPowerwerxHost(hostname)
        ? powerwerxFields(document)
        : null

      const imageNode = resolveRef(node.image, nodesById)
      const priceBreaks = isRockWestHost(hostname)
        ? rockWestPriceBreaks(html)
        : []
      return {
        url,
        hostname,
        vendorName:
          mappedVendor
          ?? brandName(node.brand)
          ?? ogVendor()
          ?? titleCaseHost(hostname),
        source: 'json-ld',
        product: {
          title: displayTitle,
          description: cleanText(node.description) ?? ogDescription(),
          price: supplement?.price ?? price,
          currency: currency ?? 'USD',
          sku: chosenOffer?.sku ?? sku ?? supplement?.sku ?? null,
          image: absoluteUrl(
            // schema.org allows a bare URL, an array, or an ImageObject.
            asString(
              Array.isArray(imageNode) ? imageNode[0] : imageNode
            ) ?? asString(
              (imageNode as Record<string, unknown> | undefined)?.url
            ) ?? ogImage(),
            urlObj
          ),
          // A ProductGroup names the platform's variant ids; the other
          // fallback sources expose none.
          variantId: selected?.id || null,
          variantTitle:
            selected && selected.title !== name ? selected.title : null,
          variants: supplement?.variants.length ? supplement.variants : variants,
          ...(priceBreaks.length > 0 ? { priceBreaks } : {})
        }
      }
    }

    // AutomationDirect marks up every product with JSON-LD, so a page that
    // reached here is one of their category listings -- and the OpenGraph
    // fallback would turn it into a line item named "Productivity1000 DC and
    // Combo I/O Modules" with no price and nothing orderable behind it, the
    // same trap WCP's configurator pages and VEX's slug pages set. Their
    // category and product URLs are not reliably told apart by shape, but the
    // markup separates them cleanly.
    if (isAutomationDirectHost(hostname)) {
      return { url, hostname, vendorName, source: 'none', product: null }
    }

    // 2.5 Amazon: read the DOM before the meta tags, which would otherwise
    // hand us a storefront-wrapped title and no price.
    if (isAmazonHost(hostname)) {
      const product = tryAmazon(document, urlObj)
      if (product) {
        return {
          url,
          hostname,
          vendorName: mappedVendor ?? titleCaseHost(hostname),
          source: 'amazon',
          product
        }
      }
    }

    // 2.6 Seattle Fabrics: microdata rather than JSON-LD, so the OpenGraph
    // fallback below already reads their price and image correctly. What it
    // cannot do is name the product -- og:title is the SEO title -- or find
    // the options, which are in a script block.
    if (isSeattleFabricsHost(hostname)) {
      // Their URL grammar tells a product from a category outright --
      // _p_{id}.html against _c_{id}.html -- and a category page carries an
      // <h1> and no price, so without this check "500 D. CORDURA(R)" becomes a
      // priceless line item with nothing orderable behind it. The same trap
      // VEX's slug pages and WCP's configurator pages set.
      const productId = SEATTLE_FABRICS_PRODUCT.exec(urlObj.pathname)?.[1]
      if (!productId) {
        return { url, hostname, vendorName, source: 'none', product: null }
      }
      const basePrice = parsePrice(
        getMeta(document, ['meta[itemprop="price"]', '[itemprop="price"]'])
      )
      const fields = seattleFabricsFields(
        document, html, productId, basePrice
      )
      const ogTitle = getMeta(document, [
        'meta[property="og:title"]',
        'meta[name="title"]',
        'h1'
      ])
      const title = fields.title ?? ogTitle
      if (title) {
        return {
          url,
          hostname,
          vendorName: mappedVendor ?? ogVendor() ?? titleCaseHost(hostname),
          source: 'html',
          product: {
            title,
            description: ogDescription(),
            price: basePrice,
            currency: getMeta(document, [
              'meta[itemprop="priceCurrency"]'
            ]) ?? 'USD',
            sku: fields.sku,
            image: absoluteUrl(
              getMeta(document, ['meta[property="og:image"]']),
              urlObj
            ),
            variantId: null,
            variantTitle: null,
            variants: fields.variants
          }
        }
      }
    }

    // 3. OpenGraph / meta fallback.
    const title = getMeta(document, [
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
      'meta[name="title"]',
      'h1'
    ])
    if (title) {
      const currency = getMeta(document, [
        'meta[property="product:price:currency"]',
        'meta[itemprop="priceCurrency"]'
      ])
      return {
        url,
        hostname,
        vendorName: mappedVendor ?? ogVendor() ?? titleCaseHost(hostname),
        source: 'opengraph',
        product: {
          title,
          description: ogDescription(),
          price: parsePrice(
            getMeta(document, [
              'meta[property="product:price:amount"]',
              'meta[property="og:price:amount"]',
              'meta[itemprop="price"]',
              '[itemprop="price"]'
            ])
          ),
          currency: currency ?? 'USD',
          sku: getMeta(document, [
            'meta[itemprop="sku"]',
            '[itemprop="sku"]'
          ]),
          image: absoluteUrl(
            getMeta(document, [
              'meta[property="og:image"]',
              'meta[name="twitter:image"]',
              'meta[itemprop="image"]'
            ]),
            urlObj
          ),
          // Neither fallback source exposes platform variant ids.
          variantId: null,
          variantTitle: null,
          variants: []
        }
      }
    }
  }

  // A rendered page that turned out to hold nothing readable still leaves the
  // URL, for a vendor that has a parser for it.
  if (fromUrl) {
    return { url, hostname, vendorName, source: 'url', product: fromUrl }
  }

  // Nothing usable — let the caller fall back to the external scraper.
  return {
    url,
    hostname,
    vendorName: mappedVendor ?? titleCaseHost(hostname),
    source: 'none',
    product: null
  }
}
