// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { convertEpub } from "../../client/src/api/convert";
import { epubFixture } from "./epub-fixture";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("browser-local EPUB conversion lifecycle", () => {
  it("does not create a boko worker when cancellation happens during the source read", async () => {
    let releaseRead!: (value: ArrayBuffer) => void;
    const delayedRead = new Promise<ArrayBuffer>((resolve) => { releaseRead = resolve; });
    const file = new File(["epub"], "cancelled.epub", { type: "application/epub+zip" });
    Object.defineProperty(file, "arrayBuffer", { value: vi.fn(() => delayedRead) });
    const WorkerConstructor = vi.fn();
    vi.stubGlobal("Worker", WorkerConstructor);
    const abort = new AbortController();

    const converting = convertEpub(file, abort.signal);
    abort.abort();
    await expect(converting).rejects.toMatchObject({ code: "CONVERSION_ABORTED" });
    releaseRead(new ArrayBuffer(4));
    await Promise.resolve();
    expect(WorkerConstructor).not.toHaveBeenCalled();
  });

  it("includes a stalled source read in the existing five-minute deadline and ignores its late result", async () => {
    vi.useFakeTimers();
    let releaseRead!: (value: ArrayBuffer) => void;
    const file = new File(["epub"], "deadline.epub");
    Object.defineProperty(file, "arrayBuffer", { value: () => new Promise<ArrayBuffer>((resolve) => { releaseRead = resolve; }) });
    const WorkerConstructor = vi.fn();
    vi.stubGlobal("Worker", WorkerConstructor);
    const converting = convertEpub(file);
    const assertion = expect(converting).rejects.toMatchObject({ code: "CONVERSION_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await assertion;
    releaseRead(new ArrayBuffer(4));
    await Promise.resolve();
    expect(WorkerConstructor).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a stalled replacement-cover read without waiting or creating the converter", async () => {
    const file = new File(["epub"], "cover.epub");
    Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(4) });
    const cover = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])]);
    let coverStarted!: () => void;
    const started = new Promise<void>((resolve) => { coverStarted = resolve; });
    Object.defineProperty(cover, "arrayBuffer", { value: () => { coverStarted(); return new Promise(() => {}); } });
    const WorkerConstructor = vi.fn();
    vi.stubGlobal("Worker", WorkerConstructor);
    const abort = new AbortController();
    const converting = convertEpub(file, abort.signal, { cover: { blob: cover, mediaType: "image/jpeg" } });
    const assertion = expect(converting).rejects.toMatchObject({ code: "CONVERSION_ABORTED" });
    await started;
    abort.abort();
    await assertion;
    expect(WorkerConstructor).not.toHaveBeenCalled();
  });

  it("shares one deadline across source preparation and the converter worker", async () => {
    vi.useFakeTimers();
    let releaseRead!: (value: ArrayBuffer) => void;
    const file = new File(["epub"], "shared-deadline.epub");
    Object.defineProperty(file, "arrayBuffer", { value: () => new Promise<ArrayBuffer>((resolve) => { releaseRead = resolve; }) });
    const terminate = vi.fn();
    const postMessage = vi.fn();
    vi.stubGlobal("Worker", class extends EventTarget { terminate = terminate; postMessage = postMessage; });
    const converting = convertEpub(file);
    const assertion = expect(converting).rejects.toMatchObject({ code: "CONVERSION_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    releaseRead(new ArrayBuffer(4));
    await vi.advanceTimersByTimeAsync(0);
    expect(postMessage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    await assertion;
    expect(terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels during EPUB metadata editing before a WASM worker can start", async () => {
    const metadata = Array.from({ length: 1000 }, (_, index) => `<meta property="belongs-to-collection" id="collection-${index}">Collection ${index}</meta>`).join("");
    const bytes = epubFixture({}, metadata);
    const file = new File([Uint8Array.from(bytes)], "metadata.epub");
    Object.defineProperty(file, "arrayBuffer", { value: async () => Uint8Array.from(bytes).buffer });
    const WorkerConstructor = vi.fn();
    vi.stubGlobal("Worker", WorkerConstructor);
    const abort = new AbortController();
    const get = Element.prototype.getAttribute;
    let visited = 0;
    vi.spyOn(Element.prototype, "getAttribute").mockImplementation(function (this: Element, name) {
      const value = get.call(this, name);
      if (name === "property" && value === "belongs-to-collection" && ++visited === 20) {
        globalThis.setTimeout(() => abort.abort(), 0);
      }
      return value;
    });
    await expect(convertEpub(file, abort.signal, { seriesIndex: 2 })).rejects.toMatchObject({ code: "CONVERSION_ABORTED" });
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 10));
    expect(visited).toBeLessThan(150);
    expect(WorkerConstructor).not.toHaveBeenCalled();
  });
});
