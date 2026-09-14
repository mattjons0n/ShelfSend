// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogKindleInventory, CatalogKindleInventoryItem } from "../../client/src/catalog-browser";
import type { CatalogApi, CatalogBook, CatalogBookMatchQuery, CatalogBookQuery, CatalogProfile } from "../../client/src/catalog-client";
import { EMPTY_CATALOG_FILTERS } from "../../client/src/library-prototype";
import { decodeLibraryRoute } from "../../client/src/library-route";
import { DebugLog } from "../../client/src/log";
import { initialAppState, type AppState } from "../../client/src/state";
import { AppView, type AppViewHandlers } from "../../client/src/view";

const PROFILE: CatalogProfile = {
  id: "inventory-profile", name: "Home library", description: "", initial: "H", sourceLabel: "Home books",
  enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 3,
};
const OTHER_PROFILE: CatalogProfile = { ...PROFILE, id: "other-profile", name: "Travel library", bookCount: 0 };
const BOOK: CatalogBook = {
  id: "local-book", profileId: PROFILE.id, rootId: "inventory-root", sourceFilename: "home-book.epub",
  title: "Local library book", authors: ["Home Author"], authorSort: "Author, Home", identifiers: [], subjects: [], language: "en",
  format: "epub", size: 1200, contentHash: "a".repeat(64), available: true, metadataComplete: true,
  addedAt: "2026-09-14T08:00:00Z", updatedAt: "2026-09-14T08:00:00Z",
};
const BOOKS: readonly CatalogBook[] = [
  BOOK,
  { ...BOOK, id: "possible-local-book", title: "Possible local copy" },
  { ...BOOK, id: "absent-local-book", title: "Not on the device" },
];
const ITEMS: readonly CatalogKindleInventoryItem[] = [
  { id: "device-home", filename: "home-book.azw3", title: "Home device copy", author: "Home Author", format: "AZW3", size: 1400, managed: true, bookId: BOOK.id, match: "confirmed" },
  { id: "device-other", filename: "travel-book.kfx", title: "A different library's book", author: "Travel Author", format: "KFX", size: 1500, managed: false, bookId: "other-book", match: "confirmed" },
  { id: "device-only", filename: "personal-notes.pdf", title: "Only on my Kindle", author: "Device Author", format: "PDF", size: 1600, managed: false, match: "unmatched" },
];
const READY: AppState = {
  ...initialAppState(), secureContext: true, webUsbAvailable: true,
  device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981 } },
  selfTest: { kind: "passed", byteLength: 1037 }, catalogInventoryState: "ready",
};

function inventory(items: readonly CatalogKindleInventoryItem[] = ITEMS): CatalogKindleInventory {
  return {
    deviceLabel: "Travel Kindle", scannedAt: new Date().toISOString(), completeness: "complete", total: items.length,
    truncated: false, items, matching: { status: "unavailable", matchedProfiles: 0, failedProfiles: 1 },
  };
}

function handlers(): AppViewHandlers {
  const noop = () => undefined;
  return {
    onTargetProfileSaved: noop, onEpubSelected: noop, onConvert: noop, onDownloadConverted: noop,
    onConnect: vi.fn(), onDisconnect: vi.fn(), onCatalogDisconnectRequested: vi.fn(), onSelfTest: vi.fn(), onSendIntegrated: noop,
    onIntegratedOpenConfirmed: noop, onCleanupInspectionConfirmed: noop, onCopyLog: noop,
  };
}

function fakeApi(profiles: readonly CatalogProfile[] = [PROFILE, OTHER_PROFILE]) {
  const books = (profileId: string, query: CatalogBookMatchQuery = {}) => {
    let items = BOOKS.filter((book) => book.profileId === profileId);
    if (query.q) items = items.filter((book) => book.title.toLowerCase().includes(query.q!.toLowerCase()));
    if (query.includeBookIds) items = items.filter((book) => query.includeBookIds!.includes(book.id));
    if (query.excludeBookIds) items = items.filter((book) => !query.excludeBookIds!.includes(book.id));
    return { items, total: items.length, offset: query.offset ?? 0, limit: query.limit ?? 24 };
  };
  return {
    getStatus: vi.fn(async () => ({ available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" })),
    listProfiles: vi.fn(async () => profiles),
    listRoots: vi.fn(async (profileId: string) => [{ id: "inventory-root", profileId, label: "Home books", path: "/libraries/home", recursive: true, watch: true, enabled: true, status: "watching" }]),
    getFilters: vi.fn(async () => EMPTY_CATALOG_FILTERS),
    listBooks: vi.fn(async (profileId: string, query: CatalogBookQuery = {}) => books(profileId, query)),
    queryBooks: vi.fn(async (profileId: string, query: CatalogBookMatchQuery = {}) => books(profileId, query)),
    subscribeEvents: vi.fn((...args: Parameters<CatalogApi["subscribeEvents"]>) => {
      args[2]?.();
      return () => undefined;
    }),
  };
}

async function mount(api = fakeApi()) {
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const root = document.createElement("div");
  document.body.append(root);
  const callbacks = handlers();
  const view = new AppView(root, READY, callbacks, new DebugLog(), { catalogApi: api as unknown as CatalogApi });
  await vi.waitFor(() => expect(api.listProfiles).toHaveBeenCalled());
  await vi.waitFor(() => expect(root.querySelector('[data-book-id="local-book"], #settings-heading, .library-error-state')).not.toBeNull());
  // Let the startup route restoration settle before simulating a later click.
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  view.setCatalogKindleInventory(inventory());
  return { root, view, api, callbacks };
}

async function openInventory(root: HTMLElement, source: "sidebar" | "header" = "sidebar") {
  const selector = source === "sidebar" ? '.library-nav [data-ui-view="on-kindle"]' : '.library-topbar [data-ui-action="show-kindle"]';
  const button = root.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  button!.click();
  await vi.waitFor(() => expect(root.querySelector(".kindle-library-view")).not.toBeNull());
  return root.querySelector<HTMLElement>(".kindle-library-view")!;
}

afterEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("standalone Kindle inventory navigation", () => {
  it.each([false, true])("keeps the guarded Disconnect control working after a device-page refresh: %s", async (refresh) => {
    const { root, view, callbacks } = await mount();
    await openInventory(root);
    if (refresh) {
      const search = root.querySelector<HTMLInputElement>("#kindle-inventory-search")!;
      search.value = "Only on my Kindle";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      view.setCatalogKindleInventory(inventory());
    }
    const disconnect = root.querySelector<HTMLButtonElement>('.kindle-library-view [data-ui-action="disconnect-catalog-device"]')!;
    expect(disconnect.disabled).toBe(false);
    disconnect.click();
    await vi.waitFor(() => expect(callbacks.onCatalogDisconnectRequested).toHaveBeenCalledTimes(1));
  });

  it.each(["sidebar", "header"] as const)("opens the complete device inventory from the %s without querying a library", async (source) => {
    const { root, view, api, callbacks } = await mount();
    view.setCatalogKindleStatuses(new Map([[BOOK.id, "confirmed"]]), new Map([[PROFILE.id, { confirmed: 1, possible: 0, notOnKindle: 0, unknown: 2 }]]));
    const librarySearch = root.querySelector<HTMLInputElement>("#library-search")!;
    librarySearch.value = "No catalog titles match this query";
    librarySearch.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(api.listBooks).toHaveBeenCalledWith(PROFILE.id, expect.objectContaining({ q: librarySearch.value }), expect.any(AbortSignal)));
    await vi.waitFor(() => expect(root.querySelectorAll(".library-book-card")).toHaveLength(0));
    api.listBooks.mockClear();
    api.queryBooks.mockClear();
    const deviceView = await openInventory(root, source);

    expect([...deviceView.querySelectorAll("[data-kindle-object-id]")].map((row) => row.getAttribute("data-kindle-object-id"))).toEqual(ITEMS.map((item) => item.id));
    expect(deviceView.textContent).toContain("Only on my Kindle");
    expect(deviceView.textContent).toContain("A different library's book");
    expect(deviceView.querySelector("#library-search, .library-quick-tabs, [data-ui-summary-filter], [data-ui-action='open-match-review'], [data-ui-action='remove-from-kindle']")).toBeNull();
    expect(root.querySelector('.library-nav [data-ui-view="on-kindle"]')?.textContent).toContain("3");
    expect(root.querySelector('.library-profile[aria-current="true"]')).toBeNull();
    expect(api.listBooks).not.toHaveBeenCalled();
    expect(api.queryBooks).not.toHaveBeenCalled();
    expect(callbacks.onConnect).not.toHaveBeenCalled();
    expect(callbacks.onSelfTest).not.toHaveBeenCalled();
  });

  it("keeps library On Kindle and Not on Kindle quick filters scoped to catalog books", async () => {
    const { root, view, api } = await mount();
    view.setCatalogKindleStatuses(new Map([[BOOK.id, "confirmed"], ["possible-local-book", "possible"], ["absent-local-book", "not-on-kindle"]]));
    root.querySelector<HTMLButtonElement>('[data-ui-kindle-filter="on-kindle"]')!.click();
    await vi.waitFor(() => expect(api.queryBooks).toHaveBeenCalledWith(PROFILE.id, expect.objectContaining({ includeBookIds: [BOOK.id] }), expect.any(AbortSignal)));
    expect([...root.querySelectorAll(".library-book-card")].map((book) => book.getAttribute("data-book-id"))).toEqual([BOOK.id]);
    expect(root.querySelector(".kindle-library-view")).toBeNull();
    expect(decodeLibraryRoute(window.location.hash)?.filters.view).toBe("all");

    root.querySelector<HTMLButtonElement>('[data-ui-kindle-filter="not-on-kindle"]')!.click();
    await vi.waitFor(() => expect(api.queryBooks).toHaveBeenCalledWith(PROFILE.id, expect.objectContaining({ includeBookIds: ["absent-local-book"] }), expect.any(AbortSignal)));
    expect([...root.querySelectorAll(".library-book-card")].map((book) => book.getAttribute("data-book-id"))).toEqual(["absent-local-book"]);
    await openInventory(root);
    expect(root.querySelectorAll(".kindle-library-view [data-kindle-object-id]")).toHaveLength(3);
  });

  it("returns from inventory to the selected library when its sidebar profile is clicked", async () => {
    const { root } = await mount();
    await openInventory(root);
    root.querySelector<HTMLButtonElement>(`[data-ui-profile="${PROFILE.id}"]`)!.click();
    await vi.waitFor(() => expect(root.querySelector("#library-heading")?.textContent).toBe(PROFILE.name));
    expect(root.querySelector(".kindle-library-view")).toBeNull();
    expect(root.querySelector(".library-quick-tabs")).not.toBeNull();
  });

  it.each(["no libraries", "catalog unavailable"] as const)("still opens the local inventory with %s", async (scenario) => {
    const api = fakeApi([]);
    if (scenario === "catalog unavailable") api.getStatus.mockRejectedValue(new Error("Catalog service offline"));
    const { root } = await mount(api);
    const deviceView = await openInventory(root);
    expect(deviceView.querySelectorAll("[data-kindle-object-id]")).toHaveLength(3);
    expect(root.querySelector(".library-main > .library-error-state")).toBeNull();
    expect(deviceView.querySelector(".onboarding-wizard, .settings-editor")).toBeNull();
  });
});

describe("standalone Kindle inventory interactions", () => {
  it("switches device gallery and list layouts without changing membership, search or library queries", async () => {
    const { root, view, api } = await mount();
    await openInventory(root);
    expect(root.querySelector("#kindle-library-heading")?.textContent).toBe("On Device");
    expect(root.querySelector('.library-nav [data-ui-view="on-kindle"]')?.textContent).toContain("On Device");
    expect(root.querySelector('.kindle-library-list[data-layout="grid"]')).not.toBeNull();
    api.listBooks.mockClear();
    api.queryBooks.mockClear();
    const details = root.querySelector<HTMLDetailsElement>('[data-kindle-object-id="device-home"] details')!;
    details.open = true;
    root.querySelector<HTMLButtonElement>('[data-ui-action="set-library-layout"][data-layout="list"]')!.click();
    expect(root.querySelector('.kindle-library-list[data-layout="list"]')).not.toBeNull();
    expect([...root.querySelectorAll("[data-kindle-object-id]")].map((row) => row.getAttribute("data-kindle-object-id"))).toEqual(ITEMS.map((item) => item.id));
    expect(root.querySelector<HTMLDetailsElement>('[data-kindle-object-id="device-home"] details')?.open).toBe(true);
    expect(decodeLibraryRoute(window.location.hash)?.layout).toBe("list");
    root.querySelector<HTMLButtonElement>('[data-ui-action="set-library-density"][data-density="compact"]')!.click();
    expect(root.querySelector('.kindle-library-view[data-density="compact"]')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('[data-ui-action="set-library-layout"][data-layout="grid"]')!.click();
    expect(root.querySelector('.kindle-library-list[data-layout="grid"]')).not.toBeNull();
    const search = root.querySelector<HTMLInputElement>("#kindle-inventory-search")!;
    search.value = "Only on my Kindle";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-ui-action="set-library-layout"][data-layout="list"]')!.click();
    expect(root.querySelectorAll("[data-kindle-object-id]")).toHaveLength(1);
    expect(root.querySelector("[data-kindle-object-id]")?.getAttribute("data-kindle-object-id")).toBe("device-only");
    expect(root.querySelector<HTMLInputElement>("#kindle-inventory-search")?.value).toBe("Only on my Kindle");
    expect(root.querySelector('[data-ui-action="send-book"], [data-ui-action="open-match-review"]')).toBeNull();
    expect(api.listBooks).not.toHaveBeenCalled();
    expect(api.queryBooks).not.toHaveBeenCalled();
    view.dispose();
  });

  it("preserves a device-gallery card-size preview and slider focus across inventory updates", async () => {
    const { root, view } = await mount();
    await openInventory(root);
    const slider = root.querySelector<HTMLInputElement>("#library-card-size")!;
    slider.focus();
    slider.value = "260";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelector<HTMLElement>('.kindle-library-list[data-layout="grid"]')?.style.getPropertyValue("--library-card-min-width")).toBe("260px");
    view.setCatalogKindleInventory(inventory([...ITEMS]));
    const replacement = root.querySelector<HTMLInputElement>("#library-card-size")!;
    expect(document.activeElement).toBe(replacement);
    expect(replacement.value).toBe("260");
    expect(root.querySelector<HTMLElement>('.kindle-library-list[data-layout="grid"]')?.style.getPropertyValue("--library-card-min-width")).toBe("260px");
    replacement.dispatchEvent(new Event("change", { bubbles: true }));
    expect(decodeLibraryRoute(window.location.hash)?.cardSize).toBe(260);
    root.querySelector<HTMLButtonElement>('[data-ui-action="set-library-layout"][data-layout="list"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-ui-action="set-library-layout"][data-layout="grid"]')!.click();
    expect(root.querySelector<HTMLInputElement>("#library-card-size")?.value).toBe("260");
    view.dispose();
  });

  it("pages all scanned items and searches beyond the first page without a catalog request", async () => {
    const { root, view, api } = await mount();
    const items = Array.from({ length: 205 }, (_, index): CatalogKindleInventoryItem => ({
      ...ITEMS[2], id: `device-${index}`, filename: `device-${index}.azw3`, title: index === 204 ? "Last device book" : `Device book ${index}`,
    }));
    view.setCatalogKindleInventory(inventory(items));
    await openInventory(root);
    api.listBooks.mockClear();
    api.queryBooks.mockClear();
    expect(root.querySelectorAll(".kindle-library-view [data-kindle-object-id]")).toHaveLength(100);
    root.querySelector<HTMLButtonElement>('.kindle-library-view [data-ui-action="kindle-page"][data-page-offset="100"]')!.click();
    expect(root.querySelector('[data-kindle-object-id="device-100"]')).not.toBeNull();
    expect(root.querySelector('[data-kindle-object-id="device-0"]')).toBeNull();

    const search = root.querySelector<HTMLInputElement>("#kindle-inventory-search")!;
    search.value = "Last device book";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelector('[data-kindle-object-id="device-204"]')).not.toBeNull();
    expect(root.querySelectorAll(".kindle-library-view [data-kindle-object-id]")).toHaveLength(1);
    expect(root.querySelector<HTMLInputElement>("#kindle-inventory-search")?.value).toBe("Last device book");
    expect(api.listBooks).not.toHaveBeenCalled();
    expect(api.queryBooks).not.toHaveBeenCalled();
  });

  it("keeps inventory search focus and selection through typing, device updates and full renders without scrolling", async () => {
    const { root, view } = await mount();
    await openInventory(root);
    vi.mocked(window.scrollTo).mockClear();
    vi.spyOn(window, "scrollY", "get").mockReturnValue(480);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const search = root.querySelector<HTMLInputElement>("#kindle-inventory-search")!;
    search.focus();
    search.value = "Kindle";
    search.setSelectionRange(1, 4, "forward");
    focus.mockClear();
    search.dispatchEvent(new Event("input", { bubbles: true }));

    const checkFocus = () => {
      const current = root.querySelector<HTMLInputElement>("#kindle-inventory-search")!;
      expect(document.activeElement).toBe(current);
      expect(current.value).toBe("Kindle");
      expect([current.selectionStart, current.selectionEnd, current.selectionDirection]).toEqual([1, 4, "forward"]);
      expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
      expect(window.scrollY).toBe(480);
    };
    checkFocus();
    view.setCatalogKindleInventory(inventory([...ITEMS, { ...ITEMS[2], id: "device-new", title: "Another Kindle book" }]));
    checkFocus();
    view.render(READY);
    checkFocus();
    expect(root.querySelectorAll(".kindle-library-view [data-kindle-object-id]")).toHaveLength(2);
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("keeps an already open inventory as last seen after disconnect, without pretending its files are current", async () => {
    const { root, view } = await mount();
    await openInventory(root);
    view.render(initialAppState());
    expect(root.querySelector('.library-nav [data-ui-view="on-kindle"]')).toBeNull();
    expect(root.querySelectorAll(".kindle-library-view [data-kindle-object-id]")).toHaveLength(3);
    expect(root.querySelector(".kindle-library-status")?.getAttribute("data-state")).toBe("last-seen");
    expect(root.querySelector(".kindle-library-view")?.textContent).toContain("not a current check");
    expect(root.querySelector('.kindle-library-view [data-ui-action="send-book"], .kindle-library-view [data-ui-action="remove-from-kindle"]')).toBeNull();
  });
});
