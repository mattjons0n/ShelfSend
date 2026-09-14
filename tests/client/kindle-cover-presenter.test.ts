// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogBrowser, type CatalogKindleInventoryItem } from "../../client/src/catalog-browser";
import type { CatalogApi } from "../../client/src/catalog-client";
import { KindleCoverPresenter, kindleCoverFingerprint, prepareKindleCoverThumbnail } from "../../client/src/kindle-cover-presenter";
import { renderKindleLibraryView } from "../../client/src/kindle-library-view";
import type { KindleBookCover } from "../../client/src/kindle/book-cover";
import { initialAppState, type AppState } from "../../client/src/state";
import { AppView } from "../../client/src/view";
import { DebugLog } from "../../client/src/log";

const ITEM: CatalogKindleInventoryItem = {
  id: "device-1", filename: "device-book.azw3", title: "Device book", author: "Author",
  path: "Documents/device-book.azw3", objectFormat: 0x3000, size: 4096, modificationDate: "20260914T121000.",
  managed: false, match: "unmatched",
};
const COVER: KindleBookCover = { bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" };
const thumbnails: KindleCoverPresenter[] = [];
const views: AppView[] = [];

class Observer {
  static current: Observer;
  readonly observed: Element[] = [];
  constructor(readonly callback: IntersectionObserverCallback) { Observer.current = this; }
  observe(element: Element) { this.observed.push(element); }
  disconnect() { /* Delivery after disconnect is deliberately testable. */ }
  show(...elements: Element[]) {
    this.callback(elements.map((target) => ({ target, isIntersecting: true } as IntersectionObserverEntry)), this as unknown as IntersectionObserver);
  }
}

function render(root: HTMLElement, items: readonly CatalogKindleInventoryItem[], offset = 0): void {
  const browser = new CatalogBrowser({} as CatalogApi, {}, () => undefined);
  root.innerHTML = renderKindleLibraryView(initialAppState(), {
    ...browser.snapshot,
    kindleInventory: { items, total: items.length, scannedAt: "2026-09-14T12:00:00Z", deviceLabel: "Kindle", completeness: "complete", truncated: false },
    kindleInventoryOffset: offset,
  });
  browser.dispose();
}

function mount(items = [ITEM], request: (itemId: string) => Promise<KindleBookCover | undefined> = vi.fn(async () => COVER),
  prepare: (cover: KindleBookCover) => Promise<Blob | undefined> = vi.fn(async () => new Blob(["thumbnail"], { type: "image/png" }))) {
  const root = document.createElement("div");
  document.body.append(root);
  render(root, items);
  const presenter = new KindleCoverPresenter(root, request, prepare);
  thumbnails.push(presenter);
  presenter.update(items, true, "page0");
  return { root, presenter, request: vi.mocked(request), prepare: vi.mocked(prepare) };
}

const row = (root: HTMLElement, index = 0) => root.querySelectorAll("[data-kindle-object-id]")[index]!;
const wait = () => new Promise<void>((resolve) => window.setTimeout(resolve, 15));

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", Observer);
  let urls = 0;
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => `blob:kindle-cover-${++urls}`);
    static revokeObjectURL = vi.fn();
  });
});

afterEach(() => {
  for (const presenter of thumbnails.splice(0)) presenter.dispose();
  for (const view of views.splice(0)) view.dispose();
  document.body.replaceChildren();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("device-owned cover presentation", () => {
  it("reads only a visible file's embedded cover, decorates its existing row and preserves details focus", async () => {
    const { root, request } = mount();
    const details = root.querySelector("details")!;
    const summary = details.querySelector("summary")!;
    details.open = true;
    summary.focus();
    const originalRow = row(root);
    await wait();
    expect(request).not.toHaveBeenCalled();
    Observer.current.show(originalRow);
    await vi.waitFor(() => expect(root.querySelector("img")?.getAttribute("src")).toBe("blob:kindle-cover-1"));
    expect(request).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    expect(root.querySelector("img")?.alt).toBe("");
    expect(row(root)).toBe(originalRow);
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(summary);
    root.querySelector("img")!.dispatchEvent(new Event("load"));
    expect(root.querySelector(".has-cover")).not.toBeNull();
  });

  it("keeps the placeholder for missing covers even when the object has a matching catalog book", async () => {
    const request = vi.fn(async () => undefined);
    const item = { ...ITEM, bookId: "catalog-cover-exists", match: "confirmed" as const };
    const { root, presenter } = mount([item], request);
    Observer.current.show(row(root));
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await wait();
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("[data-kindle-cover] svg")).not.toBeNull();
    presenter.update([item], true, "page0");
    Observer.current.show(row(root));
    await wait();
    expect(request).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("serializes visible reads and stops the queue on navigation, ignoring late old-page results", async () => {
    let resolve!: (cover: KindleBookCover) => void;
    const request = vi.fn(() => new Promise<KindleBookCover>((done) => { resolve = done; }));
    const items = [ITEM, { ...ITEM, id: "device-2" }];
    const { root, presenter } = mount(items, request);
    Observer.current.show(row(root), row(root, 1));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await wait();
    expect(request).toHaveBeenCalledTimes(1);
    presenter.update(items, false, "library");
    resolve(COVER);
    await wait();
    expect(root.querySelector("img")).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("observes only the current bounded page and starts its next visible file after the prior read finishes", async () => {
    const items = Array.from({ length: 102 }, (_, index) => ({ ...ITEM, id: `file-${index}` }));
    const { root, request, presenter } = mount(items);
    expect(Observer.current.observed).toHaveLength(100);
    Observer.current.show(row(root), row(root, 1));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    render(root, items, 100);
    presenter.update(items, true, "page100");
    expect(Observer.current.observed).toHaveLength(2);
    Observer.current.show(row(root));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(request.mock.calls.map(([id]) => id)).toEqual(["file-0", "file-1", "file-100"]);
  });

  it("preserves cached thumbnails across rerenders with identical evidence, but invalidates every changed object fact", async () => {
    const { root, presenter, request } = mount();
    Observer.current.show(row(root));
    await vi.waitFor(() => expect(root.querySelector("img")).not.toBeNull());
    const initialUrl = root.querySelector("img")!.src;
    const sameObject = { ...ITEM, title: "Updated displayed title", bookId: "new-catalog-match" };
    render(root, [sameObject]);
    presenter.update([sameObject], true, "page0");
    expect(root.querySelector("img")?.src).toBe(initialUrl);
    expect(request).toHaveBeenCalledOnce();
    expect(kindleCoverFingerprint(sameObject)).toBe(kindleCoverFingerprint(ITEM));
    for (const changed of [{ ...ITEM, id: "another" }, { ...ITEM, path: "documents/device-book.azw3" },
      { ...ITEM, objectFormat: 0x3001 }, { ...ITEM, size: 4097 }, { ...ITEM, modificationDate: "20260914T121000" }]) {
      expect(kindleCoverFingerprint(changed)).not.toBe(kindleCoverFingerprint(ITEM));
    }
    presenter.update([{ ...ITEM, size: 4097 }], true, "page0");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(initialUrl);
    expect(root.querySelector("img")).toBeNull();
  });

  it("discards late results after reset, including an in-progress thumbnail decode", async () => {
    let resolve!: (blob: Blob) => void;
    const prepare = vi.fn(() => new Promise<Blob>((done) => { resolve = done; }));
    const { root, presenter } = mount([ITEM], vi.fn(async () => COVER), prepare);
    Observer.current.show(row(root));
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    presenter.reset();
    presenter.update([ITEM], false, "page0");
    resolve(new Blob(["old-session"]));
    await wait();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(root.querySelector("img")).toBeNull();
  });

  it("cleans URLs on removed items, reset, disposal and browser image decode failure", async () => {
    const { root, presenter } = mount();
    for (const cleanup of ["remove", "reset", "error", "dispose"]) {
      presenter.reset();
      presenter.update([ITEM], true, "page0");
      Observer.current.show(row(root));
      await vi.waitFor(() => expect(root.querySelector("img")).not.toBeNull());
      const image = root.querySelector("img")!;
      const url = image.src;
      if (cleanup === "remove") presenter.update([], true, "page0");
      else if (cleanup === "reset") presenter.reset();
      else if (cleanup === "error") image.dispatchEvent(new Event("error"));
      else presenter.dispose();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
      expect(root.querySelector("img")).toBeNull();
    }
  });

  it("does not read while paused, retries transient operation contention on refresh, and preserves already-loaded covers", async () => {
    const request = vi.fn().mockRejectedValueOnce({ code: "KINDLE_OPERATION_BUSY" }).mockResolvedValue(COVER);
    const { root, presenter } = mount([ITEM], request);
    presenter.update([ITEM], false, "page0");
    await wait();
    expect(request).not.toHaveBeenCalled();
    presenter.update([ITEM], true, "page0");
    Observer.current.show(row(root));
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await wait();
    expect(request).toHaveBeenCalledOnce();
    presenter.update([ITEM], true, "page0");
    Observer.current.show(row(root));
    await vi.waitFor(() => expect(root.querySelector("img")).not.toBeNull());
    presenter.update([ITEM], false, "page0");
    expect(root.querySelector("img")).not.toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("bounds the no-IntersectionObserver fallback to actual visible rows", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 20, bottom: 40, height: 20 } as DOMRect);
    const items = Array.from({ length: 100 }, (_, index) => ({ ...ITEM, id: `file-${index}` }));
    const { request } = mount(items);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(12));
    await wait();
    expect(request).toHaveBeenCalledTimes(12);
  });

  it("evicts retained bytes without repeatedly rereading evicted visible files", async () => {
    const items = Array.from({ length: 3 }, (_, index) => ({ ...ITEM, id: `file-${index}` }));
    const prepare = vi.fn(async () => new Blob([new Uint8Array(5 * 1024 * 1024)]));
    const { root, request } = mount(items, vi.fn(async () => COVER), prepare);
    Observer.current.show(row(root), row(root, 1), row(root, 2));
    await vi.waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2));
    expect(root.querySelectorAll("img")).toHaveLength(1);
    expect(root.querySelector("img")?.src).toBe("blob:kindle-cover-3");
    await wait();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("keeps identical snapshot publications on the existing visibility observer", async () => {
    const items = [ITEM];
    const { presenter, root } = mount(items);
    const original = Observer.current;
    presenter.update(items, true, "page0");
    expect(Observer.current).toBe(original);
    original.show(row(root));
    await vi.waitFor(() => expect(root.querySelector("img")).not.toBeNull());
  });

  it("pauses without inspecting DOM, rejects late reads and restores cached images on the same page", async () => {
    let resolve!: (cover: KindleBookCover) => void;
    const request = vi.fn().mockResolvedValueOnce(COVER)
      .mockImplementationOnce(() => new Promise<KindleBookCover>((done) => { resolve = done; }))
      .mockResolvedValue(COVER);
    const items = [ITEM, { ...ITEM, id: "device-2" }, { ...ITEM, id: "device-3" }];
    const { root, presenter } = mount(items, request);
    Observer.current.show(row(root));
    await vi.waitFor(() => expect(root.querySelector("img")).not.toBeNull());
    const initialUrl = root.querySelector("img")!.src;
    const originalObserver = Observer.current;
    const secondRow = row(root, 1);
    const thirdRow = row(root, 2);
    originalObserver.show(secondRow, thirdRow);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    const query = vi.spyOn(root, "querySelector");
    const queryAll = vi.spyOn(root, "querySelectorAll");
    const observe = vi.spyOn(Observer.prototype, "observe");
    for (let index = 0; index < 100; index += 1) presenter.pause();
    expect(query).not.toHaveBeenCalled();
    expect(queryAll).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    originalObserver.show(secondRow, thirdRow);
    resolve(COVER);
    await wait();
    expect(request).toHaveBeenCalledTimes(2);
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    presenter.update(items, true, "page0");
    expect(root.querySelector("img")?.src).toBe(initialUrl);
    Observer.current.show(row(root), row(root, 1));
    await vi.waitFor(() => expect(root.querySelectorAll("img")).toHaveLength(2));
    expect(request).toHaveBeenCalledTimes(3);
  });
});

describe("AppView Kindle cover integration", () => {
  it("requests covers only on On Kindle after safe-write readiness, independently of library matching availability", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const request = vi.fn(async () => COVER);
    const noop = () => undefined;
    const state: AppState = {
      ...initialAppState(), secureContext: true, webUsbAvailable: true,
      device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981 } },
      postConnectStage: "safe-write", catalogInventoryState: "failed",
    };
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 80, height: 120, close: noop })));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: noop } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["small cover"], { type: "image/png" })));
    const view = new AppView(root, state, {
      onKindleCoverRequested: request,
      onTargetProfileSaved: noop, onEpubSelected: noop, onConvert: noop, onDownloadConverted: noop,
      onConnect: noop, onDisconnect: noop, onSelfTest: noop, onSendIntegrated: noop,
      onIntegratedOpenConfirmed: noop, onCleanupInspectionConfirmed: noop, onCopyLog: noop,
    }, new DebugLog(), { autoStartCatalog: false });
    views.push(view);
    const inventory = { items: [ITEM], total: 1, scannedAt: "2026-09-14T12:00:00Z", deviceLabel: "Kindle",
      completeness: "complete" as const, truncated: false,
      matching: { status: "unavailable" as const, matchedProfiles: 0, failedProfiles: 1 } };
    view.setCatalogKindleInventory(inventory);
    await wait();
    expect(request).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>('[data-ui-view="on-kindle"]')!.click();
    await vi.waitFor(() => expect(root.querySelector(".kindle-library-view")).not.toBeNull());
    await wait();
    expect(request).not.toHaveBeenCalled();
    view.render({ ...state, selfTest: { kind: "passed", byteLength: 1037 }, postConnectStage: "idle",
      pendingObjectCleanup: { version: 1, purpose: "self-test", stage: "handle-assigned", filename: "byte-test",
        size: 1037, vendorId: 0x1949, productId: 0x9981, storageId: 1, parentHandle: 2, recordedAt: 42 } });
    await wait();
    expect(request).not.toHaveBeenCalled();
    view.render({ ...state, selfTest: { kind: "passed", byteLength: 1037 }, postConnectStage: "idle" });
    Observer.current.show(row(root));
    await vi.waitFor(() => expect(root.querySelector("img[data-kindle-cover-image]")).not.toBeNull());
    expect(request).toHaveBeenCalledExactlyOnceWith(ITEM.id);
    const coverUrl = root.querySelector<HTMLImageElement>("img[data-kindle-cover-image]")!.src;
    for (const layout of ["list", "grid"] as const) {
      root.querySelector<HTMLButtonElement>(`[data-ui-action="set-library-layout"][data-layout="${layout}"]`)!.click();
      expect(root.querySelector(".kindle-library-list")?.getAttribute("data-layout")).toBe(layout);
      expect(root.querySelector<HTMLImageElement>("img[data-kindle-cover-image]")?.src).toBe(coverUrl);
      expect(request).toHaveBeenCalledOnce();
    }
    root.querySelector<HTMLButtonElement>('[data-ui-view="all"]')!.click();
    await vi.waitFor(() => expect(root.querySelector(".kindle-library-view")).toBeNull());
    view.setCatalogKindleInventory({ ...inventory, items: [ITEM, { ...ITEM, id: "other-device-file" }], total: 2 });
    const query = vi.spyOn(root, "querySelector");
    const queryAll = vi.spyOn(root, "querySelectorAll");
    const observe = vi.spyOn(Observer.prototype, "observe");
    for (let index = 0; index < 100; index += 1) view.refreshKindleCovers();
    expect(query).not.toHaveBeenCalled();
    expect(queryAll).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    await wait();
    expect(request).toHaveBeenCalledOnce();
  });
});

describe("browser cover thumbnails", () => {
  it("downscales and releases a decoded bitmap", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 800, height: 1200, close })));
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, callback) {
      expect(this.width).toBe(320);
      expect(this.height).toBe(480);
      callback(new Blob(["small raster"], { type: "image/png" }));
    });
    expect((await prepareKindleCoverThumbnail(COVER))?.type).toBe("image/png");
    expect(drawImage).toHaveBeenCalledOnce();
    expect(toBlob).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects unsupported bytes and oversized decoded dimensions, and closes even rejected bitmaps", async () => {
    const close = vi.fn();
    const decode = vi.fn(async () => ({ width: 8193, height: 500, close }));
    vi.stubGlobal("createImageBitmap", decode);
    expect(await prepareKindleCoverThumbnail({ ...COVER, bytes: new Uint8Array() })).toBeUndefined();
    expect(await prepareKindleCoverThumbnail({ ...COVER, bytes: new Uint8Array(12 * 1024 * 1024 + 1) })).toBeUndefined();
    expect(decode).not.toHaveBeenCalled();
    expect(await prepareKindleCoverThumbnail(COVER)).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it("times out a stalled decode and releases its eventual bitmap", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (image: { width: number; height: number; close: () => void }) => void;
      vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise((resolve) => { finish = resolve; })));
      const pending = prepareKindleCoverThumbnail(COVER);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toBeUndefined();
      const close = vi.fn();
      finish({ width: 240, height: 360, close });
      await Promise.resolve();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
