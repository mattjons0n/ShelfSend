// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogApi, CatalogBook, CatalogBookQuery, CatalogProfile, CatalogRoot } from "../../client/src/catalog-client";
import { bindLibraryDisplayControls, captureLibraryDisplayControl } from "../../client/src/library-display-controls";
import { LIBRARY_CARD_SIZE_DEFAULT, LIBRARY_CARD_SIZE_MAX, LIBRARY_CARD_SIZE_MIN, LIBRARY_CARD_SIZE_STEP, LIBRARY_PAGE_SIZES } from "../../client/src/library-display-preferences";
import { readLibraryBrowserContext } from "../../client/src/library-browser-context";
import { decodeLibraryRoute } from "../../client/src/library-route";
import { EMPTY_CATALOG_FILTERS } from "../../client/src/library-prototype";
import { DebugLog } from "../../client/src/log";
import { initialAppState } from "../../client/src/state";
import { AppView, type AppViewHandlers } from "../../client/src/view";

afterEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

function controlsMarkup(size = LIBRARY_CARD_SIZE_DEFAULT, pageSize = 24): string {
  return `<label for="library-card-size">Card size</label><input id="library-card-size" type="range" min="${LIBRARY_CARD_SIZE_MIN}" max="${LIBRARY_CARD_SIZE_MAX}" step="${LIBRARY_CARD_SIZE_STEP}" value="${size}"><div class="library-book-grid" data-layout="grid" style="--library-card-min-width: ${size}px"><article>Book title · Author · EPUB · 2.5 MB</article></div><div class="library-book-grid" data-layout="list"><article>List book</article></div><label for="library-page-size">Books per page</label><select id="library-page-size">${LIBRARY_PAGE_SIZES.map((limit) => `<option value="${limit}"${pageSize === limit ? " selected" : ""}>${limit}</option>`).join("")}</select><button id="outside">Outside</button>`;
}

function displayControls() {
  const root = document.createElement("div");
  root.innerHTML = controlsMarkup();
  document.body.append(root);
  const actions = { setCardSize: vi.fn(), setPageSize: vi.fn() };
  bindLibraryDisplayControls(root, actions);
  return {
    root,
    actions,
    slider: root.querySelector<HTMLInputElement>("#library-card-size")!,
    page: root.querySelector<HTMLSelectElement>("#library-page-size")!,
    grid: root.querySelector<HTMLElement>('[data-layout="grid"]')!,
    list: root.querySelector<HTMLElement>('[data-layout="list"]')!,
  };
}

describe("library display control binding", () => {
  it("previews the grid width during dragging without committing, replacing nodes, or affecting list layout", () => {
    const { root, slider, grid, list, actions } = displayControls();
    const book = grid.firstElementChild;
    for (const size of [LIBRARY_CARD_SIZE_MIN, LIBRARY_CARD_SIZE_MAX]) {
      slider.value = String(size);
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      expect(grid.style.getPropertyValue("--library-card-min-width")).toBe(`${size}px`);
    }
    expect(root.querySelector("#library-card-size")).toBe(slider);
    expect(grid.firstElementChild).toBe(book);
    expect(book?.textContent).toBe("Book title · Author · EPUB · 2.5 MB");
    expect(list.style.getPropertyValue("--library-card-min-width")).toBe("");
    expect(actions.setCardSize).not.toHaveBeenCalled();
    expect(actions.setPageSize).not.toHaveBeenCalled();
  });

  it("commits a completed slider change once, after its input previews", () => {
    const { slider, actions } = displayControls();
    slider.value = String(LIBRARY_CARD_SIZE_MAX);
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    expect(actions.setCardSize).toHaveBeenCalledExactlyOnceWith(LIBRARY_CARD_SIZE_MAX);
    expect(actions.setPageSize).not.toHaveBeenCalled();
  });

  it("commits each bounded books-per-page option to the page action only", () => {
    const { page, actions } = displayControls();
    for (const size of LIBRARY_PAGE_SIZES) {
      page.value = String(size);
      page.dispatchEvent(new Event("change", { bubbles: true }));
      expect(actions.setPageSize).toHaveBeenLastCalledWith(size);
    }
    expect(actions.setPageSize).toHaveBeenCalledTimes(LIBRARY_PAGE_SIZES.length);
    expect(actions.setCardSize).not.toHaveBeenCalled();
  });

  it("ignores synthetic events on disabled controls", () => {
    const { slider, page, grid, actions } = displayControls();
    slider.disabled = true;
    page.disabled = true;
    slider.value = String(LIBRARY_CARD_SIZE_MAX);
    page.value = "96";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    page.dispatchEvent(new Event("change", { bubbles: true }));
    expect(grid.style.getPropertyValue("--library-card-min-width")).toBe(`${LIBRARY_CARD_SIZE_DEFAULT}px`);
    expect(actions.setCardSize).not.toHaveBeenCalled();
    expect(actions.setPageSize).not.toHaveBeenCalled();
  });
});

describe("display control focus restoration", () => {
  it("restores a pending slider value and grid preview after replacement without scrolling or committing", () => {
    const { root, slider, actions } = displayControls();
    slider.focus();
    slider.value = String(LIBRARY_CARD_SIZE_MAX);
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    const restore = captureLibraryDisplayControl(root);
    root.innerHTML = controlsMarkup();
    const replacement = root.querySelector<HTMLInputElement>("#library-card-size")!;
    const focus = vi.spyOn(replacement, "focus");
    restore();
    expect(replacement).not.toBe(slider);
    expect(document.activeElement).toBe(replacement);
    expect(replacement.value).toBe(String(LIBRARY_CARD_SIZE_MAX));
    expect(root.querySelector<HTMLElement>('[data-layout="grid"]')!.style.getPropertyValue("--library-card-min-width")).toBe(`${LIBRARY_CARD_SIZE_MAX}px`);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(actions.setCardSize).not.toHaveBeenCalled();
  });

  it("restores page-selector focus without replacing the newly rendered selected value", () => {
    const { root, page } = displayControls();
    page.focus();
    const restore = captureLibraryDisplayControl(root);
    root.innerHTML = controlsMarkup(LIBRARY_CARD_SIZE_DEFAULT, 96);
    const replacement = root.querySelector<HTMLSelectElement>("#library-page-size")!;
    const focus = vi.spyOn(replacement, "focus");
    restore();
    expect(document.activeElement).toBe(replacement);
    expect(replacement.value).toBe("96");
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("does not overwrite a restored route's card size with the previously committed slider value", () => {
    const { root, slider } = displayControls();
    slider.focus();
    slider.value = String(LIBRARY_CARD_SIZE_MAX);
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    const restore = captureLibraryDisplayControl(root);
    root.innerHTML = controlsMarkup(LIBRARY_CARD_SIZE_MIN);
    restore();
    expect(document.activeElement).toBe(root.querySelector("#library-card-size"));
    expect(root.querySelector<HTMLInputElement>("#library-card-size")!.value).toBe(String(LIBRARY_CARD_SIZE_MIN));
    expect(root.querySelector<HTMLElement>('[data-layout="grid"]')!.style.getPropertyValue("--library-card-min-width")).toBe(`${LIBRARY_CARD_SIZE_MIN}px`);
  });

  it.each(["disabled", "removed"] as const)("does not focus a %s replacement", (state) => {
    const { root, slider } = displayControls();
    slider.focus();
    const restore = captureLibraryDisplayControl(root);
    root.innerHTML = controlsMarkup();
    const replacement = root.querySelector<HTMLInputElement>("#library-card-size")!;
    const focus = vi.spyOn(replacement, "focus");
    if (state === "disabled") replacement.disabled = true;
    else replacement.remove();
    restore();
    expect(focus).not.toHaveBeenCalled();
  });

  it("does not steal focus from unrelated controls inside or outside the root", () => {
    const { root } = displayControls();
    const inside = root.querySelector<HTMLButtonElement>("#outside")!;
    const outside = document.createElement("input");
    outside.id = "library-card-size";
    document.body.append(outside);
    for (const other of [inside, outside]) {
      other.focus();
      const restore = captureLibraryDisplayControl(root);
      restore();
      expect(document.activeElement).toBe(other);
    }
  });
});

const PROFILE: CatalogProfile = {
  id: "display-profile", name: "Display Library", description: "", initial: "D", sourceLabel: "books",
  enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 250,
};
const ROOT: CatalogRoot = {
  id: "display-root", profileId: PROFILE.id, label: "books", path: "/libraries/books",
  recursive: true, watch: true, enabled: true, status: "watching",
};
const BOOK: CatalogBook = {
  id: "display-book", profileId: PROFILE.id, rootId: ROOT.id, sourceFilename: "readable.epub",
  title: "A readable book title", authors: ["A readable author"], authorSort: "Author, A readable", identifiers: [], subjects: [], language: "en",
  format: "epub", size: 1234, contentHash: "a".repeat(64), available: true, metadataComplete: true,
  addedAt: "2026-09-14T08:00:00Z", updatedAt: "2026-09-14T08:00:00Z",
};

function viewHandlers(): AppViewHandlers {
  const noop = () => undefined;
  return {
    onTargetProfileSaved: noop, onEpubSelected: noop, onConvert: noop, onDownloadConverted: noop,
    onConnect: noop, onDisconnect: noop, onSelfTest: noop, onSendIntegrated: noop,
    onIntegratedOpenConfirmed: noop, onCleanupInspectionConfirmed: noop, onCopyLog: noop,
  };
}

async function dashboard() {
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  const listBooks = vi.fn(async (_profileId: string, query: CatalogBookQuery = {}) => ({
    items: [BOOK], total: PROFILE.bookCount, limit: query.limit ?? 24, offset: query.offset ?? 0,
  }));
  const api = {
    getStatus: vi.fn(async () => ({ available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" })),
    listProfiles: vi.fn(async () => [PROFILE]),
    listRoots: vi.fn(async () => [ROOT]),
    getFilters: vi.fn(async () => EMPTY_CATALOG_FILTERS),
    listBooks,
    subscribeEvents: vi.fn(() => () => undefined),
  } as unknown as CatalogApi;
  const root = document.createElement("div");
  document.body.append(root);
  const state = initialAppState();
  const view = new AppView(root, state, viewHandlers(), new DebugLog(), { catalogApi: api, catalogStorage: window.localStorage });
  await vi.waitFor(() => expect(root.querySelector('[data-book-id="display-book"]')).not.toBeNull());
  await vi.waitFor(() => expect(root.querySelector<HTMLSelectElement>("#library-page-size")?.disabled).toBe(false));
  return { root, view, state, listBooks };
}

describe("display controls in the actual dashboard", () => {
  it("commits card size into route and saved context while keeping keyboard focus through results and full renders", async () => {
    const { root, view, state, listBooks } = await dashboard();
    const slider = root.querySelector<HTMLInputElement>("#library-card-size")!;
    slider.focus();
    slider.value = String(LIBRARY_CARD_SIZE_MAX);
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    expect(readLibraryBrowserContext(window.localStorage, PROFILE.id)?.cardSize ?? LIBRARY_CARD_SIZE_DEFAULT).toBe(LIBRARY_CARD_SIZE_DEFAULT);
    listBooks.mockClear();
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    const committed = root.querySelector<HTMLInputElement>("#library-card-size")!;
    expect(committed).not.toBe(slider);
    expect(document.activeElement).toBe(committed);
    expect(committed.value).toBe(String(LIBRARY_CARD_SIZE_MAX));
    expect(decodeLibraryRoute(window.location.hash)?.cardSize).toBe(LIBRARY_CARD_SIZE_MAX);
    expect(readLibraryBrowserContext(window.localStorage, PROFILE.id)?.cardSize).toBe(LIBRARY_CARD_SIZE_MAX);
    expect(listBooks).not.toHaveBeenCalled();
    committed.value = String(LIBRARY_CARD_SIZE_MIN);
    committed.dispatchEvent(new Event("input", { bubbles: true }));
    view.render(state);
    const refreshed = root.querySelector<HTMLInputElement>("#library-card-size")!;
    expect(document.activeElement).toBe(refreshed);
    expect(refreshed.value).toBe(String(LIBRARY_CARD_SIZE_MIN));
    expect(root.querySelector<HTMLElement>('[data-layout="grid"].library-book-grid')!.style.getPropertyValue("--library-card-min-width")).toBe(`${LIBRARY_CARD_SIZE_MIN}px`);
    expect(readLibraryBrowserContext(window.localStorage, PROFILE.id)?.cardSize).toBe(LIBRARY_CARD_SIZE_MAX);
  });

  it("uses the chosen page size for the API, route, saved context and Show more offset", async () => {
    const { root, listBooks } = await dashboard();
    const page = root.querySelector<HTMLSelectElement>("#library-page-size")!;
    page.focus();
    page.value = "48";
    listBooks.mockClear();
    page.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(root.querySelector<HTMLSelectElement>("#library-page-size")?.value).toBe("48"));
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('[aria-label="Show more books (next page)"]')?.disabled).toBe(false));
    expect(listBooks).toHaveBeenCalledWith(PROFILE.id, expect.objectContaining({ limit: 48, offset: 0 }), expect.any(AbortSignal));
    expect(decodeLibraryRoute(window.location.hash)?.filters.limit).toBe(48);
    expect(readLibraryBrowserContext(window.localStorage, PROFILE.id)?.filters.limit).toBe(48);
    expect(document.activeElement).toBe(root.querySelector("#library-page-size"));
    const more = root.querySelector<HTMLButtonElement>('[aria-label="Show more books (next page)"]')!;
    expect(more.dataset.pageOffset).toBe("48");
    expect(more.closest(".library-pagination")).toBe(root.querySelector("#library-page-size")!.closest(".library-pagination"));
    more.click();
    await vi.waitFor(() => expect(listBooks).toHaveBeenLastCalledWith(PROFILE.id, expect.objectContaining({ limit: 48, offset: 48 }), expect.any(AbortSignal)));
  });
});
