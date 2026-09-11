import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogDatabase } from "../../server/catalog-database.js";
import { CatalogHttpServer } from "../../server/http-server.js";
import { CoverProviderClient } from "../../server/cover-providers.js";
import { CoverCache } from "../../server/cover-cache.js";
import { CatalogEventHub } from "../../server/event-hub.js";
import { AllowedRootPolicy } from "../../server/root-policy.js";
import type { HardcoverBookLookup, HardcoverSeriesBook, HardcoverSeriesPage } from "../../shared/hardcover-contracts.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

function providerBook(id: number): HardcoverSeriesBook {
  return { id, title: `Volume ${id}`, authors: ["Author"], identifiers: [],
    url: `https://hardcover.app/books/volume-${id}`, coverUrl: null, releaseYear: 2020,
    position: id === 2 ? 1.5 : id, series: [{ id: 10, name: "The series", position: id }] };
}

async function setup(configured = true, readOnly = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "shelfsend-series-http-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const library = path.join(directory, "library");
  await mkdir(library);
  const original = Buffer.from("immutable source");
  const filename = path.join(library, "source.epub");
  await writeFile(filename, original);
  const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
  cleanup.push(async () => database.close());
  const profile = database.createProfile({ name: "Selected library" });
  const other = database.createProfile({ name: "Other library" });
  const root = database.createRoot(profile.id, { path: library, label: "My books" });
  const otherRoot = database.createRoot(other.id, { path: path.join(directory, "other"), label: "Other books" });
  const add = (id: number, rootId = root.id) => database.upsertCatalogFile({
    rootId, relativePath: `book-${id}.epub`, format: "epub", size: original.length, mtimeMs: 1,
    contentHash: String(id).repeat(64).slice(0, 64), scanToken: "series-discovery-test",
    metadata: { title: `Volume ${id}`, authors: ["Author"], authorSort: null, language: "en",
      publisher: null, publishedAt: null, series: null, seriesIndex: null, subjects: [],
      identifiers: id === 1 ? ["ISBN:9780140328721"] : [], metadataComplete: true,
      coverKey: null, coverMediaType: null },
  }).bookId;
  const bookId = add(1);
  const otherBookId = add(2, otherRoot.id);
  if (configured) database.setCoverProviderCredential("hardcover", "private-server-token", 0, "add-token");
  const events = new CatalogEventHub();
  cleanup.push(async () => events.close());
  const server = new CatalogHttpServer(database, {} as never, await AllowedRootPolicy.create([library]),
    new CoverCache(path.join(directory, "cache")), events,
    { hostname: "127.0.0.1", port: 0, allowedHosts: ["127.0.0.1"], allowedOrigins: [],
      requireOriginForMutations: false, settingsMode: readOnly ? "read-only" : "read-write" });
  const address = await server.listen();
  cleanup.push(() => server.close());
  const prefix = `http://127.0.0.1:${address.port}/api/profiles/${profile.id}`;
  return { database, profile, other, bookId, otherBookId, add, prefix, filename, original };
}

describe("Hardcover book and series discovery HTTP", () => {
  it("looks up current metadata, caches by book version, and rejects books outside this profile", async () => {
    const app = await setup();
    const result: HardcoverBookLookup = { books: [providerBook(1)], matchedBookId: 1 };
    const lookup = vi.spyOn(CoverProviderClient.prototype, "lookupHardcoverBook").mockResolvedValue(result);
    const endpoint = `${app.prefix}/books/${app.bookId}/hardcover`;
    const response = await fetch(endpoint);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(response.headers.get("content-security-policy")).toContain("https://assets.hardcover.app https://production-img.hardcover.app");
    expect(lookup).toHaveBeenCalledWith({ title: "Volume 1", author: "Author", identifier: "9780140328721" }, expect.any(AbortSignal));
    expect((await fetch(endpoint)).status).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect((await fetch(`${endpoint}?token=not-accepted`)).status).toBe(400);
    expect((await fetch(`${app.prefix}/books/${app.otherBookId}/hardcover`)).status).toBe(404);
    expect(lookup).toHaveBeenCalledTimes(1);
    app.database.patchBookMetadata(app.profile.id, app.bookId, { expectedRevision: 0,
      expectedContentHash: "1".repeat(64), changes: { title: "Corrected title" } });
    expect((await fetch(endpoint)).status).toBe(200);
    expect(lookup).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Corrected title" }), expect.any(AbortSignal));
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(await readFile(app.filename)).toEqual(app.original);
  });

  it("matches every roster page against only the current library and refreshes ownership on cached pages", async () => {
    const app = await setup(true, true);
    const roster: HardcoverSeriesPage = { id: 10, name: "The series", books: [providerBook(1), providerBook(2), providerBook(3)],
      offset: 0, limit: 50, hasMore: false };
    const series = vi.spyOn(CoverProviderClient.prototype, "getHardcoverSeries").mockResolvedValue(roster);
    const endpoint = `${app.prefix}/hardcover/series/10`;
    const response = await fetch(endpoint);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ books: [
      { id: 1, library: { status: "in-library", books: [{ id: app.bookId }] } },
      { id: 2, position: 1.5, library: { status: "missing", books: [] } },
      { id: 3, library: { status: "missing", books: [] } },
    ] });
    app.add(2);
    expect(await (await fetch(endpoint)).json()).toMatchObject({ books: [
      { library: { status: "in-library" } }, { library: { status: "in-library" } }, { library: { status: "missing" } },
    ] });
    expect(series).toHaveBeenCalledTimes(1);
    expect((await fetch(`${endpoint}?limit=2&offset=2`)).status).toBe(200);
    expect(series).toHaveBeenLastCalledWith(10, 2, 2, expect.any(AbortSignal));
    for (const invalid of ["?limit=51", "?offset=-1", "?offset=1&offset=2", "?url=https://example.com"]) {
      expect((await fetch(endpoint + invalid)).status).toBe(400);
    }
    expect((await fetch(`${app.prefix}/hardcover/series/not-an-id`)).status).toBe(400);
    expect(app.database.getBookMetadataState(app.profile.id, app.bookId)?.revision).toBe(0);
  });

  it("requires a configured token even on a cache hit and invalidates discovery after replacement", async () => {
    const app = await setup(false);
    const lookup = vi.spyOn(CoverProviderClient.prototype, "lookupHardcoverBook").mockResolvedValue({ books: [], matchedBookId: null });
    const endpoint = `${app.prefix}/books/${app.bookId}/hardcover`;
    expect((await fetch(endpoint)).status).toBe(409);
    expect(lookup).not.toHaveBeenCalled();
    app.database.setCoverProviderCredential("hardcover", "first-token", 0, "save-first");
    expect((await fetch(endpoint)).status).toBe(200);
    app.database.setCoverProviderCredential("hardcover", "second-token", 1, "save-second");
    expect((await fetch(endpoint)).status).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(2);
    app.database.removeCoverProviderCredential("hardcover", 2, "remove-token");
    expect((await fetch(endpoint)).status).toBe(409);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("rejects a result when the book changed during the provider request", async () => {
    const app = await setup();
    let finish!: (value: HardcoverBookLookup) => void;
    const lookup = vi.spyOn(CoverProviderClient.prototype, "lookupHardcoverBook").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = fetch(`${app.prefix}/books/${app.bookId}/hardcover`);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
    app.database.patchBookMetadata(app.profile.id, app.bookId, { expectedRevision: 0,
      expectedContentHash: "1".repeat(64), changes: { title: "Changed while loading" } });
    finish({ books: [providerBook(1)], matchedBookId: 1 });
    expect((await pending).status).toBe(409);
  });
});
