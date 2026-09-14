// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { CatalogBrowser, type CatalogBrowserSnapshot, type CatalogKindleInventory, type CatalogKindleInventoryItem } from "../../client/src/catalog-browser";
import type { CatalogApi } from "../../client/src/catalog-client";
import { renderKindleLibraryView } from "../../client/src/kindle-library-view";
import { initialLibraryFilters } from "../../client/src/library-prototype";
import { initialAppState, type AppState } from "../../client/src/state";

const BOOK: CatalogKindleInventoryItem = {
  id: "device-1", filename: "original.azw3", title: "A Kindle Book", author: "An Author",
  format: "AZW3", size: 4096, path: "Documents/original.azw3", managed: false, match: "unmatched",
};

function inventory(items: readonly CatalogKindleInventoryItem[], overrides: Partial<CatalogKindleInventory> = {}): CatalogKindleInventory {
  return { deviceLabel: "Kindle", scannedAt: new Date().toISOString(), completeness: "complete", items, total: items.length, truncated: false, ...overrides };
}

function render(overrides: Partial<CatalogBrowserSnapshot> = {}, stateOverrides: Partial<AppState> = {}): HTMLElement {
  const browser = new CatalogBrowser({} as CatalogApi, {}, () => undefined);
  const initial = browser.snapshot;
  browser.dispose();
  const root = document.createElement("div");
  root.innerHTML = renderKindleLibraryView({
    ...initialAppState(), device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981 } },
    catalogInventoryState: "ready", ...stateOverrides,
  }, { ...initial, kindleInventory: inventory([BOOK]), ...overrides });
  return root;
}

describe("standalone Kindle library", () => {
  it.each(["grid", "list"] as const)("shows every device item in %s regardless of library, profile, shelf, filters or match status", (layout) => {
    const items = [
      { ...BOOK, id: "unmatched", title: "Only on the Kindle" },
      { ...BOOK, id: "other-library", title: "From another library", bookId: "another-profile-book", match: "confirmed" as const },
      { ...BOOK, id: "possible", title: "An uncertain comparison", match: "possible" as const },
    ];
    const root = render({
      layout,
      loadState: "error", error: "Catalog disconnected", booksState: "loading", profiles: [],
      kindleInventory: inventory(items),
      filters: { ...initialLibraryFilters("empty-profile"), view: "on-kindle", query: "not a device search", kindle: "not-on-kindle", format: "PDF", subject: "unrelated" },
      activeShelf: { id: "empty-shelf", name: "Empty", query: { version: 1 }, builtIn: false },
      kindleStatus: new Map(),
    });
    expect(root.querySelector("h1")?.textContent).toBe("On Device");
    expect(root.querySelectorAll("[data-kindle-object-id]")).toHaveLength(3);
    expect(root.textContent).toContain("Only on the Kindle");
    expect(root.textContent).toContain("From another library");
    expect(root.textContent).not.toContain("Catalog disconnected");
    expect(root.querySelector('[data-ui-action="open-match-review"]')).toBeNull();
    expect(root.querySelector('[data-ui-action="send-book"]')).toBeNull();
    expect(root.querySelector('[data-ui-action="remove-book-from-kindle"]')).toBeNull();
    expect(root.querySelector("[data-match]")).toBeNull();
  });

  it("defaults to a gallery with shared layout and cover-size controls", () => {
    const root = render();
    expect(root.querySelector('.kindle-library-view[data-layout="grid"]')).not.toBeNull();
    expect(root.querySelector('.kindle-library-list.library-book-grid[data-layout="grid"]')).not.toBeNull();
    expect(root.querySelector('[data-ui-action="set-library-layout"][data-layout="grid"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector('[data-ui-action="set-library-layout"][data-layout="list"]')?.getAttribute("aria-pressed")).toBe("false");
    expect(root.querySelector<HTMLInputElement>("#library-card-size")?.value).toBe("180");
    expect(root.querySelector('[data-ui-action="set-library-density"]')).toBeNull();
    expect(root.querySelector(".kindle-library-book h2")?.textContent).toBe(BOOK.title);
    expect(root.querySelector(".kindle-library-book p")?.textContent).toBe(BOOK.author);
    expect(root.querySelector(".kindle-library-book small")?.textContent).toBe("AZW3 · 4.10 KB");
    expect(root.querySelector(".kindle-library-file-details")?.textContent).toContain(BOOK.path);
  });

  it("uses the shared card size and preserves readable device metadata", () => {
    const root = render({ cardSize: 260, density: "compact" });
    expect(root.querySelector<HTMLElement>(".kindle-library-list")?.style.getPropertyValue("--library-card-min-width")).toBe("260px");
    expect(root.querySelector<HTMLInputElement>("#library-card-size")?.value).toBe("260");
    expect(root.querySelector(".kindle-library-book")?.textContent).toContain(BOOK.title);
    expect(root.querySelector(".kindle-library-book")?.textContent).toContain(BOOK.author);
  });

  it.each(["comfortable", "compact"] as const)("offers a list with %s density and no catalog selection controls", (density) => {
    const root = render({ layout: "list", density });
    expect(root.querySelector('.kindle-library-view[data-layout="list"]')?.getAttribute("data-density")).toBe(density);
    expect(root.querySelector('.kindle-library-list[data-layout="list"]')).not.toBeNull();
    expect(root.querySelector('[data-ui-action="set-library-layout"][data-layout="list"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector('[data-ui-action="set-library-layout"][data-layout="grid"]')?.getAttribute("aria-pressed")).toBe("false");
    expect(root.querySelector(`[data-ui-action="set-library-density"][data-density="${density}"]`)?.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector("#library-card-size")).toBeNull();
    expect(root.querySelector('[type="checkbox"], [data-book-id], .library-book-card')).toBeNull();
    expect(root.querySelector("details")?.textContent).toContain(BOOK.filename);
  });

  it.each(["grid", "list"] as const)("keeps device-only artwork placeholders in %s even when catalog art exists", (layout) => {
    const matched = { ...BOOK, bookId: "catalog-book", match: "confirmed" as const };
    const root = render({ layout, kindleInventory: inventory([matched]), page: {
      items: [{ id: "catalog-book", profileId: "profile", rootId: "root", sourceFilename: "source.epub",
        title: "Catalog-only title", authors: ["Catalog-only author"], authorSort: "Catalog-only author", subjects: [],
        identifiers: [], format: "epub", size: 2048, addedAt: "2026-09-14", updatedAt: "2026-09-14",
        metadataComplete: true, available: true, coverUrl: "/api/catalog/cover", sourceUrl: "/api/catalog/source" }],
      total: 1, offset: 0, limit: 24,
    } });
    const item = root.querySelector(`[data-kindle-object-id="${BOOK.id}"]`);
    expect(item?.querySelector("[data-kindle-cover] svg")).not.toBeNull();
    expect(item?.querySelector("[data-kindle-cover]")?.getAttribute("aria-hidden")).toBe("true");
    expect(item?.querySelector("img")).toBeNull();
    expect(root.innerHTML).not.toContain("/api/catalog/");
    expect(root.textContent).not.toContain("Catalog-only");
    expect(root.querySelectorAll("[data-kindle-object-id]")).toHaveLength(1);
  });

  it("presents filenames and an honest author fallback when device metadata is missing", () => {
    const root = render({ kindleInventory: inventory([{ ...BOOK, title: " ", author: undefined, format: undefined }]) });
    expect(root.querySelector(".kindle-library-book h2")?.textContent).toBe("original.azw3");
    expect(root.querySelector(".kindle-library-book p")?.textContent).toBe("Author unavailable");
    expect(root.querySelector(".kindle-library-book small")?.textContent).toBe("AZW3 · 4.10 KB");
    expect(root.querySelector("details")?.open).toBe(false);
    expect(root.querySelector("details")?.textContent).toContain("Documents/original.azw3");
  });

  it("uses only the independent Kindle search and includes all listed authors", () => {
    const root = render({ kindleInventoryQuery: "coauthor", kindleInventory: inventory([
      { ...BOOK, id: "a", authors: ["First author", "Coauthor"] },
      { ...BOOK, id: "b", title: "Other title", author: "Someone else" },
    ]) });
    expect(root.querySelectorAll("[data-kindle-object-id]")).toHaveLength(1);
    expect(root.querySelector(".kindle-library-book p")?.textContent).toBe("First author, Coauthor");
    expect(root.querySelector<HTMLInputElement>("#kindle-inventory-search")?.value).toBe("coauthor");
    expect(root.textContent).toContain("1 of 2 files match your search");
  });

  it("gives a Kindle-specific no-search-results state without library filter controls", () => {
    const root = render({ kindleInventoryQuery: "missing title" });
    expect(root.textContent).toContain("No matching books or documents");
    expect(root.textContent).toContain("This search only checks your Kindle");
    expect(root.querySelector('[data-ui-action="clear-filters"]')).toBeNull();
  });

  it("makes all 10,000 items available in bounded pages and clamps oversized offsets", () => {
    const items = Array.from({ length: 10_000 }, (_, index) => ({ ...BOOK, id: `item-${index}`, title: `Book ${index + 1}` }));
    const first = render({ kindleInventory: inventory(items) });
    expect(first.querySelectorAll("[data-kindle-object-id]")).toHaveLength(100);
    expect(first.querySelector<HTMLButtonElement>('[data-page-offset="0"]')?.disabled).toBe(true);
    expect(first.querySelector('[data-page-offset="100"]')?.textContent).toBe("Next");
    const last = render({ kindleInventory: inventory(items), kindleInventoryOffset: 20_000 });
    expect(last.querySelectorAll("[data-kindle-object-id]")).toHaveLength(100);
    expect(last.querySelector('[data-kindle-object-id="item-9999"]')).not.toBeNull();
    expect(last.querySelector(".kindle-library-pagination")?.textContent).toContain("9,901–10,000 of 10,000");
    expect(last.querySelector<HTMLButtonElement>('[data-page-offset="9900"]')?.disabled).toBe(true);
  });

  it.each([-100, Number.NaN, Number.POSITIVE_INFINITY])("clamps an invalid offset %s to the first page", (offset) => {
    const root = render({ kindleInventoryOffset: offset });
    expect(root.querySelector("[data-kindle-object-id]")?.getAttribute("data-kindle-object-id")).toBe(BOOK.id);
  });

  it("does not call a disconnected or explicitly stale list current", () => {
    for (const root of [
      render({}, { device: { kind: "disconnected" } }),
      render({ kindleInventory: inventory([BOOK], { completeness: "last-seen" }) }),
    ]) {
      expect(root.querySelector('.kindle-library-status[data-state="last-seen"]')).not.toBeNull();
      expect(root.textContent).toContain("not a current check");
      expect(root.textContent).not.toContain("Contents up to date");
      expect(root.querySelectorAll("[data-kindle-object-id]")).toHaveLength(1);
    }
  });

  it.each([
    { completeness: "partial" as const },
    { truncated: true },
    { total: 50 },
  ])("does not claim complete contents from an incomplete enumeration %j", (overrides) => {
    const root = render({ kindleInventory: inventory([BOOK], overrides) });
    expect(root.querySelector('.kindle-library-status[data-state="partial"]')).not.toBeNull();
    expect(root.textContent).toContain("other files may not be listed");
    expect(root.textContent).not.toContain("Contents up to date");
  });

  it("retains files while checking or after a failed check and explains missing metadata", () => {
    const inv = inventory([BOOK], { metadata: { status: "partial", eligible: 10, enriched: 1, failed: 0, skipped: 0, truncated: false } });
    const loading = render({ kindleInventory: inv }, { catalogInventoryState: "loading", postConnectStage: "inventory" });
    expect(loading.textContent).toContain("last available list stays visible");
    expect(loading.textContent).toContain("titles and authors are still being read");
    expect(loading.querySelectorAll("[data-kindle-object-id]")).toHaveLength(1);
    const failed = render({ kindleInventory: inv }, { catalogInventoryState: "failed" });
    expect(failed.querySelector('.kindle-library-status[data-state="failed"]')).not.toBeNull();
    expect(failed.textContent).toContain("latest check could not finish");
    expect(failed.textContent).toContain("Some titles and authors are unavailable");
    expect(failed.querySelectorAll("[data-kindle-object-id]")).toHaveLength(1);
  });

  it("distinguishes an empty complete scan from absent, loading, failed or partial scans", () => {
    const empty = render({ kindleInventory: inventory([]) });
    expect(empty.textContent).toContain("No books or documents found");
    expect(empty.textContent).toContain("completed check found no supported");
    const partial = render({ kindleInventory: inventory([], { completeness: "partial" }) });
    expect(partial.textContent).toContain("No files available yet");
    expect(partial.textContent).not.toContain("No books or documents found");
    const loading = render({ kindleInventory: undefined }, { catalogInventoryState: "loading" });
    expect(loading.textContent).toContain("Reading your Kindle");
    const failed = render({ kindleInventory: undefined }, { catalogInventoryState: "failed" });
    expect(failed.textContent).toContain("Unable to read Kindle contents");
    const disconnected = render({ kindleInventory: undefined }, { device: { kind: "disconnected" } });
    expect(disconnected.textContent).toContain("Connect your Kindle");
  });

  it("escapes device fields and search input without creating markup or actions", () => {
    const payload = '<img src=x onerror="alert(1)">';
    const root = render({ kindleInventory: inventory([{ ...BOOK, id: payload, title: payload, author: payload, filename: payload, path: payload, format: payload }]) });
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("[onerror]")).toBeNull();
    expect(root.querySelector("h2")?.textContent).toBe(payload);
    expect(root.querySelector("[data-kindle-object-id]")?.getAttribute("data-kindle-object-id")).toBe(payload);
    const query = render({ kindleInventoryQuery: payload });
    expect(query.querySelector("img")).toBeNull();
    expect(query.querySelector<HTMLInputElement>("input")?.value).toBe(payload);
  });

  it.each(["ready", "failed"] as const)("offers Disconnect for an idle connected Kindle after inventory is %s", (catalogInventoryState) => {
    const root = render({}, { catalogInventoryState });
    const button = root.querySelector<HTMLButtonElement>('.kindle-library-actions [data-ui-action="disconnect-catalog-device"]');
    expect(button?.textContent).toBe("Disconnect");
    expect(button?.disabled).toBe(false);
  });

  it.each<[string, Partial<AppState>, Partial<CatalogBrowserSnapshot>]>([
    ["safe-write checks", { postConnectStage: "safe-write" }, {}],
    ["inventory reading", { postConnectStage: "inventory" }, {}],
    ["library reconciliation", { postConnectStage: "reconciliation" }, {}],
    ["self-test running", { selfTest: { kind: "running" } }, {}],
    ["book send", {}, { sendBusy: true }],
    ["bulk action", {}, { bulkActionBusy: true }],
    ["device transferring", { device: { kind: "transferring", details: { vendorId: 0x1949, productId: 0x9981 } } }, {}],
    ["disconnect cleanup", { device: { kind: "recovering", details: { vendorId: 0x1949, productId: 0x9981 } } }, {}],
  ])("prevents Disconnect during %s", (_label, state, snapshot) => {
    const button = render(snapshot, state).querySelector<HTMLButtonElement>('[data-ui-action="disconnect-catalog-device"]');
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
    if (state.device?.kind === "recovering") expect(button?.textContent).toBe("Disconnecting…");
  });

  it("hides Disconnect once the Kindle is disconnected", () => {
    const root = render({}, { device: { kind: "disconnected" } });
    expect(root.querySelector('[data-ui-action="disconnect-catalog-device"]')).toBeNull();
  });
});
