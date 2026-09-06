import { chromium } from "playwright";
import type { Browser } from "playwright";

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

// Cloudflare's managed-challenge interstitial, and Imperva's.
const CHALLENGE_MARKERS = [
  "Just a moment",
  "Attention Required",
  "Checking your browser",
  "Pardon Our Interruption",
  "cf-browser-verification"
];

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

export async function renderPage(url: string): Promise<RenderResult> {
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
      let html = await page.content();
      let challengeMs: number | null = null;
      if (isChallenge(html)) {
        while (Date.now() - start < CHALLENGE_TIMEOUT_MS) {
          await page.waitForTimeout(CHALLENGE_POLL_MS);
          html = await page.content();
          if (!isChallenge(html)) {
            challengeMs = Date.now() - start;
            break;
          }
        }
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
