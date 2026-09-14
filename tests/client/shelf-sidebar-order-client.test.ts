import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogBrowser } from "../../client/src/catalog-browser";
import { CatalogApiError, HttpCatalogClient, type CatalogApi, type CatalogEvent, type CatalogProfile, type ShelfSidebarOrder, type SmartShelf } from "../../client/src/catalog-client";
import { BUILT_IN_SMART_SHELVES, orderedSidebarShelves, visibleBuiltInSmartShelves } from "../../client/src/smart-shelves";
import { BUILT_IN_SHELF_IDS, MAX_SIDEBAR_SHELF_IDS } from "../../shared/shelf-order";
import { writeLibraryBrowserContext } from "../../client/src/library-browser-context";
import { initialLibraryFilters } from "../../client/src/library-prototype";

const profiles: CatalogProfile[] = ["first", "second"].map((id) => ({
  id, name: id, description: "", initial: "L", sourceLabel: "Books", enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 0,
}));
function shelf(id: string, pinnedRank: number | null = 0): SmartShelf {
  return { id, profileId: "first", name: id, pinnedRank, query: { version: 1 }, revision: 1, serverCount: 0, createdAt: "2026-09-01", updatedAt: "2026-09-01" };
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const browsers: CatalogBrowser[] = [];
afterEach(() => { for (const browser of browsers.splice(0)) browser.dispose(); vi.useRealTimers(); });

function fixture(options: { shelves?: SmartShelf[]; omitOrderApi?: boolean; timeout?: number; storage?: Pick<Storage, "getItem" | "setItem">; reading?: boolean } = {}) {
  const shelves = options.shelves ?? [];
  const orders = new Map(profiles.map(({ id }) => [id, { profileId: id, revision: 0, shelfIds: [...BUILT_IN_SHELF_IDS, ...shelves.filter((item) => item.pinnedRank !== null).map((item) => item.id)] } as ShelfSidebarOrder]));
  let onEvent: (event: CatalogEvent) => void = () => {};
  const getShelfSidebarOrder = vi.fn(async (profileId: string, _signal?: AbortSignal) => orders.get(profileId)!);
  const reorderShelfSidebar = vi.fn(async (profileId: string, input: { expectedRevision: number; shelfIds: readonly string[] }, _signal?: AbortSignal) => {
    const current = orders.get(profileId)!;
    const updated = { profileId, revision: current.revision + 1, shelfIds: [...input.shelfIds] };
    orders.set(profileId, updated);
    return updated;
  });
  const api = {
    getStatus: vi.fn().mockResolvedValue({ available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" }),
    listProfiles: vi.fn().mockResolvedValue(profiles),
    listRoots: vi.fn(async (profileId: string) => [{ id: `root-${profileId}`, profileId, label: "Books", path: "/libraries/books", recursive: true, watch: true, enabled: true, status: "watching" }]),
    getFilters: vi.fn().mockResolvedValue({ authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [] }),
    listBooks: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 24, offset: 0 }),
    getSendQueue: vi.fn(async (profileId: string) => ({ profileId, revision: 0, entries: [], total: 0, totalSourceBytes: 0 })),
    listSmartShelves: vi.fn(async (profileId: string) => shelves.map((item) => ({ ...item, profileId }))),
    ...(options.omitOrderApi ? {} : { getShelfSidebarOrder, reorderShelfSidebar }),
    subscribeEvents: vi.fn((callback: (event: CatalogEvent) => void, _error: unknown, opened: () => void) => { onEvent = callback; opened(); return () => {}; }),
  };
  const browser = new CatalogBrowser(api as unknown as CatalogApi, {}, () => {}, options.storage ?? { getItem: () => null, setItem: () => {} }, {
    requestTimeoutMs: options.timeout,
    ...(options.reading ? { readingPresentationGate: { version: 1, enabled: true } as const } : {}),
  });
  browsers.push(browser);
  return { browser, api, orders, getShelfSidebarOrder, reorderShelfSidebar, emit: (profileId = "first") => onEvent({ id: "shelf-event", type: "shelf.updated", profileId } as CatalogEvent) };
}

async function start(f: ReturnType<typeof fixture>): Promise<void> {
  await f.browser.start();
  await vi.waitFor(() => expect(f.browser.snapshot.smartShelvesState).toBe("ready"));
}

describe("visible sidebar shelf order", () => {
  it("hides Read until enabled without removing its definition or saved place", () => {
    expect(visibleBuiltInSmartShelves().some(({ id }) => id === "builtin-read-books")).toBe(false);
    const ids = ["builtin-favorites", "builtin-read-books", "builtin-recent"];
    expect(orderedSidebarShelves([], ids).map(({ id }) => id)).not.toContain("builtin-read-books");
    expect(orderedSidebarShelves([], ids, true).map(({ id }) => id).slice(0, 3)).toEqual(ids);
    expect(BUILT_IN_SMART_SHELVES.find(({ id }) => id === "builtin-read-books")?.query.personal?.readBook).toBe(true);
  });

  it("mixes pinned custom and builtin shelves while pruning stale IDs and appending new ones", () => {
    const custom = [shelf("custom-a", 0), shelf("custom-b", 1), shelf("unpinned", null)];
    const ordered = orderedSidebarShelves(custom, ["custom-b", "removed", "builtin-favorites", "custom-b", "unpinned"]);
    expect(ordered.map(({ id }) => id)).toEqual(["custom-b", "builtin-favorites", "builtin-recent", "builtin-not-on-kindle", "builtin-want-to-read", "builtin-missing-cover", "custom-a"]);
  });
});

describe("CatalogBrowser durable sidebar ordering", () => {
  it("moves builtin and custom shelves together and retains the hidden Read entry", async () => {
    const f = fixture({ shelves: [shelf("custom-a")] });
    await start(f);
    await f.browser.reorderSidebarShelf("custom-a", "builtin-recent");
    expect(f.reorderShelfSidebar).toHaveBeenCalledWith("first", { expectedRevision: 0, shelfIds: ["builtin-read-books", "custom-a", ...BUILT_IN_SHELF_IDS.slice(1)] }, expect.any(AbortSignal));
    expect(f.browser.snapshot.sidebarShelfOrder?.revision).toBe(1);
    await f.browser.moveSidebarShelf("builtin-favorites", -1);
    expect(f.browser.snapshot.sidebarShelfOrder?.shelfIds).toEqual(["builtin-read-books", "custom-a", "builtin-recent", "builtin-favorites", "builtin-not-on-kindle", "builtin-want-to-read", "builtin-missing-cover"]);
    expect(f.browser.snapshot.sidebarShelfOrderBusy).toBe(false);
    expect(f.browser.snapshot.activeShelf).toBeUndefined();
  });

  it("moves forward to the target visible position and refuses hidden, unknown and edge moves", async () => {
    const f = fixture();
    await start(f);
    await f.browser.reorderSidebarShelf("builtin-recent", "builtin-favorites");
    expect(f.browser.snapshot.sidebarShelfOrder?.shelfIds.slice(0, 4)).toEqual(["builtin-read-books", "builtin-not-on-kindle", "builtin-favorites", "builtin-recent"]);
    await f.browser.moveSidebarShelf("builtin-not-on-kindle", -1);
    await f.browser.moveSidebarShelf("builtin-missing-cover", 1);
    await f.browser.reorderSidebarShelf("builtin-read-books", "builtin-recent");
    await f.browser.reorderSidebarShelf("unknown", "builtin-recent");
    await f.browser.reorderSidebarShelf("builtin-recent", "builtin-recent");
    expect(f.reorderShelfSidebar).toHaveBeenCalledOnce();
  });

  it("serializes saves and does not optimistically move a shelf before confirmation", async () => {
    const f = fixture();
    await start(f);
    const pending = deferred<ShelfSidebarOrder>();
    f.reorderShelfSidebar.mockImplementationOnce(() => pending.promise);
    const request = f.browser.moveSidebarShelf("builtin-favorites", -1);
    expect(f.browser.snapshot.sidebarShelfOrderBusy).toBe(true);
    expect(f.browser.snapshot.sidebarShelfOrder?.shelfIds).toEqual(BUILT_IN_SHELF_IDS);
    await f.browser.moveSidebarShelf("builtin-want-to-read", -1);
    expect(f.reorderShelfSidebar).toHaveBeenCalledOnce();
    pending.resolve({ profileId: "first", revision: 1, shelfIds: [...BUILT_IN_SHELF_IDS] });
    await request;
    expect(f.browser.snapshot.sidebarShelfOrderBusy).toBe(false);
  });

  it("refreshes conflicts without replaying the user's mutation or lowering revision checks", async () => {
    const f = fixture();
    await start(f);
    const externallySaved = { profileId: "first", revision: 7, shelfIds: [...BUILT_IN_SHELF_IDS].reverse() };
    f.orders.set("first", externallySaved);
    f.reorderShelfSidebar.mockRejectedValueOnce(new CatalogApiError(409, "sidebar_order_conflict", "conflict"));
    await f.browser.moveSidebarShelf("builtin-favorites", -1);
    expect(f.reorderShelfSidebar).toHaveBeenCalledOnce();
    expect(f.browser.snapshot.sidebarShelfOrder).toEqual(externallySaved);
    expect(f.browser.snapshot.sidebarShelfOrderError).toContain("changed elsewhere");
    expect(f.browser.snapshot.sidebarShelfOrderBusy).toBe(false);
  });

  it("refreshes changed shelf membership with conflicts, so the next explicit move includes new shelves", async () => {
    const f = fixture();
    await start(f);
    const newShelf = shelf("added-elsewhere");
    f.api.listSmartShelves.mockResolvedValue([newShelf]);
    f.orders.set("first", { profileId: "first", revision: 2, shelfIds: [...BUILT_IN_SHELF_IDS, newShelf.id] });
    f.reorderShelfSidebar.mockRejectedValueOnce(new CatalogApiError(409, "sidebar_order_conflict", "conflict"));
    await f.browser.moveSidebarShelf("builtin-favorites", -1);
    expect(f.browser.snapshot.smartShelves).toEqual([newShelf]);
    await f.browser.moveSidebarShelf(newShelf.id, -1);
    expect(f.reorderShelfSidebar.mock.lastCall?.[1]).toEqual({ expectedRevision: 2, shelfIds: [...BUILT_IN_SHELF_IDS.slice(0, -1), newShelf.id, "builtin-missing-cover"] });
  });

  it("recovers canonical state after an uncertain failed save and keeps browsing usable", async () => {
    const f = fixture();
    await start(f);
    f.reorderShelfSidebar.mockRejectedValueOnce(new Error("offline"));
    await f.browser.moveSidebarShelf("builtin-favorites", -1);
    expect(f.browser.snapshot.sidebarShelfOrderState).toBe("ready");
    expect(f.browser.snapshot.sidebarShelfOrderError).toContain("could not be saved");
    await f.browser.applySmartShelf("builtin-favorites");
    expect(f.browser.snapshot.activeShelf?.id).toBe("builtin-favorites");
  });

  it("coalesces shelf events into one active and at most one pending order read", async () => {
    const f = fixture();
    await start(f);
    const pending = deferred<ShelfSidebarOrder>();
    f.getShelfSidebarOrder.mockImplementationOnce(() => pending.promise);
    f.emit();
    for (let index = 0; index < 20; index += 1) f.emit();
    expect(f.getShelfSidebarOrder).toHaveBeenCalledTimes(2);
    pending.resolve(f.orders.get("first")!);
    await vi.waitFor(() => expect(f.getShelfSidebarOrder).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(f.browser.snapshot.sidebarShelfOrderState).toBe("ready"));
    expect(f.browser.snapshot.smartShelvesState).toBe("ready");
  });

  it("defers event refreshes during saves and reads only after the save settles", async () => {
    const f = fixture();
    await start(f);
    const pending = deferred<ShelfSidebarOrder>();
    f.reorderShelfSidebar.mockImplementationOnce(() => pending.promise);
    const request = f.browser.moveSidebarShelf("builtin-favorites", -1);
    f.emit(); f.emit();
    expect(f.getShelfSidebarOrder).toHaveBeenCalledOnce();
    pending.resolve(f.orders.get("first")!);
    await request;
    expect(f.getShelfSidebarOrder).toHaveBeenCalledTimes(2);
  });

  it("aborts saves on profile switch and ignores late responses for the prior profile", async () => {
    const f = fixture();
    await start(f);
    const pending = deferred<ShelfSidebarOrder>();
    f.reorderShelfSidebar.mockImplementationOnce(() => pending.promise);
    const request = f.browser.moveSidebarShelf("builtin-favorites", -1);
    const signal = f.reorderShelfSidebar.mock.calls[0]![2]!;
    await f.browser.selectProfile("second");
    pending.resolve({ profileId: "first", revision: 99, shelfIds: [...BUILT_IN_SHELF_IDS].reverse() });
    await request;
    await vi.waitFor(() => expect(f.browser.snapshot.sidebarShelfOrder?.profileId).toBe("second"));
    expect(signal.aborted).toBe(true);
    expect(f.browser.snapshot.sidebarShelfOrder?.revision).toBe(0);
    expect(f.browser.snapshot.sidebarShelfOrderBusy).toBe(false);
  });

  it("aborts active reads on dispose and ignores late responses", async () => {
    const f = fixture();
    await start(f);
    const pending = deferred<ShelfSidebarOrder>();
    f.getShelfSidebarOrder.mockImplementationOnce(() => pending.promise);
    const refresh = f.browser.retryShelfSidebarOrder();
    const signal = f.getShelfSidebarOrder.mock.lastCall![1]!;
    f.browser.dispose();
    pending.resolve({ profileId: "first", revision: 99, shelfIds: [] });
    await refresh;
    expect(signal.aborted).toBe(true);
    expect(f.browser.snapshot.sidebarShelfOrder?.revision).toBe(0);
  });

  it("bounds a blackholed save and ignores a response arriving after timeout", async () => {
    const f = fixture({ timeout: 25 });
    await start(f);
    const pending = deferred<ShelfSidebarOrder>();
    f.reorderShelfSidebar.mockImplementationOnce(() => pending.promise);
    await f.browser.moveSidebarShelf("builtin-favorites", -1);
    expect(f.reorderShelfSidebar.mock.lastCall?.[2]?.aborted).toBe(true);
    expect(f.browser.snapshot.sidebarShelfOrderBusy).toBe(false);
    pending.resolve({ profileId: "first", revision: 99, shelfIds: [...BUILT_IN_SHELF_IDS].reverse() });
    await Promise.resolve();
    expect(f.browser.snapshot.sidebarShelfOrder?.revision).toBe(0);
    expect(f.browser.snapshot.sidebarShelfOrderError).toContain("could not be saved");
  });

  it("bounds a blackholed read, supports retry, and never keeps reordering enabled after load failure", async () => {
    const f = fixture({ timeout: 25 });
    await start(f);
    f.getShelfSidebarOrder.mockImplementationOnce(() => new Promise(() => {}));
    await f.browser.retryShelfSidebarOrder();
    expect(f.browser.snapshot.sidebarShelfOrderState).toBe("error");
    await f.browser.moveSidebarShelf("builtin-favorites", -1);
    expect(f.reorderShelfSidebar).not.toHaveBeenCalled();
    await f.browser.retryShelfSidebarOrder();
    expect(f.browser.snapshot.sidebarShelfOrderState).toBe("ready");
    expect(f.browser.snapshot.sidebarShelfOrderError).toBeUndefined();
  });

  it("allows ordinary browsing against an older API without pretending order is saved", async () => {
    const f = fixture({ omitOrderApi: true });
    await start(f);
    expect(f.browser.snapshot.sidebarShelfOrderState).toBe("error");
    expect(f.browser.snapshot.sidebarShelfOrderError).toContain("Update the server");
    await f.browser.moveSidebarShelf("builtin-favorites", -1);
    expect(f.reorderShelfSidebar).not.toHaveBeenCalled();
    await f.browser.applySmartShelf("builtin-favorites");
    expect(f.browser.snapshot.activeShelf?.id).toBe("builtin-favorites");
  });

  it("loads saved order from the server again when returning to a library", async () => {
    const f = fixture();
    await start(f);
    await f.browser.reorderSidebarShelf("builtin-missing-cover", "builtin-recent");
    const saved = f.browser.snapshot.sidebarShelfOrder;
    await f.browser.selectProfile("second");
    await vi.waitFor(() => expect(f.browser.snapshot.sidebarShelfOrder?.profileId).toBe("second"));
    await f.browser.selectProfile("first");
    await vi.waitFor(() => expect(f.browser.snapshot.sidebarShelfOrder).toEqual(saved));
  });

  it("does not reactivate the disabled Read shelf by clicks, saved context, or a routed shelf ID", async () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
    writeLibraryBrowserContext(storage, { filters: initialLibraryFilters("first"), layout: "grid", density: "comfortable", scrollY: 0, activeShelfId: "builtin-read-books" });
    const f = fixture({ storage });
    await start(f);
    expect(f.browser.snapshot.activeShelf).toBeUndefined();
    f.api.listBooks.mockClear();
    await f.browser.applySmartShelf("builtin-read-books");
    expect(f.api.listBooks).not.toHaveBeenCalled();
    await f.browser.applyLibraryRoute({ version: 1, profileId: "first", activeShelfId: "builtin-read-books", filters: initialLibraryFilters("first"), layout: "grid", density: "comfortable", overlays: { sendQueueOpen: false, shelfManagerOpen: false, activityOpen: false } });
    expect(f.browser.snapshot.activeShelf).toBeUndefined();
    expect(f.api.listBooks.mock.calls.some((call) => (call[1] as { readBook?: boolean } | undefined)?.readBook)).toBe(false);
  });
});

function jsonResponse(value: unknown): Response { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }); }
describe("HttpCatalogClient sidebar order contract", () => {
  it("reads and patches the profile-scoped revisioned endpoint", async () => {
    const order = { profileId: "profile/id", revision: 3, shelfIds: [...BUILT_IN_SHELF_IDS] };
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(order)).mockResolvedValueOnce(jsonResponse({ ...order, revision: 4 }));
    const api = new HttpCatalogClient({ fetch });
    expect(await api.getShelfSidebarOrder(order.profileId)).toEqual(order);
    expect(fetch.mock.calls[0]![0]).toContain("/profiles/profile%2Fid/shelves/sidebar-order");
    const input = { expectedRevision: 3, shelfIds: order.shelfIds };
    expect((await api.reorderShelfSidebar(order.profileId, input)).revision).toBe(4);
    expect(fetch.mock.calls[1]![1]).toMatchObject({ method: "PATCH", body: JSON.stringify(input) });
  });

  it.each([
    { profileId: "other", revision: 0, shelfIds: [] },
    { profileId: "first", revision: -1, shelfIds: [] },
    { profileId: "first", revision: 0.5, shelfIds: [] },
    { profileId: "first", revision: 0, shelfIds: ["x", "x"] },
    { profileId: "first", revision: 0, shelfIds: [null] },
    { profileId: "first", revision: 0, shelfIds: [...BUILT_IN_SHELF_IDS.slice(1)] },
    { profileId: "first", revision: 0, shelfIds: Array.from({ length: MAX_SIDEBAR_SHELF_IDS + 1 }, (_, index) => `shelf-${index}`) },
  ])("rejects a malformed, cross-profile or oversized order: %j", async (value) => {
    const api = new HttpCatalogClient({ fetch: vi.fn().mockResolvedValue(jsonResponse(value)) });
    await expect(api.getShelfSidebarOrder("first")).rejects.toMatchObject({ code: "INVALID_SHELF_SIDEBAR_ORDER" });
  });
});
