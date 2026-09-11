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
    expect(el.querySelector('[data-ui-view="on-kindle"]')?.textContent).toContain("On Kobo");
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
  it("offers an explicit Kobo connect button without connecting on render", () => {
    const value = snapshot();
    const el = rendered({ ...value, activeReader: "kindle", kobo: { ...value.kobo!, status: "disconnected" } });
    expect(el.querySelector('[data-ui-action="connect-kobo"]')).not.toBeNull();
    expect(el.querySelector('[data-ui-action="connect-catalog-device"]')).not.toBeNull();
  });
  it("invokes the directory-connection hook synchronously only after a user click", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const onKoboConnect = vi.fn();
    const noop = () => undefined;
    const state = { ...initialAppState(), secureContext: true, webUsbAvailable: true };
    const view = new AppView(element, state, {
      onTargetProfileSaved: noop, onEpubSelected: noop, onConvert: noop, onDownloadConverted: noop,
      onConnect: noop, onDisconnect: noop, onSelfTest: noop, onSendIntegrated: noop, onIntegratedOpenConfirmed: noop, onCleanupInspectionConfirmed: noop, onCopyLog: noop, onKoboConnect,
    }, new DebugLog(), { autoStartCatalog: false, catalogApi: {} as CatalogApi });
    view.setKoboState({ ...snapshot().kobo!, status: "disconnected", statuses: new Map(), countsByProfile: new Map() });
    expect(onKoboConnect).not.toHaveBeenCalled();
    element.querySelector<HTMLButtonElement>('[data-ui-action="connect-kobo"]')!.click();
    expect(onKoboConnect).toHaveBeenCalledOnce();
    view.render({ ...state, device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981 } } });
    const blocked = element.querySelector<HTMLButtonElement>('[data-ui-action="connect-kobo"]')!;
    expect(blocked.disabled).toBe(true);
    blocked.click();
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
    const pending = { ...value, kobo: { ...value.kobo!, recovery: [{ filename: "ShelfSend/book.epub", bytes: 1000, sha256: "a".repeat(64) }] } };
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
  it("routes an EPUB-only batch and never permits Kindle delete or update hooks", async () => {
    const other = { ...book, id: "c", title: "Other book" };
    const azw3 = { ...book, id: "z", format: "AZW3" };
    const onSendRequested = vi.fn().mockResolvedValue(undefined);
    const onSendBatchFinished = vi.fn().mockResolvedValue(undefined);
    const onRemoveRequested = vi.fn();
    const onUpdateRequested = vi.fn();
    const { browser } = browserFixture([book, other, azw3], { onSendRequested, onSendBatchFinished, onRemoveRequested, onUpdateRequested });
    await browser.start();
    browser.setKoboState({ ...snapshot().kobo!, statuses: new Map([["b", "not-on-kindle"], ["c", "not-on-kindle"], ["z", "not-on-kindle"]]) });
    await vi.waitFor(() => expect(browser.snapshot.booksState).toBe("ready"));
    browser.setLayout("list");
    browser.toggleVisibleBookSelection();
    await browser.sendSelectedBooks();
    expect(onSendRequested.mock.calls.map(([request]) => request.book.id)).toEqual(["b", "c"]);
    expect(onSendRequested.mock.calls[1]?.[0].batch).toMatchObject({ position: 2, total: 2 });
    expect(onSendBatchFinished).toHaveBeenCalledOnce();
    browser.requestBookRemoval("b");
    await browser.confirmBookRemoval();
    browser.requestBookUpdate("b");
    await browser.confirmBookUpdate();
    expect(onRemoveRequested).not.toHaveBeenCalled();
    expect(onUpdateRequested).not.toHaveBeenCalled();
    expect(browser.snapshot.activityEvents[0]?.title).toBe("Kobo batch verified");
    browser.dispose();
  });
});
