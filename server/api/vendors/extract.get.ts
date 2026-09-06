import { z } from 'zod'
import {
  digiKeyPartFromUrl,
  extractPart,
  isBlockedHost
} from '../../utils/part-extractor'
import { fetchDigiKeyProduct, isDigiKeyConfigured } from '../../utils/digikey'
import {
  fetchRenderedPage,
  fetchVendordProduct,
  shouldDelegateToScraper,
  shouldRenderInBrowser,
  toExtractionResult
} from '../../utils/vendord'
import { fetchOptionGroups, isWcpHost } from '../../utils/wcp-dpo'
import { requireOrganizationContext } from '../../utils/session'

// isBlockedHost lives with the extractor now: this validates the URL the user
// pasted, and the extractor's redirect follower re-checks every hop it makes.

export default defineEventHandler(async (event) => {
  // Only authenticated org members may trigger outbound fetches.
  await requireOrganizationContext(event)

  const { url } = await getValidatedQuery(event, data =>
    z
      .object({
        url: z
          .string()
          .trim()
          .url('Enter a valid URL')
          .refine(
            (value) => {
              try {
                const parsed = new URL(value)
                return (
                  (parsed.protocol === 'http:'
                    || parsed.protocol === 'https:')
                  && !isBlockedHost(parsed.hostname)
                )
              } catch {
                return false
              }
            },
            { message: 'URL is not allowed' }
          )
      })
      .parse(data)
  )

  const controller = new AbortController()
  // A browser render is inherently slower than a fetch: measured on the
  // droplet, launching Chromium and loading a Powerwerx product page takes
  // 6.3s, which leaves no room inside the 9s that suffices for everything
  // else. Aborting mid-render would fail the whole request with a 502 rather
  // than falling back, so those hosts get a longer budget.
  const needsBrowser = shouldRenderInBrowser(new URL(url).hostname)
  const timeout = setTimeout(
    () => controller.abort(),
    needsBrowser ? 25_000 : 9_000
  )
  try {
    // DigiKey publishes an API, which beats anything readable off the page —
    // and their pages refuse Workers anyway.
    const digiKeyPart = digiKeyPartFromUrl(url)
    if (digiKeyPart && isDigiKeyConfigured()) {
      const product = await fetchDigiKeyProduct(
        digiKeyPart.mpn,
        controller.signal
      )
      if (product) {
        return {
          url,
          hostname: new URL(url).hostname,
          vendorName: 'DigiKey',
          source: 'digikey' as const,
          product
        }
      }
    }

    // Some vendors refuse requests from the Worker outright, so go through the
    // scraper service first rather than burning the timeout on a refusal. If
    // it's down or blocked in turn, extractPart still has its own fallbacks.
    const { hostname } = new URL(url)
    if (shouldDelegateToScraper(hostname)) {
      const scraped = await fetchVendordProduct(url, controller.signal)
      const mapped = scraped ? toExtractionResult(url, hostname, scraped) : null
      if (mapped) return mapped
    }

    // A few vendors answer this process with a bot challenge and a real
    // browser with the page. vendord renders those in headed Chromium and
    // hands back HTML, which extractPart then reads with its ordinary
    // strategies. A render that fails for any reason -- no display, no
    // Chromium, challenge never cleared, vendord down -- passes nothing, and
    // extractPart falls back to fetching the page itself exactly as before.
    const rendered = needsBrowser
      ? await fetchRenderedPage(url, controller.signal)
      : null

    const result = await extractPart(url, controller.signal, rendered?.html)

    // WCP's configurator pages are indistinguishable from ordinary products
    // through Shopify's API — one "Default Title" variant, a real-looking
    // "from" price — so reading one yields a category ("Imperial Bearings")
    // that looks like a successful extraction. Ask DPO for the parts it
    // actually offers.
    //
    // A genuine WCP part carries its own SKU, so only a SKU-less product is
    // a candidate. That keeps the common case — a link straight to
    // /products/wcp-2059 — at zero extra requests.
    if (
      result.source === 'shopify'
      && isWcpHost(result.hostname)
      && result.product
      && !result.product.sku
      && result.product.productId
    ) {
      const optionGroups = await fetchOptionGroups(
        result.product.productId,
        result.product.variantId,
        controller.signal
      )
      if (optionGroups) return { ...result, optionGroups }
    }

    return result
  } catch {
    throw createError({
      statusCode: 502,
      statusMessage: 'Could not reach the product page'
    })
  } finally {
    clearTimeout(timeout)
  }
})
