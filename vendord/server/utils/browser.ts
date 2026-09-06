import { chromium } from "playwright";
import type { Browser, Page } from "playwright";

// Rendering a page in a real browser, for the handful of vendors whose
// storefront answers a plain fetch with a bot challenge and a browser with the
// actual page.
//
// It lives in vendord rather than in the app deliberately. Chromium is the
// heaviest thing on a 1 vCPU / 2 GB droplet by some way, and vendord is the
// process that can afford to die: if the browser exhausts memory it takes the
// scraper with it, the app keeps serving, and the extractor falls back to what
// it did before.
//
// **Headed, under xvfb.** Headless Chromium is refused by these challenges --
// measured against Powerwerx, headless gets 403 and headed gets the page -- so
// the deploy installs xvfb and PM2 runs vendord inside it. Without a display
// the launch below throws, which the route reports as a failed render and the
// caller treats as "could not read", the same as a challenge.

const NAV_TIMEOUT_MS = 15_000;
const CHALLENGE_TIMEOUT_MS = 8_000;
const CHALLENGE_POLL_MS = 100;

// Cloudflare's managed-challenge interstitial, Imperva's, and AWS WAF's --
// the last of which announces itself only through the globals its script sets,
// since its page has an empty <title> and no visible text at all.
const CHALLENGE_MARKERS = [
  "Just a moment",
  "Attention Required",
  "Checking your browser",
  "Pardon Our Interruption",
  "cf-browser-verification",
  "awsWafCookieDomainList",
  "gokuProps"
];

// How long to keep waiting for a selector once the challenge is out of the
// way. Only needed by single-page storefronts, where clearing the wall reveals
// a shell and the product arrives over XHR afterwards.
const SELECTOR_TIMEOUT_MS = 12_000;

export interface RenderResult {
  html: string;
  finalUrl: string;
  status: number | null;
  // How long the challenge took to clear, for the log line -- it is 25-30ms
  // on a warm edge and worth noticing if it ever is not.
  challengeMs: number | null;
}

// One browser at a time. Two concurrent launches would double the memory on a
// box that has about a gigabyte spare, and these lookups are rare enough that
// serialising them costs nothing.
let inFlight: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = inFlight.then(work, work);
  // Keep the chain alive whether or not this link rejected.
  inFlight = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

function isChallenge(html: string): boolean {
  return CHALLENGE_MARKERS.some(marker => html.includes(marker));
}

// A challenge that clears by reloading -- AWS WAF's does -- will be mid-flight
// when the poll below asks for the content, and Playwright refuses with
// "Unable to retrieve content because the page is navigating". That is a
// transient state, not a failure, so treat it as "nothing yet" and ask again
// on the next tick rather than letting it abort the render.
async function contentOrNull(page: Page): Promise<string | null> {
  try {
    return await page.content();
  } catch {
    return null;
  }
}

export async function renderPage(
  url: string,
  waitForSelector?: string
): Promise<RenderResult> {
  return serialize(async () => {
    let browser: Browser | null = null;
    try {
      browser = await chromium.launch({ headless: false });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 }
      });
      const page = await context.newPage();
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS
      });

      // The challenge replaces itself once solved, so poll rather than sleep a
      // fixed amount: it clears in tens of milliseconds when it clears at all.
      const start = Date.now();
      let html = (await contentOrNull(page)) ?? "";
      let challengeMs: number | null = null;
      if (html === "" || isChallenge(html)) {
        while (Date.now() - start < CHALLENGE_TIMEOUT_MS) {
          await page.waitForTimeout(CHALLENGE_POLL_MS);
          const next = await contentOrNull(page);
          if (next === null) continue;
          html = next;
          if (!isChallenge(html)) {
            challengeMs = Date.now() - start;
            break;
          }
        }
      }

      // A single-page storefront answers the challenge with a shell and loads
      // the product over XHR, so the caller can name something to wait for.
      // Missing it is not an error: the page is returned as it stands and the
      // extractor decides whether it found anything.
      if (waitForSelector) {
        await page
          .waitForSelector(waitForSelector, { timeout: SELECTOR_TIMEOUT_MS })
          .catch(() => {});
        html = (await contentOrNull(page)) ?? html;
      }

      return {
        html,
        finalUrl: page.url(),
        status: response?.status() ?? null,
        challengeMs
      };
    } finally {
      // Always, including on a navigation timeout: a leaked Chromium is the
      // one failure this box cannot absorb.
      await browser?.close().catch(() => {});
    }
  });
}
