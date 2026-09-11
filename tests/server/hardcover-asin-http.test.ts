import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogDatabase } from "../../server/catalog-database.js";
import { CatalogHttpServer } from "../../server/http-server.js";
import { CoverProviderClient, CoverProviderError } from "../../server/cover-providers.js";
import { CoverCache } from "../../server/cover-cache.js";
import { CatalogEventHub } from "../../server/event-hub.js";
import { AllowedRootPolicy } from "../../server/root-policy.js";
import type { HardcoverSeriesPage } from "../../shared/hardcover-contracts.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

const asin = "B09KS6PMGF";
const author = "Nicholas Sansbury Smith";
const roster: HardcoverSeriesPage = {
  id: 88, name: "E-Day", offset: 0, limit: 50, hasMore: false,
  books: [
    { id: 1098688, title: "Burning Earth", position: 2 },
    { id: 1098689, title: "Dark Moon", position: 3 },
  ].map((book) => ({ ...book, authors: [author], identifiers: [], url: null, coverUrl: null, releaseYear: 2022,
    series: [{ id: 88, name: "E-Day", position: book.position }] })),
};

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "shelfsend-asin-http-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const library = path.join(directory, "library");
  await mkdir(library);
  const original = Buffer.from("immutable source for ASIN tests");
  const filename = path.join(library, "source.epub");
  await writeFile(filename, original);
  const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
  cleanup.push(async () => database.close());
  const profile = database.createProfile({ name: "Selected library" });
  const other = database.createProfile({ name: "Other library" });
  const root = database.createRoot(profile.id, { path: library, label: "Books" });
  const otherRoot = database.createRoot(other.id, { path: path.join(directory, "other"), label: "Private books" });
  const add = (sequence: number, identifiers: string[], rootId = root.id) => database.upsertCatalogFile({
    rootId, relativePath: `source-${sequence}.epub`, format: "epub", size: original.length, mtimeMs: 1,
    contentHash: String(sequence).repeat(64).slice(0, 64), scanToken: "asin-http-test",
    metadata: { title: `Imported filename ${sequence}`, authors: [author], authorSort: null,
      language: "en", publisher: null, publishedAt: null, series: null, seriesIndex: null,
      subjects: [], identifiers, metadataComplete: true, coverKey: null, coverMediaType: null },
  }).bookId;
  const bookId = add(1, ["urn:uuid:ba7cf179-58e0-437b-a43f-d32d4d921410", `ASIN:${asin}`]);
  database.setCoverProviderCredential("hardcover", "private-test-token", 0, "save-token");
  const events = new CatalogEventHub();
  cleanup.push(async () => events.close());
  const server = new CatalogHttpServer(database, {} as never, await AllowedRootPolicy.create([library]),
    new CoverCache(path.join(directory, "cache")), events,
    { hostname: "127.0.0.1", port: 0, allowedHosts: ["127.0.0.1"], allowedOrigins: [], requireOriginForMutations: false });
  const address = await server.listen();
  cleanup.push(() => server.close());
  const prefix = `http://127.0.0.1:${address.port}/api/profiles/${profile.id}`;
  return { database, profile, other, otherRoot, bookId, add, prefix, filename, original };
}

describe("ASIN discovery and series HTTP integration", () => {
  it("passes the usable ASIN after a UUID to discovery, without rewriting the book", async () => {
    const app = await setup();
    const lookup = vi.spyOn(CoverProviderClient.prototype, "lookupHardcoverBook").mockResolvedValue({
      books: [{ ...roster.books[1]!, identifiers: [`ASIN:${asin}`, "9798434681247"] }], matchedBookId: 1098689,
    });
    const endpoint = `${app.prefix}/books/${app.bookId}/hardcover`;
    expect(await (await fetch(endpoint)).json()).toMatchObject({ matchedBookId: 1098689,
      books: [{ series: [{ name: "E-Day", position: 3 }] }] });
    expect(lookup).toHaveBeenCalledWith({ title: "Imported filename 1", author, asin }, expect.any(AbortSignal));
    expect((await fetch(endpoint)).status).toBe(200);
    expect(lookup).toHaveBeenCalledOnce();
    expect(app.database.getBookMetadataState(app.profile.id, app.bookId)?.revision).toBe(0);
    expect(app.database.getBook(app.profile.id, app.bookId)?.identifiers).not.toContain("9798434681247");
    app.database.patchBookMetadata(app.profile.id, app.bookId, { expectedRevision: 0,
      expectedContentHash: "1".repeat(64), changes: { identifiers: ["ISBN:9798434681247"] } });
    expect((await fetch(endpoint)).status).toBe(200);
    expect(lookup).toHaveBeenLastCalledWith({ title: "Imported filename 1", author, asin, identifier: "9798434681247" }, expect.any(AbortSignal));
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(app.database.getBookMetadataState(app.profile.id, app.bookId)?.sourceMetadata.identifiers).toContain(`ASIN:${asin}`);
    expect(await readFile(app.filename)).toEqual(app.original);
  });

  it("accepts ASIN alongside ISBN for Hardcover metadata search and rejects invalid extra ASIN parameters", async () => {
    const app = await setup();
    const search = vi.spyOn(CoverProviderClient.prototype, "searchMetadata").mockResolvedValue([]);
    const endpoint = `${app.prefix}/books/${app.bookId}/metadata-search`;
    expect((await fetch(`${endpoint}?provider=hardcover&identifier=9798434681247&asin=${asin}`)).status).toBe(200);
    expect(search).toHaveBeenCalledWith("hardcover", { identifier: "9798434681247", asin }, expect.any(Number), expect.any(AbortSignal));
    expect((await fetch(`${endpoint}?provider=hardcover&asin=${asin}`)).status).toBe(200);
    expect((await fetch(`${endpoint}?provider=hardcover&asin=0140328726`)).status).toBe(200);
    expect(search).toHaveBeenLastCalledWith("hardcover", { asin: "0140328726" }, expect.any(Number), expect.any(AbortSignal));
    for (const query of ["provider=open-library&asin=B09KS6PMGF", "provider=hardcover&asin=uuid-not-an-asin",
      "provider=hardcover&asin=B09KS6PMGF&asin=B000000001"]) {
      expect((await fetch(`${endpoint}?${query}`)).status).toBe(400);
    }
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("resolves ASIN editions absent from the roster sample and marks the right local volumes through the series API", async () => {
    const app = await setup();
    const secondId = app.add(2, ["ASIN:B000000002"]);
    app.add(3, ["ASIN:B000000003"], app.otherRoot.id);
    const series = vi.spyOn(CoverProviderClient.prototype, "getHardcoverSeries").mockResolvedValue(roster);
    const editions = vi.spyOn(CoverProviderClient.prototype, "lookupHardcoverEditionIdentifiers").mockResolvedValue([
      { id: 1098688, identifiers: ["ASIN:B000000002"] },
      { id: 1098689, identifiers: [`ASIN:${asin}`, "9798434681247"] },
    ]);
    const endpoint = `${app.prefix}/hardcover/series/88`;
    const response = await fetch(endpoint);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ books: [
      { id: 1098688, library: { status: "in-library", books: [{ id: secondId }] } },
      { id: 1098689, library: { status: "in-library", books: [{ id: app.bookId }] } },
    ] });
    expect(editions).toHaveBeenCalledWith(["B000000002", asin], [1098688, 1098689], expect.any(AbortSignal));
    expect((await fetch(endpoint)).status).toBe(200);
    expect(series).toHaveBeenCalledOnce();
    expect(editions).toHaveBeenCalledOnce();
    editions.mockResolvedValueOnce([]);
    expect(await (await fetch(endpoint.replace(app.profile.id, app.other.id))).json()).toMatchObject({ books: [
      { library: { status: "missing", books: [] } }, { library: { status: "missing", books: [] } },
    ] });
    expect(editions).toHaveBeenLastCalledWith(["B000000003"], [1098688, 1098689], expect.any(AbortSignal));
    expect(app.database.getBook(app.profile.id, app.bookId)?.title).toBe("Imported filename 1");
    expect(app.database.getBookMetadataState(app.profile.id, app.bookId)?.revision).toBe(0);
    expect(await readFile(app.filename)).toEqual(app.original);
  });

  it("refreshes identifier resolution when profile identifiers or credentials change", async () => {
    const app = await setup();
    const series = vi.spyOn(CoverProviderClient.prototype, "getHardcoverSeries").mockResolvedValue(roster);
    const editions = vi.spyOn(CoverProviderClient.prototype, "lookupHardcoverEditionIdentifiers").mockResolvedValue([]);
    const endpoint = `${app.prefix}/hardcover/series/88`;
    expect((await fetch(endpoint)).status).toBe(200);
    app.add(2, ["ASIN:B000000002"]);
    expect((await fetch(endpoint)).status).toBe(200);
    expect(editions).toHaveBeenCalledTimes(2);
    expect(series).toHaveBeenCalledOnce();
    app.database.setCoverProviderCredential("hardcover", "replacement-token", 1, "replace-token");
    expect((await fetch(endpoint)).status).toBe(200);
    expect(editions).toHaveBeenCalledTimes(3);
    expect(series).toHaveBeenCalledTimes(2);
  });

  it("keeps rate-limit failures as errors instead of showing falsely missing volumes", async () => {
    const app = await setup();
    vi.spyOn(CoverProviderClient.prototype, "getHardcoverSeries").mockResolvedValue(roster);
    const editions = vi.spyOn(CoverProviderClient.prototype, "lookupHardcoverEditionIdentifiers")
      .mockRejectedValue(new CoverProviderError("provider_rate_limited", "Hardcover is busy. Try again later."));
    const response = await fetch(`${app.prefix}/hardcover/series/88`);
    expect(response.status).not.toBe(200);
    expect(await response.json()).toMatchObject({ error: { code: "provider_rate_limited" } });
    expect(editions).toHaveBeenCalledOnce();
  });
});
