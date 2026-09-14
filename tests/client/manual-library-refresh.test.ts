// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogBrowser, type CatalogBrowserOptions, type CatalogBrowserSnapshot } from "../../client/src/catalog-browser";
import type { CatalogApi, CatalogBook, CatalogEvent, CatalogProfile, CatalogRoot } from "../../client/src/catalog-client";
import { MAX_CATALOG_ROOTS_PER_PROFILE } from "../../shared/catalog-contracts";

const profile: CatalogProfile = {
  id: "library-one", name: "Library", description: "Books", initial: "L", sourceLabel: "Books",
  enabled: true, rootCount: 2, availableRootCount: 2, bookCount: 1,
};
const otherProfile = { ...profile, id: "library-two", name: "Other library" };
const root: CatalogRoot = {
  id: "root-one", profileId: profile.id, label: "Books", path: "/libraries/books",
  recursive: true, watch: true, enabled: true, status: "watching",
};
const secondRoot = { ...root, id: "root-two", label: "More books", path: "/libraries/more" };
const book: CatalogBook = {
  id: "book-one", profileId: profile.id, rootId: root.id, sourceFilename: "one.epub", title: "Book One",
  authors: ["Author"], authorSort: "Author", subjects: [], identifiers: [], format: "EPUB", size: 100,
  contentHash: "a".repeat(64), presentationVersion: "a".repeat(64), metadataComplete: true, available: true,
  addedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
const browsers: CatalogBrowser[] = [];
afterEach(() => { browsers.splice(0).forEach((browser) => browser.dispose()); vi.useRealTimers(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function harness(roots: readonly CatalogRoot[] = [root, secondRoot], options: CatalogBrowserOptions = {}) {
  let onEvent!: (event: CatalogEvent) => void;
  const api = {
    getStatus: vi.fn().mockResolvedValue({ available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" }),
    listProfiles: vi.fn().mockResolvedValue([profile, otherProfile]),
    listRoots: vi.fn(async (id: string, _signal?: AbortSignal) => id === profile.id ? roots : [{ ...root, id: "other-root", profileId: otherProfile.id }]),
    getFilters: vi.fn().mockResolvedValue({ authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [] }),
    listBooks: vi.fn(async (id: string) => ({ items: id === profile.id ? [book] : [], total: id === profile.id ? 1 : 0, limit: 24, offset: 0 })),
    getSendQueue: vi.fn(async (profileId: string) => ({ profileId, revision: 0, entries: [], total: 0, totalSourceBytes: 0 })),
    listSmartShelves: vi.fn().mockResolvedValue([]),
    rescanRoot: vi.fn(async (_id: string, _root: string, _signal?: AbortSignal): Promise<void> => undefined),
    subscribeEvents: vi.fn((event: typeof onEvent, _error: () => void, opened: () => void) => { onEvent = event; opened(); return () => undefined; }),
  };
  const onCatalogChanged = vi.fn(async () => undefined);
  const render = vi.fn();
  const browser = new CatalogBrowser(api as unknown as CatalogApi, { onCatalogChanged }, render, { getItem: () => null, setItem: () => undefined }, options);
  browsers.push(browser);
  await browser.start();
  await vi.waitFor(() => expect(browser.snapshot.sendQueueState).toBe("ready"));
  return { browser, api, render, onCatalogChanged, emit: (event: CatalogEvent) => onEvent(event) };
}

describe("manual library refresh", () => {
  it("checks enabled saved roots of the browsing profile, never the separate Settings selection", async () => {
    const { browser, api } = await harness([root, secondRoot, root, { ...root, id: "disabled", enabled: false }, { ...root, id: "draft-new" }]);
    await browser.selectSettingsLibrary(otherProfile.id);
    expect(browser.snapshot.filters.profileId).toBe(profile.id);
    expect(browser.snapshot.settingsLibraryId).toBe(otherProfile.id);
    const pending = deferred<void>();
    api.rescanRoot.mockImplementationOnce(() => pending.promise);
    const refreshing = browser.refreshLibrary();
    expect(browser.snapshot.libraryRefreshing).toBe(true);
    expect(api.rescanRoot).toHaveBeenCalledTimes(1);
    await browser.refreshLibrary();
    await browser.rescanRoot("other-root"); // Separate Settings library is independent.
    expect(api.rescanRoot).toHaveBeenCalledTimes(2);
    pending.resolve();
    await refreshing;
    expect(api.rescanRoot.mock.calls.map(([id, rootId]) => [id, rootId])).toEqual([
      [profile.id, root.id], [otherProfile.id, "other-root"], [profile.id, secondRoot.id],
    ]);
    expect(browser.snapshot.libraryRefreshing).toBe(false);
    expect(browser.snapshot.libraryRefreshError).toBeUndefined();
    expect(browser.snapshot.announcement).toMatch(/check started.*appear automatically/i);
    expect(browser.snapshot.activityEvents.some((event) => event.title === "Library check started" && event.profileId === profile.id)).toBe(true);
  });

  it("does not reset the visible page, filters, scroll, selection, or Kindle matching", async () => {
    const { browser, api } = await harness();
    browser.setLayout("list");
    browser.toggleBookSelection(book.id, true);
    browser.setScrollPosition(650);
    browser.setKindleBookStatus(profile.id, book.id, "confirmed");
    await browser.reloadBooks(true);
    const before = browser.snapshot;
    const calls = api.listBooks.mock.calls.length;
    api.listRoots.mockResolvedValueOnce([{ ...root, status: "scanning" }, secondRoot]);
    await browser.refreshLibrary();
    expect(api.listBooks.mock.calls).toHaveLength(calls);
    for (const key of ["page", "filters", "selectedBookIds", "kindleStatus", "kindleStatusCountsByProfile", "contextScrollY"] as const) {
      expect(browser.snapshot[key]).toBe(before[key]);
    }
    expect(browser.snapshot.rootsByProfile.get(profile.id)?.[0]?.status).toBe("scanning");
  });

  it("prevents overlapping Settings scans in the same library", async () => {
    const { browser, api } = await harness();
    const pending = deferred<void>();
    api.rescanRoot.mockImplementationOnce(() => pending.promise);
    const refreshing = browser.refreshLibrary();
    await browser.rescanRoot(root.id);
    await browser.refreshLibrary();
    expect(api.rescanRoot).toHaveBeenCalledTimes(1);
    pending.resolve();
    await refreshing;
    expect(api.rescanRoot).toHaveBeenCalledTimes(2);
  });

  it.each([
    { sendBusy: true }, { bulkActionBusy: true }, { settingsSaving: true }, { settingsRefreshing: true },
    { loadState: "loading" }, { rescanningRootIds: new Set([root.id]) },
  ] satisfies Partial<CatalogBrowserSnapshot>[])("does not request scans while guarded by %j", async (state) => {
    const { browser, api } = await harness();
    Object.assign(browser.snapshot, state);
    await browser.refreshLibrary();
    expect(api.rescanRoot).not.toHaveBeenCalled();
  });

  it.each([{ roots: [] }, { roots: [{ ...root, enabled: false }] }, { roots: [{ ...root, status: "scanning" as const }] }])("does not request scans without idle enabled roots: %j", async ({ roots }) => {
    const { browser, api } = await harness(roots);
    await browser.refreshLibrary();
    expect(api.rescanRoot).not.toHaveBeenCalled();
  });

  it("permits a read-only-settings installation to request read-only library scans", async () => {
    const { browser, api } = await harness();
    Object.assign(browser.snapshot, { serviceStatus: { ...browser.snapshot.serviceStatus, settingsMode: "read-only" } });
    await browser.refreshLibrary();
    expect(api.rescanRoot).toHaveBeenCalledTimes(2);
  });

  it("bounds root requests and reports overflow without silently skipping folders", async () => {
    const { browser, api } = await harness(Array.from({ length: MAX_CATALOG_ROOTS_PER_PROFILE + 1 }, (_, i) => ({ ...root, id: `root-${i}` })));
    await browser.refreshLibrary();
    expect(api.rescanRoot).not.toHaveBeenCalled();
    expect(browser.snapshot.libraryRefreshError).toMatch(/too many folders/);
  });

  it("reports partial acceptance in the dashboard and activity without hiding books or leaking server errors", async () => {
    const { browser, api } = await harness();
    api.rescanRoot.mockRejectedValueOnce(new Error("sensitive /server/path failed"));
    const page = browser.snapshot.page;
    await browser.refreshLibrary();
    expect(api.rescanRoot).toHaveBeenCalledTimes(2);
    expect(browser.snapshot.libraryRefreshError).toContain("1 of 2 folders");
    expect(browser.snapshot.announcement).toBe(browser.snapshot.libraryRefreshError);
    expect(browser.snapshot.settingsError).toBeUndefined();
    expect(browser.snapshot.page).toBe(page);
    expect(browser.snapshot.activityEvents[0]).toMatchObject({ title: "Library check needs attention", tone: "warning", profileId: profile.id });
    expect(JSON.stringify(browser.snapshot.activityEvents)).not.toContain("sensitive");
  });

  it("reports all failures, releases busy state, and permits an explicit retry", async () => {
    const { browser, api } = await harness();
    api.rescanRoot.mockRejectedValue(new Error("offline"));
    await browser.refreshLibrary();
    expect(browser.snapshot.libraryRefreshing).toBe(false);
    expect(browser.snapshot.libraryRefreshError).toMatch(/could not start/);
    expect(browser.snapshot.activityEvents[0]?.tone).toBe("error");
    api.rescanRoot.mockResolvedValue(undefined);
    await browser.refreshLibrary();
    expect(browser.snapshot.libraryRefreshError).toBeUndefined();
    expect(api.rescanRoot).toHaveBeenCalledTimes(4);
  });

  it("does not claim the scan failed when only the status refresh fails", async () => {
    const { browser, api } = await harness();
    api.listRoots.mockRejectedValueOnce(new Error("offline"));
    await browser.refreshLibrary();
    expect(browser.snapshot.libraryRefreshError).toMatch(/check started, but its status could not be refreshed/i);
    expect(browser.snapshot.libraryRefreshing).toBe(false);
  });

  it("times out a stalled request and stops before queuing later roots", async () => {
    const { browser, api } = await harness(undefined, { requestTimeoutMs: 25 });
    vi.useFakeTimers();
    api.rescanRoot.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = browser.refreshLibrary();
    const signal = api.rescanRoot.mock.calls[0]?.[2];
    await vi.advanceTimersByTimeAsync(25);
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(api.rescanRoot).toHaveBeenCalledTimes(1);
    expect(browser.snapshot.libraryRefreshError).toMatch(/timed out.*may still be running/);
    expect(browser.snapshot.libraryRefreshing).toBe(false);
  });

  it.each(["profile switch", "dispose"])("cancels pending requests on %s and ignores late results", async (reason) => {
    const { browser, api, render } = await harness();
    const deferredRequest = deferred<void>();
    api.rescanRoot.mockImplementationOnce(() => deferredRequest.promise);
    const pending = browser.refreshLibrary();
    const signal = api.rescanRoot.mock.calls[0]?.[2];
    if (reason === "dispose") browser.dispose();
    else await browser.selectProfile(otherProfile.id);
    await pending;
    const calls = render.mock.calls.length;
    const before = browser.snapshot;
    expect(signal?.aborted).toBe(true);
    expect(browser.snapshot.libraryRefreshing).toBe(false);
    deferredRequest.resolve();
    await Promise.resolve();
    expect(api.rescanRoot).toHaveBeenCalledTimes(1);
    expect(render.mock.calls).toHaveLength(calls);
    expect(browser.snapshot).toBe(before);
  });

  it("does not overwrite newer source status delivered by live reconciliation", async () => {
    const { browser, api, emit, onCatalogChanged } = await harness();
    const oldRoots = deferred<readonly CatalogRoot[]>();
    api.listRoots.mockImplementationOnce(() => oldRoots.promise);
    const pending = browser.refreshLibrary();
    await vi.waitFor(() => expect(api.rescanRoot).toHaveBeenCalledTimes(2));
    emit({ id: "fresh-scan", type: "root.scan.started", profileId: profile.id, rootId: root.id, at: new Date().toISOString() });
    api.listRoots.mockResolvedValue([{ ...root, status: "scanning" }, secondRoot]);
    await vi.waitFor(() => expect(onCatalogChanged).toHaveBeenCalled());
    oldRoots.resolve([root, secondRoot]);
    await pending;
    expect(browser.snapshot.rootsByProfile.get(profile.id)?.[0]?.status).toBe("scanning");
  });

  it("cancels pending requests when a remote profile deletion changes the active library", async () => {
    const { browser, api, emit } = await harness();
    api.rescanRoot.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = browser.refreshLibrary();
    const signal = api.rescanRoot.mock.calls[0]?.[2];
    api.listProfiles.mockResolvedValue([otherProfile]);
    emit({ id: "removed-profile", type: "profile.deleted", profileId: profile.id, at: new Date().toISOString() });
    await vi.waitFor(() => expect(browser.snapshot.filters.profileId).toBe(otherProfile.id));
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(api.rescanRoot).toHaveBeenCalledTimes(1);
    expect(browser.snapshot.libraryRefreshing).toBe(false);
    expect(browser.snapshot.libraryRefreshError).toBeUndefined();
  });
});
