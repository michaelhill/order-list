import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";

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
//
// **The browser is kept alive between requests.** Launching one costs 250ms to
// a second locally and more on the droplet, against roughly a second of actual
// navigation -- so a cold launch per lookup was most of the wall time. It is
// closed again after a spell of inactivity, so an idle box holds nothing.

const NAV_TIMEOUT_MS = 15_000;
const CHALLENGE_TIMEOUT_MS = 8_000;
const CHALLENGE_POLL_MS = 100;

// Long enough to cover a whole ordering session -- a team adds parts over
// half an hour, and a ten-minute window made them pay for a relaunch in the
// middle of it -- while still handing the memory back on a box nobody is
// using. Chromium is roughly 200-300 MB resident against the droplet's
// ~1.1 GB free, which is the deliberate trade: constant memory for a warm
// browser.
const IDLE_SHUTDOWN_MS = 30 * 60 * 1000;

// Chromium's own overheads that a server does not need. Deliberately *not*
// --no-sandbox or --disable-blink-features=AutomationControlled: the first is
// a well-known automation tell and the second edits the fingerprint, and this
// renderer's whole premise is that an unmodified browser is enough.
const LAUNCH_ARGS = [
  "--disable-dev-shm-usage",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-breakpad",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-sync",
  "--metrics-recording-only",
  "--mute-audio",
  "--no-first-run"
];

// Subresources that never affect what gets read out of the DOM. Scripts, XHR
// and fetch are emphatically not here: the challenges are scripts, and
// BrickLink's product arrives over XHR after the page shell. Blocking an image
// does not remove its `src` from the markup, so image URLs still extract.
const BLOCKED_RESOURCES = new Set(["image", "media", "font", "stylesheet"]);

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
  // How long the challenge took to clear, for the log line -- it is tens of
  // milliseconds on a warm edge and worth noticing if it ever is not.
  challengeMs: number | null;
  // Whether this render paid for a browser launch, so the effect of keeping
  // one alive is visible in the log rather than merely asserted.
  launched: boolean;
}

let browser: Browser | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const stale = browser;
    browser = null;
    idleTimer = null;
    if (stale) {
      stale.close().catch(() => {});
      console.log("Closed the idle render browser");
    }
  }, IDLE_SHUTDOWN_MS);
  // Never hold the process open on this timer alone.
  idleTimer.unref?.();
}

async function getBrowser(): Promise<{ browser: Browser; launched: boolean }> {
  // isConnected catches a browser that crashed or was killed underneath us,
  // which on a 2 GB box is a question of when rather than whether.
  if (browser?.isConnected()) return { browser, launched: false };
  const started = await chromium.launch({
    headless: false,
    args: LAUNCH_ARGS
  });
  started.on("disconnected", () => {
    if (browser === started) browser = null;
  });
  browser = started;
  return { browser: started, launched: true };
}

// One page at a time. Two concurrent renders would double the memory on a box
// that has about a gigabyte spare, and these lookups are rare enough that
// serialising them costs nothing.
let inFlight: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = inFlight.then(work, work);
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
    // A fresh context per render, so one vendor's cookies and storage never
    // reach another's page. It costs a few milliseconds against the hundreds
    // that reusing the browser saves.
    let context: BrowserContext | null = null;
    let launched = false;
    try {
      const acquired = await getBrowser();
      launched = acquired.launched;
      context = await acquired.browser.newContext({
        viewport: { width: 1280, height: 900 }
      });
      const page = await context.newPage();
      await page.route("**/*", (route) => {
        return BLOCKED_RESOURCES.has(route.request().resourceType())
          ? route.abort()
          : route.continue();
      });

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
        challengeMs,
        launched
      };
    } finally {
      // The context always goes, even on a navigation timeout -- a leaked one
      // holds a renderer process. The browser itself stays for the next
      // request and is closed by the idle timer instead.
      await context?.close().catch(() => {});
      scheduleIdleShutdown();
    }
  });
}
