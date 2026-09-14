// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogBrowser, type CatalogBrowserSnapshot, type CatalogKindleInventory, type CatalogRenderScope } from "../../client/src/catalog-browser";
import type { CatalogApi, CatalogBook, CatalogBookMatchQuery, CatalogProfile, CatalogRoot } from "../../client/src/catalog-client";

const profile: CatalogProfile = {
  id: "library-one", name: "Library", description: "Books", initial: "L", sourceLabel: "Books",
  enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 2,
};
const root: CatalogRoot = {
  id: "root-one", profileId: profile.id, label: "Books", path: "/libraries/books",
  recursive: true, watch: true, enabled: true, status: "watching",
};
const books: CatalogBook[] = ["a", "b"].map((id) => ({
  id, profileId: profile.id, rootId: root.id, sourceFilename: `${id}.epub`, title: `Book ${id}`,
  authors: ["Author"], authorSort: "Author", subjects: [], identifiers: [], format: "EPUB", size: 100,
  contentHash: id.repeat(64), presentationVersion: id.repeat(64),
  addedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", metadataComplete: true, available: true,
}));
const counts = new Map([[profile.id, { confirmed: 1, possible: 0, notOnKindle: 1, unknown: 0 }]]);

function inventory(bookId = "a", match: "confirmed" | "possible" = "confirmed"): CatalogKindleInventory {
  return {
    deviceLabel: "Kindle", scannedAt: "2026-01-01T00:00:00Z", completeness: "complete", total: 2, truncated: false,
    matching: { status: match === "confirmed" ? "complete" : "partial", matchedProfiles: 1, failedProfiles: match === "confirmed" ? 0 : 1 },
    items: ["original", "duplicate"].map((copy, index) => ({
      id: `mtp-${index + 1}`, filename: `${bookId}-${copy}.azw3`, size: 100, managed: true, bookId, match,
    })),
  };
}

const browsers: CatalogBrowser[] = [];
afterEach(() => {
  browsers.splice(0).forEach((browser) => browser.dispose());
  vi.restoreAllMocks();
});

async function harness() {
  let eventError!: () => void;
  const query = async (_profileId: string, input: CatalogBookMatchQuery = {}) => {
    const items = books.filter((book) => !input.includeBookIds || input.includeBookIds.includes(book.id));
    return { items, total: items.length, limit: input.limit ?? 24, offset: input.offset ?? 0 };
  };
  const api = {
    getStatus: vi.fn().mockResolvedValue({ available: true, state: "ready", settingsMode: "read-write" }),
    listProfiles: vi.fn().mockResolvedValue([profile]), listRoots: vi.fn().mockResolvedValue([root]),
    getFilters: vi.fn().mockResolvedValue({ authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [] }),
    listBooks: vi.fn(query), queryBooks: vi.fn(query),
    subscribeEvents: vi.fn((_event: unknown, error: () => void, opened: () => void) => {
      eventError = error;
      opened();
      return () => undefined;
    }),
  } as unknown as CatalogApi;
  const published: CatalogBrowserSnapshot[] = [];
  const render = vi.fn((_scope: CatalogRenderScope) => { published.push(browser.snapshot); });
  const browser = new CatalogBrowser(api, {}, render, { getItem: () => null, setItem: () => undefined });
  browsers.push(browser);
  await browser.start();
  const clear = () => {
    vi.mocked(api.listBooks).mockClear();
    vi.mocked(api.queryBooks).mockClear();
    render.mockClear();
    published.length = 0;
  };
  clear();
  return { browser, api, render, published, clear, loseEventStream: () => eventError() };
}

describe("synchronous catalog publication", () => {
  it("updates authoritative state immediately and publishes duplicate inventory once with one reload", async () => {
    const { browser, api, render, published } = await harness();
    browser.batchUpdates(() => {
      browser.setKindleStatuses(new Map([["a", "confirmed"], ["b", "not-on-kindle"]]), counts);
      expect(browser.snapshot.kindleStatus.get("a")).toBe("confirmed");
      expect(render).not.toHaveBeenCalled();
      expect(api.listBooks).not.toHaveBeenCalled();
      browser.setKindleInventory(inventory());
      expect(browser.snapshot.kindleInventory?.items).toHaveLength(2);
      expect(browser.snapshot.kindleInventory?.items.every(({ match }) => match === "confirmed")).toBe(true);
      expect(browser.snapshot.kindleStatusCountsByProfile.get(profile.id)?.confirmed).toBe(1);
      expect(render).not.toHaveBeenCalled();
      expect(api.listBooks).not.toHaveBeenCalled();
    });
    expect(render).toHaveBeenCalledExactlyOnceWith("all");
    expect(published[0]?.kindleInventory?.items).toHaveLength(2);
    expect(published[0]?.kindleStatusCountsByProfile.get(profile.id)?.confirmed).toBe(1);
    expect(api.listBooks).toHaveBeenCalledOnce();
    expect(api.queryBooks).not.toHaveBeenCalled();
  });

  it("reloads an active On Kindle filter using only the final published membership", async () => {
    const { browser, api, render, clear } = await harness();
    browser.setKindleStatuses(new Map([["a", "confirmed"], ["b", "not-on-kindle"]]), counts);
    browser.setKindleInventory(inventory());
    await browser.applyKindleSummaryFilter("on-kindle");
    expect(browser.snapshot.page?.items.map(({ id }) => id)).toEqual(["a"]);
    clear();
    browser.batchUpdates(() => {
      browser.setKindleStatuses(new Map([["a", "not-on-kindle"], ["b", "confirmed"]]), counts);
      browser.setKindleInventory(inventory("b"));
      expect(api.queryBooks).not.toHaveBeenCalled();
    });
    expect(render).toHaveBeenCalledExactlyOnceWith("all");
    expect(api.listBooks).not.toHaveBeenCalled();
    expect(api.queryBooks).toHaveBeenCalledExactlyOnceWith(profile.id, expect.objectContaining({ includeBookIds: ["b"] }), expect.any(AbortSignal));
    await vi.waitFor(() => expect(browser.snapshot.page?.items.map(({ id }) => id)).toEqual(["b"]));
    expect(api.queryBooks).toHaveBeenCalledOnce();
  });

  it("coalesces a verified-transfer fallback without upgrading its Possible evidence", async () => {
    const { browser, api, render, published } = await harness();
    browser.batchUpdates(() => {
      browser.setKindleInventory(inventory("a", "possible"));
      browser.setKindleBookStatus(profile.id, "a", "possible");
      expect(browser.snapshot.kindleStatus.get("a")).toBe("possible");
    });
    expect(render).toHaveBeenCalledExactlyOnceWith("all");
    expect(api.listBooks).toHaveBeenCalledOnce();
    expect(published[0]?.kindleInventory?.matching?.status).toBe("partial");
    expect(published[0]?.kindleInventory?.items.every(({ match }) => match === "possible")).toBe(true);
    expect(published[0]?.kindleStatus.get("a")).toBe("possible");
  });

  it("keeps event-stream loss authoritative even when a fresh comparison is batched", async () => {
    const { browser, api, render, published, loseEventStream, clear } = await harness();
    loseEventStream();
    clear();
    browser.batchUpdates(() => {
      browser.setKindleStatuses(new Map([["a", "confirmed"], ["b", "not-on-kindle"]]), counts);
      expect(browser.snapshot.kindleStatus.get("a")).toBe("unknown");
      browser.setKindleInventory(inventory());
      expect(browser.snapshot.kindleStatus.get("a")).toBe("unknown");
      expect(browser.snapshot.kindleInventory?.matching?.status).toBe("unavailable");
      expect(render).not.toHaveBeenCalled();
    });
    expect(render).toHaveBeenCalledExactlyOnceWith("all");
    expect(api.listBooks).toHaveBeenCalledOnce();
    expect(published[0]?.kindleStatusCountsByProfile.get(profile.id)).toEqual({ confirmed: 0, possible: 0, notOnKindle: 0, unknown: 2 });
    expect(published[0]?.kindleInventory?.items.every(({ match }) => match === "possible")).toBe(true);
  });

  it.each(["disconnect", "last-seen"] as const)("immediately retires stale authority on %s and publishes once", async (reason) => {
    const { browser, api, render } = await harness();
    browser.batchUpdates(() => {
      browser.setKindleStatuses(new Map([["a", "confirmed"], ["b", "not-on-kindle"]]), counts);
      browser.setKindleInventory(reason === "disconnect" ? undefined : { ...inventory(), completeness: "last-seen" });
      expect(browser.snapshot.kindleStatus.get("a")).toBe(reason === "disconnect" ? undefined : "unknown");
      expect(browser.snapshot.kindleStatusCountsByProfile.get(profile.id)?.confirmed ?? 0).toBe(0);
      expect(render).not.toHaveBeenCalled();
    });
    expect(render).toHaveBeenCalledExactlyOnceWith("all");
    expect(api.listBooks).toHaveBeenCalledOnce();
  });

  it("flushes nested updates once when the callback throws and restores immediate standalone updates", async () => {
    const { browser, api, render, clear } = await harness();
    const failure = new Error("Publication interrupted");
    expect(() => browser.batchUpdates(() => {
      browser.setKindleStatuses(new Map([["a", "confirmed"]]), counts);
      browser.batchUpdates(() => {
        browser.setKindleInventory(inventory());
      });
      expect(render).not.toHaveBeenCalled();
      expect(api.listBooks).not.toHaveBeenCalled();
      throw failure;
    })).toThrow(failure);
    expect(render).toHaveBeenCalledExactlyOnceWith("all");
    expect(api.listBooks).toHaveBeenCalledOnce();
    expect(browser.snapshot.kindleInventory?.items).toHaveLength(2);
    clear();
    browser.setKindleBookStatus(profile.id, "a", "possible");
    expect(render).toHaveBeenCalledExactlyOnceWith("all");
    expect(api.listBooks).toHaveBeenCalledOnce();
    expect(browser.snapshot.kindleStatus.get("a")).toBe("possible");
  });

  it("merges independent results and device scopes without starting a catalog reload", async () => {
    const { browser, api, render } = await harness();
    browser.batchUpdates(() => {
      browser.setLayout("list");
      browser.updateKindleInventoryQuery("A title");
      expect(browser.snapshot.layout).toBe("list");
      expect(browser.snapshot.kindleInventoryQuery).toBe("A title");
      expect(render).not.toHaveBeenCalled();
    });
    expect(render).toHaveBeenCalledExactlyOnceWith("results-and-device");
    expect(api.listBooks).not.toHaveBeenCalled();
    expect(api.queryBooks).not.toHaveBeenCalled();
  });

  it("does not render or reload an empty batch", async () => {
    const { browser, api, render } = await harness();
    browser.batchUpdates(() => undefined);
    expect(render).not.toHaveBeenCalled();
    expect(api.listBooks).not.toHaveBeenCalled();
    expect(api.queryBooks).not.toHaveBeenCalled();
  });

  it("still reloads after a renderer throws and leaves later nested batches usable", async () => {
    const { browser, api, render, clear } = await harness();
    const failure = new Error("Renderer unavailable");
    render.mockImplementationOnce(() => { throw failure; });
    expect(() => browser.batchUpdates(() => {
      browser.setKindleStatuses(new Map([["a", "confirmed"], ["b", "not-on-kindle"]]), counts);
    })).toThrow(failure);
    expect(browser.snapshot.kindleStatus.get("a")).toBe("confirmed");
    expect(render).toHaveBeenCalledExactlyOnceWith("all");
    expect(api.listBooks).toHaveBeenCalledOnce();

    clear();
    browser.batchUpdates(() => {
      browser.batchUpdates(() => {
        browser.setKindleInventory(inventory("a", "possible"));
      });
      browser.setKindleBookStatus(profile.id, "a", "possible");
      expect(render).not.toHaveBeenCalled();
      expect(api.listBooks).not.toHaveBeenCalled();
    });
    expect(browser.snapshot.kindleStatus.get("a")).toBe("possible");
    expect(render).toHaveBeenCalledExactlyOnceWith("all");
    expect(api.listBooks).toHaveBeenCalledOnce();
  });
});
