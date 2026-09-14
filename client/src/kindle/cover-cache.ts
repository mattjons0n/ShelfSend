import { inspectKindleCoverImage, type KindleBookCover } from "./book-cover";
import type { PseudonymousKindleIdentity } from "./device-identity";
import { isCacheableKindleModificationDate } from "./modification-date-diagnostics";

const DATABASE_NAME = "kindle-bridge-device-cover-cache";
const STORE_NAME = "covers-v1";
const MAX_ENTRIES = 256;
const MAX_BYTES = 32 * 1024 * 1024;
export const MAX_CACHED_KINDLE_COVER_BYTES = 4 * 1024 * 1024;
const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

export interface KindleCoverCacheEvidence {
  readonly identity: PseudonymousKindleIdentity;
  readonly storageId: number;
  readonly relativePath: string;
  readonly metadataAdjusted: false;
  readonly objectFormat: number;
  readonly size: number;
  readonly modificationDate: string;
}

export interface KindleCoverCacheHit {
  readonly cover?: KindleBookCover;
}

/** Only a digest and optional extracted raster bytes are persisted, never paths or book files. */
export interface KindleCoverCacheRecord {
  readonly version: 1;
  readonly cacheKey: string;
  readonly lastUsedAt: number;
  readonly cover?: KindleBookCover;
}

export interface KindleCoverCachePersistence {
  read(key: string): Promise<unknown>;
  put(record: KindleCoverCacheRecord, limits: {
    readonly maxEntries: number;
    readonly maxBytes: number;
    readonly expireBefore: number;
  }): Promise<void>;
}

export interface KindleCoverCache {
  lookup(evidence: KindleCoverCacheEvidence): Promise<KindleCoverCacheHit | undefined>;
  remember(evidence: KindleCoverCacheEvidence, cover: KindleBookCover | undefined): Promise<void>;
}

export interface KindleCoverCacheOptions {
  readonly persistence?: KindleCoverCachePersistence | null;
  readonly indexedDB?: IDBFactory | null;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly operationTimeoutMs?: number;
  readonly now?: () => number;
}

function validEvidence(value: KindleCoverCacheEvidence): boolean {
  return /^[a-f0-9]{64}$/u.test(value.identity.key)
    && (value.identity.stability === "installation" || value.identity.stability === "session")
    && Number.isInteger(value.storageId) && value.storageId > 0 && value.storageId < 0xffff_ffff
    && Number.isInteger(value.objectFormat) && value.objectFormat >= 0 && value.objectFormat <= 0xffff
    && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= 0xffff_ffff
    && value.metadataAdjusted === false
    && value.relativePath.length > 0 && value.relativePath.length <= 2048
    && !/[\\\p{Cc}]/u.test(value.relativePath)
    && value.relativePath.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
    && isCacheableKindleModificationDate(value.modificationDate);
}

function copyCover(value: unknown): KindleBookCover | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { bytes, mediaType } = value as Partial<KindleBookCover>;
  if (!(bytes instanceof Uint8Array) || bytes.length < 12 || bytes.length > MAX_CACHED_KINDLE_COVER_BYTES) return undefined;
  // Recheck stored raster structure, media type and dimensions before returning
  // data which may have been edited independently of the device extractor.
  return mediaType !== undefined && inspectKindleCoverImage(bytes) === mediaType
    ? { bytes: bytes.slice(), mediaType } : undefined;
}

function validRecord(value: unknown, key: string, now: number): KindleCoverCacheRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<KindleCoverCacheRecord>;
  if (record.version !== 1 || record.cacheKey !== key
      || !Number.isSafeInteger(record.lastUsedAt) || (record.lastUsedAt ?? -1) < 0
      || (record.lastUsedAt ?? 0) > now + 300_000 || now - (record.lastUsedAt ?? 0) > MAX_AGE_MS) return undefined;
  const cover = copyCover(record.cover);
  if (record.cover !== undefined && cover === undefined) return undefined;
  return { version: 1, cacheKey: key, lastUsedAt: now, ...(cover ? { cover } : {}) };
}

class IndexedDbCoverPersistence implements KindleCoverCachePersistence {
  readonly #factory: IDBFactory;
  #databasePromise?: Promise<IDBDatabase>;

  constructor(factory: IDBFactory) { this.#factory = factory; }

  #database(): Promise<IDBDatabase> {
    this.#databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.#factory.open(DATABASE_NAME, 1);
      let abandoned = false;
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE_NAME, { keyPath: "cacheKey" });
        store.createIndex("lastUsedAt", "lastUsedAt");
      };
      request.onblocked = () => { abandoned = true; reject(new Error("Device cover cache is blocked")); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (abandoned) { request.result.close(); return; }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
    return this.#databasePromise;
  }

  async read(key: string): Promise<unknown> {
    const database = await this.#database();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(key);
      transaction.oncomplete = () => resolve(request.result as unknown);
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  }

  async put(record: KindleCoverCacheRecord, limits: {
    readonly maxEntries: number; readonly maxBytes: number; readonly expireBefore: number;
  }): Promise<void> {
    const database = await this.#database();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      store.put(record);
      let retainedEntries = 0;
      let retainedBytes = 0;
      // Newest-first pruning bounds both entries (including negative results)
      // and aggregate image bytes in this same write transaction.
      const request = store.index("lastUsedAt").openCursor(null, "prev");
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const candidate = cursor.value as KindleCoverCacheRecord;
        const size = candidate.cover?.bytes?.byteLength ?? 0;
        if (candidate.lastUsedAt < limits.expireBefore || !Number.isSafeInteger(size)
            || size < 0 || size > MAX_CACHED_KINDLE_COVER_BYTES
            || retainedEntries >= limits.maxEntries || retainedBytes + size > limits.maxBytes) {
          cursor.delete();
        } else {
          retainedEntries += 1;
          retainedBytes += size;
        }
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  }
}

function boundedLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new RangeError("Invalid device cover cache limit");
  return value;
}

/** Browser-only acceleration; each hit still requires current live device evidence. */
export function createKindleCoverCache(options: KindleCoverCacheOptions = {}): KindleCoverCache {
  const maxEntries = boundedLimit(options.maxEntries, MAX_ENTRIES);
  const maxBytes = boundedLimit(options.maxBytes, MAX_BYTES);
  const timeoutMs = boundedLimit(options.operationTimeoutMs, 1000);
  const now = options.now ?? Date.now;
  const memory = new Map<string, KindleCoverCacheRecord>();
  let factory: IDBFactory | undefined;
  try { factory = options.indexedDB === null ? undefined : options.indexedDB ?? globalThis.indexedDB; } catch { /* Private browsing. */ }
  let persistence = options.persistence === null ? undefined
    : options.persistence ?? (factory ? new IndexedDbCoverPersistence(factory) : undefined);

  async function deadline<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Device cover cache timed out")), timeoutMs);
        }),
      ]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  async function keyFor(evidence: KindleCoverCacheEvidence): Promise<string | undefined> {
    if (!validEvidence(evidence) || !globalThis.crypto?.subtle) return undefined;
    try {
      return await deadline(async () => {
        const material = new TextEncoder().encode(JSON.stringify([
          "kindle-bridge-device-cover-v1", evidence.identity.key, evidence.storageId,
          evidence.relativePath, evidence.objectFormat, evidence.size, evidence.modificationDate,
        ]));
        const hash = await globalThis.crypto.subtle.digest("SHA-256", material);
        return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
      });
    } catch { return undefined; }
  }

  function retain(record: KindleCoverCacheRecord): void {
    memory.delete(record.cacheKey);
    memory.set(record.cacheKey, record);
    let bytes = 0;
    for (const value of memory.values()) bytes += value.cover?.bytes.byteLength ?? 0;
    for (const [key, value] of memory) {
      if (memory.size <= maxEntries && bytes <= maxBytes && now() - value.lastUsedAt <= MAX_AGE_MS) break;
      memory.delete(key);
      bytes -= value.cover?.bytes.byteLength ?? 0;
    }
  }

  async function persist(record: KindleCoverCacheRecord, evidence: KindleCoverCacheEvidence): Promise<void> {
    if (!persistence || evidence.identity.stability !== "installation") return;
    const backend = persistence;
    try { await deadline(() => backend.put(record, { maxEntries, maxBytes, expireBefore: now() - MAX_AGE_MS })); }
    catch { persistence = undefined; }
  }

  return {
    async lookup(evidence) {
      const key = await keyFor(evidence);
      if (!key) return undefined;
      let record = validRecord(memory.get(key), key, now());
      if (!record && persistence && evidence.identity.stability === "installation") {
        const backend = persistence;
        try { record = validRecord(await deadline(() => backend.read(key)), key, now()); }
        catch { persistence = undefined; }
      }
      if (!record || (record.cover?.bytes.byteLength ?? 0) > maxBytes) { memory.delete(key); return undefined; }
      retain(record);
      await persist(record, evidence);
      return record.cover ? { cover: copyCover(record.cover)! } : {};
    },
    async remember(evidence, value) {
      const key = await keyFor(evidence);
      const cover = copyCover(value);
      if (!key || (value !== undefined && !cover) || (cover?.bytes.byteLength ?? 0) > maxBytes) return;
      const record: KindleCoverCacheRecord = { version: 1, cacheKey: key, lastUsedAt: now(), ...(cover ? { cover } : {}) };
      retain(record);
      await persist(record, evidence);
    },
  };
}
