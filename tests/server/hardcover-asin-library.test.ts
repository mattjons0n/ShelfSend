import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogDatabase, type ExtractedBookInput } from "../../server/catalog-database.js";
import { collectHardcoverLibraryAsins, enrichHardcoverSeries } from "../../server/hardcover-library.js";
import type { HardcoverSeriesBook, HardcoverSeriesPage } from "../../shared/hardcover-contracts.js";

const databases: CatalogDatabase[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture() {
  const database = new CatalogDatabase(":memory:");
  databases.push(database);
  const profileId = database.createProfile({ name: "Selected library" }).id;
  const rootId = database.createRoot(profileId, { label: "Fiction", path: "/libraries/fiction" }).id;
  return { database, profileId, rootId };
}

let sequence = 0;
function addBook(database: CatalogDatabase, rootId: string, metadata: Partial<ExtractedBookInput> = {}) {
  const relativePath = `asin-book-${sequence++}.epub`;
  const contentHash = createHash("sha256").update(relativePath).digest("hex");
  const bookId = database.upsertCatalogFile({
    rootId, relativePath, contentHash, format: "epub", size: 100, mtimeMs: 1, scanToken: "presence",
    metadata: {
      title: "An unrelated imported title", authors: ["Nicholas Sansbury Smith"], authorSort: null,
      language: "en", publisher: null, publishedAt: null, series: null, seriesIndex: null, subjects: [],
      identifiers: ["ASIN:B09KS6PMGF"], metadataComplete: true, coverKey: null, coverMediaType: null, ...metadata,
    },
  }).bookId;
  return { bookId, contentHash };
}

function volume(id = 1098689, overrides: Partial<HardcoverSeriesBook> = {}): HardcoverSeriesBook {
  return {
    id, title: "Dark Moon", authors: ["Nicholas Sansbury Smith"], identifiers: ["ASIN:B09KS6PMGF"],
    url: null, coverUrl: null, releaseYear: 2022, series: [{ id: 5, name: "E-Day", position: 3 }],
    position: 3, ...overrides,
  };
}

function page(books = [volume()]): HardcoverSeriesPage {
  return { id: 5, name: "E-Day", books, offset: 0, limit: 40, hasMore: false };
}

describe("ASIN Hardcover series library ownership", () => {
  it("collects sorted unique source and edited ASINs only from the selected profile", () => {
    const { database, profileId, rootId } = fixture();
    const book = addBook(database, rootId);
    database.patchBookMetadata(profileId, book.bookId, {
      expectedRevision: 0, expectedContentHash: book.contentHash,
      changes: { identifiers: ["ASIN:B000000001", "urn:asin:b09ks6pmgf", "9780140328721", "urn:uuid:abc"] },
    });
    const other = database.createProfile({ name: "Another library" });
    const otherRoot = database.createRoot(other.id, { label: "Other", path: "/libraries/other" });
    addBook(database, otherRoot.id, { identifiers: ["ASIN:B000000002"] });
    expect(collectHardcoverLibraryAsins(database, profileId)).toEqual(["B000000001", "B09KS6PMGF"]);
    expect(collectHardcoverLibraryAsins(database, other.id)).toEqual(["B000000002"]);
    database.updateRoot(profileId, rootId, { enabled: false });
    expect(collectHardcoverLibraryAsins(database, profileId)).toEqual([]);
  });

  it("rejects ASIN collection overflow instead of silently dropping identifiers", () => {
    const { database, profileId, rootId } = fixture();
    addBook(database, rootId, { identifiers: ["ASIN:B09KS6PMGF", "ASIN:B000000001"] });
    expect(() => collectHardcoverLibraryAsins(database, profileId, 1))
      .toThrow(expect.objectContaining({ code: "too_large" }));
  });

  it("identifies the local book without ISBN or matching title and leaves metadata untouched", () => {
    const { database, profileId, rootId } = fixture();
    const { bookId } = addBook(database, rootId, {
      identifiers: ["urn:uuid:58fe58d6-7705-40e9-a143-f14053e46623", "urn:asin:b09ks6pmgf"],
    });
    const before = database.getBook(profileId, bookId);
    const changes = database.database.prepare("SELECT total_changes() AS total").get();
    database.database.exec("PRAGMA query_only = ON");

    expect(enrichHardcoverSeries(database, profileId, page()).books[0]!.library)
      .toMatchObject({ status: "in-library", books: [{ id: bookId }] });
    expect(database.getBook(profileId, bookId)).toEqual(before);
    expect(database.database.prepare("SELECT total_changes() AS total").get()).toEqual(changes);
  });

  it("uses both source and edited ASINs while displaying the edited local title", () => {
    const { database, profileId, rootId } = fixture();
    const source = addBook(database, rootId);
    database.patchBookMetadata(profileId, source.bookId, {
      expectedRevision: 0, expectedContentHash: source.contentHash,
      changes: { title: "My custom title", authors: ["Personal label"], identifiers: [] },
    });
    const edited = addBook(database, rootId, { identifiers: [] });
    database.patchBookMetadata(profileId, edited.bookId, {
      expectedRevision: 0, expectedContentHash: edited.contentHash,
      changes: { identifiers: ["B09KS6PMGF"] },
    });
    expect(enrichHardcoverSeries(database, profileId, page()).books[0]!.library)
      .toMatchObject({ status: "in-library", books: expect.arrayContaining([
        expect.objectContaining({ id: source.bookId, title: "My custom title" }),
        expect.objectContaining({ id: edited.bookId }),
      ]) });
  });

  it("never includes an ASIN belonging only to another profile or disabled root", () => {
    const { database, profileId, rootId } = fixture();
    addBook(database, rootId);
    const other = database.createProfile({ name: "Another library" });
    database.createRoot(other.id, { label: "Other", path: "/libraries/other" });
    expect(enrichHardcoverSeries(database, other.id, page()).books[0]!.library)
      .toEqual({ status: "missing", books: [] });
    database.updateRoot(profileId, rootId, { enabled: false });
    expect(enrichHardcoverSeries(database, profileId, page()).books[0]!.library.status).toBe("missing");
  });

  it("prefers a unique ASIN over another book with the local title", () => {
    const { database, profileId, rootId } = fixture();
    const { bookId } = addBook(database, rootId);
    const result = enrichHardcoverSeries(database, profileId, page([
      volume(), volume(2, { title: "An unrelated imported title", identifiers: [], position: 2 }),
    ]));
    expect(result.books.map((book) => book.library.status)).toEqual(["in-library", "possible"]);
    expect(result.books[0]!.library.books[0]!.id).toBe(bookId);
  });

  it("keeps duplicate ASIN provider identities possible rather than choosing by title", () => {
    const { database, profileId, rootId } = fixture();
    addBook(database, rootId, { title: "Dark Moon" });
    const result = enrichHardcoverSeries(database, profileId, page([
      volume(), volume(2, { title: "Different work", position: 2 }),
    ]));
    expect(result.books.map((book) => book.library.status)).toEqual(["possible", "possible"]);
  });

  it("keeps conflicting ASIN and ISBN identities possible", () => {
    const { database, profileId, rootId } = fixture();
    addBook(database, rootId, { identifiers: ["ASIN:B09KS6PMGF", "ISBN:9780140328721"] });
    const result = enrichHardcoverSeries(database, profileId, page([
      volume(), volume(2, { title: "Other ISBN work", identifiers: ["9780140328721"], position: 2 }),
    ]));
    expect(result.books.map((book) => book.library.status)).toEqual(["possible", "possible"]);
  });

  it("accepts corroborating ASIN and ISBN identities", () => {
    const { database, profileId, rootId } = fixture();
    addBook(database, rootId, { identifiers: ["ASIN:B09KS6PMGF", "ISBN:9780140328721"] });
    const result = enrichHardcoverSeries(database, profileId, page([
      volume(1098689, { identifiers: ["ASIN:B09KS6PMGF", "9780140328721"] }),
    ]));
    expect(result.books[0]!.library.status).toBe("in-library");
  });

  it("does not confirm an ASIN with conflicting known authors", () => {
    const { database, profileId, rootId } = fixture();
    addBook(database, rootId, { authors: ["A Different Writer"] });
    expect(enrichHardcoverSeries(database, profileId, page()).books[0]!.library.status).toBe("possible");
  });

  it("does not treat generic UUIDs as ASINs", () => {
    const { database, profileId, rootId } = fixture();
    const uuid = "urn:uuid:58fe58d6-7705-40e9-a143-f14053e46623";
    addBook(database, rootId, { identifiers: [uuid] });
    expect(enrichHardcoverSeries(database, profileId, page([volume(1098689, { identifiers: [uuid] })]))
      .books[0]!.library.status).toBe("missing");
  });
});
