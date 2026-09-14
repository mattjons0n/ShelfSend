// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogBrowser, type CatalogKindleInventory } from "../../client/src/catalog-browser";
import type { CatalogApi, CatalogBook, CatalogBookMatchQuery, CatalogEvent, CatalogProfile } from "../../client/src/catalog-client";
import { writeLibraryBrowserContext } from "../../client/src/library-browser-context";
import { initialLibraryFilters } from "../../client/src/library-prototype";
import { decodeLibraryRoute } from "../../client/src/library-route";

const profiles: CatalogProfile[] = ["one", "two"].map((id) => ({
  id, name: `Library ${id}`, description: "Books", initial: id[0]!, sourceLabel: `Folder ${id}`,
  enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 1,
}));
const books: CatalogBook[] = profiles.map(({ id }) => ({
  id: `book-${id}`, profileId: id, rootId: `root-${id}`, sourceFilename: `${id}.epub`, title: `Book ${id}`,
  authors: ["Author"], authorSort: "Author", subjects: [], identifiers: [], format: "epub", size: 100,
  contentHash: "a".repeat(64), presentationVersion: "a".repeat(64), addedAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z", metadataComplete: true, available: true,
}));
const inventory: CatalogKindleInventory = {
  deviceLabel: "Kindle", scannedAt: "2026-01-01T00:00:00Z", completeness: "complete", total: 4, truncated: false,
  matching: { status: "complete", matchedProfiles: 1, failedProfiles: 0 },
  items: [
    { id: "mtp-1", filename: "one.azw3", title: "Book one", size: 100, managed: true, bookId: "book-one", match: "confirmed" },
    { id: "mtp-2", filename: "two.azw3", title: "Book two", size: 100, managed: true, bookId: "book-two", match: "confirmed" },
    { id: "mtp-3", filename: "unknown.azw3", title: "Outside every library", size: 100, managed: false, match: "unmatched" },
    { id: "mtp-4", filename: "possible.azw3", title: "Uncertain title", size: 100, managed: false, bookId: "book-one", match: "possible" },
  ],
};

const browsers: CatalogBrowser[] = [];
afterEach(() => { browsers.splice(0).forEach((browser) => browser.dispose()); vi.useRealTimers(); });

async function harness(empty = false, unavailable = false) {
  let onEvent!: (event: CatalogEvent) => void;
  const stored = new Map<string, string>();
  const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } };
  const query = async (profileId: string, input: CatalogBookMatchQuery = {}) => {
    const items = books.filter((book) => book.profileId === profileId
      && (!input.includeBookIds || input.includeBookIds.includes(book.id))
      && (!input.q || book.title.includes(input.q)));
    return { items, total: items.length, limit: input.limit ?? 24, offset: input.offset ?? 0 };
  };
  const api = {
    getStatus: vi.fn(async () => {
      if (unavailable) throw new Error("Catalog service unavailable");
      return { available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" };
    }),
    listProfiles: vi.fn().mockResolvedValue(empty ? [] : profiles),
    listRoots: vi.fn(async (profileId: string) => [{ id: `root-${profileId}`, profileId, label: "Books", path: `/libraries/${profileId}`, recursive: true, watch: true, enabled: true, status: "watching" }]),
    getFilters: vi.fn().mockResolvedValue({ authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [] }),
    listBooks: vi.fn(query), queryBooks: vi.fn(query),
    getSendQueue: vi.fn(async (profileId: string) => ({ profileId, revision: 0, entries: [], total: 0, totalSourceBytes: 0 })),
    listSmartShelves: vi.fn().mockResolvedValue([]),
    subscribeEvents: vi.fn((event: typeof onEvent, _error: () => void, opened: () => void) => { onEvent = event; opened(); return () => undefined; }),
  };
  const render = vi.fn();
  const onCatalogChanged = vi.fn(async () => undefined);
  const browser = new CatalogBrowser(api as unknown as CatalogApi, { onCatalogChanged }, render, storage);
  browsers.push(browser);
  await browser.start();
  browser.setKindleInventory(inventory);
  browser.setKindleStatuses(new Map([["book-one", "confirmed"]]), new Map([["one", { confirmed: 1, possible: 0, notOnKindle: 0, unknown: 0 }]]));
  await browser.reloadBooks(true);
  api.listBooks.mockClear(); api.queryBooks.mockClear(); render.mockClear();
  return {
    browser, api, render, storage, onCatalogChanged,
    emit: (type: string) => onEvent({ id: type, type, profileId: "one", rootId: "root-one", at: new Date().toISOString() }),
  };
}

describe("standalone Kindle inventory navigation", () => {
  it("opens every Kindle file without querying or filtering by the selected library", async () => {
    const { browser, api } = await harness();
    await browser.setView("on-kindle");
    expect(browser.snapshot.filters.view).toBe("on-kindle");
    expect(browser.snapshot.kindleInventory?.items.map(({ id }) => id)).toEqual(["mtp-1", "mtp-2", "mtp-3", "mtp-4"]);
    expect(api.listBooks).not.toHaveBeenCalled();
    expect(api.queryBooks).not.toHaveBeenCalled();
  });

  it("searches the device locally without replacing the library's query and resets device pagination", async () => {
    const { browser, api, render } = await harness();
    browser.updateFilter("query", "Book one");
    await browser.setView("on-kindle");
    browser.goToKindleInventoryPage(48);
    api.listBooks.mockClear(); api.queryBooks.mockClear(); render.mockClear();
    browser.updateKindleInventoryQuery("Outside every library");
    expect(browser.snapshot.kindleInventoryQuery).toBe("Outside every library");
    expect(browser.snapshot.kindleInventoryOffset).toBe(0);
    expect(browser.snapshot.filters.query).toBe("Book one");
    expect(render).toHaveBeenLastCalledWith("device");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(api.listBooks).not.toHaveBeenCalled();
    expect(api.queryBooks).not.toHaveBeenCalled();
  });

  it("retains every live device file when a library scan temporarily invalidates comparison", async () => {
    const { browser, api, emit, onCatalogChanged } = await harness();
    await browser.setView("on-kindle");
    emit("root.scan.started");
    await vi.waitFor(() => expect(onCatalogChanged).toHaveBeenCalled());
    expect(browser.snapshot.kindleInventory?.matching?.status).toBe("unavailable");
    expect(browser.snapshot.kindleInventory?.items.map(({ id }) => id)).toEqual(["mtp-1", "mtp-2", "mtp-3", "mtp-4"]);
    expect(browser.snapshot.kindleStatus.get("book-one")).toBe("unknown");
    expect(api.listBooks).not.toHaveBeenCalled();
    expect(api.queryBooks).not.toHaveBeenCalled();
  });

  it("keeps comparison updates independent from device search and inventory membership", async () => {
    const { browser, api } = await harness();
    await browser.setView("on-kindle");
    browser.updateKindleInventoryQuery("outside");
    browser.setKindleStatuses(new Map([["book-one", "not-on-kindle"]]));
    browser.setKindleInventory({ ...inventory, matching: { status: "partial", matchedProfiles: 0, failedProfiles: 1 } });
    await browser.reloadBooks(true);
    expect(browser.snapshot.kindleInventoryQuery).toBe("outside");
    expect(browser.snapshot.kindleInventory?.items).toHaveLength(4);
    expect(api.listBooks).not.toHaveBeenCalled();
    expect(api.queryBooks).not.toHaveBeenCalled();
  });

  it("continues using library-scoped On Kindle and Not on Kindle filters after returning to All books", async () => {
    const { browser, api } = await harness();
    await browser.setView("on-kindle");
    await browser.setView("all");
    expect(browser.snapshot.page?.items.map(({ id }) => id)).toEqual(["book-one"]);
    expect(api.listBooks).toHaveBeenCalledWith("one", expect.any(Object), expect.any(AbortSignal));
    await browser.applyKindleSummaryFilter("on-kindle");
    expect(api.queryBooks).toHaveBeenLastCalledWith("one", expect.objectContaining({ includeBookIds: ["book-one"] }), expect.any(AbortSignal));
    await browser.applyKindleSummaryFilter("not-on-kindle");
    expect(browser.snapshot.page?.items).toEqual([]);
    expect(browser.snapshot.kindleInventory?.items).toHaveLength(4);
  });

  it("opens All books when clicking the currently selected library from device inventory", async () => {
    const { browser } = await harness();
    await browser.setView("on-kindle");
    await browser.selectProfile("one");
    expect(browser.snapshot.filters).toMatchObject({ profileId: "one", view: "all" });
    expect(browser.snapshot.page?.items.map(({ id }) => id)).toEqual(["book-one"]);
  });

  it("clears the active library shelf when opening Kindle inventory through Settings", async () => {
    const { browser, api } = await harness();
    await browser.applySmartShelf("builtin-favorites");
    expect(browser.snapshot.activeShelf?.id).toBe("builtin-favorites");
    await browser.setView("settings");
    expect(browser.snapshot.activeShelf?.id).toBe("builtin-favorites");
    api.listBooks.mockClear(); api.queryBooks.mockClear();
    await browser.setView("on-kindle");
    expect(browser.snapshot.filters.view).toBe("on-kindle");
    expect(browser.snapshot.activeShelf).toBeUndefined();
    expect(browser.snapshot.kindleInventory?.items).toHaveLength(4);
    expect(api.listBooks).not.toHaveBeenCalled();
    expect(api.queryBooks).not.toHaveBeenCalled();
  });

  it("opens the chosen library even if its saved legacy view was On Kindle", async () => {
    const { browser, storage } = await harness();
    writeLibraryBrowserContext(storage, { filters: { ...initialLibraryFilters("two"), view: "on-kindle" }, layout: "grid", density: "comfortable", scrollY: 0 });
    await browser.setView("on-kindle");
    await browser.selectProfile("two");
    expect(browser.snapshot.filters).toMatchObject({ profileId: "two", view: "all" });
    expect(browser.snapshot.page?.items.map(({ id }) => id)).toEqual(["book-two"]);
    expect(browser.snapshot.kindleInventory?.items).toHaveLength(4);
  });

  it("supports a device inventory route without any configured library", async () => {
    const { browser, api } = await harness(true);
    const route = decodeLibraryRoute("#library?v=1&view=on-kindle")!;
    expect(await browser.applyLibraryRoute(route)).toBe(true);
    expect(browser.snapshot.filters).toMatchObject({ profileId: undefined, view: "on-kindle" });
    expect(browser.snapshot.kindleInventory?.items).toHaveLength(4);
    expect(api.listBooks).not.toHaveBeenCalled();
    expect(api.queryBooks).not.toHaveBeenCalled();
  });

  it.each([false, true])("ignores a deleted library in legacy device routes, including unavailable catalog: %s", async (unavailable) => {
    const { browser, api } = await harness(true, unavailable);
    api.listProfiles.mockClear(); api.listRoots.mockClear(); api.getFilters.mockClear(); api.getStatus.mockClear();
    const route = decodeLibraryRoute("#library?v=1&p=deleted-library&view=on-kindle&shelf=builtin-favorites")!;
    expect(await browser.applyLibraryRoute(route)).toBe(true);
    expect(browser.snapshot.filters).toMatchObject({ profileId: undefined, view: "on-kindle" });
    expect(browser.snapshot.kindleInventory?.items).toHaveLength(4);
    expect(browser.snapshot.activeShelf).toBeUndefined();
    for (const method of [api.listProfiles, api.listRoots, api.getFilters, api.getStatus, api.listBooks, api.queryBooks]) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("does not switch to or load a different library named in an inventory route", async () => {
    const { browser, api } = await harness();
    api.listRoots.mockClear(); api.getFilters.mockClear(); api.listSmartShelves.mockClear();
    const route = decodeLibraryRoute("#library?v=1&p=two&view=on-kindle")!;
    expect(await browser.applyLibraryRoute(route)).toBe(true);
    expect(browser.snapshot.filters).toMatchObject({ profileId: "one", view: "on-kindle" });
    for (const method of [api.listRoots, api.getFilters, api.listSmartShelves, api.listBooks, api.queryBooks]) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("never restores a routed shelf after a delayed library extras request settles in inventory", async () => {
    const { browser, api } = await harness();
    let resolveShelves!: (value: never[]) => void;
    api.listSmartShelves.mockImplementationOnce(() => new Promise((resolve) => { resolveShelves = resolve; }));
    await browser.selectProfile("two");
    expect(browser.snapshot.smartShelvesState).toBe("loading");
    const route = decodeLibraryRoute("#library?v=1&p=two&view=on-kindle&shelf=builtin-favorites")!;
    expect(await browser.applyLibraryRoute(route)).toBe(true);
    resolveShelves([]);
    await vi.waitFor(() => expect(browser.snapshot.smartShelvesState).toBe("ready"));
    expect(browser.snapshot.activeShelf).toBeUndefined();
    expect(browser.snapshot.filters.view).toBe("on-kindle");
    expect(browser.snapshot.kindleInventory?.items).toHaveLength(4);
  });

  it("preserves the existing Kobo library comparison view", async () => {
    const { browser, api } = await harness();
    browser.setKoboState({ status: "ready", supported: true, profileId: "one", statuses: new Map([["book-one", "confirmed"]]), countsByProfile: new Map([["one", { confirmed: 1, possible: 0, notOnKindle: 0, unknown: 0 }]]) });
    api.listBooks.mockClear(); api.queryBooks.mockClear();
    await browser.setView("on-kindle");
    expect(api.queryBooks).toHaveBeenCalledWith("one", expect.objectContaining({ includeBookIds: ["book-one"] }), expect.any(AbortSignal));
    expect(browser.snapshot.page?.items.map(({ id }) => id)).toEqual(["book-one"]);
  });
});
