import { describe, expect, it, vi } from "vitest";
import {
  createKindleCoverCache, MAX_CACHED_KINDLE_COVER_BYTES,
  type KindleCoverCacheEvidence, type KindleCoverCacheRecord,
} from "../../client/src/kindle/cover-cache";
import { coverPng } from "./cover-fixtures";

const evidence: KindleCoverCacheEvidence = {
  identity: { key: "a".repeat(64), stability: "installation" }, storageId: 1,
  relativePath: "Folder/Book.azw3", metadataAdjusted: false, objectFormat: 0x3000,
  size: 317, modificationDate: "20260914T120000.",
};
const cover = { bytes: coverPng(), mediaType: "image/png" as const };

function persistence() {
  const records = new Map<string, KindleCoverCacheRecord>();
  return {
    records,
    read: vi.fn(async (key: string): Promise<unknown> => records.get(key)),
    put: vi.fn(async (record: KindleCoverCacheRecord) => { records.set(record.cacheKey, record); }),
  };
}

describe("browser-only Kindle device cover cache", () => {
  it("keys each exact device/storage/path/format/size/raw timestamp independently", async () => {
    const cache = createKindleCoverCache({ persistence: null });
    await cache.remember(evidence, cover);
    expect(await cache.lookup(evidence)).toEqual({ cover });
    const changes: Array<Partial<KindleCoverCacheEvidence>> = [
      { identity: { key: "b".repeat(64), stability: "installation" } }, { storageId: 2 },
      { relativePath: "Folder/book.azw3" }, { objectFormat: 0x3004 }, { size: 318 },
      { modificationDate: "20260914T120001." }, { modificationDate: "20260914T120000" },
      { metadataAdjusted: true as false }, { modificationDate: "" }, { relativePath: "../Book.azw3" },
    ];
    for (const change of changes) expect(await cache.lookup({ ...evidence, ...change })).toBeUndefined();
  });

  it("persists only a digest and extracted image and reuses them after a reconnect", async () => {
    const backend = persistence();
    const first = createKindleCoverCache({ persistence: backend });
    await first.remember(evidence, cover);
    const record = [...backend.records.values()][0]!;
    expect(record.cacheKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.keys(record).sort()).toEqual(["cacheKey", "cover", "lastUsedAt", "version"]);
    expect(JSON.stringify(record)).not.toContain(evidence.relativePath);
    expect(JSON.stringify(record)).not.toContain(evidence.identity.key);
    expect(backend.put).toHaveBeenCalledWith(expect.anything(), {
      maxEntries: 256, maxBytes: 32 * 1024 * 1024, expireBefore: expect.any(Number),
    });
    const second = createKindleCoverCache({ persistence: backend });
    const hit = await second.lookup(evidence);
    expect(hit).toEqual({ cover });
    hit!.cover!.bytes[0] = 0;
    expect(await second.lookup(evidence)).toEqual({ cover });
  });

  it("never persists a session-only identity and remembers safe absence independently", async () => {
    const backend = persistence();
    const cache = createKindleCoverCache({ persistence: backend });
    const session = { ...evidence, identity: { ...evidence.identity, stability: "session" as const } };
    await cache.remember(session, undefined);
    expect(await cache.lookup(session)).toEqual({});
    expect(backend.read).not.toHaveBeenCalled();
    expect(backend.put).not.toHaveBeenCalled();
  });

  it("bounds retained entries and image bytes and expires old results", async () => {
    let now = 100;
    const cache = createKindleCoverCache({ persistence: null, maxEntries: 2, maxBytes: 66, now: () => now });
    await cache.remember(evidence, cover);
    const second = { ...evidence, size: 400 };
    await cache.remember(second, cover);
    await cache.lookup(evidence);
    await cache.remember({ ...evidence, size: 500 }, cover);
    expect(await cache.lookup(second)).toBeUndefined();
    expect(await cache.lookup(evidence)).toEqual({ cover });
    now += 181 * 24 * 60 * 60 * 1000;
    expect(await cache.lookup(evidence)).toBeUndefined();
    const bounded = createKindleCoverCache({ persistence: null, maxBytes: 40 });
    await bounded.remember(evidence, { ...cover, bytes: coverPng(41) });
    expect(await bounded.lookup(evidence)).toBeUndefined();
    await bounded.remember(evidence, { ...cover, bytes: coverPng(MAX_CACHED_KINDLE_COVER_BYTES + 1) });
    expect(await bounded.lookup(evidence)).toBeUndefined();
  });

  it("rejects corrupt, expired, wrong-key, MIME-mismatched, and oversized stored data", async () => {
    const backend = persistence();
    await createKindleCoverCache({ persistence: backend, now: () => 1000 }).remember(evidence, cover);
    const record = [...backend.records.values()][0]!;
    const corrupt = [
      { ...record, version: 2 }, { ...record, cacheKey: "f".repeat(64) }, { ...record, lastUsedAt: -1 },
      { ...record, lastUsedAt: 9e15 }, { ...record, cover: { ...cover, mediaType: "image/jpeg" } },
      { ...record, cover: { ...cover, bytes: new TextEncoder().encode("<svg width='600' height='800'/>") } },
      { ...record, cover: { ...cover, bytes: coverPng(MAX_CACHED_KINDLE_COVER_BYTES + 1) } },
    ];
    for (const value of corrupt) {
      backend.read.mockResolvedValue(value);
      expect(await createKindleCoverCache({ persistence: backend, now: () => 1000 }).lookup(evidence)).toBeUndefined();
    }
    backend.read.mockResolvedValue({ ...record, cover: { ...cover, bytes: coverPng(100) } });
    expect(await createKindleCoverCache({ persistence: backend, maxBytes: 50, now: () => 1000 }).lookup(evidence)).toBeUndefined();
  });

  it("falls back to memory on persistence failure and ignores late read results", async () => {
    const backend = persistence();
    backend.put.mockRejectedValue(new Error("quota exceeded"));
    const cache = createKindleCoverCache({ persistence: backend });
    await cache.remember(evidence, cover);
    expect(await cache.lookup(evidence)).toEqual({ cover });
    expect(backend.put).toHaveBeenCalledTimes(1);

    let resolve!: (value: unknown) => void;
    backend.read.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const timed = createKindleCoverCache({ persistence: backend, operationTimeoutMs: 5 });
    expect(await timed.lookup(evidence)).toBeUndefined();
    resolve({ version: 1, cacheKey: "a".repeat(64), lastUsedAt: Date.now(), cover });
    expect(await timed.lookup(evidence)).toBeUndefined();
    expect(backend.read).toHaveBeenCalledTimes(1);
    await timed.remember(evidence, cover);
    expect(await timed.lookup(evidence)).toEqual({ cover });
  });
});
