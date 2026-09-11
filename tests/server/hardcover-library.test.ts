import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CatalogDatabase,
  MAX_LIBRARY_PRESENCE_ENTRIES,
  MAX_LIBRARY_PRESENCE_METADATA_BYTES,
  type ExtractedBookInput,
} from "../../server/catalog-database.js";
import { enrichHardcoverSeries, MAX_HARDCOVER_LIBRARY_MATCHES_PER_BOOK } from "../../server/hardcover-library.js";
import type { HardcoverSeriesBook, HardcoverSeriesPage } from "../../shared/hardcover-contracts.js";

const databases: CatalogDatabase[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const database = new CatalogDatabase(":memory:");
  databases.push(database);
  const profileId = database.createProfile({ name: "Selected library" }).id;
  const rootId = database.createRoot(profileId, { label: "Fiction", path: "/libraries/fiction" }).id;
  return { database, profileId, rootId };
}

let sequence = 0;
function addBook(database: CatalogDatabase, rootId: string, metadata: Partial<ExtractedBookInput> = {}) {
  const relativePath = `book-${sequence++}.epub`;
  const contentHash = createHash("sha256").update(relativePath).digest("hex");
  const bookId = database.upsertCatalogFile({
    rootId, relativePath, contentHash, format: "epub", size: 100, mtimeMs: 1, scanToken: "presence",
    metadata: {
      title: "The first book", authors: ["A. Writer"], authorSort: null, language: "en", publisher: null,
      publishedAt: null, series: null, seriesIndex: null, subjects: [], identifiers: [], metadataComplete: true,
      coverKey: null, coverMediaType: null, ...metadata,
    },
  }).bookId;
  return { bookId, contentHash };
}

function volume(id = 1, overrides: Partial<HardcoverSeriesBook> = {}): HardcoverSeriesBook {
  return {
    id, title: "The first book", authors: ["A. Writer"], identifiers: [], url: null, coverUrl: null,
    releaseYear: null, series: [{ id: 5, name: "A series", position: 1 }], position: 1, ...overrides,
  };
}

function page(books = [volume()]): HardcoverSeriesPage {
  return { id: 5, name: "A series", books, offset: 0, limit: 40, hasMore: false };
}

const trilogyAuthor = "Nicholas Sansbury Smith";
function trilogyVolume(id: number, title: string, position: number, overrides: Partial<HardcoverSeriesBook> = {}) {
  return volume(id, { title, authors: [trilogyAuthor], position, series: [{ id: 5, name: "E-Day", position }], ...overrides });
}

function trilogyPage(books: HardcoverSeriesBook[]): HardcoverSeriesPage {
  return { ...page(books), name: "E-Day" };
}

describe("decorated-title Hardcover library ownership", () => {
  it("uses complete source or edited identities and does not mutate catalog metadata", () => {
    const { database, profileId, rootId } = fixture();
    const source = addBook(database, rootId, {
      title: "E-Day III: Dark Moon (E-Day Trilogy Book 3)", authors: [trilogyAuthor],
      identifiers: ["ASIN:B09KS6PMGF", "urn:uuid:58fe58d6-7705-40e9-a143-f14053e46623"],
    });
    database.patchBookMetadata(profileId, source.bookId, {
      expectedRevision: 0, expectedContentHash: source.contentHash,
      changes: { title: "My third E-Day book", authors: ["Personal author label"] },
    });
    const edited = addBook(database, rootId, { title: "Unusable imported title", authors: ["Unknown"] });
    database.patchBookMetadata(profileId, edited.bookId, {
      expectedRevision: 0, expectedContentHash: edited.contentHash,
      changes: { title: "E-Day II: Burning Earth (E-Day Trilogy Book 2)", authors: [trilogyAuthor] },
    });
    const before = [source, edited].map(({ bookId }) => database.getBook(profileId, bookId));
    const changes = database.database.prepare("SELECT total_changes() AS total").get();
    database.database.exec("PRAGMA query_only = ON");

    const result = enrichHardcoverSeries(database, profileId, trilogyPage([
      trilogyVolume(1098688, "Burning Earth", 2), trilogyVolume(1098689, "Dark Moon", 3),
    ]));

    expect(result.books.map((book) => [book.id, book.library.status, book.library.books.map((local) => local.id)]))
      .toEqual([[1098688, "in-library", [edited.bookId]], [1098689, "in-library", [source.bookId]]]);
    expect(result.books[1]!.library.books[0]!.title).toBe("My third E-Day book");
    expect([source, edited].map(({ bookId }) => database.getBook(profileId, bookId))).toEqual(before);
    expect(database.database.prepare("SELECT total_changes() AS total").get()).toEqual(changes);
  });

  it.each([
    ["author", { authors: ["A Different Writer"] }],
    ["series", { series: [{ id: 5, name: "A Different Series", position: 3 }] }],
    ["volume", { position: 2, series: [{ id: 5, name: "E-Day", position: 2 }] }],
  ] satisfies Array<[string, Partial<HardcoverSeriesBook>]>) ("does not confirm a cleaned title with a conflicting %s", (_field, overrides) => {
    const { database, profileId, rootId } = fixture();
    addBook(database, rootId, { title: "E-Day III: Dark Moon (E-Day Trilogy Book 3)", authors: [trilogyAuthor] });
    const result = enrichHardcoverSeries(database, profileId, trilogyPage([trilogyVolume(1098689, "Dark Moon", 3, overrides)]));
    expect(result.books[0]!.library.status).not.toBe("in-library");
  });

  it("keeps competing provider identities for one cleaned local title possible", () => {
    const { database, profileId, rootId } = fixture();
    const { bookId } = addBook(database, rootId, {
      title: "E-Day III: Dark Moon (E-Day Trilogy Book 3)", authors: [trilogyAuthor],
    });
    const result = enrichHardcoverSeries(database, profileId, trilogyPage([
      trilogyVolume(1098689, "Dark Moon", 3), trilogyVolume(1098690, "Dark Moon", 3),
    ]));
    expect(result.books.map((book) => book.library)).toEqual([
      { status: "possible", books: [expect.objectContaining({ id: bookId })] },
      { status: "possible", books: [expect.objectContaining({ id: bookId })] },
    ]);
  });

  it("preserves disjoint ISBN versus cleaned-title claims as possible", () => {
    const { database, profileId, rootId } = fixture();
    addBook(database, rootId, {
      title: "E-Day III: Dark Moon (E-Day Trilogy Book 3)", authors: [trilogyAuthor], identifiers: ["9780140328721"],
    });
    const result = enrichHardcoverSeries(database, profileId, trilogyPage([
      trilogyVolume(1098688, "Burning Earth", 2, { identifiers: ["9780140328721"] }),
      trilogyVolume(1098689, "Dark Moon", 3),
    ]));
    expect(result.books.map((book) => book.library.status)).toEqual(["possible", "possible"]);
  });

  it("preserves an author conflict even when the cleaned title and ISBN agree", () => {
    const { database, profileId, rootId } = fixture();
    addBook(database, rootId, {
      title: "E-Day III: Dark Moon (E-Day Trilogy Book 3)", authors: ["A Different Writer"], identifiers: ["9780140328721"],
    });
    expect(enrichHardcoverSeries(database, profileId, trilogyPage([
      trilogyVolume(1098689, "Dark Moon", 3, { identifiers: ["9780140328721"] }),
    ])).books[0]!.library.status).toBe("possible");
  });

  it("does not borrow corroboration from another series membership or roster position", () => {
    const { database, profileId, rootId } = fixture();
    const { bookId } = addBook(database, rootId, {
      title: "E-Day III: Dark Moon (E-Day Trilogy Book 3)", authors: [trilogyAuthor],
    });
    const memberships = [{ id: 5, name: "E-Day", position: 2 }, { id: 6, name: "E-Day", position: 3 }];
    const unrelatedMembership = enrichHardcoverSeries(database, profileId, trilogyPage([
      trilogyVolume(1098689, "Dark Moon", 2, { series: memberships }),
    ]));
    expect(unrelatedMembership.books[0]!.library.status).not.toBe("in-library");

    const repeatedWork = enrichHardcoverSeries(database, profileId, trilogyPage([
      trilogyVolume(1098689, "Dark Moon", 2, { series: [{ id: 5, name: "E-Day", position: 3 }] }),
      trilogyVolume(1098689, "Dark Moon", 3),
    ]));
    expect(repeatedWork.books[0]!.library.status).not.toBe("in-library");
    expect(repeatedWork.books[1]!.library).toMatchObject({ status: "in-library", books: [{ id: bookId }] });
  });

  it("does not combine a source title with an unrelated edited author", () => {
    const { database, profileId, rootId } = fixture();
    const { bookId, contentHash } = addBook(database, rootId, {
      title: "E-Day III: Dark Moon (E-Day Trilogy Book 3)", authors: ["A Different Writer"],
    });
    database.patchBookMetadata(profileId, bookId, {
      expectedRevision: 0, expectedContentHash: contentHash,
      changes: { title: "A different edited title", authors: [trilogyAuthor] },
    });
    expect(enrichHardcoverSeries(database, profileId, trilogyPage([
      trilogyVolume(1098689, "Dark Moon", 3),
    ])).books[0]!.library.status).not.toBe("in-library");
  });
});

describe("read-only Hardcover selected-library presence", () => {
  it("matches exact normalized title/author without any local series metadata", () => {
    const { database, profileId, rootId } = fixture();
    const { bookId } = addBook(database, rootId, {
      title: "The First—Book!", authors: ["Á. Writer"], coverKey: "v1-cover.jpg", coverMediaType: "image/jpeg",
    });
    const result = enrichHardcoverSeries(database, profileId, page());
    expect(result.books[0]!.library).toEqual({ status: "in-library", books: [{
      id: bookId, title: "The First—Book!", available: true,
      coverUrl: `/api/profiles/${profileId}/books/${bookId}/cover?v=v1-cover.jpg`,
    }] });
    expect(database.getBook(profileId, bookId)!.series).toBeNull();
  });

  it("matches ISBN-10 against ISBN-13 despite title differences and keeps missing books explicit", () => {
    const { database, profileId, rootId } = fixture();
    const { bookId } = addBook(database, rootId, { title: "Edition-specific subtitle", identifiers: ["urn:isbn:0-14-032872-6"] });
    const result = enrichHardcoverSeries(database, profileId, page([
      volume(1, { identifiers: ["ISBN_13:9780140328721"] }),
      volume(2, { title: "The absent sequel", position: 2 }),
    ]));
    expect(result.books[0]!.library).toMatchObject({ status: "in-library", books: [{ id: bookId }] });
    expect(result.books[1]!.library).toEqual({ status: "missing", books: [] });
  });

  it("does not treat malformed ISBNs or numeric non-ISBN identifiers as strong evidence", () => {
    const { database, profileId, rootId } = fixture();
    addBook(database, rootId, { title: "Unrelated", identifiers: ["ISBN:9780140328720", "ASIN:0140328726"] });
    const result = enrichHardcoverSeries(database, profileId, page([
      volume(1, { identifiers: ["9780140328720", "0140328726"] }),
    ]));
    expect(result.books[0]!.library.status).toBe("missing");
  });

  it("uses source and effective identities while showing the current edited title", () => {
    const { database, profileId, rootId } = fixture();
    const { bookId, contentHash } = addBook(database, rootId);
    database.patchBookMetadata(profileId, bookId, {
      expectedRevision: 0, expectedContentHash: contentHash,
      changes: { title: "A personal title", authors: ["Edited Writer"], identifiers: ["ISBN:9780140328721"] },
    });
    expect(enrichHardcoverSeries(database, profileId, page()).books[0]!.library)
      .toMatchObject({ status: "in-library", books: [{ id: bookId, title: "A personal title" }] });
    expect(enrichHardcoverSeries(database, profileId, page([
      volume(1, { title: "A personal title", authors: ["Edited Writer"] }),
    ])).books[0]!.library.status).toBe("in-library");
    expect(enrichHardcoverSeries(database, profileId, page([
      volume(1, { title: "Other edition", identifiers: ["9780140328721"] }),
    ])).books[0]!.library.status).toBe("in-library");
  });

  it("includes books beyond a catalog page and every enabled selected-profile root", () => {
    const { database, profileId, rootId } = fixture();
    for (let i = 0; i < 105; i++) addBook(database, rootId, { title: `A filler ${i}` });
    const secondRoot = database.createRoot(profileId, { label: "Other folder", path: "/libraries/second" });
    const { bookId } = addBook(database, secondRoot.id, { title: "Z last book" });
    expect(database.listBooks(profileId, { limit: 100 }).items.some((book) => book.id === bookId)).toBe(false);
    expect(enrichHardcoverSeries(database, profileId, page([volume(1, { title: "Z last book" })])).books[0]!.library)
      .toMatchObject({ status: "in-library", books: [{ id: bookId }] });
  });

  it("excludes unrelated and disabled memberships and rejects a disabled selected profile", () => {
    const { database, profileId, rootId } = fixture();
    addBook(database, rootId);
    const other = database.createProfile({ name: "Other library" });
    const otherRoot = database.createRoot(other.id, { label: "Other", path: "/libraries/other" });
    addBook(database, otherRoot.id, { title: "Only in other library" });
    const target = page([volume(), volume(2, { title: "Only in other library" })]);
    expect(enrichHardcoverSeries(database, profileId, target).books.map((book) => book.library.status))
      .toEqual(["in-library", "missing"]);
    database.updateRoot(profileId, rootId, { enabled: false });
    expect(enrichHardcoverSeries(database, profileId, target).books.map((book) => book.library.status))
      .toEqual(["missing", "missing"]);
    database.updateProfile(profileId, { enabled: false });
    expect(() => enrichHardcoverSeries(database, profileId, target)).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("keeps offline ownership in-library and flags unavailable mounts immediately", () => {
    const { database, profileId, rootId } = fixture();
    const { bookId } = addBook(database, rootId);
    database.setRootStatus(rootId, "unavailable", "mount_unavailable");
    expect(enrichHardcoverSeries(database, profileId, page()).books[0]!.library)
      .toMatchObject({ status: "in-library", books: [{ id: bookId, available: false }] });
    database.noteRootUnavailable(rootId);
    database.noteRootUnavailable(rootId);
    expect(enrichHardcoverSeries(database, profileId, page()).books[0]!.library)
      .toMatchObject({ status: "in-library", books: [{ id: bookId, available: false }] });
  });

  it("shows title-only and known conflicting author identity as possible", () => {
    const { database, profileId, rootId } = fixture();
    addBook(database, rootId, { authors: ["Different Author"], identifiers: ["9780140328721"] });
    expect(enrichHardcoverSeries(database, profileId, page()).books[0]!.library.status).toBe("possible");
    expect(enrichHardcoverSeries(database, profileId, page([
      volume(1, { identifiers: ["9780140328721"] }),
    ])).books[0]!.library.status).toBe("possible");
  });

  it("preserves fractional/zero positions and marks indistinguishable volumes possible", () => {
    const { database, profileId, rootId } = fixture();
    addBook(database, rootId);
    const result = enrichHardcoverSeries(database, profileId, page([
      volume(1, { position: 0 }), volume(2, { position: 1.5 }),
    ]));
    expect(result.books.map((book) => [book.position, book.library.status])).toEqual([[0, "possible"], [1.5, "possible"]]);
  });

  it("uses a unique ISBN to distinguish identical-volume labels", () => {
    const { database, profileId, rootId } = fixture();
    addBook(database, rootId, { identifiers: ["9780140328721"] });
    const result = enrichHardcoverSeries(database, profileId, page([
      volume(1, { position: 1, identifiers: ["9780140328721"] }), volume(2, { position: 1.5 }),
    ]));
    expect(result.books.map((book) => book.library.status)).toEqual(["in-library", "possible"]);
  });

  it("does not choose between contradictory ISBN and title-author claims", () => {
    const { database, profileId, rootId } = fixture();
    addBook(database, rootId, { identifiers: ["9780140328721"] });
    const result = enrichHardcoverSeries(database, profileId, page([
      volume(1, { title: "Another volume", identifiers: ["9780140328721"] }), volume(2),
    ]));
    expect(result.books.map((book) => book.library.status)).toEqual(["possible", "possible"]);
  });

  it("performs no writes or match-index delivery healing", () => {
    const { database, profileId, rootId } = fixture();
    addBook(database, rootId);
    const matchIndex = vi.spyOn(database, "getMatchIndex").mockImplementation(() => { throw new Error("Delivery path is forbidden"); });
    database.database.exec("PRAGMA query_only = ON");
    const changes = database.database.prepare("SELECT total_changes() AS total").get();
    expect(enrichHardcoverSeries(database, profileId, page()).books[0]!.library.status).toBe("in-library");
    expect(database.database.prepare("SELECT total_changes() AS total").get()).toEqual(changes);
    expect(matchIndex).not.toHaveBeenCalled();
  });

  it("rejects row and UTF-8 byte ceilings before visiting any partial candidates", () => {
    const { database, profileId, rootId } = fixture();
    addBook(database, rootId, { title: "漢".repeat(100) });
    addBook(database, rootId);
    const visit = vi.fn();
    expect(() => database.visitLibraryPresenceCandidates(profileId, visit, { maxEntries: 1 }))
      .toThrow(expect.objectContaining({ code: "too_large" }));
    expect(visit).not.toHaveBeenCalled();
    expect(() => database.visitLibraryPresenceCandidates(profileId, visit, { maxMetadataBytes: 500 }))
      .toThrow(expect.objectContaining({ code: "too_large" }));
    expect(visit).not.toHaveBeenCalled();
  });

  it("fails explicitly at the production profile ceiling instead of reporting false absence", () => {
    const { database, profileId, rootId } = fixture();
    database.database.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n < ?)
      INSERT INTO source_files(id, root_id, relative_path, format, size, mtime_ms, content_hash, scan_token, created_at, updated_at)
      SELECT 'src_' || n, ?, n || '.epub', 'epub', 1, 1, 'hash_' || n, 'scan', 'now', 'now' FROM numbers`)
      .run(MAX_LIBRARY_PRESENCE_ENTRIES + 1, rootId);
    database.database.prepare(`INSERT INTO books(id, root_id, source_file_id, title, added_at, updated_at)
      SELECT 'book_' || id, root_id, id, 'Other book', 'now', 'now' FROM source_files WHERE root_id = ?`).run(rootId);
    expect(() => enrichHardcoverSeries(database, profileId, page()))
      .toThrow(expect.objectContaining({ code: "too_large" }));
  });

  it("rejects a giant raw field before materializing or normalizing it", () => {
    const { database, profileId, rootId } = fixture();
    const { bookId } = addBook(database, rootId);
    database.database.prepare("UPDATE books SET title = CAST(zeroblob(?) AS TEXT) WHERE id = ?")
      .run(MAX_LIBRARY_PRESENCE_METADATA_BYTES + 1, bookId);
    expect(() => enrichHardcoverSeries(database, profileId, page())).toThrow(expect.objectContaining({ code: "too_large" }));
  });

  it("rejects overwhelming ambiguity instead of quietly truncating matching rows", () => {
    const { database, profileId, rootId } = fixture();
    for (let i = 0; i <= MAX_HARDCOVER_LIBRARY_MATCHES_PER_BOOK; i++) addBook(database, rootId, { authors: [] });
    expect(() => enrichHardcoverSeries(database, profileId, page())).toThrow(expect.objectContaining({ code: "too_large" }));
  });

  it("bounds title/author fan-out before visiting any raw identity arrays", () => {
    const { database, profileId, rootId } = fixture();
    const { bookId } = addBook(database, rootId);
    const visit = vi.fn();
    database.database.prepare("UPDATE books SET authors_json = ? WHERE id = ?")
      .run(JSON.stringify(Array.from({ length: 129 }, () => "")), bookId);
    expect(() => database.visitLibraryPresenceCandidates(profileId, visit)).toThrow(expect.objectContaining({ code: "too_large" }));
    expect(visit).not.toHaveBeenCalled();
    database.database.prepare("UPDATE books SET authors_json = '[]', title = ? WHERE id = ?")
      .run("T".repeat(16_385), bookId);
    expect(() => database.visitLibraryPresenceCandidates(profileId, visit)).toThrow(expect.objectContaining({ code: "too_large" }));
    expect(visit).not.toHaveBeenCalled();
  });

  it("rejects malformed source identity arrays instead of claiming missing", () => {
    const { database, profileId, rootId } = fixture();
    const { bookId } = addBook(database, rootId);
    database.database.prepare("UPDATE book_source_metadata SET authors_json = '{}' WHERE book_id = ?").run(bookId);
    expect(() => enrichHardcoverSeries(database, profileId, page())).toThrow(expect.objectContaining({ code: "invalid_state" }));
  });
});
