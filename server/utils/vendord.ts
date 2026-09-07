// Talking to the `vendord` scraper service.
//
// vendord runs as its own process alongside the app, listening on localhost.
// It exists because some vendors refuse requests from the app's own runtime,
// so those product lookups get delegated to it instead.
//
// VENDORD_URL overrides where it lives; the default matches running it on the
// same droplet.

import { hostMatches, vendorDisplayName } from './part-extractor'
import type {
  ExtractedVariant,
  ExtractionResult
} from './part-extractor'

const VENDORD_ORIGIN = process.env.VENDORD_URL
  ?? (import.meta.dev ? 'http://localhost:3001' : 'http://localhost:3434')

// Vendors that sit behind a bot challenge, so a direct fetch from the Worker
// only ever returns an interstitial. These go to vendord first instead of
// wasting a round trip on a request we know will be refused.
// Online Metals used to be here and is browser-rendered now, which reads its
// page properly where the scraper hop did not.
//
// Swyft is the case this mechanism was kept for. Their storefront is headless
// Shopify on Next.js: the product lives in an RSC flight payload, which the
// extractor cannot read and vendord's swyft.ts can. Left to itself the
// extractor got as far as OpenGraph -- a title, no price, no variants -- and
// because that *is* a product, the slideover applied it and returned without
// ever consulting the scraper. A part arrived named, priced blank, with no
// variant picker and no warning that anything had been missed.
const DELEGATED_HOSTS: string[] = ['swyftrobotics.com']

export function shouldDelegateToScraper(hostname: string): boolean {
  return DELEGATED_HOSTS.some(domain => hostMatches(hostname, domain))
}

// Vendors whose storefront answers a plain fetch with a bot challenge and a
// real browser with the actual page. vendord renders these in headed Chromium
// and hands back the HTML, which then goes through the ordinary extraction
// strategies -- so this list buys page *access*, not a parser.
//
// Kept deliberately short. Every entry costs a browser launch, and it only
// helps where the block is a solvable challenge: Lowe's and Home Depot answer
// a flat deny that a browser does not clear either, so adding them would spend
// the memory for nothing.
//
// VEX is here despite the older note saying a headed browser is "re-blocked
// after roughly one navigation" -- which turns out not to describe this usage.
// A fresh browser is launched and closed per lookup, so every request is a
// first navigation: four consecutive product pages rendered clean, none
// blocked. It is the same reason their entry stays in URL_ONLY_VENDORS as
// well, as the fallback for a render that does not happen.
//
// The selector, where present, is something to wait for once the challenge
// clears: a single-page storefront answers with a shell and fetches the
// product over XHR afterwards, so returning at that point would hand back an
// empty page. Only BrickLink needs it; the rest are server-rendered.
//
// `blockScripts` drops the vendor's own JavaScript, which is most of a render's
// cost where the product data is already in the server-rendered HTML. Verified
// per host by extracting with and without and comparing the result, not
// assumed: Online Metals, Powerwerx and VEX come back identical -- same price,
// same variant counts -- at a third to a fifth of the time. BrickLink does not
// and must not have it: their product arrives over XHR after the shell, so
// without scripts the render yields nothing at all.
//
// Studica is unset because it has never been verified end to end at all; there
// is no product URL on file for it.
const BROWSER_RENDER_HOSTS: Array<{
  domain: string
  waitFor?: string
  blockScripts?: boolean
}> = [
  { domain: 'powerwerx.com', blockScripts: true },
  { domain: 'studica.com' },
  { domain: 'vexrobotics.com', blockScripts: true },
  { domain: 'bricklink.com', waitFor: '.item.table-row' },
  { domain: 'onlinemetals.com', blockScripts: true }
]

// Seattle Fabrics is deliberately NOT in that list, and the reason is worth
// keeping because their pages read perfectly in a browser -- from the right
// address. Cloudflare serves them to a residential IP on the first navigation
// every time, and refuses the droplet outright: measured on the production
// box, the challenge holds for a full 60 seconds without the page even
// changing size. That is a flat refusal, not a slow solve, so no timeout gets
// past it. The same box renders VEX and Powerwerx, both also behind
// Cloudflare, without trouble.
//
// Listing them anyway would cost every production lookup ~17s of waiting
// (8s challenge poll, then the retry with scripts allowed) before falling back
// to exactly what the URL parser returns instantly. Worse, it made dev and
// production disagree -- which is how this shipped: the whole vendor was
// validated over a home connection and never once from the droplet.
//
// To re-enable if that address is ever allowlisted, add
// `{ domain: 'seattlefabrics.com', blockScripts: true }` above and restore the
// 'seattle-fabrics' branch in cart-link.ts. Everything that reads their
// options is still there in server/utils/seattle-fabrics.ts.

export function shouldRenderInBrowser(hostname: string): boolean {
  return BROWSER_RENDER_HOSTS.some(v => hostMatches(hostname, v.domain))
}

function renderOptionsFor(
  hostname: string
): { waitFor?: string, blockScripts?: boolean } {
  return BROWSER_RENDER_HOSTS.find(v => hostMatches(hostname, v.domain)) ?? {}
}

export interface RenderedPage {
  html: string
  finalUrl: string
  status: number | null
}

// Ask vendord to render a page. Returns null on anything at all going wrong --
// no display on the box, Chromium missing, the challenge not clearing, vendord
// down -- because every caller has a fallback and a browser that cannot launch
// must degrade to the old behaviour rather than fail the lookup.
export async function fetchRenderedPage(
  url: string,
  signal?: AbortSignal
): Promise<RenderedPage | null> {
  const target = new URL('/render', VENDORD_ORIGIN)
  target.searchParams.set('url', url)
  const { waitFor, blockScripts } = renderOptionsFor(new URL(url).hostname)
  if (waitFor) target.searchParams.set('waitFor', waitFor)
  if (blockScripts) target.searchParams.set('blockScripts', '1')

  try {
    const response = await fetch(target, {
      headers: { accept: 'application/json' },
      signal
    })
    if (!response.ok) return null
    const data = (await response.json()) as Partial<RenderedPage>
    return typeof data.html === 'string' && data.html.length > 0
      ? {
          html: data.html,
          finalUrl: data.finalUrl ?? url,
          status: data.status ?? null
        }
      : null
  } catch {
    return null
  }
}

export function vendordUrl(productUrl: string): string {
  const target = new URL(VENDORD_ORIGIN)
  target.searchParams.set('url', productUrl)
  return target.toString()
}

export interface VendordVariant {
  id: string
  title: string
  price?: number
}

export interface VendordProduct {
  title?: string
  description?: string
  image?: string
  price?: number
  currency?: string
  variants?: VendordVariant[]
}

export interface VendordResponse {
  productData?: { product?: VendordProduct | null } | null
  variantId?: string | null
  vendor?: { id: string, name: string, hostname: string, type: string } | null
}

export async function fetchVendordProduct(
  url: string,
  signal?: AbortSignal
): Promise<VendordResponse | null> {
  const target = vendordUrl(url)

  try {
    // Only what the scraper needs to look like a browser to the vendor —
    // never the caller's cookies or authorization.
    const response = await fetch(target, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
        'accept': 'application/json'
      },
      signal
    })
    if (!response.ok) return null
    return (await response.json()) as VendordResponse
  } catch {
    // Scraper down, unreachable, or blocked in turn — the caller falls back.
    return null
  }
}

// Reshape a scraper response into the same result the in-Worker extractor
// returns, so callers don't care which route the details came from.
export function toExtractionResult(
  url: string,
  hostname: string,
  response: VendordResponse
): ExtractionResult | null {
  const product = response.productData?.product
  const title = product?.title?.trim()
  if (!product || !title) return null

  // vendord writes "default" when it couldn't resolve a real variant.
  const variants: ExtractedVariant[] = (product.variants ?? [])
    .filter(variant => variant.id && variant.id !== 'default')
    .map(variant => ({
      id: variant.id,
      sku: null,
      title: variant.title?.trim() || title,
      price: variant.price ?? null
    }))

  // The scraper echoes back the ?variant= the link asked for; on sites where
  // that value is the orderable code (Online Metals' cut lengths) it's the
  // most useful thing to carry onto the order.
  const requestedVariant = response.variantId?.trim() || null
  const selected = requestedVariant
    ? variants.find(variant => variant.id === requestedVariant)
    : undefined

  return {
    url,
    hostname,
    vendorName: response.vendor?.name?.trim() || vendorDisplayName(hostname),
    source: 'scraper',
    product: {
      title,
      description: product.description?.trim() || null,
      price: selected?.price ?? product.price ?? null,
      currency: product.currency ?? 'USD',
      sku: requestedVariant,
      variantId: requestedVariant,
      variantTitle: selected?.title ?? null,
      variants: variants.length > 1 ? variants : []
    }
  }
}
