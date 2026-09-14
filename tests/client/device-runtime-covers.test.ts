import { describe, expect, it, vi } from "vitest";
import { ConnectedKindle } from "../../client/src/device-runtime";
import {
  buildKindleInventory, type KindleStoredObjectInfo, type KindleTarget,
} from "../../client/src/kindle";
import { createKindleCoverCache, type KindleCoverCache } from "../../client/src/kindle/cover-cache";
import { MAX_KINDLE_COVER_OBJECT_BYTES } from "../../client/src/kindle/device-cover-reader";
import { coverPng, deviceBook } from "../kindle/cover-fixtures";

const STORAGE = 0x10001;
const DOCUMENTS = 42;
const HANDLE = 10;

function info(handle = HANDLE, overrides: Partial<KindleStoredObjectInfo> = {}): KindleStoredObjectInfo {
  return { handle, storageId: STORAGE, objectFormat: 0x3000, protectionStatus: 0,
    compressedSize: deviceBook().length, parentHandle: DOCUMENTS, associationType: 0,
    filename: `Device-${handle}.azw3`, modificationDate: "20260914T120000.", ...overrides };
}

async function harness(options: {
  readonly objects?: KindleStoredObjectInfo[];
  readonly cache?: KindleCoverCache;
  readonly identity?: string;
  readonly scan?: boolean;
} = {}) {
  const order: string[] = [];
  const objects = new Map((options.objects ?? [info()]).map((entry) => [entry.handle, entry]));
  const store = {
    listObjectHandles: vi.fn(async (query: { associationHandle?: number }) => [...objects.values()]
      .filter((entry) => entry.parentHandle === query.associationHandle).map((entry) => entry.handle)),
    getObjectInfo: vi.fn(async (handle: number) => {
      order.push(`info:${handle}`);
      const object = objects.get(handle);
      if (!object) throw new Error("missing object");
      return { ...object };
    }),
    readObject: vi.fn(async (_handle: number, _options: unknown) => { order.push("read"); return deviceBook(); }),
    createObject: vi.fn(), deleteObject: vi.fn(), readObjectRange: vi.fn(),
  };
  const target: KindleTarget = {
    storageId: STORAGE, documentsHandle: DOCUMENTS,
    storage: { storageType: 3, filesystemType: 2, accessCapability: 0,
      maxCapacity: 1_000_000n, freeSpaceInBytes: 500_000n, freeSpaceInImages: 0,
      storageDescription: "Kindle", volumeLabel: "Kindle" },
    documents: info(DOCUMENTS, { filename: "Documents", compressedSize: 0,
      parentHandle: 0xffff_ffff, objectFormat: 0x3001, associationType: 1 }),
  };
  const kindle = {
    store,
    inventory: vi.fn(async (inventoryOptions = {}) => {
      order.push("inventory");
      return buildKindleInventory(store as never, target, inventoryOptions);
    }),
    runSelfTest: vi.fn(async () => ({ filename: "test", handle: 99, bytesVerified: 1, cleanedUp: true as const })),
  };
  const session = { isOpen: true, close: vi.fn(async () => { order.push("session-close"); session.isOpen = false; }) };
  const transport = { close: vi.fn(async () => { order.push("usb-close"); }) };
  const lease = { release: vi.fn(async () => { order.push("release"); }) };
  const connection = new ConnectedKindle({ vendorId: 0x1949, productId: 0x9981 } as never,
    { vendorId: 0x1949, productId: 0x9981 }, transport as never, session as never,
    kindle as never, lease as never, options.identity ?? "a".repeat(64), "installation", false,
    options.cache ?? createKindleCoverCache({ persistence: null }));
  if (options.scan !== false) await connection.refreshInventory({ bookMetadata: false, deviceMetadataCache: false });
  store.getObjectInfo.mockClear();
  order.length = 0;
  return { connection, store, kindle, objects, session, transport, lease, order };
}

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("ConnectedKindle optional device cover reads", () => {
  it("reads the actual file between exact metadata checks without device mutations", async () => {
    const { connection, store, order } = await harness();
    const source = deviceBook();
    const original = source.slice();
    store.readObject.mockResolvedValue(source);
    expect(await connection.readBookCover(HANDLE)).toEqual({ bytes: coverPng(), mediaType: "image/png" });
    expect(order).toEqual(["info:10", "info:10"]);
    expect(store.readObject).toHaveBeenCalledWith(HANDLE, expect.objectContaining({ maxBytes: source.length }));
    expect(source).toEqual(original);
    expect(store.createObject).not.toHaveBeenCalled();
    expect(store.deleteObject).not.toHaveBeenCalled();
    expect(store.readObjectRange).not.toHaveBeenCalled();
    store.getObjectInfo.mockClear();
    await connection.readBookCover(HANDLE);
    expect(store.readObject).toHaveBeenCalledTimes(1);
    expect(store.getObjectInfo).toHaveBeenCalledTimes(2);
  });

  it("requires an actual complete current inventory and rejects absent, unsupported, adjusted, or ambiguous objects", async () => {
    const unscanned = await harness({ scan: false });
    expect(await unscanned.connection.readBookCover(HANDLE)).toBeUndefined();
    const missing = await harness();
    expect(await missing.connection.readBookCover(999)).toBeUndefined();
    expect(missing.store.getObjectInfo).not.toHaveBeenCalled();
    for (const filename of ["Book.kfx", "Book.azw8", "cover.png", "Bad\\Name.azw3"]) {
      const { connection, store } = await harness({ objects: [info(HANDLE, { filename })] });
      expect(await connection.readBookCover(HANDLE)).toBeUndefined();
      expect(store.readObject).not.toHaveBeenCalled();
    }
    const duplicate = await harness({ objects: [info(), info(11, { filename: info().filename })] });
    expect(await duplicate.connection.readBookCover(HANDLE)).toBeUndefined();
    expect(duplicate.store.readObject).not.toHaveBeenCalled();
    const partial = await harness({ objects: [info(), info(11)] });
    await partial.connection.refreshInventory({ bookMetadata: false, maxObjects: 1 });
    expect(await partial.connection.readBookCover(HANDLE)).toBeUndefined();
  });

  it("does not reuse cached covers for another Kindle or stale/removed objects", async () => {
    const cache = createKindleCoverCache({ persistence: null });
    const first = await harness({ cache });
    await first.connection.readBookCover(HANDLE);
    const second = await harness({ cache, identity: "b".repeat(64) });
    await second.connection.readBookCover(HANDLE);
    expect(second.store.readObject).toHaveBeenCalledTimes(1);
    first.objects.set(HANDLE, info(HANDLE, { modificationDate: "20260914T120001." }));
    expect(await first.connection.readBookCover(HANDLE)).toBeUndefined();
    expect(first.store.readObject).toHaveBeenCalledTimes(1);
    await first.connection.refreshInventory({ bookMetadata: false });
    await first.connection.readBookCover(HANDLE);
    expect(first.store.readObject).toHaveBeenCalledTimes(2);
    first.objects.delete(HANDLE);
    expect(await first.connection.readBookCover(HANDLE)).toBeUndefined();
  });

  it("rejects changed post-read ObjectInfo and freshly validates nested parent paths", async () => {
    const changed = await harness();
    changed.store.readObject.mockImplementation(async () => {
      changed.objects.set(HANDLE, info(HANDLE, { filename: "Replaced.azw3" }));
      return deviceBook();
    });
    expect(await changed.connection.readBookCover(HANDLE)).toBeUndefined();
    const nested = await harness({ objects: [
      info(50, { filename: "Folder", objectFormat: 0x3001, associationType: 1, compressedSize: 0 }),
      info(HANDLE, { parentHandle: 50 }),
    ] });
    expect(await nested.connection.readBookCover(HANDLE)).toBeDefined();
    expect(nested.order).toEqual(["info:10", "info:50", "read", "info:10", "info:50"]);
    nested.objects.set(50, info(50, { filename: "Changed", objectFormat: 0x3001, associationType: 1, compressedSize: 0 }));
    expect(await nested.connection.readBookCover(HANDLE)).toBeUndefined();
    expect(nested.store.readObject).toHaveBeenCalledTimes(1);
  });

  it("reads fresh without persistent evidence when the device timestamp is missing", async () => {
    const { connection, store } = await harness({ objects: [info(HANDLE, { modificationDate: "" })] });
    expect(await connection.readBookCover(HANDLE)).toBeDefined();
    expect(await connection.readBookCover(HANDLE)).toBeDefined();
    expect(store.readObject).toHaveBeenCalledTimes(2);
  });

  it("revalidates after a slow cache lookup and refuses a removed live object", async () => {
    const pending = gate<{ cover: { bytes: Uint8Array; mediaType: "image/png" } }>();
    const cache = { lookup: vi.fn(() => pending.promise), remember: vi.fn(async () => undefined) };
    const { connection, objects, store } = await harness({ cache });
    const read = connection.readBookCover(HANDLE);
    await vi.waitFor(() => expect(cache.lookup).toHaveBeenCalled());
    objects.delete(HANDLE);
    pending.resolve({ cover: { bytes: coverPng(), mediaType: "image/png" } });
    expect(await read).toBeUndefined();
    expect(store.readObject).not.toHaveBeenCalled();
  });

  it("bounds each file at 32 MiB and reserves at most 256 MiB per connection including failed reads", async () => {
    const big = await harness({ objects: [info(HANDLE, { compressedSize: MAX_KINDLE_COVER_OBJECT_BYTES + 1 })] });
    expect(await big.connection.readBookCover(HANDLE)).toBeUndefined();
    expect(big.store.readObject).not.toHaveBeenCalled();
    const { connection, store } = await harness({ objects: Array.from({ length: 9 }, (_, index) =>
      info(index + 10, { compressedSize: MAX_KINDLE_COVER_OBJECT_BYTES })) });
    store.readObject.mockResolvedValue(new Uint8Array(1));
    for (let handle = 10; handle < 19; handle += 1) expect(await connection.readBookCover(handle)).toBeUndefined();
    expect(store.readObject).toHaveBeenCalledTimes(8);
  });

  it("gives foreground operations priority after the current metadata command drains", async () => {
    const { connection, store, kindle } = await harness();
    const pendingInfo = gate<KindleStoredObjectInfo>();
    store.getObjectInfo.mockImplementationOnce(() => pendingInfo.promise);
    const cover = connection.readBookCover(HANDLE);
    const foreground = connection.runSelfTest();
    expect(kindle.runSelfTest).not.toHaveBeenCalled();
    await expect(connection.readBookCover(HANDLE)).rejects.toMatchObject({ code: "KINDLE_OPERATION_BUSY" });
    pendingInfo.resolve(info());
    expect(await cover).toBeUndefined();
    await foreground;
    expect(store.readObject).not.toHaveBeenCalled();
    expect(kindle.runSelfTest).toHaveBeenCalledTimes(1);
  });

  it("drains a whole-object read before scanning, and never starts concurrent device work", async () => {
    const { connection, store, kindle } = await harness();
    const pending = gate<Uint8Array>();
    store.readObject.mockImplementation(() => pending.promise);
    const cover = connection.readBookCover(HANDLE);
    await vi.waitFor(() => expect(store.readObject).toHaveBeenCalledTimes(1));
    const scanCount = kindle.inventory.mock.calls.length;
    const scan = connection.refreshInventory({ bookMetadata: false });
    expect(kindle.inventory).toHaveBeenCalledTimes(scanCount);
    await expect(connection.readBookCover(HANDLE)).rejects.toMatchObject({ code: "KINDLE_OPERATION_BUSY" });
    pending.resolve(deviceBook());
    expect(await cover).toBeUndefined();
    await scan;
    expect(kindle.inventory).toHaveBeenCalledTimes(scanCount + 1);
  });

  it("treats navigation cancellation as advisory and leaves the session usable after draining", async () => {
    const { connection, store } = await harness();
    const pending = gate<Uint8Array>();
    store.readObject.mockImplementationOnce(() => pending.promise);
    const cancellation = new AbortController();
    const cover = connection.readBookCover(HANDLE, { signal: cancellation.signal });
    await vi.waitFor(() => expect(store.readObject).toHaveBeenCalledTimes(1));
    expect(store.readObject.mock.calls[0]![1]).not.toHaveProperty("signal");
    cancellation.abort();
    pending.resolve(deviceBook());
    expect(await cover).toBeUndefined();
    expect(await connection.readBookCover(HANDLE)).toBeDefined();
  });

  it("waits for the current read before orderly disconnect and closes physical removal safely", async () => {
    const normal = await harness();
    const pending = gate<Uint8Array>();
    normal.store.readObject.mockImplementationOnce(() => pending.promise);
    const cover = normal.connection.readBookCover(HANDLE);
    await vi.waitFor(() => expect(normal.store.readObject).toHaveBeenCalled());
    const closing = normal.connection.disconnect();
    expect(normal.session.close).not.toHaveBeenCalled();
    pending.resolve(deviceBook());
    expect(await cover).toBeUndefined();
    await closing;
    expect(normal.order.slice(-3)).toEqual(["session-close", "usb-close", "release"]);

    const physical = await harness();
    const unplugged = gate<Uint8Array>();
    physical.store.readObject.mockImplementationOnce(() => unplugged.promise);
    const read = physical.connection.readBookCover(HANDLE);
    const expectedFailure = expect(read).rejects.toMatchObject({ code: "USB_DEVICE_DISCONNECTED" });
    await vi.waitFor(() => expect(physical.store.readObject).toHaveBeenCalled());
    physical.transport.close.mockImplementation(async () => {
      unplugged.reject(Object.assign(new Error("unplugged"), { code: "USB_DEVICE_DISCONNECTED" }));
    });
    await physical.connection.closeAfterPhysicalDisconnect();
    await expectedFailure;
    expect(physical.session.close).not.toHaveBeenCalled();
    expect(physical.lease.release).toHaveBeenCalledTimes(1);
  });

  it("propagates fatal transport failures to the caller and waiting foreground work", async () => {
    const { connection, store, kindle } = await harness();
    const pending = gate<Uint8Array>();
    store.readObject.mockImplementationOnce(() => pending.promise);
    const read = connection.readBookCover(HANDLE);
    const readFailure = expect(read).rejects.toMatchObject({ fatal: true });
    await vi.waitFor(() => expect(store.readObject).toHaveBeenCalled());
    const foreground = connection.runSelfTest();
    const foregroundFailure = expect(foreground).rejects.toMatchObject({ fatal: true });
    pending.reject(Object.assign(new Error("faulted"), { code: "MTP_TRANSPORT_ERROR", fatal: true }));
    await Promise.all([readFailure, foregroundFailure]);
    expect(kindle.runSelfTest).not.toHaveBeenCalled();
  });

  it("revokes optional cover freshness after a failed refresh", async () => {
    const { connection, kindle, store } = await harness();
    await connection.readBookCover(HANDLE);
    kindle.inventory.mockRejectedValueOnce(new Error("scan failed"));
    await expect(connection.refreshInventory()).rejects.toThrow("scan failed");
    store.getObjectInfo.mockClear();
    expect(await connection.readBookCover(HANDLE)).toBeUndefined();
    expect(store.getObjectInfo).not.toHaveBeenCalled();
  });

  it("preserves current cover eligibility after a successful standalone self-test", async () => {
    const { connection } = await harness();
    await connection.runSelfTest();
    expect(await connection.readBookCover(HANDLE)).toBeDefined();
  });
});
