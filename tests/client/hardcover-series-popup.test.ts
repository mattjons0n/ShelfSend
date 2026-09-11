// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogBrowser } from "../../client/src/catalog-browser";
import { HttpCatalogClient, safeHardcoverBookUrl, type CatalogApi, type CatalogBook, type HardcoverBookLookup, type HardcoverLibrarySeriesPage } from "../../client/src/catalog-client";
import { renderLibraryPrototype } from "../../client/src/library-prototype-view";
import { initialAppState } from "../../client/src/state";
import { AppView, type AppViewHandlers } from "../../client/src/view";
import { DebugLog } from "../../client/src/log";

const local: CatalogBook = {
  id: "local", profileId: "profile", rootId: "root", sourceFilename: "book.epub", title: "The First Book",
  authors: ["An Author"], authorSort: "Author", subjects: [], identifiers: ["hardcover:11"], format: "EPUB",
  size: 100, metadataComplete: true, available: true, addedAt: "2026-09-01", updatedAt: "2026-09-01",
};
const remote = {
  id: 11, title: "The First Book", authors: ["An Author"], identifiers: ["hardcover:11"],
  url: "https://hardcover.app/books/the-first-book", coverUrl: "https://assets.hardcover.app/cover.jpg", releaseYear: 2025,
  series: [{ id: 7, name: "A Long Story", position: 1 }],
};
function page(offset = 0): HardcoverLibrarySeriesPage {
  return {
    id: 7, name: "A Long Story", offset, limit: 50, hasMore: offset === 0,
    books: offset ? [{ ...remote, id: 14, title: "The Final Book", position: null, library: { status: "missing", books: [] } }] : [
      { ...remote, position: 0, library: { status: "in-library", books: [{ id: local.id, title: local.title, available: false, coverUrl: "/api/profiles/profile/books/local/cover" }] } },
      { ...remote, id: 12, title: "An Interlude", position: 1.5, library: { status: "missing", books: [] } },
      { ...remote, id: 13, title: "An Uncertain Book", url: "javascript:alert(1)", coverUrl: "https://evil.invalid/x", position: 2, library: { status: "possible", books: [{ id: "uncertain", title: "A Similar Book", available: true, coverUrl: null }] } },
    ],
  };
}
function fixture(configured = true) {
  return {
    getStatus: vi.fn(async () => ({ available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" })),
    listProfiles: vi.fn(async () => ["profile", "other"].map((id) => ({ id, name: id, description: "Home", initial: "H", sourceLabel: "Books", enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 1 }))),
    listRoots: vi.fn(async (profileId: string) => [{ id: "root", profileId, label: "Books", path: "/libraries", recursive: true, watch: true, enabled: true, status: "watching" }]),
    getFilters: vi.fn(async () => ({ authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [] })),
    listBooks: vi.fn(async (profileId: string) => ({ items: [{ ...local, profileId }], total: 1, limit: 24, offset: 0 })),
    getBook: vi.fn(async (profileId: string, id: string) => ({ ...local, profileId, id })),
    listCoverProviderCredentials: vi.fn(async () => [{ provider: "hardcover", configured, revision: 1, status: configured ? "working" : "not-configured", maskedKey: configured ? "••••••••" : null, errorCode: null }]),
    getHardcoverBook: vi.fn(async (): Promise<HardcoverBookLookup> => ({ books: [remote], matchedBookId: remote.id })),
    getHardcoverSeries: vi.fn(async (_profile: string, _series: number, _limit = 50, offset = 0): Promise<HardcoverLibrarySeriesPage> => page(offset)),
    subscribeEvents: vi.fn(() => () => {}),
  };
}
const browsers: CatalogBrowser[] = [];
async function setup(configured = true) {
  const api = fixture(configured);
  const browser = new CatalogBrowser(api as unknown as CatalogApi, {}, () => {}, undefined);
  browsers.push(browser);
  await browser.start();
  return { api, browser };
}
function rendered(browser: CatalogBrowser): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = renderLibraryPrototype(initialAppState(), browser.snapshot);
  return root;
}
afterEach(() => {
  browsers.splice(0).forEach((browser) => browser.dispose());
  document.body.innerHTML = "";
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("Hardcover book details and series discovery", () => {
  it("loads once per details opening and requires Settings when no token is configured", async () => {
    const { api, browser } = await setup(false);
    await browser.openBookDetails(local.id);
    expect(api.getHardcoverBook).not.toHaveBeenCalled();
    expect(rendered(browser).querySelector('[data-ui-action="hardcover-discovery-settings"]')).not.toBeNull();
    expect(rendered(browser).textContent).toContain("Add your Hardcover token");
    expect(rendered(browser).querySelector<HTMLButtonElement>('[data-ui-action="open-hardcover-series"]')!.disabled).toBe(true);
    browser.dismissAnnouncement();
    rendered(browser);
    expect(api.listCoverProviderCredentials).toHaveBeenCalledOnce();
  });

  it("shows the provider roster, fractional volumes and cautious library status, then loads all pages", async () => {
    const { api, browser } = await setup();
    await browser.openBookDetails(local.id);
    const details = browser.snapshot.bookDetails;
    expect(rendered(browser).querySelector('.hardcover-actions a')?.getAttribute("href")).toBe(remote.url);
    await browser.openHardcoverSeries();
    let root = rendered(browser);
    expect(root.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(root.querySelectorAll(".hardcover-series-book")).toHaveLength(3);
    for (const text of ["Volume 0", "Volume 1.5", "In your library", "Missing", "Possible match", "source unavailable"]) expect(root.textContent).toContain(text);
    expect(root.querySelector('[src^="https://evil.invalid"]')).toBeNull();
    expect(root.querySelector('[href^="javascript:"]')).toBeNull();
    expect(root.querySelector('.hardcover-series-sheet [data-ui-action="send-book"]')).toBeNull();
    expect(root.querySelector('.hardcover-series-sheet [data-ui-action="remove-book-from-kindle"]')).toBeNull();
    await browser.loadHardcoverSeries(7, true);
    expect(api.getHardcoverSeries).toHaveBeenLastCalledWith("profile", 7, 50, 50, expect.any(AbortSignal));
    root = rendered(browser);
    expect(root.querySelectorAll(".hardcover-series-book")).toHaveLength(4);
    expect(root.textContent).toContain("Volume not listed");
    expect(root.querySelector('[data-ui-action="load-more-hardcover-series"]')).toBeNull();
    browser.closeHardcoverSeries();
    expect(browser.snapshot.bookDetails?.book).toBe(details?.book);
    expect(api.getHardcoverBook).toHaveBeenCalledOnce();
    await browser.openHardcoverSeries();
    expect(api.getHardcoverSeries).toHaveBeenCalledTimes(2);
  });

  it("requires an explicit book and series choice for ambiguous results", async () => {
    const { api, browser } = await setup();
    api.getHardcoverBook.mockResolvedValue({ books: [
      { ...remote, series: [...remote.series, { id: 9, name: "Publication order", position: 3 }] },
      { ...remote, id: 22, title: "A Similar Title", series: [] },
    ], matchedBookId: null });
    await browser.openBookDetails(local.id);
    expect(rendered(browser).querySelector(".hardcover-actions a")).toBeNull();
    browser.selectHardcoverBook(11);
    await browser.openHardcoverSeries();
    expect(api.getHardcoverSeries).not.toHaveBeenCalled();
    expect(rendered(browser).querySelector('[data-ui-action="select-hardcover-series"]')).not.toBeNull();
    await browser.loadHardcoverSeries(7);
    expect(api.getHardcoverSeries).toHaveBeenCalledOnce();
    browser.selectHardcoverBook(22);
    expect(rendered(browser).textContent).toContain("No series is listed");
    expect(rendered(browser).querySelectorAll(".hardcover-series-book")).toHaveLength(0);
    browser.selectHardcoverBook(0);
    expect(browser.snapshot.bookDetails?.hardcover?.selectedBookId).toBeUndefined();
  });

  it("retains the roster when a later page fails and retries that offset", async () => {
    const { api, browser } = await setup();
    await browser.openBookDetails(local.id);
    await browser.openHardcoverSeries();
    api.getHardcoverSeries.mockRejectedValueOnce(new Error("Hardcover rate limit. Try again later."));
    await browser.loadHardcoverSeries(7, true);
    expect(rendered(browser).querySelector('[role="alert"]')?.textContent).toContain("rate limit");
    expect(rendered(browser).querySelectorAll(".hardcover-series-book")).toHaveLength(3);
    await browser.loadHardcoverSeries(7, true);
    expect(api.getHardcoverSeries).toHaveBeenLastCalledWith("profile", 7, 50, 50, expect.any(AbortSignal));
    expect(browser.snapshot.bookDetails?.hardcover?.seriesPage?.books).toHaveLength(4);
  });

  it("distinguishes lookup failure from no match and offers a safe retry", async () => {
    const { api, browser } = await setup();
    api.getHardcoverBook.mockRejectedValueOnce(new Error("The Hardcover token expired."));
    await browser.openBookDetails(local.id);
    expect(rendered(browser).querySelector('.hardcover-discovery [role="alert"]')?.textContent).toContain("token expired");
    expect(rendered(browser).querySelector('.hardcover-actions a')).toBeNull();
    api.getHardcoverBook.mockResolvedValueOnce({ books: [], matchedBookId: null });
    await browser.loadHardcoverBook();
    expect(rendered(browser).textContent).toContain("No matching book was found");
    expect(rendered(browser).querySelector('.hardcover-discovery [role="alert"]')).toBeNull();
    await browser.loadHardcoverBook();
    expect(rendered(browser).querySelector('.hardcover-actions a')?.getAttribute("href")).toBe(remote.url);
  });

  it("discards late lookup and series responses after close, book replacement or profile switch", async () => {
    const { api, browser } = await setup();
    let completeLookup!: (value: HardcoverBookLookup) => void;
    api.getHardcoverBook.mockImplementationOnce(() => new Promise((resolve) => { completeLookup = resolve; }));
    const opening = browser.openBookDetails(local.id);
    await vi.waitFor(() => expect(api.getHardcoverBook).toHaveBeenCalledOnce());
    browser.closeBookDetails();
    completeLookup({ books: [remote], matchedBookId: 11 });
    await opening;
    expect(browser.snapshot.bookDetails).toBeUndefined();
    await browser.openBookDetails(local.id);
    let completeSeries!: (value: HardcoverLibrarySeriesPage) => void;
    api.getHardcoverSeries.mockImplementationOnce(() => new Promise((resolve) => { completeSeries = resolve; }));
    const loading = browser.openHardcoverSeries();
    await vi.waitFor(() => expect(api.getHardcoverSeries).toHaveBeenCalledOnce());
    browser.closeHardcoverSeries();
    completeSeries(page());
    await loading;
    expect(browser.snapshot.bookDetails?.hardcover?.seriesOpen).toBe(false);
    expect(browser.snapshot.bookDetails?.hardcover?.seriesPage).toBeUndefined();
    api.getHardcoverBook.mockImplementationOnce(() => new Promise((resolve) => { completeLookup = resolve; }));
    const oldProfile = browser.openBookDetails(local.id);
    await vi.waitFor(() => expect(api.getHardcoverBook).toHaveBeenCalledTimes(3));
    await browser.selectProfile("other");
    await browser.openBookDetails(local.id);
    completeLookup({ books: [{ ...remote, title: "Wrong profile result" }], matchedBookId: 11 });
    await oldProfile;
    expect(browser.snapshot.bookDetails?.profileId).toBe("other");
    expect(browser.snapshot.bookDetails?.hardcover?.books[0]?.title).toBe(remote.title);
  });

  it("contains keyboard focus, returns to the book and keeps popup navigation out of browser history", async () => {
    const api = fixture();
    const root = document.createElement("div");
    document.body.append(root);
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
    const handlers: AppViewHandlers = {
      onTargetProfileSaved: vi.fn(), onEpubSelected: vi.fn(), onConvert: vi.fn(), onDownloadConverted: vi.fn(),
      onConnect: vi.fn(), onDisconnect: vi.fn(), onSelfTest: vi.fn(), onSendIntegrated: vi.fn(),
      onIntegratedOpenConfirmed: vi.fn(), onCleanupInspectionConfirmed: vi.fn(), onCopyLog: vi.fn(),
    };
    new AppView(root, initialAppState(), handlers, new DebugLog(), { catalogApi: api as unknown as CatalogApi });
    await vi.waitFor(() => expect(root.querySelector('[data-ui-action="open-book-details"]')).not.toBeNull());
    root.querySelector<HTMLButtonElement>('[data-ui-action="open-book-details"]')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('[data-ui-action="open-hardcover-series"]')?.disabled).toBe(false));
    const bookHash = window.location.hash;
    root.querySelector<HTMLButtonElement>('[data-ui-action="open-hardcover-series"]')!.click();
    await vi.waitFor(() => expect(root.querySelectorAll(".hardcover-series-book")).toHaveLength(3));
    expect(window.location.hash).toBe(bookHash);
    const dialog = root.querySelector<HTMLElement>(".hardcover-series-sheet")!;
    expect(root.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(root.querySelector(".library-sidebar")?.hasAttribute("inert")).toBe(true);
    const first = dialog.querySelector<HTMLButtonElement>('[data-ui-action="close-hardcover-series"]')!;
    const last = dialog.querySelector<HTMLButtonElement>('footer [data-ui-action="close-hardcover-series"]')!;
    last.focus();
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first);
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(root.querySelector(".hardcover-series-sheet")).toBeNull();
    expect(document.activeElement?.getAttribute("data-ui-action")).toBe("open-hardcover-series");
    expect(window.location.hash).toBe(bookHash);
    root.querySelector<HTMLButtonElement>('[data-ui-action="open-hardcover-series"]')!.click();
    root.querySelector<HTMLElement>('.library-modal-backdrop[data-ui-action="close-hardcover-series"]')!.click();
    expect(root.querySelector(".hardcover-series-sheet")).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-ui-action="close-book-details"]')!.click();
  });

  it("accepts only provider HTTPS book links and adapts paginated read-only API responses", async () => {
    for (const url of ["http://hardcover.app/books/book", "https://hardcover.app.evil.invalid/books/book", "javascript:alert(1)", "https://hardcover.app/books/book?token=secret", "https://user:pass@hardcover.app/books/book"]) expect(safeHardcoverBookUrl(url)).toBeNull();
    expect(safeHardcoverBookUrl("https://hardcover.app/id/book/11")).toBe("https://hardcover.app/id/book/11");
    const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    const fetch = vi.fn().mockResolvedValueOnce(json({ books: [remote], matchedBookId: 11 }))
      .mockResolvedValueOnce(json(page()));
    const client = new HttpCatalogClient({ fetch });
    expect(await client.getHardcoverBook("profile", "a/b")).toMatchObject({ matchedBookId: 11 });
    expect(fetch.mock.calls[0]?.[0]).toContain("/profiles/profile/books/a%2Fb/hardcover");
    expect((await client.getHardcoverSeries("profile", 7)).books[1]?.position).toBe(1.5);
    expect(fetch.mock.calls[1]?.[0]).toContain("/hardcover/series/7?limit=50&offset=0");
  });
});
