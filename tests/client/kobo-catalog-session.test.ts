// @vitest-environment jsdom

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KoboCatalogSession, type KoboCatalogDevice } from "../../client/src/kobo/catalog-session";
import { koboIdentityHash } from "../../client/src/kobo/device";
import type { CatalogApi, CatalogBook, CatalogBookMetadataState, CatalogBookSource, CatalogMatchIndex } from "../../client/src/catalog-client";
import type { KoboIdentity, KoboInventory, KoboInventoryEntry, KoboRecoveryRecord, KoboSendOptions, KoboTransferResult } from "../../client/src/kobo/types";

let source: Blob;
let sourceHash: string;
beforeAll(async () => {
  const bytes = await readFile("tests/fixtures/epictetus.epub");
  source = new Blob([Uint8Array.from(bytes)], { type: "application/epub+zip" });
  sourceHash = createHash("sha256").update(bytes).digest("hex");
});

function book(patch: Partial<CatalogBook> = {}): CatalogBook {
  return { id: "book-1", profileId: "profile-a", rootId: "root-a", sourceFilename: "book.epub", title: "Original title",
    authors: ["Original Author"], authorSort: "Author, Original", identifiers: [], subjects: [], format: "EPUB", size: source.size,
    contentHash: sourceHash, presentationVersion: sourceHash, addedAt: "2026-01-01", updatedAt: "2026-01-01", metadataComplete: true,
    available: true, metadataRevision: 0, ...patch };
}

function index(books: CatalogBook[]): CatalogMatchIndex {
  return { profileId: books[0]?.profileId ?? "profile-a", generatedAt: "2026-01-01", entries: books.map((value) => ({
    bookId: value.id, sourceFilename: value.sourceFilename, sourceFormat: value.format, sourceSize: value.size,
    contentHash: value.contentHash!, presentationVersion: value.presentationVersion, identifiers: value.identifiers,
    title: value.title, authors: value.authors, deliveries: [],
  })) };
}

function metadata(value: CatalogBook): CatalogBookMetadataState {
  return { book: value, revision: value.metadataRevision!, basedOnContentHash: value.contentHash!, sourceChanged: false,
    sourceCoverUrl: null, coverOverride: null, overrides: { title: "Reviewed title", series: "Reviewed series", seriesIndex: 2.5 },
    sourceMetadata: { title: value.title, authors: [...value.authors], authorSort: value.authorSort, language: null, publisher: null,
      publishedAt: null, series: null, seriesIndex: null, description: null, subjects: [], identifiers: [] } };
}

function identity(value: CatalogBook): KoboIdentity {
  return { profileId: value.profileId, bookId: value.id, contentHash: value.contentHash!, presentationVersion: value.presentationVersion!, title: value.title };
}

async function managed(value: CatalogBook, patch: Partial<KoboInventoryEntry> = {}): Promise<KoboInventoryEntry> {
  return { name: `managed-${value.id}.epub`, relativePath: `ShelfSend/managed-${value.id}.epub`, size: value.size, lastModified: 1,
    managed: { identityHash: await koboIdentityHash(identity(value)), artifactHash: sourceHash }, ...patch };
}

class Device implements KoboCatalogDevice {
  closed = false;
  recoveryRecords: readonly KoboRecoveryRecord[] = [];
  inventory: KoboInventory = { entries: [], complete: true, scannedAt: "2026-01-01" };
  scan = vi.fn(async (_signal?: AbortSignal) => this.inventory);
  verifyEntry = vi.fn(async (_entry: KoboInventoryEntry, _signal?: AbortSignal) => true);
  send = vi.fn(async (blob: Blob, _identity: KoboIdentity, options?: KoboSendOptions): Promise<KoboTransferResult> => {
    options?.onProgress?.(50);
    options?.onProgress?.(95);
    return { filename: "sent.epub", relativePath: "ShelfSend/sent.epub", bytes: blob.size, sha256: sourceHash, alreadyPresent: false };
  });
  acknowledgeRecovery = vi.fn(() => { this.recoveryRecords = []; });
  disconnect = vi.fn(() => { this.closed = true; });
}

function setup(value = book()) {
  const device = new Device();
  const api = {
    getMatchIndex: vi.fn(async (_profile: string, _signal?: AbortSignal) => index([value])),
    getBook: vi.fn(async (_profile: string, _id: string, _signal?: AbortSignal) => value),
    getBookSource: vi.fn(async (_profile: string, _id: string, _signal?: AbortSignal): Promise<CatalogBookSource> => ({
      blob: source, contentLength: source.size, etag: `"sha256-${sourceHash}"`, presentationVersion: value.presentationVersion,
    })),
    getBookMetadata: vi.fn(async (_profile: string, _id: string, _signal?: AbortSignal) => metadata(value)),
    getBookCover: vi.fn(async (_profile: string, _id: string, _signal?: AbortSignal) => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: "image/jpeg" })),
    createDelivery: vi.fn(),
  };
  const hooks = { state: vi.fn(), progress: vi.fn() };
  const session = new KoboCatalogSession(api as unknown as CatalogApi, device, hooks);
  const request = { profileId: value.profileId, book: value };
  return { value, api, device, hooks, session, request };
}

describe("Kobo catalog session", () => {
  it("remains connected and idle when no library has been created or selected", async () => {
    const s = setup();
    await s.session.refresh(undefined);
    expect(s.session.snapshot).toMatchObject({ status: "ready", message: expect.stringContaining("Choose or create a library") });
    expect(s.session.snapshot.countsByProfile.size).toBe(0);
    expect(s.session.busy).toBe(false);
    expect(s.api.getMatchIndex).not.toHaveBeenCalled();
    expect(s.device.scan).not.toHaveBeenCalled();
    await expect(s.session.send(s.request)).rejects.toThrow();
    s.session.disconnect();
    expect(s.device.disconnect).toHaveBeenCalledOnce();
  });

  it("confirms only a current byte-verified managed identity and leaves failed hashes unknown", async () => {
    const s = setup();
    s.device.inventory = { ...s.device.inventory, entries: [await managed(s.value)] };
    await s.session.refresh(s.value.profileId);
    expect(s.session.snapshot.statuses.get(s.value.id)).toBe("confirmed");
    expect(s.device.verifyEntry).toHaveBeenCalledOnce();
    s.device.verifyEntry.mockResolvedValue(false);
    await s.session.refresh(s.value.profileId);
    expect(s.session.snapshot.statuses.get(s.value.id)).toBe("unknown");
  });

  it("keeps multiple managed copies uncertain instead of confirming the first one", async () => {
    const s = setup();
    const entry = await managed(s.value);
    s.device.inventory = { ...s.device.inventory, entries: [entry, { ...entry, name: "duplicate.epub", relativePath: "ShelfSend/duplicate.epub" }] };
    await s.session.refresh(s.value.profileId);
    expect(s.session.snapshot.statuses.get(s.value.id)).toBe("unknown");
    expect(s.device.verifyEntry).not.toHaveBeenCalled();
  });

  it("distinguishes unmanaged filename hints from confirmed presence and incomplete scans", async () => {
    const s = setup();
    s.device.inventory = { ...s.device.inventory, entries: [{ name: "Original title.kepub.epub", relativePath: "Original title.kepub.epub", size: 32, lastModified: 1 }] };
    await s.session.refresh(s.value.profileId);
    expect(s.session.snapshot.statuses.get(s.value.id)).toBe("possible");
    await expect(s.session.send(s.request)).rejects.toMatchObject({ code: "INVALID_STATE" });
    s.device.inventory = { ...s.device.inventory, entries: [], complete: false };
    await s.session.refresh(s.value.profileId);
    expect(s.session.snapshot.statuses.get(s.value.id)).toBe("unknown");
    expect(s.device.send).not.toHaveBeenCalled();
  });

  it("does not reuse another profile's managed presence", async () => {
    const s = setup();
    s.device.inventory = { ...s.device.inventory, entries: [await managed({ ...s.value, profileId: "other-profile" })] };
    await s.session.refresh(s.value.profileId);
    expect(s.session.snapshot.statuses.get(s.value.id)).toBe("not-on-kindle");
    expect(s.device.verifyEntry).not.toHaveBeenCalled();
    expect([...s.session.snapshot.countsByProfile.keys()]).toEqual([s.value.profileId]);
  });

  it("rejects a mismatched API profile or index larger than its request budget", async () => {
    const s = setup();
    s.api.getMatchIndex.mockResolvedValue({ ...index([s.value]), profileId: "other-profile" });
    await s.session.refresh(s.value.profileId);
    expect(s.session.snapshot.status).toBe("error");
    s.api.getMatchIndex.mockResolvedValue({ ...index([s.value]), entries: Array(20_001).fill(index([s.value]).entries[0]) });
    await s.session.refresh(s.value.profileId);
    expect(s.session.snapshot.status).toBe("error");
    expect(s.device.scan).not.toHaveBeenCalled();
  });

  it("stops hashing managed files once the one-GiB comparison budget is reached", async () => {
    const s = setup();
    const books = Array.from({ length: 6 }, (_, position) => book({ id: `book-${position}` }));
    s.api.getMatchIndex.mockResolvedValue(index(books));
    s.device.inventory = { ...s.device.inventory, entries: await Promise.all(books.map((value) => managed(value, { size: 200 * 1024 * 1024 }))) };
    await s.session.refresh(s.value.profileId);
    expect(s.device.verifyEntry).toHaveBeenCalledTimes(5);
    expect(s.session.snapshot.statuses.get("book-5")).toBe("unknown");
  });

  it("stops at 2,000 verified files even for very small managed entries", async () => {
    const s = setup();
    const books = Array.from({ length: 2_001 }, (_, position) => book({ id: `book-${position}` }));
    s.api.getMatchIndex.mockResolvedValue(index(books));
    s.device.inventory = { ...s.device.inventory, entries: await Promise.all(books.map((value) => managed(value, { size: 4 }))) };
    await s.session.refresh(s.value.profileId);
    expect(s.device.verifyEntry).toHaveBeenCalledTimes(2_000);
    expect(s.session.snapshot.statuses.get("book-2000")).toBe("unknown");
  });

  it("sends verified EPUB bytes and a profile-scoped identity, with no Kindle delivery or inventory upload", async () => {
    const s = setup();
    await s.session.refresh(s.value.profileId);
    await s.session.send(s.request);
    expect(s.device.send).toHaveBeenCalledOnce();
    const [artifact, sentIdentity] = s.device.send.mock.calls[0]!;
    expect(createHash("sha256").update(new Uint8Array(await artifact.arrayBuffer())).digest("hex")).toBe(sourceHash);
    expect(sentIdentity).toEqual(identity(s.value));
    expect(s.api.getBook).toHaveBeenCalledTimes(2);
    expect(s.api.getBookSource).toHaveBeenCalledWith(s.value.profileId, s.value.id, expect.any(AbortSignal));
    expect(s.api.createDelivery).not.toHaveBeenCalled();
    expect(s.hooks.progress.mock.calls.map(([update]) => update.phase)).toEqual(["preparing", "sending", "verifying", "complete"]);
    expect(s.session.snapshot.statuses.get(s.value.id)).toBe("confirmed");
  });

  it("preserves reviewed metadata and covers in the sent EPUB only", async () => {
    const s = setup(book({ metadataEdited: true, coverEdited: true, metadataRevision: 3, presentationVersion: "b".repeat(64) }));
    s.api.getBookMetadata.mockResolvedValue({ ...metadata(s.value), coverOverride: {
      assetKey: "cover-key", mediaType: "image/jpeg", byteLength: 4, width: 1, height: 1, sourceKind: "upload", provider: null, providerReference: null, sourceUrl: null,
    } });
    await s.session.refresh(s.value.profileId);
    await s.session.send(s.request);
    const [artifact] = s.device.send.mock.calls[0]!;
    const text = new TextDecoder().decode(await artifact.arrayBuffer());
    expect(text).toContain("Reviewed title");
    expect(text).toContain("Reviewed series");
    expect(text).toContain('property="group-position">2.5');
    expect(s.api.getBookCover).toHaveBeenCalledOnce();
    expect(createHash("sha256").update(new Uint8Array(await source.arrayBuffer())).digest("hex")).toBe(sourceHash);
  });

  it.each([
    ["unavailable source", { available: false }],
    ["changed presentation", { presentationVersion: "c".repeat(64) }],
    ["changed hash", { contentHash: "c".repeat(64) }],
    ["foreign profile", { profileId: "other-profile" }],
    ["wrong local book", { id: "other-book" }],
    ["AZW3 source", { format: "AZW3" }],
  ] satisfies [string, Partial<CatalogBook>][])("rejects %s before downloading or writing", async (_label, patch) => {
    const s = setup();
    await s.session.refresh(s.value.profileId);
    s.api.getBook.mockResolvedValue({ ...s.value, ...patch });
    await expect(s.session.send(s.request)).rejects.toThrow();
    expect(s.api.getBookSource).not.toHaveBeenCalled();
    expect(s.device.send).not.toHaveBeenCalled();
  });

  it("rejects stale UI requests and another profile before any send preflight", async () => {
    const s = setup();
    await s.session.refresh(s.value.profileId);
    await expect(s.session.send({ ...s.request, profileId: "other-profile" })).rejects.toThrow();
    await expect(s.session.send({ ...s.request, book: { ...s.value, presentationVersion: "d".repeat(64) } })).rejects.toThrow();
    expect(s.api.getBook).not.toHaveBeenCalled();
    expect(s.device.send).not.toHaveBeenCalled();
  });

  it.each(["etag", "presentationVersion", "contentLength", "bytes"] as const)("rejects changed source %s before writes", async (field) => {
    const s = setup();
    await s.session.refresh(s.value.profileId);
    const response = await s.api.getBookSource(s.value.profileId, s.value.id);
    s.api.getBookSource.mockResolvedValue({ ...response, ...(field === "etag" ? { etag: '"changed"' }
      : field === "presentationVersion" ? { presentationVersion: "c".repeat(64) }
        : field === "contentLength" ? { contentLength: source.size + 1 } : { blob: new Blob([new Uint8Array(source.size)]) }) });
    await expect(s.session.send(s.request)).rejects.toThrow();
    expect(s.device.send).not.toHaveBeenCalled();
  });

  it("rechecks presentation after preparation to catch a newly created overlay", async () => {
    const s = setup();
    await s.session.refresh(s.value.profileId);
    s.api.getBook.mockResolvedValueOnce(s.value).mockResolvedValueOnce({ ...s.value, presentationVersion: "c".repeat(64), metadataEdited: true });
    await expect(s.session.send(s.request)).rejects.toThrow();
    expect(s.device.send).not.toHaveBeenCalled();
  });

  it.each(["profile", "book", "revision", "sourceChanged"] as const)("rejects metadata with conflicting %s", async (field) => {
    const s = setup(book({ metadataEdited: true, metadataRevision: 3, presentationVersion: "b".repeat(64) }));
    const original = metadata(s.value);
    s.api.getBookMetadata.mockResolvedValue({ ...original, ...(field === "profile" ? { book: { ...s.value, profileId: "other-profile" } }
      : field === "book" ? { book: { ...s.value, id: "other-book" } } : field === "revision" ? { revision: 4 } : { sourceChanged: true }) });
    await s.session.refresh(s.value.profileId);
    await expect(s.session.send(s.request)).rejects.toThrow();
    expect(s.device.send).not.toHaveBeenCalled();
  });

  it.each(["missing", "size", "mediaType"] as const)("rejects an edited cover with %s identity evidence", async (field) => {
    const s = setup(book({ coverEdited: true, metadataRevision: 3, presentationVersion: "b".repeat(64) }));
    s.api.getBookMetadata.mockResolvedValue({ ...metadata(s.value), coverOverride: field === "missing" ? null : {
      assetKey: "cover-key", mediaType: "image/jpeg", byteLength: field === "size" ? 4000 : 4, width: 1, height: 1, sourceKind: "upload", provider: null, providerReference: null, sourceUrl: null,
    } });
    if (field === "mediaType") s.api.getBookCover.mockResolvedValue(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: "image/png" }));
    await s.session.refresh(s.value.profileId);
    await expect(s.session.send(s.request)).rejects.toThrow();
    expect(s.device.send).not.toHaveBeenCalled();
  });

  it("rechecks a newly copied unmanaged file before sending", async () => {
    const s = setup();
    await s.session.refresh(s.value.profileId);
    s.device.inventory = { ...s.device.inventory, entries: [{ name: "book.epub", relativePath: "book.epub", size: 10, lastModified: 1 }] };
    await expect(s.session.send(s.request)).rejects.toThrow();
    expect(s.device.send).not.toHaveBeenCalled();
  });

  it("requires complete fresh inventory before a new write", async () => {
    const s = setup();
    await s.session.refresh(s.value.profileId);
    s.device.inventory = { ...s.device.inventory, complete: false };
    await expect(s.session.send(s.request)).rejects.toThrow();
    expect(s.device.send).not.toHaveBeenCalled();
  });

  it("aborts a stalled catalog read without a write or stale success", async () => {
    const s = setup();
    await s.session.refresh(s.value.profileId);
    s.api.getBook.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = s.session.send({ ...s.request, cancelSignal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ code: "TRANSFER_CANCELLED" });
    controller.abort();
    await assertion;
    expect(s.device.send).not.toHaveBeenCalled();
    expect(s.hooks.progress.mock.calls.at(-1)?.[0]).toMatchObject({ phase: "cancelled" });
    expect(s.session.busy).toBe(false);
  });

  it("holds its busy state until transport cancellation cleanup settles", async () => {
    const s = setup();
    await s.session.refresh(s.value.profileId);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    s.device.send.mockImplementation(async (_blob, _id, options) => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
      options?.signal?.throwIfAborted();
      throw new Error("not cancelled");
    });
    const controller = new AbortController();
    const pending = s.session.send({ ...s.request, cancelSignal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ code: "TRANSFER_CANCELLED" });
    await started;
    controller.abort();
    expect(s.session.busy).toBe(true);
    release();
    await assertion;
    expect(s.session.busy).toBe(false);
  });

  it("reports recovery rather than claiming cancellation removed every file", async () => {
    const s = setup();
    await s.session.refresh(s.value.profileId);
    const controller = new AbortController();
    s.device.send.mockImplementation(async () => {
      s.device.recoveryRecords = [{ filename: "interrupted.epub", bytes: 12, sha256: sourceHash }];
      controller.abort();
      throw new Error("Inspect the interrupted file before sending again.");
    });
    await expect(s.session.send({ ...s.request, cancelSignal: controller.signal })).rejects.toMatchObject({ code: "CATALOG_REQUEST_FAILED" });
    expect(s.session.snapshot.status).toBe("error");
    expect(s.hooks.progress.mock.calls.at(-1)?.[0]).toMatchObject({ phase: "failed", message: expect.stringContaining("Inspect") });
    await expect(s.session.send(s.request)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await s.session.acknowledgeRecovery();
    expect(s.device.acknowledgeRecovery).toHaveBeenCalledOnce();
    expect(s.session.snapshot.status).toBe("ready");
  });

  it("bounds a stalled refresh and reports provider/device errors, not empty-library success", async () => {
    const s = setup();
    s.api.getMatchIndex.mockRejectedValueOnce(new Error("Catalog unavailable"));
    await s.session.refresh(s.value.profileId);
    expect(s.session.snapshot).toMatchObject({ status: "error", message: "Catalog unavailable" });
    s.api.getMatchIndex.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const pending = s.session.refresh(s.value.profileId);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await pending;
      expect(s.session.snapshot).toMatchObject({ status: "error", message: expect.stringContaining("too long") });
    } finally { vi.useRealTimers(); }
  });

  it("disconnects and prevents further reading or writing", async () => {
    const s = setup();
    await s.session.refresh(s.value.profileId);
    s.session.disconnect();
    expect(s.device.disconnect).toHaveBeenCalledOnce();
    const calls = s.device.scan.mock.calls.length;
    await s.session.refresh(s.value.profileId);
    await expect(s.session.send(s.request)).rejects.toThrow();
    expect(s.device.scan).toHaveBeenCalledTimes(calls);
    expect(s.device.send).not.toHaveBeenCalled();
  });
});
