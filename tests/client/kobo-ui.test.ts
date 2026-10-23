// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { CatalogBrowser, type CatalogBrowserSnapshot, type CatalogHardwareHooks } from "../../client/src/catalog-browser";
import type { CatalogApi, CatalogBook, CatalogBookQuery, CatalogRoot } from "../../client/src/catalog-client";
import { bookActionCapabilities, bulkBookActionCapabilities } from "../../client/src/book-action-capabilities";
import { renderLibraryPrototype } from "../../client/src/library-prototype-view";
import { EMPTY_CATALOG_FILTERS, initialLibraryFilters } from "../../client/src/library-prototype";
import { initialAppState } from "../../client/src/state";
import { AppView } from "../../client/src/view";
import { DebugLog } from "../../client/src/log";

const book: CatalogBook = { id: "b", profileId: "p", rootId: "r", sourceFilename: "book.epub", title: "A book", authors: ["Author"], authorSort: "Author", subjects: [], identifiers: [], format: "EPUB", size: 1000, addedAt: "2026-01-01", updatedAt: "2026-01-01", metadataComplete: true, available: true };
const root: CatalogRoot = { id: "r", profileId: "p", label: "Books", path: "/libraries/books", recursive: true, watch: true, enabled: true, status: "watching" };
function snapshot(): CatalogBrowserSnapshot {
  return {
    loadState: "ready", profiles: [{ id: "p", name: "Home", description: "", initial: "H", sourceLabel: "Books", enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 1 }], rootsByProfile: new Map([["p", [root]]]), filters: initialLibraryFilters("p"), facets: EMPTY_CATALOG_FILTERS,
    page: { items: [book], total: 1, limit: 24, offset: 0 }, booksState: "ready", stale: false, liveUpdatesConnected: true,
    settingsSaving: false, settingsRefreshing: false, settingsConflict: false, settingsDirty: false, rescanningRootIds: new Set(), sendBusy: false,
    kindleStatus: new Map([["b", "confirmed"]]), kindleStatusCountsByProfile: new Map(), kindleInventoryOffset: 0, layout: "grid", selectedBookIds: new Set(), bulkActionBusy: false,
    sendQueueState: "ready", sendQueueOpen: false, sendQueueBusy: false, seriesState: "idle", seriesQuery: "", seriesSort: "name", smartShelves: [], smartShelvesState: "ready", shelfManagerOpen: false, annotations: new Map(), healthState: "ready", healthBooks: new Map(), healthFilter: { type: "all", severity: "all", ignored: false }, metadataLookupState: "ready", metadataLookupBusy: false, activityOpen: false, activityEvents: [],
    activeReader: "kobo", kobo: { status: "ready", supported: true, statuses: new Map([["b", "not-on-kindle"]]), countsByProfile: new Map([["p", { confirmed: 0, possible: 0, notOnKindle: 1, unknown: 0 }]]) },
  };
}
function rendered(value = snapshot()): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = renderLibraryPrototype({ ...initialAppState(), secureContext: true, webUsbAvailable: true }, value, "", '<div id="kindle-only-diagnostic">Kindle diagnostics</div>');
  return el;
}

describe("Kobo reader UI", () => {
  it("updates folder inventory search and paging through real view handlers", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const noop = () => undefined;
    const view = new AppView(element, initialAppState(), {
      onTargetProfileSaved: noop, onEpubSelected: noop, onConvert: noop, onDownloadConverted: noop,
      onConnect: noop, onDisconnect: noop, onSelfTest: noop, onSendIntegrated: noop,
      onIntegratedOpenConfirmed: noop, onCleanupInspectionConfirmed: noop, onCopyLog: noop,
    }, new DebugLog(), { autoStartCatalog: false, catalogApi: {} as CatalogApi });
    view.setKoboState({ ...snapshot().kobo!, reader: "kindle-drive", inventory: {
      complete: true, scannedAt: "2026-10-23", entries: Array.from({ length: 105 }, (_, index) => ({
        name: `file-${index}.mobi`, relativePath: `documents/file-${index}.mobi`, size: 128, lastModified: 1,
        metadata: { title: `Title ${index}`, authors: [`Author ${index}`], identifiers: [] },
      })),
    } });
    element.querySelector<HTMLButtonElement>('[data-ui-view="on-kindle"]')!.click();
    expect(element.querySelectorAll('.kindle-library-item')).toHaveLength(100);
    element.querySelector<HTMLButtonElement>('[data-ui-action="kindle-page"][data-page-offset="100"]')!.click();
    expect(element.querySelectorAll('.kindle-library-item')).toHaveLength(5);
    const search = element.querySelector<HTMLInputElement>('#kindle-inventory-search')!;
    search.value = "Author 104";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(element.querySelectorAll('.kindle-library-item')).toHaveLength(1);
    expect(element.querySelector('.kindle-library-book h2')?.textContent).toBe("Title 104");
    view.dispose();
    element.remove();
  });
  it("shows all scanned Kindle-drive files even without server-library matches", () => {
    const value = snapshot();
    const el = rendered({ ...value, activeReader: "kindle-drive", filters: { ...value.filters, view: "on-kindle" },
      page: { ...value.page!, items: [], total: 0 },
      kobo: { ...value.kobo!, reader: "kindle-drive", inventory: { complete: true, scannedAt: "2026-10-23", entries: [
        { name: "Existing.mobi", relativePath: "documents/Author/Existing.mobi", size: 128, lastModified: 1, metadata: { title: "Embedded title", authors: ["Embedded Author"], identifiers: [] } },
        { name: "Other.azw", relativePath: "documents/Other.azw", size: 256, lastModified: 1 },
      ] } } });
    expect(el.querySelector('[aria-label="Kindle USB-drive files"]')?.textContent).toContain("2 books and documents");
    expect(el.textContent).toContain("Existing.mobi");
    expect(el.textContent).toContain("Other.azw");
    expect(el.querySelector('.kindle-library-book h2')?.textContent).toBe("Embedded title");
    expect(el.querySelector('.kindle-library-book p')?.textContent).toBe("Embedded Author");
    expect(el.querySelector('[data-ui-view="on-kindle"] .library-nav-count')?.textContent).toBe("2");
    expect(el.querySelector('[data-ui-action="remove-book-from-kindle"]')).toBeNull();
    expect(el.querySelector('[data-ui-action="send-book"]')).toBeNull();
    expect(el.querySelector('[data-kindle-object-id]')).toBeNull();
    expect(el.querySelector('.library-stat-row')).toBeNull();
    expect(el.querySelector('[data-ui-action="search-kindle-inventory"]')).not.toBeNull();
  });
  it("renders Kindle USB-drive presence without borrowing MTP permissions", () => {
    const value: CatalogBrowserSnapshot = { ...snapshot(), activeReader: "kindle-drive", kobo: { ...snapshot().kobo!, reader: "kindle-drive" } };
    const el = rendered(value);
    expect(el.textContent).toContain("Kindle connected");
    expect(el.textContent).not.toContain("Kobo");
    expect(el.querySelector('[data-ui-action="send-book"]')?.textContent).toContain("Send to Kindle");
    expect(bookActionCapabilities({ ...book, format: "AZW3" }, initialAppState(), value)).toMatchObject({
      send: { enabled: true }, remove: { enabled: false }, update: { enabled: false }, exactKindleAssociation: false,
    });
    expect(el.querySelector('[data-ui-action="remove-book-from-kindle"]')).toBeNull();
    expect(rendered({ ...value, activityOpen: true }).querySelector('[aria-labelledby="activity-center-title"]')?.textContent).not.toContain("Kobo");
  });
  it("uses Kobo presence independently of retained Kindle evidence", () => {
    const value = snapshot();
    expect(bookActionCapabilities(book, initialAppState(), value)).toMatchObject({ send: { enabled: true, label: "Send to Kobo" }, exactKindleAssociation: false, update: { enabled: false }, remove: { enabled: false }, matchReview: { enabled: false, decisionEnabled: false } });
    expect(value.kindleStatus.get("b")).toBe("confirmed");
  });
  it("allows EPUB only and explains why AZW3 cannot be sent", () => {
    const actions = bookActionCapabilities({ ...book, format: "AZW3" }, initialAppState(), snapshot());
    expect(actions.send.enabled).toBe(false);
    expect(actions.send.reason).toMatch(/EPUB/i);
    expect(bulkBookActionCapabilities([{ ...book, format: "AZW3" }], new Set(["b"]), initialAppState(), snapshot()).send.count).toBe(0);
  });
  it("keeps off-page eligible EPUB selections sendable while excluding unsupported/unknown entries", () => {
    const value = snapshot();
    const offPage = { ...value, kobo: { ...value.kobo!, statuses: new Map([["b", "confirmed" as const], ["off-page", "not-on-kindle" as const], ["azw3", "unknown" as const]]) } };
    expect(bulkBookActionCapabilities([book], new Set(["b", "off-page", "azw3"]), initialAppState(), offPage).send).toMatchObject({ enabled: true, count: 1 });
  });
  it("renders a Kobo connection and reader-specific navigation without Kindle mutation controls", () => {
    const el = rendered();
    expect(el.textContent).toContain("Kobo connected");
    expect(el.querySelector('[data-ui-view="on-kindle"]')?.textContent).toContain("On Device");
    expect(el.querySelector('[data-ui-action="send-book"]')?.textContent).toContain("Send to Kobo");
    expect(el.querySelector('[data-ui-action="remove-book-from-kindle"]')).toBeNull();
    expect(el.querySelector('[data-ui-action="update-book-on-kindle"]')).toBeNull();
    expect(el.querySelector('[data-ui-action="disconnect-kobo"]')).not.toBeNull();
    expect(el.textContent).toMatch(/eject/i);
  });
  it("retains inline progress and click-to-cancel with a Kobo completion label", () => {
    const value = { ...snapshot(), pendingBook: book, pendingBookId: "b", sendBusy: true, sendPhase: "sending" as const, sendProgress: 42, sendCancellable: true };
    expect(rendered(value).querySelector('[data-ui-action="cancel-book-send"]')?.textContent).toContain("Sending 42%");
    expect(rendered(value).querySelector('[role="dialog"]')).toBeNull();
    expect(rendered({ ...value, sendBusy: false, sendPhase: "complete" }).textContent).toContain("Sent to Kobo");
  });
  it("keeps a compact named batch popup and hides Kindle diagnostics for Kobo", () => {
    const value = { ...snapshot(), pendingBook: book, pendingBookId: "b", sendBusy: true, sendPhase: "sending" as const, sendProgress: 50, batchTransfer: { id: "batch", total: 2, position: 1, verifiedBooks: [], retryBooks: [] } };
    const popup = rendered(value).querySelector('[role="dialog"]');
    expect(popup?.textContent).toContain("Book 1 of 2");
    expect(popup?.textContent).toContain("A book");
    expect(popup?.textContent).toContain("Keep your Kobo connected");
    expect(rendered({ ...snapshot(), filters: { ...initialLibraryFilters("p"), view: "settings" } }).querySelector("#kindle-only-diagnostic")).toBeNull();
  });
  it("offers an explicit Kobo option inside a closed connection chooser", () => {
    const value = snapshot();
    const el = rendered({ ...value, activeReader: "kindle", kobo: { ...value.kobo!, status: "disconnected" } });
    expect(el.querySelector('[data-ui-action="connect-kobo"]')).not.toBeNull();
    expect(el.querySelector('[data-ui-action="connect-catalog-device"]')).not.toBeNull();
    expect(el.querySelector('[data-ui-action="connect-kindle-drive"]')).not.toBeNull();
    expect(el.querySelector<HTMLElement>(".library-reader-options")?.hidden).toBe(true);
  });
  it("invokes the directory-connection hook synchronously only after a user click", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const onKoboConnect = vi.fn();
    const onKindleDriveConnect = vi.fn();
    const noop = () => undefined;
    const state = { ...initialAppState(), secureContext: true, webUsbAvailable: true };
    const view = new AppView(element, state, {
      onTargetProfileSaved: noop, onEpubSelected: noop, onConvert: noop, onDownloadConverted: noop,
      onConnect: noop, onDisconnect: noop, onSelfTest: noop, onSendIntegrated: noop, onIntegratedOpenConfirmed: noop, onCleanupInspectionConfirmed: noop, onCopyLog: noop, onKoboConnect, onKindleDriveConnect,
    }, new DebugLog(), { autoStartCatalog: false, catalogApi: {} as CatalogApi });
    view.setKoboState({ ...snapshot().kobo!, status: "disconnected", statuses: new Map(), countsByProfile: new Map() });
    expect(onKoboConnect).not.toHaveBeenCalled();
    element.querySelector<HTMLButtonElement>('[data-ui-action="toggle-reader-picker"]')!.click();
    expect(onKoboConnect).not.toHaveBeenCalled();
    element.querySelector<HTMLButtonElement>('[data-ui-action="connect-kobo"]')!.click();
    expect(onKoboConnect).toHaveBeenCalledOnce();
    expect(onKindleDriveConnect).not.toHaveBeenCalled();
    element.querySelector<HTMLButtonElement>('[data-ui-action="connect-kindle-drive"]')!.click();
    expect(onKindleDriveConnect).toHaveBeenCalledOnce();
    view.render({ ...state, device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981 } } });
    expect(element.querySelector('[data-ui-action="connect-kobo"]')).toBeNull();
    expect(element.querySelector(".library-reader-picker")).toBeNull();
    expect(onKoboConnect).toHaveBeenCalledOnce();
    element.remove();
  });
  it("does not borrow a catalog book's Kindle status if Kobo has no evidence", () => {
    const value = snapshot();
    const entry = { ...book, kindleStatus: "confirmed" as const };
    const el = rendered({ ...value, page: { ...value.page!, items: [entry] }, kobo: { ...value.kobo!, statuses: new Map(), countsByProfile: new Map() } });
    expect(el.querySelector('[aria-label="Already on this Kobo"]')).toBeNull();
    expect(bookActionCapabilities(entry, initialAppState(), { ...value, kobo: { ...value.kobo!, statuses: new Map() } }).send.enabled).toBe(false);
  });
  it("blocks sends and shows only exact inspection filenames while recovery is pending", () => {
    const value = snapshot();
    const pending = { ...value, kobo: { ...value.kobo!, recovery: [{ filename: "book.epub", bytes: 1000, sha256: "a".repeat(64) }] } };
    expect(bookActionCapabilities(book, initialAppState(), pending).send.enabled).toBe(false);
    const el = rendered(pending);
    expect(el.textContent).toContain("Check an interrupted transfer");
    expect(el.querySelector('[data-ui-action="acknowledge-kobo-recovery"]')?.textContent).toBe("I inspected these files");
    expect(el.textContent).not.toContain("a".repeat(64));
  });
});

function browserFixture(books: readonly CatalogBook[] = [book], hooks: CatalogHardwareHooks = {}) {
  const queryBooks = vi.fn(async (_profile: string, query: CatalogBookQuery & { includeBookIds?: readonly string[] }) => {
    const selected = query.includeBookIds ? books.filter((entry) => query.includeBookIds!.includes(entry.id)) : books;
    return { items: selected, total: selected.length, limit: 24, offset: 0 };
  });
  const api = {
    getStatus: vi.fn().mockResolvedValue({ available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" }),
    listProfiles: vi.fn().mockResolvedValue(snapshot().profiles), listRoots: vi.fn().mockResolvedValue([root]), getFilters: vi.fn().mockResolvedValue(EMPTY_CATALOG_FILTERS),
    listBooks: vi.fn().mockResolvedValue({ items: books, total: books.length, limit: 24, offset: 0 }), queryBooks,
    getSendQueue: vi.fn().mockResolvedValue({ profileId: "p", revision: 0, entries: [], total: 0, totalSourceBytes: 0 }),
    listSmartShelves: vi.fn().mockResolvedValue([]), subscribeEvents: vi.fn((_a, _b, opened) => { opened(); return () => undefined; }),
  } as unknown as CatalogApi;
  const browser = new CatalogBrowser(api, hooks, () => undefined, { getItem: () => null, setItem: () => undefined });
  return { browser, api, queryBooks };
}

describe("Kobo catalog routing", () => {
  it("does not fetch catalog pages merely to announce initial browser support or unchanged progress", async () => {
    const { browser, api } = browserFixture();
    const state = { ...snapshot().kobo!, status: "disconnected" as const, statuses: new Map(), countsByProfile: new Map() };
    browser.setKoboState(state);
    expect(api.listBooks).not.toHaveBeenCalled();
    await browser.start();
    browser.setKoboState(snapshot().kobo);
    await vi.waitFor(() => expect(browser.snapshot.booksState).toBe("ready"));
    vi.mocked(api.listBooks).mockClear();
    browser.setKoboState({ ...snapshot().kobo!, message: "Checking connection" });
    expect(api.listBooks).not.toHaveBeenCalled();
    browser.dispose();
  });
  it("filters On Kobo using separate evidence and preserves Kindle statuses", async () => {
    const other = { ...book, id: "c", title: "Other book" };
    const { browser, queryBooks } = browserFixture([book, other]);
    await browser.start();
    browser.setKindleStatuses(new Map([["b", "confirmed"], ["c", "not-on-kindle"]]));
    browser.setKoboState({ ...snapshot().kobo!, statuses: new Map([["b", "not-on-kindle"], ["c", "confirmed"]]) });
    await browser.setView("on-kindle");
    expect(queryBooks).toHaveBeenLastCalledWith("p", expect.objectContaining({ includeBookIds: ["c"] }), expect.any(AbortSignal));
    expect(browser.snapshot.kindleStatus.get("b")).toBe("confirmed");
    expect(browser.snapshot.kobo?.statuses.get("b")).toBe("not-on-kindle");
    expect(browser.snapshot.page?.items.map((entry) => entry.id)).toEqual(["c"]);
    browser.dispose();
  });
  it.each(["kobo", "kindle-drive"] as const)("routes a %s batch with its allowed formats and no MTP delete/update hooks", async (reader) => {
    const other = { ...book, id: "c", title: "Other book" };
    const azw3 = { ...book, id: "z", format: "AZW3" };
    const onSendRequested = vi.fn().mockResolvedValue(undefined);
    const onSendBatchFinished = vi.fn().mockResolvedValue(undefined);
    const onRemoveRequested = vi.fn();
    const onUpdateRequested = vi.fn();
    const { browser } = browserFixture([book, other, azw3], { onSendRequested, onSendBatchFinished, onRemoveRequested, onUpdateRequested });
    await browser.start();
    browser.setKoboState({ ...snapshot().kobo!, reader, statuses: new Map([["b", "not-on-kindle"], ["c", "not-on-kindle"], ["z", "not-on-kindle"]]) });
    await vi.waitFor(() => expect(browser.snapshot.booksState).toBe("ready"));
    browser.setLayout("list");
    browser.toggleVisibleBookSelection();
    await browser.sendSelectedBooks();
    expect(onSendRequested.mock.calls.map(([request]) => request.book.id)).toEqual(reader === "kobo" ? ["b", "c"] : ["b", "c", "z"]);
    expect(onSendRequested.mock.calls[1]?.[0].batch).toMatchObject({ position: 2, total: reader === "kobo" ? 2 : 3 });
    expect(onSendBatchFinished).toHaveBeenCalledOnce();
    browser.requestBookRemoval("b");
    await browser.confirmBookRemoval();
    browser.requestBookUpdate("b");
    await browser.confirmBookUpdate();
    expect(onRemoveRequested).not.toHaveBeenCalled();
    expect(onUpdateRequested).not.toHaveBeenCalled();
    expect(browser.snapshot.activityEvents[0]?.title).toBe(`${reader === "kobo" ? "Kobo" : "Kindle"} batch verified`);
    browser.dispose();
  });
});
