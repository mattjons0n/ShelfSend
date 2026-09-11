// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { CatalogBrowser } from "../../client/src/catalog-browser";
import { HttpCatalogClient, type CatalogApi, type CatalogBook, type CatalogBookMetadataState, type MetadataCandidateSearchTerms } from "../../client/src/catalog-client";

const ASIN = "B09KS6PMGF";
const ISBN = "9798434681247";
const UUID = "urn:uuid:bbd5144f-e51c-4a5f-b80a-5f2bca629858";

async function setup(identifiers = [UUID, `ASIN:${ASIN}`, `ISBN:${ISBN}`]) {
  const book: CatalogBook = {
    id: "book", profileId: "profile", rootId: "root", sourceFilename: "book.epub",
    title: "E-Day III: Dark Moon (E-Day Trilogy Book 3)", authors: ["Nicholas Sansbury Smith"],
    authorSort: "Smith", subjects: [], identifiers, format: "epub", size: 100,
    contentHash: "a".repeat(64), presentationVersion: "b".repeat(64), metadataRevision: 0,
    metadataComplete: true, available: true, addedAt: "2026-01-01", updatedAt: "2026-01-01",
  };
  const metadata: CatalogBookMetadataState = {
    book, revision: 0, overrides: {}, basedOnContentHash: book.contentHash!, sourceChanged: false,
    sourceCoverUrl: null, coverOverride: null,
    sourceMetadata: { title: book.title, authors: [...book.authors], authorSort: "Smith", language: null, publisher: null,
      publishedAt: null, series: null, seriesIndex: null, description: null, subjects: [], identifiers },
  };
  const searchBookMetadata = vi.fn(async (_profile: string, _book: string, provider: string, _terms: MetadataCandidateSearchTerms, _signal?: AbortSignal) => ({ provider, items: [] }));
  const api = {
    getStatus: vi.fn(async () => ({ available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" })),
    listProfiles: vi.fn(async () => [{ id: "profile", name: "Library", enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 1 }]),
    listRoots: vi.fn(async () => [{ id: "root", profileId: "profile", label: "Books", path: "/libraries/books", enabled: true, status: "watching" }]),
    getFilters: vi.fn(async () => ({ authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [] })),
    listBooks: vi.fn(async () => ({ items: [book], total: 1, limit: 24, offset: 0 })),
    getBook: vi.fn(async () => book), getBookMetadata: vi.fn(async () => metadata), searchBookMetadata,
    listCoverProviderCredentials: vi.fn(async () => [{ provider: "hardcover", configured: true, maskedKey: "••••••••", revision: 1, status: "working" }]),
    subscribeEvents: vi.fn(() => () => {}),
  } as unknown as CatalogApi;
  const browser = new CatalogBrowser(api, {}, () => {}, undefined);
  await browser.start();
  await browser.openMetadataEditor(book.id);
  return { browser, searchBookMetadata, metadata, book };
}

describe("Hardcover ASIN metadata workflows", () => {
  it("sends both local edition identifiers, ignoring an earlier UUID, without applying metadata", async () => {
    const { browser, searchBookMetadata, book } = await setup();
    try {
      const terms = browser.snapshot.metadataEditor!.metadataSearch.terms;
      expect(terms.identifier).toBe(ISBN);
      await browser.searchBookMetadata("hardcover", terms);
      expect(searchBookMetadata).toHaveBeenCalledWith("profile", "book", "hardcover", { ...terms, asin: ASIN }, expect.any(AbortSignal));
      expect(browser.snapshot.metadataEditor!.data!.book.identifiers).toEqual(book.identifiers);
      expect(browser.snapshot.metadataEditor!.draftOverrides).toEqual({});
    } finally { browser.dispose(); }
  });

  it("uses ASIN in the visible identifier field when the source has no ISBN", async () => {
    const { browser, searchBookMetadata } = await setup([UUID, `ASIN:${ASIN}`]);
    try {
      const terms = browser.snapshot.metadataEditor!.metadataSearch.terms;
      expect(terms.identifier).toBe(ASIN);
      await browser.searchBookMetadata("hardcover", terms);
      expect(searchBookMetadata).toHaveBeenCalledWith("profile", "book", "hardcover", expect.objectContaining({ identifier: ASIN }), expect.any(AbortSignal));
    } finally { browser.dispose(); }
  });

  it("preserves the ASIN type for numeric Amazon identifiers in the one visible input", async () => {
    const { browser, searchBookMetadata } = await setup(["ASIN:1234567890"]);
    try {
      const terms = browser.snapshot.metadataEditor!.metadataSearch.terms;
      expect(terms.identifier).toBe("ASIN:1234567890");
      await browser.searchBookMetadata("hardcover", terms);
      expect(searchBookMetadata).toHaveBeenCalledWith("profile", "book", "hardcover", { ...terms, asin: "1234567890" }, expect.any(AbortSignal));
    } finally { browser.dispose(); }
  });

  it("retains the source ASIN when an imported overlay only contains an ISBN", async () => {
    const { browser, searchBookMetadata, metadata } = await setup([`ISBN:${ISBN}`]);
    try {
      metadata.sourceMetadata.identifiers = [`ASIN:${ASIN}`];
      const terms = browser.snapshot.metadataEditor!.metadataSearch.terms;
      await browser.searchBookMetadata("hardcover", terms);
      expect(searchBookMetadata).toHaveBeenCalledWith("profile", "book", "hardcover", { ...terms, asin: ASIN }, expect.any(AbortSignal));
    } finally { browser.dispose(); }
  });

  it("keeps source ISBN evidence alongside the effective ASIN for conflict checks", async () => {
    const { browser, searchBookMetadata, metadata } = await setup([`ASIN:${ASIN}`]);
    try {
      metadata.sourceMetadata.identifiers = [`ISBN:${ISBN}`];
      const terms = browser.snapshot.metadataEditor!.metadataSearch.terms;
      await browser.searchBookMetadata("hardcover", terms);
      expect(searchBookMetadata).toHaveBeenCalledWith("profile", "book", "hardcover", { ...terms, identifier: ISBN, asin: ASIN }, expect.any(AbortSignal));
    } finally { browser.dispose(); }
  });

  it.each(["title", "author", "identifier"] as const)("does not retain a hidden ASIN after the user changes %s", async (field) => {
    const { browser, searchBookMetadata } = await setup();
    try {
      await browser.searchBookMetadata("hardcover", browser.snapshot.metadataEditor!.metadataSearch.terms);
      searchBookMetadata.mockClear();
      const terms = { ...browser.snapshot.metadataEditor!.metadataSearch.terms, [field]: field === "identifier" ? "9780140328721" : "Different query" };
      browser.setMetadataCandidateSearchTerms(terms);
      await browser.searchBookMetadata("hardcover", terms);
      expect(searchBookMetadata).toHaveBeenCalledWith("profile", "book", "hardcover", terms, expect.any(AbortSignal));
      expect(searchBookMetadata.mock.calls[0]?.[3]).not.toHaveProperty("asin");
    } finally { browser.dispose(); }
  });

  it("serializes a separate ASIN only for Hardcover and preserves the existing ISBN query", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify({ provider: String(url).includes("provider=hardcover") ? "hardcover" : "open-library", items: [] }), { headers: { "content-type": "application/json" } }));
    const client = new HttpCatalogClient({ fetch });
    const terms = { identifier: ISBN, asin: ASIN };
    await client.searchBookMetadata("profile", "book", "hardcover", terms);
    await client.searchBookMetadata("profile", "book", "open-library", terms);
    expect(String(fetch.mock.calls[0]?.[0])).toContain(`asin=${ASIN}`);
    expect(String(fetch.mock.calls[0]?.[0])).toContain(`identifier=${ISBN}`);
    expect(String(fetch.mock.calls[1]?.[0])).not.toContain("asin=");
  });
});
