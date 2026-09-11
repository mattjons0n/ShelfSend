import { describe, expect, it } from "vitest";
import { CatalogDatabase } from "../../server/catalog-database.js";
import { hardcoverLookupIdentifiers } from "../../shared/hardcover-identifiers.js";

describe("Hardcover bulk lookup identifiers", () => {
  it("does not reinterpret typed ASINs or UUIDs as an ISBN", () => {
    expect(hardcoverLookupIdentifiers(["ASIN:1234567890"])).toEqual({ asin: "1234567890" });
    expect(hardcoverLookupIdentifiers(["UUID:1234567890", "urn:uuid:1234567890123"])).toEqual({});
    expect(hardcoverLookupIdentifiers(["urn:isbn:9798434681247"])).toEqual({ identifier: "9798434681247" });
  });
  it.each<{ identifiers: string[]; expected: { identifier?: string; asin?: string }; overlayIdentifiers?: string[] }>([
    { identifiers: ["urn:uuid:bbd5144f-e51c-4a5f-b80a-5f2bca629858", "ASIN:B09KS6PMGF", "ISBN:9798434681247"], expected: { identifier: "9798434681247", asin: "B09KS6PMGF" } },
    { identifiers: ["urn:uuid:bbd5144f-e51c-4a5f-b80a-5f2bca629858", "ASIN:B09KS6PMGF"], expected: { asin: "B09KS6PMGF" } },
    { identifiers: ["urn:uuid:bbd5144f-e51c-4a5f-b80a-5f2bca629858"], expected: {} },
    { identifiers: ["ASIN:B09KS6PMGF"], overlayIdentifiers: ["ISBN:9798434681247"], expected: { identifier: "9798434681247", asin: "B09KS6PMGF" } },
  ])("passes exact available identifiers without using UUID as an ISBN: $identifiers", ({ identifiers, expected, overlayIdentifiers }) => {
    const database = new CatalogDatabase(":memory:");
    try {
      const profile = database.createProfile({ name: "Library" });
      const root = database.createRoot(profile.id, { label: "Books", path: "/libraries/books" });
      const bookId = database.upsertCatalogFile({
        rootId: root.id, relativePath: "book.epub", format: "epub", size: 100, mtimeMs: 1,
        contentHash: "a".repeat(64), scanToken: "asin-test",
        metadata: { title: "Local title", authors: ["Author"], authorSort: null, language: "en", publisher: null,
          publishedAt: null, series: null, seriesIndex: null, subjects: [], identifiers,
          metadataComplete: true, coverKey: null, coverMediaType: null },
      }).bookId;
      if (overlayIdentifiers) database.patchBookMetadata(profile.id, bookId, { expectedRevision: 0, expectedContentHash: "a".repeat(64), changes: { identifiers: overlayIdentifiers } });
      database.setCoverProviderCredential("hardcover", "test-token", 0, "save");
      const job = database.createMetadataLookupJob(profile.id, { provider: "hardcover", bookIds: [bookId] }, "job").job;
      database.controlMetadataLookupJob(profile.id, job.id, "resume", job.revision);
      const claims = database.claimMetadataLookupEntries(profile.id, job.id);
      expect(claims[0]?.terms).toEqual({ title: "Local title", author: "Author", ...expected });
      expect(database.getBook(profile.id, bookId)?.identifiers).toEqual(overlayIdentifiers ?? identifiers);
      expect(database.getBookMetadataState(profile.id, bookId)?.sourceMetadata.identifiers).toEqual(identifiers);
    } finally { database.close(); }
  });
});
