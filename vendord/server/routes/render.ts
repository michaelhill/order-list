import { eventHandler, getQuery, createError } from "h3";
import { renderPage } from "../utils/browser";

// GET /render?url=... -> the page's HTML after a real browser has loaded it.
//
// Only the app calls this, over localhost, and only for the hosts listed in
// server/utils/vendord.ts. It is not a general-purpose fetcher: the URL is
// checked the same way the app's own extractor checks one, so a caller cannot
// point it at an internal address.
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0" || host === "::1" || host === "[::1]") return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

export default eventHandler(async (event) => {
  const query = getQuery(event);
  const raw = query.url;
  const url = typeof raw === "string" ? raw.trim() : "";
  // Optional: a selector to wait for once the challenge clears, for the
  // storefronts that load their product over XHR.
  const waitForRaw = query.waitFor;
  const waitFor
    = typeof waitForRaw === "string" && waitForRaw.trim().length > 0
      ? waitForRaw.trim().slice(0, 120)
      : undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw createError({ statusCode: 400, statusMessage: "Invalid url" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw createError({ statusCode: 400, statusMessage: "Unsupported scheme" });
  }
  if (isBlockedHost(parsed.hostname)) {
    throw createError({ statusCode: 400, statusMessage: "Host not allowed" });
  }

  const startedAt = Date.now();
  try {
    const result = await renderPage(parsed.toString(), waitFor);
    console.log(
      `Rendered ${parsed.hostname} in ${Date.now() - startedAt}ms`
      + ` (${result.launched ? "cold launch" : "warm browser"}): `
      + `${result.html.length} bytes, status ${result.status}`
      + (result.challengeMs === null
        ? ""
        : `, challenge cleared in ${result.challengeMs}ms`)
    );
    return result;
  } catch (error) {
    // No display, no Chromium, or the page never loaded. The caller falls back
    // to its ordinary fetch, so this is a bad gateway rather than a crash.
    console.error(`Browser render failed for ${parsed.hostname}:`, error);
    throw createError({
      statusCode: 502,
      statusMessage: "Browser render failed"
    });
  }
});
