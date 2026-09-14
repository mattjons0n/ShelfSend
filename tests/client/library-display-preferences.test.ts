// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { CatalogBrowser } from "../../client/src/catalog-browser";
import { CatalogApiError } from "../../client/src/catalog-client";
import type { CatalogApi, CatalogBook, CatalogBookPage, CatalogBookQuery, CatalogProfile } from "../../client/src/catalog-client";
import { LIBRARY_BROWSER_CONTEXT_STORAGE_KEY, readLibraryBrowserContext, writeLibraryBrowserContext } from "../../client/src/library-browser-context";
import { isLibraryCardSize, isLibraryPageSize, LIBRARY_CARD_SIZE_DEFAULT, LIBRARY_PAGE_SIZES, normalizeLibraryCardSize } from "../../client/src/library-display-preferences";
import { EMPTY_CATALOG_FILTERS, initialLibraryFilters } from "../../client/src/library-prototype";
import { decodeLibraryRoute, encodeLibraryRoute } from "../../client/src/library-route";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

function profile(id: string): CatalogProfile {
  return { id, name: id, description: id, initial: id[0]!, sourceLabel: "Books", enabled: true, rootCount: 0, availableRootCount: 0, bookCount: 500 };
}

function book(profileId: string, id: string): CatalogBook {
  return {
    id, profileId, rootId: "root", sourceFilename: `${id}.epub`, title: id, authors: ["Author"], authorSort: "Author",
    identifiers: [], subjects: [], format: "epub", size: 1024, contentHash: "a".repeat(64),
    addedAt: "2026-09-14T00:00:00Z", updatedAt: "2026-09-14T00:00:00Z", metadataComplete: true, available: true,
  };
}

function page(profileId: string, query: CatalogBookQuery): CatalogBookPage {
  return { items: [book(profileId, `${profileId}-${query.offset ?? 0}`)], total: 500, limit: query.limit ?? 24, offset: query.offset ?? 0 };
}

function fakeApi() {
  const listBooks = vi.fn(async (profileId: string, query: CatalogBookQuery, _signal?: AbortSignal): Promise<CatalogBookPage> => page(profileId, query));
  const api = {
    getStatus: vi.fn().mockResolvedValue({ available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" }),
    listProfiles: vi.fn().mockResolvedValue([profile("one"), profile("two")]),
    listRoots: vi.fn().mockResolvedValue([]),
    getFilters: vi.fn().mockResolvedValue(EMPTY_CATALOG_FILTERS),
    listBooks,
    subscribeEvents: vi.fn().mockReturnValue(() => undefined),
  } as unknown as CatalogApi;
  return { api, listBooks };
}

describe("bounded dashboard display preferences", () => {
  it("accepts only supported widths and page sizes, without coercing unsafe input", () => {
    for (const width of [180, 200, 220, 240, 260, 280]) {
      expect(isLibraryCardSize(width)).toBe(true);
      expect(normalizeLibraryCardSize(width)).toBe(width);
    }
    for (const value of [undefined, null, "180", -1, 0, 179, 181, 281, 10000, NaN, Infinity]) {
      expect(isLibraryCardSize(value)).toBe(false);
      expect(normalizeLibraryCardSize(value)).toBe(LIBRARY_CARD_SIZE_DEFAULT);
    }
    for (const limit of LIBRARY_PAGE_SIZES) expect(isLibraryPageSize(limit)).toBe(true);
    for (const value of [undefined, "24", 0, 6, 13, 201, NaN]) expect(isLibraryPageSize(value)).toBe(false);
  });

  it("restores safe widths from old, corrupt and per-profile saved contexts", () => {
    const storage = memoryStorage();
    writeLibraryBrowserContext(storage, { filters: initialLibraryFilters("one"), layout: "grid", density: "comfortable", cardSize: 180, scrollY: 0 });
    writeLibraryBrowserContext(storage, { filters: { ...initialLibraryFilters("two"), limit: 96 }, layout: "list", density: "compact", cardSize: 280, scrollY: 0 });
    expect(readLibraryBrowserContext(storage, "one").cardSize).toBe(180);
    expect(readLibraryBrowserContext(storage, "two")).toMatchObject({ cardSize: 280, density: "compact", filters: { limit: 96 } });
    const saved = JSON.parse(storage.getItem(LIBRARY_BROWSER_CONTEXT_STORAGE_KEY)!) as { entries: Array<{ cardSize?: number }> };
    saved.entries[0]!.cardSize = 2;
    delete saved.entries[1]!.cardSize;
    storage.setItem(LIBRARY_BROWSER_CONTEXT_STORAGE_KEY, JSON.stringify(saved));
    expect(readLibraryBrowserContext(storage, "one").cardSize).toBe(220);
    expect(readLibraryBrowserContext(storage, "two").cardSize).toBe(220);
  });

  it("persists sizes on reload and keeps separate profile preferences and list density", async () => {
    const storage = memoryStorage();
    const { api } = fakeApi();
    const browser = new CatalogBrowser(api, {}, () => undefined, storage);
    await browser.start();
    browser.setCardSize(180);
    browser.setPageSize(48);
    await vi.waitFor(() => expect(browser.snapshot.page?.limit).toBe(48));
    await browser.selectProfile("two");
    expect(browser.snapshot).toMatchObject({ cardSize: 220, filters: { limit: 24 } });
    browser.setCardSize(280);
    browser.setDensity("compact");
    browser.setPageSize(96);
    await vi.waitFor(() => expect(browser.snapshot.page?.limit).toBe(96));
    await browser.selectProfile("one");
    expect(browser.snapshot).toMatchObject({ cardSize: 180, density: "comfortable", filters: { limit: 48 } });
    browser.dispose();
    const reloaded = new CatalogBrowser(api, {}, () => undefined, storage);
    await reloaded.start();
    expect(reloaded.snapshot).toMatchObject({ cardSize: 180, filters: { profileId: "one", limit: 48 } });
    await reloaded.selectProfile("two");
    expect(reloaded.snapshot).toMatchObject({ cardSize: 280, density: "compact", filters: { limit: 96 } });
    reloaded.dispose();
  });

  it("changes width without requests or lost selection, but a new page size resets pagination and hidden selection only", async () => {
    const storage = memoryStorage();
    writeLibraryBrowserContext(storage, {
      filters: { ...initialLibraryFilters("one"), query: "science", author: "Author", sort: "title", offset: 96 },
      layout: "list", density: "compact", cardSize: 220, scrollY: 100,
    });
    const { api, listBooks } = fakeApi();
    const browser = new CatalogBrowser(api, {}, () => undefined, storage);
    await browser.start();
    browser.toggleBookSelection("one-96", true);
    const calls = listBooks.mock.calls.length;
    browser.setCardSize(260);
    expect(browser.snapshot.selectedBookIds.has("one-96")).toBe(true);
    expect(listBooks).toHaveBeenCalledTimes(calls);
    browser.setPageSize(200);
    await vi.waitFor(() => expect(browser.snapshot.page?.limit).toBe(200));
    expect(browser.snapshot.filters).toMatchObject({ query: "science", author: "Author", sort: "title", limit: 200, offset: 0 });
    expect(browser.snapshot.selectedBookIds.size).toBe(0);
    expect(browser.snapshot.cardSize).toBe(260);
    expect(readLibraryBrowserContext(storage, "one")).toMatchObject({ cardSize: 260, filters: { limit: 200, offset: 0 } });
    expect(listBooks.mock.lastCall?.[1]).toMatchObject({ q: "science", author: "Author", sort: "title", limit: 200, offset: 0 });
    browser.dispose();
  });

  it("rejects invalid choices and changes while a transfer is busy", async () => {
    const { api, listBooks } = fakeApi();
    let finish!: () => void;
    const sending = new Promise<void>((resolve) => { finish = resolve; });
    const browser = new CatalogBrowser(api, { onSendRequested: () => sending }, () => undefined, memoryStorage());
    await browser.start();
    const calls = listBooks.mock.calls.length;
    browser.setCardSize(90);
    browser.setPageSize(1000);
    expect(browser.snapshot).toMatchObject({ cardSize: 220, filters: { limit: 24 } });
    expect(listBooks).toHaveBeenCalledTimes(calls);
    browser.openSend("one-0");
    expect(browser.snapshot.sendBusy).toBe(true);
    browser.setCardSize(280);
    browser.setPageSize(48);
    expect(browser.snapshot).toMatchObject({ cardSize: 220, filters: { limit: 24 } });
    expect(listBooks).toHaveBeenCalledTimes(calls);
    finish();
    await vi.waitFor(() => expect(browser.snapshot.sendBusy).toBe(false));
    browser.dispose();
  });

  it("cancels an obsolete page-size request and ignores its late response", async () => {
    const { api, listBooks } = fakeApi();
    const browser = new CatalogBrowser(api, {}, () => undefined, memoryStorage());
    await browser.start();
    let finishOld!: (value: CatalogBookPage) => void;
    listBooks.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    browser.setPageSize(48);
    const staleSignal = listBooks.mock.lastCall?.[2];
    browser.setPageSize(96);
    expect(staleSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(browser.snapshot.page?.limit).toBe(96));
    finishOld(page("one", { limit: 48, offset: 48 }));
    await Promise.resolve();
    expect(browser.snapshot.filters).toMatchObject({ limit: 96, offset: 0 });
    expect(browser.snapshot.page).toMatchObject({ limit: 96, offset: 0 });
    browser.dispose();
  });

  it("round-trips display settings in URLs and leaves legacy links compatible with saved widths", async () => {
    const encoded = encodeLibraryRoute({
      version: 1, profileId: "one", filters: { ...initialLibraryFilters("one"), limit: 96, offset: 192 },
      layout: "grid", density: "comfortable", cardSize: 280,
      overlays: { sendQueueOpen: false, shelfManagerOpen: false, activityOpen: false },
    });
    const route = decodeLibraryRoute(encoded)!;
    expect(route).toMatchObject({ cardSize: 280, filters: { limit: 96, offset: 192 } });
    expect(decodeLibraryRoute("#library?v=1&p=one&card-size=1")?.cardSize).toBeUndefined();
    const { api } = fakeApi();
    const browser = new CatalogBrowser(api, {}, () => undefined, memoryStorage());
    await browser.start();
    expect(await browser.applyLibraryRoute(route)).toBe(true);
    expect(browser.snapshot).toMatchObject({ cardSize: 280, filters: { limit: 96, offset: 192 } });
    await browser.applyLibraryRoute(decodeLibraryRoute("#library?v=1&p=one&layout=grid")!);
    expect(browser.snapshot.cardSize).toBe(280);
    browser.dispose();
  });

  it("keeps the bounded smaller-page fallback when a chosen page exceeds the response limit", async () => {
    const { api, listBooks } = fakeApi();
    const browser = new CatalogBrowser(api, {}, () => undefined, memoryStorage());
    await browser.start();
    listBooks.mockClear();
    listBooks.mockImplementation(async (profileId, query) => {
      if ((query.limit ?? 24) > 6) throw new CatalogApiError(413, "response_too_large", "Page response exceeds its limit");
      return page(profileId, query);
    });
    browser.setPageSize(200);
    await vi.waitFor(() => expect(browser.snapshot.page?.limit).toBe(6));
    expect(listBooks.mock.calls.map(([, query]) => query.limit)).toEqual([200, 24, 12, 6]);
    expect(browser.snapshot.filters.limit).toBe(6);
    expect(browser.snapshot.error).toBeUndefined();
    browser.dispose();
  });
});
