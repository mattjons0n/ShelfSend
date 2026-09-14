import { afterEach, describe, expect, it, vi } from "vitest";
import type { KindleTarget } from "../../client/src/kindle/contracts";
import {
  buildKindleInventory,
  type KindleInventoryProgress,
} from "../../client/src/kindle/inventory";
import { KindleDevice, MTP_OBJECT_FORMAT_ASSOCIATION } from "../../client/src/kindle/kindle-device";
import { createKindleMetadataCache, type KindleMetadataCache } from "../../client/src/kindle/metadata-cache";
import { makeKindleBookFixture } from "./book-fixture";
import { FakeKindleObjectStore, objectInfo, storageInfo } from "./fake-store";

afterEach(() => vi.restoreAllMocks());

function target(store: FakeKindleObjectStore): KindleTarget {
  return { storageId: 1, storage: storageInfo(), documentsHandle: 10, documents: store.objects.get(10)! };
}

function addBook(store: FakeKindleObjectStore, handle: number, filename = `Book-${handle}.azw3`): void {
  const bytes = makeKindleBookFixture({ exthTitle: `Book ${handle}`, authors: ["Sample Author"] });
  store.objects.set(handle, objectInfo(handle, {
    parentHandle: 10,
    filename,
    compressedSize: bytes.byteLength,
    modificationDate: "20260829T120000.",
  }));
  store.objectData.set(handle, bytes);
}

function advanceOnEachReport(): void {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now += 150);
}

function metadataEvents(events: readonly KindleInventoryProgress[]): readonly KindleInventoryProgress[] {
  return events.filter(({ phase }) => phase === "metadata");
}

describe("measured Kindle inventory progress", () => {
  it("reports live enumeration without an invented total, then processed book counts", async () => {
    advanceOnEachReport();
    const store = new FakeKindleObjectStore();
    store.objects.set(20, objectInfo(20, {
      parentHandle: 10, filename: "Fiction", objectFormat: MTP_OBJECT_FORMAT_ASSOCIATION, associationType: 1,
    }));
    store.objects.set(21, objectInfo(21, { parentHandle: 20, filename: "Notes.txt" }));
    addBook(store, 11);
    addBook(store, 12);
    const events: KindleInventoryProgress[] = [];
    const inventory = await buildKindleInventory(store, target(store), { onProgress: (event) => events.push(event) });

    expect(events.filter(({ phase }) => phase === "enumerating")).toEqual([
      { phase: "enumerating", completed: 0 },
      { phase: "enumerating", completed: 1 },
      { phase: "enumerating", completed: 2 },
      { phase: "enumerating", completed: 3 },
      { phase: "enumerating", completed: 4 },
    ]);
    expect(metadataEvents(events)).toEqual([
      { phase: "metadata", completed: 0, total: 2 },
      { phase: "metadata", completed: 1, total: 2 },
      { phase: "metadata", completed: 2, total: 2 },
    ]);
    expect(inventory.scannedObjectCount).toBe(4);
    expect(events.every(Object.isFrozen)).toBe(true);
    expect(store.readRequests.map(({ handle }) => handle)).toEqual([11, 12]);
    expect(store.createRequests).toEqual([]);
    expect(store.deletedHandles).toEqual([]);
  });

  it("counts uniquely visited objects even when their object information is unavailable", async () => {
    const store = new FakeKindleObjectStore();
    addBook(store, 11);
    addBook(store, 12);
    store.metadataFailures.set(11, new Error("Unreadable object"));
    const events: KindleInventoryProgress[] = [];
    const inventory = await buildKindleInventory(store, target(store), { onProgress: (event) => events.push(event) });

    expect(events.filter(({ phase }) => phase === "enumerating").at(-1)).toEqual({ phase: "enumerating", completed: 2 });
    expect(metadataEvents(events).at(-1)).toEqual({ phase: "metadata", completed: 1, total: 1 });
    expect(inventory.status).toBe("partial");
    expect(inventory.scannedObjectCount).toBe(1);
  });

  it("counts cache hits on a warm scan without any extra book reads", async () => {
    advanceOnEachReport();
    const store = new FakeKindleObjectStore();
    addBook(store, 11);
    addBook(store, 12);
    const cache = createKindleMetadataCache({ persistence: null, now: () => 1_000 });
    const kindle = new KindleDevice(store, undefined, { cache, identity: { key: "a".repeat(64), stability: "installation" } });
    const cold: KindleInventoryProgress[] = [];
    const first = await kindle.inventory({ deviceMetadataCache: false, onProgress: (event) => cold.push(event) });
    const coldReads = store.readRequests.length;
    const warm: KindleInventoryProgress[] = [];
    const second = await kindle.inventory({ deviceMetadataCache: false, onProgress: (event) => warm.push(event) });

    expect(first.bookMetadata?.attemptedObjectCount).toBe(2);
    expect(second.bookMetadata?.cacheHitObjectCount).toBe(2);
    expect(store.readRequests).toHaveLength(coldReads);
    expect(metadataEvents(warm)).toEqual(metadataEvents(cold));
    expect(metadataEvents(warm).at(-1)).toEqual({ phase: "metadata", completed: 2, total: 2 });
  });

  it("advances through managed, unsupported, oversized, and failed objects", async () => {
    advanceOnEachReport();
    const store = new FakeKindleObjectStore();
    addBook(store, 11, "Owned-kb-0123456789abcdefabcd-20260829T120000Z-000000.azw3");
    addBook(store, 12, "Unsupported.kfx");
    addBook(store, 13, "Too-large.azw3");
    store.objects.set(13, { ...store.objects.get(13)!, compressedSize: 10_000 });
    addBook(store, 14, "Unreadable.azw3");
    store.readFailures.set(14, new Error("Read failed"));
    addBook(store, 15);
    const events: KindleInventoryProgress[] = [];
    const inventory = await buildKindleInventory(store, target(store), {
      bookMetadata: { maxObjectBytes: 1_000 }, onProgress: (event) => events.push(event),
    });

    expect(metadataEvents(events).map(({ completed }) => completed)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(metadataEvents(events).every(({ total }) => total === 5)).toBe(true);
    expect(inventory.bookMetadata).toMatchObject({
      eligibleObjectCount: 5, managedObjectCount: 1, skippedObjectCount: 2, failedObjectCount: 1, parsedObjectCount: 1,
    });
    expect(store.readRequests.map(({ handle }) => handle)).toEqual([14, 15]);
  });

  it("counts objects skipped by aggregate object and byte budgets", async () => {
    for (const bookMetadata of [{ maxObjects: 1 }, { maxTotalBytes: 1 }]) {
      const store = new FakeKindleObjectStore();
      addBook(store, 11);
      addBook(store, 12);
      const events: KindleInventoryProgress[] = [];
      const inventory = await buildKindleInventory(store, target(store), { bookMetadata, onProgress: (event) => events.push(event) });
      expect(inventory.bookMetadata?.skippedObjectCount).toBeGreaterThan(0);
      expect(metadataEvents(events).at(-1)).toEqual({ phase: "metadata", completed: 2, total: 2 });
    }
  });

  it("does not report a successful total after a fatal transport failure", async () => {
    advanceOnEachReport();
    const store = new FakeKindleObjectStore();
    addBook(store, 11);
    addBook(store, 12);
    const failure = Object.assign(new Error("Connection lost"), { code: "MTP_TRANSPORT_ERROR" });
    store.readFailures.set(12, failure);
    const events: KindleInventoryProgress[] = [];
    await expect(buildKindleInventory(store, target(store), { onProgress: (event) => events.push(event) })).rejects.toBe(failure);
    expect(metadataEvents(events).map(({ completed }) => completed)).toEqual([0, 1]);
  });

  it("does not publish progress after an abort, including during the final cache flush", async () => {
    const store = new FakeKindleObjectStore();
    addBook(store, 11);
    const abort = new AbortController();
    const reason = new DOMException("Cancelled", "AbortError");
    const cache: KindleMetadataCache = {
      lookup: async () => undefined,
      lookupMany: async (evidence) => evidence.map(() => undefined),
      remember: async () => false,
      rememberMany: async () => { abort.abort(reason); return 1; },
      clear: async () => undefined,
    };
    const events: KindleInventoryProgress[] = [];
    await expect(buildKindleInventory(store, target(store), {
      signal: abort.signal, onProgress: (event) => events.push(event),
    }, undefined, { cache, identity: { key: "a".repeat(64), stability: "installation" } })).rejects.toBe(reason);
    expect(metadataEvents(events)).toEqual([{ phase: "metadata", completed: 0, total: 1 }]);

    const afterAbort: KindleInventoryProgress[] = [];
    await expect(buildKindleInventory(store, target(store), {
      signal: abort.signal, onProgress: (event) => afterAbort.push(event),
    })).rejects.toBe(reason);
    expect(afterAbort).toEqual([]);
  });

  it("keeps observer exceptions separate from reads, results, and safe device state", async () => {
    const firstStore = new FakeKindleObjectStore();
    const secondStore = new FakeKindleObjectStore();
    for (const store of [firstStore, secondStore]) { addBook(store, 11); addBook(store, 12); }
    const expected = await buildKindleInventory(firstStore, target(firstStore));
    const observer = vi.fn(() => { throw new Error("Broken renderer"); });
    const actual = await buildKindleInventory(secondStore, target(secondStore), { onProgress: observer });
    expect(observer).toHaveBeenCalled();
    expect(actual).toEqual(expected);
    expect(secondStore.readRequests).toEqual(firstStore.readRequests);
    expect(secondStore.metadataRequests).toEqual(firstStore.metadataRequests);
    expect(secondStore.childListRequests).toEqual(firstStore.childListRequests);
    expect(secondStore.deletedHandles).toEqual([]);
    expect(secondStore.createRequests).toEqual([]);
  });

  it("bounds synchronous progress callbacks while retaining phase starts and final counts", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const store = new FakeKindleObjectStore();
    for (let handle = 11; handle < 1_011; handle += 1) addBook(store, handle, `Book-${handle}.kfx`);
    const events: KindleInventoryProgress[] = [];
    await buildKindleInventory(store, target(store), { onProgress: (event) => events.push(event) });
    expect(events).toEqual([
      { phase: "enumerating", completed: 0 },
      { phase: "enumerating", completed: 1_000 },
      { phase: "metadata", completed: 0, total: 1_000 },
      { phase: "metadata", completed: 1_000, total: 1_000 },
    ]);
    expect(store.readRequests).toEqual([]);
  });

  it("does not invent metadata work when enrichment is disabled or there are no books", async () => {
    const store = new FakeKindleObjectStore();
    const empty: KindleInventoryProgress[] = [];
    await buildKindleInventory(store, target(store), { onProgress: (event) => empty.push(event) });
    expect(empty).toEqual([{ phase: "enumerating", completed: 0 }, { phase: "metadata", completed: 0, total: 0 }]);
    addBook(store, 11);
    const disabled: KindleInventoryProgress[] = [];
    await buildKindleInventory(store, target(store), { bookMetadata: false, onProgress: (event) => disabled.push(event) });
    expect(disabled).toEqual([{ phase: "enumerating", completed: 0 }, { phase: "enumerating", completed: 1 }]);
    expect(store.readRequests).toEqual([]);
  });
});
