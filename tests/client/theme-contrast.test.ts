// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const stylesheets = ["styles", "library-modern", "library-health", "library-transfer-modern", "library-ux-polish", "hardcover-series"];
const css = stylesheets.map((name) => readFileSync(new NodeURL(`../../client/src/${name}.css`, import.meta.url), "utf8")).join("\n");

// JSDOM does not resolve CSS variables/light-dark. Resolve the palette only;
// selector application is left to its CSS engine. The companion browser audit
// exercises the unmodified stylesheets and real rendered screens in Chromium.
function installTheme(theme: "light" | "dark") {
  const themed = css.replace(/light-dark\(\s*(#[\da-f]+)\s*,\s*(#[\da-f]+)\s*\)/gi, (_, light, dark) => theme === "light" ? light : dark);
  const tokens = new Map([...themed.matchAll(/(--[\w-]+):\s*([^;{}]+);/g)].map((match) => [match[1], match[2]]));
  const style = document.createElement("style");
  style.textContent = themed.replace(/var\((--[\w-]+)\)/g, (value, token) => tokens.get(token) ?? value);
  document.head.append(style);
}

function luminance(color: string): number {
  const channels = color.match(/[\d.]+/g)!.slice(0, 3).map((part) => Number(part) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}

const cases: readonly (readonly [string, string])[] = [
  ["shelf action", '<div class="library-active-shelf"><button data-probe>Show all books</button></div>'],
  ["shelf subtitle", '<div class="library-active-shelf"><small data-probe>Built-in smart shelf</small></div>'],
  ["clear filters", '<div class="library-active-filters"><button data-probe>Clear all</button></div>'],
  ["queue total", '<aside class="library-queue-sheet"><div class="library-queue-totals"><strong data-probe>3 books</strong></div></aside>'],
  ["queue book title", '<aside class="library-queue-sheet"><ol class="library-queue-list"><li><div><strong data-probe>A book to send</strong></div></li></ol></aside>'],
  ["queue book size", '<aside class="library-queue-sheet"><ol class="library-queue-list"><li><span data-probe>2 MB</span></li></ol></aside>'],
  ["delete library", '<section class="settings-page"><div class="settings-delete-confirmation"><div><strong data-probe>Delete library?</strong></div></div></section>'],
  ["settings label", '<section class="settings-page"><aside class="settings-library-picker"><div class="settings-section-label" data-probe>Libraries</div></aside></section>'],
  ["disabled primary", '<button class="primary" disabled data-probe>Updating…</button>'],
  ["disabled bulk count", '<div class="library-bulk-actions"><button class="primary" disabled>Send <span data-probe>3</span></button></div>'],
  ["disabled destructive action", '<button class="danger" disabled data-probe>Remove from Kindle</button>'],
  ["provider error", '<section class="settings-page"><p class="settings-provider-error" data-probe>Could not connect</p></section>'],
  ["update progress", '<aside class="library-update-sheet"><div class="library-transfer-status"><strong data-probe>Sending</strong></div></aside>'],
  ["update failure", '<aside class="library-update-sheet"><div class="library-transfer-status failed"><strong data-probe>Transfer stopped</strong></div></aside>'],
  ["stale inventory", '<aside class="library-match-review-sheet"><div class="library-stale-notice"><strong data-probe>Reconnect your reader</strong></div></aside>'],
  ["bulk remove count", '<div class="library-bulk-actions"><button class="danger">Remove <span data-probe>3</span></button></div>'],
  ...["unknown", "confirmed", "possible"].map((state) => [`device status ${state}`, `<aside class="library-book-details-sheet"><p class="book-details-kindle-status" data-status="${state}" data-probe>Device status</p></aside>`] as const),
  ...["high", "medium", "low"].map((state) => [`confidence ${state}`, `<aside class="library-metadata-sheet"><div class="metadata-candidate-discovery"><div class="metadata-candidate-review"><header><span class="metadata-confidence" data-confidence="${state}" data-probe>${state}</span></header></div></div></aside>`] as const),
  ["cover status", '<aside class="library-metadata-sheet"><div class="metadata-cover-search-status" data-probe>No covers found</div></aside>'],
  ["cover error", '<aside class="library-metadata-sheet"><div class="metadata-cover-search-status error" data-probe>Search failed</div></aside>'],
  ["missing cover image", '<aside class="library-metadata-sheet"><div class="metadata-cover-results"><img alt="Cover unavailable" data-probe></div></aside>'],
  ["series availability", '<section class="series-detail"><ol class="series-book-list"><li><span class="series-source-state" data-probe>Available</span></li></ol></section>'],
  ["series unavailable", '<section class="series-detail"><ol class="series-book-list"><li><span class="series-source-state" data-available="false" data-probe>Unavailable</span></li></ol></section>'],
  ["activity details", '<aside class="library-activity-sheet"><section class="activity-current"><div><span data-probe>Kindle connected</span></div></section></aside>'],
  ["match footer", '<aside class="library-match-review-sheet"><footer><span data-probe>Your choice is remembered</span></footer></aside>'],
] as const;

afterEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; });

describe.each(["light", "dark"] as const)("%s theme foreground/background pairs", (theme) => {
  it.each(cases)("keeps %s readable", (_name, html) => {
    installTheme(theme);
    document.body.innerHTML = `<main class="library-app-shell">${html}</main>`;
    const element = document.querySelector<HTMLElement>("[data-probe]")!;
    const foreground = getComputedStyle(element).color;
    let parent: Element | null = element;
    let background = "rgba(0, 0, 0, 0)";
    while (parent && background === "rgba(0, 0, 0, 0)") {
      background = getComputedStyle(parent).backgroundColor;
      parent = parent.parentElement;
    }
    expect(background).not.toBe("rgba(0, 0, 0, 0)");
    const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
    expect((values[1] + .05) / (values[0] + .05), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
  });
});
