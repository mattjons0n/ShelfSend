import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initBoko, { convert } from "../../client/vendor/boko/boko.js";
import { parseKindleBookMetadata } from "../../client/src/kindle/book-metadata";
import { KoboDevice, KOBO_MAX_FILE_BYTES, KOBO_RECOVERY_STORAGE_KEY, KINDLE_DRIVE_RECOVERY_STORAGE_KEY } from "../../client/src/kobo/device";
import type { KoboDirectoryHandle, KoboFileHandle, KoboHandle, KoboIdentity, KoboWritable } from "../../client/src/kobo/types";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

class MemoryFile implements KoboFileHandle {
  readonly kind = "file" as const;
  bytes = new Uint8Array();
  closeCount = 0;
  abortCount = 0;
  writeSizes: number[] = [];
  onWrite?: () => void;
  onClose?: () => void;
  failWrite = false;
  constructor(readonly name: string) {}
  async isSameEntry(other: KoboHandle): Promise<boolean> { return other === this; }
  async getFile(): Promise<File> { return new File([this.bytes], this.name, { lastModified: 1 }); }
  async createWritable(options?: { keepExistingData?: boolean; mode?: "exclusive" }): Promise<KoboWritable> {
    expect(options?.mode).toBe("exclusive");
    let chunks: Uint8Array[] = [];
    return {
      write: async (chunk) => {
        if (this.failWrite) throw new DOMException("Device unplugged", "NotFoundError");
        this.writeSizes.push(chunk.byteLength);
        chunks.push(chunk.slice());
        this.onWrite?.();
      },
      close: async () => {
        this.closeCount++;
        const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
        this.bytes = result;
        this.onClose?.();
      },
      abort: async () => { this.abortCount++; chunks = []; },
    };
  }
}

class MemoryDirectory implements KoboDirectoryHandle {
  readonly kind = "directory" as const;
  children = new Map<string, KoboHandle>();
  removed: string[] = [];
  failAccess = false;
  onCreateFile?: (file: MemoryFile) => void;
  permission: PermissionState = "granted";
  constructor(readonly name: string) {}
  async isSameEntry(other: KoboHandle): Promise<boolean> { return other === this; }
  async queryPermission(): Promise<PermissionState> { return this.permission; }
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<KoboDirectoryHandle> {
    if (this.failAccess) throw new DOMException("Unplugged", "NotFoundError");
    let entry = this.children.get(name);
    if (!entry && options?.create) { entry = new MemoryDirectory(name); this.children.set(name, entry); }
    if (!entry) throw new DOMException("Missing", "NotFoundError");
    if (entry.kind !== "directory") throw new DOMException("Not a directory", "TypeMismatchError");
    return entry;
  }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<KoboFileHandle> {
    if (this.failAccess) throw new DOMException("Unplugged", "NotFoundError");
    let entry = this.children.get(name);
    if (!entry && options?.create) {
      entry = new MemoryFile(name);
      this.children.set(name, entry);
      this.onCreateFile?.(entry as MemoryFile);
    }
    if (!entry) throw new DOMException("Missing", "NotFoundError");
    if (entry.kind !== "file") throw new DOMException("Not a file", "TypeMismatchError");
    return entry;
  }
  async *entries(): AsyncIterableIterator<[string, KoboHandle]> {
    if (this.failAccess) throw new DOMException("Unplugged", "NotFoundError");
    yield* this.children.entries();
  }
  async removeEntry(name: string): Promise<void> {
    if (this.failAccess) throw new DOMException("Unplugged", "NotFoundError");
    this.removed.push(name);
    this.children.delete(name);
  }
}

const identity: KoboIdentity = {
  profileId: "profile-a", bookId: "book-a", contentHash: "a".repeat(64),
  presentationVersion: "b".repeat(64), title: "A book",
};
function epub(size = 64): Blob {
  const bytes = new Uint8Array(size);
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  return new Blob([bytes], { type: "application/epub+zip" });
}

describe("Kindle mounted-drive transport", () => {
  let coverBook: Uint8Array<ArrayBuffer>;
  beforeAll(async () => {
    await initBoko(await readFile("client/vendor/boko/boko_bg.wasm"));
    coverBook = Uint8Array.from(convert(await readFile("tests/fixtures/epictetus.epub"), "epub", "azw3"));
  });
  function fixture() {
    const root = new MemoryDirectory("Kindle");
    const documents = new MemoryDirectory("documents");
    const system = new MemoryDirectory("system");
    const version = new MemoryFile("version.txt");
    version.bytes = new TextEncoder().encode("System Software Version: Kindle 5.16");
    system.children.set(version.name, version);
    root.children.set("system", system);
    root.children.set("documents", documents);
    const storage = new MemoryStorage();
    const connect = () => KoboDevice.connect({ reader: "kindle-drive", picker: async () => root, storage, locks: null });
    const bytes = new Uint8Array(128);
    bytes.set(new TextEncoder().encode("BOOKMOBI"), 60);
    return { root, documents, system, storage, connect, artifact: new Blob([bytes]) };
  }

  it("reads embedded metadata from bounded prefixes without reading whole books", async () => {
    const { documents, connect } = fixture();
    const handle = new MemoryFile("misleading-filename.mobi");
    handle.bytes = coverBook.slice();
    const file = await handle.getFile();
    const fullRead = vi.spyOn(file, "arrayBuffer");
    const slices = vi.spyOn(file, "slice");
    vi.spyOn(handle, "getFile").mockResolvedValue(file);
    documents.children.set(handle.name, handle);
    const device = await connect();
    const entry = (await device.scan()).entries[0]!;
    expect(entry.metadata).toEqual(parseKindleBookMetadata(coverBook));
    expect(entry.metadata?.title).toBeTruthy();
    expect(entry.metadata?.authors.length).toBeGreaterThan(0);
    expect(fullRead).not.toHaveBeenCalled();
    expect(slices.mock.calls.every(([start, end]) => start === 0 && end! <= 1024 * 1024)).toBe(true);
    expect(handle.bytes).toEqual(coverBook);
  });

  it("keeps malformed files visible without inventing metadata", async () => {
    const { documents, connect } = fixture();
    const handle = new MemoryFile("Broken.azw3");
    handle.bytes = coverBook.slice();
    new DataView(handle.bytes.buffer).setUint32(86, 2 * 1024 * 1024, false);
    documents.children.set(handle.name, handle);
    const device = await connect();
    const entry = (await device.scan()).entries[0]!;
    expect(entry.name).toBe(handle.name);
    expect(entry.metadata).toBeUndefined();
  });

  it("extracts a real embedded cover without modifying the scanned book or creating files", async () => {
    const { documents, connect } = fixture();
    const file = new MemoryFile("Existing.mobi");
    file.bytes = coverBook.slice();
    documents.children.set(file.name, file);
    const device = await connect();
    const entry = (await device.scan()).entries[0]!;
    const cover = await device.readCover(entry);
    expect(cover?.mediaType).toBe("image/jpeg");
    expect(cover?.bytes.byteLength).toBeGreaterThan(1000);
    expect(file.bytes).toEqual(coverBook);
    expect(file.writeSizes).toEqual([]);
    expect(documents.removed).toEqual([]);
    expect([...documents.children.keys()]).toEqual([file.name]);
    await expect(device.readCover({ ...entry })).resolves.toBeUndefined();
    await device.scan();
    await expect(device.readCover(entry)).resolves.toBeUndefined();
  });

  it("does not read replaced, changed, revoked, unsupported, or disconnected cover candidates", async () => {
    const { documents, connect } = fixture();
    const file = new MemoryFile("Existing.azw3");
    file.bytes = coverBook.slice();
    documents.children.set(file.name, file);
    const device = await connect();
    const entry = (await device.scan()).entries[0]!;
    documents.children.set(file.name, new MemoryFile(file.name));
    await expect(device.readCover(entry)).resolves.toBeUndefined();
    documents.children.set(file.name, file);
    documents.permission = "denied";
    await expect(device.readCover(entry)).resolves.toBeUndefined();
    documents.permission = "granted";
    file.bytes = new Uint8Array(16);
    await expect(device.readCover(entry)).resolves.toBeUndefined();
    file.bytes = coverBook.slice();
    const kfx = new MemoryFile("Store.kfx");
    kfx.bytes = coverBook.slice();
    documents.children.set(kfx.name, kfx);
    const unsupported = (await device.scan()).entries.find(item => item.name === kfx.name)!;
    const read = vi.spyOn(kfx, "getFile");
    await expect(device.readCover(unsupported)).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    const fresh = (await device.scan()).entries[0]!;
    device.disconnect();
    await expect(device.readCover(fresh)).resolves.toBeUndefined();
  });

  it("requires existing Kindle markers without creating directories", async () => {
    const { root, connect } = fixture();
    root.children.delete("system");
    await expect(connect()).rejects.toThrow(/main Kindle drive/);
    expect([...root.children.keys()]).toEqual(["documents"]);
  });

  it("scans documents only and skips Kindle sidecars", async () => {
    const { root, documents, system, connect } = fixture();
    documents.children.set("Book.azw3", new MemoryFile("Book.azw3"));
    documents.children.set("Store.kfx", new MemoryFile("Store.kfx"));
    const sidecar = new MemoryDirectory("Book.sdr");
    sidecar.failAccess = true;
    documents.children.set(sidecar.name, sidecar);
    root.children.set("outside.azw3", new MemoryFile("outside.azw3"));
    const device = await connect();
    system.failAccess = true;
    expect((await device.scan()).entries.map(entry => entry.relativePath)).toEqual(["documents/Book.azw3", "documents/Store.kfx"]);
  });

  it("writes and verifies AZW3 only in documents/ShelfSend with isolated identity and recovery", async () => {
    const { documents, storage, connect, artifact } = fixture();
    storage.setItem(KOBO_RECOVERY_STORAGE_KEY, "unrelated Kobo recovery");
    const device = await connect();
    await expect(device.send(epub(), identity)).rejects.toThrow(/AZW3/);
    expect(documents.children.has("ShelfSend")).toBe(false);
    const result = await device.send(artifact, identity);
    expect(result.relativePath).toMatch(/^documents\/ShelfSend\/.*\.azw3$/);
    expect((await device.find(identity)).status).toBe("present");
    expect((await device.send(artifact, identity)).alreadyPresent).toBe(true);
    expect(storage.getItem(KINDLE_DRIVE_RECOVERY_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(KOBO_RECOVERY_STORAGE_KEY)).toBe("unrelated Kobo recovery");
    const folder = documents.children.get("ShelfSend") as MemoryDirectory;
    (folder.children.get(result.filename) as MemoryFile).bytes[10] = 1;
    expect((await device.find(identity)).status).toBe("unknown");
  });

  it("refuses a replaced documents directory and revoked permission", async () => {
    const { root, documents, connect, artifact } = fixture();
    const device = await connect();
    documents.permission = "denied";
    await expect(device.send(artifact, identity)).rejects.toThrow(/permission/);
    documents.permission = "granted";
    root.children.set("documents", new MemoryDirectory("documents"));
    await expect(device.send(artifact, identity)).rejects.toThrow(/folder changed/);
    expect(documents.children.size).toBe(0);
  });

  it("retains Kindle recovery after unplug without changing unrelated files", async () => {
    const { root, documents, storage, connect, artifact } = fixture();
    const device = await connect();
    const folder = await documents.getDirectoryHandle("ShelfSend", { create: true }) as MemoryDirectory;
    folder.onCreateFile = file => { file.onWrite = () => { root.failAccess = true; }; };
    await expect(device.send(artifact, identity)).rejects.toThrow(/inspect/);
    expect(storage.getItem(KINDLE_DRIVE_RECOVERY_STORAGE_KEY)).not.toBeNull();
    expect(storage.getItem(KOBO_RECOVERY_STORAGE_KEY)).toBeNull();
    expect(folder.removed).toEqual([]);
  });
});

describe("Kobo mounted-drive transport", () => {
  let root: MemoryDirectory;
  let storage: MemoryStorage;
  beforeEach(() => {
    root = new MemoryDirectory("KOBOeReader");
    root.children.set(".kobo", new MemoryDirectory(".kobo"));
    storage = new MemoryStorage();
  });
  async function connect(): Promise<KoboDevice> {
    return KoboDevice.connect({ picker: async (options) => {
      expect(options.mode).toBe("readwrite");
      return root;
    }, storage, locks: null });
  }

  it("requires a Kobo root without creating marker directories", async () => {
    root.children.clear();
    await expect(connect()).rejects.toThrow(/Kobo.*folder|folder.*Kobo/i);
    expect(root.children.size).toBe(0);
  });

  it("honors cancelled picker and revoked permission", async () => {
    await expect(KoboDevice.connect({ picker: async () => { throw new DOMException("Cancelled", "AbortError"); }, storage }))
      .rejects.toMatchObject({ name: "AbortError" });
    const device = await connect();
    root.permission = "denied";
    await expect(device.send(epub(), identity)).rejects.toThrow(/permission|reconnect/i);
    expect(root.children.has("ShelfSend")).toBe(false);
  });

  it("writes only a new EPUB in ShelfSend, streams bounded chunks, and verifies after close", async () => {
    const existing = new MemoryFile("untouched.epub");
    existing.bytes = new Uint8Array([1, 2, 3]);
    root.children.set(existing.name, existing);
    const device = await connect();
    const progress: number[] = [];
    const result = await device.send(epub(2 * 1024 * 1024 + 1), identity, { onProgress: (value) => progress.push(value) });
    const folder = root.children.get("ShelfSend") as MemoryDirectory;
    const file = folder.children.get(result.filename) as MemoryFile;
    expect(file.closeCount).toBe(1);
    expect(file.writeSizes).toEqual([1024 * 1024, 1024 * 1024, 1]);
    expect(result.relativePath).toBe(`ShelfSend/${result.filename}`);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.bytes).toBe(2 * 1024 * 1024 + 1);
    expect(progress.at(-1)).toBe(100);
    expect(existing.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(root.removed).toEqual([]);
    expect(storage.getItem(KOBO_RECOVERY_STORAGE_KEY)).toBeNull();
    expect((await device.find(identity)).status).toBe("present");
  });

  it("reuses an exact freshly verified copy and keeps profile/presentation identities separate", async () => {
    const device = await connect();
    const first = await device.send(epub(), identity);
    const second = await device.send(epub(), identity);
    expect(second.filename).toBe(first.filename);
    expect(second.alreadyPresent).toBe(true);
    expect((await device.find({ ...identity, profileId: "other" })).status).toBe("absent");
    expect((await device.find({ ...identity, presentationVersion: "c".repeat(64) })).status).toBe("absent");
    const folder = root.children.get("ShelfSend") as MemoryDirectory;
    expect(folder.children.size).toBe(1);
  });

  it("never trusts a managed filename after bytes change", async () => {
    const device = await connect();
    const result = await device.send(epub(), identity);
    const folder = root.children.get("ShelfSend") as MemoryDirectory;
    const file = folder.children.get(result.filename) as MemoryFile;
    file.bytes[10] = 5;
    expect((await device.find(identity)).status).toBe("unknown");
    await expect(device.send(epub(), identity)).rejects.toThrow(/check|inspect|changed/i);
    expect(folder.children.size).toBe(1);
    expect(folder.removed).toEqual([]);
  });

  it("aborts and removes only the exact newly-created file", async () => {
    const device = await connect();
    const folder = await root.getDirectoryHandle("ShelfSend", { create: true }) as MemoryDirectory;
    const existing = new MemoryFile("existing.epub");
    folder.children.set(existing.name, existing);
    const abort = new AbortController();
    let created: MemoryFile | undefined;
    folder.onCreateFile = (file) => { created = file; file.onWrite = () => abort.abort(); };
    await expect(device.send(epub(2 * 1024 * 1024), identity, { signal: abort.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(created?.abortCount).toBe(1);
    expect(created?.closeCount).toBe(0);
    expect([...folder.children.keys()]).toEqual(["existing.epub"]);
    expect(folder.removed).toEqual([created?.name]);
    expect(storage.getItem(KOBO_RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it("does not delete a replacement handle during cancellation cleanup", async () => {
    const device = await connect();
    const folder = await root.getDirectoryHandle("ShelfSend", { create: true }) as MemoryDirectory;
    const abort = new AbortController();
    folder.onCreateFile = (file) => { file.onWrite = () => {
      folder.children.set(file.name, new MemoryFile(file.name));
      abort.abort();
    }; };
    await expect(device.send(epub(), identity, { signal: abort.signal })).rejects.toThrow(/inspect|check/i);
    expect(folder.removed).toEqual([]);
    expect(device.recoveryRecords).toHaveLength(1);
  });

  it("keeps a durable recovery warning after unplug and never deletes stale filenames on reconnect", async () => {
    const device = await connect();
    const folder = await root.getDirectoryHandle("ShelfSend", { create: true }) as MemoryDirectory;
    folder.onCreateFile = (file) => { file.onWrite = () => { root.failAccess = true; }; };
    await expect(device.send(epub(), identity)).rejects.toThrow(/inspect|check/i);
    expect(storage.getItem(KOBO_RECOVERY_STORAGE_KEY)).not.toBeNull();
    root.failAccess = false;
    device.disconnect();
    const reconnected = await connect();
    await expect(reconnected.send(epub(), identity)).rejects.toThrow(/inspect|check/i);
    expect(folder.removed).toEqual([]);
    reconnected.acknowledgeRecovery();
    expect(reconnected.recoveryRecords).toHaveLength(0);
  });

  it("fails verification and cleans up an exact corrupted write, never reporting 100%", async () => {
    const device = await connect();
    const folder = await root.getDirectoryHandle("ShelfSend", { create: true }) as MemoryDirectory;
    folder.onCreateFile = (file) => { file.onClose = () => { file.bytes[10] = 9; }; };
    const progress: number[] = [];
    await expect(device.send(epub(), identity, { onProgress: (value) => progress.push(value) })).rejects.toThrow(/verif|match/i);
    expect(progress).not.toContain(100);
    expect(folder.children.size).toBe(0);
  });

  it("rejects unsupported bytes and oversize files before any write", async () => {
    const device = await connect();
    await expect(device.send(new Blob(["not an epub"]), identity)).rejects.toThrow(/EPUB/i);
    const tooLarge = { size: KOBO_MAX_FILE_BYTES + 1 } as Blob;
    await expect(device.send(tooLarge, identity)).rejects.toThrow(/200|size|large/i);
    expect(root.children.has("ShelfSend")).toBe(false);
  });

  it("reads only visible book folders and bounds traversal", async () => {
    const hidden = root.children.get(".kobo") as MemoryDirectory;
    hidden.failAccess = true;
    const books = new MemoryDirectory("Books");
    books.children.set("book.epub", new MemoryFile("book.epub"));
    root.children.set("Books", books);
    const device = await connect();
    expect((await device.scan()).entries.map((entry) => entry.relativePath)).toEqual(["Books/book.epub"]);
    let directory = books;
    for (let i = 0; i < 9; i++) {
      const next = new MemoryDirectory(`deep-${i}`);
      directory.children.set(next.name, next);
      directory = next;
    }
    await expect(device.scan()).rejects.toThrow(/many|deep|limit/i);
  });

  it("requires durable recovery storage before writes", async () => {
    const broken = { getItem: () => null, setItem: () => { throw new Error("storage denied"); }, removeItem: () => {} };
    const device = await KoboDevice.connect({ picker: async () => root, storage: broken, locks: null });
    await expect(device.send(epub(), identity)).rejects.toThrow(/recovery|storage/i);
    const folder = root.children.get("ShelfSend") as MemoryDirectory | undefined;
    expect(folder?.children.size ?? 0).toBe(0);
  });

  it("rejects simultaneous sends and a closed session", async () => {
    const device = await connect();
    const first = device.send(epub(), identity);
    await expect(device.send(epub(), identity)).rejects.toThrow(/already|progress|busy/i);
    await first;
    device.disconnect();
    await expect(device.scan()).rejects.toThrow(/connect/i);
  });

  it("never overwrites or deletes a nonempty file appearing during filename reservation", async () => {
    const device = await connect();
    const folder = await root.getDirectoryHandle("ShelfSend", { create: true }) as MemoryDirectory;
    folder.onCreateFile = (file) => { file.bytes = new Uint8Array([9, 8, 7]); };
    await expect(device.send(epub(), identity)).rejects.toThrow(/inspect|check/i);
    const file = [...folder.children.values()][0] as MemoryFile;
    expect(file.bytes).toEqual(new Uint8Array([9, 8, 7]));
    expect(file.writeSizes).toEqual([]);
    expect(folder.removed).toEqual([]);
    expect(device.recoveryRecords).toHaveLength(1);
  });

  it("retains recovery and refuses cleanup when native abort cannot settle", async () => {
    const device = await connect();
    const folder = await root.getDirectoryHandle("ShelfSend", { create: true }) as MemoryDirectory;
    const abort = new AbortController();
    folder.onCreateFile = (file) => {
      file.onWrite = () => abort.abort();
      const original = file.createWritable.bind(file);
      file.createWritable = async (options) => ({ ...await original(options), abort: async () => { throw new Error("pending writer"); } });
    };
    await expect(device.send(epub(), identity, { signal: abort.signal })).rejects.toThrow(/inspect|check/i);
    expect(folder.removed).toEqual([]);
    expect(device.recoveryRecords).toHaveLength(1);
  });

  it("blocks writes after a partially successful recovery storage operation", async () => {
    let calls = 0;
    const unreliable = {
      getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage),
      setItem: (key: string, value: string) => { storage.setItem(key, value); calls++; throw new Error("failed after write"); },
    };
    const device = await KoboDevice.connect({ picker: async () => root, storage: unreliable, locks: null });
    await expect(device.send(epub(), identity)).rejects.toThrow(/storage/i);
    await expect(device.send(epub(), identity)).rejects.toThrow(/inspect|check/i);
    expect(calls).toBe(1);
    expect(device.recoveryRecords).toHaveLength(1);
  });

  it("treats malformed persisted recovery as an inspection gate, never as an empty journal", async () => {
    storage.setItem(KOBO_RECOVERY_STORAGE_KEY, "not JSON");
    const device = await connect();
    expect(device.recoveryRecords).toHaveLength(1);
    await expect(device.send(epub(), identity)).rejects.toThrow(/inspect|check/i);
    expect(root.children.has("ShelfSend")).toBe(false);
    device.acknowledgeRecovery();
    expect(device.recoveryRecords).toHaveLength(0);
  });

  it("cancels an in-flight transfer on disconnect and holds the Web Lock until cleanup", async () => {
    let releaseFinished = false;
    let callbackRunning = false;
    const request = vi.fn(async (_name: string, options: unknown, callback: (lock: Lock) => Promise<unknown>) => {
      expect(options).toEqual({ mode: "exclusive", ifAvailable: true });
      callbackRunning = true;
      await callback({ name: "shelfsend-kobo-mounted-drive", mode: "exclusive" } as Lock);
      releaseFinished = true;
    });
    const device = await KoboDevice.connect({ picker: async () => root, storage, locks: { request } as unknown as LockManager });
    expect(callbackRunning).toBe(true);
    expect(releaseFinished).toBe(false);
    const folder = await root.getDirectoryHandle("ShelfSend", { create: true }) as MemoryDirectory;
    folder.onCreateFile = (file) => { file.onWrite = () => {
      device.disconnect();
      expect(releaseFinished).toBe(false);
    }; };
    await expect(device.send(epub(), identity)).rejects.toThrow(/reconnect/i);
    await Promise.resolve();
    expect(releaseFinished).toBe(true);
    expect(folder.children.size).toBe(0);
    expect(storage.getItem(KOBO_RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it("refuses a second tab when the cross-tab exclusive lock is unavailable", async () => {
    const request = async (_name: string, _options: unknown, callback: (lock: null) => unknown) => callback(null);
    await expect(KoboDevice.connect({ picker: async () => root, storage, locks: { request } as unknown as LockManager }))
      .rejects.toThrow(/another.*tab/i);
    expect(root.children.has("ShelfSend")).toBe(false);
  });

  it("bounds enumeration even when most files are not EPUBs", async () => {
    for (let i = 0; i < 10_001; i++) root.children.set(`f-${i}.txt`, new MemoryFile(`f-${i}.txt`));
    const device = await connect();
    await expect(device.scan()).rejects.toThrow(/10,000/);
    expect(root.children.has("ShelfSend")).toBe(false);
  });

  it("does not treat an incomplete inventory as proof a book is absent", async () => {
    const device = await connect();
    vi.spyOn(device, "scan").mockResolvedValue({ entries: [], complete: false, scannedAt: new Date().toISOString() });
    expect((await device.find(identity)).status).toBe("unknown");
    await expect(device.send(epub(), identity)).rejects.toThrow(/inspect|check/i);
    expect(root.children.has("ShelfSend")).toBe(false);
  });

  it("reloads recovery only after a delayed cross-tab lock is acquired", async () => {
    let grant!: () => void;
    const request = async (_name: string, _options: unknown, callback: (lock: Lock) => Promise<unknown>) => {
      await new Promise<void>((resolve) => { grant = resolve; });
      return callback({ name: "shelfsend-kobo-mounted-drive", mode: "exclusive" } as Lock);
    };
    const connecting = KoboDevice.connect({ picker: async () => root, storage, locks: { request } as unknown as LockManager });
    await vi.waitFor(() => expect(grant).toBeTypeOf("function"));
    // A previous owner can leave a recovery record before releasing its lock.
    const record = { filename: `book-ss-v1-${"a".repeat(64)}-${"b".repeat(64)}-12345678-1234-1234-1234-123456789012.epub`, bytes: 64, sha256: "b".repeat(64) };
    storage.setItem(KOBO_RECOVERY_STORAGE_KEY, JSON.stringify([record]));
    grant();
    const device = await connecting;
    expect(device.recoveryRecords).toEqual([record]);
    await expect(device.send(epub(), identity)).rejects.toThrow(/inspect|check/i);
    expect(root.children.has("ShelfSend")).toBe(false);
    expect(JSON.parse(storage.getItem(KOBO_RECOVERY_STORAGE_KEY)!)).toEqual([record]);
    device.disconnect();
  });
});
